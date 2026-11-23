#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The pool's Memory tab as XenCenter's shows it, against the fake pool's memory
# model (fake-xapi.js, memory-model: 64 GiB hosts, 512 MiB host overhead, 4 GiB
# control domain; web-01 balloons 2-4 GiB of 8, db-01 has 8 GiB; 64 MiB per VM).
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xmem-data; FX=/var/tmp/xmem-fake
PORT=3198; XPORT=4498
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xmem-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/memory-model"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xmem-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xmem-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xmem-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
# For the Storage tab of a server: which SRs it sees (a PBD on both).
CONNECT=$(cat $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
GiB=1073741824; MiB=1048576

echo "=== storage seen from a server ==="
check "connect: an SR's PBDs, shared or not, and each host's PBDs" "OpaqueRef:pbd-mem-local2 false | xs-01: xs-02:OpaqueRef:pbd-mem-local2" \
  "$(echo "$CONNECT" | field 'const sr=d.srs.find(s=>s.ref==="OpaqueRef:sr-mem-local2"); sr.pbds.join()+" "+sr.shared+" | "+d.hosts.map(h=>h.nameLabel+":"+h.pbds.join()).sort().join(" ")')"

echo "=== the pool ==="
check "answers" 200 "$(x memory_overview)"
check "a row per live host, the coordinator first" "xs-01 xs-02" "$(field 'd.hosts.map(h=>h.hostName).join(" ")' < $BODY)"
H0='const h=d.hosts[0];'
check "xs-01: total, used (overheads, VMs, control domain)" "$((64*GiB)) $((11*GiB+640*MiB))" "$(field "$H0 h.total+' '+h.used" < $BODY)"
check "  available: web-01 and web-02 at their minimum (2 GiB), Xen and the control domain" "$((55*GiB+384*MiB))" "$(field "$H0 h.available" < $BODY)"
check "  total max: both at their maximum, plus Xen -- 20% of total" "$((12*GiB+640*MiB)) 20" "$(field "$H0 h.totalMax+' '+h.overcommit" < $BODY)"
check "  control domain 4 GiB; Xen's segment the overheads without it" "$((4*GiB)) $((640*MiB))" "$(field "$H0 h.dom0+' '+h.xen" < $BODY)"
check "  a segment per VM, no control domain among them" "web-01:$((4*GiB)),web-02:$((3*GiB))" "$(field "$H0 h.vms.map(v=>v.name+':'+v.bytes).join()" < $BODY)"
check "  the pool has no VM rows" "0" "$(field 'd.vmRows.length' < $BODY)"
check "  a ballooning VM: minimum, maximum and static maximum for the tooltip" "$((2*GiB)) $((4*GiB)) $((8*GiB))" \
  "$(field "$H0 const v=h.vms[0]; v.dynamicMin+' '+v.dynamicMax+' '+v.staticMax" < $BODY)"
H1='const h=d.hosts[1];'
check "xs-02: db-01 does not balloon -- its static maximum counts both ways" "$((51*GiB+448*MiB)) $((12*GiB+576*MiB)) 20" \
  "$(field "$H1 h.available+' '+h.totalMax+' '+h.overcommit" < $BODY)"
check "  and its tooltip has no memory range" "db-01 undefined undefined" "$(field "$H1 const v=h.vms[0]; v.name+' '+v.dynamicMin+' '+v.staticMax" < $BODY)"

echo "=== one host ==="
ROWS='d.vmRows.map(r=>r.power+":"+r.vms.map(v=>v.name).join("+")).join(" ")'
check "xs-01: its row only, then its VMs -- the two with the same settings in one row" "200 xs-01 Running:web-01+web-02" \
  "$(x memory_overview '"hostRef":"OpaqueRef:host-1"') $(field 'd.hosts.map(h=>h.hostName).join()' < $BODY) $(field "$ROWS" < $BODY)"
check "  ballooning: the average in use, minimum, maximum, static maximum" "true $((3*GiB+512*MiB)) $((2*GiB)) $((4*GiB)) $((8*GiB))" \
  "$(field 'const r=d.vmRows[0]; [r.ballooning,r.used,r.dynamicMin,r.dynamicMax,r.staticMax].join(" ")' < $BODY)"
check "  not here: 'old' (its disk is on xs-02's local storage, though its affinity is xs-01), hidden-01 (hidden)" "no" \
  "$(field '/old|hidden/.test(JSON.stringify(d.vmRows)) ? "yes" : "no"' < $BODY)"
check "xs-02: running first, then the halted VM whose local disk is here" "200 Running:db-01 Halted:old" \
  "$(x memory_overview '"hostRef":"OpaqueRef:host-2"') $(field "$ROWS" < $BODY)"
check "  without ballooning: only the memory; halted, nothing in use" "false $((8*GiB)) | false 0 $((1*GiB))" \
  "$(field 'd.vmRows.map(r=>r.ballooning+" "+(r.power==="Halted"?r.used+" ":"")+r.staticMax).join(" | ")' < $BODY)"

echo "=== what Edit... is told ==="
x memory_overview '"hostRef":"OpaqueRef:host-1"' >/dev/null
check "licensed, the ratios, the host's memory and what is spoken for (overheads, dom0, both minimums)" \
  "false 0.25 0.25 $((64*GiB)) $((8*GiB+640*MiB))" \
  "$(field 'const e=d.edit; [e.dmcRestricted,e.ratioHvm,e.ratioPv,e.hostTotal,e.hostCommitted].join(" ")' < $BODY)"
check "  web-01/web-02: editable, a range below the static maximum, tools in, static minimum 1 GiB" "true true io,io $GiB" \
  "$(field 'const r=d.vmRows[0]; [r.editable,r.usesBallooning,r.vms.map(v=>v.tools).join(),r.staticMin].join(" ")' < $BODY)"
x memory_overview '"hostRef":"OpaqueRef:host-2"' >/dev/null
check "  db-01: no tools -- still editable, it has been running long enough to know" "true none false" \
  "$(field 'const r=d.vmRows[0]; [r.editable,r.vms[0].tools,r.usesBallooning].join(" ")' < $BODY)"

echo "=== one VM (its own Memory tab) ==="
check "web-02: no host rows, its row alone, with its host's memory for the limits" "200 0 web-02 Running true $((64*GiB))" \
  "$(x memory_overview '"vmRef":"OpaqueRef:vm-4"') $(field 'd.hosts.length+" "+d.vmRows.map(r=>r.vms.map(v=>v.name).join("+")+" "+r.power+" "+r.editable).join()+" "+d.edit.hostTotal' < $BODY)"
check "halted 'old': its row, no host to reckon with" "200 old Halted 0" \
  "$(x memory_overview '"vmRef":"OpaqueRef:vm-3"') $(field 'd.vmRows.map(r=>r.vms[0].name+" "+r.power).join()+" "+d.edit.hostTotal' < $BODY)"
check "hidden-01: shown on its own tab all the same, as XenCenter does" "hidden-01" \
  "$(x memory_overview '"vmRef":"OpaqueRef:vm-5"' >/dev/null; field 'd.vmRows.map(r=>r.vms[0].name).join()' < $BODY)"

# Runs vm_memory_change and waits for its job; prints the HTTP code and the job's end state.
memchange() {
  local c; c=$(x vm_memory_change "$1")
  [ "$c" != 202 ] && { echo "$c $(field 'd.error' < $BODY)"; return; }
  local id; id=$(field 'd.job.id' < $BODY)
  for _ in $(seq 60); do
    x vm_memory_job_status "\"jobId\":\"$id\"" >/dev/null
    [ "$(field 'd.job.state' < $BODY)" != running ] && break
    sleep 0.5
  done
  echo "$c $(field 'd.job.state+" "+d.job.vms.map(v=>v.name+":"+v.state+(v.error?"("+v.error+")":"")).join(",")' < $BODY)"
}
VM1='"OpaqueRef:vm-1"'; VM4='"OpaqueRef:vm-4"'; VM2='"OpaqueRef:vm-2"'

echo "=== Edit...: only the range ==="
: > "$FX/calls.log"
check "web-01 and web-02 to 3-4 GiB: no reboot, both at once" "202 done web-01:done,web-02:done" \
  "$(memchange "\"vmRefs\":[$VM1,$VM4],\"dynamicMin\":$((3*GiB)),\"dynamicMax\":$((4*GiB)),\"staticMax\":$((8*GiB))")"
check "  VM.set_memory_dynamic_range on each, nothing shut down" "2 0" \
  "$(grep -c '^set_memory_dynamic_range' "$FX/calls.log") $(grep -c 'shutdown\|start' "$FX/calls.log")"
x memory_overview '"hostRef":"OpaqueRef:host-1"' >/dev/null
check "  the row shows it" "$((3*GiB)) $((4*GiB)) $((8*GiB))" "$(field 'const r=d.vmRows[0]; [r.dynamicMin,r.dynamicMax,r.staticMax].join(" ")' < $BODY)"

echo "=== Edit...: a new static maximum ==="
check "web-01 to 6 GiB while running, not confirmed: refused, nothing done" "409 web-01 would have to be rebooted" \
  "$(memchange "\"vmRefs\":[$VM1],\"dynamicMin\":$((3*GiB)),\"dynamicMax\":$((6*GiB)),\"staticMax\":$((6*GiB))")"
: > "$FX/calls.log"
check "  confirmed: done" "202 done web-01:done" \
  "$(memchange "\"vmRefs\":[$VM1],\"dynamicMin\":$((3*GiB)),\"dynamicMax\":$((6*GiB)),\"staticMax\":$((6*GiB)),\"confirmReboot\":true")"
check "  as XenCenter: clean shutdown, set_memory_limits (static min kept), started on its host again" \
  "clean_shutdown web-01|set_memory_limits web-01 $GiB $((6*GiB)) $((3*GiB)) $((6*GiB))|start_on web-01" \
  "$(grep -E '^(clean_shutdown|hard_shutdown|set_memory_limits|set_memory_dynamic_range|start_on|start) ' "$FX/calls.log" | paste -sd'|')"
x memory_overview '"hostRef":"OpaqueRef:host-1"' >/dev/null
check "  web-01 runs on xs-01 again, in a row of its own now" "Running:web-01 Running:web-02" "$(field "$ROWS" < $BODY)"

: > "$FX/calls.log"
check "db-01 (may only be shut down hard) to a fixed 10 GiB, confirmed" "202 done db-01:done" \
  "$(memchange "\"vmRefs\":[$VM2],\"dynamicMin\":$((10*GiB)),\"dynamicMax\":$((10*GiB)),\"staticMax\":$((10*GiB)),\"confirmReboot\":true")"
check "  hard shutdown, then set and started on xs-02" "hard_shutdown db-01|set_memory_limits db-01 $GiB $((10*GiB)) $((10*GiB)) $((10*GiB))|start_on db-01" \
  "$(grep -E '^(clean_shutdown|hard_shutdown|set_memory_limits|set_memory_dynamic_range|start_on|start) ' "$FX/calls.log" | paste -sd'|')"

touch "$FX/memory-fails"; : > "$FX/calls.log"
check "setting fails: the job says so" "202 failed web-02:failed(INTERNAL_ERROR (memory-fails))" \
  "$(memchange "\"vmRefs\":[$VM4],\"dynamicMin\":$((3*GiB)),\"dynamicMax\":$((5*GiB)),\"staticMax\":$((5*GiB)),\"confirmReboot\":true")"
check "  and web-02 was started again all the same" "clean_shutdown web-02|set_memory_limits web-02 $GiB $((5*GiB)) $((3*GiB)) $((5*GiB))|start_on web-02" \
  "$(grep -E '^(clean_shutdown|hard_shutdown|set_memory_limits|set_memory_dynamic_range|start_on|start) ' "$FX/calls.log" | paste -sd'|')"
rm -f "$FX/memory-fails"

check "out of order (minimum above maximum): refused" "400" \
  "$(x vm_memory_change "\"vmRefs\":[$VM4],\"dynamicMin\":$((5*GiB)),\"dynamicMax\":$((4*GiB)),\"staticMax\":$((8*GiB))")"
check "below the static minimum: refused" "400" \
  "$(x vm_memory_change "\"vmRefs\":[$VM4],\"dynamicMin\":$((512*MiB)),\"dynamicMax\":$((4*GiB)),\"staticMax\":$((8*GiB))")"
check "not a VM (a control domain): refused" "400" \
  "$(x vm_memory_change "\"vmRefs\":[\"OpaqueRef:dom0-1\"],\"dynamicMin\":$((4*GiB)),\"dynamicMax\":$((4*GiB)),\"staticMax\":$((4*GiB))")"
check "audited: each job's end, and the requests whose reboot was confirmed" "3 3" \
  "$(grep -c '"action":"vm_memory_change_finished","target[^}]*"outcome":"success"' "$DATA/audit.jsonl") $(grep -c 'reboot confirmed' "$DATA/audit.jsonl")"

echo "=== a host away ==="
touch "$FX/h2-offline"
check "no live metrics, no row" "200 xs-01" "$(x memory_overview) $(field 'd.hosts.map(h=>h.hostName).join(" ")' < $BODY)"
rm -f "$FX/h2-offline"

echo "=== who may look ==="
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"viewer1","password":"Pass-12345-xm","role":"viewer"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/viewer1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xmem-v -X POST $B/api/auth/login $J -d '{"username":"viewer1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xmem-v -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
VS=$(field d.sessionRef < $BODY)
check "a viewer sees the memory" "200 2" "$(x memory_overview '' "-b /var/tmp/xmem-v" "$VS") $(field 'd.hosts.length' < $BODY)"
check "  but may not change it" "403" \
  "$(x vm_memory_change "\"vmRefs\":[$VM4],\"dynamicMin\":$((3*GiB)),\"dynamicMax\":$((4*GiB)),\"staticMax\":$((8*GiB))" "-b /var/tmp/xmem-v" "$VS")"

echo "=== no licence for memory ranges ==="
touch "$FX/dmc-unlicensed"
x memory_overview '"hostRef":"OpaqueRef:host-1"' >/dev/null
check "Host.RestrictDMC: restricted" "true" "$(field 'd.edit.dmcRestricted' < $BODY)"
rm -f "$FX/dmc-unlicensed"

# Last: xs-02 restarts here and is away for a while.
echo "=== the control domain's memory (Control Domain Memory Settings) ==="
H2R='"hostRef":"OpaqueRef:host-2"'
x memory_overview "$H2R" >/dev/null
check "xs-02: 4 GiB now, at least its static minimum (2 GiB), at most that plus the available memory" "$((4*GiB)) $((2*GiB)) true false" \
  "$(field 'const h=d.hosts[0], c=h.controlDomain; [c.dynamicMin, c.staticMin, c.max===Math.min(c.dynamicMin+h.available, 256*1024**3), h.maintenance].join(" ")' < $BODY)"
check "not in maintenance mode: refused" "409 The server must be in maintenance mode to edit this setting." \
  "$(x host_control_domain_memory "$H2R,\"memory\":$((6*GiB)),\"confirmReboot\":true") $(field d.error < $BODY)"
touch "$FX/h2-maintenance"
check "in maintenance mode, db-01 still running there: refused" "409 VMs still run on xs-02: db-01" \
  "$(x host_control_domain_memory "$H2R,\"memory\":$((6*GiB)),\"confirmReboot\":true") $(field d.error < $BODY)"
x vm_power '"vmRef":"OpaqueRef:vm-2","powerAction":"hard_shutdown"' >/dev/null
touch "$FX/ha"
check "HA on: refused" "409 true" "$(x host_control_domain_memory "$H2R,\"memory\":$((6*GiB)),\"confirmReboot\":true") $(field 'd.error.startsWith("HA is enabled")' < $BODY)"
rm -f "$FX/ha"
check "below its static minimum, or unchanged: refused" "400 400" \
  "$(x host_control_domain_memory "$H2R,\"memory\":$GiB,\"confirmReboot\":true") $(x host_control_domain_memory "$H2R,\"memory\":$((4*GiB)),\"confirmReboot\":true")"
check "not confirmed: refused, with XenCenter's question" "409 true" \
  "$(x host_control_domain_memory "$H2R,\"memory\":$((6*GiB))") $(field 'd.needsConfirm' < $BODY)"
check "a viewer may not" "403" "$(x host_control_domain_memory "$H2R,\"memory\":$((6*GiB)),\"confirmReboot\":true" "-b /var/tmp/xmem-v" "$VS")"
: > "$FX/calls.log"
code=$(x host_control_domain_memory "$H2R,\"memory\":$((6*GiB)),\"confirmReboot\":true"); id=$(field d.job.id < $BODY)
for _ in $(seq 30); do x host_dom0_job_status "\"jobId\":\"$id\"" >/dev/null; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
check "6 GiB, confirmed: done" "202 done" "$code $(field d.job.state < $BODY)"
check "  as XenCenter: VM.set_memory on the control domain, then the server reboots" "set_memory Control domain on xs-02 $((6*GiB))|reboot xs-02" \
  "$(grep -E '^(set_memory |reboot )' "$FX/calls.log" | paste -sd'|')"
check "  audited" 1 "$(grep -c '"action":"host_control_domain_memory_finished","target":"host \\"xs-02\\"","outcome":"success"' "$DATA/audit.jsonl")"
rm -f "$FX/h2-maintenance"

echo; echo "$pass passed, $fail failed"
exit $fail
