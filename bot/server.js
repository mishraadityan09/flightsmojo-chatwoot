// FlightsMojo support bot — a Chatwoot Agent Bot backed by Gemini.
//
// Lesson 1 (server): this program sits on a port and waits. Chatwoot is
// configured (agent_bots.outgoing_url) to POST every customer message in
// bot-handled ("pending") conversations to /webhook below.
//
// The loop per message:
//   Chatwoot --POST /webhook--> us
//   us --GET history--> Chatwoot API
//   us --generateContent--> Gemini API
//   us --POST reply (or handoff)--> Chatwoot API
//
// Chatwoot's code is never modified; we only use its documented APIs.

import express from "express";
import crypto from "node:crypto";
import { buildSystemPrompt } from "./prompt.js";
import { TRANSFER_TOOL, parseTransfer, customerMessage, agentNote } from "./handoff.js";
import { parseInboxCountries, parseCancellationPhones, marketFor, phoneFor } from "./markets.js";
import { shouldCheck, classifierInput, classify, hasFirstReply } from "./intent.js";

// Lesson: config & secrets come from the environment (.env via compose),
// never from code.
const {
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",
  // Provider switch (2026-08-03): "gemini" (default) or "openai". Both paths
  // share the same history, prompt, and booking tool — flipping this env var
  // is the whole migration, and the way back.
  BOT_PROVIDER = "gemini",
  OPENAI_API_KEY,
  // GPT-5.6 Luna: OpenAI's cost tier ($0.20/$1.20 per 1M). Chosen 2026-08-03
  // after pricing R&D — supports function calling + automatic prompt caching.
  OPENAI_MODEL = "gpt-5.6-luna",
  // Luna's reasoning dial: none/low/medium/high/xhigh. "none" is cheapest but
  // proved trigger-happy on HANDOFF in prod testing (2026-08-03); "low" buys
  // a little judgment for a few reasoning tokens. Tunable here so quality
  // experiments don't need a code redeploy.
  OPENAI_REASONING_EFFORT = "low",
  // Compose-network default. On PRODUCTION set this to the public HTTPS URL
  // (https://chat.flightsmojo.com): FORCE_SSL makes Rails 301 plain-HTTP API
  // calls to https://rails:3000, where the bot then speaks TLS at a plain
  // port — ERR_SSL_WRONG_VERSION_NUMBER, and no reply/handoff ever lands.
  CHATWOOT_BASE_URL = "http://rails:3000",
  CHATWOOT_ACCOUNT_ID,
  CHATWOOT_BOT_TOKEN,
  // The agent bot's `secret` (agent_bots.secret in Chatwoot) — used only to
  // verify webhook signatures below. Unset = verification off (warned at boot).
  CHATWOOT_BOT_HMAC_SECRET,
  // Auto-resolve: minutes of customer silence after a bot reply before the
  // bot resolves the ticket itself. Defaults ON at 10 minutes; set 0 in the
  // env to turn it off. Chatwoot's own auto-resolve only covers "open"
  // (human) conversations, never "pending" (bot) ones — so quiet bot chats
  // would pile up forever without this.
  AUTO_RESOLVE_MINUTES = "10",
  // ── Cancellation routing (2026-10-07). Everything below is OFF until set. ──
  // The team that owns cancellations/reschedules (Settings → Teams → the id
  // in the URL). With it set, and a market switched on in CANCELLATION_PHONES
  // (markets.js), a cancellation handoff from the chat bot — and a
  // cancellation the intent checker finds on the other channels — goes to
  // this team, and the customer gets that market's number. Markets that are
  // not switched on stay plain handoffs.
  CANCELLATION_TEAM_ID,
  // Optional label added when routing (must exist in Settings → Labels).
  CANCELLATION_LABEL,
  // Secret of the ACCOUNT webhook that feeds /intent (Settings → Integrations
  // → Webhooks). Unset = the intent checker is off; /intent just says 200.
  CHATWOOT_WEBHOOK_SECRET,
  PORT = 3002,
} = process.env;

// Per-inbox site identity (multi-market): INBOX_SITES is a JSON map of
// inbox id -> human description ("flightsmojo.ae (UAE) — prices in AED").
// Unknown inboxes get a market-neutral prompt.
const INBOX_SITES = JSON.parse(process.env.INBOX_SITES || "{}");
const promptCache = new Map();
function systemPromptFor(inboxId) {
  const key = String(inboxId ?? "");
  if (!promptCache.has(key)) {
    promptCache.set(key, buildSystemPrompt(INBOX_SITES[key]));
  }
  return promptCache.get(key);
}

// Inbox → market map; doubles as the intent checker's watch list. Which
// markets are switched ON — and the number each quotes — is CANCELLATION_PHONES
// (markets.js). Routing needs a team and at least one market on; the checker
// also needs the webhook secret and at least one watched inbox.
const INBOX_COUNTRIES = parseInboxCountries(process.env.INBOX_COUNTRIES);
const CANCELLATION_PHONES = parseCancellationPhones(process.env.CANCELLATION_PHONES);
const ROUTING_ENABLED =
  /^\d+$/.test(String(CANCELLATION_TEAM_ID || "")) && Object.keys(CANCELLATION_PHONES).length > 0;
const INTENT_ENABLED =
  ROUTING_ENABLED && Boolean(CHATWOOT_WEBHOOK_SECRET) && Object.keys(INBOX_COUNTRIES).length > 0;
const CLASSIFIER_CONFIG = {
  provider: BOT_PROVIDER,
  openaiKey: OPENAI_API_KEY,
  openaiModel: OPENAI_MODEL,
  geminiKey: GEMINI_API_KEY,
  geminiModel: GEMINI_MODEL,
};

const app = express();
// Keep the RAW request bytes alongside the parsed JSON: the webhook signature
// is an HMAC over the exact bytes Chatwoot sent — re-stringifying the parsed
// object would not round-trip byte-for-byte. 1 MB because the account
// webhook now carries emails too (long quoted threads).
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Webhook authenticity ──
// Chatwoot signs every agent-bot delivery with the bot's `secret`:
//   X-Chatwoot-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")
// Verifying that seal means only Chatwoot can drive this bot — without it,
// anyone who can reach this port can post replies into arbitrary
// conversations. The timestamp bound stops replays of captured requests; the
// constant-time compare keeps response timing from leaking the expected value.
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

function isFromChatwoot(req) {
  if (!CHATWOOT_BOT_HMAC_SECRET) return true; // unset = open; warned at boot
  return signedWith(req, CHATWOOT_BOT_HMAC_SECRET);
}

// Account webhooks (the intent checker's feed) carry their own secret but use
// the very same signature scheme.
function signedWith(req, secret) {
  const ts = req.get("x-chatwoot-timestamp") || "";
  const sig = req.get("x-chatwoot-signature") || "";
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!sig || !(age <= SIGNATURE_MAX_AGE_SECONDS)) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(`${ts}.`)
      .update(req.rawBody ?? "")
      .digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/webhook", (req, res) => {
  // 401 (not a silent 200) so a mismatched secret shows up loudly in
  // Chatwoot's webhook logs instead of the bot just going quiet.
  if (!isFromChatwoot(req)) {
    console.warn("webhook rejected: missing/invalid Chatwoot signature");
    return res.sendStatus(401);
  }
  // Lesson 2: always answer webhooks fast (200 = "got it"), then work async —
  // if we dawdle, the sender times out and may retry, causing double replies.
  res.sendStatus(200);

  const event = req.body;

  // Status moved away from "pending" (an agent opened or resolved the chat —
  // even silently, without typing)? The bot no longer owns it, so a pending
  // quiet-timer must never fire. Conversation events carry the conversation
  // at the payload's top level (id = display_id, status alongside).
  if (
    ["conversation_status_changed", "conversation_opened", "conversation_resolved"].includes(event?.event) &&
    event.id &&
    event.status !== "pending"
  ) {
    cancelAutoResolve(event.id);
    return;
  }

  if (event?.event !== "message_created") return;
  const conversationId = event.conversation?.id;

  // Any customer activity restarts the quiet clock. (Deliberately NOT done
  // for outgoing messages: the bot's own reply echoes back as message_created
  // moments after we schedule the timer, and would cancel it instantly.)
  if (event.message_type === "incoming" && conversationId) {
    cancelAutoResolve(conversationId);
  }

  // A HUMAN agent wrote to the customer (sender type "user" = dashboard human;
  // our own replies arrive as "agent_bot", private notes don't count). From
  // that moment the humans own the conversation: mute the bot and make it
  // durable by flipping pending → open so it lands in the human queue.
  if (
    event.message_type === "outgoing" &&
    !event.private &&
    event.sender?.type === "user" &&
    conversationId
  ) {
    muteBot(conversationId);
    cancelAutoResolve(conversationId);
    forget(conversationId);
    console.log(`[conv ${conversationId}] human agent replied — bot muted`);
    if (event.conversation?.status === "pending") {
      handoffToHuman(conversationId).catch((e) =>
        console.error("open after human reply failed:", e),
      );
    }
    return;
  }

  const isCustomerMessage =
    event.message_type === "incoming" &&
    event.conversation?.status === "pending"; // bot only owns "pending" chats

  if (!isCustomerMessage || isMuted(conversationId)) return;

  handleCustomerMessage(event).catch((err) => {
    console.error("bot error:", err);
    // If anything breaks, fail toward humans — never leave the customer hanging.
    handoffToHuman(event.conversation.id).catch((e) =>
      console.error("handoff after error also failed:", e),
    );
  });
});

// ── Intent checker feed ──
// An ACCOUNT webhook (Settings → Integrations → Webhooks, event "message
// created", URL http://bot.flightsmojo.internal:3002/intent) delivers every
// message of the account here — email, website tickets, WhatsApp, and chats
// the humans already own. shouldCheck() keeps only customer messages on
// watched inboxes, in markets switched on in CANCELLATION_PHONES, that no
// agent has replied to or routed yet; those get one small classification
// call, and only a clear cancellation changes anything.
app.post("/intent", (req, res) => {
  if (!INTENT_ENABLED) return res.sendStatus(200); // configured off: acknowledge, do nothing
  if (!signedWith(req, CHATWOOT_WEBHOOK_SECRET)) {
    console.warn("intent webhook rejected: missing/invalid Chatwoot signature");
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  checkIntent(req.body).catch((err) => console.error("intent checker error:", err));
});

async function checkIntent(event) {
  const check = shouldCheck(event, { inboxCountries: INBOX_COUNTRIES, phones: CANCELLATION_PHONES });
  if (!check.ok) return;
  const conversationId = event.conversation.id;
  if (routingState.has(conversationId)) return; // being classified, or routed already
  rememberRouting(conversationId, "checking");
  try {
    const verdict = await classify(classifierInput(event), CLASSIFIER_CONFIG);
    console.log(
      `[conv ${conversationId}] intent: ${verdict.intent}${verdict.summary ? ` — ${verdict.summary}` : ""}`,
    );
    if (verdict.intent !== "cancellation") {
      routingState.delete(conversationId); // the next message gets a fresh look
      return;
    }
    // The webhook payload is a snapshot: an agent may have replied or routed
    // while the model was thinking. Look again before touching anything.
    const live = await chatwootGet(`/conversations/${conversationId}`);
    if (live?.meta?.team || hasFirstReply(live)) {
      routingState.delete(conversationId);
      return;
    }
    if (!(await routeToCancellations(conversationId))) {
      routingState.delete(conversationId);
      return; // nothing is said to the customer — the chat is exactly as it was
    }
    const conv = event.conversation;
    await postNote(
      conversationId,
      agentNote({
        source: "checker",
        reason: "cancellation",
        summary: verdict.summary,
        channel: conv.channel,
        routed: true,
      }),
    );
    await postReply(
      conversationId,
      customerMessage({
        reason: "cancellation",
        routed: true,
        phone: cancellationPhone(conv),
        channel: conv.channel,
      }),
    );
  } catch (err) {
    routingState.delete(conversationId);
    throw err;
  }
}

// Lesson (learned the hard way, via a 401): the bot's token may POST replies
// and change conversation status, but may NOT read message history. So the
// bot keeps its own short-term memory per conversation, in RAM. A restart
// forgets mid-conversation context — acceptable for v1; the customer's next
// message simply starts fresh.
const histories = new Map(); // conversationId -> [{ role, parts }]

// What the booking tool learned in this conversation — feeds the agent's
// handoff note ("Booking ID 221324 (verified by lookup)"). RAM, like histories.
const lookups = new Map(); // conversationId -> { email, bookingId, pnr, outcome }

function recordLookup(conversationId, args = {}, result) {
  if (!conversationId) return;
  let outcome = "unavailable";
  if (lookupSucceeded(result)) outcome = "found";
  else if (result?.found === false) outcome = "not found";
  else if (/payment/i.test(String(result?.error || ""))) outcome = "payment needs a human check";
  lookups.set(conversationId, {
    email: String(args.email || "").trim() || undefined,
    bookingId: args.bookingId ? String(args.bookingId) : undefined,
    pnr: String(args.pnr || "").trim() || undefined,
    outcome,
  });
}

/** A closed chapter — humans own it, or it was resolved. */
function forget(conversationId) {
  histories.delete(conversationId);
  lookups.delete(conversationId);
}

// Routing bookkeeping shared by the chat bot and the intent checker:
// conversations being classified or already routed, so two quick messages
// never route (and phone) the same customer twice. Bounded, in RAM.
const routingState = new Map(); // conversationId -> "checking" | "routed"

function rememberRouting(conversationId, state) {
  if (routingState.size > 1000) routingState.delete(routingState.keys().next().value);
  routingState.set(conversationId, state);
}

function remember(conversationId, role, text) {
  const history = histories.get(conversationId) ?? [];
  history.push({ role, parts: [{ text }] });
  // Cost lever (2026-08-03): 12 turns = 6 exchanges. Support chats resolve or
  // hand off well before that, and history is the second-biggest input cost
  // after the system prompt.
  while (history.length > 12) history.shift();
  histories.set(conversationId, history);
  return history;
}

// Mute list: conversations a human has taken over (or the bot just handed
// off). The DURABLE signal is conversation status — "pending" is the bot's,
// anything else is the humans' — but status changes travel through Chatwoot
// async, so a customer's next message can still carry a stale "pending"
// snapshot. The mute covers that gap. Short TTL on purpose: if a resolved
// chat reopens as "pending" later (Chatwoot routes it back to the bot), the
// bot may serve it again rather than leave the customer in silence.
const MUTE_MS = 5 * 60 * 1000;
const mutedUntil = new Map(); // conversationId -> timestamp

function muteBot(conversationId) {
  if (mutedUntil.size > 500) {
    for (const [id, until] of mutedUntil) if (until < Date.now()) mutedUntil.delete(id);
  }
  mutedUntil.set(conversationId, Date.now() + MUTE_MS);
}

function isMuted(conversationId) {
  const until = mutedUntil.get(conversationId);
  if (!until) return false;
  if (until < Date.now()) {
    mutedUntil.delete(conversationId);
    return false;
  }
  return true;
}

// ── Auto-resolve: a quiet, satisfied customer closes their own ticket ──
// After the bot replies, if the customer says nothing for AUTO_RESOLVE_MINUTES
// and no human ever touched the chat, the bot resolves the conversation. If
// the customer returns later, Chatwoot flips resolved → pending again and the
// bot picks them up fresh — so resolving is never a dead end. Timers live in
// RAM: a bot restart forgets them, and those chats simply stay pending until
// a human or the customer moves them (same trade-off as `histories` above).
const AUTO_RESOLVE_MS = (Number(AUTO_RESOLVE_MINUTES) || 0) * 60 * 1000;
const resolveTimers = new Map(); // conversationId -> timeout handle

function cancelAutoResolve(conversationId) {
  const timer = resolveTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    resolveTimers.delete(conversationId);
  }
}

// The goodbye is a fixed string, never the LLM: always on-brand, zero tokens.
const AUTO_RESOLVE_GOODBYE =
  "Looks like you're all set! I'll close this chat for now — if anything else comes up, just message us here and we'll pick it right up.";

function scheduleAutoResolve(conversationId) {
  if (!AUTO_RESOLVE_MS || !conversationId) return;
  cancelAutoResolve(conversationId);
  const timer = setTimeout(async () => {
    resolveTimers.delete(conversationId);
    // Last-moment guard: a human takeover in the final seconds mutes the
    // conversation before the status-change webhook lands.
    if (isMuted(conversationId)) return;
    forget(conversationId); // closed chapter; a return starts fresh
    try {
      await postReply(conversationId, AUTO_RESOLVE_GOODBYE);
      await chatwootPost(`/conversations/${conversationId}/toggle_status`, { status: "resolved" });
      console.log(`[conv ${conversationId}] auto-resolved after ${AUTO_RESOLVE_MINUTES} quiet minutes`);
    } catch (e) {
      console.error(`auto-resolve failed (non-fatal): ${e.message}`);
    }
  }, AUTO_RESOLVE_MS);
  resolveTimers.set(conversationId, timer);
}

// One seam, two providers. History is stored Gemini-style; askOpenAI converts.
// conversationId is threaded so the booking tool can persist what it looked up.
// Resolves to { text } (post it) or { handoff: { reason, summary } } (the
// model called transfer_to_human).
async function askLLM(history, systemPrompt, conversationId) {
  const outcome =
    BOT_PROVIDER === "openai"
      ? await askOpenAI(history, systemPrompt, conversationId)
      : await askGemini(history, systemPrompt, conversationId);
  // Belt and braces: a model that types the old HANDOFF word instead of
  // calling the tool still hands off — as "other", with nothing to summarise.
  if (outcome.text && outcome.text.includes("HANDOFF")) {
    return { handoff: parseTransfer({ reason: "other", summary: "" }) };
  }
  return outcome;
}

async function handleCustomerMessage(event) {
  const conversationId = event.conversation.id;
  console.log(`[conv ${conversationId}] customer: ${event.content}`);

  // What we ALREADY know about this customer — from the pre-chat form (email
  // → contact record) and prior lookups (booking_id → conversation attribute).
  // Both ride in the webhook payload, so they survive bot restarts / history
  // scroll-out. Inject them so the bot never re-asks for something it has.
  const conv = event.conversation || {};
  // custom_attributes are NOT bot-private: Chatwoot's public widget API lets
  // any visitor set arbitrary keys when opening a conversation. Every value
  // read from there is untrusted input — accept it only if it is shaped like
  // what it claims to be, else pretend it isn't there.
  const rawBookingId = String(conv.custom_attributes?.booking_id ?? "");
  const knownBookingId = /^\d{1,10}$/.test(rawBookingId) ? rawBookingId : null;
  // Email can sit in a few payload spots depending on channel/version; take
  // the first that looks like an email. (Debug line below shows what arrived.)
  const emailCandidates = [
    conv.meta?.sender?.email,
    event.sender?.email,
    conv.contact_inbox?.contact?.email,
    conv.custom_attributes?.email,
  ];
  const knownEmail = emailCandidates
    .map((e) => String(e ?? "").trim())
    .find((e) => e.length <= 254 && EMAIL_RE.test(e));
  // The name is free text from the pre-chat form, and it is headed for the
  // SYSTEM prompt — the model's trusted channel. Reduce it to something that
  // can only ever be a name: first word, letters/'/- only, hard length cap.
  // A "name" that doesn't survive that is dropped entirely.
  const knownName = conv.meta?.sender?.name || event.sender?.name;
  const firstWord = knownName ? String(knownName).trim().split(/\s+/)[0] : "";
  const firstName = firstWord.replace(/[^\p{L}'-]/gu, "").slice(0, 30) || null;
  console.log(`[conv ${conversationId}] known: email=${knownEmail ? "yes" : "no"} booking_id=${knownBookingId || "-"} name=${firstName || "-"}`);
  // Everything a handoff needs, whichever path takes the chat to a human.
  const ctx = { conv, knownEmail, knownBookingId };

  // Deterministic guardrail: an explicit ask for a human must never depend on
  // the LLM noticing — divert straight away, before any model call.
  if (WANTS_HUMAN_RE.test(event.content || "")) {
    console.log(`[conv ${conversationId}] explicit human request — diverting`);
    await connectToHuman(conversationId, ctx, {
      reason: "other",
      summary: `Customer asked for a human: "${snippet(event.content)}"`,
    });
    return;
  }

  let systemPrompt = systemPromptFor(conv.inbox_id);
  const known = [];
  if (firstName) known.push(`Customer's first name: ${firstName} (you may greet them by it once, naturally — don't overuse it)`);
  if (knownEmail) known.push(`Email: ${knownEmail} (already provided — do NOT ask for the email again; use it for lookups)`);
  if (knownBookingId) known.push(`Booking ID: ${knownBookingId} (already provided — do NOT ask for the booking id again; use it directly)`);
  if (known.length) {
    systemPrompt += `\n\n## Already known about THIS customer\n${known.join("\n")}\nIf you have BOTH an email and a booking id/PNR here, call the lookup tool straight away instead of asking for anything.`;
  }

  // "…is typing" while we think/look up, so the customer sees the bot is
  // working instead of silence (which makes them re-type). Best-effort.
  typingOn(conversationId);
  const history = remember(conversationId, "user", event.content);
  const outcome = await askLLM([...history], systemPrompt, conversationId);
  typingOff(conversationId);
  // Race fix: a human may have replied during the seconds the model spent
  // thinking — the mute was set, but this in-flight reply would still land
  // AFTER theirs. Check again now that thinking is done; the human wins.
  if (isMuted(conversationId)) {
    console.log(`[conv ${conversationId}] human took over mid-reply — dropping bot reply`);
    return;
  }

  if (outcome.handoff) {
    console.log(`[conv ${conversationId}] transfer (${outcome.handoff.reason}): ${outcome.handoff.summary}`);
    await connectToHuman(conversationId, ctx, outcome.handoff);
  } else {
    console.log(`[conv ${conversationId}] bot: ${outcome.text}`);
    remember(conversationId, "model", outcome.text);
    await postReply(conversationId, outcome.text);
    scheduleAutoResolve(conversationId); // silence from here = satisfied
  }
}

const snippet = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);

// Phrases that mean "I want a person" — conservative on purpose ("agent"
// alone would misfire on "travel agent"); the prompt's handoff rule catches
// the long tail this regex misses.
const WANTS_HUMAN_RE =
  /\bhuman\b|\blive ?agent\b|\breal (?:person|agent)\b|\bcustomer (?:care|service|support)\b|\brepresentative\b|\bexecutive\b|\b(?:talk|speak|chat) (?:to|with) (?:an? )?(?:agent|person|someone|somebody)\b|\bcall me\b|\bconnect me\b|\btransfer me\b/i;

// Untrusted-input shape check: a "known email" may only enter the system
// prompt if it actually looks like one email address (no spaces — so it
// cannot smuggle a sentence of instructions).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The number a customer in this conversation's market is given, or null when
 *  cancellation routing is switched off for that market (CANCELLATION_PHONES)
 *  or the inbox is not in INBOX_COUNTRIES. */
function cancellationPhone(conv) {
  return phoneFor(marketFor(conv, INBOX_COUNTRIES), CANCELLATION_PHONES);
}

/** The full "a human takes over" sequence: mute FIRST (a fast follow-up
 *  message can still carry a stale "pending" status), route it if it is a
 *  cancellation in a market that is switched on, brief the agent, tell the
 *  customer, then flip the status so the chat lands in the human queue. */
async function connectToHuman(conversationId, ctx, handoff) {
  muteBot(conversationId);
  const facts = lookups.get(conversationId) || {};
  forget(conversationId); // humans own it now
  const conv = ctx.conv || {};
  const cancellation = handoff.reason === "cancellation";
  // No number = routing is off for this market (or everywhere): plain handoff.
  const phone = cancellation && ROUTING_ENABLED ? cancellationPhone(conv) : null;
  const routed = Boolean(phone) && (await routeToCancellations(conversationId));
  await postNote(
    conversationId,
    agentNote({
      source: "bot",
      reason: handoff.reason,
      summary: handoff.summary,
      channel: conv.channel,
      email: ctx.knownEmail || facts.email,
      bookingId: ctx.knownBookingId || facts.bookingId,
      pnr: facts.pnr,
      lookup: facts.outcome,
      routed,
      routingOff: cancellation && !phone,
    }),
  );
  await postReply(conversationId, customerMessage({ reason: handoff.reason, routed, phone, channel: conv.channel }));
  await handoffToHuman(conversationId);
}

// Shared by the chat bot and the intent checker. Team first — when the team
// allows auto-assign, Chatwoot picks one of its members on the spot — then
// the optional label. Returns true only when the team really got set, so
// nobody tells the customer "passed to the cancellations team" unless it was.
async function routeToCancellations(conversationId) {
  try {
    await chatwootPost(`/conversations/${conversationId}/assignments`, {
      team_id: Number(CANCELLATION_TEAM_ID),
    });
  } catch (e) {
    console.error(`[conv ${conversationId}] team assignment failed: ${e.message}`);
    return false;
  }
  rememberRouting(conversationId, "routed");
  console.log(`[conv ${conversationId}] routed to cancellations team ${CANCELLATION_TEAM_ID}`);
  if (CANCELLATION_LABEL) await addLabel(conversationId, CANCELLATION_LABEL);
  return true;
}

// The labels endpoint REPLACES the list, so read it first and send the union.
async function addLabel(conversationId, label) {
  try {
    const current = (await chatwootGet(`/conversations/${conversationId}/labels`))?.payload || [];
    if (current.includes(label)) return;
    await chatwootPost(`/conversations/${conversationId}/labels`, { labels: [...current, label] });
  } catch (e) {
    console.error(`[conv ${conversationId}] label "${label}" failed (non-fatal): ${e.message}`);
  }
}

/** Private note — agents only. Best-effort: never blocks the customer's message. */
async function postNote(conversationId, content) {
  try {
    await chatwootPost(`/conversations/${conversationId}/messages`, {
      content,
      message_type: "outgoing",
      private: true,
    });
  } catch (e) {
    console.error(`[conv ${conversationId}] private note failed (non-fatal): ${e.message}`);
  }
}

// ── Chatwoot API (lesson 3a: authenticated REST calls) ──

function chatwootUrl(path) {
  return `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}${path}`;
}

const chatwootHeaders = {
  "Content-Type": "application/json",
  // HYPHENS, not underscores: nginx silently drops underscore headers
  // (ignore_invalid_headers default), which 401'd every prod reply while
  // working fine on the Mac's direct bot->rails path. Rack normalizes both
  // forms to HTTP_API_ACCESS_TOKEN, so hyphens work everywhere.
  "api-access-token": CHATWOOT_BOT_TOKEN, // the bot's badge
};

// fetch() resolves on 4xx/5xx — without this check a dead token or wrong
// account id looks IDENTICAL to success in the logs (bug found 2026-08-03:
// prod replies vanished with a clean log).
async function chatwootPost(path, payload) {
  const res = await fetch(chatwootUrl(path), {
    method: "POST",
    headers: chatwootHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      `Chatwoot API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return res;
}

async function chatwootGet(path) {
  const res = await fetch(chatwootUrl(path), { headers: chatwootHeaders });
  if (!res.ok) {
    throw new Error(
      `Chatwoot API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return res.json();
}

function postReply(conversationId, content) {
  return chatwootPost(`/conversations/${conversationId}/messages`, {
    content,
    message_type: "outgoing",
  });
}

/** Flip pending → open: the chat appears in the human agents' queue. */
function handoffToHuman(conversationId) {
  return chatwootPost(`/conversations/${conversationId}/toggle_status`, {
    status: "open",
  });
}

/** Show/hide the "…is typing" indicator. Best-effort — a failure here must
 *  never affect the reply, so we swallow errors. */
function toggleTyping(conversationId, status) {
  chatwootPost(`/conversations/${conversationId}/toggle_typing_status`, {
    typing_status: status,
  }).catch(() => {});
}
const typingOn = (id) => toggleTyping(id, "on");
const typingOff = (id) => toggleTyping(id, "off");

/**
 * Persist the booking id onto the conversation (custom attribute), so it
 * survives bot restarts and history scroll-out, shows in the agent's info
 * panel, and feeds the CRM dashboard app. This is what makes "don't ask for
 * the booking id twice" reliable rather than RAM-dependent. Best-effort:
 * a failure here must never break the reply.
 */
async function stampBookingId(conversationId, bookingId) {
  if (!conversationId || !bookingId) return;
  try {
    await chatwootPost(`/conversations/${conversationId}/custom_attributes`, {
      custom_attributes: { booking_id: String(bookingId) },
    });
    console.log(`[conv ${conversationId}] stamped booking_id=${bookingId}`);
  } catch (e) {
    console.error(`stamp booking_id failed (non-fatal): ${e.message}`);
  }
}

// Only a VERIFIED booking id may be stamped. Persisting whatever id the model
// passed to the tool — even when the lookup found nothing — would poison every
// later turn with "already provided — use it directly", making a customer's
// typo permanent.
function lookupSucceeded(result) {
  return Boolean(result) && !result.error && result.found !== false;
}

// ── Booking lookup tool (least-privilege bot API, X-Api-Key auth) ──
// Verification rule: email is MANDATORY plus PNR or bookingId. Enforced in
// three layers: tool schema, prompt rules, and the hard check below.

const { BOOKING_API_URL, BOOKING_API_KEY } = process.env;
const BOOKING_TOOL_ENABLED = Boolean(BOOKING_API_URL && BOOKING_API_KEY);

const BOOKING_TOOL = {
  name: "get_booking_status",
  description:
    "Look up a FlightsMojo booking's status, flights, and payment state. " +
    "Requires the customer's email AND at least one of: PNR, bookingId.",
  parameters: {
    type: "object",
    properties: {
      email: { type: "string", description: "Email used on the booking (mandatory)" },
      pnr: { type: "string", description: "Airline PNR, e.g. M22W8V" },
      bookingId: { type: "integer", description: "FlightsMojo booking id" },
    },
    required: ["email"],
  },
};

// The transfer tool is always on; the booking tool only with a configured API.
const TOOL_SET = BOOKING_TOOL_ENABLED ? [TRANSFER_TOOL, BOOKING_TOOL] : [TRANSFER_TOOL];
const GEMINI_TOOLS = [{ function_declarations: TOOL_SET }];
// Responses-API shape: flat, not nested under "function".
const OPENAI_TOOLS = TOOL_SET.map((tool) => ({ type: "function", ...tool }));

// Runs the lookup, keeps what it learned for the handoff note, and stamps the
// booking id on the conversation once it is verified.
async function runBookingTool(conversationId, args = {}) {
  const result = await executeBookingLookup(args);
  recordLookup(conversationId, args, result);
  if (args?.bookingId && lookupSucceeded(result)) stampBookingId(conversationId, args.bookingId);
  return result;
}

async function executeBookingLookup(args = {}) {
  const email = String(args.email || "").trim();
  const pnr = String(args.pnr || "").trim();
  const bookingId = Number(args.bookingId) || 0;
  if (!email || (!pnr && !bookingId)) {
    return { error: "Missing details. Email plus a PNR or booking id are required — ask the customer for the missing piece." };
  }
  console.log(`booking lookup: id=${bookingId || "-"} pnr=${pnr || "-"} email=***`);
  try {
    const res = await fetch(BOOKING_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": BOOKING_API_KEY },
      body: JSON.stringify({ email, pnr: pnr || null, bookingId: bookingId || null }),
    });
    if (!res.ok) {
      return { error: `Lookup temporarily unavailable (HTTP ${res.status}). Do NOT alarm the customer — warmly tell them a human teammate will pull up their booking, then HANDOFF.` };
    }
    return sanitizePaymentStates(await res.json());
  } catch {
    return { error: "Lookup service unreachable. Do NOT alarm the customer — warmly tell them a human teammate will pull up their booking, then HANDOFF." };
  }
}

// CRM payment states are INTERNAL. "Authorized" means the money is with US
// (an agent often captures manually and then issues the ticket) — to the
// customer that is simply "payment received"; the raw word reads as "my
// payment didn't go through". Rewrite the states deterministically before the
// LLM ever sees them, so no prompt slip can leak one. And a PROBLEM state
// (failed/pending/declined) under a payment field is a human's job: replace
// the whole result with a handoff directive so the bot can't narrate it.
// Scoped to payment-ish keys on purpose — a BOOKING status of "Pending" is
// the normal in-progress case the bot handles itself.
function sanitizePaymentStates(result) {
  let paymentProblem = false;
  const walk = (value, inPayment) => {
    if (Array.isArray(value)) return value.map((v) => walk(v, inPayment));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, inPayment || /pay/i.test(k));
      return out;
    }
    if (typeof value === "string") {
      const s = value.trim();
      if (/^(authori[sz]ed|captured)$/i.test(s)) return "Received";
      if (inPayment && /^(failed|failure|declined|pending)$/i.test(s)) paymentProblem = true;
    }
    return value;
  };
  const sanitized = walk(result, false);
  if (paymentProblem) {
    return { error: "The payment on this booking needs a human to check it. Do NOT mention payment states or alarm the customer — warmly tell them a teammate will look into their booking and payment right away, then HANDOFF." };
  }
  return sanitized;
}

// ── Gemini API (lesson 3b + 4: stateless LLM calls + tool loop) ──
// The WHOLE conversation is re-sent every time — the model remembers nothing
// between calls. When it returns a functionCall instead of text, we run the
// tool, append the result, and call again (bounded rounds).

async function askGemini(history, systemPrompt, conversationId) {
  const contents = [...history];

  for (let round = 0; round < 4; round++) {
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      tools: GEMINI_TOOLS,
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    const content = json.candidates?.[0]?.content;
    if (!content) throw new Error("Gemini returned no content");

    const calls = (content.parts || []).filter((p) => p.functionCall);
    if (!calls.length) {
      const text = (content.parts || []).map((p) => p.text || "").join("");
      if (!text) throw new Error("Gemini returned an empty reply");
      return { text };
    }

    // Echo the model turn verbatim (keeps functionCall id + thoughtSignature
    // intact — required by the API), then append our tool results.
    contents.push(content);
    const responses = [];
    let transfer = null;
    for (const { functionCall } of calls) {
      if (functionCall.name === TRANSFER_TOOL.name) {
        transfer = parseTransfer(functionCall.args);
        continue;
      }
      const result = await runBookingTool(conversationId, functionCall.args);
      responses.push({
        functionResponse: { name: functionCall.name, id: functionCall.id, response: result },
      });
    }
    // A transfer ends the turn: the system speaks to the customer from here.
    if (transfer) return { handoff: transfer };
    contents.push({ role: "user", parts: responses });
  }
  throw new Error("Tool loop exceeded max rounds");
}

// ── OpenAI path (GPT-5.6 Luna) ──
// Same contract as askGemini: takes Gemini-style history + system prompt,
// returns reply text (or a HANDOFF-containing string). Differences live
// entirely in this function so the rest of the bot doesn't know which
// provider answered.
//
// Prompt caching is AUTOMATIC on OpenAI: any identical prompt prefix over
// ~1024 tokens is cached (~90% discount on those tokens). Our system prompt
// is ~2.5k tokens and byte-stable per inbox (promptCache above), so it
// qualifies as long as nothing dynamic is prepended. The usage log below
// prints cached_tokens so you can watch it kick in from the second call.

// Stored history is Gemini-shaped ({role: user|model, parts:[{text}]}) and
// only ever contains plain text (tool rounds stay local to each ask* call).
function toOpenAIInput(history) {
  return history.map((turn) => ({
    role: turn.role === "model" ? "assistant" : "user",
    content: turn.parts.map((p) => p.text || "").join(""),
  }));
}

async function askOpenAI(history, systemPrompt, conversationId) {
  // /v1/responses, not /v1/chat/completions: Luna rejects function tools
  // combined with reasoning_effort on the older endpoint (400, found in prod
  // 2026-08-03). Responses is also where OpenAI ships new features first.
  const input = toOpenAIInput(history);

  for (let round = 0; round < 4; round++) {
    const body = {
      model: OPENAI_MODEL,
      instructions: systemPrompt,
      input,
      // Reasoning tokens spend from the output budget, so this cap covers
      // "low" effort + a short reply. Visible output stays short per prompt.
      max_output_tokens: 1024,
      reasoning: { effort: OPENAI_REASONING_EFFORT },
      store: false, // don't retain conversations on OpenAI's side
      tools: OPENAI_TOOLS,
    };

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();

    // Caching visibility: cached_tokens > 0 from the 2nd call on = discount live.
    const u = json.usage || {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    console.log(
      `[openai] in=${u.input_tokens} (cached=${cached}) out=${u.output_tokens}`,
    );

    const calls = (json.output || []).filter((o) => o.type === "function_call");
    if (calls.length) {
      let transfer = null;
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch {}
        if (call.name === TRANSFER_TOOL.name) {
          transfer = parseTransfer(args);
          continue;
        }
        const result = await runBookingTool(conversationId, args);
        input.push({
          type: "function_call",
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments,
        });
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }
      // A transfer ends the turn: the system speaks to the customer from here.
      if (transfer) return { handoff: transfer };
      continue;
    }

    const text =
      json.output_text ??
      (json.output || [])
        .filter((o) => o.type === "message")
        .flatMap((m) => m.content || [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
    if (!text || !text.trim()) throw new Error("OpenAI returned an empty reply");
    return { text: text.trim() };
  }
  throw new Error("Tool loop exceeded max rounds");
}

app.listen(PORT, () => {
  const model = BOT_PROVIDER === "openai" ? OPENAI_MODEL : GEMINI_MODEL;
  console.log(`FlightsMojo support bot listening on :${PORT} (${BOT_PROVIDER}: ${model})`);
  if (!CHATWOOT_BOT_HMAC_SECRET) {
    console.warn(
      "CHATWOOT_BOT_HMAC_SECRET is not set — /webhook accepts UNSIGNED requests. " +
        "Set it to the agent bot's secret (agent_bots.secret) to lock this down.",
    );
  }
  console.log(
    AUTO_RESOLVE_MS
      ? `auto-resolve: ON — quiet bot chats resolve after ${AUTO_RESOLVE_MINUTES} min`
      : "auto-resolve: off (set AUTO_RESOLVE_MINUTES to enable)",
  );
  const watched = Object.keys(INBOX_COUNTRIES);
  const marketsOn = Object.keys(CANCELLATION_PHONES);
  console.log(
    ROUTING_ENABLED
      ? `cancellation routing: ON for ${marketsOn.join(", ")} — team ${CANCELLATION_TEAM_ID}` +
          (CANCELLATION_LABEL ? `, label "${CANCELLATION_LABEL}"` : "") +
          `; inbox → market map for ${watched.join(", ") || "(none)"}`
      : "cancellation routing: off (set CANCELLATION_TEAM_ID and CANCELLATION_PHONES to enable)",
  );
  console.log(
    INTENT_ENABLED
      ? `intent checker: ON — watching inboxes ${watched.join(", ")} via /intent, acting only for ${marketsOn.join(", ")}`
      : "intent checker: off (needs CANCELLATION_TEAM_ID, CANCELLATION_PHONES, CHATWOOT_WEBHOOK_SECRET and INBOX_COUNTRIES)",
  );
});
