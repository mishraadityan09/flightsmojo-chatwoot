// Store-neutral review → ticket text and attributes. Pure and deterministic:
// the same review always renders to the same text, which is how sync.js tells
// an edited review from an unchanged one (it compares this against the ticket's
// newest incoming message — no database needed, and it works for the App Store,
// which exposes no "modified" date).
//
// Review shape produced by play.js / apple.js / google.js:
//   { store, id, author, rating, title, body, createdAt, updatedAt, locale,
//     appVersion, device, avatarUrl, link, existingReply }

export const STORE_LABEL = { play: "Google Play", apple: "App Store", google: "Google reviews" };
export const EDIT_PREFIX = "Review edited:\n\n";

export function stars(rating) {
  const r = Math.min(5, Math.max(0, Math.round(Number(rating) || 0)));
  return "★".repeat(r) + "☆".repeat(5 - r);
}

// Chatwoot contact source_id / identifier. Store review ids may contain
// characters Rails will not accept in a path segment (a dot ends the segment),
// so the id is sanitised here; the exact id travels in the conversation's
// `review_id` attribute and is what replies use.
export function sourceId(store, id) {
  return `${store}:${String(id).replace(/[^A-Za-z0-9_:-]/g, "_")}`;
}

export function parseSourceId(value) {
  const m = /^(play|apple|google):(.+)$/.exec(String(value || ""));
  return m ? { store: m[1], id: m[2] } : null;
}

function clean(s) {
  return (s ?? "").toString().replace(/\r\n?/g, "\n").trim();
}

export function renderReview(review) {
  const header = [`${stars(review.rating)} ${Number(review.rating) || 0}/5`, STORE_LABEL[review.store] || review.store];
  if (review.appVersion) header.push(`v${review.appVersion}`);
  if (review.locale) header.push(review.locale);
  const lines = [header.join(" · "), ""];
  const title = clean(review.title);
  const body = clean(review.body);
  if (title) lines.push(title);
  lines.push(body || "(rating only, no written review)");
  return lines.join("\n");
}

export function stripEditPrefix(content) {
  const c = clean(content);
  return c.startsWith(EDIT_PREFIX) ? c.slice(EDIT_PREFIX.length) : c;
}

// Same text, ignoring line-ending and edge-whitespace differences Chatwoot may introduce.
export function sameText(a, b) {
  return clean(a) === clean(b);
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

// Keys must exist in Settings → Custom Attributes to show in the sidebar.
export function contactAttributes(review) {
  return compact({
    review_app_version: review.appVersion,
    review_locale: review.locale,
    review_device: review.device,
  });
}

export function conversationAttributes(review) {
  return compact({
    review_store: review.store,
    review_rating: Number(review.rating) || 0,
    review_id: String(review.id),
    review_updated_at: review.updatedAt || review.createdAt,
    review_link: review.link,
  });
}
