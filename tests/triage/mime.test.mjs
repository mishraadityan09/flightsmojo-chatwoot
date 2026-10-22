import { test } from "node:test";
import assert from "node:assert/strict";
import { classifierText, decodeEntities, htmlToText, normalizeMessageId, parseMail, quoteCutIndex, trimQuoted } from "../../triage/mime.js";
import { buildEml } from "./helpers.mjs";

// ── parseMail ──

test("parseMail: text-only mail → ids without <>, from lowercased, header map, trimmed text", async () => {
  const parsed = await parseMail(buildEml({ text: "Dear agent,\n\nAI 131 on 02 Nov is retimed.\n", inReplyTo: "<prev@airline.example>" }));
  assert.equal(parsed.messageId, "abc-1@airline.example");
  assert.equal(parsed.inReplyTo, "prev@airline.example");
  assert.deepEqual(parsed.from, { name: "Airline Ops", address: "ops@airline.example" });
  assert.deepEqual(parsed.to, [{ name: "", address: "agency@flightsmojo.in" }]);
  assert.deepEqual(parsed.cc, []);
  assert.equal(parsed.subject, "Schedule change PNR ABC123");
  assert.equal(new Date(parsed.date).toISOString(), "2026-10-21T10:00:00.000Z");
  assert.equal(parsed.text, "Dear agent,\n\nAI 131 on 02 Nov is retimed.");
  assert.equal(parsed.html, "");
  assert.deepEqual(parsed.attachments, []);
  assert.deepEqual(parsed.headers["message-id"], ["<abc-1@airline.example>"]);
  assert.deepEqual(parsed.headers["from"], ["Airline Ops <OPS@Airline.Example>"]);
});

test("parseMail: headers are lowercased keys with one array per header, repeats kept in order", async () => {
  const parsed = await parseMail(
    buildEml({ text: "x", headers: { "X-Original-To": "agency@flightsmojo.in", "Auto-Submitted": "auto-replied", Received: ["from a", "from b"] } }),
  );
  assert.deepEqual(parsed.headers["x-original-to"], ["agency@flightsmojo.in"]);
  assert.deepEqual(parsed.headers["auto-submitted"], ["auto-replied"]);
  assert.deepEqual(parsed.headers["received"], ["from a", "from b"]);
  assert.ok(!("X-Original-To" in parsed.headers) && !("Auto-Submitted" in parsed.headers));
  for (const values of Object.values(parsed.headers)) assert.ok(Array.isArray(values) && values.every((v) => typeof v === "string"));
});

test("parseMail: multipart text+html uses the text part and keeps the html", async () => {
  const parsed = await parseMail(buildEml({ text: "Plain version", html: "<p>HTML <b>version</b></p>" }));
  assert.equal(parsed.text, "Plain version");
  assert.match(parsed.html, /<b>version<\/b>/);
});

test("parseMail: html-only mail is converted to text", async () => {
  const html = "<html><head><title>Notice</title><style>p{color:red}</style></head><body><p>Flight <b>AI 131</b> retimed.</p><table><tr><td>Old</td><td>03:30</td></tr><tr><td>New</td><td>04:55</td></tr></table></body></html>";
  const parsed = await parseMail(buildEml({ html }));
  const lines = parsed.text.split("\n");
  assert.equal(lines[0], "Flight AI 131 retimed.");
  assert.match(lines[1], /^Old\s+03:30$/);
  assert.match(lines[2], /^New\s+04:55$/);
  assert.equal(lines.length, 3);
  assert.ok(!parsed.text.includes("Notice") && !parsed.text.includes("color"));
});

test("parseMail: a whitespace-only text part falls back to the html", async () => {
  const parsed = await parseMail(buildEml({ text: "  \n", html: "<p>Only in HTML</p>" }));
  assert.equal(parsed.text, "Only in HTML");
});

test("parseMail: attachments are listed with filename, mimeType and size; bytes are not kept", async () => {
  const parsed = await parseMail(
    buildEml({ text: "See attached.", attachments: [{ filename: "notice.pdf", mimeType: "application/pdf", content: "%PDF-1.4 fake" }, { filename: "logo.png", mimeType: "image/png", content: Buffer.alloc(32, 1) }] }),
  );
  assert.deepEqual(parsed.attachments, [
    { filename: "notice.pdf", mimeType: "application/pdf", size: 13 },
    { filename: "logo.png", mimeType: "image/png", size: 32 },
  ]);
  assert.equal(parsed.text, "See attached.");
});

test("parseMail: missing Message-ID and From give empty strings, never throw", async () => {
  const parsed = await parseMail(buildEml({ text: "x", messageId: null, from: "" }));
  assert.equal(parsed.messageId, "");
  assert.equal(parsed.inReplyTo, null);
  assert.equal(parsed.from.address, "");
});

test("normalizeMessageId strips the angle brackets and whitespace", () => {
  assert.equal(normalizeMessageId("<abc-1@airline.example>"), "abc-1@airline.example");
  assert.equal(normalizeMessageId("  <<abc@x>>\n"), "abc@x");
  assert.equal(normalizeMessageId("plain@x"), "plain@x");
  assert.equal(normalizeMessageId(undefined), "");
});

// ── htmlToText ──

test("htmlToText: tags removed, entities decoded, breaks and blocks become lines", () => {
  assert.equal(htmlToText("<p>Tom&#39;s &amp; Jerry&#x27;s&nbsp;show</p>"), "Tom's & Jerry's show");
  assert.equal(htmlToText("<div>Line one<br>Line two</div><p>Para</p>"), "Line one\nLine two\nPara");
  assert.equal(htmlToText("<div>Line one<br>Line two<br/></div><p>Para</p>"), "Line one\nLine two\n\nPara", "a trailing <br/> before a block end keeps one blank line");
  assert.equal(htmlToText('<a href="https://x.example/?a=1&amp;b=2">link</a>'), "link");
  assert.equal(htmlToText("&lt;b&gt;not a tag&lt;/b&gt;"), "<b>not a tag</b>", "entity-encoded tags stay text");
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText(null), "");
});

test("htmlToText: script, style, head/title and comments are dropped", () => {
  assert.equal(htmlToText("<head><title>Ignore</title></head><style>p{color:red}</style><script>alert('x')</script><!-- hidden --><p>Body</p>"), "Body");
  assert.equal(htmlToText("<SCRIPT type='text/javascript'>\nvar a = 1;\n</SCRIPT><P>Upper</P>"), "Upper");
});

test("htmlToText: table rows stay one per line, cells separated", () => {
  const text = htmlToText("<table><tr><th>Flight</th><th>Route</th></tr><tr><td>AI 131</td><td>DEL-LHR</td></tr><tr><td>6E 203</td><td>BOM-DEL</td></tr></table>");
  const lines = text.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Flight\s+Route$/);
  assert.match(lines[1], /^AI 131\s+DEL-LHR$/);
  assert.match(lines[2], /^6E 203\s+BOM-DEL$/);
});

test("decodeEntities: named, decimal and hex; unknown names kept; NUL dropped", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&#39;&#x27;&apos;&nbsp;"), "&<>\"''' ".replace(/ $/, decodeEntities("&nbsp;")));
  assert.equal(decodeEntities("&#x27;"), "'");
  assert.equal(decodeEntities("&#39;"), "'");
  assert.equal(decodeEntities("&unknown; stays"), "&unknown; stays");
  assert.equal(decodeEntities("a&#0;b"), "ab");
  assert.equal(htmlToText("a&nbsp;b"), "a b", "a non-breaking space ends up as a plain space");
});

// ── quoteCutIndex / trimQuoted ──

const FRESH = "Hi,\nAI 131 on 02 Nov is retimed to 04:55.";

test("trimQuoted: 'On … wrote:' starts the quoted history", () => {
  const text = `${FRESH}\n\nOn Mon, 20 Oct 2026 at 09:00, Airline Ops <ops@airline.example> wrote:\n> Booking confirmed.\n> AI 131 DEL-LHR 02 Nov 03:30.`;
  assert.equal(quoteCutIndex(text), text.indexOf("On Mon"));
  assert.equal(trimQuoted(text), FRESH);
});

test("trimQuoted: '-----Original Message-----', forwarded-message markers and underscores cut", () => {
  assert.equal(trimQuoted(`${FRESH}\n\n-----Original Message-----\nFrom: ops@airline.example\nSent: Monday\n\nold body`), FRESH);
  assert.equal(trimQuoted(`${FRESH}\n\n---------- Forwarded message ---------\nFrom: x\n\nold`), FRESH);
  assert.equal(trimQuoted(`${FRESH}\n\nBegin forwarded message:\n\nold`), FRESH);
  assert.equal(trimQuoted(`${FRESH}\n\n________________________________\nFrom: x\n\nold`), FRESH);
});

test("trimQuoted: an Outlook From:/Sent:/To: block is cut only when the next lines confirm it", () => {
  const outlook = `${FRESH}\n\nFrom: Airline Ops <ops@airline.example>\nSent: Monday, 20 October 2026 09:00\nTo: agency@flightsmojo.in\nSubject: RE: PNR ABC123\n\nold body`;
  assert.equal(trimQuoted(outlook), FRESH);
  const bold = `${FRESH}\n\n*From:* Airline Ops\n*Sent:* Monday\n*To:* agency\n\nold body`;
  assert.equal(trimQuoted(bold), FRESH);
  const dateVariant = `${FRESH}\n\nFrom: Airline Ops\nDate: Monday, 20 October 2026\nSubject: x\n\nold`;
  assert.equal(trimQuoted(dateVariant), FRESH);
  const unconfirmed = `${FRESH}\nFrom: the airline's side nothing else changed.\nWe will advise the passenger today.`;
  assert.equal(quoteCutIndex(unconfirmed), unconfirmed.length);
  assert.equal(trimQuoted(unconfirmed), unconfirmed);
});

test("trimQuoted: a trailing '>' block is cut; an inline quoted line with fresh text below is kept", () => {
  const trailing = `${FRESH}\n\n> On Monday the airline wrote\n> old text`;
  assert.equal(quoteCutIndex(trailing), trailing.indexOf("> On Monday"));
  assert.equal(trimQuoted(trailing), FRESH);
  const oneLine = `${FRESH}\n\n> cancelled flight notice`;
  assert.equal(trimQuoted(oneLine), FRESH);
  const inline = "Thanks.\n> is the new time 04:55?\nYes, 04:55 local.\nRegards";
  assert.equal(quoteCutIndex(inline), inline.length);
  assert.equal(trimQuoted(inline), inline);
});

test("trimQuoted: nothing is cut without a quote, and the first line is never cut", () => {
  assert.equal(quoteCutIndex(FRESH), FRESH.length);
  assert.equal(trimQuoted(FRESH), FRESH);
  const first = "On Mon, 20 Oct 2026 at 09:00, Ops <ops@x> wrote:\nThe flight is cancelled.";
  assert.equal(quoteCutIndex(first), first.length);
  assert.equal(trimQuoted(first), first);
  const firstQuote = "> only line";
  assert.equal(trimQuoted(firstQuote), firstQuote);
  assert.equal(quoteCutIndex(""), 0);
  assert.equal(trimQuoted(null), "");
});

// ── classifierText ──

const QUOTE = "On Mon, 20 Oct 2026 at 09:00, Airline Ops <ops@airline.example> wrote:\n> Booking confirmed for PNR ABC123.\n> Flight AI 131 DEL-LHR 02 Nov 03:30.";
const LONG = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}: AI 131 DEL-LHR on 02 Nov is retimed from 03:30 to 04:55, please accept.`).join("\n");

test("classifierText: a long fresh part goes alone", () => {
  assert.ok(LONG.length >= 400);
  assert.equal(classifierText({ subject: "Re: PNR ABC123", text: `${LONG}\n\n${QUOTE}` }), LONG);
});

test("classifierText: a short fresh part gets the earlier thread after the marker", () => {
  assert.equal(classifierText({ subject: "Re: PNR ABC123", text: `Please see below.\n\n${QUOTE}` }), `Please see below.\n\n--- earlier in this thread ---\n${QUOTE}`);
  // shortBelow is the knob
  assert.equal(classifierText({ subject: "Re: x", text: `${LONG}\n\n${QUOTE}` }, { shortBelow: 10000 }), `${LONG}\n\n--- earlier in this thread ---\n${QUOTE}`);
});

test("classifierText: a forward always includes the rest", () => {
  for (const subject of ["Fwd: PNR ABC123", "FW: PNR ABC123", "  fw: x", "TR: x", "WG: x"]) {
    assert.equal(classifierText({ subject, text: `${LONG}\n\n${QUOTE}` }), `${LONG}\n\n--- earlier in this thread ---\n${QUOTE}`, subject);
  }
  assert.equal(classifierText({ subject: "Forward planning", text: `${LONG}\n\n${QUOTE}` }), LONG, "only a Fwd: prefix counts");
});

test("classifierText: the cap is respected on both shapes", () => {
  const alone = classifierText({ subject: "x", text: `${LONG}\n\n${QUOTE}` }, { cap: 100 });
  assert.equal(alone.length, 100);
  assert.equal(alone, LONG.slice(0, 100));
  const combined = classifierText({ subject: "Fwd: x", text: `Short.\n\n${QUOTE}` }, { cap: 40 });
  assert.equal(combined.length, 40);
  assert.equal(combined, `Short.\n\n--- earlier in this thread ---\n${QUOTE}`.slice(0, 40));
});

test("classifierText: no quote → the whole (normalised) text; nothing → empty", () => {
  assert.equal(classifierText({ subject: "x", text: "Just this.\r\n\r\n\r\n\r\nAnd that.  " }), "Just this.\n\nAnd that.");
  assert.equal(classifierText({ subject: "Fwd: x", text: "Just this." }), "Just this.");
  assert.equal(classifierText({}), "");
  assert.equal(classifierText(null), "");
});
