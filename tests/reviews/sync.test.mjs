import { test } from "node:test";
import assert from "node:assert/strict";
import { syncReview } from "../../reviews/sync.js";
import { EDIT_PREFIX, renderReview } from "../../reviews/render.js";
import { fakeInbox } from "./helpers.mjs";

const review = { store: "apple", id: "r-1", author: "flyer99", rating: 2, title: "Crashes", body: "Crashes on checkout", createdAt: "2026-10-20T10:00:00Z", locale: "USA", avatarUrl: null };

test("new review: contact, conversation with attributes, one incoming message", async () => {
  const inbox = fakeInbox();
  const out = await syncReview(inbox, review);
  assert.equal(out.result, "created");
  assert.equal(out.sourceId, "apple:r-1");
  assert.deepEqual(inbox.calls.map((c) => c[0]), ["createContact", "listConversations", "createConversation", "postMessage"]);
  assert.deepEqual(inbox.calls[0][1], { sourceId: "apple:r-1", name: "flyer99", avatarUrl: null, customAttributes: { review_locale: "USA" } });
  assert.deepEqual(inbox.calls[2][2], { review_store: "apple", review_rating: 2, review_id: "r-1", review_updated_at: "2026-10-20T10:00:00Z" });
  assert.equal(inbox.calls[3][3], renderReview(review));
});

test("unchanged review: nothing posted; the cache then skips even the GET", async () => {
  const inbox = fakeInbox({ conversations: [{ id: 7, messages: [{ id: 1, message_type: 0, content: renderReview(review) }, { id: 2, message_type: 1, content: "agent reply" }] }] });
  const cache = new Map();
  assert.equal((await syncReview(inbox, review, { cache })).result, "unchanged");
  assert.deepEqual(inbox.calls.map((c) => c[0]), ["createContact", "listConversations"]);
  assert.equal((await syncReview(inbox, review, { cache })).result, "unchanged");
  assert.equal(inbox.calls.length, 2, "second pass served from cache");
});

test("edited review: 'Review edited:' message on the same ticket, contact attributes refreshed", async () => {
  const older = { ...review, body: "Old text", rating: 1 };
  const inbox = fakeInbox({ conversations: [{ id: 7, messages: [{ id: 1, message_type: 0, content: `${EDIT_PREFIX}${renderReview(older)}` }] }] });
  const out = await syncReview(inbox, review);
  assert.equal(out.result, "edited");
  assert.equal(out.conversationId, 7);
  const post = inbox.calls.find((c) => c[0] === "postMessage");
  assert.equal(post[2], 7);
  assert.equal(post[3], `${EDIT_PREFIX}${renderReview(review)}`);
  assert.ok(inbox.calls.some((c) => c[0] === "updateContact"));
  assert.ok(!inbox.calls.some((c) => c[0] === "createConversation"));
});

test("newest conversation and newest incoming message win", async () => {
  const inbox = fakeInbox({
    conversations: [
      { id: 3, messages: [{ id: 1, message_type: 0, content: "stale" }] },
      { id: 9, messages: [{ id: 5, message_type: 0, content: "stale" }, { id: 8, message_type: 0, content: renderReview(review) }] },
    ],
  });
  assert.equal((await syncReview(inbox, review)).result, "unchanged");
});

test("a review already answered in the store console gets no ticket unless importReplied", async () => {
  const replied = { ...review, existingReply: "Sorry about that" };
  const inbox = fakeInbox();
  assert.equal((await syncReview(inbox, replied)).result, "skipped-replied");
  assert.ok(!inbox.calls.some((c) => c[0] === "createConversation"));
  const inbox2 = fakeInbox();
  assert.equal((await syncReview(inbox2, replied, { importReplied: true })).result, "created");
  // once a ticket exists, an existing reply no longer matters
  const inbox3 = fakeInbox({ conversations: [{ id: 1, messages: [{ id: 1, message_type: 0, content: renderReview(review) }] }] });
  assert.equal((await syncReview(inbox3, replied)).result, "unchanged");
});
