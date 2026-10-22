// FlightsMojo IROP mail triage — phase 1 (docs/irop-mail-triage.md).
//
//   Postfix pipe ── POST /ingest (raw RFC 822) ─► pre-filter ─► one classifier call
//        IROP / unsure (queue mode) / forwarded by our own people ─► relay the bytes
//            unchanged to Chatwoot's Action Mailbox ingress ─► ticket in the IROP inbox
//        everything else ─► one line in the ledger, bytes discarded (the mailbox keeps the mail)
//   Chatwoot account webhook ── POST /chatwoot (message_created) ─► stamp the ticket:
//        custom attributes · label · priority from the travel date · team · private note
//   Daily ── raise the priority of open tickets as their travel date approaches
//
// Chatwoot's code is never modified. Ingest answers 503 (Postfix queues and
// retries) until the relay password and a classifier key are configured;
// stamping is off until the webhook secret, inbox id and bot token are set.

import express from "express";
import { parseMail, classifierText } from "./mime.js";
import { prefilter, parseTrusted, compilePattern } from "./prefilter.js";
import { classify } from "./classify.js";
import { decide, parseBands, rebump, DEFAULT_BANDS } from "./verdict.js";
import { createRelay } from "./relay.js";
import { openLedger } from "./ledger.js";
import { createApi, signedWith } from "./chatwoot.js";
import { createStamper } from "./stamp.js";

const env = process.env;
const {
  // Same rule as the bot: compose-network default; on PRODUCTION the public
  // HTTPS URL for the application API (FORCE_SSL redirects plain HTTP).
  CHATWOOT_BASE_URL = "http://rails:3000",
  CHATWOOT_ACCOUNT_ID,
  CHATWOOT_BOT_TOKEN,
  // Classifier provider, shared with the bot; the keys may be the triage's own.
  BOT_PROVIDER = "gemini",
  OPENAI_MODEL = "gpt-5.6-luna",
  GEMINI_MODEL = "gemini-flash-latest",
  TRIAGE_PORT = "3004",
  TRIAGE_INBOX_ID,
  TRIAGE_TEAM_ID,
  TRIAGE_WEBHOOK_SECRET,
  // The relay ingress, reached inside compose (no nginx body limit).
  TRIAGE_RELAY_URL = "http://rails:3000/rails/action_mailbox/relay/inbound_emails",
  RAILS_INBOUND_EMAIL_PASSWORD,
  TRIAGE_DATA_DIR = "/data",
  TRIAGE_UNSURE = "queue",
  TRIAGE_PRIORITY_BANDS = DEFAULT_BANDS,
  TRIAGE_REBUMP_HOUR = "06:00",
  TRIAGE_TIMEZONE = "Asia/Kolkata",
  TRIAGE_MAX_IN_FLIGHT = "8",
  TRIAGE_LEDGER_KEEP_DAYS = "90",
  TRIAGE_CLASSIFY_TIMEOUT_MS = "20000",
  TRIAGE_TEXT_CAP = "8000",
  TRIAGE_SKIP_SENDERS = "",
  TRIAGE_SKIP_SUBJECTS = "",
  TRIAGE_TRUSTED_SENDERS = "",
} = env;

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

const classifierConfig = {
  provider: BOT_PROVIDER,
  openaiKey: env.TRIAGE_OPENAI_API_KEY || env.OPENAI_API_KEY,
  openaiModel: OPENAI_MODEL,
  openaiBaseUrl: env.TRIAGE_OPENAI_BASE_URL || undefined,
  geminiKey: env.TRIAGE_GEMINI_API_KEY || env.GEMINI_API_KEY,
  geminiModel: GEMINI_MODEL,
  geminiBaseUrl: env.TRIAGE_GEMINI_BASE_URL || undefined,
};
const classifierKey = BOT_PROVIDER === "openai" ? classifierConfig.openaiKey : classifierConfig.geminiKey;
const classifierModel = BOT_PROVIDER === "openai" ? OPENAI_MODEL : GEMINI_MODEL;

const INGEST_ENABLED = Boolean(RAILS_INBOUND_EMAIL_PASSWORD && classifierKey);
const STAMP_ENABLED = Boolean(TRIAGE_WEBHOOK_SECRET && TRIAGE_INBOX_ID && CHATWOOT_ACCOUNT_ID && CHATWOOT_BOT_TOKEN);
const UNSURE_MODE = ["queue", "digest", "drop"].includes(TRIAGE_UNSURE) ? TRIAGE_UNSURE : "queue";
const bands = parseBands(TRIAGE_PRIORITY_BANDS);
const filters = {
  skipSenders: compilePattern(TRIAGE_SKIP_SENDERS, log),
  skipSubjects: compilePattern(TRIAGE_SKIP_SUBJECTS, log),
  trustedSenders: parseTrusted(TRIAGE_TRUSTED_SENDERS),
};
const classifyTimeoutMs = Number(TRIAGE_CLASSIFY_TIMEOUT_MS) || 20000;
const textCap = Number(TRIAGE_TEXT_CAP) || 8000;
const maxInFlight = Number(TRIAGE_MAX_IN_FLIGHT) || 8;

const ledger = openLedger(TRIAGE_DATA_DIR, { log });
const relay = INGEST_ENABLED ? createRelay({ url: TRIAGE_RELAY_URL, password: RAILS_INBOUND_EMAIL_PASSWORD }) : null;
const api = STAMP_ENABLED ? createApi({ baseUrl: CHATWOOT_BASE_URL, accountId: CHATWOOT_ACCOUNT_ID, token: CHATWOOT_BOT_TOKEN }) : null;
const stamper = api ? createStamper({ api, teamId: TRIAGE_TEAM_ID || null, log }) : null;

/** Today's date in the desk's time zone, so "tomorrow" in a mail means the right day. */
export function localDate(zone = TRIAGE_TIMEZONE, at = new Date()) {
  if (env.TRIAGE_TODAY) return env.TRIAGE_TODAY; // test hook only (preview runs): pretend it is this day
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
function localTime(zone = TRIAGE_TIMEZONE, at = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}

const state = { inFlight: 0, lastIngestAt: null, lastRebumpDate: null, counts: { seen: 0, relayed: 0, skipped: 0, failed: 0 } };

// ── Ingest: one mail per request, synchronous, from the Postfix pipe ──
async function ingest(bytes) {
  const today = localDate();
  let parsed = null;
  try {
    parsed = await parseMail(bytes);
  } catch (e) {
    log.warn(`ingest: unparseable mail (${e.message}) — relayed as unsure`);
  }
  const messageId = parsed?.messageId || "";
  const tag = `[mail ${messageId || "no-id"}]`;
  const from = parsed?.from?.address || "";
  const subject = parsed?.subject || "";

  if (parsed) {
    const pre = prefilter(parsed, filters);
    if (pre.action === "skip") {
      ledger.record({ message_id: messageId, from, subject, kind: "other", verdict: "other", category: pre.category, reason: pre.reason, relayed: false, prefiltered: true });
      state.counts.skipped++;
      log.info(`${tag} skipped by pre-filter: ${pre.reason}`);
      return;
    }
    var forcedBy = pre.action === "force" ? from : null;
  }

  let verdict = null;
  let failure = null;
  if (parsed) {
    try {
      verdict = await classify(
        { today, from: parsed.from.name ? `${parsed.from.name} <${from}>` : from, subject, date: parsed.date, attachments: parsed.attachments, text: classifierText(parsed, { cap: textCap }) },
        classifierConfig,
        { timeoutMs: classifyTimeoutMs },
      );
    } catch (e) {
      failure = e.message;
      log.warn(`${tag} classifier failed: ${failure}`);
    }
  } else failure = "unparseable mail";

  const decision = decide({ verdict, failure, forcedBy, today, bands, unsureMode: UNSURE_MODE });
  if (decision.relay) {
    await relay(bytes); // throws → 500 → Postfix keeps the mail queued
    state.counts.relayed++;
  }
  ledger.record({
    message_id: messageId,
    from,
    subject: subject.slice(0, 200),
    kind: decision.kind,
    verdict: verdict?.verdict || null,
    category: verdict?.category || null,
    irop_type: verdict?.iropType || null,
    pnrs: verdict?.pnrs || [],
    airline: verdict?.airline || null,
    travel_date: verdict?.travelDate || null,
    action_deadline: verdict?.actionDeadline || null,
    action_required: verdict?.actionRequired ?? null,
    summary: verdict?.summary || "",
    reason: failure || verdict?.reason || "",
    label: decision.label,
    priority: decision.priority,
    note: decision.note,
    relayed: decision.relay,
    digest: decision.digest,
    forced_by: forcedBy || null,
    usage: verdict?.usage || null,
  });
  const u = verdict?.usage ? ` tokens=${verdict.usage.input}/${verdict.usage.cached}c/${verdict.usage.output}` : "";
  log.info(`${tag} ${decision.kind}${verdict?.iropType ? ` ${verdict.iropType}` : ""}${verdict?.travelDate ? ` travel=${verdict.travelDate}` : ""} → ${decision.relay ? `relayed (${decision.priority})` : decision.digest ? "digest" : "not relayed"}${u}`);
}

// ── Stamping: the account webhook tells us the ticket exists ──
async function handleWebhook(event) {
  if (event?.event !== "message_created") return;
  if (event.message_type !== "incoming" || event.private) return;
  const conv = event.conversation || {};
  if (String(conv.inbox_id) !== String(TRIAGE_INBOX_ID)) return;
  const conversationId = conv.id;
  if (!conversationId) return;
  const email = event.content_attributes?.email || {};
  const messageId = String(event.source_id || email.message_id || "").replace(/^<+|>+$/g, "");
  const tag = `[conv ${conversationId}]`;

  let entry = messageId ? ledger.byMessageId(messageId) : null;
  let decision;
  const previous = ledger.byConversation(conversationId); // an earlier message of this ticket was stamped
  if (entry && entry.stamped) {
    log.info(`${tag} message ${messageId} already stamped — skipping`);
    return;
  }
  if (entry) {
    decision = decide({
      verdict: entryVerdict(entry),
      failure: entry.kind === "unclassified" ? entry.reason : null,
      forcedBy: entry.forced_by || null,
      today: localDate(),
      bands,
      unsureMode: UNSURE_MODE,
      update: Boolean(previous),
    });
  } else {
    // No verdict cached (restart between relay and webhook, or the mail came by
    // another route): classify from the payload. Chatwoot's `quoted` is the
    // trimmed new part; `content` is the full text.
    const text = email.text_content?.quoted || email.html_content?.quoted || event.content || "";
    const today = localDate();
    let verdict = null;
    let failure = null;
    try {
      verdict = await classify(
        { today, from: (email.from || [])[0] || conv.meta?.sender?.email || "", subject: email.subject || conv.additional_attributes?.mail_subject || "", date: email.date, attachments: (event.attachments || []).map((a) => ({ filename: a.file_name || "" })), text: String(text).slice(0, textCap) },
        classifierConfig,
        { timeoutMs: classifyTimeoutMs },
      );
    } catch (e) {
      failure = e.message;
    }
    decision = decide({ verdict, failure, today, bands, unsureMode: UNSURE_MODE, update: Boolean(previous) });
    entry = ledger.record({
      message_id: messageId || `conv-${conversationId}-msg-${event.id}`,
      from: (email.from || [])[0] || "",
      subject: String(email.subject || "").slice(0, 200),
      kind: decision.kind,
      verdict: verdict?.verdict || null,
      category: verdict?.category || null,
      irop_type: verdict?.iropType || null,
      pnrs: verdict?.pnrs || [],
      airline: verdict?.airline || null,
      travel_date: verdict?.travelDate || null,
      action_deadline: verdict?.actionDeadline || null,
      action_required: verdict?.actionRequired ?? null,
      summary: verdict?.summary || "",
      reason: failure || verdict?.reason || "",
      label: decision.label,
      priority: decision.priority,
      note: decision.note,
      relayed: true,
      source: "webhook",
      usage: verdict?.usage || null,
    });
  }

  const live = await stamper.conversation(conversationId);
  const result = await stamper.stamp(conversationId, decision, { live });
  ledger.stamped(entry.message_id, { conversationId, priority: decision.priority && (!live.priority || decision.priority !== live.priority) ? decision.priority : live.priority });
  log.info(`${tag} stamped ${decision.kind}${decision.label ? ` label=${decision.label}` : ""}${decision.priority ? ` priority=${decision.priority}` : ""}${result.ok ? "" : ` with failures: ${result.failures.join("; ")}`}`);
}

function entryVerdict(entry) {
  if (!entry.verdict) return null;
  return {
    verdict: entry.verdict,
    category: entry.category,
    iropType: entry.irop_type,
    pnrs: entry.pnrs || [],
    airline: entry.airline,
    flights: [],
    travelDate: entry.travel_date,
    actionDeadline: entry.action_deadline,
    actionRequired: entry.action_required ?? false,
    summary: entry.summary || "",
    reason: entry.reason || "",
  };
}

// ── Daily priority re-bump ──
async function runRebump(today = localDate()) {
  if (!stamper) return { checked: 0 };
  const tickets = ledger.openTickets();
  let raised = 0;
  for (const t of tickets) {
    try {
      const live = await stamper.conversation(t.conversation_id);
      if (live.status === "resolved") {
        ledger.resolved(t.message_id);
        continue;
      }
      const wanted = rebump({ travelDate: t.travel_date, actionDeadline: t.action_deadline, currentPriority: live.priority, today, bands });
      if (wanted) {
        await stamper.setPriority(t.conversation_id, wanted);
        ledger.rebumped(t.message_id, wanted);
        raised++;
        log.info(`[conv ${t.conversation_id}] priority ${live.priority || "none"} → ${wanted} (travel ${t.travel_date || "-"}, deadline ${t.action_deadline || "-"})`);
      }
    } catch (e) {
      log.warn(`[conv ${t.conversation_id}] re-bump failed: ${e.message}`);
    }
  }
  state.lastRebumpDate = today;
  log.info(`re-bump: ${tickets.length} open ticket(s) checked, ${raised} raised`);
  return { checked: tickets.length, raised };
}

function rebumpTick() {
  const today = localDate();
  if (state.lastRebumpDate === today) return;
  if (localTime() < TRIAGE_REBUMP_HOUR) return;
  runRebump(today).catch((e) => log.error(`re-bump error: ${e.message}`));
}

// ── HTTP ──
const app = express();
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    ingest: INGEST_ENABLED,
    stamp: STAMP_ENABLED,
    provider: BOT_PROVIDER,
    model: classifierModel,
    inbox: TRIAGE_INBOX_ID || null,
    team: TRIAGE_TEAM_ID || null,
    unsure: UNSURE_MODE,
    ledgerEntries: ledger.size,
    inFlight: state.inFlight,
    lastIngestAt: state.lastIngestAt,
    lastRebumpDate: state.lastRebumpDate,
    counts: state.counts,
  }),
);

app.post("/ingest", express.raw({ type: () => true, limit: "32mb" }), async (req, res) => {
  if (!INGEST_ENABLED) return res.status(503).send("triage ingest is not configured");
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).send("empty body");
  if (state.inFlight >= maxInFlight) return res.status(503).send("busy");
  state.inFlight++;
  state.counts.seen++;
  try {
    await ingest(req.body);
    state.lastIngestAt = new Date().toISOString();
    res.sendStatus(204);
  } catch (e) {
    state.counts.failed++;
    log.error(`ingest failed (Postfix will retry): ${e.message}`);
    res.status(500).send("relay failed");
  } finally {
    state.inFlight--;
  }
});

app.post("/chatwoot", express.json({ limit: "4mb", verify: (req, _res, buf) => { req.rawBody = buf; } }), (req, res) => {
  if (!STAMP_ENABLED) return res.sendStatus(200);
  if (!signedWith({ headers: req.headers, rawBody: req.rawBody }, TRIAGE_WEBHOOK_SECRET)) {
    log.warn("webhook rejected: missing/invalid Chatwoot signature");
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  handleWebhook(req.body).catch((e) => log.error(`webhook handling error: ${e.message}`));
});

// Operator hooks (localhost-only port): run the daily job now, compact the ledger.
app.post("/jobs/rebump", (_req, res) => runRebump().then((r) => res.json(r)).catch((e) => res.status(500).json({ error: e.message })));
app.post("/jobs/compact", (_req, res) => res.json(ledger.compact(Number(TRIAGE_LEDGER_KEEP_DAYS) || 90)));

app.listen(Number(TRIAGE_PORT), () => {
  log.info(`FlightsMojo IROP triage listening on :${TRIAGE_PORT} (${BOT_PROVIDER}: ${classifierModel})`);
  log.info(
    INGEST_ENABLED
      ? `ingest: ON — relay ${TRIAGE_RELAY_URL}, unsure=${UNSURE_MODE}, bands=${bands.map((b) => `${b.days}d:${b.priority}`).join(",")}, trusted senders=${filters.trustedSenders.join(",") || "none"}`
      : `ingest: OFF (answers 503 so Postfix queues) — needs RAILS_INBOUND_EMAIL_PASSWORD and ${BOT_PROVIDER === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"} (or the TRIAGE_* key)`,
  );
  log.info(
    STAMP_ENABLED
      ? `stamping: ON — inbox ${TRIAGE_INBOX_ID}, team ${TRIAGE_TEAM_ID || "none"}, re-bump at ${TRIAGE_REBUMP_HOUR} ${TRIAGE_TIMEZONE}`
      : "stamping: OFF — needs TRIAGE_WEBHOOK_SECRET, TRIAGE_INBOX_ID, CHATWOOT_ACCOUNT_ID, CHATWOOT_BOT_TOKEN",
  );
  log.info(`ledger: ${ledger.file} (${ledger.size} entries)`);
  setInterval(rebumpTick, 15 * 60 * 1000).unref();
  setInterval(() => ledger.compact(Number(TRIAGE_LEDGER_KEEP_DAYS) || 90), 7 * 24 * 60 * 60 * 1000).unref();
});
