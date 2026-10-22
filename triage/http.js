// Shared fetch helpers (same lesson as the bot and the reviews bridge, 2026-08-03):
// fetch() resolves on 4xx/5xx, so every call checks res.ok, and no token may
// reach the logs through a URL.

export class HttpError extends Error {
  constructor(status, url, detail) {
    super(`HTTP ${status} from ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.detail = detail;
  }
}

export async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs, fetchImpl = fetch } = {}) {
  const target = String(url);
  const init = { method, headers: { Accept: "application/json", ...headers } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(target, init);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, redact(target), text.slice(0, 300));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(res.status, redact(target), `not JSON: ${text.slice(0, 80)}`);
  }
}

export function redact(url) {
  return String(url).replace(/([?&](access_token|token|key)=)[^&]+/gi, "$1…");
}
