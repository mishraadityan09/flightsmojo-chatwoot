#!/bin/bash
# Step 2 of the email go-live: install and configure Postfix as a *receive-only*
# relay for the inbound subdomain, handing every message to Chatwoot.
# Idempotent: re-running just re-applies the same settings.
#
# Requires: env-setup.sh already run (reads RAILS_INBOUND_EMAIL_PASSWORD from .env).
# Usage (as root):  bash scripts/email/postfix-setup.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=$(pwd)
INBOUND_DOMAIN="${INBOUND_DOMAIN:-inbound.flightsmojo.com}"
MAIL_HOSTNAME="${MAIL_HOSTNAME:-mx.flightsmojo.com}"
# Chatwoot's rails container is published on 127.0.0.1:3001 by docker-compose.yml.
INGRESS_URL="${INGRESS_URL:-http://127.0.0.1:3001/rails/action_mailbox/relay/inbound_emails}"

PASS=$(grep -E '^RAILS_INBOUND_EMAIL_PASSWORD=' .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//" || true)
[ -n "$PASS" ] || { echo "RAILS_INBOUND_EMAIL_PASSWORD missing in .env - run scripts/email/env-setup.sh first"; exit 1; }

echo "== 1/6 install postfix (non-interactive)"
export DEBIAN_FRONTEND=noninteractive
echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
echo "postfix postfix/mailname string $MAIL_HOSTNAME" | debconf-set-selections
apt-get update -q >/dev/null
apt-get install -y -q postfix curl >/dev/null

echo "== 2/6 main.cf settings"
postconf -e \
  "myhostname = $MAIL_HOSTNAME" \
  "mydestination =" \
  "local_recipient_maps =" \
  "relay_domains = $INBOUND_DOMAIN" \
  "transport_maps = hash:/etc/postfix/transport" \
  "mynetworks = 127.0.0.0/8" \
  "inet_interfaces = all" \
  "inet_protocols = ipv4" \
  "message_size_limit = 31457280" \
  "smtpd_relay_restrictions = reject_unauth_destination" \
  "default_transport = error:5.7.1 receive-only relay: this server sends no mail" \
  "notify_classes =" \
  "smtpd_helo_required = yes" \
  "disable_vrfy_command = yes" \
  "smtpd_tls_security_level = may" \
  "maximal_queue_lifetime = 3d" \
  "bounce_queue_lifetime = 1d" \
  "chatwoot_destination_recipient_limit = 1" \
  "chatwoot_destination_concurrency_limit = 2"
# recipient_limit 1   -> one delivery per recipient, so X-Original-To is exact
# concurrency_limit 2 -> at most 2 parallel POSTs, so a queue flush after an
#                        outage cannot swamp Chatwoot's web workers

echo "== 3/6 routing: $INBOUND_DOMAIN -> chatwoot service"
printf '%s\tchatwoot:\n' "$INBOUND_DOMAIN" > /etc/postfix/transport
postmap /etc/postfix/transport
# master.cf service entry, written with `postconf -M` so re-runs replace it
# instead of appending a duplicate. flags: R = Return-Path header,
# O = 'X-Original-To: <forwarding address>' so Chatwoot can route by the
# per-inbox forwarding address, not only by the To: header.
postconf -M chatwoot/unix="chatwoot unix - n n - - pipe flags=RO user=nobody null_sender= argv=/usr/local/bin/chatwoot-ingress"

echo "== 4/6 hand-off script + secret"
install -m 0755 "$REPO/scripts/email/chatwoot-ingress" /usr/local/bin/chatwoot-ingress
( umask 027
  printf 'INGRESS_URL=%s\nINGRESS_PASSWORD=%s\n' "$INGRESS_URL" "$PASS" > /etc/postfix/chatwoot-ingress.env )
chown root:nogroup /etc/postfix/chatwoot-ingress.env
chmod 0640 /etc/postfix/chatwoot-ingress.env

echo "== 5/6 start"
if systemctl is-system-running >/dev/null 2>&1 || systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; then
  systemctl enable --now postfix >/dev/null
  postfix reload >/dev/null 2>&1 || systemctl restart postfix
else
  # no systemd (e.g. a test container): run postfix directly and log to a file
  postconf -e "maillog_file = /var/log/postfix.log"
  postfix status >/dev/null 2>&1 && postfix reload || postfix start
fi
sleep 2
ss -ltn | grep -q ':25 ' && echo "postfix listening on port 25" || { echo "port 25 NOT listening"; exit 1; }

echo "== 6/6 self-test"
MSG=$(printf 'From: Self Test <selftest@example.com>\nTo: selftest@%s\nSubject: postfix self-test %s\nMessage-ID: <selftest-%s@%s>\nDate: %s\n\nIf you can read this in the Postfix log as status=sent, the hand-off works.\n' \
  "$INBOUND_DOMAIN" "$(date +%s)" "$(date +%s)" "$MAIL_HOSTNAME" "$(date -R)")
code=$(printf '%s' "$MSG" | curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H "X-Forwarded-Proto: https" -u "actionmailbox:$PASS" \
  -H "Content-Type: message/rfc822" --data-binary @- "$INGRESS_URL" || echo 000)
echo "direct POST to Chatwoot -> HTTP $code (204 = good; 401 = password mismatch, recreate rails; 301 = FORCE_SSL redirect not bypassed; 000 = rails not reachable)"
printf '%s' "$MSG" | sendmail -f selftest@example.com "selftest@$INBOUND_DOMAIN"
sleep 4
echo "-- queue (empty = delivered):"; postqueue -p | tail -3
echo "-- last postfix log lines:"
if [ -f /var/log/postfix.log ]; then grep -E 'chatwoot|status=' /var/log/postfix.log | tail -5
else journalctl --since '2 min ago' --no-pager | grep -E 'postfix.*(chatwoot|status=)' | tail -5; fi
echo
echo "Done. Next: from Gmail, email anything@$INBOUND_DOMAIN and watch:  journalctl -f | grep postfix"
