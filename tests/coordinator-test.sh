#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# A new pool coordinator, against the fake pool (maint-model + coord-model):
# with maintenance mode, as XenCenter's EvacuateHostDialog/EvacuateHostAction
# (Pool.async_designate_new_master once the host is empty), or on its own
# ("Make Pool Coordinator"). What stops it (a pool secret rotation, HA being
# switched on) said in XenCenter's words; a failed change takes the host out of
# maintenance mode again; a coordinator that stops answering while it hands
# over is checked again over a new session.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xct-data; FX=/var/tmp/xct-fake
PORT=3194; XPORT=4494
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xct-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/maint-model" "$FX/coord-model"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xct-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 XENMAN_MAINT_RETRY_MS=0 XENMAN_COORD_POLL_MS=300 npx next start -p $PORT >> /var/tmp/xct-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xct-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
connect() { code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; S=$(field d.sessionRef < $BODY); }
connect
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
ours() { grep -v '^[A-Za-z_.]* \[' "$FX/calls.log"; }
H1=OpaqueRef:host-1; H2=OpaqueRef:host-2
# wait: follows the job in $BODY to its end; prints "state|step or error".
wait_job() {
  local id; id=$(field d.job.id < $BODY)
  for _ in $(seq 80); do
    x host_maintenance_job_status "\"jobId\":\"$id\"" >/dev/null
    [ "$(field d.job.state < $BODY)" != "running" ] && break
    sleep 0.5
  done
  field 'd.job.state+"|"+(d.job.error||d.job.step)' < $BODY
}
# enter <hostRef> [newCoordinatorRef]
enter() {
  x host_maintenance_enter "\"hostRef\":\"$1\"${2:+,\"newCoordinatorRef\":\"$2\"}" >/dev/null
  wait_job
}
leave() { x host_maintenance_exit "\"hostRef\":\"$1\"" >/dev/null; }
coordinator() { x pool_coordinator_options "\"hostRef\":\"$H1\"" >/dev/null; field d.coordinator.name < $BODY; }

echo "=== What the dialogs are offered ==="
check "xs-01: the coordinator, xs-02 can take over, nothing stops it" "true|xs-02|null" \
  "$(x pool_coordinator_options "\"hostRef\":\"$H1\"" >/dev/null; field 'd.isCoordinator+"|"+d.candidates.map(c=>c.name).join(",")+"|"+d.blocked' < $BODY)"
check "xs-02: not the coordinator" "false|xs-01" \
  "$(x pool_coordinator_options "\"hostRef\":\"$H2\"" >/dev/null; field 'd.isCoordinator+"|"+d.coordinator.name' < $BODY)"

echo "=== Maintenance mode for the coordinator, xs-02 to take over (EvacuateHostAction) ==="
: > "$FX/calls.log"
check "xs-01 empty, then xs-02 the coordinator" "done|xs-01 is in maintenance mode; all VMs migrated; xs-02 is the new pool coordinator" "$(enter $H1 $H2)"
check "  the job says the coordinator changed" true "$(field d.job.coordinatorChanged < $BODY)"
check "  disabled, flagged, evacuated, then designated (XenCenter's order)" \
  "host.disable xs-01|MAINTENANCE_MODE=true on xs-01|host.evacuate xs-01|pool.designate_new_master xs-02" \
  "$(ours | grep -E '^(host\.(disable|evacuate|enable)|MAINTENANCE_MODE|pool\.designate)' | paste -sd'|')"
# As XAPI says it: SESSION_INVALID, on which the browser connects again (xen-context).
check "  the old session is gone with the old coordinator" "500|SESSION_INVALID" \
  "$(x pool_coordinator_options "\"hostRef\":\"$H1\"")|$(field 'd.error.split(" ")[0]' < $BODY)"
connect
check "  connected again: the pool names xs-02" xs-02 "$(coordinator)"
leave $H1

echo "=== Keep as coordinator: maintenance mode as before ==="
: > "$FX/calls.log"
check "xs-02 in maintenance mode, still the coordinator" "done|xs-02 is in maintenance mode; all VMs migrated" "$(enter $H2)"
check "  no designate_new_master" "0 xs-02" "$(ours | grep -c '^pool.designate') $(coordinator)"
leave $H2

echo "=== What stops a change, in XenCenter's words ==="
touch "$FX/psr-pending"; : > "$FX/calls.log"
check "pool secret rotation pending: refused before anything changed" 409 "$(x host_maintenance_enter "\"hostRef\":\"$H2\",\"newCoordinatorRef\":\"$H1\"")"
check "  its reason" "You cannot nominate a new coordinator while a pool secret rotation is in progress." "$(field d.error < $BODY)"
check "  not disabled" 0 "$(ours | grep -c '^host.disable')"
check "  Make Pool Coordinator refused as well" 409 "$(x pool_designate_coordinator "\"hostRef\":\"$H1\"")"
check "  the dialogs are told" "You cannot nominate a new coordinator while a pool secret rotation is in progress." \
  "$(x pool_coordinator_options "\"hostRef\":\"$H2\"" >/dev/null; field d.blocked < $BODY)"
rm -f "$FX/psr-pending"; touch "$FX/ha-enabling"
check "HA being switched on: refused" "409|You cannot nominate a new coordinator while HA is being enabled on the pool." \
  "$(x pool_designate_coordinator "\"hostRef\":\"$H1\"")|$(field d.error < $BODY)"
rm -f "$FX/ha-enabling"

echo "=== What makes no sense ==="
check "the coordinator to itself" "400|xs-02 is already the pool coordinator" \
  "$(x host_maintenance_enter "\"hostRef\":\"$H2\",\"newCoordinatorRef\":\"$H2\"")|$(field d.error < $BODY)"
check "a member with a new coordinator" "400|xs-01 is not the pool coordinator" \
  "$(x host_maintenance_enter "\"hostRef\":\"$H1\",\"newCoordinatorRef\":\"$H2\"")|$(field d.error < $BODY)"
check "a host the pool does not have" "400|No such host in this pool" \
  "$(x host_maintenance_enter "\"hostRef\":\"$H2\",\"newCoordinatorRef\":\"OpaqueRef:host-9\"")|$(field d.error < $BODY)"
check "Make Pool Coordinator on the coordinator" 400 "$(x pool_designate_coordinator "\"hostRef\":\"$H2\"")"
enter $H1 >/dev/null
check "a host in maintenance mode cannot take over" "400|xs-01 is not enabled and running, so it cannot become the coordinator" \
  "$(x pool_designate_coordinator "\"hostRef\":\"$H1\"")|$(field d.error < $BODY)"
leave $H1

echo "=== The change fails: the host leaves maintenance mode again ==="
touch "$FX/designate-fails"; : > "$FX/calls.log"
check "failed, XAPI's reason said" "failed|xs-02 was not put into maintenance mode: INTERNAL_ERROR designate refused" "$(enter $H2 $H1)"
check "  the flag removed, the host enabled again, xs-02 still the coordinator" "MAINTENANCE_MODE removed on xs-02|host.enable xs-02|xs-02" \
  "$(ours | grep -E '^(MAINTENANCE_MODE removed|host\.enable)' | paste -sd'|')|$(coordinator)"
rm -f "$FX/designate-fails"

echo "=== Make Pool Coordinator; the old one stops answering as it hands over ==="
touch "$FX/designate-drops"; : > "$FX/calls.log"
x pool_designate_coordinator "\"hostRef\":\"$H1\"" >/dev/null
check "confirmed over a new session" "done|Nominated server xs-01 as new coordinator (was xs-02)" "$(wait_job)"
check "  no VM moved, no host disabled" "0 0" "$(ours | grep -c '^VM.pool_migrate\|^host.evacuate') $(ours | grep -c '^host.disable')"
connect
check "  connected again: the pool names xs-01" xs-01 "$(coordinator)"
rm -f "$FX/designate-drops"

echo "=== Audit and who may ==="
check "the change audited" "true true" \
  "$(grep -q '"action":"pool_designate_coordinator".*"outcome":"success".*Nominated server xs-01' "$DATA/audit.jsonl" && echo true || echo false) $(grep -q '"action":"host_maintenance_enter_finished".*"outcome":"success".*xs-02 is the new pool coordinator' "$DATA/audit.jsonl" && echo true || echo false)"
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Pass-12345-xm","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xct-o -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xct-o -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; OS=$(field d.sessionRef < $BODY)
check "an operator may not make a coordinator" 403 "$(x pool_designate_coordinator "\"hostRef\":\"$H2\"" "-b /var/tmp/xct-o" "$OS")"
check "  but may see what the dialog offers" 200 "$(x pool_coordinator_options "\"hostRef\":\"$H2\"" "-b /var/tmp/xct-o" "$OS")"

echo; echo "$pass passed, $fail failed"
exit $fail
