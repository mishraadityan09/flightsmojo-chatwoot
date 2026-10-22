// Chatwoot side of the triage service.
//  - signedWith(): account-webhook signature check, the very same scheme the
//    bot and the reviews bridge verify (X-Chatwoot-Signature over "<ts>.<body>").
//  - createApi(): the application API with the agent-bot token, hyphenated
//    header (nginx drops underscore headers). Only bot-accessible endpoints are
//    used: conversations show / custom_attributes / toggle_priority,
//    assignments create, labels index/create, messages create.

import crypto from "node:crypto";
import { fetchJson } from "./http.js";

export const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export function signedWith({ headers, rawBody }, secret, now = Date.now()) {
  if (!secret) return false;
  const ts = String(headers["x-chatwoot-timestamp"] || "");
  const sig = String(headers["x-chatwoot-signature"] || "");
  const age = Math.abs(now / 1000 - Number(ts));
  if (!sig || !ts || !(age <= SIGNATURE_MAX_AGE_SECONDS)) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(`${ts}.`)
      .update(rawBody ?? "")
      .digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createApi({ baseUrl, accountId, token, fetchImpl = fetch, timeoutMs = 15000 }) {
  const base = `${String(baseUrl).replace(/\/$/, "")}/api/v1/accounts/${encodeURIComponent(accountId)}`;
  const headers = { "api-access-token": token };
  return {
    get: (path) => fetchJson(`${base}${path}`, { headers, timeoutMs, fetchImpl }),
    post: (path, body) => fetchJson(`${base}${path}`, { method: "POST", headers, body, timeoutMs, fetchImpl }),
  };
}
