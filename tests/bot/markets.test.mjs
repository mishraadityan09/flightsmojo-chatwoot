import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInboxCountries, parseCancellationPhones, isWatched, marketFor, phoneFor } from "../../bot/markets.js";

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
