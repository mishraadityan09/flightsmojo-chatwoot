# Chatwoot fork — change ledger & upgrade guide

> **What this is.** Every change our fork (`~/Work/flightsmojo/chatwoot-fork`,
> branch `flightsmojo`) makes to upstream Chatwoot: what, where, what it can
> break, how often upstream touches the same files, and what to re-check when
> a new Chatwoot version is merged. Also the progress tracker for the UI
> upgrade (`feat/fm-ui-upgrade`).
>
> **Keep it current.** Any commit that changes the fork updates this file in
> the same piece of work: ledger row, detail card, tracker status. Architecture
> and runtime behaviour stay in [`system-map.md`](system-map.md) (§9 = fork
> internals, "Shipping the fork" = release steps).
>
> Churn figures = upstream commits touching the file, `v4.16.0..v4.18.0` /
> `v4.12.0..v4.18.0` (measured 29 Sep 2026). Line numbers drift — find code
> by the `FlightsMojo:` marker comment or the symbol named here.

---

## 1. How to use this file

| When | Do |
|---|---|
| **A new Chatwoot version is out** | Run the conflict preview (§5.1) → read the detail card (§4) of every change whose files show up → merge → go through the "after an upstream merge" checks of *every* card, including ones with no conflict (silent breakage, §5.2) → tests, preview, release. |
| **Adding or changing a fork feature** | Follow the conventions (§6), add/extend a ledger row (§2) and detail card (§4), update the tracker (§3). |
| **Something looks wrong in production** | Blast-radius column (§2) tells you which change could cause it. |

---

## 2. Change ledger

**Type:** `new` = new file only · `hook` = 1–4 lines in an upstream file that
call our code · `edit` = logic changed inside an upstream file · `asset` =
static/binary file · `ci` = workflow.
**Risk** = chance of a merge conflict or silent breakage on the next upgrade.

### Live in production (`v4.18.0-fm3`, since 23 Sep 2026)

| ID | Change | Type | Upstream files touched (churn) | Blast radius, in brief | Risk |
|---|---|---|---|---|---|
| FM-01 | Brand assets: logos, favicons | asset | `public/brand-assets/{logo.svg,logo_thumbnail.svg,logo_dark.png}` (upstream `logo_dark.svg` deleted), `public/favicon-{16,32,96,512}*.png`, `public/favicon-badge-{16,32}*.png`, `public/apple-touch-icon*.png` (all ~0) | Logos on login/sidebar/emails, browser-tab icon | Low |
| FM-02 | Installation defaults | edit | `config/installation_config.yml` (5/10): `INSTALLATION_NAME`, `BRAND_NAME` → FlightsMojo; `BRAND_URL`, `WIDGET_BRAND_URL` → flightsmojo.in; `LOGO_DARK` → png. `enterprise/config/premium_installation_config.yml` (0/0): `LOGO_DARK` | Product name in UI and emails; dark logo. Defaults only — `ConfigLoader` runs with `reconcile_only_new: true`, so values already in the `installation_configs` table win | **Med** (file changes every release; neighbouring-line conflicts) |
| FM-03 | Dark logo on onboarding + super-admin login | edit | `app/views/installation/onboarding/index.html.erb` (1/1), `app/views/super_admin/devise/sessions/new.html.erb` (1/1) — `logo_dark.svg` → `.png` | Those two pages only | Low |
| FM-04 | No "Powered by Chatwoot" footer (widget, CSAT survey) | edit | `app/javascript/shared/components/Branding.vue` (0/0) body → spacer `<div class="p-3" />`; `app/javascript/widget/components/layouts/ViewWithHeader.vue` (0/0) drops `disableBranding` | Customer-facing widget + survey footer | Low |
| FM-05 | CI: build our CE image → GHCR | ci / new | `.github/workflows/flightsmojo_image.yml` (ours) — strips `enterprise/`, tag `v*-fm*` → immutable image | Every release | Low |
| FM-06 | CI: disable upstream Docker Hub publish jobs in the fork | ci | `.github/workflows/publish_{ee,foss}_docker.yml` (0/1) — `if: github.repository == 'chatwoot/chatwoot'` | Runner slots on tag pushes | Low |
| FM-07 | Booking-ID chip `BK-<id>` in the conversation header | edit | `components/widgets/conversation/ConversationHeader.vue` (1/6, +28). In `fm3` also 3 keys in `i18n/locale/en/conversation.json` (**13/26**) — **moved to `en/flightsmojo.json` on the branch (FM-14)**, so from `fm4` that file is untouched | Conversation header | Low–Med (was High until FM-14) |
| FM-08 | Channels in sidebar show & sort by **open-ticket counts** | new + hook + edit | new `store/modules/inboxOpenCounts.js` + 3 specs; `store/index.js` (2/4, +2); `store/mutation-types.js` (2/6, +1); `helper/actionCable.js` (4/10, +2 dispatches); `helper/ReconnectService.js` (3/3, +1 dispatch) + its spec; `components-next/sidebar/Sidebar.vue` (**5/22**, ~16 lines) | Sidebar Channels badges + order; API load = 1 `GET /conversations/meta` per inbox per tab, throttled 5 s | **Med–High** (Sidebar.vue) |
| FM-09 | Sticky assignment (returning customer → last human replier, 90 days) | edit | `app/services/auto_assignment/assignment_service.rb` (1/5, +38), `inbox_round_robin_service.rb` (1/1), `round_robin_selector.rb` (0/0); `enterprise/.../auto_assignment/assignment_service.rb` (0/2), `balanced_selector.rb` (0/0); 4 specs | **Who gets new conversations** (assignment_v2 path only). Kill switch `DISABLE_STICKY_ASSIGNMENT` | **Med** (upstream is actively reworking assignment v2) |
| FM-10 | Bot-failure handoff releases the bot assignee | edit | `lib/webhooks/trigger.rb` (0/1, +6) + spec | Conversations whose bot webhook fails — without it they never reach an agent | Low; **delete when upstream fixes it** (still broken on `develop`, Sep 2026) |

### On branch `feat/fm-ui-upgrade` (target `v4.18.0-fm4`)

| ID | Change | Type | Upstream files touched (churn) | Blast radius, in brief | Risk |
|---|---|---|---|---|---|
| FM-11 | Brand colour: Chatwoot blue → logo orange-red — `b8bbdc0ed2`, `e88542778f` (softer bubble), `b36c2e1600` (survey + Cmd+K) | new + hook | new `dashboard/assets/scss/_flightsmojo.scss`; `theme/colors.js` (0/2, `n.brand`); `dashboard/assets/scss/app.scss` (0/0, +import); `v3/App.vue` (0/1, +import); `survey/assets/scss/woot.scss` (0/0, +import) | Every accent in dashboard, login pages and the customer CSAT survey (buttons, links, focus rings, checkboxes, agent bubbles, Cmd+K highlight). Widget and help centre unaffected | Low (silent-break watch: `_next-colors.scss` variable names) |
| FM-12 | Icons, manifest, email + meta colours — `d5fb874d2c` | asset / edit | new `public/favicon.ico` (16/32/48); regenerated from our `favicon-512`: `apple-icon-*` (11), `android-icon-*` (6), `ms-icon-*` (4); `favicon-badge-{16,32,96}` = icon + amber dot (they were identical to the favicon, so the unread cue was invisible); `public/manifest.json` (0/1, name + colours); `public/browserconfig.xml` (TileColor); `layouts/vueapp.html.erb` (1/3, 2 metas); `layouts/mailer/base.liquid` (1/2, bar #EF4123, 4 links #D13415); `devise/mailer/_confirmation_body.html.erb` (0/1, pill, button, link — all `#D13415` since `b36c2e1600`) | Browser/phone icons; **every email** Chatwoot sends (customers and agents) | Low |
| FM-13 | Hide the random code after API inbox names — `d74f883445` | edit | `dashboard/helper/inbox.js` (**5/8**; API resolver line replaced by a marker comment) + `helper/specs/inbox.spec.js` (row → own test) | Sidebar channel row, inbox settings list/header | Med (file changes every release, but a 1-line change) |
| FM-14 | Our own i18n file — `9dd74da9ff` | new + hook | new `i18n/locale/en/flightsmojo.json` (`FLIGHTSMOJO.*`); `i18n/locale/en/index.js` (2/4, +3 incl. marker, inserted alphabetically after `emoji`); `en/conversation.json` back to upstream; `ConversationHeader.vue` uses `FLIGHTSMOJO.BOOKING_ID.*` | All FlightsMojo strings | Low (removed a High) |
| FM-27 | **Server**: auto-resolved conversations are not credited to the assignee in reports. 19 Oct 2026, `c8f3768f2b` | hook (server) | `app/dispatchers/async_dispatcher.rb` (0/0: +1 payload key `fm_system_action`, +1 private method); `app/listeners/reporting_event_listener.rb` (1/?: `conversation_resolved` takes `user_id` from `fm_resolver_id`); specs `dispatchers/async_dispatcher_spec.rb` (1 expectation → `hash_including`, +2), `listeners/reporting_event_listener_spec.rb` (+2), `jobs/conversations/resolution_job_spec.rb` (+1) | Every async event payload carries one extra boolean. Only `conversation_resolved` events written by the auto-resolve job change: `user_id` nil → counted for the account, inbox and team, for no agent. Past events untouched | Low–Med (`reporting_event_listener.rb` churns a little) |
| FM-26 | **Server + UI**: channel filter on Reports → Agents (table + CSV). 19 Oct 2026, `5ebf3baa01` | new + hook (server + UI) | new `dashboard/flightsmojo/reports/{FmChannelFilter.vue,channelFilter.js}` + 2 specs; hooks: `api/v2/accounts/summary_reports_controller.rb` (0/0: permit `inbox_id`, account-scoped lookup → 404), `builders/v2/reports/base_summary_builder.rb` (0/0: +1), `services/reports/data_source.rb` (0/0: +2), `services/reports/raw_data_source.rb` (0/0: one `where` each in `summary_scope` / `summary_conversation_counts`), `helpers/api/v2/accounts/reports_helper.rb` (0/0: agents CSV merges `fm_channel_filter`), `settings/reports/components/SummaryReports.vue` (0/0: import, ref, fetch param, handler, file name, slot content), `OverviewReportFilters.vue` (0/0: `<slot name="filters">`), `api/summaryReports.js` + `api/reports.js` (0/0: `inbox_id`); `en/flightsmojo.json` (`REPORTS.CHANNEL.*`); specs `summary_reports_controller_spec.rb` (+2), `agent_summary_builder_spec.rb` (+1) | Reports → Agents only; with no channel chosen every query is byte-for-byte upstream's | Low (every touched file had 0 upstream commits v4.16→4.18) |
| FM-25 | **Server code**: agent capacity policies + balanced assignment (Settings → Agent Assignment) — `0ca771565d`, migration `36714dee3f` | new + hook (server + migration) | new `app/models/{agent_capacity_policy,inbox_capacity_limit}.rb`, `app/policies/agent_capacity_policy_policy.rb`, 3 controllers under `api/v1/accounts/agent_capacity_policies*`, `services/auto_assignment/{capacity_filter,balanced_selector}.rb`; hooks (marked `FlightsMojo`): `assignment_service.rb` (+8: capacity filter + balanced selector), `assignment_policy.rb` (enum + `balanced`), `account_user.rb`, `account.rb`, `inbox.rb` (1 association line each); migration `20261005000000` switches `advanced_assignment` on; `db/schema.rb` version line | **Who gets new conversations** in inboxes with a capacity limit; the balanced order. No policy → no change. Written by us (Chatwoot's EE code is licensed separately, so not copied) | **Med–High** (`assignment_service.rb` is already fork-modified; upstream reworks assignment v2) |
| FM-24 | **Server code**: required conversation attributes before resolving (Settings → Conversation Workflow) — `57b1e479ef` | new + hook (server) | new `services/conversations/required_attributes_service.rb`, `controllers/concerns/required_attributes_guard.rb`, `config/locales/flightsmojo.en.yml`; `api/v1/accounts_controller.rb` (+8: permit the setting, sanitize keys); `api/v1/accounts/conversations_controller.rb` (+1 include); `composables/useConversationRequiredAttributes.js` (+13: a value breaking the attribute's pattern counts as missing); migration switches `conversation_required_attributes` on | Resolving over the UI **and the API** for human users; agent bots (auto-resolve) are exempt | Med |
| FM-23 | Booking-ID chip on previous-conversation cards; hide Reports → SLA and Campaigns → SMS when unusable — `2895e75acc` | new + hook | `flightsmojo/helpers/ticket.js` (`getBookingId`); `ConversationCard.vue` (+`showBookingId` prop, 1 row); `ContactConversations.vue` (+1 attribute); `components-next/sidebar/Sidebar.vue` (+2 computeds, 2 conditional items) | Contact panel's Previous Conversations; sidebar Reports/Campaigns menus | Low–Med |
| FM-21 | Canned responses / editor inserts never fail on unsupported Markdown — `5d850b9b33` | new + hook | new `dashboard/flightsmojo/helpers/messageMarkdown.js` + spec; `dashboard/helper/editorHelper.js` (**4/10**: 1 import, `stripUnsupportedFormatting` returns `ensureParseable(…)`, canned-response case wraps `content` in `unindentPastedText`) | **Every editor parse** (canned responses, inserted articles, draft/initial content) — content that parses is returned unchanged | Low–Med (editorHelper churns, but 3 small spots) |
| FM-20 | Sidebar list fade clears at the end of long lists — `9d4de31e97` | edit (bug fix) | `components-next/sidebar/SidebarSubGroup.vue` (0/2, 1 line + marker): end-of-scroll check `=== clientHeight` → `≤ 1 px` gap | Channels / Folders / Teams / Labels lists with > 7 items: the "more below" fade and ⌄⌄ no longer stay over the last item at the end of the list | Low; **delete when upstream fixes it** (still exact-match on `develop`, 22 Sep 2026) |
| FM-19 | In-app ticket tab bar — `3a4cc72b44`, `caf037a304` (visible ×) | new + hook | new `dashboard/flightsmojo/tabs/{useTicketTabs.js,FmTicketTabs.vue}` + spec; `routes/dashboard/Dashboard.vue` (1/2: import, component registration, `<router-view>` wrapped in two divs + `<FmTicketTabs />`) | **Layout of every dashboard page** (40 px less height when tabs exist) | Med (app shell) |
| FM-18 | Play / Next — **removed from the branch 8 Oct 2026**, user decision "no need for now" (was `29c237a7a0`, `c0b84fbe66`, `8849ed5d31`) | removed | `flightsmojo/play/` deleted; hooks taken back out of `ConversationHeader.vue` (import + tag), `FmTicketTableHeader.vue` (Play button, route watch), `ticketTable.js` (`setPlayLiveList`, `loadMore` option), `ConversationList.vue` (call), `flightsmojo.json` (`PLAY` block) | none | — |
| FM-17 | View (folder) counts in the sidebar — `5fac9bf463`, exact badges `a2d4c4536b` | new + hook | new `dashboard/flightsmojo/folders/useFolderCounts.js` + spec; `components-next/sidebar/Sidebar.vue` (**5/22**: 1 import, 1 call, folder `badgeCount` line); `components-next/sidebar/SidebarUnreadBadge.vue` (0/4: cap 99+ → 9999+) + upstream spec `sidebar/specs/SidebarGroupLeaf.spec.js` ('caps large unread counts' expectations). **No store, `actionCable.js` or `ReconnectService.js` edits** (listens to upstream's bus events instead) | Sidebar Folders badges; API load ≤ one count-only `POST /conversations/filter` per folder per open, visible tab per 60 s (30 s until 8 Oct 2026) | Med (Sidebar.vue, but 3 lines) |
| FM-16 | Zendesk-style ticket table (expanded layout) — `2c491b4f11`, `834c412b3e` (40 px rows), `56bcfc27bc` (priority sort default), `79d5c24a7d` (scroll fix), `7762f655d5` (menu icon), `3ae59bf2a3` + `6d1d2e1fbe` (typography, calmer) | new + hook | new `dashboard/flightsmojo/tickets/{FmTicketRow,FmTicketTableHeader,FmTicketGrid}.vue`, `ticketTable.js` + 3 specs; `components/ConversationItem.vue` (0/1: the `ConversationCardExpanded` import now points at `FmTicketRow`); `components/ConversationList.vue` (0/2: 2 imports, `useTicketTable(...)`, `<FmTicketTableHeader>` tag, `:start-margin` on `<Virtualizer>`); `en/flightsmojo.json` (`FLIGHTSMOJO.TICKETS.*`). **`useUISettings.js` not touched** — the default is written per user instead | The main list screen for every agent on screens ≥ 1024 px | Med (silent-break watch: expanded-card props/events) |
| FM-15 | Subject line on the list card — `bcd308281c`, `d6e2f0f77c` (blank-subject fix, `pe-6`) | new + edit | new `dashboard/flightsmojo/helpers/ticket.js` (`getTicketSubject`) + spec; `components/widgets/conversation/ConversationCard.vue` (1/6: import, computed, subject `<p>`, `prefer-body`, 1 condition in `messagePreviewClass`); `components/widgets/conversation/MessagePreview.vue` (0/0: `preferBody` prop, 3-line branch); new specs `MessagePreview.spec.js`, `ConversationCardSubject.spec.js` | Condensed conversation list (every agent) | Low–Med |

### Planned (UI upgrade, same release)

| ID | Change | Type | Upstream files touched (churn) | Blast radius | Risk |
|---|---|---|---|---|---|

---

## 3. UI-upgrade progress tracker (`feat/fm-ui-upgrade` → `v4.18.0-fm4`)

Plan decided 29 Sep 2026: one release; in-app tab bar; Play included (taken out again 8 Oct 2026, user: not needed for now);
emails orange; subject row + body preview; sidebar/background tint decided
after preview review. Each step: user checks it in the local preview
(`http://localhost:3005`, §5.4) before the next starts.

| # | Workstream | Ledger | Est. | Status | Commit | Previewed |
|---|---|---|---|---|---|---|
| 0 | This ledger | — | 0.5 d | ✅ done 29 Sep | — (hub repo) | — |
| 1 | Branding polish: colour, icons, manifest, emails, metas, API code, i18n file | FM-11..14 | 1 d | ✅ done 29 Sep | `b8bbdc0ed2` `d5fb874d2c` `d74f883445` `9dd74da9ff` | ✅ 29 Sep, browser pass on seeded preview: login, list, conversation (BK chip), dark mode, inbox settings, icons/manifest; bubble softened after review |
| 2 | Subject line on the card | FM-15 | 1 d | ✅ done 29 Sep | `bcd308281c` | ✅ 29 Sep, browser pass: All Unsolved folder, read/unread, email/API/chat cards |
| 3 | Ticket table | FM-16 | 5–6 d | ✅ done 29 Sep–1 Oct (user-reviewed; follow-ups: rows, sort, scroll, menu icon, typography) | `2c491b4f11` … `6d1d2e1fbe` (see FM-16) | ✅ Claude browser pass: folder + tabs views, priority groups, open/Back, ⋮ menu, bulk select, 1200 px, dark |
| 4 | View counts | FM-17 | 2–3 d | ✅ done 29 Sep | `5fac9bf463` | ✅ Claude browser pass: counts match the data (All Unsolved 12, Unassigned 4, My Unsolved 4, teams 5/2/1, empty hidden); live refresh not demonstrable in the preview (no sidekiq → no websocket events), covered by specs |
| 5 | Play / Next | FM-18 | 2 d | ❌ removed 8 Oct 2026 (user: not needed for now) | `29c237a7a0` | ✅ Claude browser pass: Play → first Urgent, Next → second ("23 left"), Stop → folder, Back ends Play, manual open shows no controls |
| 6 | Tab bar | FM-19 | 5–7 d | ✅ done 29 Sep | `3a4cc72b44` | ✅ Claude browser pass: open/switch/close tabs, Views, reload restore, labels survive list resets; every page type measured (bar 40 px, page fills 860/900, no overflow), hidden < md, dark mode |
| 7 | QA, PR + CI, tag `fm4`, deploy | FM-20, FM-21 | 2–3 d | 🟡 QA done 2 Oct (below); PR + CI, tag, deploy not started | `9d4de31e97` `5d850b9b33` | ✅ 2 Oct release-readiness pass (below) |

**Review 29 Sep (`/code-review high`, 9 findings on the 6 commits):** fixed — CSAT survey + Cmd+K still blue, blank-email-subject bug, email button contrast, `pe-6` convention (`d6e2f0f77c`, `b36c2e1600`); by design — API code hidden everywhere, pale blue-grey email panels, expanded layout has no subject yet (step 3 replaces it); false positive — sidebar logo; leftovers listed in FM-11.

**Table decisions (29 Sep, after the user's own preview):** table is the default for every agent (one-time switch, opt-out via the layout toggle) · soft-tint status badges · compact 40 px rows (Claude's suggestion, accepted).

Open decisions: sidebar/page background tint (after preview).

**Release-readiness review, 2 Oct.** Scope: fm3 → branch, 24 commits.

*Diff check, 72 files.*
- No Ruby, database, config, dependency or CI files changed.
- Only front-end code, strings, tests and icons, plus 3 templates whose changes are colour values and comments only.
- The new `layouts/mailer/base.liquid` renders identically to fm3's apart from colour codes.
- `vueapp.html.erb` and `_confirmation_body.html.erb` compile.

*Tooling.*
- vitest 4755/4755 passing.
- `vite build` OK.
- eslint: 0 errors.

*Preview smoke test (fm3 server + fm4 build).*
- Reply and private note.
- Canned reply in an API inbox (the fm3 crash case).
- Resolve and reopen.
- Bulk label.
- Contacts, reports, settings and help-centre layout.
- Switching to the condensed layout.
- The hub bot ignores assignment events.

*Behaviour changes agents will notice.*
- On first load each agent gets the table layout and priority sort (one time; their own choice is kept afterwards).
- Folder badges show totals: "Recently Solved" will read 9999+ on prod (about 20.7k tickets).

*Load.* Folder counts measured at about 0.3 s per request on prod.

*Prod issue found, not caused by fm4.*
- FM-08's per-inbox `GET /conversations/meta` (15 inboxes) can hit Rack::Attack's 30/min per-user limit (`RATE_LIMIT_CONVERSATIONS_META`), leaving badges and Mine/Unassigned/All counts stale.
- fm4's folder counts use `POST /filter`, which that limit doesn't cover.

*Added after the review (5 Oct; committed as `2895e75acc`, `57b1e479ef`, `0ca771565d`, `36714dee3f`):* FM-23 (screens), FM-24 and FM-25 (**server code**, so this branch is no longer UI-only: it needs a server release with `db:migrate`; the two migrations only switch feature flags on and change no table). Verified on the preview: admin screens save, resolve form + API refusal, capacity limit stops auto-assignment and resumes when a slot frees, balanced order, label exclusion; rubocop clean; rspec runs on GitHub CI (not runnable on the Mac).

*Added 19 Oct 2026 (committed 21 Oct: `5ebf3baa01`, `c8f3768f2b`):* FM-26 channel filter on Reports → Agents (server + UI) and FM-27 auto-resolutions not credited to agents (server). vitest green (11 new specs); rspec only on CI — still no PR.

*Candidates for the next plan (not decided).*
- Tab bar: remove the Views tab, add an "all tabs" menu, keep the active tab scrolled into view (hidden overflow tabs).
- Folders oldest-first (main views on top), Teams and Labels collapsed by default.
- No count on solved folders.
- Status switch in the sidebar footer.
- Team names title case.
- Hide Reports → SLA (paid; spins forever) and Campaigns → SMS.
- Optionally rename My Inbox → Notifications and Folders → Views.
- Admin-only data fixes (no code):
  - business name on email inboxes (customers see "Agent from USA-CA.Email");
  - labels off the sidebar;
  - consistent inbox names.

---

## 4. Detail cards

Each card: **what & why · where · blast radius · tests · after an upstream
merge, check.**

### FM-01..04 — Branding (assets, installation defaults, logos, widget footer)
- **Why:** the product is FlightsMojo, not Chatwoot, for agents and customers.
- **Where:** see ledger. Our fork deleted upstream's `logo_dark.svg`; everything points at `logo_dark.png`.
- **Blast radius:** visual only. A wrong `LOGO_DARK` path = broken image in dark mode (happened once, fixed in `ecb0201e2a`).
- **After merge, check:** upstream re-adding `logo_dark.svg` or new `*.svg` references (`git grep -n "logo_dark"`); new installation-config keys with "Chatwoot" defaults (`git diff OLD NEW -- config/installation_config.yml`); new places rendering `Branding.vue` or a "Powered by" string in widget/portal/survey; conflicts in `installation_config.yml` → keep ours for the 5 keys above.

### FM-05..06 — CI
- **Why:** prod runs our image from GHCR, CE only (enterprise stripped → `ChatwootApp.enterprise?` false).
- **After merge, check:** upstream changes to `docker/Dockerfile` or its build args (our workflow mirrors `publish_foss_docker.yml`); upstream workflows that trigger on tags (guard them the same way).

### FM-07 — Booking-ID chip
- **Where:** `ConversationHeader.vue`, marker `FlightsMojo: booking id` — reads `chat.custom_attributes.booking_id`, shows only `^\d{1,10}$`, click-to-copy.
- **Blast radius:** header row width (chip has `max-w-40 truncate`).
- **Tests:** none of its own (vitest header specs still pass).
- **After merge, check:** header template restructured → re-place the chip. Strings are `FLIGHTSMOJO.BOOKING_ID.*` in `en/flightsmojo.json` (FM-14); `conversation.json` needs nothing from `fm4` on.

### FM-08 — Open-ticket counts on Channels
- **Where:** `store/modules/inboxOpenCounts.js` (5 s trailing throttle, round counter, failed inbox keeps last count, skips commit when unchanged); dispatches in `actionCable.js` (`onConversationCreated`, `onStatusChange`) and `ReconnectService.js` (`revalidateCaches`); `Sidebar.vue` markers `FlightsMojo: the Channels list shows — and sorts by` and `show open-ticket count instead of unread count`.
- **Blast radius:** sidebar only; worst case wrong/stale badge, or extra `/meta` load.
- **Tests:** `store/modules/specs/inboxOpenCounts/*`, `helper/specs/ReconnectService.spec.js`, `helper/specs/actionCable.spec.js` (dispatch counts).
- **After merge, check:** `Sidebar.vue` conflicts (most likely file to conflict) — re-apply the getter swap + watcher; `ConversationApi.meta` signature in `api/inbox/conversation.js`; `actionCable.js` handler names; `SidebarUnreadBadge` props.

### FM-09 — Sticky assignment
- **Where:** `AssignmentService#sticky_agent_id` → `preferred_user_id:` into `RoundRobinSelector` → `InboxRoundRobinService#available_agent(preferred_agent_id:)`, and EE `BalancedSelector`. Details and design: `system-map.md` §4 and §9.
- **Blast radius:** routing of every new conversation on the assignment_v2 path. Kill switch: `DISABLE_STICKY_ASSIGNMENT=true`.
- **Tests:** `spec/services/auto_assignment/{assignment_service_sticky_assignment,inbox_round_robin_service,round_robin_selector}_spec.rb`, `spec/enterprise/.../balanced_selector_spec.rb` (run in PR CI only).
- **After merge, check:** any upstream change under `app/services/auto_assignment/` or `enterprise/app/services/enterprise/auto_assignment/` (method renames, selector signature, capacity filter order); `perform_bulk_assignment` still gated by `assignment_v2`.

### FM-10 — Bot-failure handoff
- **Where:** `lib/webhooks/trigger.rb`, marker `FlightsMojo: hand off properly` — clears `ai_assignee` via `bot_handoff!` before opening.
- **After merge, check:** has upstream fixed it? If `update_conversation_status` now releases the bot assignee itself → **drop our change** and its spec.

### FM-11 — Brand colour
- **What:** Chatwoot's accent is the 12-step `--blue-*` scale + `n-brand`. `_flightsmojo.scss` replaces the scale (light `:root` + `.dark`) with Radix **tomato**, step 9 = logo `#EF4123`, plus `--text-blue`, `--border-blue(-strong)`, `--solid-blue(-2)`. `n-brand` was a hard-coded `#2781F6`; now `rgb(var(--blue-9, 39 129 246) / <alpha-value>)`.
- **Where:** `_flightsmojo.scss` (ours); markers `FlightsMojo:` in `theme/colors.js`, `app.scss`, `v3/App.vue`.
- **Deliberate deviation:** `--solid-blue` (agent message bubbles, macro chips, Captain bubbles) is one step softer than the strict tomato mapping — `#FEEBE7` light / `#391714` dark — because the strict `#FFDCD3` / `#4E1511` read like an error (user decision after the preview, `e88542778f`).
- **Also themed (review follow-up `b36c2e1600`):** the customer CSAT survey (`survey/assets/scss/woot.scss` imports our file after `next-colors`; its submit button is `bg-n-brand`), and the Cmd+K command bar — `commandbar.vue` hard-codes `--ninja-accent-color` on the `ninja-keys` web component, overridden in `_flightsmojo.scss` with `:root ninja-keys { --ninja-accent-color: rgb(var(--blue-9)) }` (a variable on a third-party element, not a Chatwoot class).
- **Known leftovers (hard-coded blue, rarely seen, left as is):** Dyte video-call bubble icon (`message/bubbles/Dyte.vue`, feature unused), voice-note waveform (`AudioRecorder.vue` `#1F93FF`), AI label-suggestion chips (`LabelSuggestion.vue`, Captain/EE), default colour of a *new* help-centre portal (`CreatePortalDialog.vue`, admin picks it anyway), 4 `text-woot-*` links in help-centre views (portal colour comes from its own setting). Sidebar logo is **not** a leftover: `Logo.vue` renders `LOGO_THUMBNAIL` (ours) whenever it is set.
- **Known side effects:** the login page background and other `--blue-1/2` tints are now faintly warm/pink instead of faintly blue. The inbox-settings **widget preview** keeps its own scoped `--solid-blue` copy (`modules/widget-preview/components/Widget.vue`, `.widget-wrapper`), on purpose — it mirrors the real widget.
- **Blast radius:** all accent colour in dashboard + login. Contrast equal to the old blue (white on step 9: 3.85 vs 3.78; links 4.65 vs 4.59). Widget stays blue through the fallback (it doesn't load `next-colors`); help centre and survey load `next-colors` but not our file.
- **Tests:** none (CSS). Verified by build output order (`--blue-9` ours after upstream's in `dashboard-*.css`, `v3app-*.css`).
- **After merge, check (silent breakage!):** `git diff OLD NEW -- app/javascript/dashboard/assets/scss/_next-colors.scss theme/colors.js` — renamed/added accent variables (e.g. `--blue-a*` alpha steps, new `--solid-blue-*`) need tomato values in `_flightsmojo.scss`; new hard-coded `#2781F6`/`#1F93FF` (`git grep -niE "2781F6|1F93FF" app`); a new entrypoint that loads `next-colors` and should also load our file.

### FM-12 — Icons, manifest, emails, metas
- **Icons:** all generated with Python PIL from `public/favicon-512x512.png` (no ImageMagick needed); `favicon.ico` embeds the hand-made 16/32 PNGs + a 48 downscale. Badge = amber `#FFC53D` dot with white ring, top-right (a red dot vanished on our orange-red icon).
- **Emails:** `layouts/mailer/base.liquid` accent bar + links (marker = a `{% comment %}` on line 1 with `-%}` so no blank line precedes `<!DOCTYPE`), `devise/mailer/_confirmation_body.html.erb` pill, button, link. Links **and buttons** use `#D13415` (white 14px text on the logo colour is 3.85:1, below WCAG AA; `#D13415` is 4.98:1 — user decision after review). Pale blue-grey backgrounds (`#F4F7FB`, `#DCE7F5`, info box) deliberately kept.
- **Not markable:** `manifest.json` (JSON) and `browserconfig.xml` carry no marker comment — this card is their record.
- **After merge, check:** new mailer templates with blue; `manifest.json` / `vueapp.html.erb` icon list changes.

### FM-13 — API inbox identifier hidden
- **Where:** `helper/inbox.js` `INBOX_IDENTIFIER_RESOLVERS` — API entry removed, so `getInboxIdentifier` returns `''`. Callers: `components-next/sidebar/ChannelLeaf.vue`, `settings/inbox/Index.vue`, `settings/inbox/Settings.vue`. Config tab still shows the identifier.
- **Decision (29 Sep review):** hidden *everywhere* on purpose — sidebar, Settings → Inboxes list/header, and settings search by identifier (admins copy it from the Configuration tab). A sidebar-only variant would mean editing `ChannelLeaf.vue` (changes most releases).
- **After merge, check:** upstream re-adding/renaming the resolver map (it changed in #15528, #15611, #15628).

### FM-14 — `en/flightsmojo.json`
- All our strings under a top-level `FLIGHTSMOJO` key; registered in `i18n/locale/en/index.js`. The dashboard's `createI18n` sets no explicit fallback, so non-English UIs resolve our keys exactly as they resolved the old ones (en only). The eslint `vue-i18n` rules glob `app/javascript/*/i18n/**.json`, which covers the new file.
- **After merge, check:** the `index.js` import/spread still present.

### FM-15 — Subject line
- **What:** `getTicketSubject(chat)` = first non-blank of `additional_attributes.mail_subject`, `additional_attributes.subject` (each trimmed, strings only — a blank email subject falls through, fixed in `d6e2f0f77c`). **Contract** for the support-site ticket integration: put the ticket title in `additional_attributes.subject`.
- **Where:** `ConversationCard.vue` markers `FlightsMojo: ticket subject row`, `FlightsMojo: with a subject row, the body stays secondary`, template comment `FlightsMojo: ticket subject`; `MessagePreview.vue` marker on the `preferBody` prop.
- **Layout:** row = `text-sm leading-5 truncate`, `title` = full subject; unread → `font-medium` + logical `pe-6` (clears the absolutely-positioned unread badge, which now sits beside the subject row). With a subject, the preview line stays `text-n-slate-11` even when unread (upstream makes it medium/slate-12). Cards without a subject render exactly as upstream.
- **Blast radius:** every condensed list card; card height +20 px only when a subject exists. `MessagePreview` is also used by `ReplyToMessage.vue` — unaffected (prop defaults off).
- **Tests:** `flightsmojo/helpers/specs/ticket.spec.js`, `widgets/conversation/specs/{MessagePreview,ConversationCardSubject}.spec.js` (new files; upstream's `ConversationCard.spec.js` untouched).
- **After merge, check:** upstream adding its own subject to cards → drop ours; card template reshuffled (name `<h4>` / VoiceCallStatus / MessagePreview chain) → re-place the row; `messagePreviewClass` rewritten → re-apply the one condition; `MessagePreview.vue` converted to `<script setup>` → port the prop.

### FM-16 — Ticket table
- **What:** the expanded layout (`conversation_display_type = expanded`: full-width list, full-width ticket with Back) renders `flightsmojo/tickets/FmTicketRow.vue` in place of upstream's `ConversationCardExpanded` — `ConversationItem.vue` imports ours under that name, so its template and handlers are untouched. Columns: select · status badge (Open ruby, Pending amber, Snoozed slate, Resolved teal) · subject (or last message, grey) + first label chip "+N" + unread badge · requester · requested (`MMM d, HH:mm`) · priority · group (team) · assignee · channel (inbox) · updated (relative, shared 1-min clock) · ⋮ (opens upstream's context menu). Below `xl` requested/group/channel are hidden.
- **Header:** sticky `FmTicketTableHeader` inside the list's scroll container: "{loaded} of {total} tickets" in folder views (total = `conversationStats.allCount`), "{n} tickets shown" elsewhere, "Updated just now / {time}" from `conversationStats.updatedOn`, column titles on the same `FmTicketGrid`.
- **Priority groups:** `getTicketGroups` adds a header ("High 4") above each group's first row **only when the loaded rows are in priority order** (e.g. sort "Priority: Highest first, Created: Oldest first"); counts are loaded rows (infinite scroll).
- **Defaults (once per agent):** `useDefaultTicketLayout` (called via `useTicketTable` in `ConversationList`) runs once per agent, recorded as `flightsmojo_defaults_version: 1` in their `ui_settings` (the profile endpoint permits any key), so later choices always stick. On that run: **layout** → `conversation_display_type` and `previously_used_conversation_display_type` = `expanded` unless the agent had toggled layouts (`previously_used…` set); **sort** → `conversations_filter_by.order_by` = `priority_desc_created_at_asc` ("Priority: Highest first, Created: Oldest first") when no sort is saved **or** it is Chatwoot's default `last_activity_at_desc` — upstream's status filter saves that value even when nobody chose it (`ConversationBasicFilter.saveSelectedFilter`); any other saved sort was deliberate and is kept. Written exactly where upstream's toggles write them, so no upstream reader needs editing; `ChatList` applies the sort in `onMounted`, which runs after `ConversationList`'s setup, so it takes effect on the first load. To roll out a *new* default later: bump `DEFAULTS_VERSION` and add the rule.
- **Gotchas:** Tailwind does not scan `dashboard/flightsmojo/**/*.js` → all class strings live in `.vue` files (grid template in `FmTicketGrid.vue`). The sticky header sits inside the virtualised scroll container **before** the `<Virtualizer>`, so the Virtualizer **must** get its height as `start-margin` (virtua docs). Shipped without it at first: with 150+ tickets the list went blank while scrolling, fired several page loads at once and snapped back to the top (user report, 29 Sep). Fixed in `79d5c24a7d`: `FmTicketTableHeader` measures itself (`useResizeObserver`) into `TICKET_HEADER_HEIGHT_KEY`, `useTicketTable` returns it, `ConversationList` binds `:start-margin="showExpandedCards ? fmTicketHeaderHeight : 0"`. Verified on 162 tickets: one page per scroll step, zero blank probes at 16 positions, no jumps; group headers land at the right offsets. The row has two roots (group header + row); only the row carries `conversation`/`active` for Alt+J/K.
- **Look:** rows `h-10` (40 px, Zendesk density); group headers above each priority group. **Typography (29 Sep, user: "font doesn't give a professional vibe"):** Chatwoot's own refined scale — Inter at 420–520 with slight negative tracking (`text-body-main` style). Subject 14 px 460 (unread 520, not 600); cells 13 px 420; primary = subject, requester, priority (slate-12); secondary = requested, group, assignee, channel, updated (slate-11); dates/counts `tabular-nums`; column titles + group headers 12 px 520 muted; tab bar 13 px (active 520). **Calmer:** status = coloured dot + word (was a filled soft-tint pill), no requester avatars, unread = quiet brand-tint pill (`bg-n-blue-3 text-n-blue-11`, i.e. tomato) instead of upstream's solid green `UnreadBadge`. **Font:** Inter kept after an Inter vs system-font (SF Pro / Segoe UI) comparison — same letters on every agent's OS. Rest of the app keeps Chatwoot's typography (a global pass would mean overriding Chatwoot classes / Tailwind config; not done).
- **Blast radius:** the main list for everyone on ≥ 1024 px screens (mobile keeps upstream's condensed cards).
- **Tests:** `flightsmojo/tickets/specs/{ticketTable,FmTicketRow,FmTicketTableHeader}.spec.js` (22 tests).
- **After merge, check (silent breakage!):** the `<Virtualizer>` in `ConversationList.vue` still gets our `:start-margin` (and virtua still has that prop — `node_modules/virtua/lib/vue/Virtualizer.d.ts`); props/emits of `components-next/Conversation/ConversationCard/ConversationCardExpanded.vue` vs `FmTicketRow` (a new prop upstream passes → we must accept it); `ConversationItem.vue` handlers; `useChatListKeyboardEvents.js` selectors (`div.conversation`, `.active`); `conversationBulkActions` props; `conversationStats` getter shape.

### FM-17 — View counts
- **What:** each conversation folder in the sidebar shows its **total** matching tickets (Zendesk view counts), in upstream's `SidebarUnreadBadge` (grey pill, hidden at 0). Exact numbers: the badge's cap was raised from 99+ to 9999+ (user decision 29 Sep: "All Unsolved 99+" next to a table saying 162 was confusing). The same badge serves FM-08's channel counts and upstream's (flag-gated, off here) unread badges.
- **Channel vs folder totals (by design, user confirmed 29 Sep):** channel badges (FM-08) count **open** only — the human queue; folders like "All Unsolved" count **open + pending** (pending = bot handling). So the channel badges add up to less than All Unsolved by the number of pending tickets.
- **How:** `useFolderCounts(conversationCustomViews)` (called in `Sidebar.vue`) posts each folder's own `query` to `POST /conversations/filter?page=100000` (`COUNT_ONLY_PAGE`). `Conversations::FilterService#perform` counts the whole filtered set (`set_count_for_all_conversations`) before paginating, so `meta.all_count` is exact and the payload is empty. Permission-scoped exactly like opening the folder.
- **Load control:** trailing-edge throttle `FETCH_THROTTLE_MS` = 60 s (30 s until 8 Oct 2026 — raised after the 3000-tickets/day review: load is agents × folders × backlog, and a count-only server path + shared per-account cache were deferred to a later release; pair with Account Settings → auto-resolve after N days to bound the backlog), `MAX_IN_FLIGHT` = 3 (`settleWithLimit`), skipped while `document.visibilityState === 'hidden'` (one catch-up round on becoming visible), round counter so a slow round never overwrites a fresher one, a failed folder keeps its last count, no state change when nothing changed.
- **Triggers:** folder list or filter edits (watch on `id:updated_at`), upstream's `fetch_conversation_stats` bus event (emitted by `actionCable.js` on conversation created / status changed / assignee changed / updated), `BUS_EVENTS.WEBSOCKET_RECONNECT`. Module-level `ref` state, no Vuex module.
- **Why not upstream's:** #14726 reverted for DB load; #14885 re-land is behind `conversation_unread_counts` + `unread_count_for_filters` (both off) and counts only unread, up to 5 min stale. `getFolderUnreadCount` is still used by upstream's count-based folder *sort* (only offered when those flags are on).
- **Tests:** `flightsmojo/folders/specs/useFolderCounts.spec.js` (7).
- **After merge, check:** `Sidebar.vue` folder children block (re-apply the `badgeCount` line); the `fetch_conversation_stats` event name / `fetchConversationStats` in `actionCable.js` (if upstream renames it, counts only refresh on folder changes and reconnects); `ConversationApi.filter` signature; `filter.json.jbuilder` meta keys; `FilterService` still counting before `.page`. If upstream ships cheap server-side totals, switch to them and delete this.

### FM-18 — Play / Next
**Removed from the branch on 8 Oct 2026** (user: "no need for now"). The notes below describe the deleted code, kept so it can be brought back. The review that day also found a bug to fix before any re-add: `releaseIfUntouched` was not awaited, so on Stop/Back the re-read landed after the route change, the store kept only the server's last message, and a ticket the agent had replied to (customer or activity line last) was released to unassigned.
- **What:** Zendesk guided mode. **Play** (table header, disabled on an empty view) opens the first ticket of the view. On the open ticket `FmPlayControls` shows "{n} left · Stop · Next ticket" beside Resolve. **Next** = the first ticket in the view's **live** order that is neither current nor played this session — so tickets that left the view (resolved, reassigned) are skipped and a new urgent ticket is served next (default sort = priority, oldest first). **Stop** returns to the view; going **Back** (list route, no conversation id) ends Play via a route watch in `FmTicketTableHeader`. When the *loaded* tickets are used up, Next calls the list's `loadMore` (passed from `ConversationList` via `useTicketTable(list, { loadMore })`) and waits for the list to grow (≤ 5 pages, 10 s each, spinner on the button), so Play covers the whole view; when the whole view is done it returns to it. **"N left"** = the view's count — folder `allCount`, or the active tab's `mineCount` / `unAssignedCount` / `allCount` (tab from `getChatListFilters().assigneeType`) — minus played tickets still in the view (first version counted only the 25 loaded rows: "Mine 91 → 24 left", user report 29 Sep).
- **Several agents on one view (claim on Play, user decision 29 Sep):** Zendesk skips tickets another agent is *viewing* (live presence; Play does not assign). Chatwoot has no presence signal (`update_last_seen` is throttled to hourly), and copying Zendesk would need a Rails/ActionCable addition, so Play **claims** instead: an **open, unassigned** ticket is assigned to the agent when Play opens it (`assignAgent`, same action as the assignee menu); a ticket owned by someone else is **skipped, never taken** — re-read with `getConversation` just before claiming, so a colleague's claim not yet delivered by websocket is respected; **pending (bot) tickets are never claimed**; leaving a claimed ticket (Next / Stop / Back) with **no reply or note by the agent since the claim** (`wroteSince`, 5 s clock-skew margin) and still open + still theirs (re-read first) **releases it to unassigned** (`agentId: null`). Remaining race: two agents claiming the same ticket within the ~100 ms between re-read and assign. Side effect in production: Chatwoot writes its usual assignment activity lines ("… self-assigned", "… removed assignee") on claimed/released tickets. Verified with two preview agents: Omar's API claim on #157 was skipped (not overwritten) although the playing agent's screen still showed it unassigned; #121 claimed then released on Next; #85 kept after a private note; #49 released on Stop.
- **Where:** `flightsmojo/play/usePlayQueue.js` (module-level `session`: active, loading, played Set, claimed Map, currentId, listPath); URLs via upstream `composables/useConversationRoutePath.js` (`buildConversationPath`, `buildConversationListPath`) so folder/label/team/inbox context is kept; the live list is registered by `useTicketTable` (`setPlayLiveList`). `ConversationHeader.vue` hook = import + `<FmPlayControls :conversation-id="currentChat.id" />` in the actions area.
- **Tests:** `flightsmojo/play/specs/usePlayQueue.spec.js` (10), Play button case in `FmTicketTableHeader.spec.js`.
- **After merge, check:** `useConversationRoutePath` signature and route names (`isOnFoldersView` etc.); `ConversationHeader.vue` actions area (re-place the tag); the list stays mounted while a ticket is open in the expanded layout (`ChatList` hidden by class) — if upstream unmounts it, the live list goes empty and Next ends Play.

### FM-19 — Tab bar
- **What:** Zendesk's top bar. **Views** tab → last conversation list route; one tab per opened ticket (status dot, requester, `#id`, subject in the tooltip, bold when unread, × / middle-click closes). Opening a ticket adds or activates its tab; closing the active tab goes to the right neighbour, else the left, else the last list; `MAX_TABS` = 12 (oldest other tab drops off). Hidden until a ticket has been opened, and below `md`. Play's Next lives in the ticket header (FM-18), not here.
- **How:** `useTicketTabs` watches `route.fullPath` — ticket routes (`isAConversationRoute(name, false, true)`, id from `conversation_id`/`conversationId`) open tabs, list routes (`isAConversationRoute(name, true, false)`) set `lastListPath`. Saved in `localStorage` key `fm.ticketTabs.<accountId>.<userId>` — **ids and paths only**; saved tabs are merged with tabs opened before the agent's data arrived. Labels from the store (`getConversationById`) with an **in-memory** copy per tab (holds customer names, never persisted) because opening a list empties the conversations store; a ticket in neither place is fetched with `getConversation` once (failed fetch → blank label, no retry loop). Reads the store via `store?.` so the bar is inert without Vuex (upstream `Dashboard.spec.js` mounts the shell without a store and passes unchanged).
- **Dashboard.vue hook:** `<router-view />` → `<div class="flex flex-col flex-1 min-w-0 min-h-0 h-full"><FmTicketTabs /><div class="flex flex-1 w-full min-h-0 min-w-0 overflow-hidden"><router-view /></div></div>`. The inner div repeats `<main>`'s flex setup so page roots (`h-full`, `flex-1`, `w-full`) behave exactly as before. (A CSS grid was planned; rejected because a hidden bar would drop the page into the auto-height first row.)
- **Verified:** conversations (list, ticket), contacts, reports (scrolls internally in 860 px), settings (inboxes, agents, labels), help centre, campaigns, inbox view: bar 40 px, page root fills the remaining 860 of 900 px, no document/main overflow; < 768 px the bar is `display:none` and the page gets 900; dark mode.
- **Tests:** `flightsmojo/tabs/specs/useTicketTabs.spec.js` (12).
- **After merge, check:** `Dashboard.vue` template (re-wrap `<router-view>`; the siblings — Copilot, MobileSidebarLauncher, FloatingCallWidget, CommandBar, modals — stay outside the wrapper); route names in `helper/routeHelpers.js` `isAConversationRoute`; `getConversation` action; reply drafts still per conversation (`store/modules/draftMessages.js`) so switching tabs keeps drafts.

### FM-20 — Sidebar list fade at the end of long lists
- **What:** upstream caps a sidebar sub-list with more than 7 items (Channels has 12 in prod) at `max-h-60` and lays a gradient + ⌄⌄ over the bottom until you scroll to the end. Its end check was `scrollHeight - scrollTop === clientHeight`; on Retina or zoomed screens `scrollTop` stops at a fraction (191.82 for 192 at 110 %), so the check never fired and the fade stayed over the last item (reported 1 Oct with "Web Tickets" greyed out at the end of Channels). Now `scrollHeight - scrollTop - clientHeight <= 1`.
- **Verified:** preview with 12 inboxes, real wheel scrolling: before the fix the fade stayed at 110 %; after it the fade hides at the end at 90 / 100 / 110 / 125 % and still shows at the top. No unit test: in jsdom the component's `useEventListener` never binds to the list element, so the scroll handler cannot be exercised there.
- **After merge, check:** the `useEventListener(scrollableContainer, 'scroll', …)` block in `SidebarSubGroup.vue`; if upstream rewrote the end check (or replaced the fade), drop this change.

### FM-21 — Canned responses never fail to insert
- **Live bug (fm3, 1 Oct):** an agent picked a canned response with `/` in a **Web Tickets** (API) conversation and nothing was inserted; console: `Token type \`code_block\` not supported by Markdown parser`. Chatwoot's tokenizer (`MessageMarkdownTransformer`, markdown-it commonmark) always recognises code blocks, quotes and lists; channels without those nodes (`FORMATTING`: API, SMS, Twilio SMS, Telegram, Instagram, TikTok, Twitter) rely on the regexes in `MARKDOWN_PATTERNS` to strip them first. The code-block pattern only knows ``` fences, so a line indented with a Tab or 4+ spaces (Word paste: `\t• item`) reaches the parser and throws. 2 of 161 live canned responses had it (`service-charge --escalation`, `e-Trip-Shield-Explanation`). Still unfixed upstream (`develop`, 22 Sep 2026). In email / chat / WhatsApp the same lines didn't crash but went out as a grey monospace code box.
- **How:** `ensureParseable(content, schema)` at the end of `stripUnsupportedFormatting` — returns the content unchanged if it parses, else the un-indented version, else plain text with every Markdown character escaped (never `{` `}`, so Liquid variables survive); acts only on a real ProseMirror schema (upstream specs pass stand-in objects). All three editor parse paths go through `stripUnsupportedFormatting` (canned response in `editorHelper.createNode`, `Editor.vue` `createState` and `insertContentIntoEditor`), so one hook covers them. Canned responses are additionally un-indented for **every** channel (`unindentPastedText`, outside ``` / ~~~ fences), which removes the grey code box in email/chat/WhatsApp.
- **Verified:** preview, Website Tickets conversation, `/tripshield-test` canned response with Tab bullets → inserted with the variable resolved, plain bullets, no code box, no console error.
- **Tests:** `flightsmojo/helpers/specs/messageMarkdown.spec.js` (10; 3 of them fail without the hook — they reproduce the live error); upstream `helper/specs/editorHelper.spec.js` (124) unchanged and green.
- **After merge, check:** `stripUnsupportedFormatting` still ends in one `return`, and is still the step before every `MessageMarkdownTransformer(...).parse` in `editorHelper.js` / `Editor.vue` (grep `\.parse(`); the `cannedResponse` case of `createNode`; if upstream adds an indented-code pattern to `MARKDOWN_PATTERNS`, `unindentPastedText` can go but `ensureParseable` stays as the safety net.

### FM-26 — Channel filter on the agents report
- **Why:** Reports → Agents summed every channel: no way to see what an agent resolved in one inbox (user, 19 Oct 2026). Inbox summary = per channel over all agents; agent summary = per agent over all channels; the Conversations report filters by one entity at a time.
- **What:** a "Channel" combobox (All channels + every inbox by name) beside the date range on Reports → Agents. Picking one narrows all six columns (conversations, first response, resolution time, reply time, resolutions) to that inbox, and the CSV download follows it (`agent-report-<date>-<channel-slug>.csv`). All agents stay listed; rows outside the channel read `--`. The choice is not kept in the URL (upstream's filter bar rewrites the query on every date change).
- **How:** `inbox_id` → `SummaryReportsController#prepare_builder_params` (added only when present, so upstream specs' exact param expectations still hold; `Current.account.inboxes.find` → 404 for a foreign id) → `BaseSummaryBuilder#data_source` → `Reports::DataSource#inbox_id` → `RawDataSource#summary_scope` and `#summary_conversation_counts` add `where(inbox_id:)`. Reporting events carry `inbox_id`, so no join. CSV: `ReportsHelper#generate_agents_report` merges `fm_channel_filter`. UI: `OverviewReportFilters` gained a `filters` slot; `SummaryReports.vue` renders `FmChannelFilter` in it for `type === 'agent'`, passes `inboxId` to `summaryReports/fetchAgentSummaryReports` and `reports/downloadAgentReports`; the API clients send `inbox_id` (axios drops `null`).
- **Attribution (unchanged, know it):** a resolution is credited to the **assignee at resolve time** (`ReportingEventListener#conversation_resolved`), not to whoever clicked Resolve; unassigned tickets count for nobody. Auto-resolve: FM-27.
- **Tests:** vitest `flightsmojo/reports/specs/{channelFilter,FmChannelFilter}.spec.js` (11); rspec `summary_reports_controller_spec.rb` (+2), `agent_summary_builder_spec.rb` (+1) — CI only.
- **After merge, check:** `RawDataSource#summary_scope` / `#summary_conversation_counts` still exist and `Reports::DataSource.for` still takes `**context`. The TODO there says rollup reads will replace raw reads: rollups have no inbox × agent cell, so when `RollupDataSource` lands the raw path must stay in use whenever `inbox_id` is set. `OverviewReportFilters.vue` left group (re-add the slot); the two params objects in `SummaryReports.vue`; `summary_reports_controller_spec` still expects `params.merge(type: :agent)`.

### FM-27 — Auto-resolutions not credited to agents
- **Why:** Account settings → auto-resolve after N days resolves tickets in the assignee's name; `ReportingEventListener#conversation_resolved` stores `user_id: conversation.assignee_id`, so a 7-day sweep would inflate every agent's Resolved count and average resolution time (user decision 19 Oct 2026: exclude).
- **How it tells:** the listener runs in Sidekiq, where `Current` is empty, and the payload only carried `performed_by: Current.executed_by` — nil for a normal agent action too (`Current.executed_by` is set only by automation rules, assignment and Captain). So `AsyncDispatcher#dispatch` adds `fm_system_action: Current.user.nil? && Current.executed_by.nil? && Current.contact.nil?` to every async payload, computed at dispatch time, still inside the request or job that made the change. True only for scheduled jobs, i.e. `Conversations::ResolutionJob`. Agents (UI/API), bulk actions and macros set `Current.user`; bots are `Current.user` too (AgentBot); automation rules and Captain set `Current.executed_by`; widget actions set `Current.contact`. The listener writes `user_id: nil` when the flag is true; account, inbox and team totals still count the resolution; rollups skip the nil agent dimension (`RollupService#build_rollup_rows`). Events without the key (sync dispatcher, jobs queued before the release) behave as before.
- **Not changed:** automation-rule and bot resolves stay credited to the assignee (upstream behaviour); the activity line "resolved automatically after N days" is untouched — it keys on `Current.executed_by`, which we do not set (setting it would silence that line, see `ActivityMessageHandler#status_change_activity`).
- **Tests:** rspec `async_dispatcher_spec.rb` (+2, one expectation widened to `hash_including`), `reporting_event_listener_spec.rb` (+2), `conversations/resolution_job_spec.rb` (+1: the enqueued event carries the flag) — CI only.
- **After merge, check:** `AsyncDispatcher#dispatch` (re-apply the merge into the payload); `conversation_resolved` in the listener still sets `user_id:` from the assignee; if upstream starts passing an actor in the payload, use theirs and drop ours.

---

## 5. Upgrade playbook

### 5.1 Conflict preview — before merging
```bash
cd ~/Work/flightsmojo/chatwoot-fork
git fetch upstream --tags
OLD=v4.18.0 NEW=v4.19.0          # the tag we're on / the tag we're going to

# Files BOTH we and upstream changed = where merge conflicts can happen
comm -12 <(git diff --name-only $OLD origin/flightsmojo | sort) \
         <(git diff --name-only $OLD $NEW | sort)

# How much upstream changed in each of them
git diff --stat $OLD $NEW -- $(git diff --name-only $OLD origin/flightsmojo)

# Every hook we placed in upstream files
git grep -n "FlightsMojo" -- app lib enterprise config theme .github
```
Map each file back to its FM-ID in §2 and read that card.

### 5.2 Silent-breakage watchlist — files we DON'T edit but depend on
A clean merge can still break these. Diff them every upgrade:
```bash
git diff --stat $OLD $NEW -- \
  app/javascript/dashboard/assets/scss/_next-colors.scss \
  app/javascript/dashboard/components-next/Conversation/ConversationCard/ConversationCardExpanded.vue \
  app/javascript/dashboard/components/ConversationItem.vue \
  app/javascript/dashboard/components/ConversationList.vue \
  app/javascript/dashboard/composables/chatlist/useChatListKeyboardEvents.js \
  app/javascript/dashboard/components/widgets/conversation/conversationBulkActions \
  app/javascript/dashboard/routes/dashboard/conversation/conversation.routes.js \
  app/javascript/dashboard/helper/URLHelper.js \
  app/javascript/dashboard/api/inbox/conversation.js \
  app/javascript/dashboard/store/modules/conversationStats.js \
  app/javascript/dashboard/store/modules/customViews.js \
  app/javascript/dashboard/components-next/sidebar/SidebarUnreadBadge.vue \
  app/views/api/v1/accounts/conversations/filter.json.jbuilder \
  app/services/filter_service.rb
```

### 5.3 Merge → verify
1. Branch `chore/upstream-<NEW>` from `flightsmojo`, `git merge $NEW`, resolve using the cards.
2. **Reinstall JS deps** (`npx -y pnpm@10 install --frozen-lockfile --config.engine-strict=false`) — a stale `node_modules` produced 152 false failures once.
3. `TZ=UTC node_modules/.bin/vitest run --no-watch --no-cache --no-coverage` (baseline 4663 passing on 4.18.0-fm3) + `node_modules/.bin/eslint` on touched files.
4. `node_modules/.bin/vite build` and check the preview (§5.4): login, list/table, sidebar counts, a conversation, dark mode.
5. PR into `flightsmojo` → upstream CI runs rspec/rubocop/brakeman. Don't merge before green.
6. Count migrations (`git diff --name-only $OLD $NEW -- db/migrate | wc -l`) → release per `system-map.md` §9 "Shipping the fork" (pg_dump first if any).
7. Update this file: churn numbers, cards that changed, drop changes upstream made redundant.

### 5.3a Local tooling gotcha — the pre-commit hook
`.husky/pre-commit` runs lint-staged: `eslint --fix` on staged `app/**/*.{js,vue}` and **`scss-lint` on staged `*.scss`**. `scss-lint` (a Ruby gem) is not installed on this Mac, so any commit with an `.scss` file fails the hook — and lint-staged then SIGKILLs the parallel eslint, which looks like an eslint crash. Run `node_modules/.bin/eslint` on the staged js/vue by hand, then commit that one with `--no-verify` (done for `b8bbdc0ed2`, with the user's OK).

### 5.4 Local preview (UI checks without touching prod)
Throwaway stack `fm-ui-preview` = prod image + a separate Postgres/Redis +
the branch's freshly built `public/vite` mounted over the image's. The
compose file lives outside the repo (Claude's session scratchpad); recreate
it from this description if needed: image `ghcr.io/mishraadityan09/chatwoot:<tag>`,
`RAILS_ENV=production`, `FORCE_SSL=false`, `FRONTEND_URL=http://localhost:3005`,
port `127.0.0.1:3005:3000`, volumes `chatwoot-fork/public/vite:/app/public/vite:ro` + each changed `public/*` file (not the whole `public/`: the image's precompiled `public/assets` must stay) + the server dirs the branch changes, on rails **and** sidekiq (since FM-23/24/25 the branch has Ruby code): `app/builders`, `app/controllers`, `app/dispatchers`, `app/helpers`, `app/listeners`, `app/models`, `app/policies`, `app/services`, `app/views`, `config/locales`, `db/migrate` (the first, third, fourth and fifth since FM-26/27, 19 Oct 2026), each as a directory mount `chatwoot-fork/<dir>:/app/<dir>:ro` (same base commit as the image; run `rails db:migrate` once),
no bot. **Worker + mail (since 29 Sep):** a `sidekiq` service on an `internal: true` Docker network only (no internet route — the daily hub.2.chatwoot.com ping, Gravatar and webhooks cannot leave; verified: DNS for the hub fails inside it) and **Mailpit** (`axllent/mailpit`, web inbox http://localhost:8025, SMTP `mailpit:1025`; env `SMTP_ADDRESS=mailpit`, `SMTP_PORT=1025`, `SMTP_ENABLE_STARTTLS_AUTO=false`, `DISABLE_GRAVATAR=true`). Without the worker, bulk actions only enqueue (`BulkActionsController#create` → job) and no websocket events flow, so bulk assign/labels/status and every live update look broken in a worker-less preview. Clear stale queues before first start (`Sidekiq::Queue.all.each(&:clear)` etc. in `rails runner`). After each `vite build`: `docker compose -p fm-ui-preview restart rails`
(production Rails caches the vite manifest). First run: `rails db:chatwoot_prepare`,
then the onboarding page creates the admin. Tear down: `docker compose -p fm-ui-preview down -v`.

Gotchas: **single-file bind mounts go stale** when git rewrites a file (new inode — e.g. a failed commit hook reverting the tree): the container then 500s on that path (`Errno::ENOENT … /app/public/manifest.json`). Fix: `docker compose … up -d --force-recreate rails`. **The scratchpad is wiped between sessions** (8 Oct: compose file, seed script and test-agent password were gone): the stopped containers keep the whole config — `docker inspect fm-ui-preview-rails-1` (Env, Mounts, Networks) is enough to rewrite the compose file, and the named volume `fm-ui-preview_pgdata` keeps the data (users: the admin login plus `test.agent@`, `preview.agent@`, `preview.omar@example.test`). Compose file rebuilt 19 Oct 2026 by a Python script from `docker inspect` (session scratchpad `preview/docker-compose.yml`); it also mounts the scratchpad `preview/` dir at `/preview:ro` so `rails runner /preview/<script>.rb` works, and a throwaway administrator `preview.reports@example.test` exists for browser checks (password in that scratchpad, not in the repo). When generating the `public/*` mount lines in zsh write `${f}:ro`, not `$f:ro` (`:r` is zsh's strip-extension modifier → `/app/public/favicono`). Sample data: a seed script (scratchpad `preview/seed.rb`, run with `rails runner` in the container) creates 3 inboxes (API / web / email), 5 teams, 5 labels, 12 conversations with subjects, priorities, booking IDs, and provision-style folders — plus a separate test agent login kept in the scratchpad.

---

## 6. Conventions (how we keep conflicts low)

1. **New files over edits.** New front-end code lives in `app/javascript/dashboard/flightsmojo/` (components, helpers, composables, specs). Store modules sit next to `inboxOpenCounts.js` in `store/modules/`.
2. **Hooks, not rewrites.** In upstream files, add the smallest call-out (an import swap, one dispatch, one component tag). Prefer files upstream rarely changes — check churn first: `git log --oneline v4.16.0..v4.18.0 -- <file> | wc -l`.
3. **Mark every upstream edit** with `FlightsMojo:` (`// FlightsMojo: …`, `# FlightsMojo: …`, `<!-- FlightsMojo: … -->`) saying why.
4. **Theme = CSS variables only** (`_flightsmojo.scss`). Never override Chatwoot class names — a renamed class breaks silently.
5. **Strings in `en/flightsmojo.json`**, never in upstream locale files (they are rewritten every release).
6. **UI only** unless explicitly agreed: no Rails/API changes for UI work; reuse existing endpoints.
7. **No edits under `enterprise/` unless unavoidable** — CI strips it, but it still has to merge (FM-09 is the exception, to keep EE behaviour compatible).
8. **Same commit updates this file.**
9. **Plain `<button>`s need `p-0`.** A global style pads every `button` element `4px 10px`; in a small fixed-size icon button that leaves no room and the icon shrinks to 0–8 px (the tab bar's × was invisible and the row ⋮ half-width until `caf037a304` / the row-menu fix). Give icon-only buttons `p-0` and the `<Icon>` `flex-shrink-0`, or use upstream's `components-next/button/Button.vue`.
