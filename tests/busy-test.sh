#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# A pool update with VMs that are busy -- a VDI desktop starting -- and VMs
# moved back after each host, as XenCenter does: against the stand-in pool
# (xs-01 coordinator with web-01, xs-02 with db-01).
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
D=/var/tmp/busy-data; FX=/var/tmp/busy-fake
PORT=3180; XPORT=4490
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
BODY=/var/tmp/busy-body.json
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3') body: $(head -c 400 $BODY 2>/dev/null)"; fail=$((fail+1)); fi; }
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf $D $FX; mkdir -p $D $FX; echo normal > $FX/mode
FAKE_DOWN_MS=2000 $NODE $TESTS/fake-xapi.js $XPORT $FX > /var/tmp/busy-fake.log 2>&1 & FPID=$!
cd $W
env DATA_DIR=$D NEXT_TELEMETRY_DISABLED=1 XENMAN_XU_POLL_MS=300 XENMAN_XU_DOWN_MS=4000 XENMAN_XU_UP_MS=30000 \
  XENMAN_XU_SETTLE_MS=0 XENMAN_XU_GPU_WAIT_MS=1000 XENMAN_XU_RETRY_DELAYS_MS=300,300 \
  XENMAN_XU_BUSY_POLL_MS=500 XENMAN_XU_BUSY_WAIT_MS=8000 XENMAN_XU_HOST_RETRY_MS=500,500 \
  npx next start -p $PORT > /var/tmp/busy-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f next-server' EXIT
for _ in $(seq 40); do curl -sS -o /dev/null "$B/login" 2>/dev/null && break; sleep 1; done
C=/var/tmp/busy-cookie
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
A="-b $C"
curl -s $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
plan() { code $A -X POST $B/api/xen-updates/jobs $J -d '{"hostId":"pool1","target":"pool","automatic":true,"dryRun":true,"mail":false}'; }
job() { curl -s $A "$B/api/xen-updates/jobs?id=$1" > $BODY; }
# Where a VM runs, and whether a host is enabled, as the stand-in says (by name).
resident() { $NODE -pe "JSON.parse(require('fs').readFileSync('$FX/state.json')).vms['$1']"; }
enabled() { $NODE -pe "JSON.parse(require('fs').readFileSync('$FX/state.json')).hosts['$1'].enabled"; }

echo "=== VMs back after each host, as XenCenter does ==="
check "a plan" "200 0" "$(plan) $(field 'd.plan.blockers.length' < $BODY)"
check "  each host moves its VMs back before the next one" "xs-01:maintenance,evacuate,apply,reboot,enable,vms-back" "$(field 'const h=d.plan.hosts.find(h=>h.name==="xs-01"); h.name+":"+h.steps.map(s=>s.kind).join(",")' < $BODY)"
check "  at the end only what is still away" true "$(field 'd.plan.finalSteps.length===1 && d.plan.finalSteps[0].startsWith("Migrate remaining VMs back")' < $BODY)"

echo "=== a VM busy starting ==="
touch $FX/busy-vm
plan >/dev/null
check "no reason not to start" 0 "$(field 'd.plan.blockers.length' < $BODY)"
check "  said what it is doing" true "$(field 'd.plan.warnings.some(w=>w.includes("have operations in progress: web-01 (starting, since") && w.includes("35 %") && w.includes("waits up to"))' < $BODY)"
touch $FX/busy-stale
plan >/dev/null
check "an operation whose task has ended: in the way, with what to do" true "$(field 'd.plan.blockers.some(b=>b.includes("web-01 (completed operation still registered: starting") && b.includes("Restart the toolstack on xs-01"))' < $BODY)"
rm -f $FX/busy-stale

echo "=== the update waits for it ==="
check "started while web-01 is busy" 200 "$(code $A -X POST $B/api/xen-updates/jobs $J -d '{"hostId":"pool1","target":"pool","automatic":true,"mail":false}')"
ID=$(field d.job.id < $BODY)
seen=""
for _ in $(seq 20); do
  job $ID
  seen=$(field 'const s=d.job.steps.find(s=>s.state==="running"); s && s.detail ? s.detail : ""' < $BODY)
  case "$seen" in waiting*) break;; esac
  sleep 0.3
done
check "  waits before emptying xs-01, says for what" "true true" "$(echo "$seen" | grep -q '^waiting for web-01 (starting' && echo true) $(field 'd.job.state==="running" && d.job.steps.find(s=>s.kind==="maintenance").state==="running"' < $BODY)"
sleep 1.5
check "  still waiting while it is busy, the VM not moved" "running xs-01" "$(job $ID; field 'd.job.state' < $BODY) $(resident web-01)"
rm -f $FX/busy-vm
for _ in $(seq 120); do job $ID; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
check "the start over: the update goes on and finishes" done "$(field d.job.state < $BODY)"
check "  xs-01's VMs back before xs-02 is emptied" true "$(field 'const s=d.job.steps, back=s.findIndex(x=>x.hostName==="xs-01"&&x.kind==="vms-back"), next=s.findIndex(x=>x.hostName==="xs-02"&&x.kind==="maintenance"); back>=0 && back<next && s[back].state==="done" && s[back].detail.startsWith("1 migrated back")' < $BODY)"
check "  every VM at home again" "xs-01 xs-02" "$(resident web-01) $(resident db-01)"

echo "=== busy for too long ==="
# Reset the stand-in: the same pool, updates again, web-01 busy for good.
kill $FPID; sleep 0.5; rm -rf $FX; mkdir -p $FX; echo normal > $FX/mode; touch $FX/busy-vm
FAKE_DOWN_MS=2000 $NODE $TESTS/fake-xapi.js $XPORT $FX > /var/tmp/busy-fake.log 2>&1 & FPID=$!
sleep 1
code $A -X POST $B/api/xen-updates/jobs $J -d '{"hostId":"pool1","target":"pool","automatic":true,"mail":false}' >/dev/null
ID=$(field d.job.id < $BODY)
for _ in $(seq 60); do job $ID; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
check "given up after the wait, said why" "failed true" "$(field 'd.job.state' < $BODY) $(field '(d.job.error||"").includes("still busy after") || d.job.steps.some(s=>(s.detail||"").includes("still busy after"))' < $BODY)"
check "  nothing changed on xs-01: still enabled, web-01 at home" "true xs-01" "$(enabled xs-01) $(resident web-01)"

echo "=== a VM without the VM Tools ==="
kill $FPID; sleep 0.5; rm -rf $FX; mkdir -p $FX; echo normal > $FX/mode; touch $FX/no-tools
FAKE_DOWN_MS=2000 $NODE $TESTS/fake-xapi.js $XPORT $FX > /var/tmp/busy-fake.log 2>&1 & FPID=$!
sleep 1
plan >/dev/null
check "not allowed: in the way, with what to do" "1 true" "$(field 'd.plan.noToolsVms' < $BODY) $(field 'd.plan.blockers.some(b=>b.includes("web-01") && b.includes("XenServer VM Tools are not installed") && b.includes("restart these VMs on another host"))' < $BODY)"
code $A -X POST $B/api/xen-updates/jobs $J -d '{"hostId":"pool1","target":"pool","automatic":true,"dryRun":true,"mail":false,"noToolsRestart":true}' >/dev/null
check "allowed: no longer in the way, said what happens" "0 true" "$(field 'd.plan.blockers.length' < $BODY) $(field 'd.plan.warnings.some(w=>w.includes("web-01") && w.includes("will be restarted on another host"))' < $BODY)"
check "  the step says so" true "$(field 'd.plan.hosts.find(h=>h.name==="xs-01").steps.some(s=>s.kind==="evacuate" && s.label.includes("1 VM without XenServer VM Tools"))' < $BODY)"
check "the update with it" 200 "$(code $A -X POST $B/api/xen-updates/jobs $J -d '{"hostId":"pool1","target":"pool","automatic":true,"mail":false,"noToolsRestart":true}')"
ID=$(field d.job.id < $BODY)
for _ in $(seq 120); do job $ID; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
check "  finishes" done "$(field d.job.state < $BODY)"
check "  web-01 shut down and started on xs-02 while xs-01 was updated" "1 true" "$(grep -c 'started web-01 on xs-02' $FX/calls.log) $(field 'd.job.steps.find(s=>s.hostName==="xs-01"&&s.kind==="evacuate").detail.includes("restarted on another host (no XenServer VM Tools): web-01")' < $BODY)"
check "  and brought back the same way: home again, running" "xs-01 1" "$(resident web-01) $(grep -c 'Async.VM.start_on \[\"OpaqueRef:vm-1\",\"OpaqueRef:host-1\"' $FX/calls.log)"
check "  never live-migrated" 0 "$(grep -c 'Async.VM.pool_migrate \[\"OpaqueRef:vm-1\"' $FX/calls.log)"
check "  nothing left off" 0 "$(field 'd.job.notes.filter(n=>n.includes("not restarted")).length' < $BODY)"

# A fresh stand-in pool; files given are touched, "name=value" written.
reset_fake() {
  kill $FPID 2>/dev/null; sleep 0.5; rm -rf $FX; mkdir -p $FX; echo normal > $FX/mode
  for x in "$@"; do case "$x" in *=*) echo "${x#*=}" > "$FX/${x%%=*}";; *) touch "$FX/$x";; esac; done
  FAKE_DOWN_MS=2000 $NODE $TESTS/fake-xapi.js $XPORT $FX > /var/tmp/busy-fake.log 2>&1 & FPID=$!
  sleep 1
}
run_job() { # run_job [extra json]
  code $A -X POST $B/api/xen-updates/jobs $J -d "{\"hostId\":\"pool1\",\"target\":\"pool\",\"automatic\":true,\"mail\":false${1:+,$1}}" >/dev/null
  ID=$(field d.job.id < $BODY)
  for _ in $(seq 160); do job $ID; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
}
audits() { grep -c "\"action\":\"$1\"" $D/audit.jsonl; }

echo "=== a host's step fails twice, then works ==="
reset_fake h2-apply-fails=2
R0=$(audits xen_update_step_retry)
run_job
check "tried again, the update finishes" done "$(field d.job.state < $BODY)"
check "  two more tries, audited" 2 "$(( $(audits xen_update_step_retry) - R0 ))"
check "  both hosts updated" "0 0" "$($NODE -pe "const h=JSON.parse(require('fs').readFileSync('$FX/state.json')).hosts; h['xs-01'].updates.length+' '+h['xs-02'].updates.length")"

echo "=== a host keeps failing: skipped, the others go on ==="
reset_fake h2-apply-fails=-1
run_job
cp $BODY /var/tmp/busy-skip.json
check "the update ends as not complete, naming the host" "failed true" "$(field d.job.state < $BODY) $(field 'd.job.error.startsWith("Not updated: xs-02") && d.job.error.includes("yum transaction failed") && d.job.error.includes("The other hosts were updated")' < $BODY)"
check "  the coordinator was updated" 0 "$($NODE -pe "JSON.parse(require('fs').readFileSync('$FX/state.json')).hosts['xs-01'].updates.length")"
check "  xs-02 back in service, its VMs running" "true xs-02" "$(enabled xs-02) $(resident db-01)"
check "  tried once more at the end" true "$(field 'd.job.steps.some(s=>s.hostName==="xs-02" && s.label.endsWith("(retry)") && s.state==="failed")' < $BODY)"
check "  the notes say what happened" true "$(field 'd.job.notes.some(n=>n.startsWith("xs-02 was skipped") && /(has returned to|is in) service/.test(n) && n.includes("retried at the end"))' < $BODY)"
check "  audited as skipped" 2 "$(audits xen_update_host_skipped)"

echo "=== switched off: the update stops at the host, as before ==="
reset_fake h2-apply-fails=-1
run_job '"skipFailingHosts":false'
check "stops at the first failure, no second try" "failed false" "$(field d.job.state < $BODY) $(field 'd.job.steps.some(s=>s.label.endsWith("(retry)"))' < $BODY)"

echo "=== the coordinator keeps failing: no skipping it ==="
reset_fake apply-fails
run_job
check "stops there, the members untouched" "failed true" "$(field d.job.state < $BODY) $(field 'd.job.steps.filter(s=>s.hostName==="xs-02").every(s=>s.state==="skipped")' < $BODY)"

echo "=== another operation keeps blocking the pool: the coordinator's toolstack restarted ==="
reset_fake pool-stuck
run_job
check "blocked for the coordinator through all its tries: its toolstack restarted once, the update finishes" "done 1" \
  "$(field d.job.state < $BODY) $(grep -c 'host.restart_agent \["OpaqueRef:host-1"\]' $FX/calls.log)"
check "  restarted after the tries, before xs-01's install" true \
  "$(awk '/pool blocked/{b=NR} /host.restart_agent \["OpaqueRef:host-1"\]/{r=NR} /apply_updates \["OpaqueRef:host-1"/{if(!a)a=NR} END{print (b<r && r<a) ? "true" : "false"}' $FX/calls.log)"
check "  said in the notes, audited" "true 1" \
  "$(field 'd.job.notes.some(n=>n.startsWith("Another operation blocked the pool (xs-01)") && n.includes("toolstack on the pool coordinator xs-01 was restarted"))' < $BODY) $(audits xen_update_coordinator_toolstack)"

reset_fake three-hosts pool-stuck-members
run_job
check "blocked for two members in a row: the coordinator's toolstack restarted once, all three updated" "done 1 0 0 0" \
  "$(field d.job.state < $BODY) $(grep -c 'host.restart_agent \["OpaqueRef:host-1"\]' $FX/calls.log) $($NODE -pe "const h=JSON.parse(require('fs').readFileSync('$FX/state.json')).hosts; ['xs-01','xs-02','xs-03'].map(n=>h[n].updates.length).join(' ')")"
check "  xs-02 skipped first, done on its second try" "true true" \
  "$(field 'd.job.notes.some(n=>n.startsWith("xs-02 was skipped"))' < $BODY) $(field 'd.job.steps.some(s=>s.hostName==="xs-02" && s.label.endsWith("(retry)") && s.state==="done")' < $BODY)"
check "  the notes name both" true "$(field 'd.job.notes.some(n=>n.startsWith("Another operation blocked the pool (xs-02, xs-03)"))' < $BODY)"

reset_fake pool-stuck-members
run_job
check "one member only, blocked on its second try as well: restarted then, the update finishes" "done 1 0" \
  "$(field d.job.state < $BODY) $(grep -c 'host.restart_agent \["OpaqueRef:host-1"\]' $FX/calls.log) $($NODE -pe "JSON.parse(require('fs').readFileSync('$FX/state.json')).hosts['xs-02'].updates.length")"

reset_fake pool-stuck
run_job '"automatic":false'
check "without automatic restarts: not restarted" 0 "$(grep -c 'host.restart_agent \["OpaqueRef:host-1"\]' $FX/calls.log)"

echo "=== VMs with a vGPU: live-migrated, as XenCenter does ==="
reset_fake has-vgpu
plan >/dev/null
check "the plan says so, no shutdown step" "true false" "$(field 'd.plan.warnings.some(w=>w.includes("will be live-migrated"))' < $BODY) $(field 'd.plan.hosts.some(h=>h.steps.some(s=>s.kind==="vgpu-off"))' < $BODY)"
run_job
check "the update finishes" done "$(field d.job.state < $BODY)"
check "  web-01 migrated, not shut down; back home after xs-01" "0 xs-01" "$(grep -c 'Async.VM.clean_shutdown \[\"OpaqueRef:vm-1\"' $FX/calls.log) $(resident web-01)"
check "  moved back by xs-01's own step" true "$(field 'd.job.steps.find(s=>s.hostName==="xs-01"&&s.kind==="vms-back").detail.startsWith("1 migrated back")' < $BODY)"

echo "=== a vGPU migration fails: restarted instead, never tried live again ==="
reset_fake has-vgpu evac-vgpu-fails
run_job
check "the update finishes" done "$(field d.job.state < $BODY)"
check "  the migration failed once, not again" 1 "$(grep -c 'vgpu migration of web-01 failed' $FX/calls.log)"
check "  web-01 restarted on xs-02, then back home the same way" "2 1 xs-01" "$(grep -c 'Async.VM.clean_shutdown \[\"OpaqueRef:vm-1\"' $FX/calls.log) $(grep -c 'Async.VM.start_on \[\"OpaqueRef:vm-1\",\"OpaqueRef:host-1\"' $FX/calls.log) $(resident web-01)"
check "  never live-migrated back" 0 "$(grep -c 'Async.VM.pool_migrate \[\"OpaqueRef:vm-1\"' $FX/calls.log)"
check "  said in the notes" true "$(field 'd.job.notes.some(n=>n.includes("Live migration of VMs with vGPUs from xs-01 failed") && n.includes("web-01"))' < $BODY)"

echo "=== XenServer finds no evacuation plan, though memory is free ==="
reset_fake evac-no-plan
run_job
check "the VMs moved one by one, the update finishes" "done 1 true" "$(field d.job.state < $BODY) $(grep -c 'evacuation without a plan' $FX/calls.log) $(field 'd.job.steps.find(s=>s.hostName==="xs-01"&&s.kind==="evacuate").detail.includes("migrated individually")' < $BODY)"
check "  web-01 to the host with room, and back home" "1 xs-01" "$(grep -c 'Async.VM.pool_migrate \[\"OpaqueRef:vm-1\",\"OpaqueRef:host-2\"' $FX/calls.log) $(resident web-01)"
reset_fake evac-no-plan vm1-too-big
run_job
check "a VM no host takes: named, with what it needs" "failed true" "$(field d.job.state < $BODY) $(field 'd.job.error.includes("No suitable host found for: web-01 (4.0 GiB") && !d.job.error.includes("OpaqueRef")' < $BODY)"
check "  nothing moved, xs-01 back in service" "xs-01 true" "$(resident web-01) $(enabled xs-01)"

echo "=== VMs moved back several at once ==="
reset_fake vm3-running migrate-slow
run_job
check "the update finishes, both home" "done xs-01 xs-01" "$(field d.job.state < $BODY) $(resident web-01) $(resident old)"
# Both migrations back to xs-01 began before the first of them was done.
check "  web-01 and old moved back at the same time" "start start done done" "$(grep -E 'migrate (start|done) (web-01|old)$' $FX/calls.log | tail -4 | awk '{print $2}' | tr '
' ' ' | sed 's/ $//')"

echo; echo "$pass passed, $fail failed"
exit $fail
