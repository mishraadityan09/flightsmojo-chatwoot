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

const app = express();
// Keep the RAW request bytes alongside the parsed JSON: the webhook signature
// is an HMAC over the exact bytes Chatwoot sent — re-stringifying the parsed
// object would not round-trip byte-for-byte.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

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
  const ts = req.get("x-chatwoot-timestamp") || "";
  const sig = req.get("x-chatwoot-signature") || "";
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!sig || !(age <= SIGNATURE_MAX_AGE_SECONDS)) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", CHATWOOT_BOT_HMAC_SECRET)
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
    histories.delete(conversationId);
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

// Lesson (learned the hard way, via a 401): the bot's token may POST replies
// and change conversation status, but may NOT read message history. So the
// bot keeps its own short-term memory per conversation, in RAM. A restart
// forgets mid-conversation context — acceptable for v1; the customer's next
// message simply starts fresh.
const histories = new Map(); // conversationId -> [{ role, parts }]

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
    histories.delete(conversationId); // closed chapter; a return starts fresh
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
function askLLM(history, systemPrompt, conversationId) {
  return BOT_PROVIDER === "openai"
    ? askOpenAI(history, systemPrompt, conversationId)
    : askGemini(history, systemPrompt, conversationId);
}

async function handleCustomerMessage(event) {
  const conversationId = event.conversation.id;
  console.log(`[conv ${conversationId}] customer: ${event.content}`);

  // Deterministic guardrail: an explicit ask for a human must never depend on
  // the LLM noticing — divert straight away, before any model call.
  if (WANTS_HUMAN_RE.test(event.content || "")) {
    console.log(`[conv ${conversationId}] explicit human request — diverting`);
    await connectToHuman(conversationId);
    return;
  }

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
  const reply = await askLLM([...history], systemPrompt, conversationId);
  typingOff(conversationId);
  // Race fix: a human may have replied during the seconds the model spent
  // thinking — the mute was set, but this in-flight reply would still land
  // AFTER theirs. Check again now that thinking is done; the human wins.
  if (isMuted(conversationId)) {
    console.log(`[conv ${conversationId}] human took over mid-reply — dropping bot reply`);
    return;
  }
  console.log(`[conv ${conversationId}] bot: ${reply}`);

  if (reply.trim() === "HANDOFF" || reply.includes("HANDOFF")) {
    await connectToHuman(conversationId);
  } else {
    remember(conversationId, "model", reply);
    await postReply(conversationId, reply);
    scheduleAutoResolve(conversationId); // silence from here = satisfied
  }
}

// Phrases that mean "I want a person" — conservative on purpose ("agent"
// alone would misfire on "travel agent"); the prompt's handoff rule catches
// the long tail this regex misses.
const WANTS_HUMAN_RE =
  /\bhuman\b|\blive ?agent\b|\breal (?:person|agent)\b|\bcustomer (?:care|service|support)\b|\brepresentative\b|\bexecutive\b|\b(?:talk|speak|chat) (?:to|with) (?:an? )?(?:agent|person|someone|somebody)\b|\bcall me\b|\bconnect me\b|\btransfer me\b/i;

// Untrusted-input shape check: a "known email" may only enter the system
// prompt if it actually looks like one email address (no spaces — so it
// cannot smuggle a sentence of instructions).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The full "a human takes over" sequence: mute FIRST (a fast follow-up
 *  message can still carry a stale "pending" status), then tell the customer,
 *  then flip the status so the chat lands in the human queue. */
async function connectToHuman(conversationId) {
  muteBot(conversationId);
  histories.delete(conversationId); // humans own it now
  await postReply(
    conversationId,
    "Let me connect you with one of our travel experts — a human teammate will be with you shortly. 🙋",
  );
  await handoffToHuman(conversationId);
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

const GEMINI_TOOLS = [
  {
    function_declarations: [
      {
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
      },
    ],
  },
];

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
    };
    if (BOOKING_TOOL_ENABLED) body.tools = GEMINI_TOOLS;

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

    const fcPart = (content.parts || []).find((p) => p.functionCall);
    if (!fcPart) {
      const text = (content.parts || []).map((p) => p.text || "").join("");
      if (!text) throw new Error("Gemini returned an empty reply");
      return text;
    }

    // Echo the model turn verbatim (keeps functionCall id + thoughtSignature
    // intact — required by the API), then append our tool result.
    const result = await executeBookingLookup(fcPart.functionCall.args);
    if (fcPart.functionCall.args?.bookingId && lookupSucceeded(result)) {
      stampBookingId(conversationId, fcPart.functionCall.args.bookingId);
    }
    contents.push(content);
    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: fcPart.functionCall.name,
            id: fcPart.functionCall.id,
            response: result,
          },
        },
      ],
    });
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

const OPENAI_TOOLS = [
  // Responses-API shape: flat, not nested under "function".
  {
    type: "function",
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
  },
];

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
    };
    if (BOOKING_TOOL_ENABLED) body.tools = OPENAI_TOOLS;

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
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch {}
        const result = await executeBookingLookup(args);
        if (args?.bookingId && lookupSucceeded(result)) stampBookingId(conversationId, args.bookingId);
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
    return text.trim();
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
});
