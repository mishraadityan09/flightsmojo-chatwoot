import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldCheck,
  hasFirstReply,
  classifierInput,
  classifierUserMessage,
  parseClassification,
  classify,
  CLASSIFIER_INSTRUCTIONS,
} from "../../bot/intent.js";

const CFG = {
  inboxCountries: { 1: "IN", 2: "AE", 9: "*", 12: "US" },
  phones: { IN: "00911246932002", US: "+1 202-839-9858" }, // AE is mapped but switched off
};

// A customer email on a watched inbox that nobody has touched: the one case
// that must pass. Every other test knocks out one condition.
function event(overrides = {}, conv = {}) {
  return {
    event: "message_created",
    message_type: "incoming",
    private: false,
    content: "Please cancel my booking 345678",
    conversation: {
      id: 501,
      inbox_id: 12,
      status: "open",
      channel: "Channel::Email",
      meta: { team: null, assignee: null },
      first_reply_created_at: null,
      additional_attributes: { mail_subject: "Cancel booking" },
      custom_attributes: {},
      ...conv,
    },
    ...overrides,
  };
}

test("shouldCheck passes a fresh customer message on a watched inbox", () => {
  assert.deepEqual(shouldCheck(event(), CFG), { ok: true, why: "" });
});

test("shouldCheck skips everything that is not a customer message", () => {
  assert.equal(shouldCheck(event({ event: "conversation_updated" }), CFG).why, "not a message");
  assert.equal(shouldCheck(event({ message_type: "outgoing" }), CFG).why, "not a customer message");
  assert.equal(shouldCheck(event({ private: true }), CFG).why, "not a customer message");
  assert.equal(shouldCheck(undefined, CFG).why, "not a message");
  assert.equal(shouldCheck({ event: "message_created", message_type: "incoming" }, CFG).why, "no conversation");
});

test("shouldCheck leaves bot-owned (pending) chats to the chat bot", () => {
  assert.equal(shouldCheck(event({}, { status: "pending" }), CFG).why, "bot-owned chat");
});

test("shouldCheck ignores inboxes that are not on the watch list", () => {
  assert.equal(shouldCheck(event({}, { inbox_id: 17 }), CFG).why, "inbox not watched");
});

test("shouldCheck leaves markets alone that are not switched on in CANCELLATION_PHONES", () => {
  assert.equal(shouldCheck(event({}, { inbox_id: 1 }), CFG).ok, true);
  assert.equal(shouldCheck(event({}, { inbox_id: 2 }), CFG).why, "routing off for this market");
  assert.equal(shouldCheck(event({}, { inbox_id: 9, custom_attributes: { country: "in" } }), CFG).ok, true);
  assert.equal(shouldCheck(event({}, { inbox_id: 9, custom_attributes: { country: "UK" } }), CFG).why, "routing off for this market");
  assert.equal(shouldCheck(event({}, { inbox_id: 9 }), CFG).why, "routing off for this market");
  assert.equal(shouldCheck(event(), { inboxCountries: CFG.inboxCountries }).why, "routing off for this market");
});

test("shouldCheck stops once a team is set or an agent has replied", () => {
  assert.equal(shouldCheck(event({}, { meta: { team: { id: 3, name: "Refunds" } } }), CFG).why, "already has a team");
  assert.equal(shouldCheck(event({}, { first_reply_created_at: "2026-10-07T08:00:00Z" }), CFG).why, "an agent already replied");
  assert.equal(shouldCheck(event({}, { first_reply_created_at: 1759824000 }), CFG).why, "an agent already replied");
});

test("shouldCheck skips attachment-only or blank messages", () => {
  assert.equal(shouldCheck(event({ content: "   " }), CFG).why, "empty message");
  assert.equal(shouldCheck(event({ content: null }), CFG).why, "empty message");
});

test("hasFirstReply treats null, 0 and '0' as no reply", () => {
  assert.equal(hasFirstReply({ first_reply_created_at: null }), false);
  assert.equal(hasFirstReply({ first_reply_created_at: 0 }), false);
  assert.equal(hasFirstReply({ first_reply_created_at: "0" }), false);
  assert.equal(hasFirstReply({}), false);
  assert.equal(hasFirstReply({ first_reply_created_at: 1759824000 }), true);
  assert.equal(hasFirstReply({ first_reply_created_at: "2026-10-07T08:00:00Z" }), true);
});

test("classifierInput picks subject, issue type and the start of the text", () => {
  const long = "x".repeat(5000);
  const input = classifierInput(
    event({ content: `  ${long}` }, { channel: "Channel::Api", additional_attributes: { subject: "Need help" }, custom_attributes: { issue_type: "change-cancel" } }),
  );
  assert.equal(input.channel, "Channel::Api");
  assert.equal(input.subject, "Need help");
  assert.equal(input.issueType, "change-cancel");
  assert.equal(input.text.length, 2000);
});

test("classifierUserMessage omits lines it has nothing for", () => {
  const msg = classifierUserMessage({ channel: "Channel::Whatsapp", subject: "", issueType: "", text: "cancel pls" });
  assert.equal(msg, 'Channel: Whatsapp\nMessage:\n"""\ncancel pls\n"""');
  const full = classifierUserMessage({ channel: "Channel::Api", subject: "S", issueType: "refund-request", text: "t" });
  assert.match(full, /^Channel: Api\nSubject: S\nIssue type picked on the form: refund-request\nMessage:/);
});

test("parseClassification: only a literal cancellation routes; everything else is other", () => {
  assert.deepEqual(parseClassification(JSON.stringify({ intent: "cancellation", summary: "  cancel \n 1 " })), { intent: "cancellation", summary: "cancel 1" });
  assert.deepEqual(parseClassification({ intent: "other", summary: "hi" }), { intent: "other", summary: "hi" });
  assert.deepEqual(parseClassification({ intent: "Cancellation", summary: "" }), { intent: "other", summary: "" });
  assert.deepEqual(parseClassification("not json"), { intent: "other", summary: "" });
  assert.deepEqual(parseClassification(null), { intent: "other", summary: "" });
});

test("instructions name the airline-initiated and refund-status exclusions", () => {
  assert.match(CLASSIFIER_INSTRUCTIONS, /AIRLINE cancelled/);
  assert.match(CLASSIFIER_INSTRUCTIONS, /refund status/);
  assert.match(CLASSIFIER_INSTRUCTIONS, /not sure about/);
});

test("classify (openai): sends a strict JSON schema and parses output_text", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, json: async () => ({ output_text: '{"intent":"cancellation","summary":"cancel 345678"}' }) };
  };
  const verdict = await classify(
    { channel: "Channel::Email", subject: "Cancel", issueType: "", text: "Please cancel 345678" },
    { provider: "openai", openaiKey: "k", openaiModel: "m" },
    fetchImpl,
  );
  assert.deepEqual(verdict, { intent: "cancellation", summary: "cancel 345678" });
  assert.equal(sent.url, "https://api.openai.com/v1/responses");
  assert.equal(sent.auth, "Bearer k");
  assert.equal(sent.body.model, "m");
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.text.format.type, "json_schema");
  assert.equal(sent.body.text.format.strict, true);
  assert.deepEqual(sent.body.text.format.schema.properties.intent.enum, ["cancellation", "other"]);
  assert.match(sent.body.input[0].content, /Subject: Cancel/);
});

test("classify (openai): falls back to the message items when output_text is absent", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: '{"intent":"other","summary":"asks about baggage"}' }] },
      ],
    }),
  });
  const verdict = await classify({ channel: "", subject: "", issueType: "", text: "baggage?" }, { provider: "openai" }, fetchImpl);
  assert.deepEqual(verdict, { intent: "other", summary: "asks about baggage" });
});

test("classify (gemini): JSON mode with a response schema", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"intent":"cancellation","summary":"s"}' }] } }] }) };
  };
  const verdict = await classify(
    { channel: "Channel::Whatsapp", subject: "", issueType: "", text: "cancel karni hai" },
    { provider: "gemini", geminiKey: "g", geminiModel: "gemini-2.5-flash" },
    fetchImpl,
  );
  assert.deepEqual(verdict, { intent: "cancellation", summary: "s" });
  assert.match(sent.url, /gemini-2\.5-flash:generateContent\?key=g$/);
  assert.equal(sent.body.generationConfig.responseMimeType, "application/json");
  assert.equal(sent.body.generationConfig.temperature, 0);
  assert.equal(sent.body.system_instruction.parts[0].text, CLASSIFIER_INSTRUCTIONS);
});

test("classify throws on an API error so the caller leaves the chat alone", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => "quota" });
  await assert.rejects(
    classify({ channel: "", subject: "", issueType: "", text: "x" }, { provider: "openai" }, fetchImpl),
    /OpenAI classify 429: quota/,
  );
});
