// Apple App Store — App Store Connect API, customerReviews / customerReviewResponses.
// Docs: developer.apple.com/documentation/appstoreconnectapi/customer-reviews.
// Facts that shape this file:
//  - the list has no time window (whole history), sorted -createdDate, 200/page;
//    the bridge stops paging at the backfill cutoff;
//  - a review carries createdDate only — edits are found by comparing text;
//  - one response per review; POST again overwrites; may take 24 h to publish;
//  - no documented length limit (REVIEWS_APPLE_REPLY_MAX_CHARS is optional);
//  - the 2025 webhooks have no review event, so: polling.

import { fetchJson } from "./http.js";
import { checkChars } from "./limits.js";
import { appleJwt } from "./oauth.js";

export const APPLE_API_BASE = "https://api.appstoreconnect.apple.com";
const MAX_PAGES = 5;

export function normalizeAppleReview(item, appId) {
  const a = item.attributes || {};
  return {
    store: "apple",
    id: item.id,
    author: a.reviewerNickname || "App Store user",
    rating: a.rating,
    title: a.title || "",
    body: a.body || "",
    createdAt: a.createdDate || null,
    updatedAt: null,
    locale: a.territory || null,
    appVersion: null,
    device: null,
    avatarUrl: null,
    link: `https://apps.apple.com/app/id${encodeURIComponent(appId)}`,
    existingReply: item.existingReply || null,
  };
}

// Attach the included response bodies (include=response) to their reviews.
function withResponses(data, included) {
  const responses = new Map((included || []).filter((i) => i.type === "customerReviewResponses").map((i) => [i.id, i]));
  return (data || []).map((item) => {
    const rel = item.relationships?.response?.data;
    const response = rel ? responses.get(rel.id) : null;
    return response ? { ...item, existingReply: response.attributes?.responseBody || null } : item;
  });
}

export function createAppleClient({ appId, issuerId, keyId, privateKey, apiBase = APPLE_API_BASE, replyMaxChars = null }) {
  const getToken = appleJwt({ issuerId, keyId, privateKey });
  const base = apiBase.replace(/\/$/, "");
  const auth = async () => ({ Authorization: `Bearer ${await getToken()}` });

  return {
    store: "apple",
    label: "App Store",
    async listReviews({ since } = {}) {
      const out = [];
      let url = `${base}/v1/apps/${encodeURIComponent(appId)}/customerReviews?sort=-createdDate&limit=200&include=response`;
      let pages = 0;
      while (url && pages < MAX_PAGES) {
        const res = await fetchJson(url, { headers: await auth() });
        const items = withResponses(res?.data, res?.included);
        for (const item of items) out.push(normalizeAppleReview(item, appId));
        const last = items[items.length - 1];
        const pastCutoff = since && last && new Date(last.attributes?.createdDate) < since;
        const next = res?.links?.next;
        url = !pastCutoff && next ? new URL(next, base).toString() : null;
        pages += 1;
      }
      return out;
    },
    async reply(reviewId, text) {
      if (replyMaxChars) checkChars(text, replyMaxChars, "App Store");
      return fetchJson(`${base}/v1/customerReviewResponses`, {
        method: "POST",
        headers: await auth(),
        body: {
          data: {
            type: "customerReviewResponses",
            attributes: { responseBody: text },
            relationships: { review: { data: { type: "customerReviews", id: reviewId } } },
          },
        },
      });
    },
  };
}
