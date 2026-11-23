#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# XenCenter's Copy VM, Convert to Template and Create Template From Snapshot,
# against the fake pool's copy model (fake-xapi.js, copy-model): "old" (vm-3,
# halted) with a 40 GiB disk on the local LVM SR, a snapshot "before update",
# and SRs for each case of the copy SR list.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xcopy-data; FX=/var/tmp/xcopy-fake
PORT=3199; XPORT=4499
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xcopy-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/copy-model"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xcopy-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xcopy-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xcopy-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
OLD='"vmRef":"OpaqueRef:vm-3"'
# Waits for a line in the fake's call log (the server's follow-up after a task).
waitlog() { for _ in $(seq 40); do grep -qF "$1" "$FX/calls.log" 2>/dev/null && return 0; sleep 0.5; done; return 1; }

echo "=== Copy VM: what the dialog offers ==="
check "a halted VM: not blocked" "200 null" "$(x vm_copy_check "$OLD") $(field 'JSON.stringify(d.blocked)' < $BODY)"
check "  name and description" "Copy of old|An old VM" "$(field 'd.plan.name+"|"+d.plan.description' < $BODY)"
check "  fast clone ticked, both possible" "clone true true" "$(field '[d.plan.mode, d.plan.cloneEnabled, d.plan.copyEnabled].join(" ")' < $BODY)"
check "  SRs listed (no ISO library, no HBA), sorted" "Detached SR|Full SR|Local storage|NFS-Storage|Small SR|Tiny SR" "$(field 'd.plan.srs.map(s=>s.name).join("|")' < $BODY)"
check "  why an SR cannot take it (XenCenter's texts)" \
  "The SR is currently detached.|This storage repository is full|400 GB free of 500 GB|824 GB free of 1 TB|40 GB required when only 30 GB available|Disk size (40 GB) exceeds SR size (30 GB)" \
  "$(field 'd.plan.srs.map(s=>s.description).join("|")' < $BODY)"
check "  only the SRs with room can be chosen" "false false true true false false" "$(field 'd.plan.srs.map(s=>s.enabled).join(" ")' < $BODY)"
check "  the pool's default SR preselected" "OpaqueRef:sr-nfs" "$(field 'd.plan.defaultSr' < $BODY)"
check "a running VM: blocked" "200 Shut the VM down to copy it." "$(x vm_copy_check '"vmRef":"OpaqueRef:vm-1"') $(field 'd.blocked' < $BODY)"
touch "$FX/copy-no-fastclone"
check "storage without VDI_CLONE: no fast clone, full copy ticked" "false copy Fast clone is not supported by this storage type" \
  "$(x vm_copy_check "$OLD" >/dev/null; field '[d.plan.cloneEnabled, d.plan.mode, d.plan.cloneUnavailable].join(" ")' < $BODY)"
check "  a fast clone is refused" "409" "$(x vm_copy "$OLD,\"mode\":\"clone\",\"nameLabel\":\"x\"")"
rm -f "$FX/copy-no-fastclone"

echo "=== Copy VM: refused ==="
: > "$FX/calls.log"
check "no name" 400 "$(x vm_copy "$OLD,\"mode\":\"clone\",\"nameLabel\":\"  \"")"
check "no mode" 400 "$(x vm_copy "$OLD,\"nameLabel\":\"a\"")"
check "a full copy onto an SR without room enough" "409 Small SR: 40 GB required when only 30 GB available" \
  "$(x vm_copy "$OLD,\"mode\":\"copy\",\"nameLabel\":\"a\",\"srRef\":\"OpaqueRef:sr-small\"") $(field d.error < $BODY)"
check "onto an SR not listed (ISO)" 400 "$(x vm_copy "$OLD,\"mode\":\"copy\",\"nameLabel\":\"a\",\"srRef\":\"OpaqueRef:sr-iso\"")"
check "a running VM" 409 "$(x vm_copy '"vmRef":"OpaqueRef:vm-1","mode":"clone","nameLabel":"a"')"
check "  nothing reached XAPI" 0 "$(grep -cE '^(clone|copy) ' "$FX/calls.log")"

echo "=== Copy VM: fast clone ==="
: > "$FX/calls.log"
check "started: a task for the task list" "200 true" "$(x vm_copy "$OLD,\"mode\":\"clone\",\"nameLabel\":\"Copy of old\",\"description\":\"Golden image\"") $(field '/^OpaqueRef:task-/.test(d.taskRef)' < $BODY)"
T1=$(field d.taskRef < $BODY)
waitlog "description Copy of old = Golden image"
check "  VM.clone, then the description (VMCloneAction)" "clone old as Copy of old|description Copy of old = Golden image" "$(grep -E '^(clone|copy|description) ' "$FX/calls.log" | paste -sd'|')"
check "  the task reads as done" "success" "$(x task_status "\"taskRef\":\"$T1\"" >/dev/null; field d.status < $BODY)"
check "the next copy is named on" "Copy of old (1)" "$(x vm_copy_check "$OLD" >/dev/null; field d.plan.name < $BODY)"

echo "=== Copy VM: full copy ==="
: > "$FX/calls.log"
check "started" 200 "$(x vm_copy "$OLD,\"mode\":\"copy\",\"nameLabel\":\"old on NFS\",\"description\":\"\",\"srRef\":\"OpaqueRef:sr-nfs\"")"
waitlog "description old on NFS = "
check "  VM.copy onto the SR, then the description (VMCopyAction)" "copy old as old on NFS to NFS-Storage|description old on NFS = " "$(grep -E '^(clone|copy|description) ' "$FX/calls.log" | paste -sd'|')"
touch "$FX/copy-fails"
: > "$FX/calls.log"
check "a copy that fails" 200 "$(x vm_copy "$OLD,\"mode\":\"copy\",\"nameLabel\":\"broken\",\"srRef\":\"OpaqueRef:sr-nfs\"")"
T2=$(field d.taskRef < $BODY)
sleep 4
check "  the task says why, no description is set" "failure SR_FULL 0" \
  "$(x task_status "\"taskRef\":\"$T2\"" >/dev/null; field '[d.status, (d.errorInfo||[])[0]].join(" ")' < $BODY) $(grep -c '^description ' "$FX/calls.log")"
rm -f "$FX/copy-fails"

echo "=== Convert to Template ==="
: > "$FX/calls.log"
check "a running VM: refused" "409 Shut the VM down to convert it to a template." \
  "$(x vm_convert_to_template '"vmRef":"OpaqueRef:vm-1","confirm":true') $(field d.error < $BODY)"
check "not without the question answered" "409 true" "$(x vm_convert_to_template "$OLD") $(field d.needsConfirm < $BODY)"
# The fake logs reads too (VM.get_record); only the writes count.
check "  nothing changed" 0 "$(grep -cE '^(other_config|set_is_a_template) ' "$FX/calls.log")"
check "answered: converted" 200 "$(x vm_convert_to_template "$OLD,\"confirm\":true")"
check "  instant=true first, then the template (ConvertVMToTemplateCommand)" "other_config old instant=true|set_is_a_template old true" \
  "$(grep -E '^(other_config|set_is_a_template) ' "$FX/calls.log" | paste -sd'|')"
check "  a template is no VM to copy any more" "Only a VM can be copied." "$(x vm_copy_check "$OLD" >/dev/null; field d.blocked < $BODY)"

echo "=== Create Template From Snapshot ==="
SNAP='"snapshotRef":"OpaqueRef:snap-3"'
check "the name XenCenter suggests" "200 Template from snapshot 'before update'" "$(x vm_snapshot_to_template_check "$SNAP") $(field d.name < $BODY)"
check "not for a VM" 400 "$(x vm_snapshot_to_template '"snapshotRef":"OpaqueRef:vm-2","nameLabel":"t"')"
: > "$FX/calls.log"
check "created" 200 "$(x vm_snapshot_to_template "$SNAP,\"nameLabel\":\"Golden\"")"
waitlog "other_config Golden instant=true"
check "  a clone of the snapshot, XenMan's description, instant=true" \
  "clone before update as Golden|description Golden = Template generated by XenMan from snapshot 'before update'|other_config Golden instant=true" \
  "$(grep -E '^(clone|description|other_config) ' "$FX/calls.log" | paste -sd'|')"
check "  it is a template" "Only a VM can be copied." "$(x vm_copy_check '"vmRef":"OpaqueRef:copy-3"' >/dev/null; field d.blocked < $BODY)"

echo "=== Audit ==="
# Successful requests only: the refused ones are audited as well. The copy that
# failed later (SR_FULL) was a successful request.
ok_copy() { grep '"action":"vm_copy"' "$DATA/audit.jsonl" | grep '"outcome":"success"'; }
check "fast clone, full copies and the SR named" "1 2" \
  "$(ok_copy | grep -c 'fast clone') $(ok_copy | grep -c 'full copy to SR \\"NFS-Storage\\"')"
check "the conversion and the snapshot template" "1 1" \
  "$(grep '"action":"vm_convert_to_template"' "$DATA/audit.jsonl" | grep '"outcome":"success"' | grep -c confirmed) $(grep '"action":"vm_snapshot_to_template"' "$DATA/audit.jsonl" | grep -c '"outcome":"success"')"

echo "=== Who may ==="
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Pass-12345-xm","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"view1","password":"Pass-12345-xm","role":"viewer"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/view1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xcopy-o -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Pass-12345-xm"}' >/dev/null
curl -s -c /var/tmp/xcopy-v -X POST $B/api/auth/login $J -d '{"username":"view1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xcopy-o -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; OS=$(field d.sessionRef < $BODY)
code -b /var/tmp/xcopy-v -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; VS=$(field d.sessionRef < $BODY)
check "an operator may copy" 200 "$(x vm_copy '"vmRef":"OpaqueRef:copy-1","mode":"clone","nameLabel":"op copy"' "-b /var/tmp/xcopy-o" "$OS")"
check "a viewer may look, but neither copy nor convert" "200 403 403 403" \
  "$(x vm_copy_check "$OLD" "-b /var/tmp/xcopy-v" "$VS") $(x vm_copy "$OLD,\"mode\":\"clone\",\"nameLabel\":\"v\"" "-b /var/tmp/xcopy-v" "$VS") $(x vm_convert_to_template "$OLD,\"confirm\":true" "-b /var/tmp/xcopy-v" "$VS") $(x vm_snapshot_to_template "$SNAP,\"nameLabel\":\"v\"" "-b /var/tmp/xcopy-v" "$VS")"

echo; echo "$pass passed, $fail failed"
exit $fail
