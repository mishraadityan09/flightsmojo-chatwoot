// Chatwoot side of the bridge.
//  - publicInbox(): the public client API of one API-channel inbox
//    (app/controllers/public/api/v1/inboxes/*). Auth is the inbox identifier in
//    the URL, so no token lives here.
//  - signedWith(): the API-inbox webhook signature, same scheme as the agent-bot
//    webhook the bot verifies.
//  - privateNotes(): optional, needs the bot token; lets the bridge tell agents
//    why a reply did not reach the store.

import crypto from "node:crypto";
import { fetchJson } from "./http.js";

const enc = encodeURIComponent;

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

export function publicInbox({ baseUrl, identifier }) {
  const base = `${baseUrl.replace(/\/$/, "")}/public/api/v1/inboxes/${enc(identifier)}`;
  return {
    identifier,
    // POST contacts is idempotent on source_id (ContactInboxWithContactBuilder).
    createContact: ({ sourceId, name, avatarUrl, customAttributes }) =>
      fetchJson(`${base}/contacts`, {
        method: "POST",
        body: compact({ source_id: sourceId, identifier: sourceId, name, avatar_url: avatarUrl, custom_attributes: customAttributes }),
      }),
    updateContact: (sourceId, { name, customAttributes }) =>
      fetchJson(`${base}/contacts/${enc(sourceId)}`, { method: "PATCH", body: compact({ name, custom_attributes: customAttributes }) }),
    listConversations: (sourceId) => fetchJson(`${base}/contacts/${enc(sourceId)}/conversations`),
    // The public API permits custom_attributes only (no status, team, labels).
    createConversation: (sourceId, customAttributes) =>
      fetchJson(`${base}/contacts/${enc(sourceId)}/conversations`, { method: "POST", body: { custom_attributes: customAttributes } }),
    // Always an incoming message from the contact.
    postMessage: (sourceId, conversationId, content) =>
      fetchJson(`${base}/contacts/${enc(sourceId)}/conversations/${enc(conversationId)}/messages`, { method: "POST", body: { content } }),
  };
}

// ── Webhook authenticity ──
// Chatwoot signs every API-inbox delivery with the inbox's `secret`
// (Settings → Inboxes → the inbox → "Webhook secret"):
//   X-Chatwoot-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")
// Identical to bot/server.js. Without this seal anyone who reaches the port
// could publish replies on the stores in our name.
export const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export function signedWith({ headers, rawBody }, secret, now = Date.now()) {
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

// Private notes through the application API with the agent-bot token
// (messages#create is bot-accessible; ConversationPolicy#show? is true for bots).
export function privateNotes({ baseUrl, accountId, token }) {
  if (!baseUrl || !accountId || !token) return null;
  const base = `${baseUrl.replace(/\/$/, "")}/api/v1/accounts/${enc(accountId)}`;
  return (conversationId, content) =>
    fetchJson(`${base}/conversations/${enc(conversationId)}/messages`, {
      method: "POST",
      // Hyphenated header name: nginx drops underscore headers (see bot/server.js).
      headers: { "api-access-token": token },
      body: { content, message_type: "outgoing", private: true },
    });
}
