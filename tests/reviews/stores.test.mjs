import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPlayClient, normalizePlayReview } from "../../reviews/play.js";
import { createAppleClient, normalizeAppleReview } from "../../reviews/apple.js";
import { createGoogleClient, normalizeGoogleReview } from "../../reviews/google.js";
import { appleJwt } from "../../reviews/oauth.js";
import { APPLE_RAW, GOOGLE_RAW, PLAY_RAW, ecKeyPem, json, rsaKeyPem, stubFetch } from "./helpers.mjs";

test("Play: title/body split on the tab, timestamps, device, existing reply", () => {
  const r = normalizePlayReview(PLAY_RAW, "com.flightsmojo.app");
  assert.equal(r.store, "play");
  assert.equal(r.id, "gp:AOqpTOH-abc.def");
  assert.equal(r.title, "Great app");
  assert.equal(r.body, "I love using this app!");
  assert.equal(r.rating, 5);
  assert.equal(r.updatedAt, "2025-10-09T08:53:20.000Z");
  assert.equal(r.appVersion, "1.2.3");
  assert.equal(r.device, "E5333 (Xperia™ C4 Dual)");
  assert.equal(r.locale, "en");
  assert.equal(r.existingReply, null);
  assert.equal(r.link, "https://play.google.com/store/apps/details?id=com.flightsmojo.app");
  const replied = { ...PLAY_RAW, comments: [...PLAY_RAW.comments, { developerComment: { text: "Thanks!", lastModified: { seconds: "1" } } }] };
  assert.equal(normalizePlayReview(replied, "x").existingReply, "Thanks!");
  assert.equal(normalizePlayReview({ reviewId: "1", comments: [] }, "x"), null);
  assert.equal(normalizePlayReview({ reviewId: "2", comments: [{ userComment: { text: "no tab", starRating: 3 } }] }, "x").body, "no tab");
});

test("Play: list follows page tokens, reply posts replyText and refuses > 350 chars", async () => {
  const { privateKey } = rsaKeyPem();
  const sa = { client_email: "sa@example.iam", private_key: privateKey, token_uri: "https://oauth.test/token" };
  const { calls, restore } = stubFetch(({ url, body }) => {
    if (url === "https://oauth.test/token") {
      assert.match(body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
      return { body: { access_token: "tok", expires_in: 3600 } };
    }
    if (url.includes("/reviews?maxResults=100") && !url.includes("token=")) return { body: { reviews: [PLAY_RAW], tokenPagination: { nextPageToken: "p2" } } };
    if (url.includes("token=p2")) return { body: { reviews: [{ ...PLAY_RAW, reviewId: "second" }] } };
    if (url.endsWith(":reply")) return { body: { result: { replyText: json({ body }).replyText } } };
    throw new Error(`unexpected ${url}`);
  });
  try {
    const client = createPlayClient({ packageName: "com.fm", serviceAccount: sa, apiBase: "https://play.test/v3" });
    const reviews = await client.listReviews();
    assert.deepEqual(reviews.map((r) => r.id), ["gp:AOqpTOH-abc.def", "second"]);
    assert.equal(calls.filter((c) => c.url === "https://oauth.test/token").length, 1, "token minted once");
    assert.ok(calls.every((c) => c.url === "https://oauth.test/token" || c.headers.Authorization === "Bearer tok"));
    await client.reply("gp:AOqpTOH-abc.def", "Thank you!");
    const reply = calls.at(-1);
    assert.equal(reply.url, "https://play.test/v3/applications/com.fm/reviews/gp%3AAOqpTOH-abc.def:reply");
    assert.deepEqual(json(reply), { replyText: "Thank you!" });
    await assert.rejects(client.reply("x", "a".repeat(351)), /Google Play allows 350 characters; this reply has 351/);
  } finally {
    restore();
  }
});

test("Apple: normalisation, included responses, cutoff stops paging, reply body shape", async () => {
  const r = normalizeAppleReview(APPLE_RAW, "123");
  assert.equal(r.store, "apple");
  assert.equal(r.author, "flyer99");
  assert.equal(r.locale, "USA");
  assert.equal(r.updatedAt, null);
  assert.equal(r.link, "https://apps.apple.com/app/id123");

  const { privateKey } = ecKeyPem();
  const old = { ...APPLE_RAW, id: "old", attributes: { ...APPLE_RAW.attributes, createdDate: "2026-01-01T00:00:00+00:00" }, relationships: { response: { data: { type: "customerReviewResponses", id: "resp1" } } } };
  const { calls, restore } = stubFetch(({ url }) => {
    if (url.includes("/customerReviews?sort=-createdDate&limit=200&include=response")) {
      return { body: { data: [APPLE_RAW, old], included: [{ type: "customerReviewResponses", id: "resp1", attributes: { responseBody: "Sorry!", state: "PUBLISHED" } }], links: { next: "https://api.test/v1/apps/123/customerReviews?cursor=abc" } } };
    }
    if (url.includes("cursor=abc")) throw new Error("should not page past the cutoff");
    if (url.endsWith("/v1/customerReviewResponses")) return { status: 201, body: { data: { id: "r2" } } };
    throw new Error(`unexpected ${url}`);
  });
  try {
    const client = createAppleClient({ appId: "123", issuerId: "iss", keyId: "KEY1", privateKey, apiBase: "https://api.test" });
    const reviews = await client.listReviews({ since: new Date("2026-10-01T00:00:00Z") });
    assert.deepEqual(reviews.map((x) => [x.id, x.existingReply]), [["00000000-1111-2222-3333-444444444444", null], ["old", "Sorry!"]]);
    assert.match(calls[0].headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    await client.reply("00000000-1111-2222-3333-444444444444", "We fixed it");
    assert.deepEqual(json(calls.at(-1)), {
      data: { type: "customerReviewResponses", attributes: { responseBody: "We fixed it" }, relationships: { review: { data: { type: "customerReviews", id: "00000000-1111-2222-3333-444444444444" } } } },
    });
  } finally {
    restore();
  }
});

test("Apple JWT: ES256, kid header, 15-minute life, aud appstoreconnect-v1, verifiable", async () => {
  const { privateKey, publicKey } = ecKeyPem();
  const token = await appleJwt({ issuerId: "iss-1", keyId: "KEY1", privateKey })();
  const [h, p, s] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "KEY1", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.iss, "iss-1");
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.equal(claims.exp - claims.iat, 900);
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
});

test("Google: normalisation (anonymous, star words), refresh-token auth, paging cutoff, 4096-byte reply", async () => {
  const r = normalizeGoogleReview(GOOGLE_RAW);
  assert.equal(r.author, "Priya S");
  assert.equal(r.rating, 4);
  assert.equal(r.avatarUrl, "https://lh3.example/p.jpg");
  assert.equal(r.updatedAt, "2026-10-19T08:00:00Z");
  assert.equal(normalizeGoogleReview({ reviewId: "a", reviewer: { isAnonymous: true }, starRating: "ONE" }).author, "Anonymous reviewer");
  assert.equal(normalizeGoogleReview({ reviewId: "b", starRating: "FIVE" }).body, "");

  const { calls, restore } = stubFetch(({ url, body }) => {
    if (url === "https://oauth.test/token") {
      assert.match(body, /grant_type=refresh_token&client_id=cid&client_secret=cs&refresh_token=rt/);
      return { body: { access_token: "g-tok", expires_in: 3599 } };
    }
    if (url.includes("/reviews?pageSize=50&orderBy=updateTime+desc") && !url.includes("pageToken")) {
      return { body: { reviews: [GOOGLE_RAW, { ...GOOGLE_RAW, reviewId: "older", updateTime: "2026-01-01T00:00:00Z" }], nextPageToken: "n2" } };
    }
    if (url.includes("pageToken=n2")) throw new Error("should not page past the cutoff");
    if (url.endsWith("/reviews/AbFvOq/reply")) return { body: { comment: json({ body }).comment } };
    throw new Error(`unexpected ${url}`);
  });
  try {
    const client = createGoogleClient({ accountId: "1", locationId: "2", clientId: "cid", clientSecret: "cs", refreshToken: "rt", apiBase: "https://gbp.test", tokenUrl: "https://oauth.test/token" });
    const reviews = await client.listReviews({ since: new Date("2026-10-01T00:00:00Z") });
    assert.deepEqual(reviews.map((x) => x.id), ["AbFvOq", "older"]);
    await client.reply("AbFvOq", "Thanks Priya");
    const reply = calls.at(-1);
    assert.equal(reply.method, "PUT");
    assert.equal(reply.url, "https://gbp.test/v4/accounts/1/locations/2/reviews/AbFvOq/reply");
    assert.equal(reply.headers.Authorization, "Bearer g-tok");
    await assert.rejects(client.reply("AbFvOq", "é".repeat(2049)), /Google allows 4096 bytes; this reply has 4098/);
  } finally {
    restore();
  }
});
