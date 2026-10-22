import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SIGNATURE_MAX_AGE_SECONDS, createApi, signedWith } from "../../triage/chatwoot.js";
import { HttpError } from "../../triage/http.js";
import { json, stubFetch } from "./helpers.mjs";

function signed(body, secret, ts = Math.floor(Date.now() / 1000)) {
  const rawBody = Buffer.from(body);
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.`).update(rawBody).digest("hex");
  return { headers: { "x-chatwoot-timestamp": String(ts), "x-chatwoot-signature": sig }, rawBody };
}

test("signedWith: a valid HMAC over 'timestamp.body' passes; wrong secret and tampered body fail", () => {
  const req = signed('{"event":"message_created"}', "s3cret");
  assert.ok(signedWith(req, "s3cret"));
  assert.ok(!signedWith(req, "other"));
  assert.ok(!signedWith({ ...req, rawBody: Buffer.from('{"event":"message_updated"}') }, "s3cret"));
  assert.ok(!signedWith({ ...req, headers: { ...req.headers, "x-chatwoot-signature": "sha256=" + "0".repeat(64) } }, "s3cret"));
  assert.ok(!signedWith({ ...req, headers: { ...req.headers, "x-chatwoot-signature": "sha256=abc" } }, "s3cret"), "a different length never throws");
  assert.ok(signedWith({ ...req, rawBody: req.rawBody.toString() }, "s3cret"), "a string body hashes the same bytes");
});

test("signedWith: a stale timestamp (older than 5 minutes) fails, so does one from the future", () => {
  assert.equal(SIGNATURE_MAX_AGE_SECONDS, 300);
  const ts = 1_760_000_000;
  const req = signed("{}", "s3cret", ts);
  assert.ok(signedWith(req, "s3cret", ts * 1000));
  assert.ok(signedWith(req, "s3cret", (ts + 299) * 1000));
  assert.ok(signedWith(req, "s3cret", (ts + SIGNATURE_MAX_AGE_SECONDS) * 1000), "exactly five minutes is still accepted");
  assert.ok(!signedWith(req, "s3cret", (ts + SIGNATURE_MAX_AGE_SECONDS + 1) * 1000));
  assert.ok(!signedWith(req, "s3cret", (ts + 3600) * 1000));
  assert.ok(!signedWith(req, "s3cret", (ts - SIGNATURE_MAX_AGE_SECONDS - 1) * 1000), "clock skew the other way");
  assert.ok(!signedWith(signed("{}", "s3cret", Math.floor(Date.now() / 1000) - 600), "s3cret"), "with the real clock");
  assert.ok(signedWith(signed("{}", "s3cret"), "s3cret"));
});

test("signedWith: missing headers, a non-numeric timestamp, or no configured secret → false", () => {
  const ts = 1_760_000_000;
  assert.ok(!signedWith({ headers: {}, rawBody: Buffer.from("{}") }, "s3cret"));
  assert.ok(!signedWith({ headers: { "x-chatwoot-timestamp": String(ts) }, rawBody: Buffer.from("{}") }, "s3cret", ts * 1000), "no signature");
  assert.ok(!signedWith({ headers: { "x-chatwoot-signature": "sha256=abc" }, rawBody: Buffer.from("{}") }, "s3cret"), "no timestamp");
  const bad = signed("{}", "s3cret", "yesterday");
  assert.ok(!signedWith(bad, "s3cret"));
  const req = signed("{}", "s3cret");
  assert.ok(!signedWith(req, ""));
  assert.ok(!signedWith(req, undefined));
  assert.ok(!signedWith(req, null));
  assert.ok(!signedWith({ headers: req.headers, rawBody: undefined }, "s3cret"), "no body is not the signed body");
});

test("createApi: hyphenated api-access-token header, JSON accept/content-type, /api/v1/accounts/<id> base", async () => {
  const { calls, restore } = stubFetch((call) => (call.method === "GET" ? { body: { id: 41, status: "open" } } : { body: { payload: ["irop"] } }));
  try {
    const api = createApi({ baseUrl: "http://rails:3000/", accountId: 1, token: "bot-token" });
    assert.deepEqual(await api.get("/conversations/41"), { id: 41, status: "open" });
    assert.deepEqual(await api.post("/conversations/41/labels", { labels: ["irop"] }), { payload: ["irop"] });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url, "http://rails:3000/api/v1/accounts/1/conversations/41");
    assert.equal(calls[0].headers["api-access-token"], "bot-token");
    assert.ok(!("api_access_token" in calls[0].headers), "nginx drops underscore headers");
    assert.equal(calls[0].headers.Accept, "application/json");
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "http://rails:3000/api/v1/accounts/1/conversations/41/labels");
    assert.equal(calls[1].headers["api-access-token"], "bot-token");
    assert.equal(calls[1].headers["Content-Type"], "application/json");
    assert.deepEqual(json(calls[1]), { labels: ["irop"] });
    assert.ok(calls[0].signal instanceof AbortSignal, "time-boxed");
  } finally {
    restore();
  }
});

test("createApi: the account id is escaped and the base URL needs no trailing slash", async () => {
  const { calls, restore } = stubFetch(() => ({ body: {} }));
  try {
    await createApi({ baseUrl: "https://support.example.com", accountId: "a b", token: "t" }).get("/conversations/1");
    assert.equal(calls[0].url, "https://support.example.com/api/v1/accounts/a%20b/conversations/1");
  } finally {
    restore();
  }
});

test("createApi: non-2xx → HttpError with the status; an empty body resolves null; an injected fetchImpl is used", async () => {
  const { restore } = stubFetch((call) => (call.method === "GET" ? { status: 404, body: { error: "Resource could not be found" } } : { status: 200, body: "" }));
  try {
    const api = createApi({ baseUrl: "http://x", accountId: "1", token: "t" });
    await assert.rejects(api.get("/conversations/9"), (e) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.status, 404);
      assert.match(e.message, /^HTTP 404 from http:\/\/x\/api\/v1\/accounts\/1\/conversations\/9: .*Resource could not be found/);
      return true;
    });
    assert.equal(await api.post("/conversations/9/toggle_priority", { priority: "high" }), null);
  } finally {
    restore();
  }
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([String(url), init.headers["api-access-token"]]);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  assert.deepEqual(await createApi({ baseUrl: "http://y", accountId: "2", token: "tok", fetchImpl }).get("/conversations/3"), { ok: true });
  assert.deepEqual(seen, [["http://y/api/v1/accounts/2/conversations/3", "tok"]]);
});
