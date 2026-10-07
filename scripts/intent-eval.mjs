#!/usr/bin/env node
// Accuracy check for the cancellation intent classifier (bot/intent.js)
// against the REAL model — run before changing the instructions or the
// provider, and before go-live:
//
//   node --env-file=.env scripts/intent-eval.mjs
//
// Uses the same env as the bot (BOT_PROVIDER, OPENAI_*, GEMINI_*). Prints one
// row per case and exits 1 when any expectation is missed, so a regression is
// impossible to overlook. Costs ~22 tiny calls.

import { classify } from "../bot/intent.js";

const {
  BOT_PROVIDER = "gemini",
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-5.6-luna",
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",
} = process.env;

const config = {
  provider: BOT_PROVIDER,
  openaiKey: OPENAI_API_KEY,
  openaiModel: OPENAI_MODEL,
  geminiKey: GEMINI_API_KEY,
  geminiModel: GEMINI_MODEL,
};

// [expected, channel, text, subject?, issueType?] — written the way real
// customers write, across every channel the checker watches.
const CASES = [
  // ── should route: the customer wants to cancel/reschedule THEIR booking ──
  ["cancellation", "Channel::WebWidget", "I want to cancel my ticket"],
  ["cancellation", "Channel::Email", "Hi team, please cancel my booking 345678 for 15 Oct, I can't travel anymore.\n\nRegards,\nRavi", "Cancellation request"],
  ["cancellation", "Channel::Whatsapp", "bhai mujhe apni flight cancel karni hai, booking id 221324"],
  ["cancellation", "Channel::Api", "need to cancel my return flight only, PNR M22W8V, keep the onward", "", "general"],
  ["cancellation", "Channel::WebWidget", "can I change my travel date to the 20th?"],
  ["cancellation", "Channel::Email", "I booked DEL-BOM for 12 Oct by mistake, please cancel it and refund me", "Wrong booking"],
  ["cancellation", "Channel::Api", "I want to cancel my booking and get the refund, booking 998877", "", "refund-request"],
  ["cancellation", "Channel::Whatsapp", "how do i cancel my booking?"],
  ["cancellation", "Channel::WebWidget", "what will it cost me to cancel booking 123456?"],
  ["cancellation", "Channel::Email", "I requested a cancellation 3 days ago (booking 556677) and nobody has confirmed it. Please process it.", "Re: cancellation"],
  ["cancellation", "Channel::Whatsapp", "reschedule my flight to next week pls"],
  // ── should NOT route ──
  ["other", "Channel::Email", "IndiGo cancelled my flight 6E-203 on 10 Oct. What are my options?", "Flight cancelled by IndiGo"],
  ["other", "Channel::WebWidget", "where is my refund? I cancelled last week"],
  ["other", "Channel::Api", "where is my refund for the cancelled booking 445566", "", "change-cancel"],
  ["other", "Channel::Email", "Payment deducted but I have not received any ticket. Booking id 778899.", "No ticket received"],
  ["other", "Channel::WebWidget", "hi"],
  ["other", "Channel::Whatsapp", "what's the baggage allowance on my flight?"],
  ["other", "Channel::Email", "Please correct the passenger name on PNR ABC123 — it should be Priya not Pirya.", "Name correction"],
  ["other", "Channel::Api", "The airline changed my departure time from 6am to 9pm, I can't make it, can I get a refund?", "", "general"],
  ["other", "Channel::WebWidget", "talk to an agent"],
  ["other", "Channel::Email", "Out of office: I am away until 20 Oct and will reply when I return.", "Automatic reply: Your booking"],
  ["other", "Channel::Whatsapp", "my flight got cancelled by the airline, refund please"],
];

// Free-tier Gemini keys allow only a few requests a minute: pace the calls
// (INTENT_EVAL_DELAY_MS between cases) and wait out 429/503 before retrying.
const DELAY_MS = Number(process.env.INTENT_EVAL_DELAY_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classifyWithRetry(input) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await classify(input, config);
    } catch (e) {
      if (attempt >= 4 || !/ (429|503)[:\s]/.test(e.message)) throw e;
      process.stderr.write(`  rate-limited/overloaded (attempt ${attempt}), waiting 20 s…\n`);
      await sleep(20_000);
    }
  }
}

let missed = 0;
const rows = [];
for (const [expected, channel, text, subject = "", issueType = ""] of CASES) {
  let got;
  try {
    got = await classifyWithRetry({ channel, subject, issueType, text: text.slice(0, 2000) });
  } catch (e) {
    got = { intent: `ERROR ${e.message.replace(/\s+/g, " ").slice(0, 60)}`, summary: "" };
  }
  if (DELAY_MS) await sleep(DELAY_MS);
  const ok = got.intent === expected;
  if (!ok) missed++;
  rows.push({
    ok: ok ? "✓" : "✗",
    expected,
    got: got.intent,
    channel: channel.replace("Channel::", ""),
    text: text.replace(/\s+/g, " ").slice(0, 60),
    summary: got.summary.slice(0, 70),
  });
}

console.table(rows);
console.log(`${CASES.length - missed}/${CASES.length} correct — provider ${config.provider} (${config.provider === "openai" ? OPENAI_MODEL : GEMINI_MODEL})`);
process.exit(missed ? 1 : 0);
