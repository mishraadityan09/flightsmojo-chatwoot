// Google reviews — Google Business Profile API v4, accounts.locations.reviews.
// Docs: developers.google.com/my-business/content/review-data and
// …/reference/rest/v4/accounts.locations.reviews. Facts that shape this file:
//  - still the live reviews API in 2026 (new fields shipped this year);
//  - needs Google's API access approval first (0 QPM until then);
//  - auth is a user OAuth refresh token of an Owner/Manager of the listing;
//  - list is newest-updated first, 50/page; star-only reviews are included;
//  - one reply per review: PUT creates or updates it, 4096 bytes max.

import { fetchJson } from "./http.js";
import { checkBytes } from "./limits.js";
import { googleRefreshToken } from "./oauth.js";

export const GOOGLE_REPLY_MAX_BYTES = 4096;
export const GOOGLE_API_BASE = "https://mybusiness.googleapis.com";
const MAX_PAGES = 10;
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export function normalizeGoogleReview(raw) {
  const reviewer = raw.reviewer || {};
  return {
    store: "google",
    id: raw.reviewId,
    author: !reviewer.isAnonymous && reviewer.displayName ? reviewer.displayName : "Anonymous reviewer",
    rating: STARS[raw.starRating] ?? 0,
    title: "",
    body: raw.comment || "",
    createdAt: raw.createTime || null,
    updatedAt: raw.updateTime || raw.createTime || null,
    locale: null,
    appVersion: null,
    device: null,
    avatarUrl: reviewer.profilePhotoUrl || null,
    link: raw.reviewReplyUrl || null,
    existingReply: raw.reviewReply?.comment || null,
  };
}

export function createGoogleClient({ accountId, locationId, clientId, clientSecret, refreshToken, apiBase = GOOGLE_API_BASE, tokenUrl }) {
  const getToken = googleRefreshToken({ clientId, clientSecret, refreshToken, tokenUrl });
  const base = `${apiBase.replace(/\/$/, "")}/v4/accounts/${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews`;
  const auth = async () => ({ Authorization: `Bearer ${await getToken()}` });

  return {
    store: "google",
    label: "Google reviews",
    async listReviews({ since } = {}) {
      const out = [];
      let pageToken;
      let pages = 0;
      do {
        const url = new URL(base);
        url.searchParams.set("pageSize", "50");
        url.searchParams.set("orderBy", "updateTime desc");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const res = await fetchJson(url, { headers: await auth() });
        const items = res?.reviews || [];
        for (const raw of items) out.push(normalizeGoogleReview(raw));
        const last = items[items.length - 1];
        const pastCutoff = since && last && new Date(last.updateTime || last.createTime) < since;
        pageToken = pastCutoff ? null : res?.nextPageToken;
        pages += 1;
      } while (pageToken && pages < MAX_PAGES);
      return out;
    },
    async reply(reviewId, text) {
      checkBytes(text, GOOGLE_REPLY_MAX_BYTES, "Google");
      return fetchJson(`${base}/${encodeURIComponent(reviewId)}/reply`, {
        method: "PUT",
        headers: await auth(),
        body: { comment: text },
      });
    },
  };
}
