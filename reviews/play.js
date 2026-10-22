// Google Play — Google Play Developer API v3, `reviews` resource.
// Docs: developers.google.com/android-publisher/reply-to-reviews and
// …/api-ref/rest/v3/reviews. Facts that shape this file:
//  - list returns only reviews with text, created or modified in the last week;
//  - a review's `text` is "title<TAB>body";
//  - one reply per review, POST again edits it, 350 characters max;
//  - quota 200 GET / hour / app — polling every few minutes is fine;
//  - no push; polling is the only mechanism.

import { fetchJson } from "./http.js";
import { checkChars } from "./limits.js";
import { googleServiceAccount } from "./oauth.js";

export const PLAY_REPLY_MAX_CHARS = 350;
export const PLAY_API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const MAX_PAGES = 20;

function tsToIso(ts) {
  if (!ts || ts.seconds === undefined) return null;
  return new Date(Number(ts.seconds) * 1000).toISOString();
}

export function normalizePlayReview(raw, packageName) {
  const user = (raw.comments || []).find((c) => c.userComment)?.userComment;
  if (!user) return null;
  const developer = (raw.comments || []).find((c) => c.developerComment)?.developerComment;
  const text = user.text ?? "";
  const tab = text.indexOf("\t");
  const updatedAt = tsToIso(user.lastModified);
  return {
    store: "play",
    id: raw.reviewId,
    author: raw.authorName || "Google Play user",
    rating: user.starRating,
    title: tab >= 0 ? text.slice(0, tab) : "",
    body: tab >= 0 ? text.slice(tab + 1) : text,
    createdAt: updatedAt, // Play exposes no creation time
    updatedAt,
    locale: user.reviewerLanguage || null,
    appVersion: user.appVersionName || null,
    device: user.deviceMetadata?.productName || user.device || null,
    avatarUrl: null,
    link: `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}`,
    existingReply: developer?.text || null,
  };
}

export function createPlayClient({ packageName, serviceAccount, apiBase = PLAY_API_BASE }) {
  const getToken = googleServiceAccount({
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
    tokenUri: serviceAccount.token_uri,
    scope: "https://www.googleapis.com/auth/androidpublisher",
  });
  const base = `${apiBase.replace(/\/$/, "")}/applications/${encodeURIComponent(packageName)}/reviews`;
  const auth = async () => ({ Authorization: `Bearer ${await getToken()}` });

  return {
    store: "play",
    label: "Google Play",
    async listReviews() {
      const out = [];
      let token;
      let pages = 0;
      do {
        const url = new URL(base);
        url.searchParams.set("maxResults", "100");
        if (token) url.searchParams.set("token", token);
        const res = await fetchJson(url, { headers: await auth() });
        for (const raw of res?.reviews || []) {
          const review = normalizePlayReview(raw, packageName);
          if (review) out.push(review);
        }
        token = res?.tokenPagination?.nextPageToken;
        pages += 1;
      } while (token && pages < MAX_PAGES);
      return out;
    },
    async reply(reviewId, text) {
      checkChars(text, PLAY_REPLY_MAX_CHARS, "Google Play");
      return fetchJson(`${base}/${encodeURIComponent(reviewId)}:reply`, {
        method: "POST",
        headers: await auth(),
        body: { replyText: text },
      });
    },
  };
}
