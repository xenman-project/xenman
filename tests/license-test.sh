#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# XenCenter's License Manager, read: a pool's licence as XenCenter judges it
# (LicenseStatus, LicenseDataGridViewRow), with the cloud-based licence a real
# host reports (fake-xapi.js, license-model) and the server's own time.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xlic-data; FX=/var/tmp/xlic-fake
PORT=3196; XPORT=4495
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xlic-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/license-model"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xlic-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xlic-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xlic-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }

echo "=== licensed, cloud-based, as xen-kpr-11 reports it ==="
check "answers" 200 "$(x license_overview)"
R='const r=d.row;'
check "column License and License Type: the marketing name without (cloud-based)" "XenServer Premium Edition" "$(field "$R r.license" < $BODY)"
check "Licensing Mode: Cloud-based" "Cloud-based" "$(field "$R r.mode" < $BODY)"
check "Status: Licensed; Active CSS, a tick" "Licensed; Active CSS ok" "$(field "$R r.status+' '+r.icon" < $BODY)"
check "Entitlement valid until: 9 February 2028" "2028-02-09" "$(field "$R r.expiry.slice(0,10)" < $BODY)"
check "License Server: lic08, linked to its web console" "license.example.com http://license.example.com:8082" \
  "$(field "$R r.licenseServer.text+' '+r.licenseServer.link" < $BODY)"
check "Licensed / Premium features enabled; Active support agreement" "Licensed|Premium features enabled ok Active support agreement ok" \
  "$(field "$R r.licenseLines.join('|')+' '+r.licenseIcon+' '+r.supportLines.join('|')+' '+r.supportIcon" < $BODY)"

echo "=== other states ==="
touch "$FX/lic-css-expired"; x license_overview >/dev/null
check "support ended: Expired CSS, a warning, XenCenter's message" "Licensed; Expired CSS warning error true" \
  "$(field "$R r.status+' '+r.icon+' '+r.supportIcon+' '+r.supportLines[1].startsWith('Your Customer Success Services (CSS) agreement has expired')" < $BODY)"
rm -f "$FX/lic-css-expired"
touch "$FX/lic-expiring"; x license_overview >/dev/null
check "ten days left, in regular grace: counted down by the server's time" "9 days; Active CSS warning Your license expires in 9 days" \
  "$(field "$R r.status+' '+r.icon+' '+r.licenseLines[0]" < $BODY)"
rm -f "$FX/lic-expiring"
touch "$FX/lic-partial"; x license_overview >/dev/null
check "one host free: partially licensed" "Partially Licensed; Active CSS The pool is partially licensed" \
  "$(field "$R r.status+' '+r.licenseLines[0]" < $BODY)"
rm -f "$FX/lic-partial"

echo "=== Assign License (ApplyLicenseEditionAction) ==="
check "no licence server entered: refused" 400 "$(x license_assign '"licenseServer":""')"
: > "$FX/calls.log"
check "lic09 assigned" 200 "$(x license_assign '"licenseServer":"lic09.example.org"')"
check "  the licence server on every host first, then the pool's edition: cloud" \
  'set_license_server xs-01 {"address":"lic09.example.org"}|set_license_server xs-02 {"address":"lic09.example.org"}|apply_edition cloud' \
  "$(grep -E '^(set_license_server|apply_edition) ' "$FX/calls.log" | head -2 | sort | paste -sd'|')|$(grep -E '^(set_license_server|apply_edition) ' "$FX/calls.log" | tail -1)"
x license_overview >/dev/null
check "  the License Manager shows it" "lic09.example.org" "$(field 'd.row.licenseServer.text' < $BODY)"
touch "$FX/lic-apply-fails"; : > "$FX/calls.log"
check "the licence server refuses: XenCenter's message, with XAPI's reason" "502 The licensing action for Production failed. LICENSE_CHECKOUT_ERROR cloud" \
  "$(x license_assign '"licenseServer":"lic10.example.org"') $(field d.error < $BODY)"
check "  and the licence servers are back to what they were" 'set_license_server xs-01 {"address":"lic09.example.org"}|set_license_server xs-02 {"address":"lic09.example.org"}' \
  "$(grep -E '^set_license_server ' "$FX/calls.log" | tail -2 | sort | paste -sd'|')"
rm -f "$FX/lic-apply-fails"
touch "$FX/ha"
check "HA on: refused with XenCenter's reason, and said in the overview" "409 The license for a host cannot be changed when HA is on true" \
  "$(x license_assign '"licenseServer":"lic09.example.org"') $(field d.error < $BODY) $(x license_overview >/dev/null; field d.ha < $BODY)"
rm -f "$FX/ha"
check "audited" 1 "$(grep -c '"action":"license_assign".*license server=lic09.example.org, edition=cloud' "$DATA/audit.jsonl" | head -1 | awk '{print ($1>0)?1:0}')"

echo "=== Release License (as XenCenter 8 did it on the test pool) ==="
check "not confirmed: refused" "409 true" "$(x license_release) $(field d.needsConfirm < $BODY)"
: > "$FX/calls.log"
check "confirmed: released" 200 "$(x license_release '"confirmRelease":true')"
check "  the edition trial on the pool, the licence server left alone" "apply_edition trial|0" \
  "$(grep -E '^apply_edition ' "$FX/calls.log" | paste -sd'|')|$(grep -c '^set_license_server' "$FX/calls.log")"
x license_overview >/dev/null
check "  the License Manager shows it unlicensed, no licence server" "Unlicensed; Active CSS null" "$(field 'd.row.status+" "+d.row.licenseServer' < $BODY)"
check "  assigned again: licensed" "200 Licensed; Active CSS" "$(x license_assign '"licenseServer":"license.example.com"') $(x license_overview >/dev/null; field d.row.status < $BODY)"
check "  audited" 1 "$(grep -c '"action":"license_release".*"outcome":"success".*edition=trial' "$DATA/audit.jsonl")"

echo "=== who may look ==="
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"viewer1","password":"Pass-12345-xm","role":"viewer"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/viewer1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xlic-v -X POST $B/api/auth/login $J -d '{"username":"viewer1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xlic-v -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
VS=$(field d.sessionRef < $BODY)
check "a viewer sees the licences" "200 XenServer Premium Edition" "$(x license_overview '' "-b /var/tmp/xlic-v" "$VS") $(field 'd.row.license' < $BODY)"
check "  but may not assign one" 403 "$(x license_assign '"licenseServer":"lic09.example.org"' "-b /var/tmp/xlic-v" "$VS")"

echo; echo "$pass passed, $fail failed"
exit $fail
