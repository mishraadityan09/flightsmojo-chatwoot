import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EDIT_PREFIX, conversationAttributes, contactAttributes, parseSourceId, renderReview, sameText, sourceId, stars, stripEditPrefix,
} from "../../reviews/render.js";

test("stars clamps and rounds", () => {
  assert.equal(stars(5), "★★★★★");
  assert.equal(stars(2), "★★☆☆☆");
  assert.equal(stars(0), "☆☆☆☆☆");
  assert.equal(stars("x"), "☆☆☆☆☆");
  assert.equal(stars(9), "★★★★★");
});

test("sourceId sanitises what Rails will not take in a path segment; parse round-trips", () => {
  assert.equal(sourceId("play", "gp:AOqpTOH-abc.def"), "play:gp:AOqpTOH-abc_def");
  assert.equal(sourceId("apple", "0000-1111"), "apple:0000-1111");
  assert.deepEqual(parseSourceId("google:AbFvOq"), { store: "google", id: "AbFvOq" });
  assert.equal(parseSourceId("web:123"), null);
  assert.equal(parseSourceId(undefined), null);
});

test("renderReview is deterministic and carries the header facts", () => {
  const review = { store: "play", rating: 2, title: "Crashes", body: "Crashes on checkout\r\n", appVersion: "3.4.1", locale: "en" };
  const text = renderReview(review);
  assert.equal(text, "★★☆☆☆ 2/5 · Google Play · v3.4.1 · en\n\nCrashes\nCrashes on checkout");
  assert.equal(renderReview(review), text);
});

test("renderReview handles rating-only reviews and missing title", () => {
  assert.equal(renderReview({ store: "google", rating: 4, body: "" }), "★★★★☆ 4/5 · Google reviews\n\n(rating only, no written review)");
  assert.equal(renderReview({ store: "apple", rating: 1, body: "Bad", locale: "USA" }), "★☆☆☆☆ 1/5 · App Store · USA\n\nBad");
});

test("stripEditPrefix and sameText ignore line endings and edge whitespace", () => {
  const text = "★★☆☆☆ 2/5 · App Store\n\nBad";
  assert.equal(stripEditPrefix(`${EDIT_PREFIX}${text}`), text);
  assert.equal(stripEditPrefix(text), text);
  assert.ok(sameText("a\r\nb  \n", "a\nb"));
  assert.ok(!sameText("a", "b"));
});

test("attributes drop empty values and keep the exact review id", () => {
  const review = { store: "play", id: "gp:x.y", rating: 3, updatedAt: "2026-10-19T08:00:00.000Z", link: null, appVersion: "1.0", locale: null, device: "Pixel" };
  assert.deepEqual(conversationAttributes(review), { review_store: "play", review_rating: 3, review_id: "gp:x.y", review_updated_at: "2026-10-19T08:00:00.000Z" });
  assert.deepEqual(contactAttributes(review), { review_app_version: "1.0", review_device: "Pixel" });
});
