import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLedger } from "../../triage/ledger.js";
import { quiet } from "./helpers.mjs";

// Each test gets its own temp dir and removes it; `clock` drives the `now` option.
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-ledger-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const lines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const T0 = "2026-10-22T06:00:00.000Z";
const T1 = "2026-10-22T06:05:00.000Z";
const T2 = "2026-10-23T06:00:00.000Z";
const T3 = "2026-10-24T06:00:00.000Z";
const irop = (message_id, extra = {}) => ({ message_id, from: "ops@airline.example", subject: "Schedule change", kind: "irop", verdict: "irop", irop_type: "schedule_change", pnrs: ["ABC123"], travel_date: "2026-10-30", action_deadline: null, label: "irop", priority: "medium", relayed: true, ...extra });
const other = (message_id, extra = {}) => ({ message_id, from: "billing@airline.example", subject: "Invoice", kind: "other", verdict: "other", travel_date: null, action_deadline: null, label: null, priority: null, relayed: false, ...extra });

test("record / stamped / rebumped / resolved append one JSONL line each, with ts, and update the index", () =>
  withDir((dir) => {
    let clock = new Date(T0);
    const ledger = openLedger(dir, { now: () => clock, log: quiet });
    assert.equal(ledger.file, path.join(dir, "verdicts.jsonl"));
    assert.equal(ledger.size, 0);
    assert.equal(ledger.byMessageId("m1@x"), null);

    const rec = ledger.record(irop("m1@x"));
    assert.equal(rec.ts, T0);
    assert.equal(rec.type, "verdict");
    assert.equal(rec.message_id, "m1@x");
    assert.equal(ledger.size, 1);
    let e = ledger.byMessageId("m1@x");
    assert.equal(e.stamped, false);
    assert.equal(e.resolved, false);
    assert.equal(e.conversation_id, undefined);
    assert.equal(e.kind, "irop");
    assert.equal(ledger.byConversation(41), null);

    clock = new Date(T1);
    ledger.stamped("m1@x", { conversationId: 41, priority: "medium" });
    e = ledger.byMessageId("m1@x");
    assert.equal(e.stamped, true);
    assert.equal(e.conversation_id, 41);
    assert.equal(e.priority, "medium");
    assert.equal(e.stamped_at, T1);
    assert.equal(ledger.byConversation(41), e);
    assert.equal(ledger.byConversation("41"), e, "string or number id");

    clock = new Date(T2);
    ledger.rebumped("m1@x", "high");
    assert.equal(ledger.byMessageId("m1@x").priority, "high");
    assert.equal(ledger.byMessageId("m1@x").resolved, false);

    clock = new Date(T3);
    ledger.resolved("m1@x");
    assert.equal(ledger.byMessageId("m1@x").resolved, true);
    assert.equal(ledger.byMessageId("m1@x").stamped, true);

    const all = lines(ledger.file);
    assert.deepEqual(all.map((l) => l.type), ["verdict", "stamp", "rebump", "resolved"]);
    assert.deepEqual(all.map((l) => l.ts), [T0, T1, T2, T3]);
    assert.deepEqual(all[0], { ts: T0, ...irop("m1@x"), type: "verdict" });
    assert.deepEqual(all[1], { ts: T1, type: "stamp", message_id: "m1@x", conversation_id: 41, priority: "medium" });
    assert.deepEqual(all[2], { ts: T2, type: "rebump", message_id: "m1@x", priority: "high" });
    assert.deepEqual(all[3], { ts: T3, type: "resolved", message_id: "m1@x" });
    assert.ok(!JSON.stringify(all).includes("Dear agent"), "no mail body is ever written");
    assert.equal(ledger.size, 1);
  }));

test("stamped() without a priority stores null and keeps the verdict's priority; a verdict re-recorded keeps its stamped flag", () =>
  withDir((dir) => {
    const ledger = openLedger(dir, { now: () => new Date(T0), log: quiet });
    ledger.record(irop("m1@x", { priority: "high" }));
    ledger.stamped("m1@x", { conversationId: 41, priority: null });
    assert.equal(lines(ledger.file)[1].priority, null);
    assert.equal(ledger.byMessageId("m1@x").priority, "high");
    ledger.record(irop("m1@x", { subject: "Re: Schedule change", priority: "urgent" }));
    const e = ledger.byMessageId("m1@x");
    assert.equal(e.stamped, true, "a second verdict line for the same id does not unstamp it");
    assert.equal(e.conversation_id, 41);
    assert.equal(e.subject, "Re: Schedule change");
    assert.equal(e.priority, "urgent");
    assert.equal(ledger.size, 1);
  }));

test("stamp / rebump / resolved lines for an unknown message id are appended but ignored", () =>
  withDir((dir) => {
    const ledger = openLedger(dir, { now: () => new Date(T0), log: quiet });
    ledger.stamped("ghost@x", { conversationId: 9, priority: "low" });
    ledger.rebumped("ghost@x", "high");
    ledger.resolved("ghost@x");
    ledger.record({ subject: "no message id", kind: "other" });
    assert.equal(ledger.size, 0);
    assert.equal(ledger.byMessageId("ghost@x"), null);
    assert.equal(ledger.byConversation(9), null);
    assert.equal(lines(ledger.file).length, 4);
  }));

test("reopening the same dir rebuilds the same state from the file", () =>
  withDir((dir) => {
    let clock = new Date(T0);
    const first = openLedger(dir, { now: () => clock, log: quiet });
    first.record(irop("m1@x"));
    first.record(other("m2@x"));
    first.record(irop("m3@x", { travel_date: "2026-11-05" }));
    clock = new Date(T1);
    first.stamped("m1@x", { conversationId: 41, priority: "medium" });
    first.stamped("m3@x", { conversationId: 43, priority: "low" });
    clock = new Date(T2);
    first.rebumped("m1@x", "high");
    first.resolved("m3@x");

    const second = openLedger(dir, { now: () => new Date(T3), log: quiet });
    assert.equal(second.size, first.size);
    assert.equal(second.size, 3);
    for (const id of ["m1@x", "m2@x", "m3@x"]) assert.deepEqual(second.byMessageId(id), first.byMessageId(id), id);
    assert.deepEqual(second.byConversation(41), first.byConversation(41));
    assert.deepEqual(second.byConversation(43), first.byConversation(43));
    assert.equal(second.byMessageId("m1@x").priority, "high");
    assert.equal(second.byMessageId("m1@x").stamped_at, T1);
    assert.equal(second.byMessageId("m3@x").resolved, true);
    assert.deepEqual(second.openTickets().map((e) => e.message_id), first.openTickets().map((e) => e.message_id));
    assert.deepEqual(second.openTickets().map((e) => e.message_id), ["m1@x"]);
    // and appending to the reopened ledger continues the same file
    second.record(other("m4@x"));
    assert.equal(lines(second.file).length, 8);
    assert.equal(openLedger(dir, { log: quiet }).size, 4);
  }));

test("an empty or missing file opens an empty ledger; the directory is created", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "triage-ledger-")), "nested", "data");
  try {
    const ledger = openLedger(dir, { log: quiet });
    assert.equal(ledger.size, 0);
    assert.deepEqual(ledger.openTickets(), []);
    assert.ok(fs.existsSync(dir));
    assert.ok(!fs.existsSync(ledger.file), "nothing written until the first record");
    ledger.record(other("m1@x"));
    assert.ok(fs.existsSync(ledger.file));
  } finally {
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  }
});

test("openTickets: stamped, unresolved, with a conversation and a date to watch", () =>
  withDir((dir) => {
    const ledger = openLedger(dir, { now: () => new Date(T0), log: quiet });
    ledger.record(irop("stamped-travel"));
    ledger.record(irop("relayed-only"));
    ledger.record(irop("stamped-no-dates", { travel_date: null, action_deadline: null }));
    ledger.record(irop("stamped-deadline", { travel_date: null, action_deadline: "2026-10-28" }));
    ledger.record(irop("stamped-resolved"));
    ledger.record(other("other"));
    ledger.stamped("stamped-travel", { conversationId: 1, priority: "medium" });
    ledger.stamped("stamped-no-dates", { conversationId: 2, priority: "medium" });
    ledger.stamped("stamped-deadline", { conversationId: 3, priority: "low" });
    ledger.stamped("stamped-resolved", { conversationId: 4, priority: "medium" });
    ledger.resolved("stamped-resolved");
    assert.deepEqual(ledger.openTickets().map((e) => e.message_id).sort(), ["stamped-deadline", "stamped-travel"]);
    const t = ledger.openTickets().find((e) => e.message_id === "stamped-travel");
    assert.equal(t.conversation_id, 1);
    assert.equal(t.travel_date, "2026-10-30");
  }));

test("openTickets: one entry per conversation — the latest stamped message of a chain", () =>
  withDir((dir) => {
    let clock = new Date(T0);
    const ledger = openLedger(dir, { now: () => clock, log: quiet });
    ledger.record(irop("first@x", { travel_date: "2026-10-30" }));
    ledger.record(irop("second@x", { travel_date: "2026-11-05", subject: "Re: Schedule change" }));
    ledger.record(irop("third@x", { travel_date: "2026-11-09" }));
    ledger.stamped("first@x", { conversationId: 41, priority: "medium" });
    clock = new Date(T2);
    ledger.stamped("second@x", { conversationId: 41, priority: "medium" });
    clock = new Date(T1);
    ledger.stamped("third@x", { conversationId: 42, priority: "low" });
    const open = ledger.openTickets();
    assert.equal(open.length, 2);
    assert.deepEqual(open.map((e) => e.conversation_id).sort(), [41, 42]);
    const chain = open.find((e) => e.conversation_id === 41);
    assert.equal(chain.message_id, "second@x", "the later stamped_at wins");
    assert.equal(chain.travel_date, "2026-11-05");
    assert.equal(ledger.byConversation(41).message_id, "second@x");
    // resolving the latest message hides the ticket only for that entry; the chain's earlier message is still open
    ledger.resolved("second@x");
    assert.equal(ledger.openTickets().find((e) => e.conversation_id === 41)?.message_id, "first@x");
    ledger.resolved("first@x");
    assert.deepEqual(ledger.openTickets().map((e) => e.conversation_id), [42]);
  }));

test("compact keeps relayed and stamped entries plus recent others, drops old 'other' lines, rewrites the file", () =>
  withDir((dir) => {
    let clock = new Date(T0);
    const seed = (l) => {
      clock = new Date("2026-06-01T00:00:00.000Z"); // 143 days before T0
      l.record(other("old-other"));
      l.record(irop("old-irop"));
      l.record(irop("old-stamped"));
      l.stamped("old-stamped", { conversationId: 41, priority: "medium" });
      l.record(other("old-stamped-other", { relayed: false }));
      l.stamped("old-stamped-other", { conversationId: 42, priority: null });
      clock = new Date("2026-10-20T00:00:00.000Z");
      l.record(other("recent-other"));
      clock = new Date(T0);
    };
    const ledger = openLedger(dir, { now: () => clock, log: quiet });
    seed(ledger);
    assert.equal(lines(ledger.file).length, 7);
    assert.equal(ledger.size, 5);

    assert.deepEqual(ledger.compact(90), { kept: 4 });
    assert.equal(ledger.size, 4);
    assert.equal(ledger.byMessageId("old-other"), null);
    for (const id of ["old-irop", "old-stamped", "old-stamped-other", "recent-other"]) assert.ok(ledger.byMessageId(id), id);
    const file = lines(ledger.file);
    assert.equal(file.length, 4);
    assert.ok(file.every((l) => l.type === "verdict"));
    assert.deepEqual(file.map((l) => l.message_id), ["old-irop", "old-stamped", "old-stamped-other", "recent-other"]);
    assert.equal(file[0].ts, "2026-06-01T00:00:00.000Z", "the original ts survives");
    assert.equal(file[1].conversation_id, 41);
    assert.equal(file[1].stamped, true);
    assert.equal(file[1].stamped_at, "2026-06-01T00:00:00.000Z");
    assert.ok(!fs.existsSync(`${ledger.file}.tmp`));
    assert.equal(ledger.byConversation(41)?.message_id, "old-stamped");

    // a shorter window drops the recent other too, but never a relayed or stamped line
    // (same history on a fresh ledger: this test stays one compaction deep)
    const again = openLedger(path.join(dir, "again"), { now: () => clock, log: quiet });
    seed(again);
    assert.deepEqual(again.compact(1), { kept: 3 });
    assert.equal(again.byMessageId("recent-other"), null);
    assert.equal(again.byMessageId("old-other"), null);
    assert.ok(again.byMessageId("old-irop") && again.byMessageId("old-stamped"));
    assert.ok(again.byMessageId("old-stamped-other"), "stamped, even though never relayed by us");
    // an empty ledger compacts to an empty file
    const empty = openLedger(path.join(dir, "empty"), { now: () => clock, log: quiet });
    assert.deepEqual(empty.compact(90), { kept: 0 });
    assert.equal(fs.readFileSync(empty.file, "utf8"), "");
  }));

test("compact preserves the stamped / resolved flags — the re-bump work list survives the weekly rewrite and a restart", () =>
  withDir((dir) => {
    let clock = new Date(T0);
    const ledger = openLedger(dir, { now: () => clock, log: quiet });
    ledger.record(irop("open@x"));
    ledger.record(irop("done@x"));
    clock = new Date(T1);
    ledger.stamped("open@x", { conversationId: 41, priority: "medium" });
    ledger.stamped("done@x", { conversationId: 42, priority: "medium" });
    ledger.resolved("done@x");
    assert.deepEqual(ledger.openTickets().map((e) => e.message_id), ["open@x"]);

    clock = new Date(T2);
    ledger.compact(90);
    // The compacted file carries stamped/resolved on each line, so the flags
    // must come back both in memory (compact re-applies the kept entries) and
    // at the next boot; otherwise the daily re-bump has nothing to walk and a
    // stamped-but-not-relayed entry is dropped by the following compaction.
    assert.equal(ledger.byMessageId("open@x").stamped, true, "still stamped in memory after compaction");
    assert.equal(ledger.byMessageId("done@x").resolved, true, "still resolved in memory after compaction");
    assert.deepEqual(ledger.openTickets().map((e) => e.message_id), ["open@x"], "the re-bump list is unchanged by compaction");

    const reopened = openLedger(dir, { now: () => clock, log: quiet });
    assert.equal(reopened.byMessageId("open@x").stamped, true, "still stamped after a restart");
    assert.equal(reopened.byMessageId("done@x").resolved, true, "still resolved after a restart");
    assert.deepEqual(reopened.openTickets().map((e) => e.message_id), ["open@x"]);
  }));

test("unreadable lines are skipped with one warning; blank lines are not counted", () =>
  withDir((dir) => {
    const file = path.join(dir, "verdicts.jsonl");
    fs.writeFileSync(file, [JSON.stringify({ ts: T0, type: "verdict", ...irop("m1@x") }), "garbage {", "", "   ", '{"type":', JSON.stringify({ ts: T1, type: "stamp", message_id: "m1@x", conversation_id: 41, priority: "medium" }), JSON.stringify({ ts: T1, type: "verdict", ...other("m2@x") })].join("\n") + "\n");
    const warnings = [];
    const ledger = openLedger(dir, { log: { warn: (m) => warnings.push(m) } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^ledger: 2 unreadable line\(s\) in .*verdicts\.jsonl skipped$/);
    assert.equal(ledger.size, 2);
    assert.equal(ledger.byMessageId("m1@x").stamped, true);
    assert.equal(ledger.byMessageId("m1@x").conversation_id, 41);
    assert.equal(ledger.byMessageId("m2@x").kind, "other");
    assert.equal(openLedger(dir, { log: {} }).size, 2, "a log without warn() is fine");
    const clean = [];
    openLedger(path.join(dir, "clean"), { log: { warn: (m) => clean.push(m) } }).record(other("m@x"));
    assert.deepEqual(clean, [], "no warning without bad lines");
  }));
