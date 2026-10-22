// One structured-output call per mail. Same provider switch as the bot
// (OpenAI Responses API with a strict JSON schema, or Gemini with a
// responseSchema); anything malformed comes back as "unsure", never "other",
// because a missed IROP costs a passenger a flight and a false alarm costs an
// agent a minute.

export const IROP_TYPES = ["schedule_change", "cancellation", "delay", "reaccommodation", "equipment_or_terminal_change", "involuntary_refund", "other_irop"];
export const CATEGORIES = ["irop", "booking_confirmation", "ticketing", "finance", "promo", "auto_reply", "customer", "other"];
export const VERDICTS = ["irop", "unsure", "other"];

export const INSTRUCTIONS = `You read ONE email that arrived in the supplier mailbox of FlightsMojo, an online travel agency. Airlines, consolidators and GDS systems send this mailbox booking confirmations, ticketing notices, invoices, promotions — and IROP notices. Your job: decide whether this email is an IROP notice, and extract the facts an agent needs.

An IROP notice is any AIRLINE- or SUPPLIER-INITIATED change to a booked itinerary: a schedule change (new departure or arrival time, even by minutes), a flight cancellation, a delay, a reaccommodation onto another flight, an aircraft, terminal or airport change, or an involuntary refund offered because of such a change. It is a notice when it tells the agency about such a change on one or more bookings (PNRs), whether it also asks the agency to accept, reissue, rebook or refund by a deadline, or just informs.

NOT an IROP notice: a booking or ticket confirmation; an invoice, ADM, statement or payment note; a promotion, newsletter or fare update; a request the CUSTOMER made (the customer wants to cancel or change); a system or automatic reply; a message only acknowledging that a change was already handled; queue or report mails with no specific change on a booking; internal chatter.

The email may be a thread. The NEWEST part (before "--- earlier in this thread ---") decides; the earlier part is context only — a booking confirmation thread in which the supplier now reports a schedule change IS an IROP notice.

Answer:
- "verdict": "irop" when you are confident it is an IROP notice; "other" when you are confident it is not; "unsure" when it talks about a schedule, cancellation, reissue or refund but you cannot tell whether it is a notice that needs the agency's attention (for example: details cut off, an image-only mail, a language you cannot read, or an acknowledgement that may or may not carry a new change). When in doubt between "other" and "unsure", answer "unsure".
- "category": the kind of email, one of the listed values ("customer" = written by a traveller rather than a supplier).
- "irop_type": the main change, or null when verdict is "other".
- "pnrs": every PNR / record locator / booking reference mentioned (usually 5–6 letters and digits), empty list if none.
- "airline": the operating airline name, or null.
- "flights": each affected flight with number (like "AI 131"), route (like "DEL-LHR") and old/new departure as ISO local date-times when given, else null.
- "travel_date": the FIRST affected departure date as YYYY-MM-DD (work it out from "Today" for relative dates), or null.
- "action_deadline": the date by which the agency must accept, reissue or respond, YYYY-MM-DD, or null.
- "action_required": true when the agency must do something (accept, reissue, rebook, refund, contact the passenger), false when it is purely informational.
- "summary": one line for the agent, at most 200 characters, in English, facts only: airline, flight, route, what changed, dates, deadline.
- "reason": at most 120 characters: why you chose this verdict (for "other" and "unsure" especially).`;

const FLIGHT_PROPS = {
  number: { type: ["string", "null"] },
  route: { type: ["string", "null"] },
  old_departure: { type: ["string", "null"] },
  new_departure: { type: ["string", "null"] },
};

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    category: { type: "string", enum: CATEGORIES },
    irop_type: { type: ["string", "null"], enum: [...IROP_TYPES, null] },
    pnrs: { type: "array", items: { type: "string" } },
    airline: { type: ["string", "null"] },
    flights: { type: "array", items: { type: "object", properties: FLIGHT_PROPS, required: Object.keys(FLIGHT_PROPS), additionalProperties: false } },
    travel_date: { type: ["string", "null"] },
    action_deadline: { type: ["string", "null"] },
    action_required: { type: "boolean" },
    summary: { type: "string" },
    reason: { type: "string" },
  },
  required: ["verdict", "category", "irop_type", "pnrs", "airline", "flights", "travel_date", "action_deadline", "action_required", "summary", "reason"],
  additionalProperties: false,
};

// Gemini's schema dialect: no type arrays, `nullable` instead, no additionalProperties.
const GEMINI_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    category: { type: "string", enum: CATEGORIES },
    irop_type: { type: "string", enum: IROP_TYPES, nullable: true },
    pnrs: { type: "array", items: { type: "string" } },
    airline: { type: "string", nullable: true },
    flights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "string", nullable: true },
          route: { type: "string", nullable: true },
          old_departure: { type: "string", nullable: true },
          new_departure: { type: "string", nullable: true },
        },
      },
    },
    travel_date: { type: "string", nullable: true },
    action_deadline: { type: "string", nullable: true },
    action_required: { type: "boolean" },
    summary: { type: "string" },
    reason: { type: "string" },
  },
  required: ["verdict", "category", "pnrs", "flights", "action_required", "summary", "reason"],
};

/** The user message: headers the model may use, then the body. */
export function classifierUserMessage({ today, from, subject, date, attachments = [], text }) {
  const lines = [];
  if (today) lines.push(`Today: ${today}`);
  if (from) lines.push(`From: ${from}`);
  if (date) lines.push(`Date: ${date}`);
  lines.push(`Subject: ${subject || "(none)"}`);
  if (attachments.length) lines.push(`Attachments: ${attachments.map((a) => a.filename || a.mimeType || "file").join(", ")}`);
  lines.push("Email:", '"""', String(text || "").trim() || "(empty)", '"""');
  return lines.join("\n");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const dateOrNull = (v) => (DATE_RE.test(String(v || "").trim()) ? String(v).trim() : null);

/** Model JSON → a safe verdict. Malformed = unsure (fail open to the desk). */
export function parseVerdict(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return unsureVerdict("malformed model output");
    }
  }
  if (!obj || typeof obj !== "object") return unsureVerdict("empty model output");
  const verdict = VERDICTS.includes(obj.verdict) ? obj.verdict : "unsure";
  const category = CATEGORIES.includes(obj.category) ? obj.category : verdict === "irop" ? "irop" : "other";
  const iropType = IROP_TYPES.includes(obj.irop_type) ? obj.irop_type : verdict === "irop" ? "other_irop" : null;
  const pnrs = Array.isArray(obj.pnrs)
    ? [...new Set(obj.pnrs.map((p) => str(p, 12).toUpperCase().replace(/[^A-Z0-9]/g, "")).filter((p) => p.length >= 5 && p.length <= 8))]
    : [];
  const flights = Array.isArray(obj.flights)
    ? obj.flights
        .filter((f) => f && typeof f === "object")
        .slice(0, 10)
        .map((f) => ({
          number: str(f.number, 12) || null,
          route: str(f.route, 20) || null,
          old_departure: str(f.old_departure, 25) || null,
          new_departure: str(f.new_departure, 25) || null,
        }))
    : [];
  return {
    verdict,
    category,
    iropType,
    pnrs,
    airline: str(obj.airline, 60) || null,
    flights,
    travelDate: dateOrNull(obj.travel_date),
    actionDeadline: dateOrNull(obj.action_deadline),
    actionRequired: obj.action_required === true,
    summary: str(obj.summary, 300),
    reason: str(obj.reason, 200),
  };
}

export function unsureVerdict(reason) {
  return { verdict: "unsure", category: "other", iropType: null, pnrs: [], airline: null, flights: [], travelDate: null, actionDeadline: null, actionRequired: false, summary: "", reason: str(reason, 200) };
}

/**
 * One call. `config` = { provider: "openai"|"gemini", openaiKey, openaiModel,
 * openaiBaseUrl?, geminiKey, geminiModel, geminiBaseUrl? }. Throws on
 * transport/API errors and on timeout (the caller decides: unclassified → desk).
 */
export async function classify(input, config, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const userMessage = classifierUserMessage(input);
  const signal = AbortSignal.timeout(timeoutMs);
  return config.provider === "openai" ? classifyOpenAI(userMessage, config, fetchImpl, signal) : classifyGemini(userMessage, config, fetchImpl, signal);
}

async function classifyOpenAI(userMessage, { openaiKey, openaiModel, openaiBaseUrl = "https://api.openai.com/v1" }, fetchImpl, signal) {
  const res = await fetchImpl(`${openaiBaseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    signal,
    body: JSON.stringify({
      model: openaiModel,
      instructions: INSTRUCTIONS,
      input: [{ role: "user", content: userMessage }],
      max_output_tokens: 700,
      reasoning: { effort: "low" },
      store: false,
      text: { format: { type: "json_schema", name: "irop_triage", strict: true, schema: OUTPUT_SCHEMA } },
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
  const verdict = parseVerdict(text);
  verdict.usage = json.usage ? { input: json.usage.input_tokens, cached: json.usage.input_tokens_details?.cached_tokens ?? 0, output: json.usage.output_tokens } : null;
  return verdict;
}

async function classifyGemini(userMessage, { geminiKey, geminiModel, geminiBaseUrl = "https://generativelanguage.googleapis.com/v1beta" }, fetchImpl, signal) {
  const res = await fetchImpl(`${geminiBaseUrl.replace(/\/$/, "")}/models/${geminiModel}:generateContent?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      system_instruction: { parts: [{ text: INSTRUCTIONS }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 700, responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA },
    }),
  });
  if (!res.ok) throw new Error(`Gemini classify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const verdict = parseVerdict(text);
  const u = json.usageMetadata;
  verdict.usage = u ? { input: u.promptTokenCount, cached: u.cachedContentTokenCount ?? 0, output: u.candidatesTokenCount } : null;
  return verdict;
}
