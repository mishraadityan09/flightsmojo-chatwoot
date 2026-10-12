// Which market a conversation belongs to, and — for the markets where
// cancellation routing is switched on — the number the customer is told to
// call.
//
// CANCELLATION_PHONES (env, JSON) is the per-market switch:
//   {"IN":"00911246932002"}
//   - a market listed here is ON: a cancellation goes to the cancellations
//     team and the customer is given this number
//   - a market missing here is OFF: the chat bot hands a cancellation to the
//     humans like any other chat, and the intent checker leaves the
//     conversation alone
// Turning a market on later = add its code and number, then
// `docker compose up -d --no-deps bot`. Only the CODE ever sends a number to a
// customer; the model is told nothing about phones (faq.md forbids it from
// sharing any).
//
// INBOX_COUNTRIES (env, JSON) says which market each Chatwoot inbox serves:
//   {"1":"IN","2":"AE","3":"US","4":"UK","9":"*","13":"APAC"}
//   - a market code  → that market
//   - "*"            → read the market from the conversation's `country`
//                      custom attribute (the support website stamps one on
//                      every ticket it creates)
//   - a shared regional inbox ("APAC") is a market of its own — on only if
//     CANCELLATION_PHONES lists that code
// Only inboxes listed here are watched by the intent checker.
//
// CANCELLATION_DESK_HOURS (env, JSON) says when each market's cancellations
// line is answered: {"IN":"09:00-21:00 Asia/Kolkata"}. Outside those hours
// the number goes only to a customer travelling within
// CANCELLATION_URGENT_DAYS (default 1 = today or tomorrow); everyone else is
// told the team will call back first thing in the morning. No hours for a
// market = the number at any hour.

const MARKET_CODE = /^[A-Z]{2,4}$/;
// Digits with the usual separators, optionally led by "+" or "(": enough to
// stop a typo in .env from being read out to customers.
const PHONE = /^[+(]?\d[\d\s().-]{5,24}$/;

function parseJsonObject(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/** Parse INBOX_COUNTRIES. Bad JSON or non-object → empty map (feature off). */
export function parseInboxCountries(raw) {
  const map = {};
  for (const [inboxId, value] of Object.entries(parseJsonObject(raw))) {
    const code = String(value ?? "").trim().toUpperCase();
    if (/^\d+$/.test(inboxId) && (code === "*" || MARKET_CODE.test(code))) {
      map[inboxId] = code;
    }
  }
  return map;
}

/** Parse CANCELLATION_PHONES → { CODE: "number" }. A malformed entry is
 *  dropped; bad JSON → {} = every market off. */
export function parseCancellationPhones(raw) {
  const phones = {};
  for (const [market, value] of Object.entries(parseJsonObject(raw))) {
    const code = market.trim().toUpperCase();
    const phone = String(value ?? "").trim();
    if (MARKET_CODE.test(code) && PHONE.test(phone)) phones[code] = phone;
  }
  return phones;
}

export function isWatched(conversation, inboxCountries) {
  return Boolean(inboxCountries[String(conversation?.inbox_id ?? "")]);
}

/**
 * Market code for a conversation, or null when its inbox is not listed.
 * For "*" inboxes the `country` custom attribute decides; that attribute is
 * visitor-writable on widget inboxes, but it only ever picks which PUBLIC
 * number we quote, so a shape check (2–4 letters) is all the trust it needs.
 */
export function marketFor(conversation, inboxCountries) {
  const mapped = inboxCountries[String(conversation?.inbox_id ?? "")];
  if (!mapped) return null;
  if (mapped !== "*") return mapped;
  const attr = String(conversation?.custom_attributes?.country ?? "")
    .trim()
    .toUpperCase();
  return MARKET_CODE.test(attr) ? attr : null;
}

/** The number for a market, or null when cancellation routing is off there. */
export function phoneFor(market, phones) {
  if (!market || !phones || !Object.hasOwn(phones, market)) return null;
  return phones[market] || null;
}

const HOURS = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+(\S+)$/;

function validZone(tz) {
  try {
    Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parse CANCELLATION_DESK_HOURS → { CODE: { from, to, tz } } (minutes of the
 *  day). A malformed entry or unknown zone is dropped = no hours = any hour. */
export function parseDeskHours(raw) {
  const hours = {};
  for (const [market, value] of Object.entries(parseJsonObject(raw))) {
    const code = market.trim().toUpperCase();
    const m = String(value ?? "")
      .trim()
      .match(HOURS);
    if (!MARKET_CODE.test(code) || !m || !validZone(m[5])) continue;
    const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) continue;
    hours[code] = { from: h1 * 60 + m1, to: h2 * 60 + m2, tz: m[5] };
  }
  return hours;
}

/** Wall clock in a zone: { date: "YYYY-MM-DD", minutes since midnight }. */
export function localClock(tz, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Is the market's desk answering the phone right now? No hours → always. */
export function deskOpen(market, hours, now = new Date()) {
  const rule = market && hours && Object.hasOwn(hours, market) ? hours[market] : null;
  if (!rule) return true;
  const { minutes } = localClock(rule.tz, now);
  return rule.from <= rule.to
    ? minutes >= rule.from && minutes < rule.to
    : minutes >= rule.from || minutes < rule.to; // window crosses midnight
}

/** Whole days from today (in the zone) to a YYYY-MM-DD date; null if unparseable. */
export function daysUntil(dateStr, tz, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr ?? ""))) return null;
  const target = Date.parse(`${dateStr}T00:00:00Z`);
  const today = Date.parse(`${localClock(tz, now).date}T00:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(today)) return null;
  return Math.round((target - today) / 86400000);
}
