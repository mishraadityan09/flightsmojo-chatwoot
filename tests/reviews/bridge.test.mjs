import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../../reviews/bridge.js";
import { ReplyTooLongError } from "../../reviews/limits.js";
import { fakeInbox } from "./helpers.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function fakeStore(key, { reviews = [], replyImpl } = {}) {
  const replies = [];
  return {
    key,
    label: key,
    webhookSecret: "s3cret",
    inbox: fakeInbox(),
    client: {
      listReviews: async () => reviews,
      reply: async (id, text) => {
        if (replyImpl) await replyImpl(id, text);
        replies.push([id, text]);
        return {};
      },
    },
    replies,
  };
}

function payload(overrides = {}) {
  return {
    event: "message_created",
    message_type: "outgoing",
    private: false,
    content: "Thanks for the feedback",
    sender: { type: "user", id: 2 },
    conversation: { id: 41, inbox_id: 9, custom_attributes: { review_id: "gp:AOqp.1" }, contact_inbox: { source_id: "play:gp:AOqp_1" } },
    ...overrides,
  };
}

test("storeFor reads the store from the contact source_id", () => {
  const play = fakeStore("play");
  const bridge = createBridge({ stores: new Map([["play", play]]), log: quiet });
  assert.equal(bridge.storeFor(payload()).store, play);
  assert.equal(bridge.storeFor(payload({ conversation: { contact_inbox: { source_id: "apple:1" } } })).store, null);
  assert.equal(bridge.storeFor({ event: "x" }).store, null);
});

test("handleReply ignores everything that is not a public agent reply", async () => {
  const play = fakeStore("play");
  const bridge = createBridge({ stores: new Map([["play", play]]), replyMode: "post", log: quiet });
  for (const p of [
    payload({ event: "message_updated" }),
    payload({ message_type: "incoming" }),
    payload({ private: true }),
    payload({ sender: { type: "agent_bot" } }),
    payload({ content: "   " }),
  ]) {
    const r = await bridge.handleReply(play, p);
    assert.equal(r.status, 200);
    assert.match(r.reason, /^ignored/);
  }
  assert.equal(play.replies.length, 0);
});

test("read-only mode: 200, nothing sent, a private note explains", async () => {
  const play = fakeStore("play");
  const notes = [];
  const bridge = createBridge({ stores: new Map([["play", play]]), replyMode: "readonly", note: async (id, c) => notes.push([id, c]), log: quiet });
  const r = await bridge.handleReply(play, payload());
  assert.equal(r.status, 200);
  assert.match(r.reason, /^readonly/);
  assert.equal(play.replies.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0][0], 41);
  assert.match(notes[0][1], /Not posted to Google Play: REVIEWS_REPLY_MODE/);
});

test("post mode without a webhook secret stays read-only", async () => {
  const play = { ...fakeStore("play"), webhookSecret: null };
  const bridge = createBridge({ stores: new Map([["play", play]]), replyMode: "post", log: quiet });
  const r = await bridge.handleReply(play, payload());
  assert.equal(r.status, 200);
  assert.match(r.reason, /webhook secret/);
});

test("post mode: the exact review id from custom_attributes is replied to", async () => {
  const play = fakeStore("play");
  const bridge = createBridge({ stores: new Map([["play", play]]), replyMode: "post", log: quiet });
  const r = await bridge.handleReply(play, payload());
  assert.deepEqual(r, { status: 200, reason: "posted" });
  assert.deepEqual(play.replies, [["gp:AOqp.1", "Thanks for the feedback"]]);
  // falls back to the source_id when the attribute is missing
  await bridge.handleReply(play, payload({ conversation: { id: 1, custom_attributes: {}, contact_inbox: { source_id: "play:abc" } } }));
  assert.deepEqual(play.replies[1], ["abc", "Thanks for the feedback"]);
});

test("too long → 422, store failure → 502, both leave a private note", async () => {
  const notes = [];
  const play = fakeStore("play", { replyImpl: async (_id, text) => { if (text.length > 5) throw new ReplyTooLongError("Google Play", text.length, 5, "characters"); if (text === "boom") throw new Error("HTTP 503 from play"); } });
  const bridge = createBridge({ stores: new Map([["play", play]]), replyMode: "post", note: async (id, c) => notes.push(c), log: quiet });
  assert.equal((await bridge.handleReply(play, payload({ content: "too long!" }))).status, 422);
  assert.equal((await bridge.handleReply(play, payload({ content: "boom" }))).status, 502);
  assert.equal((await bridge.handleReply(play, payload({ content: "ok" }))).status, 200);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /Reply NOT posted to Google Play: Google Play allows 5 characters/);
  assert.match(notes[1], /HTTP 503/);
});

test("pollStore applies the rating and backfill filters and counts outcomes", async () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const base = { store: "apple", author: "a", title: "", body: "b", locale: null, avatarUrl: null };
  const reviews = [
    { ...base, id: "new", rating: 2, createdAt: "2026-10-20T00:00:00Z" },
    { ...base, id: "happy", rating: 5, createdAt: "2026-10-20T00:00:00Z" },
    { ...base, id: "old", rating: 1, createdAt: "2026-09-01T00:00:00Z" },
    { ...base, id: "answered", rating: 1, createdAt: "2026-10-20T00:00:00Z", existingReply: "done" },
  ];
  const apple = fakeStore("apple", { reviews });
  const bridge = createBridge({ stores: new Map([["apple", apple]]), maxRating: 3, backfillDays: 7, log: quiet });
  const counts = await bridge.pollStore(apple, now);
  assert.deepEqual(counts, { seen: 2, created: 1, edited: 0, unchanged: 0, "skipped-replied": 1, failed: 0 });
  assert.equal(apple.inbox.calls.filter((c) => c[0] === "createConversation").length, 1);
  assert.deepEqual(await bridge.pollStore(apple, now), { seen: 2, created: 0, edited: 0, unchanged: 2, "skipped-replied": 0, failed: 0 });
});

test("pollStore survives a store outage and a single bad review", async () => {
  const down = { ...fakeStore("play"), client: { listReviews: async () => { throw new Error("HTTP 503"); } } };
  const bridge = createBridge({ stores: new Map([["play", down]]), log: quiet });
  assert.equal(await bridge.pollStore(down), null);
  const bad = fakeStore("google", { reviews: [{ store: "google", id: "x", rating: 3, body: "ok" }] });
  bad.inbox.createContact = async () => { throw new Error("HTTP 500"); };
  const counts = await createBridge({ stores: new Map([["google", bad]]), log: quiet }).pollStore(bad);
  assert.equal(counts.failed, 1);
});
