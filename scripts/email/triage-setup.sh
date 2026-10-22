#!/bin/bash
# IROP mail triage, server side: route ONE forwarding address (the agency
# mailbox's Chatwoot inbox) through the triage service instead of straight into
# Chatwoot. Everything else Postfix receives keeps its current path.
# Idempotent: re-running re-applies the same settings. Design: docs/irop-mail-triage.md §6.3.
#
# Usage (as root, from the hub clone):
#   TRIAGE_FORWARD_ADDRESS=<hex>@inbound.flightsmojo.com bash scripts/email/triage-setup.sh
#   bash scripts/email/triage-setup.sh --remove      # rollback: mail goes straight to Chatwoot again
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=$(pwd)
TRANSPORT=/etc/postfix/transport
INGRESS_URL="${TRIAGE_INGRESS_URL:-http://127.0.0.1:3004/ingest}"
CONCURRENCY="${TRIAGE_CONCURRENCY:-4}"

if [ "${1:-}" = "--remove" ]; then
  echo "== removing the triage route (mail for the address goes straight to Chatwoot)"
  sed -i '/\ttriage:$/d' "$TRANSPORT"
  postmap "$TRANSPORT"
  postfix reload >/dev/null 2>&1 || true
  echo "done:"; cat "$TRANSPORT"
  exit 0
fi

ADDR="${TRIAGE_FORWARD_ADDRESS:-}"
[ -n "$ADDR" ] || { echo "TRIAGE_FORWARD_ADDRESS is required: the IROP inbox's 'Forward to Email' address (Settings → Inboxes → the inbox → Configuration)"; exit 1; }
case "$ADDR" in *@*) ;; *) echo "TRIAGE_FORWARD_ADDRESS must be a full address"; exit 1 ;; esac
[ -f "$TRANSPORT" ] || { echo "$TRANSPORT missing — run scripts/email/postfix-setup.sh first"; exit 1; }

echo "== 1/5 transport map: $ADDR -> triage service (a full-address entry wins over the domain entry)"
sed -i '/\ttriage:$/d' "$TRANSPORT"
printf '%s\ttriage:\n' "$ADDR" | cat - "$TRANSPORT" > "$TRANSPORT.new" && mv "$TRANSPORT.new" "$TRANSPORT"
postmap "$TRANSPORT"
cat "$TRANSPORT"

echo "== 2/5 master.cf pipe service (flags R = Return-Path, O = X-Original-To, so Chatwoot still routes by the forward address)"
postconf -M triage/unix="triage unix - n n - - pipe flags=RO user=nobody null_sender= argv=/usr/local/bin/triage-ingress"
postconf -e "triage_destination_recipient_limit = 1" "triage_destination_concurrency_limit = $CONCURRENCY"

echo "== 3/5 hand-off script"
install -m 0755 "$REPO/scripts/email/triage-ingress" /usr/local/bin/triage-ingress
( umask 027; printf 'INGRESS_URL=%s\n' "$INGRESS_URL" > /etc/postfix/triage-ingress.env )
chown root:nogroup /etc/postfix/triage-ingress.env
chmod 0640 /etc/postfix/triage-ingress.env

echo "== 4/5 reload"
postfix reload >/dev/null 2>&1 || systemctl restart postfix

echo "== 5/5 self-test"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${INGRESS_URL%/ingest}/health" || echo 000)
echo "triage /health -> HTTP $code (200 = the service is up; 000 = container not running yet, mail will queue until it is)"
MSG=$(printf 'From: Self Test <selftest@example.com>\nTo: %s\nSubject: triage self-test %s\nMessage-ID: <triage-selftest-%s@localhost>\nDate: %s\nAuto-Submitted: auto-generated\n\nThis mail is dropped by the pre-filter (Auto-Submitted) and never reaches Chatwoot; it only proves the Postfix hand-off.\n' \
  "$ADDR" "$(date +%s)" "$(date +%s)" "$(date -R)")
printf '%s' "$MSG" | sendmail -f selftest@example.com "$ADDR"
sleep 4
echo "-- queue (empty = handed off):"; postqueue -p | tail -3
echo "-- last log lines:"
journalctl --since '2 min ago' --no-pager 2>/dev/null | grep -E 'triage|status=' | tail -5 || true
echo
echo "Done. The triage service's log should show '[mail triage-selftest-…] skipped by pre-filter: auto-submitted'."
