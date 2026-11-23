#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# XenCenter's Import of an XVA, against the fake pool (fake-xapi.js, import-model
# with copy-model for the SRs): the home servers and SRs offered, the upload as
# XenCenter makes it (task.create, PUT /import on the SR's own host), the
# unique name, the home server, the interfaces moved, the import's networks
# removed, the start -- and who may.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/ximp-data; FX=/var/tmp/ximp-fake
PORT=3197; XPORT=4497
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/ximp-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/copy-model" "$FX/import-model" "$FX/import-h1-localhost"
# Larger than the 10 MB proxy.ts would cut a body at.
XVA=/var/tmp/ximp-test.xva; head -c 12582912 /dev/urandom > $XVA; SIZE=12582912
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/ximp-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/ximp-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/ximp-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
# imp <query> [cookie args]: the upload, as the dialog sends it.
imp() { code ${2:-$A} -X POST "$B/api/xen/import?$1" -H "Content-Type: application/octet-stream" --data-binary @$XVA; }
H1=OpaqueRef:host-1; H2=OpaqueRef:host-2
# The fake logs every JSON-RPC call as it came ("VM.get_record [...]") beside its own lines: only those.
ours() { grep -v '^[A-Za-z_.]* \[' "$FX/calls.log"; }

echo "=== Where XenCenter lets an XVA go ==="
check "home servers" "200 xs-01 true|xs-02 true" "$(x vm_import_targets) $(field 'd.hosts.map(h=>h.name+" "+h.live).join("|")' < $BODY)"
check "no home server: shared storage only (SrPickerVmItem)" \
  "This SR is broken or not fully attached.|VMs without a home server cannot have disks on local storage|VMs without a home server cannot have disks on local storage|824 GB free of 1 TB|VMs without a home server cannot have disks on local storage|VMs without a home server cannot have disks on local storage" \
  "$(field 'd.srs.map(s=>s.description).join("|")' < $BODY)"
check "  no ISO library, no HBA; the pool's default preselected" "Detached SR|Full SR|Local storage|NFS-Storage|Small SR|Tiny SR OpaqueRef:sr-nfs" \
  "$(field 'd.srs.map(s=>s.name).join("|")+" "+d.defaultSr' < $BODY)"
check "home server xs-01: its local SRs, unless full or unplugged" \
  "The SR is currently unplugged from xs-01|This storage repository is full|400 GB free of 500 GB|824 GB free of 1 TB|30 GB free of 50 GB|30 GB free of 30 GB" \
  "$(x vm_import_targets "\"affinity\":\"$H1\"" >/dev/null; field 'd.srs.map(s=>s.description).join("|")' < $BODY)"
check "home server xs-02: not the local SRs of xs-01" "This storage repository cannot be seen from xs-02" \
  "$(x vm_import_targets "\"affinity\":\"$H2\"" >/dev/null; field 'd.srs.find(s=>s.name==="Local storage").description' < $BODY)"

echo "=== Refused before anything is uploaded ==="
: > "$FX/calls.log"
check "local storage without a home server" "409 Local storage: VMs without a home server cannot have disks on local storage" \
  "$(imp "sessionRef=$S&srRef=OpaqueRef:sr-local1&fileName=a.xva") $(field d.error < $BODY)"
check "a full SR" "409 Full SR: This storage repository is full" "$(imp "sessionRef=$S&srRef=OpaqueRef:sr-full&affinity=$H1&fileName=a.xva") $(field d.error < $BODY)"
check "no SR" 400 "$(imp "sessionRef=$S&fileName=a.xva")"
check "an empty body" 400 "$(code $A -X POST "$B/api/xen/import?sessionRef=$S&srRef=OpaqueRef:sr-nfs" -H 'Content-Type: application/octet-stream' --data-binary '')"
check "  no import task was made" 0 "$(ours | grep -c '^task.create')"

echo "=== Import onto shared storage ==="
: > "$FX/calls.log"
check "uploaded" 200 "$(imp "sessionRef=$S&srRef=OpaqueRef:sr-nfs&fileName=test.xva")"
cp $BODY /var/tmp/ximp-first.json
check "  the name made unique, not a template, two interfaces" "old (1) false 2" "$(field '[d.name, d.isTemplate, d.vifs.length].join(" ")' < $BODY)"
check "  the interfaces stay on the networks they came with" "imported eth0|imported eth1" \
  "$(field 'd.vifs.map(v=>d.networks.find(n=>n.ref===v.network).name).join("|")' < $BODY)"
check "  the guest installer network is not offered" "false" "$(field 'd.networks.some(n=>/internal management/.test(n.name))' < $BODY)"
check "  task.create, then the whole file to the coordinator" "task.create put_import_task 127.0.0.1|PUT /import on 127.0.0.1:$XPORT task=known sr=NFS-Storage bytes=$SIZE length=$SIZE" \
  "$(ours | grep -E '^(task.create|PUT /import)' | paste -sd'|')"
check "  renamed, no home server set" "VM.set_name_label old old (1)|0" "$(ours | grep '^VM.set_name_label')|$(ours | grep -c '^VM.set_affinity')"

echo "=== The wizard's last pages ==="
VM=$(field d.vmRef < /var/tmp/ximp-first.json); TASK=$(field d.importTask < /var/tmp/ximp-first.json)
VIF0=$(field 'd.vifs.find(v=>v.device==="0").ref' < /var/tmp/ximp-first.json); VIF1=$(field 'd.vifs.find(v=>v.device==="1").ref' < /var/tmp/ximp-first.json)
: > "$FX/calls.log"
check "an interface of another VM: refused" 409 "$(x vm_import_finish "\"vmRef\":\"$VM\",\"importTask\":\"$TASK\",\"networks\":{\"OpaqueRef:vif-x\":\"OpaqueRef:net-mgmt\"}")"
check "finished, started" "200 true" "$(x vm_import_finish "\"vmRef\":\"$VM\",\"importTask\":\"$TASK\",\"networks\":{\"$VIF0\":\"OpaqueRef:net-mgmt\",\"$VIF1\":\"OpaqueRef:net-imp-1-1\"},\"start\":true") $(field '/^OpaqueRef:task-/.test(d.taskRef)' < $BODY)"
check "  interface 0 moved; the network it left removed, the one still used kept" "VIF.move 0 to Bond_Management|network.destroy imported eth0" \
  "$(ours | grep -E '^(VIF.move|network.destroy) ' | paste -sd'|')"
check "  the VM started" 1 "$(grep -c '^started old (1) on ' "$FX/calls.log")"

echo "=== Import onto local storage, with a home server ==="
: > "$FX/calls.log"
check "uploaded" "200 old (2)" "$(imp "sessionRef=$S&srRef=OpaqueRef:sr-local1&affinity=$H1&fileName=b.xva") $(field d.name < $BODY)"
check "  to the SR's own host (xs-01), its home server set" "PUT /import on localhost:$XPORT task=known sr=Local storage bytes=$SIZE length=$SIZE|VM.set_affinity old (2) xs-01" \
  "$(ours | grep -E '^(PUT /import|VM.set_affinity)' | paste -sd'|')"

echo "=== Failures ==="
touch "$FX/import-fails"
check "the import fails: XAPI's reason" "502 IMPORT_ERROR Some disks could not be imported" \
  "$(imp "sessionRef=$S&srRef=OpaqueRef:sr-nfs&fileName=c.xva") $(field d.error < $BODY)"
rm -f "$FX/import-fails"; touch "$FX/import-refused"; : > "$FX/calls.log"
check "the host refuses the upload" "502 The server refused the upload (HTTP 500)" \
  "$(imp "sessionRef=$S&srRef=OpaqueRef:sr-nfs&fileName=d.xva") $(field d.error < $BODY)"
check "  its task canceled" 1 "$(grep -c '^cancelled ' "$FX/calls.log")"
rm -f "$FX/import-refused"

echo "=== Audit ==="
check "the import, its file, SR and the new VM's name" 1 \
  "$(grep '"action":"vm_import"' "$DATA/audit.jsonl" | grep '"outcome":"success"' | grep 'file=test.xva' | grep 'SR \\"NFS-Storage\\"' | grep -c 'imported as old (1)')"
check "the failures too" 2 "$(grep '"action":"vm_import"' "$DATA/audit.jsonl" | grep -c '"outcome":"failure".*\(IMPORT_ERROR\|refused the upload\)')"
check "the wizard's end" 1 "$(grep '"action":"vm_import_finish"' "$DATA/audit.jsonl" | grep '"outcome":"success"' | grep -c 'interfaces=2, start')"

echo "=== Who may ==="
check "not signed in" 401 "$(code -X POST "$B/api/xen/import?sessionRef=$S&srRef=OpaqueRef:sr-nfs" -H 'Content-Type: application/octet-stream' --data-binary @$XVA)"
check "an unknown XenServer session" 401 "$(imp "sessionRef=OpaqueRef:session-999&srRef=OpaqueRef:sr-nfs")"
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Pass-12345-xm","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"view1","password":"Pass-12345-xm","role":"viewer"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/view1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/ximp-o -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Pass-12345-xm"}' >/dev/null
curl -s -c /var/tmp/ximp-v -X POST $B/api/auth/login $J -d '{"username":"view1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/ximp-o -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; OS=$(field d.sessionRef < $BODY)
code -b /var/tmp/ximp-v -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; VS=$(field d.sessionRef < $BODY)
check "another user's XenServer session" 403 "$(imp "sessionRef=$S&srRef=OpaqueRef:sr-nfs" "-b /var/tmp/ximp-o")"
check "an operator may import" 200 "$(imp "sessionRef=$OS&srRef=OpaqueRef:sr-nfs&fileName=op.xva" "-b /var/tmp/ximp-o")"
check "a viewer may not" "403 403" "$(imp "sessionRef=$VS&srRef=OpaqueRef:sr-nfs" "-b /var/tmp/ximp-v") $(x vm_import_finish "\"vmRef\":\"$VM\",\"importTask\":\"$TASK\"" "-b /var/tmp/ximp-v" "$VS")"

echo "=== The pool behind NAT: the SR's host where it is reached ==="
# xs-01 reports "localhost" here; the pool's NAT setting says it is reached at 127.0.0.1.
code $A -X POST $B/api/hosts $J -d "{\"action\":\"update\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"\",\"useSsl\":false,\"nat\":{\"enabled\":true,\"hosts\":{\"localhost\":\"127.0.0.1\"}}}}" >/dev/null
: > "$FX/calls.log"
check "uploaded" 200 "$(imp "sessionRef=$S&srRef=OpaqueRef:sr-local1&affinity=$H1&fileName=n.xva")"
check "  to xs-01 at the address set, not the one it reports" "PUT /import on 127.0.0.1:$XPORT task=known sr=Local storage bytes=$SIZE length=$SIZE" "$(ours | grep '^PUT /import')"

echo; echo "$pass passed, $fail failed"
exit $fail
