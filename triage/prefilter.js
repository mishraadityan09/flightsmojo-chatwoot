// Free decisions before any model call. Pure.
//  - skip: auto-replies, bounces, newsletters, and the operator's own
//    sender/subject patterns → "other" without a model call
//  - force: mail forwarded by one of our own people → ingested whatever the
//    classifier thinks (the human already decided it matters)
//  - classify: everything else

const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[\s-]?reply|autoreply|out of (the )?office|undeliverable|delivery status notification|mail delivery failed|delivery failure|read:|returned mail)/i;

export function prefilter(parsed, { skipSenders = null, skipSubjects = null, trustedSenders = [] } = {}) {
  const h = parsed?.headers || {};
  const from = String(parsed?.from?.address || "").toLowerCase();
  const subject = String(parsed?.subject || "");

  const auto = h["auto-submitted"]?.some((v) => !/^no\b/i.test(v.trim()));
  if (auto) return skip("auto-submitted", "auto_reply");
  if (h["x-autoreply"] || h["x-autorespond"] || h["x-auto-response-suppress"]?.some((v) => /all|oof/i.test(v)) && AUTO_SUBJECT.test(subject))
    return skip("auto-reply header", "auto_reply");
  if (h["precedence"]?.some((v) => /^(bulk|list|junk|auto_reply)/i.test(v.trim()))) return skip("precedence bulk/list", "promo");
  if (h["return-path"]?.some((v) => v.trim() === "<>") || /^(mailer-daemon|postmaster)@/i.test(from)) return skip("bounce", "auto_reply");
  if (AUTO_SUBJECT.test(subject)) return skip("auto-reply subject", "auto_reply");
  if (h["list-unsubscribe"] || h["list-id"]) return skip("mailing list / newsletter", "promo");

  if (isTrusted(from, trustedSenders)) return { action: "force", reason: `forwarded by ${from}`, category: null };

  if (skipSenders && from && skipSenders.test(from)) return skip("sender matches TRIAGE_SKIP_SENDERS", "other");
  if (skipSubjects && subject && skipSubjects.test(subject)) return skip("subject matches TRIAGE_SKIP_SUBJECTS", "other");
  return { action: "classify", reason: "", category: null };
}

function skip(reason, category) {
  return { action: "skip", reason, category };
}

/** "flightsmojo.in, ops@partner.example" → matcher list (domains and full addresses). */
export function parseTrusted(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isTrusted(address, trusted = []) {
  const a = String(address || "").toLowerCase();
  if (!a) return false;
  return trusted.some((t) => (t.includes("@") ? a === t : a.endsWith(`@${t}`)));
}

/** Env regex (one pattern string) → RegExp or null; a broken pattern is reported, not fatal. */
export function compilePattern(value, log = console) {
  if (!value) return null;
  try {
    return new RegExp(value, "i");
  } catch (e) {
    log.warn?.(`triage: ignoring invalid pattern ${JSON.stringify(value)}: ${e.message}`);
    return null;
  }
}
