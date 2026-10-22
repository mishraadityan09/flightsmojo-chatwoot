// Reply length rules per store. A reply over the limit is refused here, before
// the store sees it, so the agent gets a clear reason instead of a bare 400.

export class ReplyTooLongError extends Error {
  constructor(label, have, max, unit) {
    super(`${label} allows ${max} ${unit}; this reply has ${have}`);
    this.name = "ReplyTooLongError";
    this.status = "too_long";
  }
}

// Characters as a human counts them (code points), not UTF-16 units.
export function checkChars(text, max, label) {
  const have = [...String(text)].length;
  if (have > max) throw new ReplyTooLongError(label, have, max, "characters");
}

export function checkBytes(text, max, label) {
  const have = Buffer.byteLength(String(text), "utf8");
  if (have > max) throw new ReplyTooLongError(label, have, max, "bytes");
}
