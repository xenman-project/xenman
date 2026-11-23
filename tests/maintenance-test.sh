#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Entering maintenance mode as XenCenter's EvacuateHostAction, against the fake
# pool (maint-model, WLB connected): what stops it asked first, WLB's
# recommendations followed, host.evacuate otherwise -- one by one when its plan
# fails as seen in the field (HOST_NOT_ENOUGH_FREE_MEMORY with memory free) --
# and the host out of maintenance mode again when anything failed.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xmt-data; FX=/var/tmp/xmt-fake
PORT=3193; XPORT=4493
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xmt-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/maint-model" "$FX/wlb-on"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xmt-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 XENMAN_MAINT_RETRY_MS=0 npx next start -p $PORT >> /var/tmp/xmt-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xmt-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
ours() { grep -v '^[A-Za-z_.]* \[' "$FX/calls.log"; }
H1=OpaqueRef:host-1; H2=OpaqueRef:host-2
# enter <hostRef>: starts the job and waits for its end; prints "state|step or error".
enter() {
  x host_maintenance_enter "\"hostRef\":\"$1\"" >/dev/null
  local id; id=$(field d.job.id < $BODY)
  for _ in $(seq 60); do
    x host_maintenance_job_status "\"jobId\":\"$id\"" >/dev/null
    [ "$(field d.job.state < $BODY)" != "running" ] && break
    sleep 0.5
  done
  field 'd.job.state+"|"+(d.job.error||d.job.step)' < $BODY
}
leave() { x host_maintenance_exit "\"hostRef\":\"$1\"" >/dev/null; }
# How many VMs are on a host now (the fake's state.json: VM name -> host name).
on() { x refresh >/dev/null; "$NODE" -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(Object.values(s.vms).filter((h)=>h===process.argv[2]).length)' "$FX/state.json" "$1"; }

echo "=== Without WLB recommendations: host.evacuate ==="
: > "$FX/calls.log"
check "xs-02 in maintenance mode" "done|xs-02 is in maintenance mode; all VMs migrated" "$(enter $H2)"
check "  asked WLB, disabled, flagged, evacuated (XenCenter's order)" \
  "wlb recommendations for xs-02: none|host.disable xs-02|MAINTENANCE_MODE=true on xs-02|host.evacuate xs-02" \
  "$(ours | grep -E '^(wlb|host\.(disable|evacuate|enable)|MAINTENANCE_MODE)' | paste -sd'|')"
leave $H2

echo "=== host.evacuate finds no plan (as in the field): one by one ==="
touch "$FX/evac-no-plan"; : > "$FX/calls.log"
check "xs-01 empty after all" "done|xs-01 is in maintenance mode; 2 VMs migrated one by one (XenServer found no plan for all at once)" "$(enter $H1)"
check "  each VM live to xs-02" "VM.pool_migrate db-01 to xs-02 live=true|VM.pool_migrate web-01 to xs-02 live=true" \
  "$(ours | grep '^VM.pool_migrate' | sort | paste -sd'|')"
leave $H1; rm -f "$FX/evac-no-plan"

echo "=== It fails: the host leaves maintenance mode again ==="
touch "$FX/evac-no-plan" "$FX/vm1-too-big"; : > "$FX/calls.log"
x host_maintenance_exit "\"hostRef\":\"$H2\"" >/dev/null
# Both VMs back on xs-01 first.
check "nothing takes web-01: failed, its name said" \
  "failed|xs-02 was not put into maintenance mode: No host takes web-01 (HOST_NOT_ENOUGH_FREE_MEMORY)" "$(enter $H2)"
check "  the flag removed, the host enabled again" "MAINTENANCE_MODE removed on xs-02|host.enable xs-02" \
  "$(ours | grep -E '^(MAINTENANCE_MODE removed|host\.enable)' | paste -sd'|')"
rm -f "$FX/evac-no-plan" "$FX/vm1-too-big"

echo "=== What stops it is asked first ==="
touch "$FX/stuck-vm"; : > "$FX/calls.log"
check "a VM that cannot move: refused, nothing changed" \
  "failed|xs-02 was not put into maintenance mode: These VMs cannot be moved off xs-02: web-01 (VM_REQUIRES_SR OpaqueRef:sr-local)" "$(enter $H2)"
check "  not disabled" 0 "$(ours | grep -c '^host.disable')"
rm -f "$FX/stuck-vm"

echo "=== With WLB's recommendations ==="
leave $H1; leave $H2
touch "$FX/wlb-recs"; : > "$FX/calls.log"
N=$(on xs-02); [ "$N" = 1 ] && VMS=VM || VMS=VMs
check "xs-02 emptied as WLB recommends ($N on it)" "done|xs-02 is in maintenance mode; $N $VMS migrated as WLB recommended" "$(enter $H2)"
check "  VM by VM, no host.evacuate, none left" "0 $N 0" "$(ours | grep -c '^host.evacuate') $(ours | grep -c '^VM.pool_migrate') $(on xs-02)"
leave $H2; rm -f "$FX/wlb-recs"
touch "$FX/wlb-recs-error"; : > "$FX/calls.log"
check "WLB says a VM cannot go: refused before anything changed" "failed 0" \
  "$(enter $H1 | cut -d'|' -f1) $(ours | grep -c '^host.disable')"
check "  with WLB's reason" "true" "$(field '/: (web-01|db-01): VM_REQUIRES_SR OpaqueRef:sr-local$/.test(d.job.error)' < $BODY)"
rm -f "$FX/wlb-recs-error"
touch "$FX/wlb-recs-offline"; : > "$FX/calls.log"
check "WLB recommends a host that is down: not followed, host.evacuate instead" "done 1" \
  "$(enter $H1 | cut -d'|' -f1) $(ours | grep -c '^host.evacuate')"
leave $H1; rm -f "$FX/wlb-recs-offline"
# As in the field: WLB leaves a (vGPU) VM out of its plan, xapi names it
# HOST_NOT_ENOUGH_FREE_MEMORY -- XenCenter stops; XenMan moves it live itself.
touch "$FX/wlb-recs-nomem"; : > "$FX/calls.log"
N=$(on xs-02); R=$((N-1)); [ "$R" = 1 ] && VMS=VM || VMS=VMs
check "WLB has no host for one VM ($N on xs-02): the rest as WLB says, that one live by XenMan" \
  "done|xs-02 is in maintenance mode; $R $VMS migrated as WLB recommended, 1 one by one (WLB had no host for it)" "$(enter $H2)"
check "  all live, no host.evacuate, none left" "0 $N 0 0" \
  "$(ours | grep -c '^host.evacuate') $(ours | grep -c 'live=true') $(ours | grep '^VM.pool_migrate' | grep -vc 'live=true') $(on xs-02)"
leave $H2; rm -f "$FX/wlb-recs-nomem"

echo "=== Audit and who may ==="
check "the end of each job audited" "true true" \
  "$(grep -q '"action":"host_maintenance_enter_finished".*"outcome":"success"' "$DATA/audit.jsonl" && echo true || echo false) $(grep -q '"action":"host_maintenance_enter_finished".*"outcome":"failure".*No host takes web-01' "$DATA/audit.jsonl" && echo true || echo false)"
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Pass-12345-xm","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xmt-o -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xmt-o -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; OS=$(field d.sessionRef < $BODY)
check "an operator may not" 403 "$(x host_maintenance_enter "\"hostRef\":\"$H2\"" "-b /var/tmp/xmt-o" "$OS")"
: > "$FX/calls.log"
check "  nor restart or shut down a server (the Power menu is for administrators)" "403 403" \
  "$(x host_reboot "\"hostRef\":\"$H2\"" "-b /var/tmp/xmt-o" "$OS") $(x host_shutdown "\"hostRef\":\"$H2\"" "-b /var/tmp/xmt-o" "$OS")"
check "  nothing reached the pool (not even host.disable)" 0 "$(ours | grep -cE '^host\.(disable|reboot|shutdown)')"
check "a host's other_config is not open to anyone through the API any more" "400 400" \
  "$(x host_add_other_config "\"hostRef\":\"$H2\",\"key\":\"k\",\"value\":\"v\"") $(x host_remove_other_config "\"hostRef\":\"$H2\",\"key\":\"k\"")"

echo; echo "$pass passed, $fail failed"
exit $fail
