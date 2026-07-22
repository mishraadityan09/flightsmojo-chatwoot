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
  CHATWOOT_BASE_URL = "http://rails:3000", // compose network: service name = hostname
  CHATWOOT_ACCOUNT_ID,
  CHATWOOT_BOT_TOKEN,
  PORT = 3002,
} = process.env;

const SYSTEM_PROMPT = buildSystemPrompt();

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
  while (history.length > 20) history.shift(); // keep the last 10 exchanges
  histories.set(conversationId, history);
  return history;
}

async function handleCustomerMessage(event) {
  const conversationId = event.conversation.id;
  console.log(`[conv ${conversationId}] customer: ${event.content}`);

  const history = remember(conversationId, "user", event.content);
  const reply = await askGemini([...history]);
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
  api_access_token: CHATWOOT_BOT_TOKEN, // the bot's badge
};

function postReply(conversationId, content) {
  return fetch(chatwootUrl(`/conversations/${conversationId}/messages`), {
    method: "POST",
    headers: chatwootHeaders,
    body: JSON.stringify({ content, message_type: "outgoing" }),
  });
}

/** Flip pending → open: the chat appears in the human agents' queue. */
function handoffToHuman(conversationId) {
  return fetch(chatwootUrl(`/conversations/${conversationId}/toggle_status`), {
    method: "POST",
    headers: chatwootHeaders,
    body: JSON.stringify({ status: "open" }),
  });
}

// ── Gemini API (lesson 3b + 4: stateless LLM calls) ──
// Note: the WHOLE conversation is re-sent every time — the model remembers
// nothing between calls. The system prompt (the briefing) rides along too.

async function askGemini(history) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: history,
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) throw new Error("Gemini returned an empty reply");
  return text;
}

app.listen(PORT, () => {
  console.log(`FlightsMojo support bot listening on :${PORT} (model: ${GEMINI_MODEL})`);
});
