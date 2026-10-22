import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../../triage/relay.js";
import { HttpError } from "../../triage/http.js";
import { buildEml, stubFetch } from "./helpers.mjs";

const URL = "http://rails:3000/rails/action_mailbox/relay/inbound_emails";

test("relay posts the exact bytes as message/rfc822 with basic auth and X-Forwarded-Proto https; 204 resolves", async () => {
  const bytes = buildEml({ text: "AI 131 retimed.", headers: { "X-Original-To": "agency@flightsmojo.in" } });
  const { calls, restore } = stubFetch(() => ({ status: 204, body: null }));
  try {
    const relay = createRelay({ url: URL, password: "s3cret" });
    assert.equal(await relay(bytes), 204);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, "POST");
    assert.equal(call.url, URL);
    assert.equal(call.body, bytes, "the very same Buffer, untouched");
    assert.ok(Buffer.isBuffer(call.body) && call.body.equals(bytes));
    assert.match(call.body.toString(), /^From: Airline Ops <OPS@Airline\.Example>\r\n/, "nothing re-encoded or re-ordered");
    assert.match(call.body.toString(), /\r\nX-Original-To: agency@flightsmojo\.in\r\n/, "Postfix's routing header is still there for Chatwoot");
    assert.equal(call.headers["Content-Type"], "message/rfc822");
    assert.equal(call.headers.Authorization, `Basic ${Buffer.from("actionmailbox:s3cret").toString("base64")}`);
    assert.equal(call.headers.Authorization, "Basic YWN0aW9ubWFpbGJveDpzM2NyZXQ=");
    assert.equal(call.headers["X-Forwarded-Proto"], "https");
    assert.ok(call.signal instanceof AbortSignal, "the call is time-boxed");
  } finally {
    restore();
  }
});

test("relay resolves on 200 too and accepts an injected fetchImpl", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([String(url), init.method, init.headers["Content-Type"]]);
    return new Response("", { status: 200 });
  };
  const relay = createRelay({ url: URL, password: "p", fetchImpl });
  assert.equal(await relay(Buffer.from("From: a@b\r\n\r\nx")), 200);
  assert.deepEqual(seen, [[URL, "POST", "message/rfc822"]]);
});

test("relay throws HttpError carrying the status on 401 and 500", async () => {
  for (const status of [401, 500]) {
    const { calls, restore } = stubFetch(() => ({ status, body: "nope" }));
    try {
      const relay = createRelay({ url: URL, password: "s3cret" });
      await assert.rejects(relay(Buffer.from("From: a@b\r\n\r\nx")), (e) => {
        assert.ok(e instanceof HttpError, `HttpError for ${status}`);
        assert.equal(e.name, "HttpError");
        assert.equal(e.status, status);
        assert.equal(e.url, URL);
        assert.equal(e.detail, "nope");
        assert.equal(e.message, `HTTP ${status} from ${URL}: nope`);
        return true;
      });
      assert.equal(calls.length, 1);
    } finally {
      restore();
    }
  }
});

test("relay never puts the password in the error message or the URL", async () => {
  const { restore } = stubFetch(() => ({ status: 500, body: "boom" }));
  try {
    const relay = createRelay({ url: URL, password: "hunter2" });
    await assert.rejects(relay(Buffer.from("x")), (e) => !e.message.includes("hunter2") && !e.url.includes("hunter2"));
  } finally {
    restore();
  }
});
