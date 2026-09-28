#!/bin/bash
# Read-only health check for the email path. Prints no secrets.
# Usage (as root):  bash scripts/email/check.sh
cd "$(dirname "$0")/../.."
INBOUND_DOMAIN="${INBOUND_DOMAIN:-inbound.flightsmojo.com}"
PASS=$(grep -E '^RAILS_INBOUND_EMAIL_PASSWORD=' .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//")
URL=$(grep -E '^INGRESS_URL=' /etc/postfix/chatwoot-ingress.env 2>/dev/null | cut -d= -f2-)
URL=${URL:-http://127.0.0.1:3001/rails/action_mailbox/relay/inbound_emails}

echo "== env";  grep -E '^(MAILER_INBOUND_EMAIL_DOMAIN|RAILS_INBOUND_EMAIL_SERVICE|SMTP_ADDRESS|SMTP_PORT|SMTP_USERNAME|MAILER_SENDER_EMAIL)=' .env
for k in RAILS_INBOUND_EMAIL_PASSWORD SMTP_PASSWORD; do grep -qE "^$k=.+" .env && echo "$k=(set)" || echo "$k=(EMPTY)"; done
echo "== containers"; docker ps --format '{{.Names}}: {{.Status}}' 2>/dev/null | grep flightsmojo-chatwoot || echo "(docker not reachable)"
echo "== dns";  echo "A  mx.flightsmojo.com -> $(getent hosts mx.flightsmojo.com | awk '{print $1}')"
if command -v dig >/dev/null; then echo "MX $INBOUND_DOMAIN -> $(dig +short MX "$INBOUND_DOMAIN")"
elif command -v host >/dev/null; then host -t MX "$INBOUND_DOMAIN" | tail -1; fi
echo "== postfix"; command -v systemctl >/dev/null && systemctl is-active postfix; ss -ltn | grep -q ':25 ' && echo "port 25 listening" || echo "port 25 NOT listening"
echo "queued messages: $(postqueue -p 2>/dev/null | grep -c '^[0-9A-F]')"
echo "== chatwoot relay endpoint (expect 204)"
[ -n "$PASS" ] && printf 'From: c@example.com\nTo: check@%s\nSubject: check\nMessage-ID: <check-%s@mx>\n\nok\n' "$INBOUND_DOMAIN" "$(date +%s)" | \
  curl -sS -o /dev/null -w 'HTTP %{http_code}\n' -H 'X-Forwarded-Proto: https' -u "actionmailbox:$PASS" -H 'Content-Type: message/rfc822' --data-binary @- "$URL"
echo "== last postfix events"; journalctl --since '1 hour ago' --no-pager 2>/dev/null | grep postfix | grep -E 'status=|reject|warning' | tail -8
