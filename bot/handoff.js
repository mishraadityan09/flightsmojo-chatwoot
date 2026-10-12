// Everything said or written when a conversation goes to a human: the
// transfer tool the model calls, the customer-facing lines, and the private
// note for the agent. Pure functions, no I/O — unit-tested in tests/bot.

export const HANDOFF_REASONS = Object.freeze(["cancellation", "other"]);

// Called by the model instead of typing HANDOFF. The reason routes the chat
// (cancellation → the cancellations team, when configured); the summary is
// what the agent reads first.
export const TRANSFER_TOOL = Object.freeze({
  name: "transfer_to_human",
  description:
    "Hand this chat to a human support agent. Call this instead of writing a reply " +
    "whenever the customer needs a person (see the handoff rules). " +
    "reason=cancellation only when the customer wants to cancel or reschedule a booking " +
    "THEY made; airline-initiated changes and refund status are reason=other.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        enum: [...HANDOFF_REASONS],
        description:
          "cancellation = customer wants to cancel or change the date/time of their own booking. other = everything else.",
      },
      summary: {
        type: "string",
        description:
          "One line (max 200 characters) for the agent, in English: what the customer wants, " +
          "with any booking id, PNR, route or dates they gave, and whether a lookup found the booking.",
      },
      travel_date: {
        type: "string",
        description:
          "First travel date of the booking in question as YYYY-MM-DD, from the lookup or the customer. Empty if unknown.",
      },
      callback_phone: {
        type: "string",
        description: "Phone number the customer gave for a call back, with country code. Empty if none.",
      },
    },
    required: ["reason", "summary"],
  },
});

const SUMMARY_MAX = 300;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^\+?\d[\d\s().-]{5,24}$/;

/** Normalise whatever the model passed to the tool into a safe handoff. */
export function parseTransfer(args = {}) {
  const reason = HANDOFF_REASONS.includes(args?.reason) ? args.reason : "other";
  const summary = String(args?.summary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUMMARY_MAX);
  const date = String(args?.travel_date ?? "").trim();
  const phone = String(args?.callback_phone ?? "").trim();
  return {
    reason,
    summary,
    travelDate: DATE_RE.test(date) ? date : null,
    callbackPhone: PHONE_RE.test(phone) ? phone : null,
  };
}

const GENERIC_HANDOFF =
  "Let me connect you with one of our travel experts — a human teammate will be with you shortly. 🙋";

/** Channels where the customer reads our replies as email, not in a chat. */
function repliesByEmail(channel) {
  return channel === "Channel::Email" || channel === "Channel::Api";
}

export function channelLabel(channel) {
  switch (channel) {
    case "Channel::Email":
      return "email";
    case "Channel::Api":
      return "website ticket";
    case "Channel::Whatsapp":
      return "WhatsApp";
    case "Channel::WebWidget":
      return "website chat";
    default:
      return "chat";
  }
}

/**
 * What the customer is told. Fixed text, never the model, so the phone
 * number is always exact and never appears anywhere else.
 *  - a cancellation that was routed: "passed to the cancellations team" + the
 *    market's number (CANCELLATION_PHONES), worded for the channel
 *  - `callback` (routed outside desk hours, travel not imminent): the team
 *    will call back first thing in the morning — no number
 *  - anything else: the generic handoff line
 */
export function customerMessage({ reason, routed, phone, channel, callback }) {
  if (reason !== "cancellation" || !routed) return GENERIC_HANDOFF;
  if (callback) {
    return repliesByEmail(channel)
      ? "We've received your request and passed it to our cancellations team. They'll be in touch first thing in the morning."
      : "Thanks — I've passed your request to our cancellations team. We've got your details, and a teammate will call you back first thing in the morning.";
  }
  const base = repliesByEmail(channel)
    ? "We've received your request and passed it to our cancellations team, who will reply to you by email shortly."
    : "Thanks — I've passed your request to our cancellations team; a teammate will pick it up right here shortly.";
  return phone ? `${base} If you'd like to speak to them directly, call us on ${phone}.` : base;
}

const REASON_LABEL = Object.freeze({
  cancellation: "cancellation request",
  other: "needs a human",
});

const DESK_LINE = Object.freeze({
  callback:
    "Routed to the cancellations team. Outside desk hours — the customer was told the team will call back first thing in the morning.",
  urgent: "Routed to the cancellations team. Outside desk hours, but travel is within a day — the number was sent.",
});

const LOOKUP_LABEL = Object.freeze({
  found: "booking found and verified",
  "not found": "found nothing with the details given — re-check them with the customer",
});

/**
 * Private note for the agent (customers never see it). `source` is "bot"
 * (the chat bot handed off) or "checker" (the intent checker on an email,
 * ticket, WhatsApp or human-owned chat). `routingOff` = a cancellation in a
 * market where routing is switched off, so "not routed" is by design.
 * `desk` = what the night rule decided: "callback" (told: call back in the
 * morning) or "urgent" (outside hours but travel within a day: number sent).
 */
export function agentNote({
  source,
  reason,
  summary,
  channel,
  email,
  bookingId,
  pnr,
  lookup,
  travelDate,
  callbackPhone,
  routed,
  routingOff,
  desk,
}) {
  const head = source === "checker" ? "🤖 Intent check" : "🤖 Bot handoff";
  const lines = [`${head} — ${REASON_LABEL[reason] || REASON_LABEL.other} (${channelLabel(channel)})`];

  const facts = [];
  if (email) facts.push(`Email: ${email}`);
  if (bookingId) facts.push(`Booking ID: ${bookingId}`);
  if (pnr) facts.push(`PNR: ${pnr}`);
  if (lookup) facts.push(`Lookup: ${LOOKUP_LABEL[lookup] || lookup}`);
  if (travelDate) facts.push(`Travel date: ${travelDate}`);
  if (callbackPhone) facts.push(`Call back on: ${callbackPhone}`);
  if (facts.length) lines.push(facts.join(" · "));

  if (summary) lines.push(`Summary: ${summary}`);
  lines.push(
    routed
      ? DESK_LINE[desk] || "Routed to the cancellations team."
      : routingOff
        ? "Not routed to a team — cancellation routing is switched off for this market."
        : "Not routed to a team — please triage.",
  );
  return lines.join("\n");
}
