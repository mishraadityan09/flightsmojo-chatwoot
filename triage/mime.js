// MIME parsing and the text the classifier gets to see. The service sees the
// mail BEFORE Chatwoot does, so it parses the raw RFC 822 bytes itself
// (postal-mime, zero dependencies) and does its own reply trimming — the same
// idea as Chatwoot's EmailReplyTrimmer: the newest part of a thread decides.

import PostalMime from "postal-mime";

/** Raw bytes → a plain object with everything the pre-filter and classifier use. */
export async function parseMail(bytes) {
  const mail = await PostalMime.parse(bytes);
  const headers = {};
  for (const h of mail.headers || []) {
    const key = String(h.key || "").toLowerCase();
    if (!key) continue;
    (headers[key] ||= []).push(String(h.value ?? ""));
  }
  const text = mail.text && mail.text.trim() ? normalizeWhitespace(mail.text) : htmlToText(mail.html || "");
  const addr = (a) => ({ name: String(a?.name || "").trim(), address: String(a?.address || "").trim().toLowerCase() });
  return {
    messageId: normalizeMessageId(mail.messageId || headers["message-id"]?.[0] || ""),
    inReplyTo: mail.inReplyTo ? normalizeMessageId(mail.inReplyTo) : null,
    from: addr(mail.from),
    to: (mail.to || []).map(addr).filter((a) => a.address),
    cc: (mail.cc || []).map(addr).filter((a) => a.address),
    subject: String(mail.subject || "").trim(),
    date: mail.date || null,
    headers,
    text,
    html: mail.html || "",
    attachments: (mail.attachments || []).map((a) => ({
      filename: String(a.filename || ""),
      mimeType: String(a.mimeType || ""),
      size: a.content?.byteLength ?? 0,
    })),
  };
}

export function normalizeMessageId(id) {
  return String(id || "")
    .trim()
    .replace(/^<+|>+$/g, "")
    .trim();
}

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", ndash: "–", mdash: "—", hellip: "…", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+|#39);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
}

/** Airline HTML templates → readable text, tables kept one row per line. */
export function htmlToText(html) {
  let s = String(html || "");
  if (!s.trim()) return "";
  s = s.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|pre|section|article|header|footer)>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, " \t ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return normalizeWhitespace(s);
}

export function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ ]+$/g, "").replace(/^[ ]{2,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Where the quoted history starts. Returns the character index of the cut, or
// text.length when nothing looks like a quote.
const CUT_LINE = [
  /^On .{3,200}? wrote:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^Begin forwarded message:\s*$/i,
  /^_{5,}\s*$/,
  /^\*?From:\*?\s.+$/i, // Outlook header block, confirmed by the next lines
];

export function quoteCutIndex(text) {
  const lines = String(text || "").split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0) {
      if (CUT_LINE[0].test(line) || CUT_LINE[1].test(line) || CUT_LINE[2].test(line) || CUT_LINE[3].test(line) || CUT_LINE[4].test(line)) return offset;
      if (CUT_LINE[5].test(line) && lines.slice(i + 1, i + 5).some((l) => /^\*?(Sent|Date|To):\*?\s/i.test(l))) return offset;
      if (/^>/.test(line)) {
        const next = lines.slice(i + 1, i + 8).filter((l) => l.trim());
        if (next.length === 0 || next.filter((l) => /^>/.test(l)).length >= Math.min(2, next.length)) return offset;
      }
    }
    offset += line.length + 1;
  }
  return String(text || "").length;
}

/** The newest part of the mail, without the quoted history below it. */
export function trimQuoted(text) {
  const s = String(text || "");
  return s.slice(0, quoteCutIndex(s)).trim();
}

/**
 * What the model reads: the new part first; for a short new part or a
 * forward, the rest of the thread after a marker. Capped (default 8,000 chars
 * ≈ 2,000 tokens). Pure, unit-tested.
 */
export function classifierText(parsed, { cap = 8000, shortBelow = 400 } = {}) {
  const full = normalizeWhitespace(parsed?.text || "");
  const cut = quoteCutIndex(full);
  const fresh = full.slice(0, cut).trim();
  const rest = full.slice(cut).trim();
  const isForward = /^\s*(fwd?|fw|tr|wg)\s*:/i.test(parsed?.subject || "");
  if (!rest || (fresh.length >= shortBelow && !isForward)) return fresh.slice(0, cap);
  const combined = fresh ? `${fresh}\n\n--- earlier in this thread ---\n${rest}` : rest;
  return combined.slice(0, cap);
}
