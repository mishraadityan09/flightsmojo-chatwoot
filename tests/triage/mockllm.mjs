// A stand-in for the OpenAI Responses API, for end-to-end runs on the preview
// stack: deterministic verdicts keyed on the subject line, so a run costs
// nothing and always produces the same tickets. Not used by the unit tests.
//
//   node tests/triage/mockllm.mjs            (PORT, default 3999)
//   POST /v1/responses                       → canned verdict
//   POST /_fail {"fail":true|false}          → make /v1/responses answer 500 (the "model down" path)
//   GET  /_state                             → calls seen

import http from "node:http";

const PORT = Number(process.env.PORT || 3999);
const state = { fail: false, calls: [] };

function verdictFor(userMessage) {
  const subject = (/^Subject: (.*)$/m.exec(userMessage) || [])[1] || "";
  const today = (/^Today: (\d{4}-\d{2}-\d{2})/m.exec(userMessage) || [])[1] || "2026-01-01";
  const pnrs = [...new Set((userMessage.match(/\b[A-Z0-9]{6}\b/g) || []).filter((p) => /[A-Z]/.test(p) && /\d/.test(p)))].slice(0, 3);
  const plus = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
  if (/unsure|acknowledg/i.test(subject))
    return { verdict: "unsure", category: "other", irop_type: null, pnrs, airline: null, flights: [], travel_date: null, action_deadline: null, action_required: false, summary: "Mentions a schedule change but may only acknowledge one already handled", reason: "cannot tell whether a new change is reported" };
  if (/schedule change/i.test(subject))
    return { verdict: "irop", category: "irop", irop_type: "schedule_change", pnrs, airline: "Air India", flights: [{ number: "AI 131", route: "DEL-LHR", old_departure: `${plus(2)}T03:30`, new_departure: `${plus(2)}T04:55` }], travel_date: plus(2), action_deadline: plus(1), action_required: true, summary: `AI 131 DEL-LHR ${plus(2)} retimed 0330→0455, accept or reissue by ${plus(1)}`, reason: "supplier schedule change notice" };
  if (/cancell/i.test(subject))
    return { verdict: "irop", category: "irop", irop_type: "cancellation", pnrs, airline: "IndiGo", flights: [{ number: "6E 203", route: "BOM-DEL", old_departure: `${plus(9)}T06:00`, new_departure: null }], travel_date: plus(9), action_deadline: null, action_required: true, summary: `6E 203 BOM-DEL ${plus(9)} cancelled, rebook or refund`, reason: "airline cancellation" };
  return { verdict: "other", category: /invoice/i.test(subject) ? "finance" : /confirm/i.test(subject) ? "booking_confirmation" : "other", irop_type: null, pnrs, airline: null, flights: [], travel_date: null, action_deadline: null, action_required: false, summary: "", reason: "not an IROP notice" };
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/_fail") {
      state.fail = Boolean(JSON.parse(body || "{}").fail);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ fail: state.fail }));
    }
    if (req.method === "GET" && req.url === "/_state") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state));
    }
    if (req.method === "POST" && req.url === "/v1/responses") {
      const payload = JSON.parse(body || "{}");
      const userMessage = (payload.input || []).map((i) => i.content).join("\n");
      state.calls.push({ at: new Date().toISOString(), subject: (/^Subject: (.*)$/m.exec(userMessage) || [])[1] || "" });
      if (state.fail) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "mock outage" } }));
      }
      const verdict = verdictFor(userMessage);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ output_text: JSON.stringify(verdict), usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 700 }, output_tokens: 120 } }));
    }
    res.writeHead(404);
    res.end();
  });
});
server.listen(PORT, () => console.log(`mock LLM on :${PORT}`));
