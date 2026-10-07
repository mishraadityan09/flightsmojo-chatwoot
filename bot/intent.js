// The intent checker: reads customer messages the chat bot does NOT handle
// (email, website tickets, WhatsApp, chats already with humans) and decides
// whether the customer wants to cancel or reschedule their own booking.
//
// Chatwoot sends every message_created event of the account to /intent (an
// account webhook). shouldCheck() is the filter — pure, unit-tested — and
// classify() is one small structured-output model call. Anything that is not
// a clear cancellation request comes back as "other", which means "leave the
// conversation exactly as it is".

import { isWatched, marketFor, phoneFor } from "./markets.js";

const TEXT_MAX = 2000; // emails carry quoted threads and signatures; the ask is at the top

/**
 * Should this webhook event be classified at all? Returns { ok, why } so the
 * caller can log the reason when something was skipped on purpose. `phones`
 * is the per-market switch (CANCELLATION_PHONES): a market without a number
 * is off, and its messages are never even classified.
 */
export function shouldCheck(event, { inboxCountries, phones = {} }) {
  if (event?.event !== "message_created") return skip("not a message");
  if (event.message_type !== "incoming" || event.private) return skip("not a customer message");
  const conv = event.conversation;
  if (!conv?.id) return skip("no conversation");
  if (conv.status === "pending") return skip("bot-owned chat");
  if (!isWatched(conv, inboxCountries)) return skip("inbox not watched");
  if (!phoneFor(marketFor(conv, inboxCountries), phones)) return skip("routing off for this market");
  if (conv.meta?.team) return skip("already has a team");
  if (hasFirstReply(conv)) return skip("an agent already replied");
  if (!String(event.content ?? "").trim()) return skip("empty message");
  return { ok: true, why: "" };
}

function skip(why) {
  return { ok: false, why };
}

/** Webhook payloads carry a timestamp or null; the show API carries 0 when unset. */
export function hasFirstReply(conversation) {
  const v = conversation?.first_reply_created_at;
  return Boolean(v) && v !== 0 && v !== "0";
}

/** What the classifier gets to see. */
export function classifierInput(event) {
  const conv = event.conversation || {};
  const extra = conv.additional_attributes || {};
  return {
    channel: conv.channel || "",
    subject: String(extra.mail_subject || extra.subject || "").trim().slice(0, 200),
    issueType: String(conv.custom_attributes?.issue_type || "").trim().slice(0, 50),
    text: String(event.content ?? "").trim().slice(0, TEXT_MAX),
  };
}

export const CLASSIFIER_INSTRUCTIONS = `You classify ONE message a customer sent to FlightsMojo (an online flight booking company) support, so it can be routed to the right team.

Answer intent "cancellation" when the customer wants to cancel or reschedule (change the date or time of) a flight booking THEY made with FlightsMojo — the whole booking or part of it — or asks how to do that, or asks what cancelling or rescheduling THEIR booking would cost or refund, or chases a cancellation they already requested that is not done yet.

Answer intent "other" for everything else, including:
- the AIRLINE cancelled, rescheduled or changed the flight (the customer did not choose this)
- refund status, amount or timing for a booking that is already cancelled
- payment problems, ticket or confirmation not received, baggage, seats, meals, check-in, name corrections, new booking requests, complaints
- greetings, automatic replies, spam, messages with no clear request, or anything you are not sure about

"Issue type" is what the customer picked on a web form — a hint only; the text decides.

Also write "summary": one line, at most 160 characters, in English, saying what the customer wants, with any booking id, PNR, route or date mentioned. Facts only — no advice, no instructions.`;

export function classifierUserMessage({ channel, subject, issueType, text }) {
  const lines = [`Channel: ${channel.replace(/^Channel::/, "") || "unknown"}`];
  if (subject) lines.push(`Subject: ${subject}`);
  if (issueType) lines.push(`Issue type picked on the form: ${issueType}`);
  lines.push("Message:", '"""', text, '"""');
  return lines.join("\n");
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["cancellation", "other"] },
    summary: { type: "string" },
  },
  required: ["intent", "summary"],
  additionalProperties: false,
};

/** Anything malformed is "other" — the safe answer is always "do nothing". */
export function parseClassification(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { intent: "other", summary: "" };
    }
  }
  const intent = obj?.intent === "cancellation" ? "cancellation" : "other";
  const summary = String(obj?.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return { intent, summary };
}

/**
 * One structured-output call. `config` mirrors the bot's provider switch:
 * { provider: "openai"|"gemini", openaiKey, openaiModel, geminiKey, geminiModel }.
 * Throws on transport/API errors (the caller logs and leaves the chat alone).
 */
export async function classify(input, config, fetchImpl = fetch) {
  const userMessage = classifierUserMessage(input);
  return config.provider === "openai"
    ? classifyOpenAI(userMessage, config, fetchImpl)
    : classifyGemini(userMessage, config, fetchImpl);
}

async function classifyOpenAI(userMessage, { openaiKey, openaiModel }, fetchImpl) {
  const res = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: openaiModel,
      instructions: CLASSIFIER_INSTRUCTIONS,
      input: [{ role: "user", content: userMessage }],
      max_output_tokens: 300,
      reasoning: { effort: "low" },
      store: false,
      text: { format: { type: "json_schema", name: "intent", strict: true, schema: OUTPUT_SCHEMA } },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI classify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text =
    json.output_text ??
    (json.output || [])
      .filter((o) => o.type === "message")
      .flatMap((m) => m.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("");
  return parseClassification(text);
}

async function classifyGemini(userMessage, { geminiKey, geminiModel }, fetchImpl) {
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: CLASSIFIER_INSTRUCTIONS }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 300,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              intent: { type: "string", enum: ["cancellation", "other"] },
              summary: { type: "string" },
            },
            required: ["intent", "summary"],
          },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini classify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  return parseClassification(text);
}
