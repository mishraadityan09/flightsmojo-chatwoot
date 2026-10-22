// Tokens for the three stores, built with Node's crypto only (no JWT library).
//  - Google service account (Play): RS256 JWT exchanged for an access token.
//  - Google user OAuth (Business Profile): refresh-token grant.
//  - Apple App Store Connect: ES256 JWT sent directly as the bearer, ≤ 20 min.
// Each getter caches its token and renews a minute before expiry.

import crypto from "node:crypto";
import { fetchJson } from "./http.js";

const b64url = (x) => Buffer.from(x).toString("base64url");

function cached(mint, skewSeconds = 60) {
  let token = null;
  let exp = 0;
  return async () => {
    const now = Math.floor(Date.now() / 1000);
    if (token && exp - skewSeconds > now) return token;
    ({ token, exp } = await mint(now));
    return token;
  };
}

export function googleServiceAccount({ clientEmail, privateKey, tokenUri = "https://oauth2.googleapis.com/token", scope }) {
  return cached(async (now) => {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: clientEmail, scope, aud: tokenUri, iat: now, exp: now + 3600 }));
    const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey);
    const assertion = `${header}.${claims}.${signature.toString("base64url")}`;
    const res = await fetchJson(tokenUri, {
      method: "POST",
      form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion },
    });
    return { token: res.access_token, exp: now + Number(res.expires_in || 3600) };
  });
}

export function googleRefreshToken({ clientId, clientSecret, refreshToken, tokenUrl = "https://oauth2.googleapis.com/token" }) {
  return cached(async (now) => {
    const res = await fetchJson(tokenUrl, {
      method: "POST",
      form: { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken },
    });
    return { token: res.access_token, exp: now + Number(res.expires_in || 3600) };
  });
}

// Apple: "Tokens that expire more than 20 minutes into the future are not valid".
export function appleJwt({ issuerId, keyId, privateKey, lifetimeSeconds = 15 * 60 }) {
  return cached(async (now) => {
    const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + lifetimeSeconds, aud: "appstoreconnect-v1" }));
    const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return { token: `${header}.${claims}.${signature.toString("base64url")}`, exp: now + lifetimeSeconds };
  });
}
