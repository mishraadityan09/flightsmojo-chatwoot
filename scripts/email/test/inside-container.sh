# Runs INSIDE the disposable container (see run-in-docker.sh). Not for the server.
# Exercises every email script on a clean Ubuntu with a fake Chatwoot endpoint.
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q python3 iproute2 curl ca-certificates >/dev/null
mkdir -p /root/flightsmojo-chatwoot/scripts && cp -r /work/email /root/flightsmojo-chatwoot/scripts/email && cd /root/flightsmojo-chatwoot
cp /env.example .env
sed -i 's/^MAILER_SENDER_EMAIL=.*/MAILER_SENDER_EMAIL=""/' .env   # quoted-empty must count as empty
q() { postqueue -p | grep -c '^[0-9A-F]' || true; }
say() { echo; echo "########## $*"; }

say "1) env-setup.sh twice (idempotent, backups outside the repo)"
bash scripts/email/env-setup.sh >/tmp/env1.log; P1=$(grep '^RAILS_INBOUND_EMAIL_PASSWORD=' .env | cut -d= -f2-)
bash scripts/email/env-setup.sh >/tmp/env2.log; P2=$(grep '^RAILS_INBOUND_EMAIL_PASSWORD=' .env | cut -d= -f2-)
echo "password kept on re-run: $([ "$P1" = "$P2" ] && echo yes || echo NO)"
echo "duplicate keys: $(grep -oE '^[A-Z_]+=' .env | sort | uniq -d | tr '\n' ' ')(none expected)"
echo "sender: $(grep '^MAILER_SENDER_EMAIL=' .env)"
echo "backups in /root/env-backups: $(ls -A /root/env-backups | wc -l) (expect 2); backup files in repo: $(ls -A | grep -c 'bak' || true) (expect 0)"
grep -q -- '--no-deps' /tmp/env2.log && echo "next-step hint uses --no-deps: yes"

say "2) postfix-setup.sh twice (idempotent)"
PW="$P2" python3 /test/fake_chatwoot.py >/tmp/fake.log 2>&1 & FAKE=$!; sleep 1
bash scripts/email/postfix-setup.sh >/tmp/setup1.log 2>&1; bash scripts/email/postfix-setup.sh >/tmp/setup2.log 2>&1
grep -E 'direct POST|listening' /tmp/setup2.log
echo "chatwoot entries in master.cf: $(grep -c '^chatwoot ' /etc/postfix/master.cf) (expect 1)"
postconf -n | grep -E 'concurrency_limit|recipient_limit|default_transport|relay_restrictions'
postconf -M chatwoot/unix
ls -l /etc/postfix/chatwoot-ingress.env | awk '{print "secret file:", $1, $3":"$4}'; stat -c 'main.cf mode: %a' /etc/postfix/main.cf

IP=$(hostname -I | awk '{print $1}')
say "3) SMTP from outside ($IP) and loopback: accept inbound domain only"
python3 - "$IP" <<'PY'
import smtplib, sys
for host in [sys.argv[1], "127.0.0.1"]:
  for rcpt, label in [("a1b2c3@inbound.flightsmojo.com","inbound"),("victim@gmail.com","foreign"),("someone@flightsmojo.com","parent")]:
    s = smtplib.SMTP(host, 25, timeout=10); s.ehlo("sender.example.net")
    try:
        s.sendmail("customer@gmail.com",[rcpt],f"From: c@gmail.com\r\nTo: care@flightsmojo.com\r\nSubject: {label}\r\nMessage-ID: <{label}-{host}@x>\r\n\r\nbody\r\n")
        print(f"  from {host:12s} {label:8s} ACCEPTED")
    except smtplib.SMTPRecipientsRefused as e:
        code,msg=list(e.recipients.values())[0]; print(f"  from {host:12s} {label:8s} REFUSED {code} {msg.decode()}")
    finally: s.quit()
PY
sleep 3; grep 'Subject: inbound' /tmp/fake.log | head -1

say "4) locally submitted foreign mail never leaves"
printf 'Subject: escape\n\nx\n' | sendmail -f a@b.c victim@gmail.com; sleep 3
grep 'victim@gmail.com' /var/log/postfix.log | grep -oE 'status=[a-z]+ \(.{0,60}' | tail -1
echo "outbound connections to other mail servers: $(grep -cE 'relay=[a-z0-9.-]+\[[0-9.]+\]:25' /var/log/postfix.log) (expect 0)"

say "5) Chatwoot down -> deferred, not bounced; back -> delivered"
kill $FAKE; sleep 1
printf 'To: care@flightsmojo.com\nSubject: while-down\n\nx\n' | sendmail -f c@gmail.com a1b2c3@inbound.flightsmojo.com; sleep 4
echo "queued while down: $(q) (expect 1)"
PW="$P2" python3 /test/fake_chatwoot.py >>/tmp/fake.log 2>&1 & FAKE=$!; sleep 1; postqueue -f; sleep 4
echo "queued after flush: $(q) (expect 0); delivered: $(grep -c 'while-down' /tmp/fake.log)"

say "6) secret file unreadable -> deferred, not bounced"
mv /etc/postfix/chatwoot-ingress.env /tmp/hold.env
printf 'To: care@flightsmojo.com\nSubject: no-secret\n\nx\n' | sendmail -f c@gmail.com a1b2c3@inbound.flightsmojo.com; sleep 4
echo "queued without secret: $(q) (expect 1)"
mv /tmp/hold.env /etc/postfix/chatwoot-ingress.env; postqueue -f; sleep 4
echo "queued after restore: $(q) (expect 0); delivered: $(grep -c 'no-secret' /tmp/fake.log)"

say "7) check.sh"
bash scripts/email/check.sh 2>&1 | grep -vE '^$' | head -16
say "every bounce in the log (expect only the escape test and its own notice, both local):"
grep 'status=bounced' /var/log/postfix.log | grep -oE 'to=<[^>]*>, relay=[a-z]+' 
