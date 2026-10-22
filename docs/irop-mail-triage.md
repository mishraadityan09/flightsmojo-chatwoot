# IROP supplier mail → Chatwoot tickets — phase 1: triage and assignment (implementation spec)

*Researched 21 Oct 2026 against the fork at `feat/fm-ui-upgrade` (Chatwoot 4.18), the live hub
(`bot/`, `reviews/`, `scripts/email/`), Emailgistics' own pages, the providers' pricing pages and
a storage measurement run on the preview stack the same day. Every Chatwoot statement below was
read in the code (file paths given). "NV" = not verified anywhere yet; "DECISION" = waiting on
the user.*

> **Status 22 Oct 2026:** phase 1 is **built** — `triage/` in this repo, `tests/triage/`,
> `scripts/triage-eval.mjs`, `scripts/email/triage-setup.sh`, the compose service and the
> `.env.example` block — and **verified end to end on the preview stack** (§11). Decisions taken the
> same day: IROP = all supplier-initiated changes; unsure mails go to the IROP queue at low priority
> for the shadow run (`TRIAGE_UNSURE=queue`); the labelled sample is exported now and labelled by
> the desk. Nothing is committed or deployed yet.

Goal: of the ~3,000 supplier mails a day that arrive in `agency@flightsmojo.in` (managed in
Emailgistics today), the 500–600 IROP notices — schedule changes, cancellations and the like,
including the ones a supplier buries inside a "booking successful" chain — become tickets in a
Chatwoot inbox, prioritised by travel date and assigned to the IROP team. The mailbox,
Emailgistics and the ~1,500 tickets a day Chatwoot already handles are not touched. Phase 2
(replies) is out of scope and listed at the end.

---

## 1. Shape of the solution

```
supplier mail
  → M365 mailbox agency@flightsmojo.in      original stays here; Emailgistics keeps working on it
  → M365 forwarding rule, keep-a-copy       sends a COPY to the inbox's forward address
  → Postfix on the Chatwoot box             transport entry for that one address → "triage" pipe
  → triage service (hub, triage/)           regex pre-filter, then ONE structured intent call
        IROP or unsure  → relayed byte-for-byte into Chatwoot's relay ingress → ticket in the IROP inbox
        everything else → one audit line in the ledger, copy discarded
  → Chatwoot account webhook (message_created) → triage service stamps the ticket:
        custom attributes · label · priority from travel date · team → Chatwoot auto-assigns the agent
```

- **Filtering happens on a copy, by intent, before Chatwoot.** The mailbox keeps every mail;
  Chatwoot only ever receives the IROP and unsure copies (600–800 a day instead of 3,000).
- **One new hub service, `triage/`**, built like `reviews/` (Node 22 ESM, express, `node --test`,
  own Dockerfile, env-gated). The bot (`bot/`) is not changed.
- **No fork change for phase 1** (see §3.6 for why sticky assignment is a phase 2 item).
- **Everything is reversible in seconds**: remove one Postfix transport line, or the M365
  forward, and the flow stops with nothing lost — the mailbox still has every mail.

## 2. Today, and what phase 1 replaces

**The mailbox.** `agency@flightsmojo.in`, Microsoft 365, ~3,000 inbound mails a day (user figure,
21 Oct 2026): booking confirmations, ticketing, invoices, promotions and 500–600 IROP notices.
Suppliers sometimes send the IROP inside an existing success-booking thread, so subject rules
cannot be trusted; the body must be read.

**Emailgistics** (vendor pages, fetched 21 Oct 2026 — pricing https://emailgistics.com/pricing,
product https://emailgistics.com/product, rules
https://emailgistics.com/learning-centre/mailbox-administration-and-workflow-configuration/how-emailgistics-rules-work-and-rule-hierarchy,
assignment https://emailgistics.com/learning-centre/lesson/automatic-assignment-methods-explained/,
privacy FAQ https://emailgistics.com/faq/sales/privacy-and-security):
an Outlook add-in plus web admin that reads the shared mailbox through a Microsoft Graph token;
mail stays in M365, Emailgistics stores metadata only. Assignment = round robin, load-balanced or
manual (a message is moved into a per-user folder). Rules on subject phrases, sender/domain, body
keywords, business hours and attachments; no intent/AI classification (Pro has AI thread summaries
only). Reply/closed SLAs with alerts, reports, templates (Pro), API + webhooks (Enterprise).
Price per user per month: $11 / $26 / $46 yearly, $13 / $31 / $55 monthly — volume does not
change its price. Offboarding erases Emailgistics-side history; the mail itself stays.

**What phase 1 replaces:** the rule-and-assignment layer *for IROP mail only*. During the shadow
period Emailgistics keeps running on the whole mailbox; after cut-over the mailbox remains the
archive for all 3,000 a day, and Chatwoot holds the IROP work. Customer mail that happens to land
in `agency@` is not IROP and stays with the mailbox (routing it into a country inbox is a later
phase; the X-Original-To mechanism in §3.1 makes that cheap).

## 3. Chatwoot side — verified in code

### 3.1 Inbound path (the forwarding route, already live for three inboxes)

- Postfix delivers the forward address through the `chatwoot` pipe service
  (`scripts/email/postfix-setup.sh:58`, `flags=RO` → Postfix **prepends `X-Original-To:` with the
  original recipient**, i.e. the inbox's forward address) → `/usr/local/bin/chatwoot-ingress`
  POSTs the raw message to `/rails/action_mailbox/relay/inbound_emails` with basic auth
  `actionmailbox:$RAILS_INBOUND_EMAIL_PASSWORD` and `X-Forwarded-Proto: https` (prod has
  `FORCE_SSL`); 204 = stored, anything else = Postfix keeps the mail queued (`exit 75`).
- `ApplicationMailbox` (`app/mailboxes/application_mailbox.rb:10-18`) routes to `ReplyMailbox`
  when the To header is well-formed and either it is a `reply+<uuid>@` address or
  `EmailChannelFinder` finds a channel. `EmailChannelFinder`
  (`app/finders/email_channel_finder.rb:33-46`) matches **To + CC + `X-Original-To`**, then BCC,
  against `channel.email` **or** `channel.forward_to_email` (plus-tags stripped). So a forwarded
  mail reaches the inbox through the `X-Original-To` Postfix added, and the triage service can
  relay the bytes unchanged. (Later phases can route a mail into another inbox by setting that one
  header to the other inbox's forward address.)
- The relay ingress is **not rate-limited** (`config/initializers/rack_attack.rb` throttles only
  sign-in and password paths).
- Every inbound mail is also stored raw as an ActionMailbox blob and **incinerated after 30 days**
  (Rails default; verified on the preview: `IncinerationJob` scheduled exactly +30 d; the
  `action_mailbox_incineration` queue is the last entry of `config/sidekiq.yml`, so it runs).
- Queue order (`config/sidekiq.yml`): `critical, high, medium, default, mailers,
  action_mailbox_routing, …`. Mail routing sits **below** the queues chat and ticket work use, so a
  mail burst cannot delay the live tickets; the reverse can delay IROP ingest slightly at peak.
- Attachments → ActiveStorage (`config/environments/production.rb:43`,
  `ACTIVE_STORAGE_SERVICE`, prod = `local` on the `storage_data` volume shared by rails and
  sidekiq via the compose `&base` anchor). The message keeps the last 15 attachments
  (`Message::NUMBER_OF_PERMITTED_ATTACHMENTS`); `content` is capped at 150,000 characters.

### 3.2 Threading and reopening (why "IROP inside a chain" works)

- `Mailbox::ConversationFinder` strategies, in order (`app/services/mailbox/conversation_finder.rb`):
  `reply+<uuid>` recipient → `In-Reply-To` → `References` → new conversation.
  **Subject is never used; the sender's address alone never merges** (no `lock_to_single_conversation`
  for email — the UI hides the toggle, `settings/inbox/Settings.vue:334-345`). A supplier reply
  inside a chain that started in Chatwoot lands in that ticket; a chain that started before the
  switch opens a new ticket (fine).
- `Message#reopen_conversation` (`app/models/message.rb:404-435`, `after_create_commit`): an
  incoming message on a **resolved** ticket reopens it (snoozed → open too; muted/blocked contacts
  excepted) and **keeps the assignee**. If the inbox had an active agent bot the ticket would go
  `pending` instead — so **no agent bot is attached to the IROP inbox**.
- Consequence for the service: it classifies **every incoming message in the inbox**, not only new
  tickets, and re-stamps the ticket when a later message in the chain is the IROP.

### 3.3 What the webhook carries

`Message#webhook_data` (`app/models/message.rb:181-199`): `id`, `content` (**full** text
including the quoted chain — `MailboxHelper#mail_content` stores `text_content[:reply]`, which
despite its name is the untrimmed body, `app/presenters/mail_presenter.rb:42-56`),
`content_attributes.email` = `{message_id, subject, from, to, cc, date, in_reply_to, references,
text_content{full, reply, quoted}, html_content{…}, number_of_attachments, auto_reply}` —
`quoted` is the **EmailReplyTrimmer-trimmed new part** (names are inverted upstream);
`source_id` = the Message-ID; `message_type`, `private`, `sender`, `inbox`, `conversation`
(`id` = display id, `inbox_id`, `status`, `custom_attributes`, `additional_attributes.mail_subject`,
`meta.team`, `first_reply_created_at`, `contact_inbox.source_id`), `attachments[]`.
Account webhooks are signed exactly like agent-bot webhooks (`X-Chatwoot-Signature` =
`sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")`, `X-Chatwoot-Timestamp`); the bot's
`signedWith()` already verifies this scheme and is reused.

### 3.4 What a bot token may do (`app/controllers/concerns/access_token_auth_helper.rb:2-7`)

`conversations` show / toggle_status / toggle_priority / create / update / **custom_attributes**
(merge with `merge=true`, `conversation_custom_attributes_concern.rb:2-9`); `messages` create
(incl. `private: true`); `assignments` create (`team_id` or `assignee_id`); `labels` index /
create (**create replaces the list** → read, union, write — the bot's `addLabel` pattern).
`ConversationPolicy#show?` is true for any AgentBot, so the service may act on the IROP inbox even
though no bot is attached to it. **Not** bot-accessible: `conversations#index` and
`team_members#index` — so the service keeps its own ledger of the tickets it stamped (§5.5) for
the daily priority re-bump, and never needs a human API token.

### 3.5 Automation, attributes, folders, SLA

- Automation `message_created` conditions (`app/models/automation_rule.rb:49-52`,
  `lib/filters/filter_keys.yml`): `content` (= `processed_message_content`, the trimmed part,
  case-insensitive substring), contact `email` (contains), `inbox_id`, `labels`, `priority`,
  `message_type`, custom attributes; `mail_subject` only on conversation events. Actions include
  `add_label`, `assign_team`, `change_priority`, `resolve_conversation`, `snooze_conversation`,
  `add_private_note`, `send_email_to_team`; **there is no "set custom attribute" action** and no
  relative-date condition — hence the service stamps attributes and re-bumps priority itself.
  Keyword rules stay available as belt-and-braces (e.g. "message contains `schedule change`" →
  `irop` label) but are optional.
- Custom attribute definitions are **account-wide**: the sidebar lists every conversation
  attribute for every ticket, showing the first five and hiding the rest behind "show more"
  with new ones appended last (`conversation/customAttributes/CustomAttributes.vue:76-130`). Four
  IROP attributes therefore cost the other inboxes nothing visible beyond "show more".
- Priority enum `low/medium/high/urgent` or nil (`conversation.rb:87`); list sort options include
  `priority_desc` (`app/services/conversations/sort_service.rb`, `ConversationBasicFilter.vue`);
  folders filter on `priority`, `labels`, `inbox_id` and defined custom attributes.
- **SLA is enterprise-only**: `config/features.yml:130-134` (`premium: true`), reset daily on the
  community plan by `Internal::ReconcilePlanConfigService`. Priority bands + folder sort are the
  phase 1 substitute; a breach alert would be a small job in the service (phase 2+ if wanted).

### 3.6 Assignment, and the sticky-assignment gotcha

- Team auto-assign → `AutoAssignment::AssignmentService` (`docs/system-map.md` §4): open,
  unassigned conversations in the inbox, online agents of the team, per-agent rate limit, round
  robin (capacity limits and balanced order arrive with FM-25 in the fm4 release).
- **FM-09 sticky assignment** (`app/services/auto_assignment/assignment_service.rb:92-113`):
  the preferred agent is whoever **last sent a public reply to this contact within 90 days, in
  any of the contact's conversations, account-wide**. Supplier mail comes from a handful of
  no-reply addresses, each one a single contact — so the first agent who *replies* to
  `noreply@<airline>` from Chatwoot would receive every later mail from that address for 90 days.
  **Phase 1 sends no replies, so sticky never triggers** (private notes, bot messages and
  unanswered assignments do not count). It becomes a prerequisite of phase 2: FM-28, a
  per-inbox exemption (`STICKY_ASSIGNMENT_SKIP_INBOXES`, ~10 lines + spec, ledger row). Until
  then the rule for the IROP inbox is: **do not reply to suppliers from Chatwoot**.
- FM-24 (required attributes before resolving, fm4) and FM-23's Booking-ID chip: IROP tickets
  carry a PNR, not a booking id — the IROP inbox needs an exemption or the PNR must satisfy the
  rule when fm4 ships (DECISION, fm4 scope).

### 3.7 Measured footprint and load (preview, 21 Oct 2026)

Three synthetic supplier mails pushed through the preview's relay ingress (scratchpad
`preview/measure_email_footprint.sh`, samples `sample_{light,typical,heavy}.eml`; the preview now
carries `RAILS_INBOUND_EMAIL_*`, `MAILER_INBOUND_EMAIL_DOMAIN` and a `storage:/app/storage`
volume shared by rails and sidekiq — without the shared volume `RoutingJob` dies with
`ActiveStorage::FileNotFoundError`, which prod avoids through the `&base` anchor):

| Sample mail | Raw size | Postgres row (TOAST-compressed) | Permanent attachment blob | Raw copy, 30 days |
|---|---|---|---|---|
| text only | 2.4 KB | 2.8 KB | — | 2.4 KB |
| HTML notice | 67 KB | 20.5 KB | — | 67 KB |
| HTML notice + 150 KB PDF | 275 KB | 20.7 KB | 154 KB | 275 KB |

`RoutingJob` ≈ 0.8 s for the heavy mail; event jobs 25–260 ms each. Extrapolated with a mix of
30% text, 50% HTML, 20% with a PDF:

| | Ingest everything (3,000/day) | **Phase 1: triage first (~800/day)** |
|---|---|---|
| Postgres growth | 1.5 GB / month | 0.4–0.5 GB / month |
| Attachments, permanent | 2.8 GB / month | 0.75 GB / month |
| Raw mail, rolling 30 days | 8 GB | 2 GB |
| Year one, total | ≈ 58 GB | **≈ 17 GB** |
| Sidekiq | ≈ 50 thread-minutes / day | ≈ 15 thread-minutes / day |

Prod disk: 58 GB, 45 GB free (Sep 2026). **Phase 1 needs no S3 and no bigger instance**: CPU on
the t3.medium peaks around 21% with the credit balance pegged at its maximum (EC2 console, week
of 14–21 Oct 2026); the extra load lands it around 25%. What is needed instead: the daily EBS
snapshot policy pending since the disk incident (attachments are not in the DB-only backup) and a
disk-space alarm, plus a one-off memory check at the afternoon peak (`free -h`,
`docker stats --no-stream`, `df -h /`). Revisit S3 at ingest-all, at phase 2, or when free space
drops under ~20 GB.

## 4. The classifier

### 4.1 Input

The service parses the MIME itself (it sees the mail before Chatwoot does). It sends the model:
`Today` (IST date), `From`, `Subject`, `Date`, the **trimmed new part** of the text body first
(same trimming idea as Chatwoot's `quoted`: reply-trimmer rules), then the head of the full text
when the trimmed part is short or the mail is a forward, capped at **8,000 characters** (≈ 2,000
tokens); HTML-only mail is converted to text; attachment **names** only. PDF text extraction is
**not** in phase 1 (DECISION 11: revisit if the eval shows IROP details living only in PDFs).

### 4.2 Regex pre-filter (free, before the model)

Mail is marked `other` without a model call when it is clearly not an IROP notice:
auto-replies and bounces (`Auto-Submitted: auto-replied|auto-generated`, `X-Autoreply`,
`Precedence: bulk|list|junk`, `Return-Path: <>`), newsletters (`List-Unsubscribe` header),
and sender/subject patterns from `TRIAGE_SKIP_SENDERS` / `TRIAGE_SKIP_SUBJECTS` (env, regex,
empty by default). Conservative on purpose; the eval (§7) reports how many mails the pre-filter
removed and whether any of them were IROP (must be zero).

### 4.3 Output (structured JSON, strict schema; both providers of the bot's switch)

```
{
  "verdict":          "irop" | "unsure" | "other",
  "irop_type":        "schedule_change" | "cancellation" | "delay" | "reaccommodation"
                      | "equipment_or_terminal_change" | "involuntary_refund" | "other_irop" | null,
  "pnrs":             ["K7X2QM"],                      // every PNR / record locator mentioned
  "airline":          "Air India" | null,
  "flights":          [{"number":"AI 131","route":"DEL-LHR","old_departure":"2026-11-02T03:30",
                        "new_departure":"2026-11-02T04:55"}],
  "travel_date":      "2026-11-02" | null,             // first affected departure, YYYY-MM-DD
  "action_deadline":  "2026-10-28" | null,             // accept / reissue by
  "action_required":  true | false,
  "summary":          "AI 131 DEL-LHR 02 Nov retimed 0330→0455, accept or reissue by 28 Oct",  // ≤ 200 chars
  "category":         "irop" | "booking_confirmation" | "ticketing" | "finance" | "promo" | "auto_reply" | "other"
}
```

Rules in the instructions: an IROP is **any airline- or supplier-initiated change to a booked
itinerary** — DECISION 1 fixes the list; the customer-initiated cases (the customer wants to
cancel/change) are **not** IROP; when the mail is a chain, the newest part decides; several PNRs
→ one verdict listing all of them; "unsure" whenever the mail talks about a schedule or
cancellation but it is unclear whether it is a notice or a confirmation of something already
handled. Anything malformed = `unsure` (fail open to the desk).

### 4.4 Verdict → action (recall first)

| Verdict | Into Chatwoot? | Label | Priority |
|---|---|---|---|
| `irop` | yes | `irop` | from travel date (§4.5) |
| `unsure` | yes | `irop-unsure` | `low` (DECISION 4) |
| `other` | no — ledger line only | — | — |
| model error / timeout (20 s) | yes | `irop-unsure` + note "unclassified" | `low` |

A missed IROP costs a passenger a flight; a false alarm costs an agent a minute. The thresholds
and the eval target (§7) follow from that.

### 4.5 Priority from the travel date (DECISION 2 — proposal)

| Days until first affected departure | Priority |
|---|---|
| ≤ 1 | `urgent` |
| ≤ 3 | `high` |
| ≤ 7 | `medium` |
| > 7 or unknown | `low` |

The `action_deadline` is a band of its own, computed the same way, and the **higher of the two
bands wins**: travel in 10 days (low) with a deadline in 2 days gives high; a deadline today gives
urgent. Priority is **only ever raised** by the service (an agent may lower it). The daily re-bump
(§5.5) walks the ledger's open tickets at `TRIAGE_REBUMP_HOUR` (default 06:00 IST) and raises
priority as either date approaches (DECISION 2: bands as proposed, taken as the default).

### 4.6 Provider and cost

The bot's provider switch is reused (`BOT_PROVIDER`, OpenAI Responses API with `json_schema`
strict output and `reasoning: { effort: "low" }`, or Gemini `responseSchema`), with a **separate
OpenAI key and budget cap** (`TRIAGE_OPENAI_API_KEY`; DECISION 7) so the classifier and the chat
bot cannot starve each other. Prod provider today: `gpt-5.6-luna`.

Live reference (OpenAI usage dashboard, 21 Sep–21 Oct 2026, project "Flights Mojo Chat"):
53,147 requests, $35.79 → **$0.00067 per request**, matching the per-mail estimate below.
Pricing (official pages, 21 Oct 2026): Luna $0.20 / $0.02 cached / $1.20 per 1M tokens, cache
writes billed ≈ $0.25 per 1M (the dashboard's categories only reconcile at that rate); Haiku 5.5
$0.10 / $0.50 (≤ 100K-token prompts); Gemini 3.5 Flash-Lite $0.30 / $2.50; Gemini 3.8 Flash
$0.75 / $3.75 until 31 Dec 2026, then doubled.

| 90,000 mails / month, 1,500 mail tokens + cached 1,500-token instructions + 300 output | Per mail | Per month |
|---|---|---|
| gpt-5.6-luna (prod) | $0.0007 | **$62–70**, worst case $91 |
| same, after the regex pre-filter removes ~30% | | ≈ $45 |
| Claude Haiku 5.5 | $0.0003 | $28 |
| Gemini 3.5 Flash-Lite | $0.0017 | $150 |
| Gemini 3.8 Flash | $0.0034 | $306 (→ $612 in 2027) |

Bursts (a mass schedule change of ~1,000 mails in an hour) are far below provider request limits
and are smoothed by Postfix's queue (§5.6).

## 5. The service — `triage/` (built 22 Oct 2026)

### 5.1 Files

| File | Role |
|---|---|
| `triage/server.js` | env, express (raw `message/rfc822` body for `/ingest`, raw JSON for `/chatwoot`), routes, boot log of what is on/off, the daily re-bump timer |
| `triage/mime.js` | MIME parse → `{messageId, from, to, cc, subject, date, text, html, headers, attachments[name,size]}`; HTML → text; reply trimming (DECISION 5: `postal-mime` as the one dependency, or a hand-rolled parser) |
| `triage/prefilter.js` | §4.2, pure |
| `triage/classify.js` | §4.3 instructions + schema; OpenAI / Gemini calls (same shape as `bot/intent.js`), 20 s time-box, parse → safe object |
| `triage/verdict.js` | §4.4 / §4.5: verdict → `{relay, label, priority, attributes, note}`, priority bands, re-bump arithmetic — pure, unit-tested |
| `triage/relay.js` | POST the **unchanged** bytes to `TRIAGE_RELAY_URL` (basic auth `actionmailbox:$RAILS_INBOUND_EMAIL_PASSWORD`, `X-Forwarded-Proto: https`, 60 s); 204/200 = ok, else throw |
| `triage/stamp.js` | Chatwoot API with the bot token: custom attributes (merge), labels (union), `toggle_priority`, assignment `{team_id}` when the ticket has neither team nor assignee, private note; idempotent per `(conversation_id, message_id)` |
| `triage/ledger.js` | append-only JSONL under `TRIAGE_DATA_DIR` (`verdicts.jsonl`): `{ts, message_id, from, subject, verdict, irop_type, pnrs, travel_date, action_deadline, priority, relayed, conversation_id?}`; lookup by message id (RAM index rebuilt at boot from the file); weekly compaction; the open-ticket list for the re-bump |
| `triage/chatwoot.js` | `signedWith()` (copied from `reviews/chatwoot.js`), `chatwootGet/Post` with the hyphenated `api-access-token` header |
| `triage/http.js` | fetch wrapper with status check, timeout and token redaction (as in `reviews/`) |
| `triage/Dockerfile`, `triage/package.json` | node:22-alpine, runs as `node`, `EXPOSE 3004`; dependencies `express` + `postal-mime` |
| `tests/triage/*.test.mjs` | 94 unit tests of every module (node:test, stubbed fetch, temp-dir ledger; `node --test tests/triage/*.test.mjs`, the three hub suites together = 166); `tests/triage/mockllm.mjs` = a stand-in for the OpenAI Responses API with canned verdicts keyed on the subject, used for the preview end-to-end run (the real Chatwoot preview plays Chatwoot) |
| `scripts/triage-eval.mjs` | §7 accuracy script over a folder of `.eml` + a CSV of labels; exits 1 on a miss |
| `scripts/email/triage-setup.sh` | Postfix transport entry + `triage` pipe service + `/usr/local/bin/triage-ingress`, idempotent like `postfix-setup.sh`, with a self-test |

### 5.2 Endpoints and jobs

- `POST /ingest` — body = raw RFC 822 (from the Postfix pipe via `triage-ingress`, localhost only,
  `127.0.0.1:3004`). Synchronous: parse → pre-filter → classify (≤ 20 s) → decide → relay →
  ledger → **204**. A relay failure returns **500** so Postfix keeps the mail queued and retries
  (nothing is written to the ledger for it). A parse failure relays the mail as `unsure`.
  Size limit 32 MB (Postfix caps at 30 MB).
- `POST /chatwoot` — the account webhook ("IROP triage", event `message_created` only). Verify
  the signature with `TRIAGE_WEBHOOK_SECRET` (401 otherwise), answer 200 immediately, then act
  only when `message_type == incoming`, `!private`, `conversation.inbox_id == TRIAGE_INBOX_ID`.
  Look the verdict up by `source_id` / `content_attributes.email.message_id`; if the ledger has
  none (service restarted between relay and webhook, or a mail that reached the inbox by another
  route) classify from the payload's trimmed text instead. Then stamp (§5.3).
- `GET /health` — `{ok, ingest, stamp, provider, model, inbox, team, unsure, ledgerEntries, inFlight, lastIngestAt, lastRebumpDate, counts}`.
- `POST /jobs/rebump`, `POST /jobs/compact` — operator hooks on the localhost-only port: run the daily job now, compact the ledger now.
- `TRIAGE_TODAY=YYYY-MM-DD` — test hook only (preview runs): the service pretends it is that day, which is how the re-bump was exercised without waiting a week.
- Daily re-bump — at `TRIAGE_REBUMP_HOUR` IST: for each ledger entry with a `conversation_id`
  and a `travel_date` within the next 8 days, `GET /conversations/:id` (bot-accessible), skip
  resolved, raise priority when the band says so, append a ledger line. Nothing is lowered.

### 5.3 Stamping a ticket (first IROP message, and later messages in a chain)

1. `POST /conversations/:id/custom_attributes` with `merge: true`:
   `irop_type`, `travel_date`, `pnr` (comma-joined), `action_deadline`
   (+ `airline` if DECISION 10 adds it). Keys must exist as account custom attribute definitions
   (§6.1) or the sidebar will not show them.
2. Labels: read, union with `irop` / `irop-unsure`, write.
3. `POST …/toggle_priority` with the band's value, only if higher than the current one.
4. `POST …/assignments {team_id: TRIAGE_TEAM_ID}` only when the ticket has no team **and** no
   assignee (a reopened chain keeps its agent — §3.2).
5. Private note: `🛬 IROP — <irop_type> · PNR <…> · travel <date> · deadline <date>\n<summary>`,
   or `🛬 IROP update — …` for a later message in the same ticket.
6. Ledger: `conversation_id`, `stamped_at`, final priority.

Idempotency: a `(conversation_id, message_id)` pair is stamped once; a duplicate webhook delivery
is a no-op.

### 5.4 Fail-open rules

| Failure | Behaviour |
|---|---|
| model error, 4xx/5xx, timeout, quota | mail relayed as `unsure`, label `irop-unsure`, note says "unclassified — model unavailable" |
| Chatwoot relay down | 500 to Postfix → queued and retried (Postfix's queue is the durable buffer; `triage` down = the same) |
| webhook secret missing | the route answers 401 and the boot log warns; nothing is stamped |
| bot token wrong / API 4xx | relay still works (tickets exist), stamping is logged as failed and retried on the next webhook for that message (and by the daily job for priority) |
| ledger file unwritable | the service refuses to start (the audit trail is part of the contract) |

Nothing is ever deleted or moved: not in the mailbox, not in Chatwoot.

### 5.5 State

One named volume, `triage_data:/data`, holding `verdicts.jsonl` (≈ 300 bytes per mail →
~1 GB a year; weekly compaction drops `other` lines older than `TRIAGE_LEDGER_KEEP_DAYS`, default
90). This file is the audit trail ("what did the classifier decide about mail X") and the
re-bump work list. The bodies of mails are never written anywhere by the service.

### 5.6 Throughput and concurrency

Postfix delivers the `triage` transport with `triage_destination_concurrency_limit`
(DECISION 6, proposal 4; the existing `chatwoot` transport uses 2). Each delivery is one
synchronous `/ingest` taking ~1–5 s (model) + ~0.3 s (relay), so 4 in parallel ≈ 50–200 mails a
minute — a 1,000-mail burst drains in 5–20 minutes, during which Postfix holds the rest. The
service's own in-process guard (`TRIAGE_MAX_IN_FLIGHT`, default 8) returns 503 above it, which
Postfix treats as a retry.

### 5.7 Logging and secrets

One line per mail (`[mail <message-id>] <verdict> <irop_type> travel=<date> → relayed|skipped
(<ms>)`), never the body; API tokens redacted in error text (`http.js`). Secrets come from `.env`
only (`env_file: .env`, never baked into the image), the bot token is an agent-bot token (no
admin or human token anywhere), the webhook is signature-checked, port 3004 is bound to
`127.0.0.1` on the host and reachable inside compose as `triage.flightsmojo.internal:3004`.

## 6. Setup — dashboard, M365, server (all by hand, nothing scripted against the database)

### 6.1 Chatwoot dashboard

1. **Inbox** — Settings → Inboxes → Add → Email: name `Agency.Mail` (DECISION 10), email
   `agency@flightsmojo.in`. Then: greeting message **off** (a greeting would answer every supplier
   auto-reply), **no agent bot**, auto-assignment **on**, collaborators = the IROP agents. Copy the
   *Forward to Email* address (shown because prod has `MAILER_INBOUND_EMAIL_DOMAIN`). No SMTP block
   in phase 1 (no replies).
2. **Team** — Settings → Teams: `IROP desk` (DECISION 10), "Allow auto assign" on, members = the
   IROP agents. Note the team id (URL) → `TRIAGE_TEAM_ID`.
3. **Custom attributes** (Settings → Custom Attributes, model *Conversation*): `irop_type` (list:
   the §4.3 values), `travel_date` (date), `pnr` (text), `action_deadline` (date); optional
   `airline` (text). Four keys keep the other inboxes' sidebars unchanged above "show more".
4. **Labels** — `irop`, `irop-unsure`.
5. **Folders** (custom views) for the IROP agents: "IROP · open" = inbox + status open, sorted by
   priority; "IROP · unsure" = label `irop-unsure`; optional "IROP · travel ≤ 7 d" using the
   `travel_date` attribute filter.
6. **Account webhook** — Settings → Integrations → Webhooks: name `IROP triage`, URL
   `http://triage.flightsmojo.internal:3004/chatwoot`, only *Message created* ticked → copy the
   secret into `TRIAGE_WEBHOOK_SECRET`. (Create it **after** the service is up, or Chatwoot times
   out on every delivery — the same ordering lesson as the bot's webhook.)
7. Optional belt-and-braces automation: *Message created* + inbox = Agency.Mail + content contains
   `schedule change` → add label `irop`.

### 6.2 Microsoft 365 (the admin)

Forward `agency@flightsmojo.in` to the inbox's forward address with **keep a copy** (mailbox
forwarding or a mail flow rule — the tenant already allows external forwarding, proven with
`care@`). Nothing else changes: Emailgistics, Outlook folders and the mailbox contents stay as
they are.

### 6.3 Postfix (`scripts/email/triage-setup.sh`, to write; run once on the server)

- `/etc/postfix/transport`: add `<forward-address>@inbound.flightsmojo.com  triage:` above the
  existing domain line (a full-address entry wins over the domain entry) → `postmap`.
- `postconf -M triage/unix="triage unix - n n - - pipe flags=RO user=nobody null_sender=
  argv=/usr/local/bin/triage-ingress"`; `postconf -e triage_destination_concurrency_limit=4`.
- `/usr/local/bin/triage-ingress`: the `chatwoot-ingress` script with `INGRESS_URL=
  http://127.0.0.1:3004/ingest` and no password (loopback only); same exit-code contract.
- Self-test: a sample `.eml` through `sendmail` → `/health` shows `lastIngestAt`.
- Rollback: delete the transport line, `postmap`, `postfix reload` — mail for that address goes
  straight to Chatwoot again (or nowhere, if the M365 forward is also removed).

### 6.4 Compose and env (hub repo)

```yaml
  triage:
    # IROP supplier mail → tickets (triage/ folder). Off until TRIAGE_* is set.
    build: ./triage
    env_file: .env
    logging: *default-logging
    restart: always
    depends_on: [rails]
    ports: ['127.0.0.1:3004:3004']          # Postfix on the host posts here
    volumes: ['triage_data:/data']
    networks: { default: { aliases: [triage.flightsmojo.internal] } }
```

| Variable | Default | Meaning |
|---|---|---|
| `TRIAGE_INBOX_ID` | unset = service answers 204/200 and does nothing | the IROP inbox id |
| `TRIAGE_TEAM_ID` | unset = no team assignment | the IROP team id |
| `TRIAGE_WEBHOOK_SECRET` | unset = `/chatwoot` rejects everything (401) | the account webhook's secret |
| `TRIAGE_RELAY_URL` | `http://rails:3000/rails/action_mailbox/relay/inbound_emails` | Chatwoot's relay ingress, reached inside compose (no nginx body limit) |
| `RAILS_INBOUND_EMAIL_PASSWORD` | (already in prod `.env`) | basic-auth password for the relay |
| `CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_BOT_TOKEN` | (already in `.env`) | API calls for stamping |
| `BOT_PROVIDER`, `OPENAI_MODEL`, `GEMINI_MODEL` | (already in `.env`) | provider switch, shared with the bot |
| `TRIAGE_OPENAI_API_KEY` / `TRIAGE_GEMINI_API_KEY` | fall back to the bot's keys | separate key + budget cap (DECISION 7) |
| `TRIAGE_PORT` | `3004` | |
| `TRIAGE_DATA_DIR` | `/data` | ledger volume |
| `TRIAGE_SKIP_SENDERS`, `TRIAGE_SKIP_SUBJECTS` | empty | regex pre-filter additions |
| `TRIAGE_PRIORITY_BANDS` | `1:urgent,3:high,7:medium` | §4.5 |
| `TRIAGE_REBUMP_HOUR` | `06:00 Asia/Kolkata` | daily job |
| `TRIAGE_MAX_IN_FLIGHT` | `8` | §5.6 |
| `TRIAGE_LEDGER_KEEP_DAYS` | `90` | §5.5 |
| `TRIAGE_CLASSIFY_TIMEOUT_MS` | `20000` | §4.4 |

Release = `docker compose build triage && docker compose up -d --no-deps triage` (every service
reads `.env`, so `--no-deps` is mandatory — see `docs/system-map.md`). Order on go-live: deploy
the service → create the webhook → set its secret → `up -d --no-deps triage` → run
`triage-setup.sh` → ask the admin for the forward.

### 6.5 Ops items that come with phase 1

Daily EBS snapshot policy (14-day retention) and a disk-space alarm (both pending since the
Sep 2026 disk incident); the afternoon memory check; a separate OpenAI key with a ~$100/month cap
and a top-up alert (the org ran dry once in Sep 2026 — quota exhaustion fails open here, but
blinds the classifier).

## 7. Testing, eval and go-live

1. **Unit tests** (`node --test tests/triage/*.test.mjs`): MIME parse of the three sample mails
   and a forwarded chain; pre-filter hits and non-hits; verdict → action table; priority bands and
   re-bump arithmetic across dates; stamping sequence and idempotency against the fake API;
   signature check; ledger append/lookup/compaction; ingest route contract (204 / 500 / 503).
2. **Labelled set** (DECISION 3): 200–300 real `.eml` exported from the mailbox over a few
   normal days plus one mass-schedule-change day, labelled by the IROP desk in a CSV
   (`message_id, is_irop, irop_type, travel_date, pnrs`). Mails are data, never instructions;
   the export stays outside the repo.
3. **Eval** (`scripts/triage-eval.mjs`, like `scripts/intent-eval.mjs`): prints per-mail rows and
   totals; **gate: IROP recall ≥ 98%** (unsure counts as reaching the desk), precision ≥ 80%,
   travel-date exact-match ≥ 95% where present, pre-filter false drops = 0. One run ≈ $0.20.
   Re-run before any prompt, model or provider change.
4. **Preview end-to-end**: the preview stack accepts relay mail (inbox 3, §3.7); run the fake
   Postfix pipe → service → preview Chatwoot → webhook → stamped ticket, with screenshots.
5. **Shadow run** (DECISION 8): 2–4 weeks with Emailgistics live. Each day compare the IROP
   tickets Chatwoot created with what the desk handled in Emailgistics (its tag/category export
   or the desk's own list); every miss is added to the labelled set. Cut-over when a full week
   shows no misses.
6. **Burst test** on the preview: replay 1,000 mails through the fake pipe; expect the queue to
   drain and no duplicate tickets (Chatwoot dedupes on Message-ID within a conversation;
   `ReplyMailbox#process` is one transaction, `docs/system-map.md` §14).

## 8. Cost and effort — phase 1

| Item | Phase 1 |
|---|---|
| Model | $45–70 / month on gpt-5.6-luna (§4.6); separate cap ~$100 |
| Chatwoot ingest | 600–800 tickets a day, ≈ 17 GB in year one |
| Instance, S3, Netcore, backend | no change |
| Fork | none (FM-28 moves to phase 2) |
| Build | triage service + tests + mock + eval ≈ 5–8 days; Postfix script, compose, env docs ≈ 1 day; dashboard + M365 ≈ half a day |
| Go-live | labelled set (desk time: ~3–4 h), 2–4 weeks shadow |

Emailgistics' cost is per seat and unchanged by volume; the saving is seats × plan once it is
switched off after cut-over (seat count: DECISION 9).

## 9. Open decisions

*Decided 22 Oct 2026 (in chat): 1 = all supplier-initiated changes; 3 = export now, the desk
labels; 4 = queue for the shadow run (flip to digest with one env line if the band is noisy);
5 = `postal-mime`; 6 = 4; 11 = no PDF extraction in phase 1; 12 = no replies from the IROP inbox in
phase 1. Defaults taken unless the user says otherwise: 2 (bands `1:urgent,3:high,7:medium`),
10 (`Agency.Mail`, `IROP desk`, no `airline` attribute). Still with the user: 7 (who creates the
separate OpenAI key), 8 (shadow length, proposal 2–4 weeks), 9 (Emailgistics seat count).*


1. **IROP definition** — the §4.3 `irop_type` list, and whether delays below some threshold count.
2. **Priority bands** — §4.5 proposal, and the `action_deadline` one-step raise.
3. **Labelled sample** — who exports 200–300 `.eml` and who labels them.
4. **Unsure mails** — into the IROP queue at `low` with `irop-unsure` (proposal), or a separate
   review inbox.
5. **MIME parsing dependency** — `postal-mime` (one zero-dependency ESM package) vs hand-rolled.
6. **Postfix concurrency** for the `triage` transport — proposal 4.
7. **OpenAI key** — separate key + cap in the same project (who creates it).
8. **Shadow-run length and cut-over criterion** — proposal 2–4 weeks, one clean week.
9. **Emailgistics seat count** for the savings line.
10. **Names and the optional `airline` attribute** — `Agency.Mail`, `IROP desk`.
11. **PDF text extraction** — not in phase 1 unless the eval shows a need.
12. **Replies from the IROP inbox** — none in phase 1 (sticky-assignment reason, §3.6); confirm
    the desk works that way until FM-28 ships.

## 10. Phase 2 — replies (not started)

What it needs before any design: a **lookup-by-PNR** endpoint from the backend team (the current
booking API requires the customer's email, which a supplier mail does not carry); the sending
identity for supplier-facing and customer-facing mail (Netcore adds its unsubscribe footer and a
~4-minute hold); FM-28 (sticky exemption) and the FM-24 exemption; where a drafted reply lives in
CE (private note; Captain is paid). Cost reference from the review: a templated customer
notification built from the §4.3 fields costs no extra tokens; free-form drafts for customer
tickets ≈ $0.0018 each on Luna (≈ $81 / month for 45,000), ≈ $0.014–0.017 on Sonnet 5.5 /
gpt-5.6-terra.

## 11. Preview run — 22 Oct 2026 (fm-ui-preview, real Chatwoot, mock model)

Setup (scratchpad `preview/setup_triage.sh`, preview only — prod is set up by hand per §6.1): the
four conversation attributes, labels `irop` / `irop-unsure`, team *IROP desk* (auto-assign, all
agents), an agent bot *IROP triage* whose token stamps tickets (attached to no inbox), the email
inbox *Agency.Mail* (`agency@flightsmojo.test`, id 16), `triage.env`, the `triage` + `mockllm`
containers on the preview networks, and the account webhook `http://triage:3004/chatwoot`
(created after the service was up; its secret into the env; container restarted). The mock
model (`tests/triage/mockllm.mjs`) answers by subject, so the run is deterministic and free; the
relay, the webhook, the stamping and the re-bump all ran against the real Chatwoot code.

| Mail (`preview/triage-mails/`) | What happened |
|---|---|
| 01 schedule change, HTML + text | relayed → ticket 184: label `irop`, priority **urgent** (travel in 2 days + deadline tomorrow raises one step), attributes `irop_type / travel_date / pnr / action_deadline`, team *IROP desk*, private note with the summary |
| 02 cancellation with a 40 KB PDF | relayed → ticket 185: `irop`, priority **low** (travel in 9 days), PDF attached |
| 03 booking confirmation | **not relayed** — ledger line only (`other`, `booking_confirmation`) |
| 04b acknowledgement of an old change | relayed → ticket 188: label `irop-unsure`, priority low, note explains why unsure |
| 05 newsletter (`List-Unsubscribe`, `Precedence: bulk`) | **dropped by the pre-filter**, no model call, ledger line |
| 06 forwarded by `ops.lead@flightsmojo.test` | relayed although the classifier said `other` → ticket 187: label `irop`, note "Forwarded by …" |
| 07 reply in the chain of 01 (`In-Reply-To`) | threaded into ticket **184** by Chatwoot, re-stamped: note "IROP update", attributes merged, priority kept |
| 08 schedule change while the mock answered 500 | relayed as **unclassified** → ticket 189: `irop-unsure`, low, note names the error — fail-open works |
| 09 schedule change, fresh ticket | team set even though no agent was assigned yet (after the fix below) |
| daily job with `TRIAGE_TODAY` = +7 days | `{checked: 4, raised: 1}`: ticket 185 low → **high** as its travel date came within 2 days; urgent ones untouched |

Dashboard check (screenshot in the session scratchpad `preview/shots/irop-ticket-184.png`): ticket
184 shows both supplier messages and the yellow private notes, the labels and the team.

Three fixes came out of the run and the unit tests: the ledger's weekly compaction dropped the
stamped/resolved flags (the re-bump list would have emptied after the first rewrite — caught by a
test); the deadline is now a band of its own (§4.5) instead of a one-step raise; the team is now set whenever the ticket has **no team** (the inbox's
own policy may already have picked an agent before the webhook arrives — that must not block the
team), and `openTickets()` returns one entry per ticket. Not exercised on the preview and left for
the shadow run: the real model (run `scripts/triage-eval.mjs` on the labelled sample), the Postfix
pipe hand-off (`triage-setup.sh` has a self-test), the M365 forward, and agent auto-assignment to
online agents (the preview had none online most of the time; Chatwoot's own job).

Reproduce: `preview/setup_triage.sh`, then `preview/verify_triage.sh ingest|down|rebump|tickets|ledger`.

## Sources

Fork files as cited inline (`app/mailboxes/*`, `app/finders/email_channel_finder.rb`,
`app/services/mailbox/conversation_finder.rb`, `app/models/message.rb`,
`app/presenters/mail_presenter.rb`, `app/mailboxes/mailbox_helper.rb`,
`app/controllers/concerns/access_token_auth_helper.rb`, `app/models/automation_rule.rb`,
`lib/filters/filter_keys.yml`, `config/features.yml`, `config/sidekiq.yml`,
`app/services/auto_assignment/assignment_service.rb`,
`app/javascript/dashboard/routes/dashboard/conversation/customAttributes/CustomAttributes.vue`);
hub `scripts/email/postfix-setup.sh`, `scripts/email/chatwoot-ingress`, `bot/intent.js`,
`reviews/`. Emailgistics pages listed in §2. OpenAI pricing
https://developers.openai.com/api/docs/pricing; Anthropic pricing
https://platform.claude.com/docs/en/about-claude/pricing; Gemini pricing
https://ai.google.dev/gemini-api/docs/pricing (all fetched 21 Oct 2026). EC2 Mumbai on-demand
figures (third-party listings, not needed for phase 1): https://www.doit.com/compute/spot/ap-south-1/t3.large.
