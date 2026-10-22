# Moving the support site and the TripShield claim portal onto the Chatwoot server — step-by-step runbook

*Written 22 Oct 2026 for someone doing this on AWS for the first time. Every step says what to
do, what you should see, why it is done, and how to undo it. Facts about the two apps were read
in their repos the same day; facts about the server come from the hub docs and the Sep–Oct 2026
work on it. Where something could not be checked from the laptop, the step starts with
"Find out" and tells you how. Read the whole thing once before doing anything.*

---

## 0. The picture

**Today**

```
help.flightsmojo.{in,co.uk,ph,ca,com,id} + help.lk.flightsmojo.com   ─┐
tripshield.flightsmojo.in                                             ─┼─► Windows "Utility Server-Email/SMS/APP"
                                                                       │    IIS + iisnode, C:\Website\…
chat.flightsmojo.com ───────────────────────────────────────────────────┼─► Ubuntu "chatwood-server" (t3.medium)
                                                                       │    nginx → Docker compose: rails, sidekiq, postgres, redis, bot
                                                                       └    Postfix (inbound email), certbot (TLS)
```

**After**

```
help.* (14 hostnames) ──┐
tripshield.flightsmojo.in ─┼─► Ubuntu "chatwood-server" (t3.large)
chat.flightsmojo.com ───┘    nginx (TLS for every hostname) →
                              compose: rails, sidekiq, postgres, redis, bot, reviews, support, claims
Windows server: keeps its .NET email/SMS/app services; the two IIS sites are stopped, not deleted.
```

**Why move at all.** The two apps are plain Next.js. On IIS they run through iisnode, a bridge
that exists only so Node apps can live inside IIS. On the Linux box they run the way Next.js is
meant to run, in a container behind nginx, deployed with the same two commands as everything
else there. The Windows server keeps its RDP brute-force history, its SQL port open to the
internet and an admin account nobody can explain; the public web apps are better off away from
it. The IIS "uploads 500" bug on the claim portal disappears with IIS.

**What does not change.** The Windows server stays, because its .NET services stay. Both apps
already need Chatwoot to be up (the help centre reads articles from it; both forms create
tickets in it), so putting them on the same box adds no new dependency.

**Rough time.** One evening for the preparation (phases A–D), one 10-minute downtime window for
the resize (phase B), one more evening for certificates and DNS (phases E–F). Nothing in
phases A, C, D or E touches the live sites.

---

## 1. Vocabulary you need (read once)

| Word | Meaning here |
|---|---|
| **EC2 instance** | A virtual machine. Ours is `i-0a1861ad886af298e`, named `chatwood-server`, in region **Asia Pacific (Mumbai) ap-south-1**. |
| **Instance type** | The size of the machine. `t3.medium` = 2 vCPU, 4 GB RAM. `t3.large` = 2 vCPU, 8 GB RAM. Changing it is called a resize and needs the machine stopped. |
| **t3 burstable / CPU credits** | t3 machines earn CPU credits while idle and spend them when busy. Our balance sits at the maximum (576), which means the CPU has never been short. Credits are lost on stop and rebuild from zero after a start; "unlimited mode" (on by default for t3) lets it burst anyway for a small charge. |
| **EBS volume** | The machine's disk, a separate AWS object that survives stop/start. Ours: `vol-05fce695a2490de55`, 60 GiB gp3, mounted as `/`. |
| **Snapshot** | A point-in-time copy of an EBS volume, stored by AWS. The way to get the whole disk back if something goes badly wrong. |
| **Elastic IP (EIP)** | A fixed public IP you own. Ours is `65.0.152.108`. Without one, a stopped-and-started instance gets a **new** public IP; with one, the address stays. This is why the resize is safe for DNS. |
| **Security group** | The instance's firewall, edited in the console. Today it allows 22 (SSH), 80, 443 and 25 (email in). |
| **EC2 Instance Connect** | The "Connect" button in the console that opens a terminal in the browser. You land as `ubuntu`; `sudo -i` makes you root. |
| **nginx** | The web server on the box. It owns ports 80 and 443, holds the TLS certificates, and forwards each hostname to the right app on a local port. |
| **certbot / Let's Encrypt** | Free TLS certificates, valid 90 days, renewed automatically by a timer on the box. Already used for `chat.flightsmojo.com`. |
| **Docker / compose** | Each app runs in a container; `docker-compose.yml` in `/root/flightsmojo-chatwoot` lists them. `docker compose up -d --no-deps <name>` starts or replaces one container without touching the others. |
| **DNS A record / TTL** | The record that says "this hostname is this IP". TTL is how long the world may cache it; lowering it before a change makes the change (and a rollback) take effect in minutes. |
| **HSTS** | A header both sites already send that tells browsers "only ever use HTTPS here". It is why the new box must have valid certificates **before** DNS points at it. |

---

## 2. Phase 0 — find out what you have (nothing changes)

> **Already answered on 22 Oct 2026 from the laptop (§2.1, §2.2):** the six live hostnames
> `help.flightsmojo.{in,co.uk,ph,ca,com,id}` and `tripshield.flightsmojo.in` are plain A records
> to **3.108.112.151** — confirmed in the EC2 console on 22 Oct 2026 as the Elastic IP
> ("CoreMainServer") of `i-0ea5e50a39ca94cb8` *Utility Server-Email/SMS/APP* (Windows, t3.medium,
> VPC `mojo-vpc-prod-vpc`); the `www.help.*` names and `help.lk.flightsmojo.com` have **no DNS
> records**; **no CDN** is in front; all six zones are on **GoDaddy** (`domaincontrol.com`
> nameservers); the records already have a **600 s TTL**, so §4.1 needs no waiting.
> Still to do yourself: §2.3 (certificate issuer on IIS — needed only for Plan B, §6.6) and
> §2.5 (IIS paths, bindings, Node version).
>
> **Answered from the box on 22 Oct 2026 (§2.4):** nginx **1.28.3** (so the `http2 on;` form in
> §6.4 is the right one); the only site file is `/etc/nginx/sites-enabled/chatwoot`; certbot holds
> one certificate, `chat.flightsmojo.com` (ECDSA, valid to 2026-12-31, standard
> `/etc/letsencrypt/live/...` paths); the certbot timer has been active since 3 Aug 2026; memory
> **3.7 GiB total, 1.8 GiB available, 370 MiB of swap in use** — the box already swaps a little
> at today's load, which is the case for the resize in §4.3; disk **58 GB, 19 GB used, 39 GB
> free** (13 GB used on 28 Sep, so ~6 GB grew in a month: new email inboxes with attachments and
> 30-day raw mail copies, plus pulled images — watch it with the §4.5 disk alarm).
>
> **The chat site file** (`/etc/nginx/sites-enabled/chatwoot`, pasted 22 Oct 2026) is in the
> certbot nginx-plugin layout (`# managed by Certbot` lines): a `listen 443 ssl` block with the
> four `ssl_*`/`include` lines, `client_max_body_size 40M`, `proxy_pass http://127.0.0.1:3001`
> with `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto $scheme`, a `/cable` WebSocket
> location, and a port-80 block that redirects `chat.flightsmojo.com` and answers 404 to any
> other hostname. **No IPv6 `listen [::]` lines and no `http2`** — the templates in §6.4 follow
> the same layout (IPv6 lines removed; `http2 on;` kept because nginx 1.28 supports it and it is
> harmless, delete the line if you prefer an exact match). Because the port-80 block answers 404
> for unknown hostnames, the `acme` site in §6.2 needs its own `server_name`, which it has.

Do these from the laptop and from the box. Write the answers down; the later phases use them.

### 2.1 Where each hostname points today

On the laptop:

```
for h in help.flightsmojo.in www.help.flightsmojo.in help.flightsmojo.co.uk www.help.flightsmojo.co.uk help.flightsmojo.ph www.help.flightsmojo.ph help.flightsmojo.ca www.help.flightsmojo.ca help.flightsmojo.com www.help.flightsmojo.com help.flightsmojo.id www.help.flightsmojo.id help.lk.flightsmojo.com www.help.lk.flightsmojo.com tripshield.flightsmojo.in chat.flightsmojo.com; do printf '%-32s %s\n' "$h" "$(dig +short "$h" | tr '\n' ' ')"; done
```

What you should see: each hostname followed by an IP, or by a name and then an IP (that is a
CNAME), or nothing (the hostname is not set up). Compare the IPs with the public IP of the
Windows server in the EC2 console (Instances → Utility Server → Public IPv4). Hostnames that do
not resolve, or point somewhere else, are simply not part of the move. If an answer is a
Cloudflare or other CDN address rather than the Windows server, stop and say so before
continuing: the certificate steps differ behind a CDN.

Why: the move is "change these records to 65.0.152.108". Knowing the current values is the
rollback.

### 2.2 Which DNS provider holds each zone

```
for z in flightsmojo.in flightsmojo.co.uk flightsmojo.ph flightsmojo.ca flightsmojo.com flightsmojo.id; do printf '%-20s %s\n' "$z" "$(dig +short NS "$z" | tr '\n' ' ')"; done
```

`domaincontrol.com` nameservers = GoDaddy (where flightsmojo.com and the country domains
checked in September live). Anything else = another provider; the DNS steps are the same, the
screens differ.

### 2.3 The current TLS certificates on IIS

In a browser open `https://help.flightsmojo.in` and `https://tripshield.flightsmojo.in`, click
the padlock → certificate. Note the **issuer** (Let's Encrypt? GoDaddy? Sectigo?) and the
**expiry date**. Why: phase E issues fresh certificates on the box; if that fails on the night,
Plan B is to export the existing ones from IIS (§6.6), and you want to know in advance that they
are not about to expire.

### 2.4 On the box

Open EC2 → Instances → `chatwood-server` → **Connect** → *EC2 Instance Connect* → Connect. Then:

```
sudo -i
cd /root/flightsmojo-chatwoot
df -h / && free -h && docker compose ps
ls /etc/nginx/sites-enabled/
cat /etc/nginx/sites-enabled/chatwoot     # the site file is a symlink: `grep -r` skips it, `cat` does not
certbot certificates
systemctl status certbot.timer --no-pager | head -5
nginx -v
```

What you should see: the disk with ~39 GB free; `free -h` with the used/available split
(write the "available" number down — it decides nothing today but is the before-figure for
phase B); the five or six containers "Up"; one nginx site file for `chat.flightsmojo.com` with
its `ssl_certificate` lines pointing into `/etc/letsencrypt/live/...`; `certbot certificates`
listing that certificate with its expiry; the timer "active (waiting)"; an nginx version
(Ubuntu 26.04 ships 1.26 or newer, which matters for the `http2` line in §6.3).

Write down the exact `listen` and `ssl_*`/`include` lines from the chat site file: the new site
files copy that house style.

### 2.5 The live app folders on Windows

RDP to the Windows server (3389 is open only to your IP). Note the two IIS sites (IIS Manager →
Sites): their physical paths (claims: `C:\Website\claimportal`; the support site: whatever IIS
shows), their bindings (which hostnames, which ports, which certificate), and the Node version
(`node -v` in a command prompt). Why: the containers must be built from exactly the code that is
live, and §3.1 checks that.

---

## 3. Phase A — get the code ready (laptop only, no live impact)

### 3.1 Freeze and commit what is live

Both repos on the laptop carry uncommitted work on feature branches:
`~/Work/flightsmojo/flightsmojo-support` on `feature/chatwoot-tickets`, and
`~/Work/flightsmojo/tripshieldclaimportal` on `feature/chatwoot-claims`. The containers will be
built from git, so git must hold what is live.

1. Copy each live folder off the Windows server (zip the site folder **without** `node_modules`,
   `.next` and `iisnode`) to the laptop, and diff it against the repo working tree:
   ```
   diff -rq --exclude=node_modules --exclude=.next --exclude=iisnode --exclude=.git ~/Downloads/support-live ~/Work/flightsmojo/flightsmojo-support
   diff -rq --exclude=node_modules --exclude=.next --exclude=iisnode --exclude=.git ~/Downloads/claimportal-live ~/Work/flightsmojo/tripshieldclaimportal
   ```
   Expected: only `.env.local` (never in git) and files you knowingly changed after the last
   deploy (for the support site, `eccfa98`'s friendlier ticket confirmation is in git but not yet
   deployed — decide whether it ships with the move; for the claim portal the live copy is also at
   `~/Work/claim`).
2. Commit the live state first, then the features, so history shows what ran where:
   ```
   cd ~/Work/flightsmojo/flightsmojo-support && git add -A && git commit -m "support site: state as deployed on IIS, Oct 2026"
   cd ~/Work/flightsmojo/tripshieldclaimportal && git add -A && git commit -m "claim portal: state as deployed on IIS, Oct 2026"
   ```
   (Check `git status` first that no `.env*` file is staged. Both `.gitignore`s must list
   `.env*`; add it if missing.)
3. Push both branches (`git push -u origin <branch>`). The box clones from GitHub in phase C.

Why: a container is built from a git checkout. If the checkout is not what IIS ran, you are
deploying a change you did not plan.

### 3.2 Add the container files to each repo

The same three files in both repos, plus one line in `next.config.mjs`.

**`next.config.mjs`** — add `output: 'standalone'` inside `nextConfig`:
```js
const nextConfig = {
  output: 'standalone',
  // ...existing settings stay
};
```
Why: with this setting `next build` writes a self-contained `.next/standalone` folder holding
only the files the server needs. The image becomes ~200 MB instead of ~1 GB, and the running
container contains no source, no dev dependencies.

**`Dockerfile`**:
```dockerfile
# Stage 1: install exactly the locked dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: build the site
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 3: the image that actually runs — only the standalone output
FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```
Why three stages: the first two have compilers and dev packages; the last one has only what runs,
as the unprivileged `node` user. `server.js` here is the one Next generates inside
`.next/standalone`, not the iisnode `server.js` at the repo root (that one is not copied).
`HOSTNAME=0.0.0.0` makes Next listen on all container interfaces so Docker can publish the port.

**`.dockerignore`**:
```
node_modules
.next
.git
iisnode
web.config
.env
.env.*
claim-archive
public/uploads
```
Why: these must not enter the image. `web.config` and `iisnode` are Windows-only; `.env*` are
secrets; `claim-archive` and `public/uploads` are data, mounted at run time instead (§5.4).

**`package.json`** — add `sharp` to `dependencies` (`npm install sharp`). Why: Next.js
optimises images with the `sharp` library in production; on IIS it was installed globally or
skipped, in the container it must be in the dependency list. Commit `package-lock.json` with it.

Then build once on the laptop to prove the Dockerfile:
```
cd ~/Work/flightsmojo/flightsmojo-support && docker build --platform linux/amd64 -t support-test . && docker run --rm -p 3010:3000 -e CHATWOOT_BASE_URL=https://chat.flightsmojo.com -e CHATWOOT_ACCOUNT_ID=1 -e CHATWOOT_TICKET_INBOX_ID=9 -e CHATWOOT_API_ACCESS_TOKEN=dummy support-test
```
Open `http://localhost:3010/` — the help-centre pages must render (articles come from Chatwoot's
public API, so they load even with a dummy token; only ticket creation needs the real one).
`--platform linux/amd64` because the Mac is ARM and the server is x86; the box builds its own
images later, this is only a proof. Repeat for the claim portal with its env keys from
`env.example` (dummy values are fine for a render test; the admin login needs
`ADMIN_SESSION_SECRET` set to anything long).

Commit and push: `git commit -am "run as a container: standalone build, Dockerfile" && git push`.

---

## 4. Phase B — AWS: snapshot, resize, alarms (one short downtime)

### 4.1 Lower the DNS TTLs a day ahead (no impact)

Checked 22 Oct 2026: the `help` and `tripshield` records already have a **600-second** TTL
(GoDaddy's minimum, 10 minutes), so there is nothing to change here. If a record is ever found
with a longer TTL, set it to 600 a day before moving it. Why: when you change the IP in phase F, nobody waits longer than 10
minutes for the new address, and a rollback is equally fast. TTL changes themselves need the old
TTL to expire, hence "a day ahead".

### 4.2 Take an EBS snapshot (your undo button for the whole disk)

EC2 console → **Elastic Block Store → Volumes** → select `vol-05fce695a2490de55` (the one
attached to `chatwood-server`) → **Actions → Create snapshot** → description
`before t3.large resize and app move, <date>` → Create. Wait until its state is **Completed**
(Snapshots page; a 60 GB volume takes some minutes). Why: a snapshot is the one thing that
brings back the box as it was if a later step destroys something. The database is also dumped
nightly by `/root/backup-chatwoot.sh`, but the snapshot includes nginx config, certificates,
Postfix and Docker volumes — everything.

### 4.3 Resize to t3.large

Pick a quiet time (late night IST; agents off). Downtime is the stop + start, about 3–5
minutes, during which chat, tickets, email ingest and WhatsApp are down (inbound email is **not
lost**: senders' mail servers retry for hours, and Postfix is only down for those minutes).

1. Tell the team the window.
2. On the box, a clean stop of the containers so Postgres closes its files properly:
   ```
   cd /root/flightsmojo-chatwoot && docker compose stop && docker compose ps
   ```
   (`stop`, not `down`: `down` would delete the network and is pointless here.)
3. EC2 console → Instances → `chatwood-server` → **Instance state → Stop instance** → confirm.
   Wait for **Stopped** (the page refreshes; 1–2 minutes). The Elastic IP stays attached —
   you can see it in the Details tab.
4. **Actions → Instance settings → Change instance type** → choose **t3.large** → Apply.
   Why t3.large: same 2 vCPU (the CPU was never the limit, §0), double the RAM for the two
   Node servers plus Chatwoot's own growth. Price: about double the t3.medium (Mumbai
   on-demand, roughly $65 a month against $33).
5. **Instance state → Start instance**. Wait until **Status checks: 2/2 checks passed**.
6. Connect again and verify:
   ```
   sudo -i
   free -h && nproc && df -h /
   cd /root/flightsmojo-chatwoot && docker compose ps
   systemctl status nginx postfix --no-pager | grep -E "Active|nginx|postfix"
   curl -sI https://chat.flightsmojo.com | head -1
   ```
   What you should see: `Mem: 7.6Gi` total; 2 CPUs; all containers "Up" (they have
   `restart: always`, Docker starts them at boot — if any is missing, `docker compose up -d`);
   nginx and postfix active; `HTTP/2 200` (or 302) from Chatwoot. Open the dashboard in a
   browser and send one test message through a widget.
7. Side effect worth knowing: the stop/start also applies the kernel update that has been
   pending since September.

**If the instance does not pass status checks** after 10 minutes: Instance state → Reboot. If
still failing, Stop → change the type back to t3.medium → Start (the resize is the only thing
that changed). If the disk looks wrong, the snapshot from §4.2 can be turned into a new volume
(Snapshots → Actions → Create volume → attach as root) — rare, and not something to do alone the
first time.

### 4.4 Daily snapshots from now on (Data Lifecycle Manager)

EC2 console → **Elastic Block Store → Lifecycle Manager → Create lifecycle policy** → policy
type *EBS snapshot policy* → target resources by **tag**. First give the volume a tag: Volumes →
`vol-05fce…` → Tags → add `Backup = daily`. Then in the policy: target tag `Backup = daily`,
schedule *daily* at 22:00 UTC (03:30 IST, after the 03:30-UTC database dump would be fine too
— pick a quiet hour), **retain 14** snapshots, enable the policy. Why: the on-box database
dump has no copy anywhere else and does not include attachments; a daily snapshot covers both
and lives outside the machine. Cost: snapshots are incremental, a few dollars a month for this
volume.

### 4.5 Alarms (so you hear about trouble before customers do)

CloudWatch console → **Alarms → Create alarm**. Four alarms, each with the action "send a
notification" to a new **SNS topic** (`chatwoot-alerts`) with your email as subscriber — AWS
emails a confirmation link; click it once.

| Alarm | Metric | Condition | Why |
|---|---|---|---|
| Disk | CWAgent → `disk_used_percent`, path `/` | > 80% for 5 min | the Sep 2026 outage was a full disk |
| Memory | CWAgent → `mem_used_percent` | > 85% for 10 min | the new workload is memory, not CPU |
| Status | EC2 → `StatusCheckFailed` | ≥ 1 for 2 periods | the box itself is unhealthy |
| Credits | EC2 → `CPUCreditBalance` | < 100 for 15 min | sustained CPU pressure, which today never happens |

The CloudWatch agent is already installed (the Monitoring tab shows CWAgent metrics), so the
first two metrics exist.

### 4.6 Security group tidy-up (two minutes)

EC2 → Instances → `chatwood-server` → Security tab → the group → **Edit inbound rules**. Keep
22, 80, 443, 25. Delete the leftover **3001** rule from the email rollout if it is still there.
Nothing else is needed for the apps: nginx answers on 443 for every hostname.

---

## 5. Phase C — prepare the box (no live impact)

All as root in `/root`.

### 5.1 Clone the two repos next to the hub clone

```
cd /root
git clone -b feature/chatwoot-tickets https://github.com/mishraadityan09/flightsmojo-support.git
git clone -b feature/chatwoot-claims https://github.com/mishraadityan09/tripshieldclaimportal.git
ls -d /root/flightsmojo-* /root/tripshieldclaimportal
```
(Private repos: GitHub will ask for a username and a **personal access token** as the password —
create one at GitHub → Settings → Developer settings → Fine-grained tokens, read-only on these
two repos; or use the same method that cloned the hub repo here.) Why clone instead of copying:
every future deploy is `git pull` + rebuild, and `git log` on the box always says what is running.

### 5.2 Environment files (secrets) — one per app, outside git

```
cd /root/flightsmojo-chatwoot
umask 077
cat > support.env <<'EOT'
CHATWOOT_BASE_URL=https://chat.flightsmojo.com
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_TICKET_INBOX_ID=9
CHATWOOT_API_ACCESS_TOKEN=<token of the "Website Tickets" user, from the IIS .env.local>
EOT
cat > claims.env <<'EOT'
CHATWOOT_BASE_URL=https://chat.flightsmojo.com
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_API_ACCESS_TOKEN=<token of the claims user, from C:\Website\claimportal\.env.local>
CHATWOOT_CLAIMS_INBOX_ID=17
CHATWOOT_INBOUND_DOMAIN=inbound.flightsmojo.com
SMTP_HOST=smtp.netcorecloud.net
SMTP_PORT=587
SMTP_USER=<as on IIS>
SMTP_PASS=<as on IIS>
EMAIL_FROM=FlightsMojo Trip Shield <tripshield.claims@flightsmojo.in>
ADMIN_USERNAME=<as on IIS>
ADMIN_PASSWORD=<as on IIS>
ADMIN_SESSION_SECRET=<as on IIS>
CLAIMS_ARCHIVE_DIR=/data/claim-archive
EOT
ls -l support.env claims.env
```
Copy the real values from each site's `.env.local` on Windows (open it in Notepad; never paste
them into chat or a ticket). `umask 077` makes the files readable by root only (`-rw-------`).

Then stop git from ever committing them: in the hub repo's `.gitignore` the line `.env` becomes
`*.env` (which matches `.env`, `support.env` and `claims.env`, and not `.env.example`). Why one
file per app rather than the hub `.env`: every service in `docker-compose.yml` reads the hub
`.env`, so a secret placed there is visible inside the bot, the reviews bridge and Chatwoot
itself. These two files are read only by their own container.

### 5.3 Copy the claim archive from Windows

The claim portal's "archive" tab reads a folder of old claims (`CLAIMS_ARCHIVE_DIR`; on IIS it is
`claim-archive` under the site folder, with the older `public\uploads` next to it). Those are
customer documents, so they travel through a private S3 bucket, never through chat or email.

1. On Windows: zip `C:\Website\claimportal\claim-archive` (and `public\uploads` if it still has
   content) into `claim-archive.zip`.
2. AWS console → **S3 → Create bucket**: name `flightsmojo-transfer-<something unique>`, region
   Mumbai, **Block all public access** left ON (default). Open the bucket → Upload →
   `claim-archive.zip`.
3. Select the uploaded object → **Actions → Share with a presigned URL** → 1 hour → copy the URL.
   Why: a presigned URL is a one-off, time-limited download link to a private object; the box
   needs no AWS credentials to use it.
4. On the box:
   ```
   mkdir -p /root/apps-data/claims && cd /root/apps-data/claims
   curl -fSL -o claim-archive.zip '<paste the presigned URL inside single quotes>'
   apt-get install -y unzip >/dev/null 2>&1; unzip -q claim-archive.zip && ls
   ```
   You should end with `/root/apps-data/claims/claim-archive/<one folder per claim>`. If the zip
   unpacked `uploads` too, move its folders into `claim-archive` only if they are not already
   there (`claim-archive` is the archive; `uploads` was the old public location).
5. Delete the object from S3 (and the bucket, if you created it only for this). Documents
   should not sit in an extra place.

### 5.4 Add the two services to `docker-compose.yml`

In `/root/flightsmojo-chatwoot/docker-compose.yml` (edit on the laptop, commit, push, `git pull`
on the box — the same path every hub change takes), add under `services:`:

```yaml
  support:
    # Help-centre + ticket forms website (14 help.* hostnames). Built from the
    # sibling clone; nginx forwards the hostnames to 127.0.0.1:3010.
    build: /root/flightsmojo-support
    env_file: support.env
    logging: *default-logging
    restart: always
    ports:
      - '127.0.0.1:3010:3000'

  claims:
    # TripShield claim portal (tripshield.flightsmojo.in). The archive of old
    # claims is a read-only mount; nothing else is stored on disk.
    build: /root/tripshieldclaimportal
    env_file: claims.env
    logging: *default-logging
    restart: always
    ports:
      - '127.0.0.1:3011:3000'
    volumes:
      - /root/apps-data/claims/claim-archive:/data/claim-archive:ro
```

Line by line: `build:` points at the clone, so `docker compose build support` rebuilds from
whatever `git pull` fetched; `env_file:` is the app's own secrets file from §5.2; `logging:`
reuses the hub's log rotation (50 MB × 3 per container — the Sep 2026 outage was unrotated
logs); `restart: always` brings the container back after a reboot; `127.0.0.1:` in `ports:`
means only the box itself can reach the app — the internet reaches it through nginx only;
the archive is mounted read-only because the app only reads it.

`docker compose config >/dev/null && echo OK` validates the file.

### 5.5 Build and start the containers (not yet reachable from the internet)

```
cd /root/flightsmojo-chatwoot && git pull
docker compose build support claims 2>&1 | tail -5
docker compose up -d --no-deps support claims
docker compose ps
```
The build takes 3–6 minutes per app on this box; memory is the reason phase B came first. If
the build fails on `npm ci`, the lock file is out of date — run `npm install` on the laptop,
commit `package-lock.json`, push, pull, rebuild. `--no-deps` matters: without it compose would
also recreate rails, postgres and redis because they share the `.env` file (a lesson from
7 Oct 2026).

Test from the box, pretending to be each hostname:
```
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: help.flightsmojo.in' http://127.0.0.1:3010/
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: help.flightsmojo.co.uk' http://127.0.0.1:3010/help-center
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: tripshield.flightsmojo.in' http://127.0.0.1:3011/
docker compose logs --tail 20 support claims
```
Expect `200` three times and clean logs ("Ready in …"). The support site reads the `Host`
header to pick the country, which is why the test sends one.

Clean up build leftovers: `docker image prune -f` (removes the intermediate stages;
`docker system df` shows what Docker uses).

---

## 6. Phase E — nginx and certificates (still no live impact)

### 6.1 The problem to solve

Both sites send HSTS, so browsers will only talk HTTPS to them. The moment DNS points at the
box, nginx must already present valid certificates for every hostname. Let's Encrypt proves you
own a hostname by fetching `http://<hostname>/.well-known/acme-challenge/<token>` — and today
that request lands on IIS. The trick: make IIS **redirect** those requests to the box.
Let's Encrypt follows redirects, so the box can obtain certificates for all 15 names while IIS
is still serving the sites. No gap, no self-signed interlude.

### 6.2 One helper hostname and the IIS redirect rule

1. DNS (GoDaddy, zone flightsmojo.com): add an **A record** `acme` → `65.0.152.108`, TTL 600.
   This gives the box a name of its own, `acme.flightsmojo.com`, that already points at it.
2. On the box, a site that answers that name on port 80 and serves the challenge folder:
   ```
   mkdir -p /var/www/acme
   cat > /etc/nginx/sites-available/acme <<'EOT'
   server {
       listen 80;
          server_name acme.flightsmojo.com;
       location /.well-known/acme-challenge/ { root /var/www/acme; }
       location / { return 404; }
   }
   EOT
   ln -s /etc/nginx/sites-available/acme /etc/nginx/sites-enabled/acme
   nginx -t && systemctl reload nginx
   echo ok > /var/www/acme/.well-known/acme-challenge/test 2>/dev/null || (mkdir -p /var/www/acme/.well-known/acme-challenge && echo ok > /var/www/acme/.well-known/acme-challenge/test)
   curl -s http://acme.flightsmojo.com/.well-known/acme-challenge/test
   ```
   Expect `ok`. `nginx -t` checks the config before `reload`; never reload on a failed test.
3. On Windows, in **each** of the two sites' `web.config`, add this rule as the **first** rule
   inside `<rules>` (the existing first rule sends everything to `server.js`, so the new one must
   come before it):
   ```xml
   <rule name="ACME challenge to new server" stopProcessing="true">
     <match url="^\.well-known/acme-challenge/(.*)$" />
     <action type="Redirect" url="http://acme.flightsmojo.com/.well-known/acme-challenge/{R:1}" redirectType="Found" />
   </rule>
   ```
   Test from the laptop: `curl -sI http://help.flightsmojo.in/.well-known/acme-challenge/test | head -3`
   should show `302` with a `Location:` on `acme.flightsmojo.com`; and
   `curl -sL http://help.flightsmojo.in/.well-known/acme-challenge/test` should print `ok`.
   If IIS forces HTTPS first, that is fine too — the validator follows that redirect as well.

### 6.3 Issue the certificates

One certificate for all help hostnames, one for the claim portal:
```
certbot certonly --webroot -w /var/www/acme --cert-name help.flightsmojo \
  -d help.flightsmojo.in -d help.flightsmojo.co.uk -d help.flightsmojo.ph \
  -d help.flightsmojo.ca -d help.flightsmojo.com -d help.flightsmojo.id
certbot certonly --webroot -w /var/www/acme --cert-name tripshield.flightsmojo.in -d tripshield.flightsmojo.in
certbot certificates
```
Only the six `help.*` names that exist in DNS are requested (checked 22 Oct 2026: the `www.help.*`
variants and `help.lk.flightsmojo.com` have no DNS records, so they cannot be validated — Let's
Encrypt fails the whole request if one name cannot be validated, and the error names the hostname).
They stay in the `server_name` lists, which is harmless, and can be added to the certificate
later with the same command once their records exist. Expect "Successfully received
certificate" and files under `/etc/letsencrypt/live/help.flightsmojo/` and
`/etc/letsencrypt/live/tripshield.flightsmojo.in/`. Renewal is automatic: the timer seen in §2.4
reruns, per certificate, the method it was obtained with (the chat certificate keeps using
certbot's nginx plugin, these two use the webroot) every 60 days, which keeps working after DNS has moved because
by then the hostnames point straight at the box (the IIS rule is no longer involved).

### 6.4 The two site files

Copy the `listen 443`/`ssl_*`/`include` style from the chat site file you noted in §2.4. The
template below is the usual certbot layout; adjust the `http2` line to what the chat site uses.

```
cat > /etc/nginx/sites-available/help.flightsmojo <<'EOT'
server {
    listen 80;
    server_name help.flightsmojo.in www.help.flightsmojo.in help.flightsmojo.co.uk www.help.flightsmojo.co.uk help.flightsmojo.ph www.help.flightsmojo.ph help.flightsmojo.ca www.help.flightsmojo.ca help.flightsmojo.com www.help.flightsmojo.com help.flightsmojo.id www.help.flightsmojo.id help.lk.flightsmojo.com www.help.lk.flightsmojo.com;
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    http2 on;
    server_name help.flightsmojo.in www.help.flightsmojo.in help.flightsmojo.co.uk www.help.flightsmojo.co.uk help.flightsmojo.ph www.help.flightsmojo.ph help.flightsmojo.ca www.help.flightsmojo.ca help.flightsmojo.com www.help.flightsmojo.com help.flightsmojo.id www.help.flightsmojo.id help.lk.flightsmojo.com www.help.lk.flightsmojo.com;
    ssl_certificate     /etc/letsencrypt/live/help.flightsmojo/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/help.flightsmojo/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
    }
}
EOT
cat > /etc/nginx/sites-available/tripshield.flightsmojo.in <<'EOT'
server {
    listen 80;
    server_name tripshield.flightsmojo.in;
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    http2 on;
    server_name tripshield.flightsmojo.in;
    ssl_certificate     /etc/letsencrypt/live/tripshield.flightsmojo.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tripshield.flightsmojo.in/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    client_max_body_size 40m;
    location / {
        proxy_pass http://127.0.0.1:3011;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
EOT
ln -s /etc/nginx/sites-available/help.flightsmojo /etc/nginx/sites-enabled/help.flightsmojo
ln -s /etc/nginx/sites-available/tripshield.flightsmojo.in /etc/nginx/sites-enabled/tripshield.flightsmojo.in
nginx -t && systemctl reload nginx
```

Why each unusual line:
- `X-Forwarded-Host` — the support site's `proxy.js` reads it to decide the country of the
  visitor; without it every visitor would be treated as the default country (India).
- `X-Forwarded-For` — the claim portal's rate limiter and admin-login lockout use the first
  address in it (on IIS, iisnode filled it). Without it every visitor would share one bucket and
  the sixth claim in ten minutes from anyone would be refused.
- `X-Forwarded-Proto https` — the claim portal sets its admin cookie as `secure` in production;
  the app must know the visitor used HTTPS.
- `client_max_body_size 40m` on the claim portal — claim documents are uploaded through the
  form; 2 MB (nginx's default is 1 MB) would cut them off. The support site needs little.
- `Strict-Transport-Security … always` — the same header IIS sent from `web.config`; moving it
  here keeps browsers' expectations unchanged. `always` adds it on error pages too.
- The `/.well-known/acme-challenge/` location on port 80 — keeps renewals working forever.
- The `http2 on;` form is for nginx ≥ 1.25.1; older nginx wants `listen 443 ssl http2;` — the
  chat site file shows which one this box uses.

### 6.5 Test everything before DNS moves

From the laptop, force the hostnames to the box without changing DNS:
```
for h in help.flightsmojo.in help.flightsmojo.co.uk help.flightsmojo.com tripshield.flightsmojo.in; do printf '%-28s ' "$h"; curl -s -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' --resolve "$h:443:65.0.152.108" "https://$h/"; done
```
Expect `200 0` on each line (`0` = certificate verified). Then the browser test: add to the
laptop's `/etc/hosts` the line `65.0.152.108 help.flightsmojo.in tripshield.flightsmojo.in`, open
both sites, click through the help centre, open a support form (do **not** submit yet), log into
the claim admin, open the archive tab (the copied folders must be listed). Remove the
`/etc/hosts` line afterwards.

### 6.6 Plan B if certificates could not be issued (IIS export)

If the redirect trick fails on the night: on Windows, IIS Manager → Server Certificates → the
site's certificate → Export as `.pfx` with a password; transfer it the S3 presigned-URL way
(§5.3); on the box convert and point nginx at it:
```
openssl pkcs12 -in help.pfx -clcerts -nokeys -out /etc/ssl/help-fullchain.pem
openssl pkcs12 -in help.pfx -nocerts -nodes -out /etc/ssl/help-privkey.pem && chmod 600 /etc/ssl/help-privkey.pem
```
and use those two paths in the `ssl_certificate` lines. After DNS has moved, run §6.3 again
(validation then reaches the box directly), switch the paths back to `/etc/letsencrypt/live/…`,
reload, and delete the exported files. This is a fallback, not the plan: it moves private keys
around and the exported certificate's expiry is a deadline.

---

## 7. Phase F — DNS cutover, one hostname at a time

Order: `tripshield.flightsmojo.in` first (one hostname, low traffic, easy to watch), then the
help sites, the busiest last. Each hostname:

1. In the DNS provider, change the A record (`help` and `www.help` in that zone; `help.lk` in
   flightsmojo.com; `tripshield` in flightsmojo.in) to `65.0.152.108`. If it was a CNAME, delete
   the CNAME and add an A record. Save.
2. Watch it switch (TTL is 600 s from §4.1):
   ```
   dig +short help.flightsmojo.in @8.8.8.8
   ```
   until it prints `65.0.152.108`.
3. On the box, watch requests arrive:
   ```
   tail -f /var/log/nginx/access.log | grep --line-buffered "help.flightsmojo.in\|tripshield"
   ```
   (if the chat site file uses its own log file names, the new sites can get their own
   `access_log` lines too — not needed on day one).
4. Browser check without `/etc/hosts` tricks: the site loads, padlock valid, pages work.
5. Functional test for that site (once per app, not per hostname):
   - Support site: submit one ticket from `/support` with a recognisable subject → it must
     appear in Chatwoot inbox 9 "Website Tickets" with the country label. Resolve it.
   - Claim portal: submit one dummy claim with two small PDFs → a ticket in inbox 17 with the
     documents attached and the confirmation email arriving (Netcore holds it ~4 minutes).
     Log into `/admin`, open the archive tab.

IIS keeps serving anyone whose DNS cache has not expired; both run in parallel for a while, which
is harmless because both talk to the same Chatwoot.

**Rollback for any hostname**: set its A record back to the old IP (from §2.1). Within 10
minutes traffic returns to IIS, which was never stopped. Nothing on the box needs undoing.

**After 48 hours** with all hostnames moved and no complaints: on Windows, IIS Manager →
**Stop** the two sites (do not delete). Keep them stopped for two weeks, then remove the
sites and their folders if you wish (the code is in git; the claim archive is on the box and in
its snapshots). Remove the ACME redirect rules with the sites.

---

## 8. Day-2 operations — the cheat sheet

### 8.1 Deploy a change to either app

On the laptop: commit, push the branch the box tracks. On the box:
```
cd /root/flightsmojo-support && git pull        # or /root/tripshieldclaimportal
cd /root/flightsmojo-chatwoot && docker compose build support && docker compose up -d --no-deps support
docker compose logs --tail 20 support
```
(`claims` instead of `support` for the portal.) The site is unavailable for the 2–5 seconds the
container swaps; nginx answers 502 in that window. Build at a quiet hour: the build uses CPU
and ~2 GB RAM for a few minutes.

### 8.2 Is it healthy?

```
cd /root/flightsmojo-chatwoot && docker compose ps
docker compose logs --tail 50 support claims
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: help.flightsmojo.in' http://127.0.0.1:3010/
systemctl status nginx --no-pager | head -3 && nginx -t
free -h && df -h /
certbot certificates
```

### 8.3 Restart one app

```
docker compose restart support      # or claims
```
Restart nginx only after `nginx -t` says the config is fine: `systemctl reload nginx`.

### 8.4 Something is down — where to look, in order

1. **Is it DNS?** `dig +short <hostname>` from the laptop must print `65.0.152.108`.
2. **Is the box up?** EC2 console → Instances → status checks. If 1/2 or 0/2: Instance state →
   Reboot. If it comes back with a full disk (`df -h /` near 100%), see the disk-incident notes
   in `docs/system-map.md` §13.
3. **Is nginx up?** `systemctl status nginx`. A 502 from nginx means the app container is
   down or restarting: `docker compose ps`, `docker compose logs --tail 100 <app>`.
4. **Is the app failing to talk to Chatwoot?** The help centre renders but articles are empty,
   or ticket forms return an error: `curl -sI https://chat.flightsmojo.com | head -1` and check
   the token in `support.env` / `claims.env` (a token belongs to a user; if that user was
   deleted or its token regenerated in Chatwoot, create a new one and update the file, then
   `docker compose up -d --no-deps <app>`).
5. **Certificate warning in the browser?** `certbot certificates` shows expiry; `certbot renew`
   then `systemctl reload nginx`. Renewal needs port 80 open and the `.well-known` location in
   the site file.

### 8.5 Where things live

| What | Where |
|---|---|
| App code | `/root/flightsmojo-support`, `/root/tripshieldclaimportal` (git clones) |
| Secrets | `/root/flightsmojo-chatwoot/support.env`, `claims.env` (root-only, not in git) |
| Claim archive | `/root/apps-data/claims/claim-archive` (in the daily snapshot) |
| nginx sites | `/etc/nginx/sites-available/help.flightsmojo`, `tripshield.flightsmojo.in`, `acme` |
| Certificates | `/etc/letsencrypt/live/help.flightsmojo/`, `/etc/letsencrypt/live/tripshield.flightsmojo.in/` |
| Logs | `docker compose logs <app>`; nginx `/var/log/nginx/access.log`, `error.log` |
| Snapshots | EC2 console → Snapshots (manual from §4.2 plus the daily policy from §4.4) |

### 8.6 Costs after the move

| Item | Before | After |
|---|---|---|
| Chatwoot server | t3.medium ≈ $33 / month | t3.large ≈ $65 / month (Mumbai on-demand; check the console's pricing before relying on it) |
| Daily snapshots | none | a few dollars / month (incremental) |
| Windows server | unchanged | unchanged — it keeps the .NET services |

---

## 9. Checklist (print this)

- [ ] §2 answers written down: current IPs, DNS provider per zone, certificate issuer and expiry, IIS paths, Node version, box's nginx style
- [ ] §3.1 live state committed and pushed for both repos
- [ ] §3.2 Dockerfile, .dockerignore, `output: 'standalone'`, sharp — built once on the laptop
- [ ] §4.1 TTLs at 600 s, a day ahead
- [ ] §4.2 snapshot completed
- [ ] §4.3 resized to t3.large, all containers up, chat tested
- [ ] §4.4 daily snapshot policy on · §4.5 four alarms, email confirmed · §4.6 security group tidy
- [ ] §5.1 clones · §5.2 env files (root-only, `*.env` ignored) · §5.3 archive copied, S3 object deleted
- [ ] §5.4 compose services committed · §5.5 built, started, `200` on local curl tests
- [ ] §6.2 `acme.flightsmojo.com` + IIS redirect rules, `ok` test passed
- [ ] §6.3 certificates issued · §6.4 site files enabled, `nginx -t` clean
- [ ] §6.5 `--resolve` tests `200 0`, browser test via `/etc/hosts`
- [ ] §7 DNS moved hostname by hostname, functional tests done, IIS sites stopped after 48 h

---

## 10. Glossary of commands used

| Command | What it does |
|---|---|
| `sudo -i` | become root (needed for nginx, certbot, docker, `/root`) |
| `df -h /` · `free -h` · `nproc` | disk space · memory · CPU count |
| `docker compose ps / logs / build / up -d --no-deps / restart / stop` | list containers · show their output · build an image · start or replace one container only · restart one · stop all |
| `docker image prune -f` · `docker system df` | delete unused image layers · show Docker's disk use |
| `nginx -t` · `systemctl reload nginx` | check config · apply it without dropping connections |
| `certbot certonly --webroot …` · `certbot certificates` · `certbot renew` | get a certificate · list them · renew (the timer does this) |
| `dig +short <name>` · `dig +short NS <zone>` | what a hostname resolves to · who hosts the zone |
| `curl -sI <url>` · `curl --resolve host:443:ip <url>` | show response headers · talk to a hostname at a chosen IP, ignoring DNS |
| `tail -f <log> \| grep --line-buffered <text>` | follow a log, show matching lines as they arrive |
| `umask 077` | files created after it are readable by the owner only |
