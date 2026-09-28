#!/bin/bash
# Step 1 of the email go-live: put the inbound + Netcore sending settings into
# the compose .env. Safe to re-run: existing non-empty values are kept, except
# the ones this project owns (inbound domain / relay / SMTP host,port,user).
#
# It never prints or overwrites passwords. SMTP_PASSWORD (Netcore) is left for
# you to fill by hand with `nano .env` afterwards.
#
# Usage (as root):  bash scripts/email/env-setup.sh
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root, where .env lives
ENV_FILE=.env
[ -f "$ENV_FILE" ] || { echo "no .env here ($(pwd))"; exit 1; }

INBOUND_DOMAIN="${INBOUND_DOMAIN:-inbound.flightsmojo.com}"
SENDER="${SENDER:-FlightsMojo Support <noreply@flightsmojo.com>}"
# Backups live OUTSIDE the git clone: .gitignore only covers `.env`, so a
# `.env.bak-*` next to it could be committed by a careless `git add .`.
BACKUP_DIR="${BACKUP_DIR:-/root/env-backups}"
mkdir -p -m 700 "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/env-$(date +%Y%m%d-%H%M%S)-$$.bak"   # PID suffix: never overwrites an earlier backup
cp -p "$ENV_FILE" "$BACKUP" && chmod 600 "$BACKUP"
echo "backed up .env to $BACKUP"

# set_var KEY VALUE  -> replace the KEY= line or append it
set_var() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
# current value of KEY, surrounding quotes stripped (empty if absent or "")
get_var() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//" || true; }

# Warn if a key this script manages appears more than once (compose uses the
# LAST one; set_var rewrites every copy, so they stay identical).
for k in MAILER_INBOUND_EMAIL_DOMAIN RAILS_INBOUND_EMAIL_SERVICE RAILS_INBOUND_EMAIL_PASSWORD \
         SMTP_ADDRESS SMTP_PORT SMTP_USERNAME SMTP_PASSWORD SMTP_AUTHENTICATION \
         SMTP_ENABLE_STARTTLS_AUTO SMTP_DOMAIN MAILER_SENDER_EMAIL; do
  n=$(grep -cE "^${k}=" "$ENV_FILE" || true)
  [ "$n" -gt 1 ] && echo "WARNING: $k appears $n times in .env; consider deleting the extra lines"
done

# --- receiving (Postfix relay -> Chatwoot) --------------------------------
set_var MAILER_INBOUND_EMAIL_DOMAIN "$INBOUND_DOMAIN"
set_var RAILS_INBOUND_EMAIL_SERVICE relay
if [ -z "$(get_var RAILS_INBOUND_EMAIL_PASSWORD)" ]; then
  set_var RAILS_INBOUND_EMAIL_PASSWORD "$(openssl rand -hex 24)"   # shared with Postfix
  echo "generated RAILS_INBOUND_EMAIL_PASSWORD (Postfix reads it from .env)"
else
  echo "kept existing RAILS_INBOUND_EMAIL_PASSWORD"
fi

# --- sending (Netcore SMTP relay; account config untouched) ---------------
set_var SMTP_ADDRESS smtp.netcorecloud.net
set_var SMTP_PORT 587                      # not 25: AWS throttles outbound 25
set_var SMTP_USERNAME flightsmojo_eapi
set_var SMTP_AUTHENTICATION plain
set_var SMTP_ENABLE_STARTTLS_AUTO true
set_var SMTP_DOMAIN flightsmojo.com
if [ -z "$(get_var MAILER_SENDER_EMAIL)" ]; then
  set_var MAILER_SENDER_EMAIL "\"$SENDER\""
fi
if [ -z "$(get_var SMTP_PASSWORD)" ]; then
  echo
  echo ">>> SMTP_PASSWORD is empty. Run:  nano .env   and set it like this, WITH single quotes:"
  echo ">>>     SMTP_PASSWORD='the-netcore-password'"
  echo ">>> (single quotes stop docker compose from treating a \$ inside it as a variable)"
fi

echo
echo "Now in .env (passwords hidden):"
grep -E '^(MAILER_INBOUND_EMAIL_DOMAIN|RAILS_INBOUND_EMAIL_SERVICE|SMTP_ADDRESS|SMTP_PORT|SMTP_USERNAME|SMTP_AUTHENTICATION|SMTP_ENABLE_STARTTLS_AUTO|SMTP_DOMAIN|MAILER_SENDER_EMAIL)=' "$ENV_FILE"
for k in RAILS_INBOUND_EMAIL_PASSWORD SMTP_PASSWORD; do
  [ -n "$(get_var $k)" ] && echo "$k=(set)" || echo "$k=(EMPTY)"
done
echo
echo "Next: fill SMTP_PASSWORD if empty, then:  docker compose up -d --no-deps rails sidekiq"
echo "(--no-deps matters: postgres/redis/bot read the same .env, and without it compose would recreate them too)"
