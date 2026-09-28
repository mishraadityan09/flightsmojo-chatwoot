# Email Integration — R&D: per-country mailboxes forwarded into Chatwoot

Plain-language research write-up for connecting the per-country support
addresses to our self-hosted Chatwoot, so every email to a country address
becomes a ticket in that country's inbox and agents reply from Chatwoot into
the customer's mail thread.
Last updated: 2026-09-23. Status: **research done, nothing built or changed.**

**No secrets in this file.**

---

## The one-sentence version

The Microsoft 365 admin gives us one address per country and forwards each to
a private Chatwoot address; to make those forwards land we run a small mail
receiver on our own server, and to send replies we use Amazon SES — no
Chatwoot code changes, one env change on the server, and DNS records from
whoever owns the domains.

---

## What Chatwoot supports (from its own docs)

Chatwoot's developer docs list five ways to run an email inbox
(https://developers.chatwoot.com/self-hosted/configuration/features/email-channel):

1. Google OAuth (sign in with a Google Workspace mailbox)
2. Microsoft OAuth (sign in with a Microsoft 365 mailbox)
3. Standard IMAP + SMTP with a username and password
4. **Forwarding rule** — the mailbox forwards to Chatwoot's "ingress
   address"; Chatwoot sends replies through SMTP
5. IMAP inbound + Chatwoot's global mailer for outbound

The admin's plan ("he will forward it") is option 4. The user guide the team
shared
(https://www.chatwoot.com/hc/user-guide/articles/1677843043-how-to-setup-an-email-channel)
is the click-through for it: **Settings → Inboxes → Add Inbox → Email**, enter
a channel name and the support address, **Create Email Channel**, add agents;
the inbox's **Configuration** tab then shows three blocks: *Forward to
Email*, *Configure IMAP*, *Configure SMTP*. We only use the first, and
optionally the third.

Options 1–3 are ruled out by the mailbox side: Microsoft retired password
IMAP in 2022 and is retiring password SMTP at the end of 2026, and OAuth
needs a sign-in per mailbox, which the admin is not offering.

---

## How the forwarding route works

```
customer ─▶ care@flightsmojo.in (Microsoft 365)
                 │  admin's forwarding rule, "keep a copy"
                 ▼
          a1b2…@inbound.flightsmojo.com     ◀── one address per Chatwoot inbox
                 │  MX record → our mail receiver
                 ▼
          Postfix on the Chatwoot server (port 25)
                 │  HTTPS POST of the raw email, basic-auth
                 ▼
          Chatwoot  /rails/action_mailbox/relay/inbound_emails
                 │  matches the address → "India · Email" inbox
                 ▼
          conversation → agent reply → Amazon SES → customer's thread
```

**Per-country routing is automatic, on two keys.** Postfix runs the
hand-off with pipe flag `O` (+ `chatwoot_destination_recipient_limit = 1`),
which prepends `X-Original-To: <forwarding address>` to every message;
Chatwoot's finder reads that header, so the per-inbox address routes even when
the To: header is odd (BCC, alias, distribution list). Chatwoot generates a different
forwarding address for every inbox (`<random-hex>@<inbound domain>`, from the
fork's `app/models/channel/email.rb`). A forwarded mail can only land in the
inbox whose address it was sent to. As a second key, Chatwoot also matches the
original **To** header (`care@flightsmojo.in`) against the address typed into
the inbox (`app/finders/email_channel_finder.rb` checks To, Cc,
X-Original-To, then Bcc), and Microsoft's admin-level mailbox forwarding
keeps those headers intact.

**Threading.** New mail creates a conversation; a reply is matched by
`In-Reply-To` and `References` (Chatwoot docs: "message threading via
Message-ID, References, and In-Reply-To"). Two reply paths both work:

- The customer hits Reply on our email. Chatwoot's Reply-To is
  `reply+<conversation-uuid>@inbound.flightsmojo.com`, so the reply comes
  straight to our receiver and is matched by the UUID.
- The customer writes to `care@…` again. The mailbox forwards it and Chatwoot
  matches it by the headers into the same conversation.

**What the customer sees on a reply** depends on one setting per inbox:

| Inbox SMTP block | From | Reply-To |
|---|---|---|
| Not configured (default) | the global sender, e.g. `FlightsMojo <noreply@flightsmojo.com>` | `reply+<uuid>@inbound.flightsmojo.com` |
| Configured with SES credentials | **`care@flightsmojo.in`** with the agent's name | `reply+<uuid>@inbound.flightsmojo.com` |

(From the fork's `conversation_reply_mailer_helper.rb`.) Sending as the
country address needs that country's domain verified in SES with DKIM and
SPF records — see "Sending".

**Body.** The reply email carries only the agent's message and signature, not
the quoted history; the customer's mail client threads it anyway.

---

## Receiving: the choices, and why Postfix on our server

Chatwoot delivers forwarded mail through a Rails "ingress". Supported values
of `RAILS_INBOUND_EMAIL_SERVICE`
(https://developers.chatwoot.com/self-hosted/configuration/features/email-channel/ingress-providers):
`relay` (Exim/Postfix/Qmail — our own mail server), `sendgrid`, `mailgun`,
`mandrill`, `postmark`, `ses`. Whatever we pick must own the MX record of the
inbound domain.

| Option | Cost | Attachment limit | Server changes | Verdict |
|---|---|---|---|---|
| **Postfix on the Chatwoot box** (`relay`) | none | what we set (30 MB) | install Postfix, open port 25 | **Recommended** |
| Amazon SES → SNS (`ses`) | cents | **150 KB, larger mail bounces** | none | Not usable for a support desk |
| Postmark (`postmark`) | paid plan | 35 MB | none | Fallback if we don't want Postfix |
| SendGrid / Mailgun / Mandrill | paid | 30 MB-ish | none | No advantage over Postmark |
| getmail6 polling the mailbox → relay | none | n/a | install getmail | needs OAuth to M365 — same blocker as sign-in |

Why SES is out: Chatwoot's SES guide
(https://developers.chatwoot.com/self-hosted/configuration/features/email-channel/amazon-ses-ingress)
uses an SES receipt rule with the **"Publish to SNS topic"** action. AWS's
own documentation for that action says: *"the maximum email size (including
headers) is 150 KB. Larger emails will bounce."* Any screenshot or PDF from a
customer would be returned to them. SES can receive in our Mumbai region
(`inbound-smtp.ap-south-1.amazonaws.com`), but that limit alone rules it out.

Why Postfix is fine here: Chatwoot's docs warn that *"running your own mail
server comes with deliverability and security responsibilities"* — that
warning is about **sending** (IP reputation, SPF/DKIM). We would only
**receive**, on a subdomain nobody else uses, and hand every message to
Chatwoot on the same machine. Deliverability stays with SES.

### What Postfix does, concretely

Rails' relay ingress accepts an HTTP POST of the raw message with
`Content-Type: message/rfc822` and basic auth `actionmailbox:<password>`
(Rails guide, Action Mailbox → Exim/Postfix/Qmail; Chatwoot's
ingress-providers page shows the same curl). `scripts/email/postfix-setup.sh`
configures Postfix as a **receive-only** relay:

- accepts mail **only** for `inbound.flightsmojo.com` (`relay_domains`);
  `mydestination` empty, so nothing is delivered locally;
- **relays for nobody**, not even localhost (`smtpd_relay_restrictions =
  reject_unauth_destination`);
- **never sends outward**: `default_transport = error:…`, so anything not for
  the inbound domain dies locally with a log line; no bounces leave, no IP
  reputation is at stake;
- 30 MB message limit, STARTTLS offered (Ubuntu's default certificate),
  IPv4 only, `HELO` required, `VRFY` off, queue lifetime 3 days;
- pipes each message to `/usr/local/bin/chatwoot-ingress` with
  `flags=RO` and `chatwoot_destination_recipient_limit = 1`, so every
  message carries `X-Original-To: <the forwarding address it was sent to>`;
- at most **2 parallel hand-offs** (`chatwoot_destination_concurrency_limit = 2`)
  so a queue flush after an outage cannot swamp Chatwoot's web workers;
- the `master.cf` entry is written with `postconf -M`, so re-running the
  script replaces it rather than appending a duplicate;
- the hand-off sends `X-Forwarded-Proto: https`: **production runs
  `FORCE_SSL=true`** (found 28 Sep during step 6 — the local health probe got
  redirects, never 200), and Rails 301s plain HTTP on the local port. With the
  header the request stays local (no nginx body limit) and is not redirected;
- the hand-off script POSTs to `http://127.0.0.1:3001/rails/action_mailbox/relay/inbound_emails`
  (Chatwoot's published port; no nginx, no TLS needed) and exits **75 on any
  non-2xx**, which makes Postfix keep the message and retry.

**Validated 25 Sep 2026** in a disposable `ubuntu:26.04` container against a
fake endpoint that checks auth + content type
(`scripts/email/test/run-in-docker.sh`):

| Check | Result |
|---|---|
| install + configure on a clean box, self-test | HTTP 204, `status=sent` |
| mail To: care@… forwarded to `a1b2c3@inbound…` | delivered with `X-Original-To: a1b2c3@inbound…`, To: preserved |
| Chatwoot down | `status=deferred`, message kept in queue; delivered on flush when back |
| mail for gmail.com / flightsmojo.com from outside and from loopback | `554 Relay access denied` |
| locally submitted foreign mail | bounced locally: "receive-only relay"; **0** outbound connections |
| STARTTLS / SIZE advertised on port 25 | yes / 31457280 |
| both scripts run twice (review pass, 28 Sep) | same password kept, no duplicate keys, one `master.cf` entry, two separate backups outside the repo |
| hand-off secret file unreadable | `deferred`, delivered once restored — never bounced |

Notes: the inbound domain is deliberately **not** in `mydestination`
(that produces the *"User unknown in local recipient table"* failure of
Chatwoot issue #6438). Exchange Online retries for **24 h** (30 min, then
hourly) before an NDR, so a Chatwoot outage under a day loses nothing.
Postfix logs to the journal (size-capped); ~20 MB RAM.

### AWS and DNS for receiving

| Where | What |
|---|---|
| EC2 security group `sg-018f8f5eec9fbe929` (chatwood-server-sg) | allow inbound TCP **25** from anywhere (IPv4 + IPv6). Seen 25 Sep: 22 (two admin ranges), 80, 443 — and **3001 open to 0.0.0.0/0**, which is unnecessary (compose binds 3001 to 127.0.0.1 only) and should be removed in the same edit. |
| EC2 | **Elastic IP confirmed 25 Sep 2026: `65.0.152.108`** attached to `i-0a1861ad886af298e` (chatwood-server, VPC flightmojo-prod-vpc, public subnet). No IP change on stop/start. |
| DNS for flightsmojo.com (**GoDaddy** — nameservers `ns29/ns30.domaincontrol.com`; all four country domains are on GoDaddy DNS). **Both records added and verified 25 Sep 2026** (`mx` → 65.0.152.108, `inbound` MX 10 → mx.flightsmojo.com, parent MX untouched). | In GoDaddy → Domains → flightsmojo.com → DNS → Add record. GoDaddy's *Name* field takes only the label: `A` name `mx` value `65.0.152.108`; `MX` name `inbound` value `mx.flightsmojo.com` priority `10`. |

Nothing else on AWS: no S3, SNS, Lambda or SES receiving.

---

## Sending: reuse the company's Netcore account (SMTP relay)

**Confirmed 25 Sep 2026:** the website and backend send all mail through
**Netcore** (Netcore Cloud Email API); the backend also exposes an internal
`POST /api/v1/Email/Sendmail` wrapper (fromEmail, toEmail, cc/bcc, subject,
body, one attachment). Chatwoot cannot use that wrapper — it sends only via
SMTP, and the wrapper carries no `Message-ID`/`In-Reply-To`/`References`
headers and only one attachment, so replies would not thread into the
customer's mail chain. Netcore offers **SMTP relay on the same account**, so
Chatwoot sends through Netcore directly (docs:
https://emaildocs.netcorecloud.com/docs/smtp-integration-with-netcore):

| Setting | Value |
|---|---|
| Host | `smtp.netcorecloud.net` |
| Port | `587` (25 and 2525 also offered), STARTTLS on |
| Username / password | Settings → Integrations → SMTP Relay: username `flightsmojo_eapi`, password behind SHOW (= Netcore profile password by default). **Decision 25 Sep 2026: Netcore config stays exactly as it is** — no subaccount, no password change, no Allowed-IPs lock; Chatwoot uses the existing credentials as-is. Consequence: rotating that password later means updating Chatwoot's env too. |
| Port choice | **587, not 25**: AWS throttles outbound port 25 from EC2 |
| Login verified | **25 Sep 2026, from the laptop:** STARTTLS on 587, server offers PLAIN/LOGIN, `235 Authentication successful` with `flightsmojo_eapi` — so `SMTP_AUTHENTICATION=plain` is right |
| Send test | **25 Sep 2026 18:42 IST:** one message from `FlightsMojo Support <noreply@flightsmojo.com>` via the relay reached an Outlook 365 **Focused inbox** (not junk). Outbound path proven end to end. |
| `.env` gotcha | the Netcore password contains a `$`. In `.env` write it **single-quoted**: `SMTP_PASSWORD='…'` — docker compose interpolates `$name` in unquoted/double-quoted values and would mangle it |

To do in Netcore before the pilot:
1. ~~Confirm `flightsmojo.com` is verified in Netcore~~ **Done — verified
   25 Sep 2026** (Netcore panel 207124, Settings → General → Sending
   domains: `delivery.flightsmojo.com CNAME eapi.sslind.netcorecloud.net`
   and `nc2048._domainkey CNAME dkim2048.ind.netcorecloud.net`, both
   Success). Selector is `nc2048`, which is why generic DKIM probes missed
   it. Other country domains: check the same page per domain before their
   inboxes go live.
2. Get (or create) SMTP credentials; store in a password manager.
3. Check the plan's daily/monthly limit covers ~300 extra emails/day.

These values go into `.env` (`SMTP_*`, for Chatwoot's own system mail) and
into the pilot inbox's SMTP block so replies go out **from
`care@flightsmojo.com`**. Per further country: make sure that domain is
verified in Netcore, then fill the inbox SMTP block.

*Side note:* `flightsmojo.in` also carries **SendGrid** DKIM records
(`s1/s2._domainkey → u28930571.wl072.sendgrid.net`), so a SendGrid account
exists too (legacy or website-only). Either provider works for Chatwoot;
Netcore is the current standard, so use it.

### Fallback: Amazon SES

Chatwoot's replies go out through SMTP. The server cannot do this itself —
AWS blocks outgoing port 25 on EC2 by default and a fresh IP has no
reputation — and a Microsoft 365 mailbox with a password is the Basic-auth
path Microsoft is switching off. SES in `ap-south-1` is the natural choice:
we already run there, it signs mail (DKIM) and manages reputation.

| Where | What |
|---|---|
| SES | verify `flightsmojo.com` as an identity (Easy DKIM); request **production access** (short form, ~1 day); create **SMTP credentials** |
| DNS for flightsmojo.com | 3 DKIM CNAME records from SES; add `include:amazonses.com` to the SPF record |
| Per country, if replies should come **from** `care@<country domain>` | repeat the identity + DKIM + SPF step for `flightsmojo.in`, `.co.uk`, `.id`; then fill the inbox's **Configure SMTP** block with the SES host/credentials |

Chatwoot tests the SMTP connection when the inbox block is saved
(`app/helpers/api/v1/inboxes_helper.rb`), so a wrong credential is caught
immediately.

Cost is fractions of a cent per email. While SES is still in its sandbox it
can only send to addresses we verify, which is fine for testing.

---

## Chatwoot-side changes (prod `.env`, one container recreate)

```
MAILER_INBOUND_EMAIL_DOMAIN=inbound.flightsmojo.com
RAILS_INBOUND_EMAIL_SERVICE=relay
RAILS_INBOUND_EMAIL_PASSWORD=<long random string, same one Postfix uses>

SMTP_ADDRESS=smtp.netcorecloud.net      # Netcore SMTP relay (SES fallback: email-smtp.ap-south-1.amazonaws.com)
SMTP_PORT=587
SMTP_USERNAME=<Netcore SMTP username, Settings → Integrations>
SMTP_PASSWORD=<Netcore SMTP password / API key>
SMTP_AUTHENTICATION=plain
SMTP_ENABLE_STARTTLS_AUTO=true
MAILER_SENDER_EMAIL=FlightsMojo <noreply@flightsmojo.com>
```

- `relay` is already Chatwoot's default for the ingress; we set it explicitly
  so the next person can see it.
- `MAILER_INBOUND_EMAIL_DOMAIN` **must be in the env**, not only in Super
  Admin: the dashboard shows the forwarding address only when the env var is
  present (`_inbox.json.jbuilder` → `forwarding_enabled`). Chatwoot's docs
  describe the same symptom as *"forwarding disabled … missing
  MAILER_INBOUND_EMAIL_DOMAIN"*.
- `MAILER_SENDER_EMAIL` must **not** be a country address: Chatwoot drops
  inbound mail whose sender equals it, treating it as its own notification.
- This is an env-only change, no image bump; it still follows the release
  runbook's quiet-window rule because rails and sidekiq are recreated.
- The docs' prerequisite "cloud storage must be configured" is a Chatwoot
  Cloud note; local Active Storage already holds our WhatsApp and widget
  attachments and works the same for email.

---

## Microsoft 365 side (the admin)

From Microsoft's documentation on external forwarding
(https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding):

- Use **admin mailbox forwarding** (Exchange admin center → mailbox →
  *Manage mail flow settings → Email forwarding*), not a user Inbox rule, and
  tick **keep a copy of forwarded email**. Mailbox forwarding keeps the
  original headers, which is what our per-country matching relies on.
- **External forwarding is blocked by default** in tenants created or not
  actively forwarding since 2021 (the *Automatic - System-controlled* value
  now means *Off*). If the block is on, the forward fails with
  `5.7.520 Access denied, Your organization does not allow external
  forwarding`. The admin fixes this with an **outbound spam policy** scoped
  to the support mailboxes with *Automatic forwarding = On*, or a remote
  domain entry for `inbound.flightsmojo.com` that allows automatic
  forwarding. Both are ten-minute jobs for a Microsoft 365 admin.
- Agents must **reply only from Chatwoot**. A reply sent from Outlook on the
  same mailbox never reaches Chatwoot, so the ticket history would split.

---

## Side effects the moment SMTP works (decide before Phase 3 step 6)

Found 28 Sep 2026 in the fork. Today no email leaves Chatwoot because
`SMTP_ADDRESS` is blank; after the recreate two **existing** features start
sending on their own, independent of the new email inboxes:

1. **Web-chat email continuity** (`Channel::WebWidget#continuity_via_email`,
   default **true** on every website inbox). After any outgoing, non-private
   message — **agent or bot** — in a website conversation whose contact has an
   email, `Messages::SendEmailNotificationService` schedules
   `ConversationReplyEmailJob` **2 minutes later**; `reply_with_summary` sends
   only if the visitor has not viewed the conversation since
   (`conversation_already_viewed?`), with the last 10 earlier messages plus
   the new ones, From `MAILER_SENDER_EMAIL`, Reply-To
   `reply+<uuid>@inbound.flightsmojo.com` — so the visitor can answer by email
   and it threads back into the chat. Switch per inbox: Settings → Inboxes →
   (website inbox) → Settings → *Enable conversation continuity via email*.
   WhatsApp inboxes are not affected (only WebWidget and API channels).
   **Done 28 Sep 2026: switched OFF on all five website inboxes** (India,
   UAE, US, UK, Indonesia) before SMTP was enabled; turn back on deliberately
   once email is live and tested. (India's widget also has the email collect
   box on, so many contacts carry an email address.)
2. **Agent assignment emails.** Every account user is created with
   `email_conversation_assignment` on (`AccountUser#create_notification_setting`),
   so each agent gets an email whenever a conversation is assigned to them —
   at ~600 conversations/day across 19 users that is roughly 30 emails per
   agent per day. Each agent can switch it off under Profile Settings →
   Notifications.

Also newly working: password-reset and invite emails, and the inbox
reconnect / webhook-failure alerts to admins.

## Risks and limits worth knowing

- **Postfix is a new service on a small (3.8 GB) box** that has had one
  outage. Mitigations: it is ~20 MB, journald caps its logs, and the compose
  health check already watches disk. If we would rather not, Postmark is the
  drop-in managed alternative (same env keys except the service name).
- **Port 25 open to the internet.** Postfix only accepts mail for
  `inbound.flightsmojo.com` and relays nothing, which is the standard safe
  posture; expect background scanner noise in the log.
- **Spam.** Whatever the country mailbox accepts gets forwarded, so Microsoft's
  filtering still applies before us. We do not filter again (Chatwoot's SES
  guide says the same: no spam scanning needed on the ingress).
- **Big attachments.** Incoming: Chatwoot keeps the last 15 attachments per
  email and truncates text at 150,000 characters. Outgoing: up to 20 MB are
  attached, larger files become download links.
- **One inbound domain for all countries** is fine; the per-inbox random
  address does the separation. Country isolation for agents is via
  Collaborators per inbox, as with the widgets.
- **Bots.** If the FlightsMojo bot is ever attached to an email inbox, it
  receives email conversations exactly like web chat and its answers go out
  as emails. Keep it off for email until decided.

---

## The process — five phases, one downtime window

Each phase ends with a check that must pass before the next starts. "You"
= runs the AWS console, DNS requests and server commands; "me" = prepares
configs, commands, test scripts and docs; "admin" = the Microsoft 365 admin.

### Phase 0 — confirmations, nothing changes
- Admin answers the five questions below; DNS owner identified.
- Decisions locked: Postfix on the box, From address policy, bot off.
- Optional: the read-only prod env check (`FRONTEND_URL`, `SMTP_*`).
- **Gate:** answers in, decisions written here.

### Phase 1 — local dry run on the laptop, zero prod impact
> **Decision 25 Sep 2026: skipped.** `care@flightsmojo.com` is not published
> to customers yet, so all testing happens directly on production with that
> address; it goes on the website only after the Phase 4 tests pass. Cost of
> skipping: any wrong env value means one more rails/sidekiq recreate (~1–2
> min blip). Postfix itself can be fixed live without touching Chatwoot.
- Local `.env`: `MAILER_INBOUND_EMAIL_DOMAIN`, `RAILS_INBOUND_EMAIL_PASSWORD`;
  recreate local rails + sidekiq.
- Create an Email inbox locally; confirm the forwarding address appears.
- Run the draft Postfix config in a throwaway container pointed at the
  local Chatwoot; send it a saved `.eml`; watch the conversation appear.
  Also test with Chatwoot stopped: the mail must queue, not bounce.
- **Gate:** email → conversation on the laptop with the exact Postfix files
  we will ship; failure mode verified.

### Phase 2 — AWS and DNS groundwork, no downtime
- Elastic IP: confirm attached (or attach). Security group: allow TCP 25.
- SES (ap-south-1): verify `flightsmojo.com`, request production access,
  create SMTP credentials. S3 bucket + IAM user for attachments.
- DNS: `A mx.flightsmojo.com`, `MX inbound.flightsmojo.com`, SES DKIM
  CNAMEs, SPF include.
- EBS: **done 28 Sep 2026** — `vol-05fce695a2490de55` modified 30 → 60 GiB (gp3, 3000 IOPS, 125 MiB/s unchanged), `growpart` + `resize2fs` run online; `/` now 58G, 13G used, 45G free.
  Swap: **done 28 Sep 2026** — 2 GB `/swapfile`, in fstab, swappiness 10 (`free -h`: Swap 2.0Gi, 0 used). Still to do: daily snapshot policy, 14-day retention.
- **Gate:** DNS resolves from outside; SES sends to a verified test address;
  `df -h` shows the new size; `swapon --show` shows swap; first snapshot exists.

### Phase 3 — the quiet window on the server (15–30 min downtime)
1. Announce; take a manual snapshot.
2. Stop → change to t3.large → start; confirm all containers up.
3. `bash scripts/email/env-setup.sh` (writes the inbound + Netcore lines
   into `.env`, generates the shared password), then `nano .env` to paste
   the Netcore SMTP password **single-quoted**, then
   `docker compose up -d --no-deps rails sidekiq`. **`--no-deps` is
   essential:** postgres, redis and the bot read the same `.env`, so without
   it compose would recreate them too. The next *full* `docker compose up -d`
   (e.g. a future release) will recreate them once for the same reason —
   expected, and harmless now that the postgres bind mount is in the file.
4. `bash scripts/email/postfix-setup.sh` (installs + configures Postfix,
   installs the hand-off script, runs a self-test that must print HTTP 204
   and `status=sent`). `bash scripts/email/server-prep.sh` for swap + disk
   can run any time before or after.
5. Checks: site answers; an agent invite / password-reset mail arrives via
   SES; a mail from Gmail to `test@inbound.flightsmojo.com` shows in the
   Postfix log as accepted and handed to Chatwoot with a 2xx (Chatwoot
   ignores unknown addresses, so nothing is created yet).
- **Before creating any inbox, check in Super Admin:** Settings → Email →
  *Inbound Email Domain* is blank-never-saved **or** `inbound.flightsmojo.com`
  (set it to that to be safe), and Accounts → FlightsMojo → *domain* is
  blank. Chatwoot picks the forwarding domain as account domain →
  Super Admin value → env, and a Super Admin value saved as an empty string
  wins over the env and yields addresses like `abc123@` with no domain.
  After creating the inbox, its forwarding address **must** end in
  `@inbound.flightsmojo.com`. Saving that Super Admin page with the two
  email-limit fields blank is safe: `AccountEmailRateLimitable` returns early
  unless `ChatwootApp.chatwoot_cloud?`, and the plan-limit reader is
  enterprise-only code, which our CE image does not ship.
- **Rollback:** revert `.env` + `compose up -d --no-deps rails sidekiq`; stop Postfix; instance type
  back with another stop/start; snapshot restore as last resort.
- **Gate:** relay reachable from the internet end-to-end; SES sending works.

### Phase 4 — pilot inbox: `care@flightsmojo.com` (UI only)
- Add Inbox → Email → *Other providers*: name `USA · Email`, address
  `care@flightsmojo.com`. Collaborators; signatures; Bot = None.
- Configure SMTP block with the SES credentials so replies come **from**
  `care@flightsmojo.com`. (flightsmojo.com is already verified in SES.)
- Copy the forwarding address; send the admin the one-line rule plus
  "keep a copy" and "external forwarding must be allowed".
- Tests from a personal Gmail: inbound with attachment lands in the USA
  inbox; reply from Chatwoot arrives from care@ inside the same Gmail
  thread; reply from Gmail appends to the same conversation; reply to a
  resolved conversation reopens it; a large attachment goes out as a link.
- Run in parallel with today's handling for 2–3 days of real mail.
- **Rollback:** admin removes the rule; mail is still in the mailbox.
- **Gate:** all tests pass; agents have handled real tickets from it.

### Phase 5 — go-live and rollout
- Agent rule: reply only from Chatwoot. Cut over the US email path.
- Per additional country: inbox + rule; optionally SES-verify that domain
  and fill the SMTP block so replies come from the country address.
- Watch for two weeks: memory available, CPU credit balance, Sidekiq
  latency → decide on t3.xlarge before the remaining countries.
- Housekeeping: Postfix files into `scripts/` in this repo; prune the old
  4.16 image; record addresses, inbox IDs and DNS here and in
  `docs/system-map.md` §16.

**Elapsed time, realistically:** Phase 1 half a day; Phase 2 one to two
days, mostly waiting on SES approval and DNS; Phase 3 one evening; Phase 4
two to three days of parallel running.

---

## Server scripts (`scripts/email/`, added 25 Sep 2026)

All idempotent, run as root from the server's clone of this repo
(`/root/flightsmojo-chatwoot`, `git pull` first). None prints a secret.

| Script | Does |
|---|---|
| `env-setup.sh` | backs up `.env` to `/root/env-backups/` (outside the git clone — `.gitignore` covers only `.env`); warns on duplicate keys; sets `MAILER_INBOUND_EMAIL_DOMAIN`, `RAILS_INBOUND_EMAIL_SERVICE=relay`, generates `RAILS_INBOUND_EMAIL_PASSWORD` if empty; sets Netcore `SMTP_*` (host/587/user/plain/STARTTLS/domain) and a default `MAILER_SENDER_EMAIL`; leaves `SMTP_PASSWORD` for `nano` (single-quoted); prints the recreate command **with `--no-deps`** |
| `postfix-setup.sh` | preseeds + installs Postfix; `postconf -e` receive-only settings (`mydestination` empty, `relay_domains = inbound.…`, 30 MB, no relay, TLS may); transport map → `chatwoot` pipe service in `master.cf`; installs `/usr/local/bin/chatwoot-ingress` and `/etc/postfix/chatwoot-ingress.env` (root:nogroup 0640, password copied from `.env`); self-test: direct POST (expect 204) + `sendmail` through the queue |
| `chatwoot-ingress` | the pipe target: `curl` the raw message to the relay endpoint; exit 0 on 2xx, **75 (retry later) on anything else**, so nothing bounces |
| `server-prep.sh` | 2 GB swap file (+ fstab, swappiness 10); `growpart` + `resize2fs`/`xfs_growfs` after an EBS resize |
| `check.sh` | read-only: env keys present, containers, DNS, port 25, queue length, endpoint returns 204, last Postfix events |
| `test/run-in-docker.sh` | laptop only: runs everything above in a throwaway Ubuntu 26.04 container against a fake Chatwoot; the way to re-prove the scripts after any edit |

Rollback: `env-setup.sh` writes `/root/env-backups/env-<timestamp>-<pid>.bak`;
`systemctl disable --now postfix` stops receiving; nothing in the Chatwoot
image changes.

## Questions for the admin

1. Which address per country, and are all of them in the **same** Microsoft
   365 tenant? **Pilot decided 23 Sep: `care@flightsmojo.com` (USA).**
   Its domain is the one we verify in SES anyway, so the pilot inbox can
   reply *from* `care@flightsmojo.com` with no extra DNS work. Other
   countries follow as inbox + forwarding rule each.
2. Can he set **admin mailbox forwarding with keep-a-copy** and switch on
   **external forwarding** for those mailboxes (or for the domain
   `inbound.flightsmojo.com`)?
3. Who manages **DNS** for `flightsmojo.com` and for the country domains?
   We need: one A and one MX record on flightsmojo.com; per country, three
   DKIM CNAMEs and one SPF edit if replies should come from that country's
   address.
4. Does anyone currently read or reply from these mailboxes in Outlook?
   (They will need the "reply only from Chatwoot" rule.)
5. How does mail reach Zendesk today, so the cut-over does not double-handle
   tickets?

## Decisions for us

1. Postfix on the Chatwoot server (recommended) or Postmark (paid, no server
   change) for receiving.
2. Replies from `noreply@flightsmojo.com` for all countries, or from each
   country address (needs the per-country DNS work).
3. Bot on email inboxes: off to start (recommended).

---

## Sources

- Chatwoot user guide, *How to setup an Email channel*:
  https://www.chatwoot.com/hc/user-guide/articles/1677843043-how-to-setup-an-email-channel
- Chatwoot developer docs, email channel overview and sub-pages
  (forwarding, ingress providers, Amazon SES ingress, conversation
  continuity, Azure app setup):
  https://developers.chatwoot.com/self-hosted/configuration/features/email-channel
- Rails guide, Action Mailbox (relay ingress, Postmark/SendGrid webhook
  formats): https://guides.rubyonrails.org/action_mailbox_basics.html
- AWS, SES receipt-rule SNS action and its 150 KB limit:
  https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-sns.html
- Microsoft, external email forwarding controls and 5.7.520:
  https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding
- Microsoft, SMTP AUTH Basic-auth retirement timeline (end of 2026):
  https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835
- Microsoft, Exchange Online retry and expiration intervals (24 h):
  https://learn.microsoft.com/en-us/exchange/mail-flow/queues/message-intervals
- Postmark inbound limits (35 MB) and inbound domain forwarding:
  https://postmarkapp.com/developer/user-guide/inbound/inbound-domain-forwarding
- Chatwoot issue #6438 (Postfix "User unknown in local recipient table"):
  https://github.com/chatwoot/chatwoot/issues/6438
- Chatwoot issue #13043 (Microsoft channel needs a multi-tenant Azure app):
  https://github.com/chatwoot/chatwoot/issues/13043
- Fork code read on 2026-09-23 (upstream 4.18.0, unchanged by us):
  `app/models/channel/email.rb`, `app/finders/email_channel_finder.rb`,
  `app/mailboxes/*`, `app/mailers/conversation_reply_mailer_helper.rb`,
  `app/views/api/v1/models/_inbox.json.jbuilder`, `config/initializers/mailer.rb`.

## Appendix — the sign-in (OAuth) route, kept for reference

If the admin ever offers a **login per mailbox** instead of forwarding,
Chatwoot's Microsoft channel is simpler: register one multi-tenant Azure app
with redirect `https://chat.flightsmojo.com/microsoft/callback`, paste its ID
and secret into **Super Admin → Settings → Microsoft**, then *Add Inbox →
Email → Microsoft → Sign in* as each mailbox. Needs a licensed user mailbox
(shared mailboxes cannot sign in), IMAP and Authenticated SMTP enabled on it,
and a calendar reminder for the client-secret expiry. No server or DNS work.
Details are in the Chatwoot Azure guide:
https://developers.chatwoot.com/self-hosted/configuration/features/email-channel/azure-app-setup
