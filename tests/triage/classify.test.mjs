import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, INSTRUCTIONS, IROP_TYPES, OUTPUT_SCHEMA, VERDICTS, classifierUserMessage, classify, parseVerdict, unsureVerdict } from "../../triage/classify.js";
import { json, stubFetch } from "./helpers.mjs";

// ── parseVerdict ──

const RAW = {
  verdict: "irop",
  category: "irop",
  irop_type: "schedule_change",
  pnrs: ["abc123", "ABC123", "ab-c123", " k7x2qm ", "ABCD", "TOOLONGPNR1234", 123456, null],
  airline: "  Air  India ",
  flights: [{ number: " AI 131 ", route: "DEL-LHR", old_departure: "2026-11-02T03:30", new_departure: "2026-11-02T04:55" }],
  travel_date: "2026-11-02",
  action_deadline: "28/10/2026",
  action_required: true,
  summary: "  AI 131 DEL-LHR 02 Nov\nretimed   0330→0455 ",
  reason: " supplier notice ",
};

test("parseVerdict: a valid verdict (JSON string or object) is normalised", () => {
  for (const input of [JSON.stringify(RAW), RAW]) {
    const v = parseVerdict(input);
    assert.equal(v.verdict, "irop");
    assert.equal(v.category, "irop");
    assert.equal(v.iropType, "schedule_change");
    assert.deepEqual(v.pnrs, ["ABC123", "K7X2QM"], "uppercased, non-alphanumerics stripped, deduped, 5–8 chars only");
    assert.equal(v.airline, "Air India");
    assert.deepEqual(v.flights, [{ number: "AI 131", route: "DEL-LHR", old_departure: "2026-11-02T03:30", new_departure: "2026-11-02T04:55" }]);
    assert.equal(v.travelDate, "2026-11-02");
    assert.equal(v.actionDeadline, null, "not YYYY-MM-DD → null");
    assert.equal(v.actionRequired, true);
    assert.equal(v.summary, "AI 131 DEL-LHR 02 Nov retimed 0330→0455");
    assert.equal(v.reason, "supplier notice");
  }
});

test("parseVerdict: PNR shapes — 5 to 8 alphanumerics after cleaning, deduped, non-arrays ignored", () => {
  // "PNR: K7X2QM" cleans to PNRK7X2QM (9 chars) and is dropped like any other over-long token
  assert.deepEqual(parseVerdict({ verdict: "irop", pnrs: ["K7X2Q", "K7X2QM", "K7X2QMAB", "K7X2QMABC", "K7X", "k7x-2qm", "PNR: K7X2QM"] }).pnrs, ["K7X2Q", "K7X2QM", "K7X2QMAB"]);
  assert.deepEqual(parseVerdict({ verdict: "irop", pnrs: "K7X2QM" }).pnrs, []);
  assert.deepEqual(parseVerdict({ verdict: "irop" }).pnrs, []);
});

test("parseVerdict: dates must be YYYY-MM-DD, else null", () => {
  for (const bad of ["02/11/2026", "2026-11-02T03:30", "Nov 2", 20261102, null, undefined, "", "2026-1-2"]) {
    const v = parseVerdict({ verdict: "irop", travel_date: bad, action_deadline: bad });
    assert.equal(v.travelDate, null, String(bad));
    assert.equal(v.actionDeadline, null, String(bad));
  }
  const v = parseVerdict({ verdict: "irop", travel_date: " 2026-11-02 ", action_deadline: "2026-10-28" });
  assert.equal(v.travelDate, "2026-11-02");
  assert.equal(v.actionDeadline, "2026-10-28");
});

test("parseVerdict: flights capped at 10 and shaped; junk entries dropped; long fields cut", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ number: `AI ${100 + i}`, route: "DEL-LHR", old_departure: null, new_departure: "2026-11-02T04:55", extra: "ignored" }));
  const v = parseVerdict({ verdict: "irop", flights: [null, "AI 1", 7, ...many] });
  assert.equal(v.flights.length, 10);
  assert.deepEqual(v.flights[0], { number: "AI 100", route: "DEL-LHR", old_departure: null, new_departure: "2026-11-02T04:55" });
  assert.deepEqual(v.flights[9].number, "AI 109");
  assert.deepEqual(parseVerdict({ verdict: "irop", flights: [{}] }).flights, [{ number: null, route: null, old_departure: null, new_departure: null }]);
  assert.deepEqual(parseVerdict({ verdict: "irop", flights: [{ number: "", route: "   ", old_departure: 5 }] }).flights, [{ number: null, route: null, old_departure: null, new_departure: null }]);
  assert.deepEqual(parseVerdict({ verdict: "irop", flights: "none" }).flights, []);
  const long = parseVerdict({ verdict: "irop", flights: [{ number: "X".repeat(30), route: "Y".repeat(30), old_departure: "Z".repeat(30), new_departure: "W".repeat(30) }] }).flights[0];
  assert.deepEqual([long.number.length, long.route.length, long.old_departure.length, long.new_departure.length], [12, 20, 25, 25]);
  assert.equal(parseVerdict({ verdict: "irop", airline: "A".repeat(100) }).airline.length, 60);
  assert.equal(parseVerdict({ verdict: "irop", summary: "S".repeat(500), reason: "R".repeat(500) }).summary.length, 300);
  assert.equal(parseVerdict({ verdict: "irop", reason: "R".repeat(500) }).reason.length, 200);
});

test("parseVerdict: an invalid verdict → unsure; irop without irop_type → other_irop; unknown values fall back", () => {
  const maybe = parseVerdict({ verdict: "maybe", category: "nope", irop_type: "nope", action_required: "true" });
  assert.equal(maybe.verdict, "unsure");
  assert.equal(maybe.category, "other");
  assert.equal(maybe.iropType, null);
  assert.equal(maybe.actionRequired, false, "only boolean true counts");
  assert.equal(maybe.summary, "");
  assert.equal(maybe.airline, null);
  const irop = parseVerdict({ verdict: "irop" });
  assert.equal(irop.iropType, "other_irop");
  assert.equal(irop.category, "irop");
  assert.equal(parseVerdict({ verdict: "irop", irop_type: "bogus" }).iropType, "other_irop");
  assert.equal(parseVerdict({ verdict: "irop", category: "booking_confirmation" }).category, "booking_confirmation", "a listed category is kept as given");
  assert.equal(parseVerdict({ verdict: "other" }).iropType, null);
  assert.equal(parseVerdict({ verdict: "unsure", category: "customer" }).category, "customer");
  for (const t of IROP_TYPES) assert.equal(parseVerdict({ verdict: "irop", irop_type: t }).iropType, t);
  for (const c of CATEGORIES) assert.equal(parseVerdict({ verdict: "other", category: c }).category, c);
  for (const v of VERDICTS) assert.equal(parseVerdict({ verdict: v }).verdict, v);
});

test("parseVerdict: malformed text → unsureVerdict with a reason; non-objects → unsure", () => {
  assert.deepEqual(parseVerdict("{not json"), unsureVerdict("malformed model output"));
  assert.equal(parseVerdict("").reason, "malformed model output");
  assert.deepEqual(parseVerdict(42), unsureVerdict("empty model output"));
  assert.deepEqual(parseVerdict(null), unsureVerdict("empty model output"));
  assert.deepEqual(parseVerdict(undefined), unsureVerdict("empty model output"));
  assert.deepEqual(parseVerdict("null"), unsureVerdict("empty model output"));
  assert.deepEqual(unsureVerdict("why"), { verdict: "unsure", category: "other", iropType: null, pnrs: [], airline: null, flights: [], travelDate: null, actionDeadline: null, actionRequired: false, summary: "", reason: "why" });
  assert.equal(unsureVerdict("x".repeat(300)).reason.length, 200);
});

// ── classifierUserMessage ──

test("classifierUserMessage: Today / From / Date / Subject / Attachments, then the body between triple quotes", () => {
  const msg = classifierUserMessage({
    today: "2026-10-22",
    from: "Airline Ops <ops@airline.example>",
    subject: "Schedule change",
    date: "2026-10-21T10:00:00.000Z",
    attachments: [{ filename: "notice.pdf", mimeType: "application/pdf" }, { filename: "", mimeType: "image/png" }, {}],
    text: "  Body text  \n",
  });
  assert.equal(msg, 'Today: 2026-10-22\nFrom: Airline Ops <ops@airline.example>\nDate: 2026-10-21T10:00:00.000Z\nSubject: Schedule change\nAttachments: notice.pdf, image/png, file\nEmail:\n"""\nBody text\n"""');
  assert.equal(classifierUserMessage({ text: "" }), 'Subject: (none)\nEmail:\n"""\n(empty)\n"""');
  assert.equal(classifierUserMessage({ today: "2026-10-22", subject: "x", attachments: [], text: "y" }), 'Today: 2026-10-22\nSubject: x\nEmail:\n"""\ny\n"""');
});

// ── classify() against a fake fetch ──

const input = { today: "2026-10-22", from: "ops@airline.example", subject: "Cancellation PNR K7X2QM", date: null, attachments: [], text: "6E 203 BOM-DEL on 30 Oct is cancelled." };
const openai = { provider: "openai", openaiKey: "sk-test", openaiModel: "gpt-5.6-luna", openaiBaseUrl: "http://llm.test/v1/" };
const gemini = { provider: "gemini", geminiKey: "g-key", geminiModel: "gemini-flash-latest", geminiBaseUrl: "http://gem.test/v1beta" };
const VERDICT = { verdict: "irop", category: "irop", irop_type: "cancellation", pnrs: ["K7X2QM"], airline: "IndiGo", flights: [{ number: "6E 203", route: "BOM-DEL", old_departure: "2026-10-30T06:00", new_departure: null }], travel_date: "2026-10-30", action_deadline: null, action_required: true, summary: "6E 203 BOM-DEL 30 Oct cancelled, rebook or refund", reason: "airline cancellation" };

test("classify: OpenAI Responses call — strict json_schema, low reasoning, store false; output_text parsed; usage", async () => {
  const { calls, restore } = stubFetch(() => ({ body: { output_text: JSON.stringify(VERDICT), usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 700 }, output_tokens: 120 } } }));
  try {
    const v = await classify(input, openai, { timeoutMs: 1000 });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, "http://llm.test/v1/responses");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.Authorization, "Bearer sk-test");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.ok(call.signal instanceof AbortSignal, "the call is time-boxed");
    const body = json(call);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.instructions, INSTRUCTIONS);
    assert.deepEqual(body.input, [{ role: "user", content: classifierUserMessage(input) }]);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 700);
    assert.deepEqual(body.text, { format: { type: "json_schema", name: "irop_triage", strict: true, schema: OUTPUT_SCHEMA } });
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.equal(v.verdict, "irop");
    assert.equal(v.iropType, "cancellation");
    assert.deepEqual(v.pnrs, ["K7X2QM"]);
    assert.equal(v.travelDate, "2026-10-30");
    assert.equal(v.summary, VERDICT.summary);
    assert.deepEqual(v.usage, { input: 900, cached: 700, output: 120 });
  } finally {
    restore();
  }
});

test("classify: OpenAI without output_text → message content; default base URL; missing usage → null", async () => {
  const { calls, restore } = stubFetch(() => ({ body: { output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(VERDICT) }] }] } }));
  try {
    const v = await classify(input, { provider: "openai", openaiKey: "k", openaiModel: "m" });
    assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
    assert.equal(v.verdict, "irop");
    assert.equal(v.usage, null);
  } finally {
    restore();
  }
});

test("classify: Gemini generateContent call — key in the query, responseSchema; candidates text parsed; usage", async () => {
  const { calls, restore } = stubFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: JSON.stringify(VERDICT) }] } }], usageMetadata: { promptTokenCount: 800, cachedContentTokenCount: 100, candidatesTokenCount: 90 } } }));
  try {
    const v = await classify(input, gemini, { timeoutMs: 1000 });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, "http://gem.test/v1beta/models/gemini-flash-latest:generateContent?key=g-key");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.headers["Content-Type"], "application/json");
    const body = json(call);
    assert.deepEqual(body.system_instruction, { parts: [{ text: INSTRUCTIONS }] });
    assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: classifierUserMessage(input) }] }]);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.temperature, 0);
    assert.equal(body.generationConfig.maxOutputTokens, 700);
    const schema = body.generationConfig.responseSchema;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.properties.verdict.enum, VERDICTS);
    assert.deepEqual(schema.properties.irop_type, { type: "string", enum: IROP_TYPES, nullable: true });
    assert.ok(!("additionalProperties" in schema), "Gemini's dialect has no additionalProperties");
    assert.ok(schema.required.includes("verdict") && schema.required.includes("summary"));
    assert.equal(v.verdict, "irop");
    assert.equal(v.iropType, "cancellation");
    assert.deepEqual(v.usage, { input: 800, cached: 100, output: 90 });
  } finally {
    restore();
  }
});

test("classify: Gemini default base URL; multi-part answer joined; missing usageMetadata → null", async () => {
  const text = JSON.stringify(VERDICT);
  const { calls, restore } = stubFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: text.slice(0, 20) }, { text: text.slice(20) }] } }] } }));
  try {
    const v = await classify(input, { provider: "gemini", geminiKey: "k", geminiModel: "m" });
    assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=k");
    assert.equal(v.verdict, "irop");
    assert.equal(v.usage, null);
  } finally {
    restore();
  }
});

test("classify: anything the model returns that is not the schema becomes unsure, never an exception", async () => {
  const { restore } = stubFetch((call) => (call.url.includes("/responses") ? { body: { output_text: "I cannot help with that." } } : { body: { candidates: [] } }));
  try {
    const o = await classify(input, openai);
    assert.equal(o.verdict, "unsure");
    assert.equal(o.reason, "malformed model output");
    const g = await classify(input, gemini);
    assert.equal(g.verdict, "unsure");
    assert.equal(g.reason, "malformed model output");
  } finally {
    restore();
  }
});

test("classify: a non-2xx answer throws with the status in the message", async () => {
  const { restore } = stubFetch((call) => (call.url.includes("/responses") ? { status: 500, body: { error: { message: "mock outage" } } } : { status: 429, body: "quota" }));
  try {
    await assert.rejects(classify(input, openai), /^Error: OpenAI classify 500: .*mock outage/);
    await assert.rejects(classify(input, gemini), /^Error: Gemini classify 429: quota/);
  } finally {
    restore();
  }
});

test("classify: the time-box rejects a slow model", async () => {
  let timer = null;
  const { restore } = stubFetch(() => new Promise((resolve) => { timer = setTimeout(() => resolve({ body: { output_text: JSON.stringify(VERDICT) } }), 100); }));
  try {
    const started = Date.now();
    await assert.rejects(classify(input, openai, { timeoutMs: 20 }), (e) => e.name === "TimeoutError" || /abort|timeout/i.test(e.message));
    assert.ok(Date.now() - started < 150, "rejected by the timeout, not by the slow answer");
  } finally {
    clearTimeout(timer);
    restore();
  }
});

test("classify: fetchImpl can be injected instead of the global", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ output_text: JSON.stringify(VERDICT) }), { status: 200 });
  };
  const v = await classify(input, openai, { fetchImpl });
  assert.deepEqual(seen, ["http://llm.test/v1/responses"]);
  assert.equal(v.verdict, "irop");
});
