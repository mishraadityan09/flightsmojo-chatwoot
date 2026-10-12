import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseInboxCountries,
  parseCancellationPhones,
  parseDeskHours,
  isWatched,
  marketFor,
  phoneFor,
  deskOpen,
  daysUntil,
  localClock,
} from "../../bot/markets.js";

test("parseInboxCountries keeps valid entries, uppercases, drops junk", () => {
  const map = parseInboxCountries('{"1":"in","2":"AE","9":"*","13":"apac","x":"US","4":"united kingdom","5":""}');
  assert.deepEqual(map, { 1: "IN", 2: "AE", 9: "*", 13: "APAC" });
});

test("parseInboxCountries is empty (feature off) on bad input", () => {
  assert.deepEqual(parseInboxCountries(undefined), {});
  assert.deepEqual(parseInboxCountries(""), {});
  assert.deepEqual(parseInboxCountries("not json"), {});
  assert.deepEqual(parseInboxCountries("[1,2]"), {});
  assert.deepEqual(parseInboxCountries("null"), {});
});

const MAP = parseInboxCountries('{"1":"IN","3":"US","9":"*","13":"APAC"}');

test("isWatched: only listed inboxes", () => {
  assert.equal(isWatched({ inbox_id: 1 }, MAP), true);
  assert.equal(isWatched({ inbox_id: "9" }, MAP), true);
  assert.equal(isWatched({ inbox_id: 17 }, MAP), false);
  assert.equal(isWatched({}, MAP), false);
  assert.equal(isWatched(undefined, MAP), false);
});

test("marketFor: mapped inbox → its code; unlisted → null", () => {
  assert.equal(marketFor({ inbox_id: 1 }, MAP), "IN");
  assert.equal(marketFor({ inbox_id: 3 }, MAP), "US");
  assert.equal(marketFor({ inbox_id: 13 }, MAP), "APAC");
  assert.equal(marketFor({ inbox_id: 17 }, MAP), null);
});

test("marketFor: '*' inbox reads the ticket's country attribute, shape-checked", () => {
  assert.equal(marketFor({ inbox_id: 9, custom_attributes: { country: "uk" } }, MAP), "UK");
  assert.equal(marketFor({ inbox_id: 9, custom_attributes: { country: " ca " } }, MAP), "CA");
  assert.equal(marketFor({ inbox_id: 9, custom_attributes: { country: "call +91 99" } }, MAP), null);
  assert.equal(marketFor({ inbox_id: 9, custom_attributes: {} }, MAP), null);
  assert.equal(marketFor({ inbox_id: 9 }, MAP), null);
});

test("parseCancellationPhones: the per-market switch keeps only well-formed entries", () => {
  const phones = parseCancellationPhones(
    '{"in":" 00911246932002 ","US":"+1 202-839-9858","AE":"","UK":"call me","x":"+44 20 4578 5985","ID":123,"PH":"(02) 5323 5784"}',
  );
  assert.deepEqual(phones, { IN: "00911246932002", US: "+1 202-839-9858", PH: "(02) 5323 5784" });
});

test("parseCancellationPhones: bad input means every market is off", () => {
  assert.deepEqual(parseCancellationPhones(undefined), {});
  assert.deepEqual(parseCancellationPhones(""), {});
  assert.deepEqual(parseCancellationPhones("not json"), {});
  assert.deepEqual(parseCancellationPhones('["IN"]'), {});
  assert.deepEqual(parseCancellationPhones("null"), {});
});

const PHONES = parseCancellationPhones('{"IN":"00911246932002"}');

test("phoneFor: a number only for markets that are switched on", () => {
  assert.equal(phoneFor("IN", PHONES), "00911246932002");
  assert.equal(phoneFor("US", PHONES), null);
  assert.equal(phoneFor("APAC", PHONES), null);
  assert.equal(phoneFor(null, PHONES), null);
  assert.equal(phoneFor("IN", {}), null);
  assert.equal(phoneFor("IN", undefined), null);
  assert.equal(phoneFor("constructor", PHONES), null);
});

test("parseDeskHours: well-formed entries with a real zone only", () => {
  const hours = parseDeskHours('{"in":"09:00-21:00 Asia/Kolkata","US":"9-17 America/New_York","UK":"09:00-17:00 Mars/Olympus","AE":"25:00-21:00 Asia/Dubai","PH":"21:00-09:00 Asia/Manila"}');
  assert.deepEqual(hours, {
    IN: { from: 540, to: 1260, tz: "Asia/Kolkata" },
    PH: { from: 1260, to: 540, tz: "Asia/Manila" },
  });
  assert.deepEqual(parseDeskHours(undefined), {});
  assert.deepEqual(parseDeskHours("nope"), {});
});

const HOURS = parseDeskHours('{"IN":"09:00-21:00 Asia/Kolkata","PH":"21:00-09:00 Asia/Manila"}');

test("localClock: wall clock in the market's zone", () => {
  // 16:30 UTC = 22:00 IST (same day); 20:00 UTC = 01:30 IST next day
  assert.deepEqual(localClock("Asia/Kolkata", new Date("2026-10-12T16:30:00Z")), { date: "2026-10-12", minutes: 22 * 60 });
  assert.deepEqual(localClock("Asia/Kolkata", new Date("2026-10-12T20:00:00Z")), { date: "2026-10-13", minutes: 90 });
  assert.deepEqual(localClock("UTC", new Date("2026-10-12T00:00:00Z")), { date: "2026-10-12", minutes: 0 });
});

test("deskOpen: inside the window, outside it, windows across midnight, no rule", () => {
  assert.equal(deskOpen("IN", HOURS, new Date("2026-10-12T04:00:00Z")), true); // 09:30 IST
  assert.equal(deskOpen("IN", HOURS, new Date("2026-10-12T03:00:00Z")), false); // 08:30 IST
  assert.equal(deskOpen("IN", HOURS, new Date("2026-10-12T15:30:00Z")), false); // 21:00 IST — closes at 21:00 sharp
  assert.equal(deskOpen("IN", HOURS, new Date("2026-10-12T15:29:00Z")), true); // 20:59 IST
  assert.equal(deskOpen("PH", HOURS, new Date("2026-10-12T14:00:00Z")), true); // 22:00 Manila, night window
  assert.equal(deskOpen("PH", HOURS, new Date("2026-10-12T02:00:00Z")), false); // 10:00 Manila
  assert.equal(deskOpen("US", HOURS, new Date("2026-10-12T02:00:00Z")), true); // no rule → always
  assert.equal(deskOpen(null, HOURS), true);
});

test("daysUntil: counted from today in the market's zone", () => {
  const now = new Date("2026-10-12T20:00:00Z"); // already 13 Oct in India, still 12 Oct in UTC
  assert.equal(daysUntil("2026-10-13", "Asia/Kolkata", now), 0);
  assert.equal(daysUntil("2026-10-14", "Asia/Kolkata", now), 1);
  assert.equal(daysUntil("2026-10-14", "UTC", now), 2);
  assert.equal(daysUntil("2026-10-12", "Asia/Kolkata", now), -1);
  assert.equal(daysUntil("tomorrow", "Asia/Kolkata", now), null);
  assert.equal(daysUntil(null, "Asia/Kolkata", now), null);
});
