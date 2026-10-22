import { test } from "node:test";
import assert from "node:assert/strict";
import { createStamper } from "../../triage/stamp.js";
import { fakeApi, quiet } from "./helpers.mjs";

const decision = { kind: "irop", relay: true, label: "irop", priority: "high", attributes: { irop_type: "schedule_change", travel_date: "2026-10-24", pnr: "ABC123" }, digest: false, note: "🛬 IROP — schedule change\nAir India · PNR ABC123 · travel 2026-10-24 · priority high" };
const paths = (api) => api.calls.map((c) => `${c[0]} ${c[1]}`);

test("conversation() maps status, priority, meta.team.id and meta.assignee.id from the live ticket", async () => {
  const api = fakeApi({ gets: { "/conversations/41": { id: 41, status: "open", priority: "medium", meta: { team: { id: 5, name: "IROP desk" }, assignee: { id: 9, name: "Agent" } }, custom_attributes: { pnr: "ABC123" } } } });
  const live = await createStamper({ api, log: quiet }).conversation(41);
  assert.deepEqual(live, { id: 41, status: "open", priority: "medium", teamId: 5, assigneeId: 9, customAttributes: { pnr: "ABC123" } });
  assert.deepEqual(api.calls, [["GET", "/conversations/41"]]);
});

test("conversation() tolerates a sparse payload and escapes the id", async () => {
  const api = fakeApi({ gets: { "/conversations/42": { id: 42, meta: { team: null, assignee: null } }, "/conversations/a%2Fb": { id: "a/b", priority: "urgent" } } });
  const stamper = createStamper({ api, log: quiet });
  assert.deepEqual(await stamper.conversation(42), { id: 42, status: null, priority: null, teamId: null, assigneeId: null, customAttributes: {} });
  assert.deepEqual(await stamper.conversation("a/b"), { id: "a/b", status: null, priority: "urgent", teamId: null, assigneeId: null, customAttributes: {} });
  assert.equal(api.calls[1][1], "/conversations/a%2Fb");
  const empty = fakeApi({ gets: { "/conversations/7": () => null } });
  assert.deepEqual(await createStamper({ api: empty, log: quiet }).conversation(7), { id: undefined, status: null, priority: null, teamId: null, assigneeId: null, customAttributes: {} });
});

test("stamp(): attributes (merge), label union, priority, team, private note — in that order", async () => {
  const api = fakeApi({ gets: { "/conversations/41/labels": { payload: ["billing"] } } });
  const result = await createStamper({ api, teamId: "5", log: quiet }).stamp(41, decision, { live: { priority: "low", teamId: null, assigneeId: null } });
  assert.deepEqual(result, { ok: true, failures: [] });
  assert.deepEqual(api.calls, [
    ["POST", "/conversations/41/custom_attributes", { custom_attributes: decision.attributes, merge: true }],
    ["GET", "/conversations/41/labels"],
    ["POST", "/conversations/41/labels", { labels: ["billing", "irop"] }],
    ["POST", "/conversations/41/toggle_priority", { priority: "high" }],
    ["POST", "/conversations/41/assignments", { team_id: 5 }],
    ["POST", "/conversations/41/messages", { content: decision.note, message_type: "outgoing", private: true }],
  ]);
});

test("stamp(): the label is a union — no POST when already present; a missing payload counts as no labels", async () => {
  const present = fakeApi({ gets: { "/conversations/41/labels": { payload: ["irop", "billing"] } } });
  const result = await createStamper({ present, api: present, log: quiet }).stamp(41, { ...decision, attributes: {}, priority: null, note: "" }, { live: {} });
  assert.deepEqual(result, { ok: true, failures: [] });
  assert.deepEqual(present.calls, [["GET", "/conversations/41/labels"]]);

  const none = fakeApi({ gets: { "/conversations/41/labels": {} } });
  await createStamper({ api: none, log: quiet }).stamp(41, { label: "irop-unsure" }, { live: {} });
  assert.deepEqual(none.calls, [
    ["GET", "/conversations/41/labels"],
    ["POST", "/conversations/41/labels", { labels: ["irop-unsure"] }],
  ]);
  const nothing = fakeApi();
  await createStamper({ api: nothing, log: quiet }).stamp(41, { label: null, attributes: {}, priority: null, note: "" }, { live: {} });
  assert.deepEqual(nothing.calls, [], "a decision with nothing to stamp makes no call");
});

test("stamp(): empty attributes → no custom_attributes POST; no note → no message", async () => {
  const api = fakeApi({ gets: { "/conversations/41/labels": { payload: [] } } });
  await createStamper({ api, log: quiet }).stamp(41, { label: "irop", attributes: {}, priority: null, note: null }, { live: {} });
  assert.deepEqual(paths(api), ["GET /conversations/41/labels", "POST /conversations/41/labels"]);
  const api2 = fakeApi();
  await createStamper({ api: api2, log: quiet }).stamp(41, { attributes: { pnr: "ABC123" } }, { live: {} });
  assert.deepEqual(api2.calls, [["POST", "/conversations/41/custom_attributes", { custom_attributes: { pnr: "ABC123" }, merge: true }]]);
});

test("stamp(): priority is posted only when higher than the live one", async () => {
  const run = async (livePriority, wanted = "high") => {
    const api = fakeApi();
    await createStamper({ api, log: quiet }).stamp(41, { priority: wanted }, livePriority === "no-live" ? {} : { live: { priority: livePriority } });
    return paths(api);
  };
  assert.deepEqual(await run("urgent"), [], "never lowered");
  assert.deepEqual(await run("high"), [], "equal is not higher");
  assert.deepEqual(await run("medium"), ["POST /conversations/41/toggle_priority"]);
  assert.deepEqual(await run("low"), ["POST /conversations/41/toggle_priority"]);
  assert.deepEqual(await run(null), ["POST /conversations/41/toggle_priority"], "no priority yet");
  assert.deepEqual(await run("no-live"), ["POST /conversations/41/toggle_priority"], "no live snapshot at all");
  assert.deepEqual(await run("urgent", "low"), []);
  assert.deepEqual(await run(null, null), [], "no wanted priority → nothing");
});

test("stamp(): the team is set whenever the live ticket has no team; an assignee alone does not block it", async () => {
  const run = async (live, teamId = 5) => {
    const api = fakeApi();
    await createStamper({ api, teamId, log: quiet }).stamp(41, { note: "" }, { live });
    return api.calls;
  };
  assert.deepEqual(await run({ teamId: null, assigneeId: null }), [["POST", "/conversations/41/assignments", { team_id: 5 }]]);
  assert.deepEqual(await run({ teamId: null, assigneeId: 9 }), [["POST", "/conversations/41/assignments", { team_id: 5 }]], "a reopened chain with an agent but no team still gets the desk's team");
  assert.deepEqual(await run({ teamId: 3, assigneeId: null }), [], "a ticket with a team keeps it");
  assert.deepEqual(await run({ teamId: 3, assigneeId: 9 }), []);
  assert.deepEqual(await run({ teamId: 5 }), [], "even when it is our own team");
  assert.deepEqual(await run(null), [["POST", "/conversations/41/assignments", { team_id: 5 }]], "no live snapshot → set");
  assert.deepEqual(await run({ teamId: null }, "7"), [["POST", "/conversations/41/assignments", { team_id: 7 }]], "TRIAGE_TEAM_ID comes from env as a string");
  assert.deepEqual(await run({ teamId: null }, null), [], "no team configured → never assigned");
  assert.deepEqual(await run({ teamId: null }, ""), []);
});

test("stamp(): a failing step is reported in failures and the other steps still run", async () => {
  const warnings = [];
  const api = fakeApi({ gets: { "/conversations/41/labels": () => { throw new Error("HTTP 500 from http://rails:3000/api/v1/accounts/1/conversations/41/labels"); } } });
  const result = await createStamper({ api, teamId: 5, log: { warn: (m) => warnings.push(m) } }).stamp(41, decision, { live: { priority: "low" } });
  assert.deepEqual(result, { ok: false, failures: ["label: HTTP 500 from http://rails:3000/api/v1/accounts/1/conversations/41/labels"] });
  assert.deepEqual(paths(api), ["POST /conversations/41/custom_attributes", "GET /conversations/41/labels", "POST /conversations/41/toggle_priority", "POST /conversations/41/assignments", "POST /conversations/41/messages"]);
  assert.deepEqual(warnings, ["[conv 41] label failed: HTTP 500 from http://rails:3000/api/v1/accounts/1/conversations/41/labels"]);

  const api2 = fakeApi({ gets: { "/conversations/41/labels": { payload: [] } }, failOn: /POST \/conversations\/41\/(custom_attributes|messages)$/ });
  const result2 = await createStamper({ api: api2, teamId: 5, log: quiet }).stamp(41, decision, { live: { priority: "low" } });
  assert.deepEqual(result2, { ok: false, failures: ["attributes: boom", "note: boom"] });
  assert.deepEqual(paths(api2), ["POST /conversations/41/custom_attributes", "GET /conversations/41/labels", "POST /conversations/41/labels", "POST /conversations/41/toggle_priority", "POST /conversations/41/assignments", "POST /conversations/41/messages"]);

  const api3 = fakeApi({ failOn: /./ });
  const result3 = await createStamper({ api: api3, teamId: 5, log: {} }).stamp(41, decision, { live: {} });
  assert.equal(result3.ok, false);
  assert.deepEqual(result3.failures.map((f) => f.split(":")[0]), ["attributes", "label", "priority", "team", "note"], "every step fails, nothing throws, a log without warn() is fine");
});

test("setPriority posts toggle_priority for the daily re-bump", async () => {
  const api = fakeApi();
  await createStamper({ api, log: quiet }).setPriority(41, "urgent");
  await createStamper({ api, log: quiet }).setPriority("a/b", "high");
  assert.deepEqual(api.calls, [
    ["POST", "/conversations/41/toggle_priority", { priority: "urgent" }],
    ["POST", "/conversations/a%2Fb/toggle_priority", { priority: "high" }],
  ]);
  const down = fakeApi({ failOn: /toggle_priority/ });
  await assert.rejects(createStamper({ api: down, log: quiet }).setPriority(41, "urgent"), /boom/, "setPriority is not best-effort: the caller logs it");
});
