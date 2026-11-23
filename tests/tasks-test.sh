#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Recent Tasks (lib/recent-tasks.ts, tasks_list / task_cancel): XenMan's own
# actions with who started them, followed XenServer tasks, jobs and update
# jobs, the tasks of other clients as XenCenter shows them, cancelling with
# the role rules, and how long entries stay -- against the fake pool.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xtk-data; FX=/var/tmp/xtk-fake
PORT=3162; XPORT=4462
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xtk-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/task-list"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xtk-fake.log 2>&1 & FPID=$!
cd "$W"
# Finished entries stay 40 s here instead of a day; at most 40 instead of 500.
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 XENMAN_TASKS_KEEP_MS=40000 XENMAN_TASKS_MAX=40 XENMAN_XU_POLL_MS=300 XENMAN_XU_SETTLE_MS=500 \
  npx next start -p $PORT >> /var/tmp/xtk-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xtk-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
# An operator and a viewer with the pool, each with a session of their own.
for u in op1:operator vw1:viewer; do
  curl -s $A -X POST $B/api/auth/users $J -d "{\"username\":\"${u%%:*}\",\"password\":\"Maple-Root-2468\",\"role\":\"${u##*:}\",\"pools\":[\"pool1\"]}" >/dev/null
  curl -s $A -X PUT $B/api/auth/users/${u%%:*} $J -d '{"pools":["pool1"]}' >/dev/null
done
CO=/var/tmp/xtk-cookie-op; CV=/var/tmp/xtk-cookie-vw
curl -s -c $CO -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Maple-Root-2468"}' >/dev/null
curl -s -c $CV -X POST $B/api/auth/login $J -d '{"username":"vw1","password":"Maple-Root-2468"}' >/dev/null
code -b $CO -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; SO=$(field d.sessionRef < $BODY)
code -b $CV -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; SV=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
H1=OpaqueRef:host-1; H2=OpaqueRef:host-2
list() { x tasks_list >/dev/null; }
# One entry, by operation and object ref: what the test asks of it.
entry() { list; field "const t=d.tasks.find(t=>t.operation===\"$1\"&&(t.object.ref===\"$2\"||\"$2\"===\"\")); t?($3):\"none\"" < $BODY; }

echo "=== XenMan's own actions ==="
check "empty at first" "200 0" "$(x tasks_list) $(field 'd.tasks.length' < $BODY)"
x host_disable "\"hostRef\":\"$H1\"" >/dev/null
check "a host disabled: listed, done, by its user" "done admin xenman host" "$(entry Disable $H1 't.state+" "+t.by+" "+t.source+" "+t.object.class')"
x host_enable "\"hostRef\":\"$H1\"" >/dev/null
check "  enabled again: a second entry" "done" "$(entry Enable $H1 't.state')"
x vm_power '"vmRef":"OpaqueRef:vm-2","powerAction":"clean_shutdown"' "-b $CO" "$SO" >/dev/null
check "an operator's shutdown: by the operator, the failure said" "failed op1 true" "$(entry 'Shut down' OpaqueRef:vm-2 't.state+" "+t.by+" "+(t.error.length>0)')"
x vm_power '"vmRef":"OpaqueRef:vm-2","powerAction":"clean_shutdown"' "-b $CV" "$SV" >/dev/null
check "a viewer's refused attempt is no task" 1 "$(list; field 'd.tasks.filter(t=>t.operation==="Shut down").length' < $BODY)"
x vm_migrate "\"vmRef\":\"OpaqueRef:vm-1\",\"targetHostRef\":\"$H2\"" "-b $CO" "$SO" >/dev/null
TASK=$(field d.taskRef < $BODY)
check "a migration: its XenServer task followed, with progress" "running 40 op1 $H2" "$(entry Migrate OpaqueRef:vm-1 't.state+" "+t.progress+" "+t.by+" "+t.hostRefs.join()')"
check "  cancellable by operators (a VM's task)" "task false" "$(entry Migrate OpaqueRef:vm-1 't.cancel.kind+" "+t.cancel.adminOnly')"
check "  and not listed again as another client's" 0 "$(list; field 'd.tasks.filter(t=>t.source==="xapi").length' < $BODY)"
check "the viewer cannot cancel it" 403 "$(x task_cancel "\"taskRef\":\"$TASK\"" "-b $CV" "$SV")"
: > "$FX/calls.log"
check "the operator can" 200 "$(x task_cancel "\"taskRef\":\"$TASK\"" "-b $CO" "$SO")"
check "  task.cancel asked of XenServer" 1 "$(grep -c "^cancelled $TASK" "$FX/calls.log")"
check "  shown as cancelled" "cancelled" "$(entry Migrate OpaqueRef:vm-1 't.state')"
check "  audited" true "$(grep task_cancel "$DATA/audit.jsonl" | grep -q '"actor":"op1"' && echo true)"
check "no task: 400" 400 "$(x task_cancel '"taskRef":"nonsense"')"

echo "=== tasks of other clients ==="
touch "$FX/foreign-task"
list
check "XenCenter's migration and an evacuation; no subtask, no unknown operation" "Evacuate,Migrate" "$(field 'd.tasks.filter(t=>t.source==="xapi").map(t=>t.operation).sort().join()' < $BODY)"
check "  XenCenter's: on web-01, named as XenCenter's" "VM OpaqueRef:vm-1 XenCenter running" "$(entry Migrate OpaqueRef:vm-1 't.object.class+" "+t.object.ref+" "+t.by+" "+t.state')"
check "  its hosts: where it runs, where it goes" "$H1,$H2" "$(entry Migrate OpaqueRef:vm-1 't.hostRefs.slice().sort().join()')"
check "  the evacuation: xs-02, no user known, administrators cancel it" "host $H2 none true" "$(entry Evacuate $H2 't.object.class+" "+t.object.ref+" "+(t.by??"none")+" "+t.cancel.adminOnly')"
check "an operator may not cancel a host's task" 403 "$(x task_cancel '"taskRef":"OpaqueRef:task-xe-evacuate"' "-b $CO" "$SO")"
check "an administrator may" 200 "$(x task_cancel '"taskRef":"OpaqueRef:task-xe-evacuate"')"
check "  then cancelled" "cancelled" "$(entry Evacuate $H2 't.state')"
check "a VM's task of another client: operators may cancel" 200 "$(x task_cancel '"taskRef":"OpaqueRef:task-xc-migrate"' "-b $CO" "$SO")"
rm -f "$FX/foreign-task"

echo "=== XenMan's jobs ==="
x host_maintenance_enter "\"hostRef\":\"$H1\"" >/dev/null
JOB=$(field d.job.id < $BODY)
for _ in $(seq 40); do x host_maintenance_job_status "\"jobId\":\"$JOB\"" >/dev/null; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
JS=$(field d.job.state < $BODY)
check "maintenance mode: the job followed to its end, by its user" "$JS admin true" "$(entry 'Enter maintenance mode' $H1 't.state+" "+t.by+" "+(t.lines.length>0)')"
check "  its XenServer tasks are not another client's" 0 "$(list; field 'd.tasks.filter(t=>t.source==="xapi"&&t.state==="running").length' < $BODY)"
x host_maintenance_exit "\"hostRef\":\"$H1\"" >/dev/null

echo "=== update jobs ==="
code $A -X POST $B/api/xen-updates/jobs $J -d '{"hostId":"pool1","target":"pool","automatic":true,"skipFailingHosts":false}' >/dev/null
UJ=$(field d.job.id < $BODY)
[ -z "$UJ" ] && echo "  (update not started: $(head -c 400 $BODY))"
sleep 1.5
check "an update: listed with its user, steps as lines, stoppable" "running admin true update-job" \
  "$(entry 'Install updates' '' 't.state+" "+t.by+" "+(t.lines.length>0)+" "+t.cancel.kind')"
check "  lines name host and step" true "$(entry 'Install updates' '' 't.lines.some(l=>/^xs-0[12]: /.test(l.text)&&l.at)')"
check "  its XenServer tasks are the job's, not another client's" 0 "$(list; field 'd.tasks.filter(t=>t.source==="xapi"&&t.state==="running").length' < $BODY)"
code $A -X POST $B/api/xen-updates/jobs $J -d "{\"hostId\":\"pool1\",\"action\":\"stop\",\"id\":\"$UJ\"}" >/dev/null
for _ in $(seq 120); do code $A "$B/api/xen-updates/jobs?id=$UJ" >/dev/null; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
check "  stopped: shown so" "cancelled" "$(entry 'Install updates' '' 't.state')"

echo "=== how many, how long ==="
for _ in $(seq 12); do x host_disable "\"hostRef\":\"$H1\"" >/dev/null; x host_enable "\"hostRef\":\"$H1\"" >/dev/null; done
check "more than 30: everything of the time kept" true "$(list; field 'd.tasks.length>30&&d.tasks.length<=40' < $BODY)"
for _ in $(seq 10); do x host_disable "\"hostRef\":\"$H1\"" >/dev/null; x host_enable "\"hostRef\":\"$H1\"" >/dev/null; done
check "the cap holds against a flood" 40 "$(list; field 'd.tasks.length' < $BODY)"
check "running first, then newest first" true "$(field 'd.tasks.every((t,i,a)=>{if(i===0)return true;const p=a[i-1],pr=p.state==="running",tr=t.state==="running";return pr!==tr?pr:p.startedAt>=t.startedAt})' < $BODY)"
sleep 42
check "finished entries gone after the time kept" "" "$(list; field 'd.tasks.filter(t=>t.state!=="running").map(t=>t.operation+"/"+t.state+"/"+t.startedAt+"/"+(t.finishedAt??"")).join(" ")' < $BODY)"
check "reading is no audited action" 0 "$(grep -c '"action":"tasks_list"' "$DATA/audit.jsonl")"

echo; echo "$pass passed, $fail failed"
exit $fail
