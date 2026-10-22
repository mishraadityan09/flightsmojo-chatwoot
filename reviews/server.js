// FlightsMojo reviews bridge — store reviews become Chatwoot tickets, agent
// replies become the public store reply. Design and the verified store facts:
// docs/store-reviews-to-chatwoot.md in this repo.
//
//   Google Play ──┐
//   App Store ────┼─ poll (REVIEWS_POLL_MINUTES) ─► one API inbox per store
//   Google ───────┘                                   (public client API)
//   Chatwoot ── API-inbox webhook ── POST /chatwoot ─► store reply API
//
// Chatwoot's code is never modified; every store is OFF until its variables
// are set, and replies are read-only until REVIEWS_REPLY_MODE=post.

import express from "express";
import { createAppleClient } from "./apple.js";
import { createBridge } from "./bridge.js";
import { privateNotes, publicInbox, signedWith } from "./chatwoot.js";
import { createGoogleClient } from "./google.js";
import { createPlayClient } from "./play.js";

const env = process.env;
const {
  // Same rule as the bot: compose-network default; on PRODUCTION the public
  // HTTPS URL, because FORCE_SSL redirects plain-HTTP API calls.
  CHATWOOT_BASE_URL = "http://rails:3000",
  // Optional: with both set the bridge leaves a private note on the ticket
  // whenever a reply could not be posted (or replies are read-only).
  CHATWOOT_ACCOUNT_ID,
  CHATWOOT_BOT_TOKEN,
  REVIEWS_PORT = "3003",
  REVIEWS_POLL_MINUTES = "10",
  REVIEWS_BACKFILL_DAYS = "7",
  REVIEWS_REPLY_MODE = "readonly",
  REVIEWS_MAX_RATING = "5",
  REVIEWS_IMPORT_REPLIED = "false",
} = env;

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

const fromBase64 = (v) => (v ? Buffer.from(v, "base64").toString("utf8") : null);
const missing = (names) => names.filter((n) => !env[n]);

// A store is on only when every one of its variables is present.
function configureStores() {
  const stores = new Map();
  const off = [];

  const play = missing(["REVIEWS_PLAY_PACKAGE", "REVIEWS_PLAY_SERVICE_ACCOUNT_B64", "REVIEWS_PLAY_INBOX_IDENTIFIER"]);
  if (play.length === 0) {
    stores.set("play", {
      key: "play",
      label: "Google Play",
      client: createPlayClient({
        packageName: env.REVIEWS_PLAY_PACKAGE,
        serviceAccount: JSON.parse(fromBase64(env.REVIEWS_PLAY_SERVICE_ACCOUNT_B64)),
        apiBase: env.REVIEWS_PLAY_API_BASE || undefined,
      }),
      inbox: publicInbox({ baseUrl: CHATWOOT_BASE_URL, identifier: env.REVIEWS_PLAY_INBOX_IDENTIFIER }),
      webhookSecret: env.REVIEWS_PLAY_WEBHOOK_SECRET || null,
    });
  } else off.push(`play (missing ${play.join(", ")})`);

  const apple = missing(["REVIEWS_APPLE_APP_ID", "REVIEWS_APPLE_ISSUER_ID", "REVIEWS_APPLE_KEY_ID", "REVIEWS_APPLE_KEY_B64", "REVIEWS_APPLE_INBOX_IDENTIFIER"]);
  if (apple.length === 0) {
    stores.set("apple", {
      key: "apple",
      label: "App Store",
      client: createAppleClient({
        appId: env.REVIEWS_APPLE_APP_ID,
        issuerId: env.REVIEWS_APPLE_ISSUER_ID,
        keyId: env.REVIEWS_APPLE_KEY_ID,
        privateKey: fromBase64(env.REVIEWS_APPLE_KEY_B64),
        apiBase: env.REVIEWS_APPLE_API_BASE || undefined,
        replyMaxChars: env.REVIEWS_APPLE_REPLY_MAX_CHARS ? Number(env.REVIEWS_APPLE_REPLY_MAX_CHARS) : null,
      }),
      inbox: publicInbox({ baseUrl: CHATWOOT_BASE_URL, identifier: env.REVIEWS_APPLE_INBOX_IDENTIFIER }),
      webhookSecret: env.REVIEWS_APPLE_WEBHOOK_SECRET || null,
    });
  } else off.push(`apple (missing ${apple.join(", ")})`);

  const google = missing([
    "REVIEWS_GOOGLE_ACCOUNT_ID",
    "REVIEWS_GOOGLE_LOCATION_ID",
    "REVIEWS_GOOGLE_CLIENT_ID",
    "REVIEWS_GOOGLE_CLIENT_SECRET",
    "REVIEWS_GOOGLE_REFRESH_TOKEN",
    "REVIEWS_GOOGLE_INBOX_IDENTIFIER",
  ]);
  if (google.length === 0) {
    stores.set("google", {
      key: "google",
      label: "Google reviews",
      client: createGoogleClient({
        accountId: env.REVIEWS_GOOGLE_ACCOUNT_ID,
        locationId: env.REVIEWS_GOOGLE_LOCATION_ID,
        clientId: env.REVIEWS_GOOGLE_CLIENT_ID,
        clientSecret: env.REVIEWS_GOOGLE_CLIENT_SECRET,
        refreshToken: env.REVIEWS_GOOGLE_REFRESH_TOKEN,
        apiBase: env.REVIEWS_GOOGLE_API_BASE || undefined,
        tokenUrl: env.REVIEWS_GOOGLE_TOKEN_URL || undefined,
      }),
      inbox: publicInbox({ baseUrl: CHATWOOT_BASE_URL, identifier: env.REVIEWS_GOOGLE_INBOX_IDENTIFIER }),
      webhookSecret: env.REVIEWS_GOOGLE_WEBHOOK_SECRET || null,
    });
  } else off.push(`google (missing ${google.join(", ")})`);

  return { stores, off };
}

const { stores, off } = configureStores();
const bridge = createBridge({
  stores,
  replyMode: REVIEWS_REPLY_MODE,
  maxRating: Number(REVIEWS_MAX_RATING) || 5,
  backfillDays: Number(REVIEWS_BACKFILL_DAYS) || 7,
  importReplied: REVIEWS_IMPORT_REPLIED === "true",
  note: privateNotes({ baseUrl: CHATWOOT_BASE_URL, accountId: CHATWOOT_ACCOUNT_ID, token: CHATWOOT_BOT_TOKEN }),
  log,
});

// ── HTTP ──
const app = express();
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get("/health", (_req, res) => res.json({ ok: true, stores: [...stores.keys()], replyMode: REVIEWS_REPLY_MODE }));

// The API-inbox webhook of every review inbox points here. The store is read
// from the contact's source_id, then the delivery is verified with that inbox's
// secret. 401 (not a silent 200) so a wrong secret shows in Chatwoot's logs.
app.post("/chatwoot", async (req, res) => {
  const { store } = bridge.storeFor(req.body);
  if (!store) return res.status(200).json({ ok: true, reason: "ignored: not a review inbox" });
  if (store.webhookSecret && !signedWith(req, store.webhookSecret)) {
    log.warn(`[reviews] ${store.key}: rejected a webhook with a bad or missing signature`);
    return res.status(401).json({ error: "bad signature" });
  }
  const { status, reason } = await bridge.handleReply(store, req.body);
  if (status >= 400) res.statusMessage = reason.slice(0, 120); // shows up in the failed message's error text
  return res.status(status).json({ ok: status < 400, reason });
});

// ── Pollers ──
const pollMs = Math.max(1, Number(REVIEWS_POLL_MINUTES) || 10) * 60 * 1000;
for (const store of stores.values()) {
  bridge.pollStore(store);
  setInterval(() => bridge.pollStore(store), pollMs).unref();
}

app.listen(Number(REVIEWS_PORT), () => {
  log.info(`[reviews] listening on :${REVIEWS_PORT}; chatwoot ${CHATWOOT_BASE_URL}; poll every ${REVIEWS_POLL_MINUTES} min; backfill ${REVIEWS_BACKFILL_DAYS} d; max rating ${REVIEWS_MAX_RATING}`);
  log.info(`[reviews] stores on: ${[...stores.keys()].join(", ") || "none"}${off.length ? `; off: ${off.join("; ")}` : ""}`);
  for (const store of stores.values()) {
    if (REVIEWS_REPLY_MODE === "post" && !store.webhookSecret) {
      log.warn(`[reviews] ${store.key}: REVIEWS_REPLY_MODE=post but no webhook secret — replies stay read-only for this store`);
    }
  }
  if (REVIEWS_REPLY_MODE !== "post") log.info("[reviews] replies are read-only (REVIEWS_REPLY_MODE != post): agent replies are NOT sent to the stores");
  if (!CHATWOOT_BOT_TOKEN || !CHATWOOT_ACCOUNT_ID) log.info("[reviews] no CHATWOOT_BOT_TOKEN/ACCOUNT_ID: failures are logged only, no private notes on tickets");
});
