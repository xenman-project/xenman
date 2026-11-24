#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# VM snapshot schedules (lib/xen-vmss.ts): the overview, creating, changing,
# assigning, deleting, enabling and running a schedule with XenCenter's calls
# in XenCenter's order, the values XAPI accepts (xapi_vmss.ml), the roles and
# the licence -- against the fake pool (vmss-model).
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xvs-data; FX=/var/tmp/xvs-fake
PORT=3163; XPORT=4463
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xvs-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/vmss-model" "$FX/task-list"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xvs-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xvs-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xvs-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
for u in op1:operator vw1:viewer; do
  curl -s $A -X POST $B/api/auth/users $J -d "{\"username\":\"${u%%:*}\",\"password\":\"Maple-Root-2468\",\"role\":\"${u##*:}\",\"pools\":[\"pool1\"]}" >/dev/null
  curl -s $A -X PUT $B/api/auth/users/${u%%:*} $J -d '{"pools":["pool1"]}' >/dev/null
done
CO=/var/tmp/xvs-cookie-op; CV=/var/tmp/xvs-cookie-vw
curl -s -c $CO -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Maple-Root-2468"}' >/dev/null
curl -s -c $CV -X POST $B/api/auth/login $J -d '{"username":"vw1","password":"Maple-Root-2468"}' >/dev/null
code -b $CO -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; SO=$(field d.sessionRef < $BODY)
code -b $CV -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; SV=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
L="$FX/calls.log"
writes() { grep -E '^(VMSS\.(create|destroy|set_[a-z_]+|snapshot_now)|VM\.set_snapshot_schedule) ' "$L" | sed -E 's/ \[.*//' | paste -sd' '; }
overview() { x vmss_overview >/dev/null; }
sched() { field "const s=d.schedules.find(s=>s.name===\"$1\"); s?($2):\"none\"" < $BODY; }
VM1=OpaqueRef:vm-1; VM2=OpaqueRef:vm-2; VM3=OpaqueRef:vm-3

echo "=== the overview ==="
check "read by a viewer" 200 "$(x vmss_overview '' "-b $CV" "$SV")"
check "licensed; disk and memory allowed" "true true" "$(field 'd.licensed+" "+d.checkpointAllowed' < $BODY)"
check "the coordinator's time" "2026-11-21 10:07" "$(field 'd.serverLocalTime' < $BODY)"
check "Nightly: daily at 02:00, keeps 7, db-01 in it" "daily 2:0 7 $VM2" "$(sched Nightly 's.frequency+" "+s.hour+":"+s.min+" "+s.retained+" "+s.vms.join()')"
check "  next run in the pool's time, and how soon" "2026-11-22 02:00 953" "$(sched Nightly 's.nextRun+" "+s.nextRunInMin')"
check "  its alerts, newest first, others' left out" "VMSS_SNAPSHOT_SUCCEEDED,VMSS_SNAPSHOT_FAILED" "$(sched Nightly 's.messages.map(m=>m.name).join()')"
check "VMs without templates, each with its schedule" "db-01:OpaqueRef:vmss-nightly old:none web-01:none" "$(field 'd.vms.map(v=>v.name+":"+(v.schedule??"none")).sort().join(" ")' < $BODY)"

echo "=== creating, as XenCenter's CreateVMPolicy ==="
: > "$L"
x vmss_save "\"schedule\":{\"name\":\"Daily backup\",\"description\":\"web\",\"enabled\":true,\"type\":\"snapshot\",\"retained\":7,\"frequency\":\"daily\",\"min\":0,\"hour\":2,\"days\":[],\"vms\":[\"$VM1\",\"$VM3\"],\"runNow\":true}" >/dev/null
NEW=$(field d.vmssRef < $BODY)
check "created, its first run started in the background" "true true" "$(field '(d.vmssRef||"").startsWith("OpaqueRef:")+" "+(typeof d.backgroundId==="string"&&!d.taskRef)' < $BODY)"
sleep 0.3
check "  create, the two VMs, then the run -- synchronous, as XenServer has no Async.VMSS.snapshot_now" "VMSS.create VM.set_snapshot_schedule VM.set_snapshot_schedule VMSS.snapshot_now" "$(writes)"
check "  in Recent Tasks: running while XenServer takes the snapshots" true "$(x tasks_list >/dev/null; field 'd.tasks.some(t=>t.operation==="Create snapshot schedule"&&t.state==="running")' < $BODY)"
sleep 2
check "  then done" true "$(x tasks_list >/dev/null; field 'd.tasks.some(t=>t.operation==="Create snapshot schedule"&&t.state==="done")' < $BODY)"
check "  the schedule map as XenCenter writes it" '{"hour":"2","min":"0"}' "$(grep '^VMSS.create ' "$L" | sed -E 's/^VMSS.create //' | "$NODE" -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0))[0].schedule)')"
check "  retained as XAPI's int" '"7"' "$(grep '^VMSS.create ' "$L" | sed -E 's/^VMSS.create //' | "$NODE" -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0))[0].retained_snapshots)')"
overview
check "  listed with its VMs" "$VM1,$VM3" "$(sched 'Daily backup' 's.vms.slice().sort().join()')"
check "  audited, and in Recent Tasks with its user" "true true" "$(grep -q '"action":"vmss_save".*Daily backup' "$DATA/audit.jsonl" && echo true) $(x tasks_list >/dev/null; field 'd.tasks.some(t=>t.operation==="Create snapshot schedule"&&t.by==="admin"&&t.object.name==="Daily backup")' < $BODY)"

echo "=== changing, as VMSS.SaveChanges ==="
: > "$L"
x vmss_save "\"vmssRef\":\"$NEW\",\"schedule\":{\"name\":\"Daily backup\",\"description\":\"web\",\"enabled\":true,\"type\":\"snapshot\",\"retained\":4,\"frequency\":\"weekly\",\"min\":30,\"hour\":22,\"days\":[\"friday\",\"monday\"],\"vms\":[\"$VM1\",\"$VM2\"]}" >/dev/null
check "weekly Mon and Fri: only what changed, the frequency before the schedule" "VMSS.set_retained_snapshots VMSS.set_frequency VMSS.set_schedule VM.set_snapshot_schedule VM.set_snapshot_schedule" "$(writes)"
check "  the days in the week's order" '"monday,friday"' "$(grep '^VMSS.set_schedule ' "$L" | sed -E 's/^VMSS.set_schedule //' | "$NODE" -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0))[1].days)')"
check "  old-01 out, db-01 moved over from Nightly" "VM.set_snapshot_schedule [\"$VM3\",\"OpaqueRef:NULL\"]|VM.set_snapshot_schedule [\"$VM2\",\"$NEW\"]" "$(grep -E '^VM.set_snapshot_schedule \["OpaqueRef:vm-[23]"' "$L" | paste -sd'|')"
overview
check "  Nightly now empty" "" "$(sched Nightly 's.vms.join()')"
: > "$L"
x vmss_save "\"vmssRef\":\"$NEW\",\"schedule\":{\"name\":\"Daily backup\",\"description\":\"web\",\"enabled\":true,\"type\":\"snapshot\",\"retained\":4,\"frequency\":\"weekly\",\"min\":30,\"hour\":22,\"days\":[\"monday\",\"friday\"],\"vms\":[\"$VM1\",\"$VM2\"]}" >/dev/null
check "saved unchanged: nothing written" "" "$(writes)"

echo "=== what XAPI would refuse ==="
bad() { x vmss_save "\"schedule\":{\"name\":\"x\",\"type\":\"snapshot\",\"retained\":${2:-7},\"frequency\":\"${3:-daily}\",\"min\":${1:-0},\"hour\":2,\"days\":${4:-[]},\"vms\":${5:-[]}}"; }
check "minute 10" 400 "$(bad 10)"
check "11 snapshots" 400 "$(bad 0 11)"
check "weekly without a day" 400 "$(bad 0 7 weekly)"
check "a day that is none" 400 "$(bad 0 7 weekly '["funday"]')"
check "a template as a VM" 400 "$(bad 0 7 daily [] '["OpaqueRef:vm-tpl"]')"
check "no name" 400 "$(x vmss_save '"schedule":{"name":"","type":"snapshot","retained":7,"frequency":"daily","min":0,"hour":2}')"
check "quiesced, newly chosen" 400 "$(x vmss_save '"schedule":{"name":"q","type":"snapshot_with_quiesce","retained":7,"frequency":"daily","min":0,"hour":2}')"

echo "=== enabling, running, one VM ==="
: > "$L"
check "disabled" "200 VMSS.set_enabled" "$(x vmss_set_enabled "\"vmssRef\":\"$NEW\",\"vmssName\":\"Daily backup\",\"enabled\":false") $(writes)"
check "run now: started in the background, followed in Recent Tasks" "true true" "$(x vmss_run_now "\"vmssRef\":\"$NEW\",\"vmssName\":\"Daily backup\"" >/dev/null; field 'typeof d.backgroundId==="string"' < $BODY) $(x tasks_list >/dev/null; field 'd.tasks.some(t=>t.operation==="Run snapshot schedule"&&t.state==="running")' < $BODY)"
sleep 2
check "  done once XenServer answered" true "$(x tasks_list >/dev/null; field 'd.tasks.filter(t=>t.operation==="Run snapshot schedule").every(t=>t.state==="done")' < $BODY)"
touch "$FX/vmss-snapshot-fails"
x vmss_run_now "\"vmssRef\":\"$NEW\",\"vmssName\":\"Daily backup\"" >/dev/null; sleep 2
check "  a run that fails: failed, with XenServer's words" true "$(x tasks_list >/dev/null; field 'd.tasks.some(t=>t.operation==="Run snapshot schedule"&&t.state==="failed"&&/SR_FULL/.test(t.error))' < $BODY)"
rm -f "$FX/vmss-snapshot-fails"
check "  never the Async form, which XenServer does not have" 0 "$(grep -c '^Async.VMSS.snapshot_now' "$L")"
check "an error of XenServer: its code and details, not a bare word" "502 HANDLE_INVALID VMSS OpaqueRef:vmss-gone" "$(x vmss_set_enabled '"vmssRef":"OpaqueRef:vmss-gone","enabled":true') $(field d.error < $BODY)"
check "run now with no VMs: refused" 409 "$(x vmss_run_now '"vmssRef":"OpaqueRef:vmss-nightly"')"
: > "$L"
check "web-01 into Nightly from its VM" "200 VM.set_snapshot_schedule" "$(x vm_set_snapshot_schedule "\"vmRef\":\"$VM1\",\"vmssRef\":\"OpaqueRef:vmss-nightly\"") $(writes)"
check "  and out of any" 200 "$(x vm_set_snapshot_schedule "\"vmRef\":\"$VM1\",\"vmssRef\":null")"
overview
check "  now in none" "none" "$(field "d.vms.find(v=>v.ref===\"$VM1\").schedule??\"none\"" < $BODY)"

echo "=== who may ==="
check "a viewer may not change" 403 "$(x vmss_set_enabled "\"vmssRef\":\"$NEW\",\"enabled\":true" "-b $CV" "$SV")"
check "an operator may" 200 "$(x vmss_set_enabled "\"vmssRef\":\"$NEW\",\"enabled\":true" "-b $CO" "$SO")"
check "  audited as theirs" true "$(grep '"action":"vmss_set_enabled"' "$DATA/audit.jsonl" | tail -1 | grep -q '"actor":"op1"' && echo true)"

echo "=== deleting, as DestroyPolicyAction ==="
: > "$L"
check "deleted: its VMs out first, then the schedule" "200 VM.set_snapshot_schedule VMSS.destroy" "$(x vmss_delete "\"vmssRef\":\"$NEW\",\"vmssName\":\"Daily backup\"") $(writes)"
overview
check "  gone" none "$(sched 'Daily backup' 's.name')"

echo "=== the licence ==="
touch "$FX/vmss-restricted"
overview
check "not licensed: said so" false "$(field 'd.licensed' < $BODY)"
check "  nothing written" 409 "$(x vmss_set_enabled '"vmssRef":"OpaqueRef:vmss-nightly","enabled":false')"
rm -f "$FX/vmss-restricted"
touch "$FX/checkpoint-restricted"
check "disk and memory without the licence" 409 "$(x vmss_save '"schedule":{"name":"mem","type":"checkpoint","retained":7,"frequency":"daily","min":0,"hour":2}')"
rm -f "$FX/checkpoint-restricted"

echo; echo "$pass passed, $fail failed"
exit $fail
