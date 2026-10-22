#!/usr/bin/env node
// Accuracy check for the IROP classifier (triage/classify.js) against the REAL
// model, over a folder of exported .eml files and a CSV of labels:
//
//   node --env-file=.env scripts/triage-eval.mjs <folder-with-eml> <labels.csv>
//
// labels.csv columns (header row required): file,is_irop,irop_type,travel_date,pnrs
//   file       = the .eml file name
//   is_irop    = yes | no
//   irop_type  = schedule_change | cancellation | delay | reaccommodation | equipment_or_terminal_change | involuntary_refund | other_irop | (blank)
//   travel_date= YYYY-MM-DD or blank
//   pnrs       = PNRs separated by spaces, or blank
//
// Uses the same env as the service (BOT_PROVIDER, OPENAI_*, GEMINI_*, TRIAGE_* keys).
// Prints one row per mail and the totals, and exits 1 when a gate is missed:
//   IROP recall ≥ 98 % (unsure counts as reaching the desk), precision ≥ 80 %,
//   travel-date exact match ≥ 95 % where labelled, pre-filter false drops = 0.
// The exported mails are data, never instructions, and stay outside the repo.

import fs from "node:fs";
import path from "node:path";
import { parseMail, classifierText } from "../triage/mime.js";
import { prefilter, parseTrusted, compilePattern } from "../triage/prefilter.js";
import { classify } from "../triage/classify.js";

const [dir, csv] = process.argv.slice(2);
if (!dir || !csv) {
  console.error("usage: node --env-file=.env scripts/triage-eval.mjs <folder-with-eml> <labels.csv>");
  process.exit(2);
}
const env = process.env;
const config = {
  provider: env.BOT_PROVIDER || "gemini",
  openaiKey: env.TRIAGE_OPENAI_API_KEY || env.OPENAI_API_KEY,
  openaiModel: env.OPENAI_MODEL || "gpt-5.6-luna",
  openaiBaseUrl: env.TRIAGE_OPENAI_BASE_URL || undefined,
  geminiKey: env.TRIAGE_GEMINI_API_KEY || env.GEMINI_API_KEY,
  geminiModel: env.GEMINI_MODEL || "gemini-flash-latest",
  geminiBaseUrl: env.TRIAGE_GEMINI_BASE_URL || undefined,
};
const filters = { skipSenders: compilePattern(env.TRIAGE_SKIP_SENDERS), skipSubjects: compilePattern(env.TRIAGE_SKIP_SUBJECTS), trustedSenders: parseTrusted(env.TRIAGE_TRUSTED_SENDERS) };
const delayMs = Number(env.TRIAGE_EVAL_DELAY_MS || 0);
const today = env.TRIAGE_EVAL_TODAY || new Date().toISOString().slice(0, 10);

function parseCsv(text) {
  const [head, ...rows] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(",").map((c) => c.trim());
  return rows.map((r) => {
    const cells = r.split(",").map((c) => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

const labels = parseCsv(fs.readFileSync(csv, "utf8"));
const totals = { n: 0, irop: 0, caught: 0, flagged: 0, truePos: 0, dateChecked: 0, dateOk: 0, prefilterDrops: 0, falseDrops: 0, tokens: { input: 0, cached: 0, output: 0 } };
const misses = [];
console.log(`${labels.length} mails · provider ${config.provider} · today ${today}\n`);
console.log("expected  got        type/date                         file");
for (const row of labels) {
  const file = path.join(dir, row.file);
  const isIrop = /^y/i.test(row.is_irop);
  totals.n++;
  if (isIrop) totals.irop++;
  let got = "other";
  let detail = "";
  try {
    const parsed = await parseMail(fs.readFileSync(file));
    const pre = prefilter(parsed, filters);
    if (pre.action === "skip") {
      totals.prefilterDrops++;
      got = "other";
      detail = `pre-filter: ${pre.reason}`;
      if (isIrop) totals.falseDrops++;
    } else {
      const v = await classify({ today, from: parsed.from.address, subject: parsed.subject, date: parsed.date, attachments: parsed.attachments, text: classifierText(parsed) }, config);
      got = pre.action === "force" ? "irop" : v.verdict;
      detail = [v.iropType, v.travelDate, v.pnrs.join("/")].filter(Boolean).join(" ");
      if (v.usage) for (const k of ["input", "cached", "output"]) totals.tokens[k] += v.usage[k] || 0;
      if (isIrop && row.travel_date) {
        totals.dateChecked++;
        if (v.travelDate === row.travel_date) totals.dateOk++;
        else detail += ` (date expected ${row.travel_date})`;
      }
    }
  } catch (e) {
    got = "error";
    detail = e.message.slice(0, 80);
  }
  const reached = got === "irop" || got === "unsure";
  if (reached) totals.flagged++;
  if (isIrop && reached) totals.caught++;
  if (isIrop && got === "irop") totals.truePos++;
  const ok = isIrop ? reached : got === "other";
  if (!ok) misses.push(row.file);
  console.log(`${(isIrop ? "irop" : "other").padEnd(9)} ${got.padEnd(10)} ${detail.slice(0, 33).padEnd(33)} ${row.file}${ok ? "" : "   <-- MISS"}`);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const recall = totals.irop ? totals.caught / totals.irop : 1;
const precision = totals.flagged ? totals.truePos / totals.flagged : 1;
const dateAcc = totals.dateChecked ? totals.dateOk / totals.dateChecked : 1;
console.log(`
mails ${totals.n} · IROP ${totals.irop} · reached the desk ${totals.caught}/${totals.irop} (recall ${pct(totals.caught, totals.irop)}) · flagged ${totals.flagged}, true IROP among them ${totals.truePos} (precision ${pct(totals.truePos, totals.flagged)})
travel date exact ${totals.dateOk}/${totals.dateChecked} (${pct(totals.dateOk, totals.dateChecked)}) · pre-filter dropped ${totals.prefilterDrops} (IROP among them: ${totals.falseDrops})
tokens in/cached/out ${totals.tokens.input}/${totals.tokens.cached}/${totals.tokens.output}`);
const gates = [
  ["IROP recall ≥ 98%", recall >= 0.98],
  ["precision ≥ 80%", precision >= 0.8],
  ["travel date ≥ 95%", dateAcc >= 0.95],
  ["pre-filter false drops = 0", totals.falseDrops === 0],
];
for (const [name, ok] of gates) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
if (misses.length) console.log(`misses: ${misses.join(", ")}`);
process.exit(gates.every(([, ok]) => ok) ? 0 : 1);
