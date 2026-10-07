import { test } from "node:test";
import assert from "node:assert/strict";
import { TRANSFER_TOOL, parseTransfer, customerMessage, agentNote, channelLabel } from "../../bot/handoff.js";

test("transfer tool schema: reason is a closed enum, both fields required", () => {
  assert.equal(TRANSFER_TOOL.name, "transfer_to_human");
  assert.deepEqual(TRANSFER_TOOL.parameters.properties.reason.enum, ["cancellation", "other"]);
  assert.deepEqual(TRANSFER_TOOL.parameters.required, ["reason", "summary"]);
});

test("parseTransfer normalises the model's arguments", () => {
  assert.deepEqual(parseTransfer({ reason: "cancellation", summary: "  cancel  booking 1 \n now " }), {
    reason: "cancellation",
    summary: "cancel booking 1 now",
  });
  assert.deepEqual(parseTransfer({ reason: "refund", summary: "x" }), { reason: "other", summary: "x" });
  assert.deepEqual(parseTransfer({}), { reason: "other", summary: "" });
  assert.deepEqual(parseTransfer(undefined), { reason: "other", summary: "" });
  assert.equal(parseTransfer({ reason: "other", summary: "a".repeat(500) }).summary.length, 300);
});

const GENERIC = "Let me connect you with one of our travel experts — a human teammate will be with you shortly. 🙋";

test("customerMessage: anything that is not a routed cancellation gets the generic line", () => {
  assert.equal(customerMessage({ reason: "other", routed: false, phone: "+1", channel: "Channel::WebWidget" }), GENERIC);
  assert.equal(customerMessage({ reason: "other", routed: true, phone: "+1", channel: "Channel::WebWidget" }), GENERIC);
  // cancellation but the team could not be set → never claim it was
  assert.equal(customerMessage({ reason: "cancellation", routed: false, phone: "+1", channel: "Channel::Email" }), GENERIC);
});

test("customerMessage: routed cancellation on a chat channel, with and without a number", () => {
  assert.equal(
    customerMessage({ reason: "cancellation", routed: true, phone: "+91-9205544546", channel: "Channel::WebWidget" }),
    "Thanks — I've passed your request to our cancellations team; a teammate will pick it up right here shortly. If you'd like to speak to them directly, call us on +91-9205544546.",
  );
  assert.equal(
    customerMessage({ reason: "cancellation", routed: true, phone: null, channel: "Channel::Whatsapp" }),
    "Thanks — I've passed your request to our cancellations team; a teammate will pick it up right here shortly.",
  );
});

test("customerMessage: email and website tickets are told to expect an email", () => {
  for (const channel of ["Channel::Email", "Channel::Api"]) {
    assert.equal(
      customerMessage({ reason: "cancellation", routed: true, phone: "+44 20 4578 5985", channel }),
      "We've received your request and passed it to our cancellations team, who will reply to you by email shortly. If you'd like to speak to them directly, call us on +44 20 4578 5985.",
    );
  }
});

test("channelLabel", () => {
  assert.equal(channelLabel("Channel::Email"), "email");
  assert.equal(channelLabel("Channel::Api"), "website ticket");
  assert.equal(channelLabel("Channel::Whatsapp"), "WhatsApp");
  assert.equal(channelLabel("Channel::WebWidget"), "website chat");
  assert.equal(channelLabel(undefined), "chat");
});

test("agentNote: chat-bot cancellation with a verified booking", () => {
  const note = agentNote({
    source: "bot",
    reason: "cancellation",
    summary: "wants to cancel both legs, 12 Oct",
    channel: "Channel::WebWidget",
    email: "ravi@example.com",
    bookingId: "221324",
    lookup: "found",
    routed: true,
  });
  assert.equal(
    note,
    [
      "🤖 Bot handoff — cancellation request (website chat)",
      "Email: ravi@example.com · Booking ID: 221324 · Lookup: booking found and verified",
      "Summary: wants to cancel both legs, 12 Oct",
      "Routed to the cancellations team.",
    ].join("\n"),
  );
});

test("agentNote: plain handoff with no facts says it was not routed", () => {
  const note = agentNote({ source: "bot", reason: "other", summary: 'Customer asked for a human: "agent please"', channel: "Channel::Whatsapp" });
  assert.equal(
    note,
    [
      "🤖 Bot handoff — needs a human (WhatsApp)",
      'Summary: Customer asked for a human: "agent please"',
      "Not routed to a team — please triage.",
    ].join("\n"),
  );
});

test("agentNote: checker on an email, PNR only, lookup found nothing", () => {
  const note = agentNote({
    source: "checker",
    reason: "cancellation",
    summary: "cancel booking for 15 Oct",
    channel: "Channel::Email",
    pnr: "M22W8V",
    lookup: "not found",
    routed: true,
  });
  assert.match(note, /^🤖 Intent check — cancellation request \(email\)\n/);
  assert.match(note, /PNR: M22W8V · Lookup: found nothing with the details given — re-check them with the customer/);
  assert.match(note, /Routed to the cancellations team\.$/);
});

test("agentNote: unknown lookup outcomes are printed verbatim, empty summary is skipped", () => {
  const note = agentNote({ source: "bot", reason: "other", summary: "", channel: "Channel::WebWidget", lookup: "payment needs a human check", routed: false });
  assert.equal(note.split("\n").length, 3);
  assert.match(note, /Lookup: payment needs a human check/);
  assert.doesNotMatch(note, /Summary:/);
});

test("agentNote: a cancellation in a market that is switched off says so, instead of asking for triage", () => {
  const note = agentNote({
    source: "bot",
    reason: "cancellation",
    summary: "wants to cancel PNR M22W8V",
    channel: "Channel::WebWidget",
    routed: false,
    routingOff: true,
  });
  assert.match(note, /^🤖 Bot handoff — cancellation request \(website chat\)\n/);
  assert.match(note, /\nNot routed to a team — cancellation routing is switched off for this market\.$/);
  assert.doesNotMatch(note, /please triage/);
});
