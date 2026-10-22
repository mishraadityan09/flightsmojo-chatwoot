// One review → one Chatwoot ticket, kept current. Stateless by design: the
// ticket itself says what was already posted.
//
//   1. POST contacts            idempotent on source_id (= "<store>:<id>")
//   2. GET  conversations       reuse the newest ticket of that contact,
//      or POST conversations    create it with the review attributes
//   3. compare the rendered review with the ticket's newest incoming message:
//        none      → post the review            ("created")
//        different → post "Review edited:" + it ("edited")
//        same      → nothing                    ("unchanged")
//
// `cache` (Map source_id → rendered text) only saves the GET for reviews that
// did not change since the last poll; losing it costs one round of GETs.

import { EDIT_PREFIX, contactAttributes, conversationAttributes, renderReview, sameText, sourceId, stripEditPrefix } from "./render.js";

const isIncoming = (m) => m?.message_type === 0 || m?.message_type === "incoming";

function newestIncoming(messages) {
  return (messages || []).filter(isIncoming).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0] || null;
}

function newestConversation(conversations) {
  return (conversations || []).slice().sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0] || null;
}

export async function syncReview(inbox, review, { cache = new Map(), importReplied = false } = {}) {
  const sid = sourceId(review.store, review.id);
  const rendered = renderReview(review);
  if (cache.get(sid) === rendered) return { result: "unchanged", sourceId: sid };

  await inbox.createContact({
    sourceId: sid,
    name: review.author,
    avatarUrl: review.avatarUrl,
    customAttributes: contactAttributes(review),
  });

  let conversation = newestConversation(await inbox.listConversations(sid));
  if (!conversation) {
    // Already answered in the store console before the bridge saw it: no ticket,
    // unless explicitly asked for.
    if (review.existingReply && !importReplied) {
      cache.set(sid, rendered);
      return { result: "skipped-replied", sourceId: sid };
    }
    conversation = await inbox.createConversation(sid, conversationAttributes(review));
  }

  const last = newestIncoming(conversation.messages);
  let result;
  if (!last) {
    await inbox.postMessage(sid, conversation.id, rendered);
    result = "created";
  } else if (!sameText(stripEditPrefix(last.content), rendered)) {
    await inbox.postMessage(sid, conversation.id, EDIT_PREFIX + rendered);
    await inbox.updateContact(sid, { customAttributes: contactAttributes(review) });
    result = "edited";
  } else {
    result = "unchanged";
  }
  cache.set(sid, rendered);
  return { result, sourceId: sid, conversationId: conversation.id };
}
