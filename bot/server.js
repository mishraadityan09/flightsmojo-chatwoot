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
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/webhook", (req, res) => {
  // Lesson 2: always answer webhooks fast (200 = "got it"), then work async —
  // if we dawdle, the sender times out and may retry, causing double replies.
  res.sendStatus(200);

  const event = req.body;
  const isCustomerMessage =
    event?.event === "message_created" &&
    event?.message_type === "incoming" &&
    event?.conversation?.status === "pending"; // bot only owns "pending" chats

  if (!isCustomerMessage) return;

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

  // What we ALREADY know about this customer — from the pre-chat form (email
  // → contact record) and prior lookups (booking_id → conversation attribute).
  // Both ride in the webhook payload, so they survive bot restarts / history
  // scroll-out. Inject them so the bot never re-asks for something it has.
  const conv = event.conversation || {};
  const knownBookingId = conv.custom_attributes?.booking_id;
  // Email can sit in a few payload spots depending on channel/version; take
  // the first that looks like an email. (Debug line below shows what arrived.)
  const emailCandidates = [
    conv.meta?.sender?.email,
    event.sender?.email,
    conv.contact_inbox?.contact?.email,
    conv.custom_attributes?.email,
  ];
  const knownEmail = emailCandidates.find((e) => e && String(e).includes("@"));
  console.log(`[conv ${conversationId}] known: email=${knownEmail ? "yes" : "no"} booking_id=${knownBookingId || "-"}`);

  let systemPrompt = systemPromptFor(conv.inbox_id);
  const known = [];
  if (knownEmail) known.push(`Email: ${knownEmail} (already provided — do NOT ask for the email again; use it for lookups)`);
  if (knownBookingId) known.push(`Booking ID: ${knownBookingId} (already provided — do NOT ask for the booking id again; use it directly)`);
  if (known.length) {
    systemPrompt += `\n\n## Already known about THIS customer\n${known.join("\n")}\nIf you have BOTH an email and a booking id/PNR here, call the lookup tool straight away instead of asking for anything.`;
  }

  const history = remember(conversationId, "user", event.content);
  const reply = await askLLM([...history], systemPrompt, conversationId);
  console.log(`[conv ${conversationId}] bot: ${reply}`);

  if (reply.trim() === "HANDOFF" || reply.includes("HANDOFF")) {
    await postReply(
      conversationId,
      "Let me connect you with one of our travel experts — a human teammate will be with you shortly. 🙋",
    );
    await handoffToHuman(conversationId);
    histories.delete(conversationId); // humans own it now
  } else {
    remember(conversationId, "model", reply);
    await postReply(conversationId, reply);
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
    return await res.json();
  } catch {
    return { error: "Lookup service unreachable. Do NOT alarm the customer — warmly tell them a human teammate will pull up their booking, then HANDOFF." };
  }
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
    if (fcPart.functionCall.args?.bookingId) {
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
        if (args?.bookingId) stampBookingId(conversationId, args.bookingId);
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
});
