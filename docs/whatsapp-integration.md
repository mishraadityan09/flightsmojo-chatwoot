# WhatsApp Integration — What's Done, What's Left

Plain-language status of connecting WhatsApp to our self-hosted Chatwoot.
Last updated: 2026-07-29.

**No secrets in this file.** Tokens and the app secret live in `.env` (gitignored).

---

## The one-sentence version

We proved the whole thing works using a Meta *test* number. Going live means
swapping in the real number, getting Meta to approve our business, and moving
off the temporary tunnel — plus a few Chatwoot housekeeping items.

---

## How it actually works

Four things have to talk to each other:

```
Customer's WhatsApp
        ↓
   Meta's servers          ← Meta holds the phone number and routes messages
        ↓  (webhook: Meta calls US)
   Chatwoot (rails)        ← creates the contact + conversation
        ↓
   Our bot (bot/)          ← Gemini answers, or hands off to a human
        ↓
   Human agent in Chatwoot
```

The important thing to understand: **Meta calls us, we don't poll Meta.** That
means our server must be reachable from the public internet over HTTPS. This is
the single biggest difference from Zendesk, where Zendesk's servers did this
for us.

---

## Why this is more work than Zendesk

Zendesk is an official Meta partner ("Tech Provider"). They did the Meta
paperwork once, for all their customers. You clicked a button and it worked.

Self-hosting Chatwoot means **we are our own provider**. The work didn't
appear out of nowhere — it just stopped being hidden. Roughly half the
remaining list would have been required with Zendesk too (business
verification, templates, billing); the other half is the price of self-hosting.

---

## What's working right now

Tested end-to-end on 2026-07-29:

- ✅ Messages from a phone arrive in Chatwoot and create a conversation
- ✅ Agents can reply from Chatwoot and it reaches the phone
- ✅ The Gemini bot answers, looks up bookings, and hands off to a human
- ✅ Delivery receipts (sent / delivered / read) come back

**But this is all on a Meta test number** (`+1 555 641 7975`), which:

- only talks to phone numbers we explicitly allow-list (max 5)
- expires after 90 days
- can never be given to customers

### Reference IDs

| Thing | Value |
|---|---|
| Meta app | `FlightsMojo Support` — `1713817676541417` |
| WhatsApp Business Account (WABA) | `1037638598623900` |
| Test phone number ID | `1273116309212279` |
| Chatwoot inbox | id `5` — "FlightsMojo WhatsApp (Test)" |

⚠️ Do **not** use the app called `FlightsMojo Support - Test1`
(`1030567489895817`). It has no WhatsApp capability — Meta test *apps* can't do
WhatsApp. This cost us time; don't repeat it.

---

## What's left before customers can use it

### 1. Move the real phone number — start this first

`+91-7699976888` (the number on our website and in every canned response) has
to move onto Meta Cloud API.

**This is disruptive and one-way:**

- Whatever handles that number today stops receiving on it the moment it moves
- No chat history comes across
- Meta reviews the display name, which takes time
- It becomes a **new inbox** in Chatwoot — the test inbox stays behind

Needs a maintenance window and a heads-up to the support team. Everything else
on this list is a day or two of work; this one waits on Meta, so start it now.

### 2. Meta approvals

- **Business Verification** — Meta verifies FlightsMojo is a real company.
  Document upload + review time.
- **Publish the app** — it's currently marked "Unpublished".
- **Payment method** — real messages cost money (test numbers are free for 90
  days). We pay Meta directly, which is normally cheaper than a reseller.
- **Message templates** — to message a customer who hasn't written to us in the
  last 24 hours, Meta must pre-approve the wording. Booking confirmations,
  refund updates, etc. We have exactly one template today (`hello_world`).

### 3. A permanent web address

Right now Chatwoot is exposed through a temporary tunnel
(`*.trycloudflare.com`) that dies when the laptop session ends and gets a new
random address every restart.

Production needs the real server with a proper domain and HTTPS. When the
address changes, **two** things must be re-pointed:

1. the phone-level callback — Chatwoot does this automatically when you re-save
   the inbox
2. the app-level webhook — **manual**, this one does not fix itself

### 4. A permanent access token

The token we're using expires after about an hour. When a token expires,
sending silently stops working — nothing in the Chatwoot screen tells you why.

Replace it with a "System User" token set to never expire.

---

## Chatwoot housekeeping

- **`scripts/provision.rb` doesn't create the WhatsApp inbox.** That file is
  supposed to be able to rebuild everything from scratch. Today it only knows
  about the four website chat widgets, so a fresh install would come up without
  WhatsApp. Needs adding.
- **`INBOX_SITES` in `.env` has no entry for the WhatsApp inbox**, so the bot
  doesn't know which market it's serving and avoids currency-specific answers.
  Should point at the India entry.
- **Inbox settings were set by hand.** Ticket-style behaviour (new message after
  resolve = new conversation) was applied manually to inbox 5. Belongs in
  `provision.rb`.

---

## The gap most likely to bite us

When the WhatsApp connection breaks, Chatwoot tries to email an administrator.

**But email sending isn't configured** (`SMTP_ADDRESS` and
`MAILER_SENDER_EMAIL` are blank). So that warning goes nowhere.

In practice: WhatsApp stops working, the one thing designed to warn us silently
throws the warning away, and we find out from angry customers.

**Fix this before go-live.** Configure SMTP, or route the alert somewhere the
team actually watches.

---

## Security gap: the webhook accepts unsigned requests

Meta signs every webhook it sends (`X-Hub-Signature-256`) so we can prove a
request really came from Meta. **We don't currently check that signature.**

Chatwoot skips the check for WhatsApp channels that were set up by hand —
`meta_signature_verification_required?` returns false unless the secret is
stored on the channel itself or the channel came from embedded signup. Ours is
neither.

In practice: anyone who learns the webhook URL can POST fake customer messages
straight into the agents' queue — invented refund demands, fake complaints.

Low risk today (the URL is a random temporary tunnel address). **A real
exposure once it's a stable public domain.**

To fix, the app secret has to go into the channel's own `provider_config` under
`app_secret` — see `MetaTokenVerifyConcern::CHANNEL_APP_SECRET_KEYS`. Note:

- Setting `WHATSAPP_APP_SECRET` in `.env` does **not** do this
- Filling in Super Admin → WhatsApp Embedded does **not** do this either
- There is **no UI field** — it has to be set via the API

Do it before the production number goes live.

---

## Things Zendesk does that Chatwoot doesn't

Worth knowing before agents switch over:

| Zendesk | Chatwoot |
|---|---|
| Ticket list as a sortable table | Chat-style list, no columns to sort |
| Subject line on every ticket | **No subject field at all** |
| Views shared across the whole team | Folders are **per agent** — created for each |
| Suspended (spam) tickets | No equivalent — spam lands in the queue |
| GMB / Google review tickets | No such channel |

The conversation folders mirroring our Zendesk views are already created
(15 per agent, in `provision.rb`). The missing subject line matters most on
**email**, where agents currently scan by subject.

---

## An easier path, if this feels like too much

**360dialog** is a reseller that Chatwoot supports out of the box. They hold the
Meta relationship; we paste one API key instead of managing app secrets,
webhooks, and tokens. We'd pay them a margin — which is what we pay Zendesk
today, so it may still be cheaper.

Worth pricing before committing to the direct route. Trade-off: no WhatsApp
voice calling.

---

## UI runbook — connecting a WhatsApp number

No terminal needed. Follow in order; **the order matters** (step 4 explains why).

### 1. Collect the details from Meta

`developers.facebook.com` → your app → **WhatsApp → API Setup**

Copy three things:

- **Phone number ID** (a long number, *not* the phone number)
- **WhatsApp Business Account ID**
- **Access token** — use a permanent System User token, not the temporary
  one on this page (see "A permanent access token" above)

### 2. Create the inbox in Chatwoot

**Settings → Inboxes → Add Inbox → WhatsApp**, provider **WhatsApp Cloud**:

| Field | What to enter |
|---|---|
| Inbox name | e.g. `FlightsMojo WhatsApp` |
| Phone number | with country code, e.g. `+919876543210` |
| Phone number ID | from step 1 |
| Business account ID | from step 1 |
| API key | the access token from step 1 |

Chatwoot checks the credentials with Meta when you save. If they're wrong it
refuses to save — that's the credentials check working, not a bug.

### 3. Add agents

**Settings → Inboxes → (your inbox) → Collaborators** — add the agents who
should see these conversations. Nobody sees the inbox until they're added here.

### 4. Give Meta the webhook address

⚠️ **This is the step people miss, and it fails silently.**

On save, Chatwoot tries to register the webhook with Meta automatically. On a
fresh Meta app this **fails**, because Meta requires an app-level webhook to
exist first:

```
(#100) Before override the current callback uri, your app must be
subscribed to receive messages for WhatsApp Business Account
```

The inbox still saves and looks completely healthy. It just never receives
anything. To fix:

1. In Chatwoot: **Settings → Inboxes → (your inbox) → Configuration**.
   Copy the **Callback URL** and the **Webhook Verification Token**.
2. In Meta: **WhatsApp → Configuration** → Edit, paste both, **Verify and save**.
   Subscribe to the `messages` field.
3. Back in Chatwoot, **re-save the inbox** — this retries the registration,
   which now succeeds.

Only needed once per Meta app, not per number.

### 5. Make it behave like a ticket queue

**Settings → Inboxes → (your inbox) → Settings**, match the website inboxes:

- **Enable CSAT** — ask for a rating on resolve
- **Disable "allow messages after resolved"** — a new message starts a new
  conversation instead of reopening the old one

The second one matters: without it the bot never picks up follow-ups, because
reopened conversations are `open` rather than `pending`, and the bot only
handles `pending`.

### 6. Attach the bot

**Settings → Inboxes → (your inbox) → Bot Configuration** → select
*FlightsMojo Assistant*.

Only conversations created **after** the bot is attached are handed to it.
Existing ones stay with humans forever.

### 7. Test it

1. Add your own mobile to the allow-list (test numbers only) — Meta's API Setup
   page, **To** → Manage phone number list, then confirm the code
2. From Meta's API Setup, **Send message** to yourself — proves outbound
3. Reply from your phone — proves inbound
4. The conversation should appear in Chatwoot, and the bot should answer

If outbound works but nothing arrives, go back to step 4.

---

## Suggested order

1. Start the phone number migration + Business Verification (they wait on Meta)
2. Configure SMTP so failures are visible
3. Deploy to the real server with a proper domain
4. Create a permanent token
5. Write and submit message templates
6. Tidy `provision.rb` so a rebuild reproduces all of this
7. Train agents on folders-instead-of-views before cutover
