// Verdict → what happens. Pure functions, unit-tested: the priority bands,
// the relay decision per verdict, the note text, and the daily re-bump.

export const PRIORITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2, urgent: 3 });
export const DEFAULT_BANDS = "1:urgent,3:high,7:medium";
export const LABELS = Object.freeze({ irop: "irop", unsure: "irop-unsure" });

/** "1:urgent,3:high,7:medium" → [{days, priority}] ascending; invalid parts are dropped. */
export function parseBands(value = DEFAULT_BANDS) {
  return String(value || DEFAULT_BANDS)
    .split(",")
    .map((p) => p.trim().split(":"))
    .filter(([d, pr]) => /^\d+$/.test(d || "") && pr in PRIORITY_RANK)
    .map(([d, pr]) => ({ days: Number(d), priority: pr }))
    .sort((a, b) => a.days - b.days);
}

/** Whole days from `today` (YYYY-MM-DD) to `date` (YYYY-MM-DD); null when either is missing/invalid. */
export function daysUntil(date, today) {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function isHigher(a, b) {
  return (PRIORITY_RANK[a] ?? -1) > (PRIORITY_RANK[b] ?? -1);
}

/** The band a date falls in: ≤1 day urgent, ≤3 high, ≤7 medium, else low; unknown = low; past = urgent. */
export function bandFor(date, today, bands = parseBands()) {
  const d = daysUntil(date, today);
  if (d === null) return "low";
  const band = bands.find((b) => d <= b.days);
  return band ? band.priority : "low";
}

/**
 * Priority = the higher of the travel date's band and the action deadline's
 * band. A deadline is a date the agency must act by, so it counts like a
 * departure: travel in 10 days (low) with a deadline in 2 days gives high.
 * Unknown dates are low; a date already in the past counts as today (urgent).
 */
export function priorityFor({ travelDate, actionDeadline, today, bands = parseBands() }) {
  const a = bandFor(travelDate, today, bands);
  const b = bandFor(actionDeadline, today, bands);
  return isHigher(b, a) ? b : a;
}

const TYPE_LABEL = Object.freeze({
  schedule_change: "schedule change",
  cancellation: "cancellation",
  delay: "delay",
  reaccommodation: "reaccommodation",
  equipment_or_terminal_change: "equipment / terminal change",
  involuntary_refund: "involuntary refund",
  other_irop: "IROP",
});

/** Conversation custom attributes to stamp (only the keys that have a value). */
export function attributesFor(verdict) {
  const out = {};
  if (verdict?.iropType) out.irop_type = verdict.iropType;
  if (verdict?.travelDate) out.travel_date = verdict.travelDate;
  if (verdict?.pnrs?.length) out.pnr = verdict.pnrs.join(", ");
  if (verdict?.actionDeadline) out.action_deadline = verdict.actionDeadline;
  return out;
}

export function noteFor({ kind, verdict, priority, update = false, forcedBy = null, failure = null }) {
  const v = verdict || {};
  const facts = [];
  if (v.airline) facts.push(v.airline);
  if (v.pnrs?.length) facts.push(`PNR ${v.pnrs.join(", ")}`);
  if (v.travelDate) facts.push(`travel ${v.travelDate}`);
  if (v.actionDeadline) facts.push(`deadline ${v.actionDeadline}`);
  if (priority) facts.push(`priority ${priority}`);
  const factLine = facts.length ? facts.join(" · ") : "";
  const head =
    kind === "irop"
      ? `🛬 IROP${update ? " update" : ""} — ${TYPE_LABEL[v.iropType] || "IROP"}`
      : kind === "unsure"
        ? `🛬 IROP? unsure${v.reason ? ` — ${v.reason}` : ""}`
        : kind === "unclassified"
          ? `🛬 IROP? unclassified — model unavailable${failure ? ` (${String(failure).slice(0, 120)})` : ""}`
          : kind === "forwarded"
            ? `🛬 Forwarded by ${forcedBy}${v.iropType ? ` — ${TYPE_LABEL[v.iropType]}` : ""}`
            : `🛬 Not an IROP notice according to the classifier${v.reason ? ` — ${v.reason}` : ""}`;
  const lines = [head];
  if (factLine) lines.push(factLine);
  if (v.summary) lines.push(v.summary);
  if (kind === "irop" && v.actionRequired === false) lines.push("Informational — no action requested by the supplier.");
  return lines.join("\n");
}

/**
 * The decision for one mail.
 *   verdict   – parsed classifier output, or null when the model failed
 *   failure   – the error message when the model failed
 *   forcedBy  – address of our own person who forwarded the mail (always ingested)
 *   unsureMode – "queue" (ticket, low priority), "digest" (no ticket, listed daily), "drop"
 */
export function decide({ verdict, failure = null, forcedBy = null, today, bands = parseBands(), unsureMode = "queue", update = false }) {
  const v = verdict || null;
  let kind;
  if (forcedBy) kind = "forwarded";
  else if (!v) kind = "unclassified";
  else if (v.verdict === "irop") kind = "irop";
  else if (v.verdict === "unsure") kind = "unsure";
  else kind = "other";

  const attributes = attributesFor(v);
  let relay = false;
  let label = null;
  let priority = null;
  let digest = false;

  switch (kind) {
    case "irop":
      relay = true;
      label = LABELS.irop;
      priority = priorityFor({ travelDate: v.travelDate, actionDeadline: v.actionDeadline, today, bands });
      break;
    case "forwarded":
      relay = true;
      label = LABELS.irop;
      priority = priorityFor({ travelDate: v?.travelDate, actionDeadline: v?.actionDeadline, today, bands });
      break;
    case "unsure":
    case "unclassified":
      if (unsureMode === "queue") {
        relay = true;
        label = LABELS.unsure;
        priority = "low";
      } else if (unsureMode === "digest") digest = true;
      break;
    default:
      break;
  }
  return { kind, relay, label, priority, attributes, digest, note: noteFor({ kind, verdict: v, priority, update, forcedBy, failure }) };
}

/** Daily job: the priority a still-open ticket should have today, or null when unchanged. */
export function rebump({ travelDate, actionDeadline, currentPriority, today, bands = parseBands() }) {
  if (!travelDate && !actionDeadline) return null;
  const wanted = priorityFor({ travelDate, actionDeadline, today, bands });
  return isHigher(wanted, currentPriority) ? wanted : null;
}
