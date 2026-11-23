#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# XenServer updates, stage 2: planning and running an update of a pool or a
# host against the stand-in pool (fake-xapi.js), including a coordinator
# restart, a failure and XenMan restarting mid-run.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xj-data
FX=/var/tmp/fake-xapi-j
PORT=3108; XPORT=4481
BASE="http://127.0.0.1:$PORT"
NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
B=/var/tmp/xj-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $B -w "%{http_code}" "$@"; }
J='-H Content-Type:application/json'
pool() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync('$FX/state.json','utf8')); $1"; }

# Until the stand-in pool has set itself up and answers: under load (XenMan
# still busy after a run with restarts) half a second was not always enough.
wait_fake() { for _ in $(seq 100); do [ -f "$FX/state.json" ] && curl -s -o /dev/null "http://127.0.0.1:$XPORT/" && return; sleep 0.1; done; echo "  (stand-in pool did not start)"; }
start_fake() { [ -n "${FPID:-}" ] && kill $FPID 2>/dev/null; sleep 0.3; rm -f "$FX/calls.log" "$FX/state.json"; FAKE_DOWN_MS=2500 "$NODE" $TESTS/fake-xapi.js $XPORT "$FX" & FPID=$!; wait_fake; }
start_xenman() {
  cd "$W"
  DATA_DIR="$DATA" XENMAN_XU_POLL_MS=300 XENMAN_XU_DOWN_MS=6000 XENMAN_XU_UP_MS=30000 \
    XENMAN_XU_RETRY_DELAYS_MS=1000,1500,2000 XENMAN_XU_EVACUATE_MS=4000 XENMAN_XU_SETTLE_MS=500 XENMAN_XU_GPU_WAIT_MS=2000 NEXT_TELEMETRY_DISABLED=1 \
    npx next start -p $PORT >> /var/tmp/xj-server.log 2>&1 & PID=$!
  for _ in $(seq 40); do curl -sS -o /dev/null "$BASE/login" 2>/dev/null && break; sleep 1; done
  curl -sS -c /var/tmp/xj-cookie -X POST "$BASE/api/auth/login" $J -d '{"username":"admin","password":"admin"}' >/dev/null; curl -sS -b /var/tmp/xj-cookie -c /var/tmp/xj-cookie -X POST "$BASE/api/auth/change-password" $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null; curl -sS -c /var/tmp/xj-cookie -X POST "$BASE/api/auth/login" $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
}
rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; : > /var/tmp/xj-server.log
start_fake; start_xenman
trap 'kill $PID $FPID 2>/dev/null' EXIT
A="-b /var/tmp/xj-cookie"
curl -sS $A -X POST "$BASE/api/hosts" $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
JB="$BASE/api/xen-updates/jobs"
plan() { code $A -X POST "$JB" $J -d "{\"hostId\":\"pool1\",\"skipFailingHosts\":false,\"target\":\"$1\",\"automatic\":${2:-true},\"moveVmsBack\":true,\"evacuateAlways\":${3:-true},\"dryRun\":true}" >/dev/null; }
steps() { field "d.plan.hosts.map(h=>h.name+': '+h.steps.map(s=>s.label).join(' / ')).join(' | ')" < $B; }

echo "=== the plan ==="
plan pool
check "coordinator first, then the member" "xs-01 xs-02" "$(field 'd.plan.hosts.map(h=>h.name).join(" ")' < $B)"
check "xs-01: evacuate, install, restart" "xs-01: Enter maintenance mode / Evacuate host / Install 2 updates / Restart host / Exit maintenance mode / Migrate VMs back" "$(steps | cut -d'|' -f1 | sed 's/ $//')"
check "xs-02: pending restart before installing, toolstack after" "xs-02: Enter maintenance mode / Evacuate host / Restart host (pending from a previous update) / Install 1 update / Restart toolstack / Exit maintenance mode / Migrate VMs back" "$(steps | cut -d'|' -f2 | sed 's/^ //')"
check "at the end, what is still away" "Migrate remaining VMs back to their original hosts" "$(field 'd.plan.finalSteps.join()' < $B)"
check "nothing in the way" 0 "$(field 'd.plan.blockers.length' < $B)"
check "planning changed nothing" "true true 0" "$(pool 'd.hosts["xs-01"].enabled+" "+d.hosts["xs-02"].enabled+" "+(d.hosts["xs-01"].reboots+d.hosts["xs-02"].reboots)')"
plan pool false
check "restarts by hand: a pending restart blocks xs-02" true "$(field 'd.plan.blockers.some(b=>b.includes("xs-02 has a pending host restart"))' < $B)"
check "  and xs-01 would stay in maintenance" true "$(field 'd.plan.warnings.some(w=>w.includes("xs-01 requires a restart after the update"))' < $B)"
check "  without restart or VMs back for xs-01" "xs-01: Enter maintenance mode / Evacuate host / Install 2 updates" "$(steps | cut -d'|' -f1 | sed 's/ $//')"
plan OpaqueRef:host-2
check "member alone while the coordinator lacks updates: refused" true "$(field 'd.plan.blockers.some(b=>b.includes("Update the pool coordinator xs-01 first"))' < $B)"
touch "$FX/ha"; plan pool
check "HA on: refused" true "$(field 'd.plan.blockers.some(b=>b.includes("High Availability"))' < $B)"
rm -f "$FX/ha"; touch "$FX/stuck-vm"; plan pool
check "VM that cannot move: refused, named" true "$(field 'd.plan.blockers.some(b=>b.includes("web-01 (VM_REQUIRES_SR)"))' < $B)"
rm -f "$FX/stuck-vm"; touch "$FX/h2-offline"; plan pool
check "host offline: refused" true "$(field 'd.plan.blockers.some(b=>b.includes("xs-02 is offline"))' < $B)"
rm -f "$FX/h2-offline"
check "starting while blocked: 409 with reasons" 409 "$(touch "$FX/ha"; code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool"}'; rm -f "$FX/ha")"
check "  and nothing touched" 0 "$(grep -c 'host.disable' "$FX/calls.log")"
check "bad target" 400 "$(code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"rm -rf"}')"

echo "=== who may ==="
curl -sS $A -X POST "$BASE/api/auth/users" $J -d '{"username":"op2","password":"Maple-Root-2468","role":"operator","pools":["pool1"]}' >/dev/null
curl -sS $A -X PUT "$BASE/api/auth/users/op2" $J -d '{"pools":["pool1"]}' >/dev/null
curl -sS -c /var/tmp/xj-cookie2 -X POST "$BASE/api/auth/login" $J -d '{"username":"op2","password":"Maple-Root-2468"}' >/dev/null
O="-b /var/tmp/xj-cookie2"
check "operator may not plan or start" "403 403" "$(code $O -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","dryRun":true}') $(code $O -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool"}')"
check "operator with the grant may watch" 200 "$(code $O "$JB?hostId=pool1")"

echo "=== updating the pool ==="
check "started" 200 "$(code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true,"moveVmsBack":true}')"
ID=$(field 'd.job.id' < $B)
check "a second one waits" 409 "$(code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool"}')"
check "  because one is running" true "$(field 'd.blockers.some(b=>b.includes("already in progress"))' < $B)"
check "running shown in the sidebar summary" true "$(code $A "$BASE/api/xen-updates/summary" >/dev/null; field 'd.pools[0].jobRunning' < $B)"
SAW_DOWN=no
for _ in $(seq 120); do
  code $A "$JB?id=$ID" >/dev/null
  s=$(field 'd.job.state' < $B)
  [ "$(field 'd.job.steps.some(x=>x.state==="running"&&x.kind==="reboot"&&x.hostName==="xs-01")' < $B)" = true ] && SAW_DOWN=yes
  [ "$s" != running ] && break
  sleep 1
done
check "finished" done "$s"
check "every step done" "true" "$(field 'd.job.steps.every(x=>x.state==="done")' < $B)"
check "the coordinator's restart was waited for" yes "$SAW_DOWN"
check "VMs counted when moved away" "1 VM migrated" "$(field 'd.job.steps.find(x=>x.kind==="evacuate"&&x.hostName==="xs-01").detail' < $B)"
check "pool: all updates installed" "0 0" "$(pool 'd.hosts["xs-01"].updates.length+" "+d.hosts["xs-02"].updates.length')"
check "pool: nothing pending" "0 0" "$(pool 'd.hosts["xs-01"].pending.length+" "+d.hosts["xs-02"].pending.length')"
check "pool: each host restarted once" "1 1" "$(pool 'd.hosts["xs-01"].reboots+" "+d.hosts["xs-02"].reboots')"
check "pool: both out of maintenance" "true true" "$(pool 'd.hosts["xs-01"].enabled+" "+d.hosts["xs-02"].enabled')"
check "VMs back where they were" "xs-01 xs-02 null" "$(pool 'd.vms["web-01"]+" "+d.vms["db-01"]+" "+d.vms["old"]')"
check "  at the end nothing was still away -- not counted as work" "no VMs to migrate back" "$(field 'd.job.steps.find(x=>x.kind==="vms-back"&&!x.host).detail' < $B)"
L="$FX/calls.log"
first() { grep -n -- "$1" "$L" | head -1 | cut -d: -f1; }
check "coordinator done before the member started" yes "$([ "$(first 'host.enable \["OpaqueRef:host-1"')" -lt "$(first 'host.disable \["OpaqueRef:host-2"')" ] && echo yes || echo no)"
check "xs-02 restarted before installing" yes "$([ "$(first 'host.reboot \["OpaqueRef:host-2"')" -lt "$(first 'apply_updates \["OpaqueRef:host-2"')" ] && echo yes || echo no)"
check "installed with the list's hash" 2 "$(grep -c 'Async.host.apply_updates \[".*","abc123hash"\]' "$L")"
check "toolstack of xs-02 restarted" 1 "$(grep -c 'host.restart_agent \["OpaqueRef:host-2"\]' "$L")"
check "audited: started, each host, finished" "1 2 1" "$(grep -c xen_update_started "$DATA/audit.jsonl") $(grep -c xen_update_host_done "$DATA/audit.jsonl") $(grep xen_update_finished "$DATA/audit.jsonl" | grep -c '"outcome":"success"')"
check "job file private" 600 "$(stat -c %a "$DATA/xen-update-jobs/$ID.json")"
code $A "$BASE/api/xen-updates?hostId=pool1&fresh=1" >/dev/null
check "afterwards: up to date" "0 0" "$(field 'd.updates.updates.length+" "+d.updates.hosts.filter(h=>h.updates.length).length' < $B)"
plan pool
check "nothing left to do" true "$(field 'd.plan.blockers.includes("No updates available.")' < $B)"

echo "=== a failure ==="
start_fake; touch "$FX/apply-fails"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 60); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 1; done
check "failed" failed "$(field 'd.job.state' < $B)"
check "the failing step marked, the rest skipped" "failed skipped" "$(field 'd.job.steps.find(x=>x.kind==="apply").state+" "+d.job.steps.find(x=>x.kind==="reboot").state' < $B)"
check "the error says where and what is left" true "$(field 'd.job.error.includes("on xs-01") && d.job.error.includes("maintenance mode")' < $B)"
check "the member was not touched" 0 "$(grep -c 'host.disable \["OpaqueRef:host-2"' "$FX/calls.log")"
check "failure audited" 1 "$(grep xen_update_finished "$DATA/audit.jsonl" | grep -c '"outcome":"failure"')"
rm -f "$FX/apply-fails"

echo "=== the update asks for more than its metadata said (seen in the field) ==="
start_fake; touch "$FX/no-guidance"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"OpaqueRef:host-1","automatic":true,"evacuateAlways":false,"dryRun":true}' >/dev/null
check "plan: VMs stay, nothing to restart foreseen" "Disable host / Install 2 updates / Exit maintenance mode" "$(field 'd.plan.hosts[0].steps.map(s=>s.label).join(" / ")' < $B)"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"OpaqueRef:host-1","automatic":true,"evacuateAlways":false}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 60); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "finished" done "$(field 'd.job.state' < $B)"
check "the toolstack restart XenServer asked for was added" "Disable host / Install 2 updates / Restart toolstack (required by the update) / Exit maintenance mode / Synchronize update information" "$(field 'd.job.steps.map(s=>s.label).join(" / ")' < $B)"
check "host back in service, nothing pending" "true 0" "$(pool 'd.hosts["xs-01"].enabled+" "+d.hosts["xs-01"].pending.length')"
check "VMs stayed where they were" "xs-01 0" "$(pool 'd.vms["web-01"]') $(grep -c 'Async.host.evacuate' "$FX/calls.log")"

start_fake; touch "$FX/no-guidance"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"OpaqueRef:host-1","automatic":false,"evacuateAlways":false}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 60); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "restarts by hand: finished, host left in maintenance as XenServer requires" "done false" "$(field 'd.job.state' < $B) $(pool 'd.hosts["xs-01"].enabled')"
check "  leaving maintenance skipped, not failed" skipped "$(field 'd.job.steps.find(s=>s.kind==="enable").state' < $B)"
check "  and said so" true "$(field 'd.job.notes.some(n=>n.includes("xs-01 requires a toolstack restart"))' < $B)"
rm -f "$FX/no-guidance"

echo "=== VMs stay unless a restart needs them away (as XenCenter) ==="
start_fake; touch "$FX/no-guidance"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"OpaqueRef:host-1","dryRun":true}' >/dev/null
check "by default nothing is migrated for a toolstack-only update" "Disable host / Install 2 updates / Exit maintenance mode" "$(field 'd.plan.hosts[0].steps.map(s=>s.label).join(" / ")' < $B)"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"OpaqueRef:host-1","evacuateAlways":true,"dryRun":true}' >/dev/null
check "asked for, VMs move away first" "Enter maintenance mode / Evacuate host / Install 2 updates / Exit maintenance mode / Migrate VMs back" "$(field 'd.plan.hosts[0].steps.map(s=>s.label).join(" / ")' < $B)"
rm -f "$FX/no-guidance"

echo "=== older XenServer: guidance in the old fields ==="
start_fake; touch "$FX/legacy-format"
plan pool
check "same plan from the old format" "xs-01: Enter maintenance mode / Evacuate host / Install 2 updates / Restart host / Exit maintenance mode / Migrate VMs back" "$(steps | cut -d'|' -f1 | sed 's/ $//')"
code $A "$BASE/api/xen-updates?hostId=pool1&fresh=1" >/dev/null
check "advisory link from the old field" "https://support.example/XSU-2026-001" "$(field 'd.updates.updates.find(x=>x.id==="XSU-2026-001").url' < $B)"
rm -f "$FX/legacy-format"
code $A "$BASE/api/xen-updates?hostId=pool1&fresh=1" >/dev/null
check "new format: guidance per update shown" "RebootHost RestartToolstack" "$(field 'd.updates.updates.map(u=>u.guidance).sort().join(" ")' < $B)"
check "  nothing beyond it for full effectiveness" "0 0" "$(field 'd.updates.updates.filter(u=>u.fullGuidance).length+" "+d.updates.hosts.filter(h=>h.fullGuidance.length).length' < $B)"

echo "=== tasks for full effectiveness and live patches (seen in the field) ==="
start_fake; touch "$FX/full-reboot"
code $A "$BASE/api/xen-updates?hostId=pool1&fresh=1" >/dev/null
check "tab: nothing required, a restart for full effectiveness" " | RebootHost" "$(field 'const h=d.updates.hosts.find(x=>x.name==="xs-01"); " "+h.guidance.join()+"| "+h.fullGuidance.join()' < $B)"
check "tab: live patches by component" "xen,kernel" "$(field 'd.updates.hosts.find(x=>x.name==="xs-01").livepatchComponents.join()' < $B)"
check "tab: per update too" "RebootHost" "$(field 'd.updates.updates.find(x=>x.id==="XSU-2026-002").fullGuidance' < $B)"
fplan() { code $A -X POST "$JB" $J -d "{\"hostId\":\"pool1\",\"skipFailingHosts\":false,\"target\":\"OpaqueRef:host-1\",\"evacuateAlways\":false,\"automatic\":$1,\"fullEffectiveness\":$2,\"dryRun\":true}" >/dev/null; }
hsteps() { field 'd.plan.hosts[0].steps.map(s=>s.label).join(" / ")' < $B; }
hnotes() { field 'd.plan.hosts[0].notes.join(" | ")' < $B; }
fplan true false
check "plan without the option: no restart" "Disable host / Install 2 updates / Exit maintenance mode" "$(hsteps)"
check "  says what is left out, and the live patches" "Not performed: Restart host (full effectiveness) | Live patches: Xen, Kernel. The host is restarted if a live patch fails." "$(hnotes)"
check "  the option offered" "xs-01: Restart host" "$(field 'd.plan.fullTasks.map(x=>x.host+": "+x.tasks.join()).join()' < $B)"
fplan true true
check "plan with the option: evacuate and restart" "Enter maintenance mode / Evacuate host / Install 2 updates / Restart host / Exit maintenance mode / Migrate VMs back" "$(hsteps)"
check "  still offered, so the switch stays" 1 "$(field 'd.plan.fullTasks.length' < $B)"
check "  live patches without the failure clause" "Live patches: Xen, Kernel." "$(hnotes)"
fplan false true
check "restarts by hand: the option does nothing" "Disable host / Install 2 updates / Exit maintenance mode" "$(hsteps)"
check "  notes" "Not performed: Restart host (full effectiveness) | Live patches: Xen, Kernel. A host restart is required if a live patch fails." "$(hnotes)"
frun() {
  code $A -X POST "$JB" $J -d "{\"hostId\":\"pool1\",\"skipFailingHosts\":false,\"target\":\"OpaqueRef:host-1\",\"evacuateAlways\":false,\"automatic\":$1,\"fullEffectiveness\":$2}" >/dev/null
  ID=$(field 'd.job.id' < $B)
  [ -z "$ID" ] && echo "  (not started: $(head -c 300 $B))"
  for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
}
frun true false
check "without the option: done, not restarted, in service" "done 0 true" "$(field 'd.job.state' < $B) $(pool 'd.hosts["xs-01"].reboots+" "+d.hosts["xs-01"].enabled')"
check "  said so" true "$(field 'd.job.notes.includes("Tasks for full effectiveness not performed on xs-01: Restart host.")' < $B)"
code $A "$BASE/api/xen-updates?hostId=pool1&fresh=1" >/dev/null
check "  the tab shows it as pending" "reboot_host" "$(field 'd.updates.hosts.find(x=>x.name==="xs-01").pendingFull.join()' < $B)"
start_fake
frun true true
check "with the option: restarted once, in service, nothing pending" "done 1 true 0" "$(field 'd.job.state' < $B) $(pool 'd.hosts["xs-01"].reboots+" "+d.hosts["xs-01"].enabled+" "+d.hosts["xs-01"].pendingFull.length')"
check "  VMs moved away first and back" "1 xs-01" "$(grep -c 'Async.host.evacuate \["OpaqueRef:host-1"' "$FX/calls.log") $(pool 'd.vms["web-01"]')"
check "  no note of anything left out" false "$(field 'd.job.notes.some(n=>n.includes("not performed"))' < $B)"

echo "=== a live patch fails ==="
start_fake; touch "$FX/livepatch-fail"
frun true false
check "automatic: the restart XenServer recommends was added" "Evacuate host / Restart host (live patch failed)" "$(field 'd.job.steps.filter(s=>s.kind==="evacuate"||s.kind==="reboot").map(s=>s.label).join(" / ")' < $B)"
check "  done, restarted once, in service, nothing pending" "done 1 true 0" "$(field 'd.job.state' < $B) $(pool 'd.hosts["xs-01"].reboots+" "+d.hosts["xs-01"].enabled+" "+d.hosts["xs-01"].pendingRecommended.length')"
start_fake
frun false false
check "by hand: not restarted, back in service" "done 0 true" "$(field 'd.job.state' < $B) $(pool 'd.hosts["xs-01"].reboots+" "+d.hosts["xs-01"].enabled')"
check "  and said so" true "$(field 'd.job.notes.includes("Live patch failed on xs-01. Restart the host to complete the update.")' < $B)"
code $A "$BASE/api/xen-updates?hostId=pool1&fresh=1" >/dev/null
check "  the tab shows it as pending" "reboot_host_on_livepatch_failure" "$(field 'd.updates.hosts.find(x=>x.name==="xs-01").pendingRecommended.join()' < $B)"
rm -f "$FX/full-reboot" "$FX/livepatch-fail"

echo "=== the pool as the first failed run left it ==="
start_fake_with() { [ -n "${FPID:-}" ] && kill $FPID 2>/dev/null; sleep 0.3; rm -f "$FX/calls.log" "$FX/state.json"; for f in "$@"; do touch "$FX/$f"; done; FAKE_DOWN_MS=2500 "$NODE" $TESTS/fake-xapi.js $XPORT "$FX" & FPID=$!; wait_fake; for f in "$@"; do rm -f "$FX/$f"; done; }
start_fake_with field-state
plan pool
check "no longer blocked by the coordinator in maintenance" 0 "$(field 'd.plan.blockers.length' < $B)"
check "  but said it will be checked again" true "$(field 'd.plan.warnings.some(w=>w.includes("the check is repeated when xs-02 is updated"))' < $B)"
check "coordinator: the pending toolstack restart, then back" "xs-01: Enter maintenance mode / Evacuate host / Restart toolstack (pending from a previous update) / Exit maintenance mode / Migrate VMs back" "$(steps | cut -d'|' -f1 | sed 's/ $//')"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true,"evacuateAlways":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "finished" done "$(field 'd.job.state' < $B)"
check "both hosts in service, nothing pending, nothing left" "true true 0 0 0" "$(pool 'd.hosts["xs-01"].enabled+" "+d.hosts["xs-02"].enabled+" "+d.hosts["xs-01"].pending.length+" "+d.hosts["xs-02"].pending.length+" "+d.hosts["xs-02"].updates.length')"
check "VMs back where they were" "xs-01 xs-02" "$(pool 'd.vms["web-01"]+" "+d.vms["db-01"]')"
check "leaving maintenance waited for the toolstack (HOST_STILL_BOOTING)" true "$(field 'd.job.steps.filter(x=>x.kind==="enable").every(x=>x.state==="done")' < $B)"

start_fake_with field-state gpu-stuck
touch "$FX/gpu-stuck"
plan pool
check "GPU VMs hidden behind the maintenance host: only a warning at first" 0 "$(field 'd.plan.blockers.length' < $B)"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true,"evacuateAlways":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "checked again on its turn: stopped" failed "$(field 'd.job.state' < $B)"
check "  with the real reason" true "$(field 'd.job.error.includes("db-01 (VGPU_TYPE_NOT_SUPPORTED)")' < $B)"
check "  and nothing changed on it" "true true" "$(field 'd.job.error.includes("Nothing was changed on xs-02")' < $B) $(pool 'd.hosts["xs-02"].enabled')"
check "  the coordinator was finished before" "true 0" "$(pool 'd.hosts["xs-01"].enabled+" "+d.hosts["xs-01"].pending.length')"
check "  xs-02 never disabled" 0 "$(grep -c 'host.disable \["OpaqueRef:host-2"' "$FX/calls.log")"
rm -f "$FX/gpu-stuck"

echo "=== a host left in maintenance mode ==="
start_fake_with left-in-maintenance
plan pool
check "only the host with something to install is planned" "xs-02" "$(field 'd.plan.hosts.map(h=>h.name).join()' < $B)"
check "blocked, naming the host to take out of maintenance mode" true "$(field 'd.plan.blockers.some(b=>b.includes("xs-01 is in maintenance mode. Exit maintenance mode first"))' < $B)"

echo "=== moving VMs away needs another try ==="
start_fake; echo 2 > "$FX/evacuate-fails"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
SAW_RETRY=no
for _ in $(seq 120); do
  code $A "$JB?id=$ID" >/dev/null
  field 'd.job.steps.find(x=>x.kind==="evacuate").detail||""' < $B | grep -q 'attempt 1 of 4 failed (VM_MIGRATE_FAILED' && SAW_RETRY=yes
  [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5
done
check "the retry was shown while waiting" yes "$SAW_RETRY"
check "finished anyway" done "$(field 'd.job.state' < $B)"
check "  after the third attempt" "1 VM migrated (after 3 attempts)" "$(field 'd.job.steps.find(x=>x.kind==="evacuate"&&x.hostName==="xs-01").detail' < $B)"
check "  three evacuations asked for on xs-01" 3 "$(grep -c 'Async.host.evacuate \["OpaqueRef:host-1"\]' "$FX/calls.log")"
check "pool fully updated after all" "0 0" "$(pool 'd.hosts["xs-01"].updates.length+" "+d.hosts["xs-02"].updates.length')"

echo "=== moving VMs away hangs once ==="
start_fake; touch "$FX/evacuate-slow-once"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "the hanging task was cancelled" 1 "$(grep -c '^cancelled ' "$FX/calls.log")"
check "then tried again and finished" "done 1 VM migrated (after 2 attempts)" "$(field 'd.job.state+" "+d.job.steps.find(x=>x.kind==="evacuate"&&x.hostName==="xs-01").detail' < $B)"

echo "=== VMs that cannot be moved back ==="
start_fake; touch "$FX/pci-vm"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "the update still finishes" done "$(field 'd.job.state' < $B)"
check "  a passed-through device is not tried again" 1 "$(grep -c 'Async.VM.pool_migrate \["OpaqueRef:vm-2"' "$FX/calls.log")"
check "  the step says which VM stayed, where it belongs and why" true "$(field 'd.job.steps.find(x=>x.kind==="vms-back"&&x.hostName==="xs-02").detail.includes("db-01 → xs-02 (VM_HAS_PCI_ATTACHED")' < $B)"
check "  and a note for afterwards" true "$(field 'd.job.notes.some(n=>n.includes("continue to run on their current host"))' < $B)"
check "  the VM keeps running elsewhere" xs-01 "$(pool 'd.vms["db-01"]')"
check "  the pool's last step does not count it as still to move" "no VMs to migrate back" "$(field 'd.job.steps.find(x=>x.kind==="vms-back"&&!x.host).detail' < $B)"
check "  web-01 back home after xs-01, once" "xs-01 1" "$(pool 'd.vms["web-01"]') $(grep -c 'Async.VM.pool_migrate \["OpaqueRef:vm-1"' "$FX/calls.log")"
rm -f "$FX/pci-vm"
start_fake; touch "$FX/vgpu-fails"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "a vGPU that failed to move is not tried again" "done 1" "$(field 'd.job.state' < $B) $(grep -c 'Async.VM.pool_migrate \["OpaqueRef:vm-2"' "$FX/calls.log")"
rm -f "$FX/vgpu-fails"

echo "=== GPUs without migration data after a toolstack restart ==="
start_fake; touch "$FX/gpumon-late-once"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "finished after restarting the toolstack once more" done "$(field 'd.job.state' < $B)"
check "  two toolstack restarts on xs-02" 2 "$(grep -c 'host.restart_agent \["OpaqueRef:host-2"\]' "$FX/calls.log")"
check "  said so" "GPU migration data available after a second toolstack restart" "$(field 'd.job.steps.find(x=>x.kind==="toolstack"&&x.hostName==="xs-02").detail' < $B)"
check "  VMs moved back only afterwards" "xs-01 xs-02" "$(pool 'd.vms["web-01"]+" "+d.vms["db-01"]')"
rm -f "$FX/gpumon-late-once"
start_fake; touch "$FX/gpumon-broken"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "data never comes back: stopped" failed "$(field 'd.job.state' < $B)"
check "  with what to do on the host" true "$(field 'd.job.error.includes("systemctl restart xcp-rrdd-gpumon && xe-toolstack-restart")' < $B)"
check "  before moving xs-02's VMs back" skipped "$(field 'd.job.steps.find(x=>x.kind==="vms-back"&&x.hostName==="xs-02").state' < $B)"
rm -f "$FX/gpumon-broken"

echo "=== moving VMs away keeps failing ==="
start_fake; echo 9 > "$FX/evacuate-fails"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "gives up after four attempts" "failed 4" "$(field 'd.job.state' < $B) $(grep -c 'Async.host.evacuate' "$FX/calls.log")"
check "  and says why" true "$(field 'd.job.error.includes("VM_MIGRATE_FAILED") && d.job.error.includes("xs-01")' < $B)"
check "  nothing installed on xs-01" 0 "$(grep -c 'apply_updates' "$FX/calls.log")"
rm -f "$FX/evacuate-fails"

echo "=== stopping an update ==="
wait_for() { for _ in $(seq 60); do grep -q "$1" "$FX/calls.log" && return; sleep 0.1; done; }
finish() { for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done; }
start_fake; touch "$FX/evacuate-slow"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
check "operator may not stop it" 403 "$(code $O -X POST "$JB" $J -d "{\"action\":\"stop\",\"id\":\"$ID\"}")"
wait_for 'Async.host.evacuate'
check "stop accepted while moving VMs" 200 "$(code $A -X POST "$JB" $J -d "{\"action\":\"stop\",\"id\":\"$ID\"}")"
check "  shown as asked for" admin "$(field 'd.job.stopRequested.by' < $B)"
finish
check "stopped" stopped "$(field 'd.job.state' < $B)"
check "  the evacuation was cancelled" 1 "$(grep -c '^cancelled' "$FX/calls.log")"
check "  nothing installed, xs-02 untouched" "0 0" "$(grep -c 'apply_updates' "$FX/calls.log") $(grep -c 'host.disable \["OpaqueRef:host-2"' "$FX/calls.log")"
check "  xs-01 out of maintenance mode again" "true true" "$(pool 'd.hosts["xs-01"].enabled+" "+d.hosts["xs-02"].enabled')"
check "  its step says so" "done after the update was stopped" "$(field 'd.job.steps.find(x=>x.kind==="enable"&&x.hostName==="xs-01").state+" "+d.job.steps.find(x=>x.kind==="enable"&&x.hostName==="xs-01").detail' < $B)"
check "  the evacuation shown as stopped" "skipped stopped" "$(field 'd.job.steps.find(x=>x.kind==="evacuate").state+" "+d.job.steps.find(x=>x.kind==="evacuate").detail' < $B)"
check "  says which hosts were not updated" true "$(field 'd.job.notes.some(n=>n==="Not updated: xs-01, xs-02.")' < $B)"
check "  nothing left to do" 0 "$(field 'd.job.steps.filter(x=>x.state==="todo"||x.state==="running").length' < $B)"
check "stopping a finished update: 409" 409 "$(code $A -X POST "$JB" $J -d "{\"action\":\"stop\",\"id\":\"$ID\"}")"
check "unknown job: 404" 404 "$(code $A -X POST "$JB" $J -d '{"action":"stop","id":"00000000-0000-0000-0000-000000000000"}')"
check "audited" true "$(grep -q xen_update_stop_requested $DATA/audit*.log* 2>/dev/null || grep -rq xen_update_stop_requested $DATA; [ $? = 0 ] && echo true)"
rm -f "$FX/evacuate-slow"

start_fake; touch "$FX/evacuate-slow" "$FX/has-vgpu"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
wait_for 'Async.host.evacuate'
code $A -X POST "$JB" $J -d "{\"action\":\"stop\",\"id\":\"$ID\"}" >/dev/null
finish
check "a vGPU VM on the move: not cancelled" "stopped 0" "$(field 'd.job.state' < $B) $(grep -c '^cancelled' "$FX/calls.log")"
check "  the host emptied, then the job stopped" "done skipped" "$(field 'd.job.steps.find(x=>x.kind==="evacuate").state+" "+d.job.steps.find(x=>x.kind==="apply").state' < $B)"
check "  xs-01 out of maintenance mode, web-01 left on xs-02" "true xs-02" "$(pool 'd.hosts["xs-01"].enabled+" "+d.vms["web-01"]')"
check "  said so" true "$(field 'd.job.notes.some(n=>n.startsWith("VMs migrated by this update and not migrated back: web-01."))' < $B)"
rm -f "$FX/evacuate-slow" "$FX/has-vgpu"

start_fake
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
wait_for 'Async.host.apply_updates'
code $A -X POST "$JB" $J -d "{\"action\":\"stop\",\"id\":\"$ID\"}" >/dev/null
finish
check "stopped during the install: it finished first" "stopped done" "$(field 'd.job.state+" "+d.job.steps.find(x=>x.kind==="apply").state' < $B)"
check "  no restart after the stop" 0 "$(grep -c 'host.reboot' "$FX/calls.log")"
check "  xs-01 stays in maintenance mode, needing its restart" "false reboot_host" "$(pool 'd.hosts["xs-01"].enabled+" "+d.hosts["xs-01"].pending.join()')"
check "  said so" true "$(field 'd.job.notes.some(n=>n.startsWith("xs-01 remains in maintenance mode. A host restart is required"))' < $B)"
check "  only xs-02 not updated" true "$(field 'd.job.notes.includes("Not updated: xs-02.")' < $B)"

echo "=== XenMan restarts in the middle ==="
start_fake
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 30); do grep -q 'Async.host.evacuate' "$FX/calls.log" && break; sleep 0.3; done
kill $PID 2>/dev/null; pkill -f next-server; sleep 1
start_xenman
code $A "$JB?id=$ID" >/dev/null
check "marked interrupted, not running" interrupted "$(field 'd.job.state' < $B)"
check "  says to look at the hosts" true "$(field 'd.job.error.includes("maintenance mode")' < $B)"
check "a new update may start again" 0 "$(plan pool; field 'd.plan.blockers.filter(b=>b.includes("already in progress")).length' < $B)"

echo "=== a pool of one host (issue #8) ==="
start_fake_with single-host
plan OpaqueRef:host-1
check "VMs running there: refused, naming them" true "$(field 'd.plan.blockers.some(b=>b.includes("no other host is available")&&b.includes("web-01")&&b.includes("db-01"))' < $B)"
start_fake_with single-host vms-off
plan OpaqueRef:host-1
check "every VM shut down: not refused" "" "$(field 'd.plan.blockers.join(" | ")' < $B)"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"OpaqueRef:host-1","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "  updated: done, restarted once, back in service" "done 1 true" "$(field 'd.job.state' < $B) $(pool 'd.hosts["xs-01"].reboots+" "+d.hosts["xs-01"].enabled')"
check "  no evacuation asked of XenServer" 0 "$(grep -c 'Async.host.evacuate' "$FX/calls.log")"
check "  the step says why" "no running VMs" "$(field 'd.job.steps.find(s=>s.kind==="evacuate").detail' < $B)"
start_fake_with single-host
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"OpaqueRef:host-1","automatic":true,"shutdownVms":true,"dryRun":true}' >/dev/null
check "VMs running, shut down by the option: not refused" "" "$(field 'd.plan.blockers.join(" | ")' < $B)"
check "  the VMs offered by name" "db-01,web-01" "$(field 'd.plan.singleHostVms.slice().sort().join()' < $B)"
check "  shut down, updated, restarted, started again" "Enter maintenance mode / Shut down 2 VMs / Install 2 updates / Restart host / Exit maintenance mode / Start 2 VMs" "$(field 'd.plan.hosts[0].steps.map(s=>s.label).join(" / ")' < $B)"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"OpaqueRef:host-1","automatic":true,"shutdownVms":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done
check "  done, the host restarted once" "done 1 true" "$(field 'd.job.state' < $B) $(pool 'd.hosts["xs-01"].reboots+" "+d.hosts["xs-01"].enabled')"
check "  both VMs running there again" "xs-01 xs-01" "$(pool 'd.vms["web-01"]+" "+d.vms["db-01"]')"
check "  nothing evacuated" 0 "$(grep -c 'Async.host.evacuate' "$FX/calls.log")"
start_fake_with single-host
plan OpaqueRef:host-1
check "  without the option: still refused" true "$(field 'd.plan.blockers.some(b=>b.includes("Shut down these VMs first"))' < $B)"

echo "=== Workload Balancing, paused for the update ==="
wait_job() { for _ in $(seq 120); do code $A "$JB?id=$ID" >/dev/null; [ "$(pool 'd.wlb.enabled')" = false ] && SAW=yes; [ "$(field 'd.job.state' < $B)" != running ] && break; sleep 0.5; done; }
start_fake_with wlb-on
plan pool
check "the plan says so" true "$(field 'd.plan.warnings.some(w=>w.includes("Workload Balancing is paused during the update"))' < $B)"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B); SAW=no; wait_job
check "finished" done "$(field 'd.job.state' < $B)"
check "  paused while it ran, acting again after" "yes true false,true" "$SAW $(pool 'd.wlb.enabled') $(pool 'd.wlb.enabledLog.join()')"
check "  nothing left to resume" false "$(field 'Boolean(d.job.wlbPaused)' < $B)"
check "  both audited" 2 "$(grep -c '"action":"xen_update_wlb"' "$DATA/audit.jsonl")"

start_fake_with wlb-paused
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B); SAW=no; wait_job
check "paused by someone before: left paused" "done false 0" "$(field 'd.job.state' < $B) $(pool 'd.wlb.enabled') $(pool 'd.wlb.enabledLog.length')"

start_fake_with wlb-on; touch "$FX/apply-fails"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B); SAW=no; wait_job
rm -f "$FX/apply-fails"
check "a failed update: acting again all the same" "failed true false,true" "$(field 'd.job.state' < $B) $(pool 'd.wlb.enabled') $(pool 'd.wlb.enabledLog.join()')"

start_fake_with wlb-on; touch "$FX/wlb-pause-fails"
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B); SAW=no; wait_job
rm -f "$FX/wlb-pause-fails"
check "WLB cannot be paused: stopped before anything changed" "failed true 0" "$(field 'd.job.state' < $B) $(field 'd.job.error.includes("could not be paused")' < $B) $(grep -c 'host.disable' "$FX/calls.log")"

start_fake_with wlb-on
code $A -X POST "$JB" $J -d '{"hostId":"pool1","skipFailingHosts":false,"target":"pool","automatic":true}' >/dev/null
ID=$(field 'd.job.id' < $B)
for _ in $(seq 30); do grep -q 'Async.host.evacuate' "$FX/calls.log" && break; sleep 0.3; done
check "XenMan stops mid-update with WLB paused" false "$(pool 'd.wlb.enabled')"
kill $PID 2>/dev/null; pkill -f next-server; sleep 1
start_xenman
for _ in $(seq 30); do [ "$(pool 'd.wlb.enabled')" = true ] && break; sleep 0.5; done
code $A "$JB?id=$ID" >/dev/null
check "  on its next start: WLB acting again, and said" "true interrupted true" "$(pool 'd.wlb.enabled') $(field 'd.job.state' < $B) $(field 'd.job.notes.some(n=>n.includes("resumed after XenMan restarted"))' < $B)"

echo; echo "$pass passed, $fail failed"
exit $fail
