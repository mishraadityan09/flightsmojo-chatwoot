// Shared JSON fetch with the one check the bot learned the hard way (2026-08-03):
// fetch() resolves on 4xx/5xx, so a dead token looks like success unless res.ok
// is checked. Every store and Chatwoot call goes through here.

export class HttpError extends Error {
  constructor(status, url, detail) {
    super(`HTTP ${status} from ${url}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.detail = detail;
  }
}

export async function fetchJson(url, { method = "GET", headers = {}, body, form } = {}) {
  const target = String(url);
  const init = { method, headers: { Accept: "application/json", ...headers } };
  if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(target, init);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, redact(target), text.slice(0, 300));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(res.status, redact(target), `not JSON: ${text.slice(0, 80)}`);
  }
}

// Never let a token in a query string reach the logs.
function redact(url) {
  return url.replace(/([?&](access_token|token|key)=)[^&]+/gi, "$1…");
}
