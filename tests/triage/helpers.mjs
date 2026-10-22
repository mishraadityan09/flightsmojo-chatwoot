// Shared fakes for the triage unit tests (modelled on tests/reviews/helpers.mjs).

// Replace global fetch for one test; handler(call) → { status?, body? }.
// Unlike the reviews helper this honours `init.signal`: classify() and the
// relay time-box their calls with AbortSignal.timeout, so a handler that is
// slow (or never answers) makes the fake reject the way undici would.
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  const fake = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body, signal: init.signal };
    calls.push(call);
    const { signal } = init;
    if (signal?.aborted) throw signal.reason;
    let onAbort = null;
    const aborted = signal
      ? new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;
    try {
      const r = (await (aborted ? Promise.race([handler(call), aborted]) : handler(call))) ?? {};
      const status = r.status ?? 200;
      const noBody = r.body === null || [101, 204, 205, 304].includes(status);
      const body = noBody ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
  globalThis.fetch = fake;
  return { calls, fetch: fake, restore: () => { globalThis.fetch = original; } };
}

export const json = (call) => (call.body ? JSON.parse(call.body) : null);

export const quiet = { info() {}, warn() {}, error() {} };

/**
 * Raw RFC 822 bytes built by hand (CRLF, no library):
 *   text only / html only / multipart-alternative (text + html), optionally
 *   wrapped in multipart/mixed with base64 attachments. `headers` adds custom
 *   headers; an array value repeats the header. `messageId: null` omits it.
 */
export function buildEml({
  from = "Airline Ops <OPS@Airline.Example>",
  to = "agency@flightsmojo.in",
  subject = "Schedule change PNR ABC123",
  messageId = "<abc-1@airline.example>",
  inReplyTo = null,
  date = "Tue, 21 Oct 2026 10:00:00 +0000",
  headers = {},
  text = null,
  html = null,
  attachments = [],
} = {}) {
  const crlf = (s) => String(s).replace(/\r?\n/g, "\r\n");
  const top = [];
  const push = (key, value) => {
    for (const one of [].concat(value ?? [])) top.push(`${key}: ${one}`);
  };
  push("From", from);
  push("To", to);
  push("Subject", subject);
  if (messageId) push("Message-ID", messageId);
  if (inReplyTo) push("In-Reply-To", inReplyTo);
  if (date) push("Date", date);
  for (const [key, value] of Object.entries(headers)) push(key, value);
  push("MIME-Version", "1.0");

  const textPart = text != null ? ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", crlf(text)] : null;
  const htmlPart = html != null ? ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", crlf(html)] : null;

  let bodyHeaders;
  let bodyLines;
  if (textPart && htmlPart) {
    const b = "alt-boundary-001";
    bodyHeaders = [`Content-Type: multipart/alternative; boundary="${b}"`];
    bodyLines = ["", `--${b}`, ...textPart, `--${b}`, ...htmlPart, `--${b}--`];
  } else if (textPart || htmlPart) {
    const part = textPart || htmlPart;
    bodyHeaders = part.slice(0, 2);
    bodyLines = part.slice(2);
  } else {
    bodyHeaders = ["Content-Type: text/plain; charset=utf-8"];
    bodyLines = ["", ""];
  }

  let lines;
  if (attachments.length) {
    const b = "mixed-boundary-001";
    lines = [...top, `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, ...bodyHeaders, ...bodyLines];
    for (const a of attachments) {
      const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? "");
      lines.push(
        `--${b}`,
        `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${a.filename}"`,
        `Content-Disposition: attachment; filename="${a.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        content.toString("base64"),
      );
    }
    lines.push(`--${b}--`, "");
  } else {
    lines = [...top, ...bodyHeaders, ...bodyLines, ""];
  }
  return Buffer.from(lines.join("\r\n"), "utf8");
}

// A recording fake of chatwoot.js createApi(): `gets` maps a path to the GET
// answer (a value, or a function — which may throw); `failOn` is a RegExp
// tested against "<METHOD> <path>" to make a call fail with "boom".
export function fakeApi({ gets = {}, failOn = null } = {}) {
  const calls = [];
  const answer = (path) => {
    const v = gets[path];
    return typeof v === "function" ? v() : v ?? {};
  };
  return {
    calls,
    async get(path) {
      calls.push(["GET", path]);
      if (failOn?.test(`GET ${path}`)) throw new Error("boom");
      return answer(path);
    },
    async post(path, body) {
      calls.push(["POST", path, body]);
      if (failOn?.test(`POST ${path}`)) throw new Error("boom");
      return {};
    },
  };
}
