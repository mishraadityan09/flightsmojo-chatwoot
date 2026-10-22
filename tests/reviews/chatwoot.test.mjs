import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { privateNotes, publicInbox, signedWith } from "../../reviews/chatwoot.js";
import { json, stubFetch } from "./helpers.mjs";

function signed(body, secret, ts = Math.floor(Date.now() / 1000)) {
  const rawBody = Buffer.from(body);
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.`).update(rawBody).digest("hex");
  return { headers: { "x-chatwoot-timestamp": String(ts), "x-chatwoot-signature": sig }, rawBody };
}

test("signedWith accepts Chatwoot's HMAC over 'timestamp.body' and rejects tampering, stale and missing", () => {
  const req = signed('{"a":1}', "s3cret");
  assert.ok(signedWith(req, "s3cret"));
  assert.ok(!signedWith(req, "other"));
  assert.ok(!signedWith({ ...req, rawBody: Buffer.from('{"a":2}') }, "s3cret"));
  assert.ok(!signedWith(signed("{}", "s3cret", Math.floor(Date.now() / 1000) - 600), "s3cret"));
  assert.ok(!signedWith({ headers: {}, rawBody: Buffer.from("{}") }, "s3cret"));
});

test("publicInbox builds the public client API calls", async () => {
  const { calls, restore } = stubFetch(() => ({ body: { id: 1 } }));
  try {
    const inbox = publicInbox({ baseUrl: "http://rails:3000/", identifier: "abc123" });
    await inbox.createContact({ sourceId: "play:1", name: "John", avatarUrl: null, customAttributes: { review_locale: "en" } });
    await inbox.listConversations("play:1");
    await inbox.createConversation("play:1", { review_rating: 5 });
    await inbox.postMessage("play:1", 42, "hello");
    await inbox.updateContact("play:1", { customAttributes: { review_device: "Pixel" } });
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [
      ["POST", "http://rails:3000/public/api/v1/inboxes/abc123/contacts"],
      ["GET", "http://rails:3000/public/api/v1/inboxes/abc123/contacts/play%3A1/conversations"],
      ["POST", "http://rails:3000/public/api/v1/inboxes/abc123/contacts/play%3A1/conversations"],
      ["POST", "http://rails:3000/public/api/v1/inboxes/abc123/contacts/play%3A1/conversations/42/messages"],
      ["PATCH", "http://rails:3000/public/api/v1/inboxes/abc123/contacts/play%3A1"],
    ]);
    assert.deepEqual(json(calls[0]), { source_id: "play:1", identifier: "play:1", name: "John", custom_attributes: { review_locale: "en" } });
    assert.deepEqual(json(calls[2]), { custom_attributes: { review_rating: 5 } });
    assert.deepEqual(json(calls[3]), { content: "hello" });
  } finally {
    restore();
  }
});

test("publicInbox surfaces non-2xx as errors", async () => {
  const { restore } = stubFetch(() => ({ status: 404, body: { error: "Resource could not be found" } }));
  try {
    await assert.rejects(publicInbox({ baseUrl: "http://x", identifier: "nope" }).listConversations("a"), /HTTP 404 from http:\/\/x\/public\/api\/v1\/inboxes\/nope\/contacts\/a\/conversations/);
  } finally {
    restore();
  }
});

test("privateNotes needs the bot token and account id, then posts a private outgoing message", async () => {
  assert.equal(privateNotes({ baseUrl: "http://x", accountId: "1", token: "" }), null);
  const { calls, restore } = stubFetch(() => ({ body: { id: 9 } }));
  try {
    await privateNotes({ baseUrl: "http://x", accountId: "1", token: "t" })(41, "note");
    assert.equal(calls[0].url, "http://x/api/v1/accounts/1/conversations/41/messages");
    assert.equal(calls[0].headers["api-access-token"], "t");
    assert.deepEqual(json(calls[0]), { content: "note", message_type: "outgoing", private: true });
  } finally {
    restore();
  }
});
