#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# An update whose host evacuation XenServer does not finish (1.0.3), as seen
# in the field: the host empty, the task at 97 % for an hour; cancelled, it
# stayed on the host and every migration to it was refused until the
# coordinator's toolstack restarted.
#   evac-hang-cancels  the cancel works: the step goes on after a short wait
#   evac-hang          it does not: the job waits for an administrator, with a
#                      mail; confirmed, the coordinator's toolstack restarts
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/eh-data; FX=/var/tmp/eh-fake; MAIL=/var/tmp/eh-mail
PORT=3171; XPORT=4471; SPORT=2571
BASE="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
B=/var/tmp/eh-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $B -w "%{http_code}" "$@"; }
pool() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync('$FX/state.json','utf8')); $1"; }
rm -rf "$DATA" "$FX" "$MAIL"; mkdir -p "$DATA" "$FX" "$MAIL"; echo normal > "$FX/mode"
start_fake_with() { [ -n "${FPID:-}" ] && kill $FPID 2>/dev/null; sleep 0.3; rm -f "$FX/calls.log" "$FX/state.json"; for f in "$@"; do touch "$FX/$f"; done; FAKE_DOWN_MS=2500 "$NODE" $TESTS/fake-xapi.js $XPORT "$FX" > /dev/null 2>&1 & FPID=$!; sleep 0.5; }
"$NODE" $TESTS/smtp-sink.js $SPORT $MAIL & SPID=$!
start_fake_with
cd $W
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 XENMAN_XU_POLL_MS=300 XENMAN_XU_DOWN_MS=6000 XENMAN_XU_UP_MS=30000 \
  XENMAN_XU_RETRY_DELAYS_MS=1000,1500,2000 XENMAN_XU_EVACUATE_MS=60000 XENMAN_XU_SETTLE_MS=500 XENMAN_XU_GPU_WAIT_MS=2000 \
  XENMAN_XU_EVAC_EMPTY_MS=1500 XENMAN_XU_SETTLED_CHECK_MS=500 XENMAN_XU_STUCK_CLEAR_MS=1500 \
  npx next start -p $PORT > /var/tmp/eh-server.log 2>&1 & PID=$!
trap 'kill $PID $FPID $SPID 2>/dev/null' EXIT
for _ in $(seq 60); do curl -s -o /dev/null $BASE/login && break; sleep 1; done
C=/var/tmp/eh-cookie
curl -s -c $C -X POST $BASE/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $BASE/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $BASE/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
A="-b $C"
curl -s $A -X POST $BASE/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
curl -s $A -X POST $BASE/api/smtp $J -d "{\"host\":\"127.0.0.1\",\"port\":$SPORT,\"from\":\"xenman@example.org\",\"encryption\":\"none\",\"validateCertificate\":false,\"username\":\"\",\"password\":\"\"}" >/dev/null
curl -s $A -X PUT $BASE/api/auth/users/admin $J -d '{"email":"admin@example.org"}' >/dev/null
curl -s $A -X POST "$BASE/api/auth/users" $J -d '{"username":"op3","password":"Maple-Root-2468","role":"operator","pools":["pool1"]}' >/dev/null
curl -s $A -X PUT "$BASE/api/auth/users/op3" $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/eh-cookie2 -X POST "$BASE/api/auth/login" $J -d '{"username":"op3","password":"Maple-Root-2468"}' >/dev/null
O="-b /var/tmp/eh-cookie2"
JB="$BASE/api/xen-updates/jobs"
start() { code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true,"moveVmsBack":true}' >/dev/null; ID=$(field 'd.job.id' < $B); }
finish() { for _ in $(seq 160); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done; }
waiting() { for _ in $(seq 80); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'Boolean(d.job.attention)' < $B)" = true ] && return; [ "$(field 'd.job.state' < $B)" != running ] && return; sleep 0.5; done; }
mails() { ls $MAIL | wc -l; }
last() { $NODE -e 'const fs=require("fs");const d=process.argv[1];const f=fs.readdirSync(d).sort((a,b)=>parseInt(a)-parseInt(b)).pop();process.stdout.write(fs.readFileSync(d+"/"+f,"latin1").replace(/=\r?\n/g,"").replace(/=([0-9A-F]{2})/g,(m,h)=>String.fromCharCode(parseInt(h,16))))' $MAIL; }
audited() { grep -c "\"action\":\"$1\"" "$DATA/audit.jsonl"; }

echo "=== the evacuation hangs, the host empty, the cancel works ==="
start_fake_with evac-hang-cancels
T0=$(date +%s); start; finish; T1=$(date +%s)
check "finished" done "$(field 'd.job.state' < $B)"
check "  long before the evacuation timeout (60 s)" true "$([ $((T1 - T0)) -lt 55 ] && echo true || echo false)"
check "  the hung evacuation cancelled" 1 "$(grep -c '^cancelled OpaqueRef:task' "$FX/calls.log")"
check "  said so" true "$(field 'd.job.notes.some(n=>n.startsWith("Evacuation of xs-01 did not complete although no VMs remained"))' < $B)"
check "  nobody asked" "false 0" "$(field 'Boolean(d.job.attention)' < $B) $(audited xen_update_attention)"
check "  web-01 back on xs-01" xs-01 "$(pool 'd.vms["web-01"]')"
N0=$(mails)

echo "=== the cancel does not work: an administrator is asked ==="
start_fake_with evac-hang
start; waiting
check "paused, still running" "true running" "$(field 'Boolean(d.job.attention)' < $B) $(field 'd.job.state' < $B)"
check "  names the host and the coordinator" "xs-01 xs-01" "$(field 'd.job.attention.hostNames.join()+" "+d.job.attention.coordinatorName' < $B)"
check "  the step says what it waits for" true "$(field 'd.job.steps.some(s=>s.state==="running"&&(s.detail||"").startsWith("waiting for an administrator"))' < $B)"
check "  the cancel was ignored by XenServer" 1 "$(grep -c '^cancel ignored' "$FX/calls.log")"
check "  audited" 1 "$(audited xen_update_attention)"
for _ in $(seq 20); do [ "$(mails)" -gt "$N0" ] && break; sleep 0.3; done
check "  one mail: attention needed" "$((N0 + 1)) true" "$(mails) $(last | grep -A1 '^Subject:' | tr -d '\r\n' | grep -q 'attention_needed' && echo true || echo false)"
check "  it says what the button does" true "$(last | tr -d '\r\n' | grep -q "Restart the coordinator's toolstack and continue" && echo true || echo false)"
check "  no VM moved to the blocked host meanwhile" 0 "$(grep -c '^migrate refused' "$FX/calls.log")"
check "an operator may not confirm" 403 "$(code $O -X POST "$JB" $J -d "{\"action\":\"restart-coordinator\",\"id\":\"$ID\"}")"
check "  nothing restarted" 0 "$(grep -c 'evacuation mark of' "$FX/calls.log")"
check "an admin confirms" 200 "$(code $A -X POST "$JB" $J -d "{\"action\":\"restart-coordinator\",\"id\":\"$ID\"}")"
check "  audited" 1 "$(audited xen_update_coordinator_restart_confirmed)"
check "  a second confirm: not waiting any more" 409 "$(code $A -X POST "$JB" $J -d "{\"action\":\"restart-coordinator\",\"id\":\"$ID\"}")"
finish
check "the update finished" done "$(field 'd.job.state' < $B)"
check "  after the coordinator's toolstack restart" 1 "$(grep -c 'evacuation mark of xs-01 cleared' "$FX/calls.log")"
check "  no longer paused" false "$(field 'Boolean(d.job.attention)' < $B)"
check "  said who confirmed" true "$(field 'd.job.notes.some(n=>n.includes("The toolstack on the pool coordinator xs-01 was restarted (confirmed by admin)"))' < $B)"
check "  web-01 back on xs-01" xs-01 "$(pool 'd.vms["web-01"]')"

echo "=== stopped while it waits ==="
start_fake_with evac-hang
start; waiting
check "paused" true "$(field 'Boolean(d.job.attention)' < $B)"
code $A -X POST "$JB" $J -d "{\"action\":\"stop\",\"id\":\"$ID\"}" >/dev/null
finish
check "  stopped, nothing restarted" "stopped 0" "$(field 'd.job.state' < $B) $(grep -c 'evacuation mark of' "$FX/calls.log")"
check "  no longer paused" false "$(field 'Boolean(d.job.attention)' < $B)"

echo; echo "$pass passed, $fail failed"
exit $fail
