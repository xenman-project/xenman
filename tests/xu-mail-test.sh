#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The mail to the administrators at the end of a XenServer update: finished,
# failed, stopped -- and none when switched off or no mail server is set up.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xm-data; FX=/var/tmp/xm-fake; MAIL=/var/tmp/xm-mail
PORT=3160; XPORT=4495; SPORT=2595
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
rm -rf $DATA $FX $MAIL; mkdir -p $DATA $FX $MAIL; echo normal > $FX/mode
start_fake() { [ -n "${FPID:-}" ] && kill $FPID 2>/dev/null; sleep 0.3; rm -f $FX/calls.log; $NODE $TESTS/fake-xapi.js $XPORT $FX > /dev/null 2>&1 & FPID=$!; sleep 0.5; }
start_fake
$NODE $TESTS/smtp-sink.js $SPORT $MAIL & SPID=$!
cd $W
DATA_DIR=$DATA NEXT_TELEMETRY_DISABLED=1 XENMAN_XU_POLL_MS=300 XENMAN_XU_DOWN_MS=6000 XENMAN_XU_UP_MS=30000 XENMAN_XU_RETRY_DELAYS_MS=1000,1500,2000 \
  XENMAN_XU_EVACUATE_MS=4000 XENMAN_XU_SETTLE_MS=500 XENMAN_XU_GPU_WAIT_MS=2000 XENMAN_XU_HOST_RETRY_MS=300,300 \
  npx next start -p $PORT > /var/tmp/xm-server.log 2>&1 & PID=$!
trap 'kill $PID $FPID $SPID 2>/dev/null' EXIT
for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 1; done
C=/var/tmp/xm-cookie
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
A="-b $C"
curl -s $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
JB=$B/api/xen-updates/jobs
field() { $NODE -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
run_job() { # run_job <json extra>: starts a pool update, waits for its end, prints the state
  local id; id=$(curl -s $A -X POST $JB $J -d "{\"hostId\":\"pool1\",\"target\":\"pool\",\"automatic\":true$1}" | field d.job.id)
  for _ in $(seq 160); do s=$(curl -s $A "$JB?id=$id" | field d.job.state); [ "$s" != running ] && break; sleep 0.5; done
  sleep 1.5; echo "$s"
}
mails() { ls $MAIL | wc -l; }
# The last mail, quoted-printable undone, so plain text can be searched.
last() { $NODE -e 'const fs=require("fs");const d=process.argv[1];const f=fs.readdirSync(d).sort((a,b)=>parseInt(a)-parseInt(b)).pop();process.stdout.write(fs.readFileSync(d+"/"+f,"latin1").replace(/=\r?\n/g,"").replace(/=([0-9A-F]{2})/g,(m,h)=>String.fromCharCode(parseInt(h,16))))' $MAIL; }
auditlast() { $NODE -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).filter(x=>x.action==="xen_update_mail");const x=l.pop();console.log(x?x.outcome+" "+x.detail:"none")' $DATA/audit.jsonl; }

echo "=== no mail server ==="
check "plan says so" "false 0" "$(curl -s $A -X POST $JB $J -d '{"hostId":"pool1","target":"pool","dryRun":true}' | field 'd.plan.mail.smtpConfigured+" "+d.plan.mail.adminsWithEmail')"
check "the update still runs" done "$(run_job '')"
check "  no mail, and the audit log says why" "0 failure not sent: no mail server is set up" "$(mails) $(auditlast)"

echo "=== with a mail server and an admin's address ==="
curl -s $A -X POST $B/api/smtp $J -d "{\"host\":\"127.0.0.1\",\"port\":$SPORT,\"from\":\"xenman@example.org\",\"encryption\":\"none\",\"validateCertificate\":false,\"username\":\"\",\"password\":\"\"}" >/dev/null
curl -s $A -X PUT $B/api/auth/users/admin $J -d '{"email":"admin@example.org"}' >/dev/null
check "plan says it can reach someone" "true 1" "$(curl -s $A -X POST $JB $J -d '{"hostId":"pool1","target":"pool","dryRun":true}' | field 'd.plan.mail.smtpConfigured+" "+d.plan.mail.adminsWithEmail')"
start_fake
check "finished" done "$(run_job '')"
check "  one mail, to the admin" "1 <admin@example.org>" "$(mails) $(last | grep -m1 '^X-Rcpt:' | sed 's/X-Rcpt: //')"
check "  subject" 1 "$(last | grep -c '^Subject: XenMan: update of pool Production finished')"
check "  short: one line for the hosts that went through, none of their steps" "1 0 0" \
  "$(last | grep -c '^2 hosts updated') $(last | grep -c '^xs-0') $(last | grep -c 'Install 2 updates')"
check "  the plan's warnings left out of it" 0 "$(last | grep -c 'Workload Balancing is paused')"
check "  links to XenMan as it was used" 1 "$(last | grep -m1 -c "XenMan: http://127.0.0.1:$PORT/")"
check "  audited as sent" "success sent to 1 administrator" "$(auditlast)"
check "  dates in the default format, English (US)" 1 "$(last | grep -cE '^Started by admin on [0-9]{1,2}/[0-9]{1,2}/20[0-9]{2}, [0-9]{1,2}:[0-9]{2}:[0-9]{2} (AM|PM), ended ')"

start_fake; touch $FX/apply-fails
check "failed" failed "$(run_job '')"
check "  mail says so, with the error" "1 1" "$(last | grep -c '^Subject: XenMan: update of pool Production failed') $(last | grep -m1 -c 'APPLY_UPDATES_FAILED')"
check "  the host it stopped at listed, with what was left" "1 1" "$(last | grep -c '^xs-01$') $(last | grep -m1 -c 'Restart host')"
rm -f $FX/apply-fails

start_fake
N=$(mails)
check "switched off in the dialog" done "$(run_job ',"mail":false')"
check "  no mail" "$N" "$(mails)"

start_fake; touch $FX/evacuate-slow
id=$(curl -s $A -X POST $JB $J -d '{"hostId":"pool1","target":"pool","automatic":true}' | field d.job.id)
for _ in $(seq 60); do grep -q Async.host.evacuate $FX/calls.log 2>/dev/null && break; sleep 0.1; done
curl -s $A -X POST $JB $J -d "{\"action\":\"stop\",\"id\":\"$id\"}" >/dev/null
for _ in $(seq 120); do s=$(curl -s $A "$JB?id=$id" | field d.job.state); [ "$s" != running ] && break; sleep 0.5; done; sleep 1.5
check "stopped" stopped "$s"
check "  mail says who stopped it" "1 1" "$(last | grep -c '^Subject: XenMan: update of pool Production was stopped') $(last | grep -m1 -c 'was stopped by admin')"
rm -f $FX/evacuate-slow

echo "=== links in mails ==="
reset() { curl -s -o /dev/null -X POST $B/api/auth/forgot-password $J ${1:+-H "Host: $1"} -d '{"usernameOrEmail":"admin"}'; sleep 1.5; }
link() { last | grep -m1 -o "https\?://[^ <\"]*$1[^ <\"]*" | head -1; }
reset evil.example.com
check "a reset mail never points where the request claims to come from" 0 "$(last | grep -c 'evil.example.com')"
check "  but to this server's own address" true "$(link /reset-password | grep -qE '^https://[0-9.]+(:[0-9]+)?/reset-password\?token=' && echo true || echo false)"
check "an address that is no web address is refused" "400 400" "$(for u in 'ftp://x.example.org' 'javascript:alert(1)'; do curl -s -o /dev/null -w '%{http_code} ' $A -X POST $B/api/smtp $J -d "{\"host\":\"127.0.0.1\",\"port\":$SPORT,\"from\":\"xenman@example.org\",\"encryption\":\"none\",\"validateCertificate\":false,\"username\":\"\",\"password\":\"\",\"publicUrl\":\"$u\"}"; done | sed 's/ $//')"
curl -s $A -X POST $B/api/smtp $J -d "{\"host\":\"127.0.0.1\",\"port\":$SPORT,\"from\":\"xenman@example.org\",\"encryption\":\"none\",\"validateCertificate\":false,\"username\":\"\",\"password\":\"\",\"publicUrl\":\"https://xenman.example.org/\"}" >/dev/null
check "the set address is stored tidied" https://xenman.example.org "$(curl -s $A $B/api/smtp | field d.publicUrl)"
reset evil.example.com
check "a reset mail then points there" true "$(link /reset-password | grep -q '^https://xenman.example.org/reset-password?token=' && echo true || echo false)"
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"inv1","role":"viewer","email":"inv1@example.org"}' >/dev/null; sleep 1.5
check "so does an invitation" true "$(link /invite | grep -q '^https://xenman.example.org/invite?token=' && echo true || echo false)"
start_fake
run_job '' >/dev/null
check "and the update report" 1 "$(last | grep -m1 -c 'XenMan: https://xenman.example.org/')"

echo "=== the date format (Settings -> Time) ==="
DS=$B/api/display-settings
check "English (US) unless set" en-US "$(curl -s $A $DS | field d.dateFormat)"
check "an unknown format is refused" 400 "$(curl -s -o /dev/null -w '%{http_code}' $A -X POST $DS $J -d '{"dateFormat":"klingon"}')"
check "set to German" de-DE "$(curl -s $A -X POST $DS $J -d '{"dateFormat":"de-DE"}' | field d.dateFormat)"
check "  audited" 1 "$(grep -c '"action":"date_format_saved".*"detail":"en-US -> de-DE"' $DATA/audit.jsonl)"
start_fake
run_job '' >/dev/null
check "  the update mail then says 04.11.2026, 14:17:50" 1 "$(last | grep -cE '^Started by admin on [0-9]{2}\.[0-9]{2}\.20[0-9]{2}, [0-9]{2}:[0-9]{2}:[0-9]{2}, ended ')"
check "set to ISO 8601" iso "$(curl -s $A -X POST $DS $J -d '{"dateFormat":"iso"}' | field d.dateFormat)"
start_fake
run_job '' >/dev/null
check "  the mail then says 2026-11-04 14:17:50" 1 "$(last | grep -cE '^Started by admin on 20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}, ended ')"
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"view2","password":"Pass-12345-xm","role":"viewer"}' >/dev/null
curl -s -c /var/tmp/xm-v -X POST $B/api/auth/login $J -d '{"username":"view2","password":"Pass-12345-xm"}' >/dev/null
check "everyone reads it, only an admin sets it" "iso 403" \
  "$(curl -s -b /var/tmp/xm-v $DS | field d.dateFormat) $(curl -s -o /dev/null -w '%{http_code}' -b /var/tmp/xm-v -X POST $DS $J -d '{"dateFormat":"en-US"}')"

echo; echo "$pass passed, $fail failed"; exit $fail
