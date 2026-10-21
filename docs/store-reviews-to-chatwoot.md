# Store reviews → Chatwoot tickets (implementation spec)

*Researched 21 Oct 2026 against the fork at `feat/fm-ui-upgrade` (Chatwoot 4.18) and the
official Google / Apple docs fetched the same day. Nothing below is assumed: every
Chatwoot statement was read in the code, every store statement carries its doc URL.
"NV" = not verified on any page fetched; treat as a thing to test, not a fact.*

Goal: a Google Play review, an App Store review and a Google (Business Profile) review
each become a ticket in Chatwoot; the agent's reply in Chatwoot becomes the public
store reply. Nothing in the fork changes — this is a new hub service plus dashboard
configuration.

---

## 1. Shape of the solution

```
Play Developer API ──┐                      ┌─► POST /public/api/v1/inboxes/{id}/contacts
App Store Connect ───┼─ poll ─► reviews ────┼─► POST …/contacts/{source_id}/conversations
Business Profile ────┘   (hub service)      └─► POST …/conversations/{id}/messages
                                                          (one API inbox per store)
Chatwoot ── API-inbox webhook (message_created, outgoing, not private) ──► reviews service
                                                          └─► store "reply" API
```

- **One API-channel inbox per store** (`Play Store reviews`, `App Store reviews`,
  `Google reviews`). Separate inboxes give per-store numbers in Reports → Agents
  (Channel dropdown, FM-26), per-store routing rules, and a clean "is this a review"
  test in the bridge (`conversation.inbox_id`).
- **One contact and one conversation per review.** Stores give no stable reviewer
  identity (Play: display name only; Apple: nickname; Google: display name), so the
  review id is the identity. `source_id` = `identifier` = `play:<reviewId>` /
  `apple:<reviewId>` / `google:<reviewId>`.
- **Edited review = new message on the same ticket**, never a new ticket.
- **Reply = first non-private outgoing message.** Later outgoing messages *update*
  the public reply (every store allows exactly one reply per review). Private notes
  never leave Chatwoot.

## 2. Chatwoot side — verified in code

### 2.1 Creating the ticket: public client API (no token needed)

Controllers: `app/controllers/public/api/v1/inboxes/{contacts,conversations,messages}_controller.rb`.
Auth is only the inbox identifier in the URL (Settings → Inboxes → *inbox* →
Configuration shows it). Base URL for the service: `${CHATWOOT_BASE_URL}/public/api/v1/inboxes/{inbox_identifier}`.

| Step | Call | Permitted body | Behaviour (code) |
|---|---|---|---|
| 1 | `POST …/contacts` | `source_id`, `identifier`, `name`, `email`, `phone_number`, `avatar_url`, `custom_attributes{}` | `ContactInboxWithContactBuilder`: returns the existing contact-inbox when `source_id` already exists (idempotent); else finds the contact by `identifier` → `email` → `phone`, else creates it. Blank `name` → random "haiku" name. `avatar_url` is fetched async. |
| 2 | `POST …/contacts/{source_id}/conversations` | **`custom_attributes{}` only** | `ConversationBuilder`: if the inbox has **Lock to single conversation** ON, returns the contact-inbox's last conversation instead of creating one (`look_up_exising_conversation`). Status `open` (no bot on the inbox). No `additional_attributes`, `status`, `team`, `assignee`, labels through this API. |
| 3 | `POST …/contacts/{source_id}/conversations/{id}/messages` | `content`, `echo_id`, `attachments[]` | Always `message_type: incoming`, `sender` = the contact. `content` ≤ 150 000 chars (`Message` validation). |
| read | `GET …/contacts/{source_id}/conversations` | — | Array of `{id (display_id), uuid, inbox_id, status, messages[{id, content, message_type, content_type, created_at (unix), sender}], contact}` — enough to see what was already posted. |
| read | `GET …/contacts/{source_id}` | — | `{id, name, email, phone_number, source_id, pubsub_token}` — **no custom_attributes** in the public JSON. |

Consequences:
- Turn **Lock to single conversation ON** for the three review inboxes (Settings →
  Inboxes → Settings tab). With one contact per review, step 2 then returns the
  review's ticket every time, so the service never needs a review→ticket map.
- Dedupe of edits without local state: render the review to its message text
  (deterministic, §6), `GET …/conversations`, compare with the newest **incoming**
  message's `content`; post only when they differ (first time: no message yet). This
  works for all three stores, including Apple which has no modified date. An
  in-memory cache of `reviewId → rendered-text hash` skips the GET for unchanged
  reviews; losing it on restart only costs one round of GETs. No volume, no database.
- The public API has **no throttle of its own**; only the global
  `RACK_ATTACK_LIMIT` (3000 req/min/IP) applies (`config/initializers/rack_attack.rb`).
- `email_continuity_on_api_channel` is irrelevant: review contacts have no email, and
  `Messages::SendEmailNotificationService` returns early when `contact.email` is blank.

### 2.2 Labels, team, priority: dashboard automation, not the API

Labels cannot be set through the public API; the agent-bot token can
(`BOT_ACCESSIBLE_ENDPOINTS` allows `conversations/labels#create`), but a dashboard
rule is the convention here. `ActionService` offers `add_label`, `assign_team`,
`assign_agent`, `change_priority`, `send_message`, `add_private_note`,
`send_email_to_team`, `send_webhook_event`. Conditions support `inbox_id` and
**conversation custom attributes** (`AutomationRules::ConditionsFilterService`).

Rules to create (Settings → Automation):
1. *Conversation created* + Inbox = each review inbox → add label `review`, `play-store` /
   `app-store` / `google`; assign team (decide which).
2. *Conversation created* + Inbox ∈ review inboxes + custom attribute `review_rating`
   ≤ 2 → priority Urgent (or label `low-rating`).

### 2.3 Attributes that show in the sidebar

`CustomAttributes.vue` renders **only keys that have a definition** in
Settings → Custom Attributes (`attributes/getAttributesByModel`); undefined keys are
stored but invisible. Definitions to create (`attribute_key` must match
`[\p{L}\p{N}_.-]+`):

| Model | key | type | value |
|---|---|---|---|
| Conversation | `review_store` | list (`play`, `apple`, `google`) | store |
| Conversation | `review_rating` | number | 1–5 |
| Conversation | `review_id` | text | store review id |
| Conversation | `review_updated_at` | date | last edit time from the store |
| Conversation | `review_link` | link | console/listing URL when one exists (see §3–5) |
| Contact | `review_app_version` | text | Play `appVersionName`, Apple n/a |
| Contact | `review_locale` | text | Play `reviewerLanguage`, Apple `territory` |
| Contact | `review_device` | text | Play `device`/`deviceMetadata.productName` |

Conversation attributes are set in step 2 (`custom_attributes` on create). Contact
attributes are set in step 1 (`custom_attributes`) and can be refreshed with
`PATCH …/contacts/{source_id}` (`ContactIdentifyAction`).

### 2.4 Replies back to the store: API-inbox webhook

`Channel::Api` has `webhook_url` (editable in the inbox settings; the dashboard URL
validator rejects a bare host, so use a dotted compose alias like
`http://reviews.flightsmojo.internal:3003/chatwoot`) and `secret` (shown to admins in
the inbox Settings page as *Webhook secret*, copy/reset buttons).

What arrives (`WebhookListener#deliver_api_inbox_webhooks`):
- Events: `conversation_created`, `conversation_updated`, `conversation_status_changed`,
  `message_created`, `message_updated`, `conversation_typing_on/off`.
- `message_created` fires for **incoming, outgoing and template** messages
  (`webhook_sendable?` = `incoming? || outgoing? || template?`) — **private notes are
  included** with `private: true`. The bridge must act only on
  `event == "message_created" && message_type == "outgoing" && private == false && sender.type == "user"`.
- Payload (`Message#webhook_data`): `id`, `content` (raw text, no markdown rendering),
  `message_type`, `private`, `content_attributes`, `sender {id, name, email, type:"user"}`,
  `inbox {id, name}`, `conversation` (= `Conversations::EventDataPresenter#push_data` +
  `messages`): `id` (display id), `inbox_id`, `status`, `custom_attributes`,
  `additional_attributes`, `contact_inbox {source_id, …}`, `meta.sender`. So the bridge
  reads the store and review id straight from `conversation.contact_inbox.source_id`.
- Headers (`Webhooks::Trigger#request_headers`): `X-Chatwoot-Delivery` (uuid),
  `X-Chatwoot-Timestamp` (unix s), `X-Chatwoot-Signature: sha256=HMAC_SHA256(secret, "{ts}.{raw body}")`.
  Identical scheme to the agent-bot webhook the bot already verifies
  (`signedWith()` in `bot/server.js`) — reuse that function.
- Delivery: `WebhookJob` (Sidekiq `medium`) → `SafeFetch` POST, timeout
  `WEBHOOK_TIMEOUT` (default **5 s**), `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` is already
  in `.env` (needed for any compose-network URL).
- **Failure semantics:** a non-2xx or timeout raises `SafeFetch::HttpError`
  (`"<code> <reason phrase>"`); for an API inbox and a `message_created` /
  `message_updated` event the trigger then calls
  `Messages::StatusUpdateService(message, 'failed', error.message)`, so the agent sees
  the reply marked **failed** with that text. **No retry** for API-inbox webhooks (only
  agent-bot 429/500 are retried). ⇒ The bridge should call the store reply API
  synchronously, answer 2xx within ~4 s on success, and answer 4xx/5xx on failure.
  For a readable reason, also post a private note with the store's error using the
  existing `CHATWOOT_BOT_TOKEN` (`conversations/messages#create` with `private: true`
  is bot-accessible; `ConversationPolicy#show?` is true for any AgentBot).
- Status changes from the agent (resolve, reopen) also arrive
  (`conversation_status_changed`) — ignore.

### 2.5 Reporting and the rest of the fork

- Each store is its own inbox → Channel dropdown on Reports → Agents (FM-26) shows
  per-store handling; first-response time starts at conversation creation (no bot
  handoff on these inboxes); auto-resolve, FM-27 and the Booking ID rule behave as for
  any other inbox. If the Booking ID attribute is required before resolving (FM-23),
  review tickets will need an exemption or a dummy value — decide before go-live.
- The hub bot is per-inbox (agent bot assignment); it is **not** attached to the review
  inboxes, so nothing in `bot/` runs for them.

## 3. Google Play — Google Play Developer API v3 (verified)

Sources: reply-to-reviews guide <https://developers.google.com/android-publisher/reply-to-reviews>,
reference <https://developers.google.com/android-publisher/api-ref/rest/v3/reviews>,
getting started <https://developers.google.com/android-publisher/getting_started>,
quotas <https://developers.google.com/android-publisher/quotas>,
Console help 138230 / 9844686 / 3433208 (support.google.com/googleplay/android-developer).

| Item | Fact |
|---|---|
| List | `GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/reviews` — query `maxResults` (default 10, up to 100), `token` (page token), `startIndex`, `translationLanguage`. Response `{reviews[], tokenPagination{nextPageToken}, pageInfo}`. Newest created/modified first. |
| Get | `GET …/reviews/{reviewId}` |
| Reply | `POST …/reviews/{reviewId}:reply` body `{"replyText": "…"}` → `{"result": {"replyText", "lastEdited"}}`. "Replies to a single review, **or updates an existing reply**" — re-POST = edit. 400 when text too long/missing, 404 unknown review. |
| Window | "You can retrieve only the reviews that users have created or modified within the **last week**." Older history only via the Console CSV export. |
| Text only | "the API shows only the reviews that **include comments**" — star-only ratings never appear. Production track only. |
| Review fields | `reviewId`, `authorName` (may be absent), `comments[]` = `userComment` then (if replied) `developerComment`. `userComment`: `text` (**title and body concatenated, separated by a tab**), `lastModified{seconds,nanos}`, `starRating` 1–5, `reviewerLanguage`, `device`, `androidOsVersion`, `appVersionCode`, `appVersionName`, `thumbsUpCount`, `thumbsDownCount`, `originalText` (when translated), `deviceMetadata{productName, manufacturer, deviceClass, screenWidthPx, screenHeightPx, nativePlatform, screenDensityDpi, glEsVersion, cpuModel, cpuMake, ramMb}`. `developerComment`: `text`, `lastModified`. |
| Reply limit | **350 characters**, plain text (HTML tags stripped). One public reply per review, editable any time. First reply notifies the user (push + email); edits don't, unless the user edited the review in between. Google "discourage[s] the use of automated replies". Delete via API: NV (no method in the reference). |
| Auth | Scope `https://www.googleapis.com/auth/androidpublisher`. Service account: Cloud project → enable *Google Play Developer API* → create service account; Play Console → **Users and permissions → Invite new users** → the service-account email → permission **"Reply to reviews"** (account- or app-level). Token: standard service-account JWT bearer flow (`https://oauth2.googleapis.com/token`, RS256, exp ≤ 1 h), no human OAuth. Linking the developer account to a Cloud project is no longer required. |
| Quota | Reply-to-reviews guide: **200 GET per hour per app, 2000 POST per day**; quotas page: 3000 queries/min for the bucket. ⇒ poll every 5–10 min is far inside the limit. |
| Push | None. Only Play Console email alerts (Setup → Notifications → "Reviews: your app receives a new review", "Updated reviews"). Polling is the only API mechanism. |
| Deprecation | Nothing about reviews on the deprecated-APIs page (May 2026). Reference host is `androidpublisher.googleapis.com`; the guide still shows the old `www.googleapis.com` host — both documented, neither marked deprecated. |
| Link | No public per-review URL documented (NV). The ticket links to the app's Play listing; the Console review page is for agents with Console access only. |

Ticket mapping (Play): split `text` on the first tab → title / body; rating from
`starRating`; `review_updated_at` from `lastModified.seconds`; contact name =
`authorName`; app version / device / language into contact attributes. Reply text:
the agent's message truncated **at 350 chars is a hard reject** — the bridge should
refuse (fail the message) rather than silently cut.

## 4. Apple App Store — App Store Connect API (verified)

Sources (base `https://developer.apple.com/documentation/appstoreconnectapi/`):
`customer-reviews`, `get-v1-apps-_id_-customerreviews`, `customerreview/attributes-data.dictionary`,
`customer-review-responses`, `post-v1-customerreviewresponses`, `delete-v1-customerreviewresponses-_id_`,
`generating-tokens-for-api-requests`, `creating-api-keys-for-app-store-connect-api`,
`identifying-rate-limits`, `webhookeventtype`; Help: `help/app-store-connect/monitor-ratings-and-reviews/respond-to-reviews`,
`…/ratings-and-reviews-overview`, `help/account/access/roles`.

| Item | Fact |
|---|---|
| List | `GET https://api.appstoreconnect.apple.com/v1/apps/{appId}/customerReviews` — `sort` one of `createdDate`, `-createdDate`, `rating`, `-rating`; `limit` ≤ **200**; `filter[rating]` (e.g. `1,2`), `filter[territory]` (ISO-3166 alpha-3), `exists[publishedResponse]` true/false; `include=response`; `fields[customerReviews]`. Pagination: `links.next` (cursor), `meta.paging.total`. **No time window** — the whole history is listable (first run needs a cutoff, §6). |
| One review / its response | `GET /v1/customerReviews/{id}`, `GET /v1/customerReviews/{id}/response` |
| Reply | `POST /v1/customerReviewResponses` → 201. Body (all fields required): `{"data":{"type":"customerReviewResponses","attributes":{"responseBody":"…"},"relationships":{"review":{"data":{"type":"customerReviews","id":"<reviewId>"}}}}}`. "If a response already exists, this endpoint **updates the response by overwriting it**." `DELETE /v1/customerReviewResponses/{responseId}` → 204. `Content-Type: application/json` required (415 otherwise). |
| Review fields | `id`, `attributes{rating 1–5, title, body, reviewerNickname, createdDate, territory}`, relationships `response`, `reviewTerritory`. **No modified date** — Help says an edited review shows "the most recent change"; whether `createdDate` moves is NV ⇒ detect edits by content, not by time (§2.1). Rating-only entries: NV (tvOS users "can only rate"; nothing says they are listed) ⇒ treat `body`/`title` as optional. |
| Response fields | `responseBody`, `lastModifiedDate`, `state` ∈ `PENDING_PUBLISH`, `PUBLISHED`. |
| Reply rules | At most **one response per review**; re-POST overwrites (shown as "edited" on the store). Responses "may take up to 24 hours to appear", pending until then. The customer is notified and can edit their review in reply; the response stays visible even if they edit. **Character limit: NV** — no `maxLength` in the schema and none in Help ⇒ measure in the preview test (the 5970 figure seen elsewhere is not on an Apple page). |
| Auth | JWT, `alg` ES256, header `kid` = Key ID, `typ` JWT; payload `iss` = Issuer ID (team key) or `sub: "user"` (individual key), `iat`, `exp` ≤ **20 min** ahead, `aud: "appstoreconnect-v1"`; `Authorization: Bearer <jwt>`; reuse until expiry. Key file is the `.p8`, downloadable once. |
| Role | "Respond to customer reviews" = Account Holder, Admin or **Customer Support** only (viewing: also App Manager, Developer, Marketing). Team keys are generated by an Admin and carry chosen roles; individual keys carry the user's own roles and each user may hold one. Whether *Customer Support* is offered in the team-key role picker is NV ⇒ ask the Admin to try a team key with Customer Support first, else create a dedicated Customer Support user and an individual key. `ACCESS_TO_REPORTS` is unrelated (and deprecated). |
| Rate limit | `X-Rate-Limit: user-hour-lim:3500;user-hour-rem:…` per key, rolling hour; 429 `RATE_LIMIT_EXCEEDED`, no `Retry-After` documented. One list page per poll is negligible. |
| Push | App Store Connect webhooks (API 4.0, 2025) have 12 event types, **none for customer reviews** ⇒ poll. |
| Deprecation | `customerReviews` / `customerReviewResponses` introduced in 2.0, no deprecation; 4.0 added `GET /v1/apps/{id}/customerReviewSummarizations` (AI summary, not needed). |
| Email fallback | App Store Connect can email Admin/Customer Support users when a reviewer *updates* a replied-to review; no documented email for every new review. |
| Link | No per-review public URL documented. Link the app's App Store listing; agents with ASC access open Ratings and Reviews there. |

Ticket mapping (Apple): title + body from the attributes; rating; contact name =
`reviewerNickname`; `review_locale` = `territory`; `review_updated_at` =
`createdDate` (the only date available). Poll = first page, `sort=-createdDate&limit=200&include=response`;
a review newer than the cutoff, or whose rendered text differs from the ticket's last
incoming message, is posted.

## 5. Google reviews — Google Business Profile API v4 (verified)

Sources: review data guide <https://developers.google.com/my-business/content/review-data>,
reference <https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews>,
prerequisites <https://developers.google.com/my-business/content/prereqs>,
basic setup <https://developers.google.com/my-business/content/basic-setup>,
limits <https://developers.google.com/my-business/content/limits>,
notifications <https://developers.google.com/my-business/content/notification-setup>,
latest updates <https://developers.google.com/my-business/content/latest-updates>,
sunset dates <https://developers.google.com/my-business/content/sunset-dates>,
Business Profile help 3474050 / 3403100 / 7198436 (support.google.com/business).

| Item | Fact |
|---|---|
| Still current? | **Yes.** `accounts.locations.reviews` is in the live v4.9 reference with no deprecation banner, no reviews item on the sunset page, and new fields shipped in 2026 (`reviewReplyState` Apr, `reviewMediaItems` Apr, `policyViolation` Jul, `reviewReplyUrl` Jul). No v1 replacement exists for reviews. |
| List | `GET https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/reviews` — `pageSize` (max 50), `pageToken`, `orderBy` (`updateTime desc` default, `rating`, `rating desc`). Location must be verified. Response `{reviews[], averageRating, totalReviewCount, nextPageToken}`. |
| Get | `GET …/reviews/{reviewId}` |
| Reply | `PUT …/reviews/{reviewId}/reply` body `{"comment": "…"}` — "Reply to a specific review, **or create a new reply if one doesn't exist**" (upsert). `DELETE …/reviews/{reviewId}/reply` removes it. Also `POST …/v4/accounts/{accountId}/locations:batchGetReviews` for several locations. |
| Review fields | `name` (`accounts/…/locations/…/reviews/{reviewId}`), `reviewId`, `reviewer{displayName, profilePhotoUrl, isAnonymous}` (name/photo only when not anonymous), `starRating` enum `ONE…FIVE`, `comment` (plain text with markups; **optional** — star-only reviews are returned, batchGet's filter for them is deprecated), `createTime`, `updateTime` (RFC 3339), `reviewReply{comment, updateTime, reviewReplyState PENDING/REJECTED/APPROVED, policyViolation}`, `reviewMediaItems[]`, `reviewReplyUrl` (output only). |
| Reply limit | **4096 bytes**. One reply per review (PUT = create or update, DELETE to remove). Replies go through moderation (`PENDING → APPROVED/REJECTED`). Public view shows the business name, not the person; the reviewer is notified. |
| Auth | OAuth scope `https://www.googleapis.com/auth/business.manage`. **User-consent OAuth with an offline refresh token** for a Google account that is an **Owner or Manager** of the listing (both roles can respond to reviews). Service accounts: NV — no Business Profile page mentions them; Google's own FAQ says partners should be added as *manager* of the profile. So: one dedicated Google account added as Manager, consent once, store the refresh token. |
| Access approval | Cloud project + the form at <https://support.google.com/business/contact/api_default> ("Application for Basic API Access", project number, an email that is owner/manager of the profile). Prerequisites: the profile verified and active **60+ days** with a website; an Organization account is listed. "Requests are reviewed within 14 days." Quota shows **0 QPM until approved, 300 QPM after**; do not file a quota increase while at 0. The API itself is only visible in the Cloud console to projects that applied. |
| APIs to enable | Google My Business API (v4), My Business Account Management API, My Business Business Information API, My Business Notifications API (plus Lodging, Place Actions, Verifications are listed in the setup guide; not needed by us). |
| Find the ids | `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts` → `accounts/{accountId}`; `GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/{accountId}/locations?readMask=name,title` → `locations/{locationId}` (use `accounts/-` for indirectly owned). |
| Push | Cloud Pub/Sub: create a topic, grant `pubsub.topics.publish` to `mybusiness-api-pubsub@system.gserviceaccount.com`, then `PATCH https://mybusinessnotifications.googleapis.com/v1/accounts/{accountId}/notificationSetting?updateMask=pubsubTopic,notificationTypes` with `{"pubsubTopic": "projects/…/topics/…", "notificationTypes": ["NEW_REVIEW", "UPDATED_REVIEW"]}`. One setting per account. The notification carries `review_name` + `location_name`; exact message JSON NV → decode, then `get` the review. **Polling is simpler**: list with default `updateTime desc`, stop at the first `updateTime` ≤ last seen. Start with polling; Pub/Sub is an optional later step. |
| Quota | 300 QPM per API when approved; 429 `RESOURCE_EXHAUSTED` on breach. One list call per poll is nothing. |
| Email fallback | Business Profile notifies owners/managers of "customer activity" (new reviews, photos) by email, toggled per user in Search → profile menu → Notifications. Forwarding that to the care@ pipeline gives a ticket with no code, but no reply path. |
| Link | `reviewReplyUrl` (output only, 2026) gives a URL to reply from the Google UI — store it in `review_link`. |

Ticket mapping (Google): rating from the `starRating` word; body = `comment` or
"(rating only, no text)"; contact name = `reviewer.displayName` or "Anonymous
reviewer"; `avatar_url` = `profilePhotoUrl`; `review_updated_at` = `updateTime`.
**Blocker:** nothing can be built end-to-end until Google approves API access
(≤ 14 days) — the Play and App Store pollers do not depend on it.

## 6. The service (`reviews/` in this repo) — what to build

- Node ESM + `express`, same layout and conventions as `bot/` (`Dockerfile`, `server.js`,
  one module per store: `play.js`, `apple.js`, `google.js`, plus `chatwoot.js`).
- Compose service `reviews`, `env_file: .env`, `restart: always`, network alias
  `reviews.flightsmojo.internal`, port only on localhost for curl. Single-service
  releases: `docker compose up -d --no-deps reviews`.
- **Env-gated per store**: a store's poller starts only when all of its variables are
  set; the webhook route always answers 200 to unknown inboxes so a half-configured
  deploy is harmless. Proposed names:
  `REVIEWS_POLL_MINUTES` (default 10),
  `REVIEWS_BACKFILL_DAYS` (default 7 — Apple and Google list the whole history, so the
  first run only imports reviews created within this window; Play is one week anyway),
  `REVIEWS_REPLY_MODE` (`post` | `readonly`, default `readonly`),
  `REVIEWS_PLAY_PACKAGE`, `REVIEWS_PLAY_SERVICE_ACCOUNT_FILE` (path to a mounted JSON key),
  `REVIEWS_PLAY_INBOX_IDENTIFIER`, `REVIEWS_PLAY_WEBHOOK_SECRET`,
  `REVIEWS_APPLE_APP_ID`, `REVIEWS_APPLE_ISSUER_ID`, `REVIEWS_APPLE_KEY_ID`,
  `REVIEWS_APPLE_KEY_FILE` (.p8 path), `REVIEWS_APPLE_INBOX_IDENTIFIER`, `REVIEWS_APPLE_WEBHOOK_SECRET`,
  `REVIEWS_GOOGLE_ACCOUNT_ID`, `REVIEWS_GOOGLE_LOCATION_ID`, `REVIEWS_GOOGLE_CLIENT_ID`,
  `REVIEWS_GOOGLE_CLIENT_SECRET`, `REVIEWS_GOOGLE_REFRESH_TOKEN`,
  `REVIEWS_GOOGLE_INBOX_IDENTIFIER`, `REVIEWS_GOOGLE_WEBHOOK_SECRET`.
  Key files are mounted read-only from a host directory that is **not** in the repo.
- Loop per store: fetch (Play: all pages of the last-week window; Apple/Google: see §4/§5)
  → for each review `upsertTicket(store, review)`:
  1. `POST contacts` (idempotent by `source_id`);
  2. `POST conversations` with the conversation attributes (returns the existing ticket
     because of the single-conversation lock);
  3. render the review; if the ticket has no incoming message yet → `POST messages`
     with it; if the newest incoming message differs → post "Review edited:" + the new
     rendering and `PATCH contacts` / keep `review_rating` current (conversation
     attributes can only be set on create through the public API, so the rating in
     the sidebar stays the original unless the agent-bot token is used for
     `conversations#custom_attributes`, which is bot-accessible — decide if needed).
- Webhook route `POST /chatwoot`: verify signature (`secret` per inbox, pick by
  `conversation.inbox_id` / `inbox.name`), filter `message_created` + `outgoing` +
  `!private` + `sender.type == "user"`, map `contact_inbox.source_id` → store + review
  id, enforce the store's length limit, call the reply API, 200 on success, 4xx/5xx on
  failure (+ private note with the store error). `REVIEWS_REPLY_MODE=readonly` → 200 and
  a private note "replies are not posted to <store>; reply in the console".
- Message body (proposal, plain text):
  ```
  ★★☆☆☆  2/5 · Google Play · v3.4.1 · Android 14 · en
  <title>
  <body>
  ```
- Logging like the bot: one line per poll (`play: 12 reviews, 2 new, 1 edited`), one
  per reply with the store's HTTP status; never log review text at info level.

## 7. Checklist before coding starts

Credentials (user creates, never pasted in chat, land in the server `.env` / key dir):
- [ ] Play: Cloud project + service account JSON; invited in Play Console with *Reply to reviews*.
- [ ] Apple: App Store Connect API key (role per §4) — Issuer ID, Key ID, `.p8`.
- [ ] Google: Business Profile API access approved for a Cloud project; OAuth client +
      refresh token for an Owner/Manager of the listing; account id + location id.

Dashboard (admin):
- [ ] 3 API inboxes, *Lock to single conversation* ON, webhook URL set, secrets copied to `.env`.
- [ ] Custom attribute definitions from §2.3.
- [ ] Automation rules from §2.2; team for review tickets.
- [ ] Decision: `REVIEWS_REPLY_MODE` post vs readonly; all ratings vs ≤ 3 only.
- [ ] Decision: Booking-ID-required rule exemption for the review inboxes.

Verification plan (preview stack): create the inboxes on the preview, run the service
against the preview with `REVIEWS_REPLY_MODE=readonly`, replay saved store payloads
(fixtures) → check tickets, edits, attributes, Reports channel dropdown; then one
real reply per store from the preview with a throwaway text, and delete/edit it in
the console.
