// Hand the UNCHANGED bytes to Chatwoot's Action Mailbox relay ingress — the
// same request Postfix's chatwoot-ingress script makes, so Chatwoot routes the
// mail by the X-Original-To header Postfix already added. Inside compose the
// rails container is reached directly (no nginx body limit); X-Forwarded-Proto
// keeps FORCE_SSL from answering with a redirect.

import { HttpError, redact } from "./http.js";

export function createRelay({ url, password, fetchImpl = fetch, timeoutMs = 60000 }) {
  const auth = `Basic ${Buffer.from(`actionmailbox:${password}`).toString("base64")}`;
  return async function relay(bytes) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        Authorization: auth,
        "X-Forwarded-Proto": "https",
        "User-Agent": "FlightsMojo triage relay",
      },
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new HttpError(res.status, redact(url), (await res.text()).slice(0, 200));
    return res.status;
  };
}
