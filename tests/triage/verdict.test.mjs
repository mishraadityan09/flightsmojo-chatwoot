import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BANDS, LABELS, PRIORITY_RANK, attributesFor, daysUntil, decide, isHigher, noteFor, parseBands, priorityFor, rebump } from "../../triage/verdict.js";

const TODAY = "2026-10-22";
const plus = (d) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const DEFAULT = [
  { days: 1, priority: "urgent" },
  { days: 3, priority: "high" },
  { days: 7, priority: "medium" },
];

test("parseBands: default, custom, invalid parts dropped, sorted ascending", () => {
  assert.equal(DEFAULT_BANDS, "1:urgent,3:high,7:medium");
  assert.deepEqual(parseBands(), DEFAULT);
  assert.deepEqual(parseBands(DEFAULT_BANDS), DEFAULT);
  assert.deepEqual(parseBands(""), DEFAULT);
  assert.deepEqual(parseBands(undefined), DEFAULT);
  assert.deepEqual(parseBands("7:medium, 2:high ,1:urgent"), [
    { days: 1, priority: "urgent" },
    { days: 2, priority: "high" },
    { days: 7, priority: "medium" },
  ]);
  assert.deepEqual(parseBands("x:high,3:critical,5,,:low,-1:urgent,2:medium,1.5:high"), [{ days: 2, priority: "medium" }]);
  assert.deepEqual(parseBands("nonsense"), []);
  assert.deepEqual(parseBands("0:urgent"), [{ days: 0, priority: "urgent" }]);
});

test("daysUntil: whole days between two YYYY-MM-DD dates, null when either is unusable", () => {
  assert.equal(daysUntil(plus(2), TODAY), 2);
  assert.equal(daysUntil(TODAY, TODAY), 0);
  assert.equal(daysUntil(plus(-3), TODAY), -3);
  assert.equal(daysUntil("2026-11-02", "2026-10-22"), 11);
  assert.equal(daysUntil("2027-01-01", "2026-12-31"), 1);
  assert.equal(daysUntil(null, TODAY), null);
  assert.equal(daysUntil(undefined, TODAY), null);
  assert.equal(daysUntil("02/11/2026", TODAY), null);
  assert.equal(daysUntil("2026-13-45", TODAY), null);
  assert.equal(daysUntil(plus(1), undefined), null);
  assert.equal(daysUntil(plus(1), "yesterday"), null);
});

test("priorityFor: the bands — ≤1 urgent, ≤3 high, ≤7 medium, else low; unknown low; past dates urgent", () => {
  const p = (travelDate, actionDeadline = null) => priorityFor({ travelDate, actionDeadline, today: TODAY });
  assert.equal(p(TODAY), "urgent");
  assert.equal(p(plus(1)), "urgent");
  assert.equal(p(plus(2)), "high");
  assert.equal(p(plus(3)), "high");
  assert.equal(p(plus(4)), "medium");
  assert.equal(p(plus(7)), "medium");
  assert.equal(p(plus(8)), "low");
  assert.equal(p(plus(30)), "low");
  assert.equal(p(null), "low");
  assert.equal(p("soon"), "low");
  assert.equal(p(plus(-1)), "urgent", "a date already in the past counts as today");
  assert.equal(p(plus(-40)), "urgent");
});

test("priorityFor: the deadline is a band of its own; the higher of the two bands wins", () => {
  const p = (travelDate, actionDeadline) => priorityFor({ travelDate, actionDeadline, today: TODAY });
  assert.equal(p(plus(10), plus(1)), "urgent", "deadline tomorrow outranks travel in 10 days");
  assert.equal(p(plus(10), plus(5)), "medium", "deadline in 5 days lifts low to medium");
  assert.equal(p(plus(5), TODAY), "urgent", "deadline today");
  assert.equal(p(plus(2), plus(10)), "high", "travel band wins when the deadline is later");
  assert.equal(p(TODAY, TODAY), "urgent");
  assert.equal(p(null, plus(1)), "urgent", "unknown travel date, deadline tomorrow");
  assert.equal(p(null, plus(-2)), "urgent", "an overdue deadline counts as today");
  assert.equal(p(plus(10), null), "low");
  assert.equal(p(plus(10), "28/10/2026"), "low", "an invalid deadline is ignored");
});

test("priorityFor: custom and empty bands", () => {
  const bands = parseBands("2:high,5:medium");
  const p = (travelDate, actionDeadline = null) => priorityFor({ travelDate, actionDeadline, today: TODAY, bands });
  assert.equal(p(TODAY), "high");
  assert.equal(p(plus(2)), "high");
  assert.equal(p(plus(3)), "medium");
  assert.equal(p(plus(5)), "medium");
  assert.equal(p(plus(6)), "low");
  assert.equal(p(plus(6), plus(2)), "high", "a deadline in the first band (2 days here) wins over travel in 6 days");
  assert.equal(p(plus(6), plus(3)), "medium", "deadline in the second band lifts low to medium");
  assert.equal(priorityFor({ travelDate: TODAY, actionDeadline: TODAY, today: TODAY, bands: [] }), "low");
});

test("attributesFor: only the keys that have a value", () => {
  assert.deepEqual(attributesFor({ iropType: "schedule_change", travelDate: "2026-11-02", pnrs: ["ABC123", "K7X2QM"], actionDeadline: "2026-10-28" }), {
    irop_type: "schedule_change",
    travel_date: "2026-11-02",
    pnr: "ABC123, K7X2QM",
    action_deadline: "2026-10-28",
  });
  assert.deepEqual(attributesFor({ iropType: null, travelDate: null, pnrs: [], actionDeadline: null, airline: "Air India", summary: "x" }), {});
  assert.deepEqual(attributesFor({ pnrs: ["ABC123"] }), { pnr: "ABC123" });
  assert.deepEqual(attributesFor({ travelDate: "2026-11-02" }), { travel_date: "2026-11-02" });
  assert.deepEqual(attributesFor(null), {});
  assert.deepEqual(attributesFor(undefined), {});
});

// ── decide ──

const IROP = { verdict: "irop", category: "irop", iropType: "schedule_change", pnrs: ["ABC123"], airline: "Air India", flights: [], travelDate: plus(2), actionDeadline: null, actionRequired: true, summary: "AI 131 DEL-LHR retimed 0330→0455", reason: "supplier notice" };
const UNSURE = { verdict: "unsure", category: "other", iropType: null, pnrs: [], airline: null, flights: [], travelDate: null, actionDeadline: null, actionRequired: false, summary: "", reason: "cannot tell whether a new change is reported" };
const OTHER = { verdict: "other", category: "finance", iropType: null, pnrs: ["ABC123"], airline: null, flights: [], travelDate: null, actionDeadline: null, actionRequired: false, summary: "", reason: "invoice" };

test("decide: irop → relay, label irop, priority from the band, attributes, note", () => {
  const d = decide({ verdict: IROP, today: TODAY });
  assert.equal(d.kind, "irop");
  assert.equal(d.relay, true);
  assert.equal(d.label, LABELS.irop);
  assert.equal(d.label, "irop");
  assert.equal(d.priority, "high");
  assert.equal(d.digest, false);
  assert.deepEqual(d.attributes, { irop_type: "schedule_change", travel_date: plus(2), pnr: "ABC123" });
  assert.equal(d.note, `🛬 IROP — schedule change\nAir India · PNR ABC123 · travel ${plus(2)} · priority high\nAI 131 DEL-LHR retimed 0330→0455`);
  assert.equal(decide({ verdict: { ...IROP, travelDate: plus(20) }, today: TODAY }).priority, "low");
  assert.equal(decide({ verdict: { ...IROP, travelDate: plus(20), actionDeadline: TODAY }, today: TODAY }).priority, "urgent", "a deadline today outranks travel in 20 days");
  assert.equal(decide({ verdict: IROP, today: TODAY, bands: parseBands("5:urgent") }).priority, "urgent", "custom bands flow through");
  assert.equal(decide({ verdict: IROP, today: TODAY, update: true }).note.split("\n")[0], "🛬 IROP update — schedule change");
});

test("decide: unsure in queue / digest / drop modes", () => {
  const queue = decide({ verdict: UNSURE, today: TODAY });
  assert.equal(queue.kind, "unsure");
  assert.equal(queue.relay, true);
  assert.equal(queue.label, LABELS.unsure);
  assert.equal(queue.label, "irop-unsure");
  assert.equal(queue.priority, "low");
  assert.equal(queue.digest, false);
  assert.deepEqual(queue.attributes, {});
  assert.equal(queue.note, "🛬 IROP? unsure — cannot tell whether a new change is reported\npriority low");
  assert.deepEqual(decide({ verdict: UNSURE, today: TODAY, unsureMode: "queue" }), queue);

  const digest = decide({ verdict: UNSURE, today: TODAY, unsureMode: "digest" });
  assert.equal(digest.kind, "unsure");
  assert.equal(digest.relay, false);
  assert.equal(digest.label, null);
  assert.equal(digest.priority, null);
  assert.equal(digest.digest, true);

  const drop = decide({ verdict: UNSURE, today: TODAY, unsureMode: "drop" });
  assert.equal(drop.kind, "unsure");
  assert.equal(drop.relay, false);
  assert.equal(drop.label, null);
  assert.equal(drop.priority, null);
  assert.equal(drop.digest, false);
});

test("decide: unclassified (model failed) behaves like unsure; the note says the model was unavailable", () => {
  const d = decide({ verdict: null, failure: "OpenAI classify 500: mock outage", today: TODAY });
  assert.equal(d.kind, "unclassified");
  assert.equal(d.relay, true);
  assert.equal(d.label, "irop-unsure");
  assert.equal(d.priority, "low");
  assert.equal(d.digest, false);
  assert.deepEqual(d.attributes, {});
  assert.equal(d.note, "🛬 IROP? unclassified — model unavailable (OpenAI classify 500: mock outage)\npriority low");
  const digest = decide({ verdict: null, failure: "timeout", today: TODAY, unsureMode: "digest" });
  assert.equal(digest.kind, "unclassified");
  assert.equal(digest.relay, false);
  assert.equal(digest.digest, true);
  const drop = decide({ verdict: null, failure: "timeout", today: TODAY, unsureMode: "drop" });
  assert.equal(drop.relay, false);
  assert.equal(drop.digest, false);
  assert.equal(decide({ verdict: undefined, today: TODAY }).kind, "unclassified");
});

test("decide: forwarded by our own person → relay + label irop whatever the classifier said", () => {
  const d = decide({ verdict: OTHER, forcedBy: "umang@flightsmojo.in", today: TODAY });
  assert.equal(d.kind, "forwarded");
  assert.equal(d.relay, true);
  assert.equal(d.label, "irop");
  assert.equal(d.priority, "low");
  assert.equal(d.digest, false);
  assert.deepEqual(d.attributes, { pnr: "ABC123" });
  assert.equal(d.note, "🛬 Forwarded by umang@flightsmojo.in\nPNR ABC123 · priority low");

  const withIrop = decide({ verdict: IROP, forcedBy: "umang@flightsmojo.in", today: TODAY });
  assert.equal(withIrop.kind, "forwarded");
  assert.equal(withIrop.priority, "high", "the dates still drive the priority");
  assert.equal(withIrop.note.split("\n")[0], "🛬 Forwarded by umang@flightsmojo.in — schedule change");
  assert.deepEqual(withIrop.attributes, { irop_type: "schedule_change", travel_date: plus(2), pnr: "ABC123" });

  const modelDown = decide({ verdict: null, failure: "timeout", forcedBy: "umang@flightsmojo.in", today: TODAY, unsureMode: "drop" });
  assert.equal(modelDown.kind, "forwarded");
  assert.equal(modelDown.relay, true, "a forward is ingested even when the model is down and unsure mode is drop");
  assert.equal(modelDown.label, "irop");
  assert.equal(modelDown.priority, "low");
  assert.equal(modelDown.note, "🛬 Forwarded by umang@flightsmojo.in\npriority low");

  assert.equal(decide({ verdict: UNSURE, forcedBy: "umang@flightsmojo.in", today: TODAY, unsureMode: "digest" }).relay, true);
});

test("decide: other → nothing relayed, nothing stamped, ledger line only", () => {
  const d = decide({ verdict: OTHER, today: TODAY });
  assert.equal(d.kind, "other");
  assert.equal(d.relay, false);
  assert.equal(d.label, null);
  assert.equal(d.priority, null);
  assert.equal(d.digest, false);
  assert.deepEqual(d.attributes, { pnr: "ABC123" });
  assert.equal(d.note, "🛬 Not an IROP notice according to the classifier — invoice\nPNR ABC123");
  for (const unsureMode of ["queue", "digest", "drop"]) assert.equal(decide({ verdict: OTHER, today: TODAY, unsureMode }).relay, false, unsureMode);
});

// ── noteFor ──

test("noteFor: irop — type label, fact line, summary, update variant, informational line", () => {
  const base = { kind: "irop", verdict: { ...IROP, actionDeadline: "2026-10-28" }, priority: "high" };
  assert.equal(noteFor(base), `🛬 IROP — schedule change\nAir India · PNR ABC123 · travel ${plus(2)} · deadline 2026-10-28 · priority high\nAI 131 DEL-LHR retimed 0330→0455`);
  assert.equal(noteFor({ ...base, update: true }).split("\n")[0], "🛬 IROP update — schedule change");
  assert.ok(!noteFor(base).includes("Informational"));
  assert.match(noteFor({ ...base, verdict: { ...base.verdict, actionRequired: false } }), /\nInformational — no action requested by the supplier\.$/);
  assert.equal(noteFor({ kind: "irop", verdict: { ...IROP, pnrs: ["ABC123", "K7X2QM"] }, priority: "high" }).split("\n")[1], `Air India · PNR ABC123, K7X2QM · travel ${plus(2)} · priority high`);
  const labels = { schedule_change: "schedule change", cancellation: "cancellation", delay: "delay", reaccommodation: "reaccommodation", equipment_or_terminal_change: "equipment / terminal change", involuntary_refund: "involuntary refund", other_irop: "IROP", bogus: "IROP" };
  for (const [type, label] of Object.entries(labels)) assert.equal(noteFor({ kind: "irop", verdict: { ...IROP, iropType: type }, priority: null }).split("\n")[0], `🛬 IROP — ${label}`, type);
  assert.equal(noteFor({ kind: "irop", verdict: { verdict: "irop", iropType: "delay", actionRequired: true }, priority: null }), "🛬 IROP — delay", "no facts, no summary → head only");
});

test("noteFor: unsure / unclassified / forwarded / other heads", () => {
  assert.equal(noteFor({ kind: "unsure", verdict: UNSURE, priority: "low" }), "🛬 IROP? unsure — cannot tell whether a new change is reported\npriority low");
  assert.equal(noteFor({ kind: "unsure", verdict: { ...UNSURE, reason: "" }, priority: null }), "🛬 IROP? unsure");
  assert.equal(noteFor({ kind: "unsure", verdict: { ...UNSURE, summary: "Mentions a schedule change" }, priority: null }), "🛬 IROP? unsure — cannot tell whether a new change is reported\nMentions a schedule change");
  assert.equal(noteFor({ kind: "unclassified", verdict: null, priority: "low", failure: "Gemini classify 503: down" }), "🛬 IROP? unclassified — model unavailable (Gemini classify 503: down)\npriority low");
  assert.equal(noteFor({ kind: "unclassified", verdict: null, priority: null }), "🛬 IROP? unclassified — model unavailable");
  assert.equal(noteFor({ kind: "unclassified", verdict: null, priority: null, failure: "x".repeat(200) }), `🛬 IROP? unclassified — model unavailable (${"x".repeat(120)})`, "the failure text is cut at 120 chars");
  assert.equal(noteFor({ kind: "forwarded", verdict: IROP, priority: "high", forcedBy: "a@b" }).split("\n")[0], "🛬 Forwarded by a@b — schedule change");
  assert.equal(noteFor({ kind: "forwarded", verdict: null, priority: null, forcedBy: "a@b" }), "🛬 Forwarded by a@b");
  assert.equal(noteFor({ kind: "other", verdict: OTHER }), "🛬 Not an IROP notice according to the classifier — invoice\nPNR ABC123");
  assert.equal(noteFor({ kind: "other", verdict: { ...OTHER, reason: "", pnrs: [] } }), "🛬 Not an IROP notice according to the classifier");
  assert.ok(!noteFor({ kind: "other", verdict: { ...OTHER, actionRequired: false } }).includes("Informational"), "the informational line is for irop only");
});

// ── rebump / isHigher ──

test("rebump raises only when the band says higher; never lowers; null without dates", () => {
  assert.equal(rebump({ travelDate: plus(1), currentPriority: "medium", today: TODAY }), "urgent");
  assert.equal(rebump({ travelDate: plus(1), currentPriority: "urgent", today: TODAY }), null);
  assert.equal(rebump({ travelDate: plus(2), currentPriority: "high", today: TODAY }), null, "equal is not higher");
  assert.equal(rebump({ travelDate: plus(30), currentPriority: "high", today: TODAY }), null, "never lowered");
  assert.equal(rebump({ travelDate: plus(5), currentPriority: null, today: TODAY }), "medium", "no priority yet → set");
  assert.equal(rebump({ travelDate: plus(30), currentPriority: null, today: TODAY }), "low");
  assert.equal(rebump({ travelDate: null, actionDeadline: null, currentPriority: null, today: TODAY }), null);
  assert.equal(rebump({ travelDate: null, actionDeadline: plus(1), currentPriority: "low", today: TODAY }), "urgent");
  assert.equal(rebump({ travelDate: plus(3), actionDeadline: plus(1), currentPriority: "high", today: TODAY }), "urgent");
  assert.equal(rebump({ travelDate: plus(1), currentPriority: "medium", today: TODAY, bands: parseBands("5:high") }), "high");
});

test("isHigher follows the rank low < medium < high < urgent; unknown ranks lowest", () => {
  assert.deepEqual(PRIORITY_RANK, { low: 0, medium: 1, high: 2, urgent: 3 });
  assert.ok(isHigher("high", "low"));
  assert.ok(isHigher("urgent", "high"));
  assert.ok(isHigher("medium", "low"));
  assert.ok(!isHigher("low", "high"));
  assert.ok(!isHigher("low", "low"));
  assert.ok(!isHigher("urgent", "urgent"));
  assert.ok(isHigher("low", null));
  assert.ok(isHigher("low", undefined));
  assert.ok(!isHigher(null, "low"));
  assert.ok(!isHigher(undefined, undefined));
  assert.ok(!isHigher("critical", "low"));
});
