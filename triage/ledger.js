// The service's only state: an append-only JSONL file on the triage_data
// volume. It is the audit trail ("what did the classifier decide about mail
// X"), the verdict cache between relay and webhook, and the work list for the
// daily priority re-bump. Mail bodies are never written here.
//
// Record types (one JSON object per line, `ts` added on append):
//   verdict  – one per mail seen: message_id, from, subject, kind, relayed, …
//   stamp    – the ticket was stamped: message_id, conversation_id, priority
//   rebump   – the daily job raised the priority: message_id, priority
//   resolved – the daily job found the ticket resolved: message_id

import fs from "node:fs";
import path from "node:path";

export function openLedger(dir, { now = () => new Date(), log = console } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "verdicts.jsonl");
  const byId = new Map(); // message_id → merged entry
  const byConv = new Map(); // conversation_id → entry
  let bad = 0;

  function apply(rec) {
    const mid = String(rec.message_id || "");
    if (!mid) return;
    if (rec.type === "verdict") {
      const prev = byId.get(mid);
      // Flags live on the record after a compaction rewrite, on `prev` while the file is being replayed.
      const entry = { ...(prev || {}), ...rec, stamped: rec.stamped ?? prev?.stamped ?? false, resolved: rec.resolved ?? prev?.resolved ?? false };
      byId.set(mid, entry);
      if (entry.conversation_id) byConv.set(String(entry.conversation_id), entry);
      return;
    }
    const entry = byId.get(mid);
    if (!entry) return;
    if (rec.type === "stamp") {
      entry.stamped = true;
      entry.conversation_id = rec.conversation_id;
      if (rec.priority) entry.priority = rec.priority;
      entry.stamped_at = rec.ts;
      byConv.set(String(rec.conversation_id), entry);
    } else if (rec.type === "rebump") {
      entry.priority = rec.priority;
    } else if (rec.type === "resolved") {
      entry.resolved = true;
    }
  }

  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        apply(JSON.parse(line));
      } catch {
        bad++;
      }
    }
    if (bad) log.warn?.(`ledger: ${bad} unreadable line(s) in ${file} skipped`);
  }

  function append(rec) {
    const full = { ts: now().toISOString(), ...rec };
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
    apply(full);
    return full;
  }

  return {
    file,
    get size() {
      return byId.size;
    },
    record(entry) {
      return append({ type: "verdict", ...entry });
    },
    stamped(messageId, { conversationId, priority }) {
      return append({ type: "stamp", message_id: messageId, conversation_id: conversationId, priority: priority || null });
    },
    rebumped(messageId, priority) {
      return append({ type: "rebump", message_id: messageId, priority });
    },
    resolved(messageId) {
      return append({ type: "resolved", message_id: messageId });
    },
    byMessageId: (mid) => byId.get(String(mid || "")) || null,
    byConversation: (cid) => byConv.get(String(cid)) || null,
    /** Stamped, unresolved tickets with a date to watch — one entry per ticket (the latest stamped message). */
    openTickets() {
      const latest = new Map();
      for (const e of byId.values()) {
        if (!(e.stamped && !e.resolved && e.conversation_id && (e.travel_date || e.action_deadline))) continue;
        const key = String(e.conversation_id);
        const prev = latest.get(key);
        if (!prev || String(e.stamped_at || "") >= String(prev.stamped_at || "")) latest.set(key, e);
      }
      return [...latest.values()];
    },
    /** Rewrite the file: keep everything that became a ticket, and "other" lines newer than keepDays. */
    compact(keepDays = 90) {
      const cutoff = now().getTime() - keepDays * 86400000;
      const keep = [...byId.values()].filter((e) => e.relayed || e.stamped || Date.parse(e.ts) >= cutoff);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, keep.map((e) => JSON.stringify({ ...e, type: "verdict" })).join("\n") + (keep.length ? "\n" : ""));
      fs.renameSync(tmp, file);
      byId.clear();
      byConv.clear();
      for (const e of keep) apply({ ...e, type: "verdict" });
      return { kept: keep.length };
    },
  };
}
