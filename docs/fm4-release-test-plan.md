# fm4 release — test plan (Chatwoot 4.19.0 + FlightsMojo features)

*Written 22 Oct 2026. fm4 is the first release of `feat/fm-ui-upgrade`: the Zendesk-style
workspace, the server-side features FM-24/25/26/27 with their migrations, everything else in
`docs/chatwoot-fork-changes.md`, and — merged the same day — upstream Chatwoot 4.19.0 with its
security fixes. Production stays on `v4.18.0-fm3` until every row below has passed on the preview
stack with a CI-built image. "Owner" says who runs the check: **me** = Claude on the preview,
**team** = the agents or admins who use that flow daily, **prod** = can only be checked on
production right after the release.*

---

## 0. The order of events

1. **Merge** `v4.19.0` into `feat/fm-ui-upgrade` on the side branch `merge/v4.19.0`, open the pull
   request → CI runs rspec and vitest on the combined code for the first time → fix → merge the PR.
2. **Release candidate image**: tag `v4.19.0-fm4-rc1` → CI builds `ghcr.io/mishraadityan09/chatwoot:v4.19.0-fm4-rc1`.
3. **Preview = production, minus the outside world**: the preview stack runs the candidate image
   with a copy of the production database (last night's `pg_dump`), migrated. Outbound mail goes
   to mailpit, WhatsApp and store APIs are not reachable, webhooks point at preview copies of the
   bot, reviews bridge and triage. Alternative if a production copy is not wanted: the seeded
   preview data (less real; the inbox, team and rule inventory must then be re-created by hand).
4. **Regression** (§1–§8), every row ticked by its owner, failures fixed on the branch → new
   candidate image → the failed rows re-run.
5. **Release** by the runbook in `docs/chatwoot-fork-changes.md` (snapshot, `git pull`, pull the
   image, **explicit `db:migrate`**, `up -d`), in a quiet window, with the rollback rehearsed (§8).
6. **Prod-only checks** (§9) within the first hour.

Pass criterion for every row: the flow does what it does on production today, or what the
feature's ledger entry says, with no error in the browser console, the rails log or Sidekiq.

---

## 1. Upgrade mechanics (owner: me)

| # | Check | How | Pass |
|---|---|---|---|
| 1.1 | Migrations on real data | `rails db:migrate` on the restored production copy | completes; schema version 2026_10_19_143116; no data errors |
| 1.2 | Feature flags after migrate | Super Admin → account → features, and `Account.first.enabled_features` | our two flags on (`advanced_assignment`, `conversation_required_attributes`); nothing premium turned on by accident |
| 1.3 | Flags still on next day | same, 24 h later | unchanged (the plan-reconcile job is enterprise code and absent from our image) |
| 1.4 | Boot with the prod env file | start rails + sidekiq with a copy of prod `.env` | both healthy; Sidekiq lists the new `monitors_*` queues without errors; no new env var required |
| 1.5 | Assets | dashboard loads, no 404 on `/vite/`, Super Admin login page shows our dark logo | ok |
| 1.6 | Rollback rehearsal | switch the preview back to `v4.18.0-fm3` on the migrated database | boots and works (new tables and the one new column are ignored by old code) |

## 2. Channels in (owner: me, team for the content)

| # | Flow | How | Pass |
|---|---|---|---|
| 2.1 | Web chat, each country widget | open the widget page per inbox, send a message | conversation created in the right inbox, bot greeting, country/currency in the bot's answer |
| 2.2 | Bot: FAQ answer, booking lookup, cancellation hand-off | the scripted dialogue from `scripts/intent-eval.mjs` + a cancellation with booking id | lookup result, transfer to the cancellations team, phone number by market and desk hours, private note |
| 2.3 | Intent checker on email / WhatsApp / web ticket | post a cancellation request on each channel type | routed to team 3 with the note; non-cancellation untouched |
| 2.4 | Email in through the relay | POST sample `.eml` files to the relay ingress (as Postfix does), incl. a reply chain and an attachment | ticket in the right inbox, reply threads into the same ticket, attachment present, reopen keeps the agent |
| 2.5 | Email **forwarding** (new upstream) | forward a ticket's email from the reply box to an address; reply to that forward | forward sent (mailpit), the reply opens its own ticket with the forward recipient |
| 2.6 | Website tickets | `POST` through the support site pointed at the preview, or curl the public inbox API | ticket in inbox 9 with country label and booking id chip |
| 2.7 | TripShield claims | submit a claim against the preview | ticket in inbox 17 with attachments and the summary note |
| 2.8 | Help centre | support site reading the preview's portal API | articles and categories render; slugs unchanged |
| 2.9 | Reviews bridge | mock stores, `preview/verify_reviews.sh tickets` | tickets, replies, failed-reply note as in the 21 Oct run |
| 2.10 | IROP triage | mock model, `preview/verify_triage.sh ingest / down / rebump / tickets` | as in the 22 Oct run |
| 2.11 | WhatsApp | **prod only** (§9) | — |

## 3. Channels out

| # | Flow | How | Pass |
|---|---|---|---|
| 3.1 | Email reply from an email inbox | reply on a 2.4 ticket | arrives in mailpit with From = the inbox address, In-Reply-To / References set, agent signature once |
| 3.2 | Email continuity on API inbox | reply on a 2.6 ticket | mail in mailpit after the 2-minute delay with the `reply+uuid` Reply-To |
| 3.3 | Bot reply on web chat | 2.2 | visible in the widget |
| 3.4 | Private notes never leave | note on an email ticket | nothing in mailpit |

## 4. Agent workspace — the UI upgrade (owner: team, me for the console)

| # | Flow | Pass |
|---|---|---|
| 4.1 | Login, inbox list, unread badges, in-app tabs open/close/switch | as designed in the fm4 tracker |
| 4.2 | Folders and counts (throttled refresh) | counts correct, refresh ≤ 60 s, no flicker, tab hidden → no polling |
| 4.3 | Conversation view: messages, attachments, quoted history (new display), tables in mail | readable; long supplier chains collapse correctly |
| 4.4 | Reply box: collapsible editor, canned responses, signature, attachments, CC/BCC, forward | each works; signature not duplicated |
| 4.5 | Private note, labels, assign agent / team, priority, snooze | each works and shows in the activity trail |
| 4.6 | Booking ID chip in header and on cards (FM-23) | numeric id shown, copy works, PNR-only tickets show none |
| 4.7 | Resolve with required attributes (FM-24) | resolve blocked without booking id for human users; agent bot still resolves |
| 4.8 | Search: contacts, messages, **subject** (new) | subject search finds a supplier mail by PNR in the subject |
| 4.9 | Bulk actions: assign, label, resolve, **macros** (new) | applied to all selected |
| 4.10 | Reading mode (new), keyboard shortcuts, dark mode | ok |
| 4.11 | Contact panel: attributes, previous conversations, companies | ok; the IROP attributes appear only behind "show more" on non-IROP tickets |
| 4.12 | Notifications: in-app, browser, email assignment notice | ok |
| 4.13 | Mobile app against the preview URL | login, list, reply, push (via the relay) |
- [ ] **Columns menu (FM-33):** open it from the list toolbar; tick ID, Booking ID, Labels, Email, First response, Waiting since → every row gains the cells (dashes where empty); untick → gone; drag a column to a new place → header and rows move together; reload → the choice is back; "Reset to default" → the nine original columns. Subject cannot be unticked. Do it as two different agents: each keeps their own set. With all fifteen columns on, the list scrolls sideways with the header aligned to the rows and "n tickets shown" staying put; with the default nine on a 1280 px screen there is no sideways scroll.
- [ ] **Status dot on cards (FM-35):** switch the list to the compact layout (the ⇤ toggle) with the status chip on "All": every card shows a dot before the name in the tab bar's colours (open red, pending amber, snoozed grey, resolved teal); hover names the status; switch back to the table.
- [ ] **Popover sizes (FM-36):** open the filter dialog, the sort menu and the Columns menu: titles 14 px, chips / values / options / labels 13 px, hints 12 px, the Add / Clear / Apply buttons 14 px; the same filter dialog on Contacts.
- [ ] **My Inbox (FM-37):** open My Inbox: card text 13 px, type label and time 12 px, unread label indigo (SLA-missed stays red), Display menu pickers 13 px; mark one read → label turns grey.
- [ ] **Sort by column (FM-34):** click Requested, Updated, Priority, Status, Requester, Group, Assignee, Channel, Waiting since (when shown) → the list reloads server-side (network: `sort_by=…`), the arrow sits on that column, a second click flips it; the sort menu (⇅) names the same sort; "Priority: Highest first, Created: Oldest first" is still the default for a fresh agent; a folder view re-sorts too; unassigned tickets come last on Assignee, no-team tickets last on Group.


## 5. Assignment (owner: me; the rate limiter was rewritten upstream)

| # | Flow | How | Pass |
|---|---|---|---|
| 5.1 | Round robin | three agents online, five new tickets | spread evenly |
| 5.2 | Sticky (FM-09) | returning contact after a human reply | goes to that agent |
| 5.3 | Capacity (FM-25) | limit 2 open per agent in an inbox, send 5 | third waits unassigned, resumes when one is resolved |
| 5.4 | Balanced order (FM-25) | balanced policy on an inbox | least-loaded agent first |
| 5.5 | Rate limiter | policy with 2 per 5 min, send 4 | the agent gets 2, the rest wait |
| 5.6 | Team auto-assign | ticket assigned to a team | member picked, assignee kept on reopen |
| 5.7 | Specs on CI | `spec/services/auto_assignment/*`, enterprise balanced selector spec | green |

## 6. Admin, reports, Super Admin (owner: team for settings, me for reports)

| # | Flow | Pass |
|---|---|---|
| 6.1 | Every Settings page opens and saves: inboxes (incl. email SMTP block), teams, labels, custom attributes, automation rules, canned responses, macros, integrations/webhooks, agent assignment (FM-25 capacity), conversation workflow (FM-24), account settings incl. auto-resolve | no errors; values persist |
| 6.2 | Automation rule fires | a message-created rule with "content contains" and a conversation-created rule on `issue_type` | label applied |
| 6.3 | Auto-resolve (account setting + `AUTO_RESOLVE_CRON`) | a stale open ticket resolves; FM-27: the resolution is credited to no agent in Reports | ok |
| 6.4 | Reports → Overview, Agents (**channel dropdown FM-26**), Inboxes, Teams, Labels, CSV download | numbers match a hand count on the restored data |
| 6.5 | Super Admin: login (branding), accounts, users, user diagnostics, settings | ok |
| 6.6 | Two-factor enforcement (optional) | enable for an admin on the preview | login requires the code; recovery works |

## 7. Integrations and security

| # | Flow | Pass |
|---|---|---|
| 7.1 | Account webhook → bot `/intent` with signature | accepted; a wrong secret → 401 |
| 7.2 | Agent-bot webhook signature | same |
| 7.3 | API token: `api-access-token` header and `Authorization: Bearer` | both work for the bot token's endpoints; the contact-list endpoint still refused to a bot token |
| 7.4 | Public inbox API (website tickets) and portal API (help centre) | unchanged responses |
| 7.5 | Login throttles, FORCE_SSL redirect, cookie flags | as today |

## 8. Operations

| # | Check | Pass |
|---|---|---|
| 8.1 | Log rotation anchors on every service, `docker compose config` valid | ok |
| 8.2 | Backup script against the migrated database, and a restore of that dump into a scratch database | ok |
| 8.3 | Health check, Sidekiq web UI, queue latency after a burst of 100 emails | drains within minutes |
| 8.4 | Rollback rehearsal (1.6) | done |

## 9. Prod-only, within the first hour after release (owner: you, me on the call)

- A real WhatsApp message in and a reply out on both WhatsApp inboxes.
- A real email to care@ and a reply from Chatwoot; a customer reply threading back.
- A website ticket from the live support site; a TripShield claim.
- A mobile app login and one push notification.
- Reports → Agents with the channel dropdown on live data.
- Super Admin login.
- `df -h /`, `free -h`, `docker compose ps`, Sidekiq retries/dead tabs empty of new entries.

---

## 10. Record of runs

| Date | Image | Who | Result |
|---|---|---|---|
| 22 Oct 2026 | fm4 branch code (pre-4.19.0 merge) mounted over `v4.18.0-fm3`, on a copy of the 22 Oct production database, preview :3005 | Claude, logged in as a real super-admin account | **Passed**: login, dashboard list (33,902 conversations, four pages fetched, counts correct), ticket view with booking chip / in-app tabs / CRM tab / private notes, agents overview with the FM-26 channel dropdown and real numbers (queries 50–100 ms), conversation-workflow screen with both sections, assignment-policy and capacity screens (in-app navigation < 1 s), reviews bridge and IROP triage re-created on the copy. 0 server errors. **Expected gaps**: attachments and avatars 404 (files stayed on the server). **Findings**: (1) **production, live today** — Rack::Attack's per-user limit of 30/min on `/conversations/meta` (`RATE_LIMIT_CONVERSATIONS_META`) is hit constantly by FM-08's per-inbox open-count polling (15 inboxes, re-fired on every socket event): ~4,000 throttled calls per hour from the office IP, 7 agents affected in one hour, sidebar badges and list header counts go stale; env mitigation `RATE_LIMIT_CONVERSATIONS_META=1000` + `up -d --no-deps rails`, real fix for fm4 = one aggregated open-counts request (ledger item 241). (2) Search (messages, conversations, contacts, articles: 55–270 ms), contacts list, help centre (12 real articles) and Super Admin (dashboard, account page) all render on real data; page loads measured at ~0.3 s once the app is booted — a few screenshots simply caught pages mid-render. (3) Upstream's old `/reports/agent` route still exists unlinked and shows a raw translation key; the linked `agents_overview` page is correct. |
| 22 Oct 2026 (night) | `flightsmojo/chatwoot:v4.19.0-fm4-rc1-local` = fork `732b1b47c2` built locally with the CI Dockerfile (arm64, CE), no code mounts, on the migrated 22 Oct production copy, preview :3005 (scratchpad `preview/docker-compose.rc.yml`) | Claude, logged in as a real admin | **Passed — every section.** §1 migrate (19 migrations, schema 20261019143116), flags, boot, assets, **rollback rehearsal** (the `v4.18.0-fm3` image boots and serves on the migrated database, so a rollback needs no restore); §2 relay ingest with threading + PDF, HTML-table mail with quoted history, website ticket, reviews bridge, IROP triage stamping, **burst of 60 mails: all 60 tickets 5 s after the last post, 0 failed**; §3 reply, private note, **forward (4.19)**, Cc, attachment — all correct in Mailpit (From = account support address as on 4.18, Reply-To continuity, In-Reply-To/References; a forward goes only to the typed address, keeps the PDF, Reply-To = the inbox address); §4 sidebar + ticket table (FM-28/30/32/33/34/35/36/37: columns menu, click-to-sort, horizontal scroll with pinned summary line, compact status dots), side panel (priority, label, team, snooze), FM-24 dialog + API 422 + bot exempt, search (subject, body, contact, number), reading mode (fold + pills), contact panel, My Inbox, ⌘K command bar + dark mode, bulk-action bar; §5 assignment (capacity ≤ 2, balanced, sticky, release); §6 all 36 settings and report pages open (CE paywalls as expected), Conversation Workflow, FM-26 channel dropdown + CSV with `inbox_id`, FM-27 credit, automation rule end to end, Super Admin; §7 tokens incl. Bearer, public inbox + help centre, 60 × `conversations/meta` without a 429; §8 compose config, **backup/restore** (identical counts). **Bug found and fixed on the branch (uncommitted):** `POST /api/v1/accounts/1/bulk_actions` with `status: resolved` resolved tickets **without** a Booking ID while the single-ticket API and the dashboard refuse — guard added in `bulk_actions_controller.rb` (+ locale `missing_bulk`, 3 request specs), verified live on the candidate (422 naming the tickets, snooze unaffected, resolve allowed when filled). **Notes for the desk:** replies have editable To/Cc/Bcc rows (an agent can redirect a reply); a reply to a *forwarded* mail opens a new ticket (upstream design); the Data page needs the 4.19 `data_import` account feature (off by default); the unlinked legacy `/reports/agent` raw key is upstream's. **Not coverable on the copy:** support-bot webhooks (neutralised), WhatsApp, mobile push, Netcore delivery; MFA (optional) skipped. |
| 22 Oct 2026 (late) | same candidate image + migrated copy, fed with **300 real agency mails** (newest Inbox mails of agency@flightsmojo.in, read-only Graph export, 103 MB, one day) | Claude | **Passed.** Triage front door (prod path, mock model): 300/300 accepted, 0 unparseable, 0 failed, pre-filter dropped 5 (auto-submitted, newsletters), 27 relayed + stamped, 268 held back as non-IROP by design, 0.02 s per mail. Direct relay of all 300: 299/299 non-empty mails stored (one export file was empty), no duplicates on re-post, 100/100 attachment parts kept (PDF opens, 200), inline cid images rewritten to stored blob URLs and rendering (6/6 in a real thread, 0 broken; they are not listed as attachments), 0 empty bodies, non-UTF-8 charsets clean, 5-message thread and 207-char subject render; queue peak ≈1,600 jobs, drained 112 s after the last post. Threading: 11 replies joined their parent, 130 had parents older than the window, 1 split when a reply was posted 40 ms after its parent (parallel Sidekiq workers; needs mail and reply in the same instant). **Production data finding:** two browser-push subscriptions (users 14 and 18) with blank endpoint/p256dh make every notification log `p256dh cannot be blank` (no retries, pure noise) → delete the two `notification_subscriptions` rows on prod. |
