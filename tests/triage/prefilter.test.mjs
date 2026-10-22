import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePattern, isTrusted, parseTrusted, prefilter } from "../../triage/prefilter.js";
import { parseMail } from "../../triage/mime.js";
import { buildEml, quiet } from "./helpers.mjs";

// A parsed-mail stand-in with just the fields the pre-filter reads.
const mail = ({ from = "ops@airline.example", subject = "Schedule change PNR ABC123", headers = {} } = {}) => ({ from: { name: "", address: from }, subject, headers });
const skip = (reason, category) => ({ action: "skip", reason, category });

test("a plain supplier mail goes to the classifier", () => {
  assert.deepEqual(prefilter(mail()), { action: "classify", reason: "", category: null });
  assert.deepEqual(prefilter(mail(), { skipSenders: null, skipSubjects: null, trustedSenders: [] }), { action: "classify", reason: "", category: null });
  assert.equal(prefilter({ headers: {} }).action, "classify", "no from, no subject → still classify");
});

test("Auto-Submitted skips unless its value is 'no'", () => {
  for (const value of ["auto-replied", "auto-generated", "Auto-Replied", "auto-notified"]) {
    assert.deepEqual(prefilter(mail({ headers: { "auto-submitted": [value] } })), skip("auto-submitted", "auto_reply"), value);
  }
  assert.equal(prefilter(mail({ headers: { "auto-submitted": ["no"] } })).action, "classify");
  assert.equal(prefilter(mail({ headers: { "auto-submitted": ["No"] } })).action, "classify");
  assert.equal(prefilter(mail({ headers: { "auto-submitted": [" no (manual)"] } })).action, "classify");
});

test("X-Autoreply / X-Autorespond headers skip; X-Auto-Response-Suppress only together with an auto subject", () => {
  assert.deepEqual(prefilter(mail({ headers: { "x-autoreply": ["yes"] } })), skip("auto-reply header", "auto_reply"));
  assert.deepEqual(prefilter(mail({ headers: { "x-autorespond": ["1"] } })), skip("auto-reply header", "auto_reply"));
  assert.equal(prefilter(mail({ headers: { "x-auto-response-suppress": ["All"] } })).action, "classify", "Exchange sets this on ordinary mail too");
  assert.deepEqual(prefilter(mail({ subject: "Out of Office", headers: { "x-auto-response-suppress": ["OOF"] } })), skip("auto-reply header", "auto_reply"));
});

test("Precedence bulk / list / junk / auto_reply → promo", () => {
  for (const value of ["bulk", "list", "junk", "auto_reply", "Bulk"]) {
    assert.deepEqual(prefilter(mail({ headers: { precedence: [value] } })), skip("precedence bulk/list", "promo"), value);
  }
  assert.equal(prefilter(mail({ headers: { precedence: ["normal"] } })).action, "classify");
});

test("bounces: Return-Path <> or a mailer-daemon / postmaster sender", () => {
  assert.deepEqual(prefilter(mail({ headers: { "return-path": ["<>"] } })), skip("bounce", "auto_reply"));
  assert.deepEqual(prefilter(mail({ from: "mailer-daemon@airline.example" })), skip("bounce", "auto_reply"));
  assert.deepEqual(prefilter(mail({ from: "MAILER-DAEMON@mx.example" })), skip("bounce", "auto_reply"));
  assert.deepEqual(prefilter(mail({ from: "postmaster@airline.example" })), skip("bounce", "auto_reply"));
  assert.equal(prefilter(mail({ headers: { "return-path": ["<ops@airline.example>"] } })).action, "classify");
});

test("auto-reply subjects: 'Automatic reply', out of office, undeliverable, read receipts", () => {
  for (const subject of ["Automatic reply: Schedule change PNR ABC123", "Auto-Reply: hi", "AutoReply", "Out of Office", "Out of the office until Monday", "Undeliverable: Schedule change", "Delivery Status Notification (Failure)", "Mail delivery failed: returning message", "Read: Schedule change PNR ABC123", "Returned mail: see transcript"]) {
    assert.deepEqual(prefilter(mail({ subject })), skip("auto-reply subject", "auto_reply"), subject);
  }
  assert.equal(prefilter(mail({ subject: "RE: Automatic reply to your schedule change query" })).action, "classify", "only when the subject starts with it");
});

test("List-Unsubscribe / List-Id → promo", () => {
  assert.deepEqual(prefilter(mail({ headers: { "list-unsubscribe": ["<mailto:leave@airline.example>"] } })), skip("mailing list / newsletter", "promo"));
  assert.deepEqual(prefilter(mail({ headers: { "list-id": ["deals.airline.example"] } })), skip("mailing list / newsletter", "promo"));
});

test("trusted senders: domains and exact addresses force ingestion", () => {
  const trusted = parseTrusted("flightsmojo.in, ops@partner.example");
  assert.deepEqual(trusted, ["flightsmojo.in", "ops@partner.example"]);
  assert.deepEqual(prefilter(mail({ from: "umang@flightsmojo.in" }), { trustedSenders: trusted }), { action: "force", reason: "forwarded by umang@flightsmojo.in", category: null });
  assert.equal(prefilter(mail({ from: "Ops@Partner.Example" }), { trustedSenders: trusted }).action, "force", "case-insensitive");
  assert.equal(prefilter(mail({ from: "someone@partner.example" }), { trustedSenders: trusted }).action, "classify", "an exact address does not trust the domain");
  assert.equal(prefilter(mail({ from: "x@notflightsmojo.in" }), { trustedSenders: trusted }).action, "classify", "lookalike domain");
  assert.equal(prefilter(mail({ from: "umang@flightsmojo.in" })).action, "classify", "nothing trusted by default");
  // trusted wins over the operator's own skip patterns (the human already decided)
  assert.equal(prefilter(mail({ from: "umang@flightsmojo.in" }), { trustedSenders: trusted, skipSenders: /flightsmojo/i, skipSubjects: /schedule/i }).action, "force");
});

test("an auto-reply or bounce from a trusted domain is still skipped (order matters)", () => {
  const trustedSenders = parseTrusted("flightsmojo.in");
  assert.deepEqual(prefilter(mail({ from: "umang@flightsmojo.in", subject: "Automatic reply: Schedule change" }), { trustedSenders }), skip("auto-reply subject", "auto_reply"));
  assert.deepEqual(prefilter(mail({ from: "umang@flightsmojo.in", headers: { "auto-submitted": ["auto-replied"] } }), { trustedSenders }), skip("auto-submitted", "auto_reply"));
  assert.deepEqual(prefilter(mail({ from: "umang@flightsmojo.in", headers: { "return-path": ["<>"] } }), { trustedSenders }), skip("bounce", "auto_reply"));
  assert.deepEqual(prefilter(mail({ from: "umang@flightsmojo.in", headers: { "list-unsubscribe": ["<mailto:x>"] } }), { trustedSenders }), skip("mailing list / newsletter", "promo"));
});

test("parseTrusted / isTrusted", () => {
  assert.deepEqual(parseTrusted(""), []);
  assert.deepEqual(parseTrusted(undefined), []);
  assert.deepEqual(parseTrusted(" A.com\nb@C.d ,, e.f "), ["a.com", "b@c.d", "e.f"]);
  const trusted = ["flightsmojo.in", "ops@partner.example"];
  assert.ok(isTrusted("x@flightsmojo.in", trusted));
  assert.ok(isTrusted("X@FLIGHTSMOJO.IN", trusted));
  assert.ok(isTrusted("ops@partner.example", trusted));
  assert.ok(!isTrusted("other@partner.example", trusted));
  assert.ok(!isTrusted("x@notflightsmojo.in", trusted));
  assert.ok(!isTrusted("x@sub.flightsmojo.in", trusted));
  assert.ok(!isTrusted("", trusted));
  assert.ok(!isTrusted("x@flightsmojo.in", []));
  assert.ok(!isTrusted("x@flightsmojo.in"));
});

test("TRIAGE_SKIP_SENDERS / TRIAGE_SKIP_SUBJECTS regexes → other, without a model call", () => {
  const skipSenders = compilePattern("@(newsletter|noreply)\\.", quiet);
  const skipSubjects = compilePattern("^(weekly report|fare update)", quiet);
  assert.deepEqual(prefilter(mail({ from: "deals@newsletter.example" }), { skipSenders, skipSubjects }), skip("sender matches TRIAGE_SKIP_SENDERS", "other"));
  assert.deepEqual(prefilter(mail({ from: "ops@NoReply.airline.example" }), { skipSenders, skipSubjects }), skip("sender matches TRIAGE_SKIP_SENDERS", "other"));
  assert.deepEqual(prefilter(mail({ subject: "Weekly report: queue counts" }), { skipSenders, skipSubjects }), skip("subject matches TRIAGE_SKIP_SUBJECTS", "other"));
  assert.deepEqual(prefilter(mail({ subject: "Fare update DEL-LHR" }), { skipSenders, skipSubjects }), skip("subject matches TRIAGE_SKIP_SUBJECTS", "other"));
  assert.equal(prefilter(mail(), { skipSenders, skipSubjects }).action, "classify");
  assert.equal(prefilter(mail({ subject: "Re: weekly report question" }), { skipSenders, skipSubjects }).action, "classify");
});

test("compilePattern: case-insensitive RegExp; empty → null; an invalid pattern warns and yields null", () => {
  const warnings = [];
  const log = { warn: (m) => warnings.push(m) };
  const re = compilePattern("abc", log);
  assert.ok(re instanceof RegExp);
  assert.ok(re.test("xABCx"));
  assert.equal(compilePattern("", log), null);
  assert.equal(compilePattern(undefined, log), null);
  assert.equal(warnings.length, 0);
  assert.equal(compilePattern("(unclosed", log), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignoring invalid pattern "\(unclosed"/);
  assert.equal(compilePattern("(unclosed", {}), null, "a log without warn() is fine");
});

test("works on real parseMail output", async () => {
  const auto = await parseMail(buildEml({ text: "I am out of office.", headers: { "Auto-Submitted": "auto-replied" } }));
  assert.deepEqual(prefilter(auto), skip("auto-submitted", "auto_reply"));
  const plain = await parseMail(buildEml({ text: "AI 131 retimed." }));
  assert.equal(prefilter(plain).action, "classify");
  const forwarded = await parseMail(buildEml({ from: "Umang <Umang@FlightsMojo.in>", subject: "Fwd: Schedule change", text: "FYI" }));
  assert.deepEqual(prefilter(forwarded, { trustedSenders: parseTrusted("flightsmojo.in") }), { action: "force", reason: "forwarded by umang@flightsmojo.in", category: null });
});
