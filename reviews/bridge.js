// The bridge's two jobs, free of express and env so tests can drive them:
//   pollStore(store)   store API → tickets (via sync.js)
//   handleReply(...)   Chatwoot API-inbox webhook → store reply
//
// A `store` is { key, label, client, inbox, webhookSecret } (built in server.js).

import { parseSourceId, STORE_LABEL } from "./render.js";
import { syncReview } from "./sync.js";

export function createBridge({ stores, replyMode = "readonly", maxRating = 5, backfillDays = 7, importReplied = false, note = null, log = console }) {
  const caches = new Map();
  const running = new Set();

  function cutoff(now = Date.now()) {
    return new Date(now - backfillDays * 24 * 60 * 60 * 1000);
  }

  function wanted(review, since) {
    if (Number(review.rating) > maxRating) return false;
    const when = review.updatedAt || review.createdAt;
    return !when || new Date(when) >= since;
  }

  async function pollStore(store, now = Date.now()) {
    if (running.has(store.key)) return null; // the previous poll is still going
    running.add(store.key);
    const counts = { seen: 0, created: 0, edited: 0, unchanged: 0, "skipped-replied": 0, failed: 0 };
    try {
      const since = cutoff(now);
      const reviews = await store.client.listReviews({ since });
      if (!caches.has(store.key)) caches.set(store.key, new Map());
      const cache = caches.get(store.key);
      for (const review of reviews) {
        if (!wanted(review, since)) continue;
        counts.seen += 1;
        try {
          const { result } = await syncReview(store.inbox, review, { cache, importReplied });
          counts[result] += 1;
        } catch (err) {
          counts.failed += 1;
          log.warn(`[reviews] ${store.key}: review ${review.id} not synced: ${err.message}`);
        }
      }
      log.info(
        `[reviews] ${store.key}: ${reviews.length} listed, ${counts.seen} in scope, ${counts.created} new, ${counts.edited} edited, ${counts["skipped-replied"]} already replied, ${counts.failed} failed`,
      );
      return counts;
    } catch (err) {
      log.error(`[reviews] ${store.key}: poll failed: ${err.message}`);
      return null;
    } finally {
      running.delete(store.key);
    }
  }

  // Which store a webhook payload belongs to, from the contact's source_id.
  function storeFor(payload) {
    const parsed = parseSourceId(payload?.conversation?.contact_inbox?.source_id);
    return parsed ? { store: stores.get(parsed.store) || null, parsed } : { store: null, parsed: null };
  }

  // Decide and act on one webhook delivery. Returns { status, reason }.
  // 2xx = Chatwoot keeps the agent's message as sent; anything else marks it
  // failed in the dashboard (Webhooks::Trigger → Messages::StatusUpdateService).
  async function handleReply(store, payload) {
    if (payload?.event !== "message_created") return { status: 200, reason: "ignored: not message_created" };
    if (payload.message_type !== "outgoing") return { status: 200, reason: "ignored: not outgoing" };
    if (payload.private) return { status: 200, reason: "ignored: private note" };
    if (payload.sender?.type !== "user") return { status: 200, reason: `ignored: sender ${payload.sender?.type || "unknown"}` };

    const conversationId = payload.conversation?.id;
    const reviewId = payload.conversation?.custom_attributes?.review_id || parseSourceId(payload.conversation?.contact_inbox?.source_id)?.id;
    const text = String(payload.content ?? "").trim();
    const label = STORE_LABEL[store.key] || store.key;

    if (!reviewId || !text) return { status: 200, reason: "ignored: no review id or empty text" };

    if (replyMode !== "post" || !store.webhookSecret) {
      const why = replyMode !== "post" ? "REVIEWS_REPLY_MODE is not \"post\"" : "the inbox webhook secret is not configured";
      await tell(conversationId, `Not posted to ${label}: ${why}. Reply from the store console if it should be public.`);
      return { status: 200, reason: `readonly: ${why}` };
    }

    try {
      await store.client.reply(reviewId, text);
      log.info(`[reviews] ${store.key}: reply posted on review ${reviewId} (conversation ${conversationId})`);
      return { status: 200, reason: "posted" };
    } catch (err) {
      const tooLong = err.status === "too_long";
      await tell(conversationId, `Reply NOT posted to ${label}: ${err.message}`);
      log.warn(`[reviews] ${store.key}: reply failed on review ${reviewId}: ${err.message}`);
      return { status: tooLong ? 422 : 502, reason: err.message };
    }
  }

  async function tell(conversationId, content) {
    if (!note || !conversationId) return;
    try {
      await note(conversationId, content);
    } catch (err) {
      log.warn(`[reviews] private note failed on conversation ${conversationId}: ${err.message}`);
    }
  }

  return { pollStore, handleReply, storeFor, cutoff };
}
