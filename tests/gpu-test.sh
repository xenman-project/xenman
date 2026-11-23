#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The GPU tab as XenCenter's shows it, against the fake pool's vGPU model
# (fake-xapi.js, vgpu-model: two NVIDIA A16 per host, web-01 and db-01 each with
# an A16-1B): the rows, the bars, the vGPU types, the placement policy -- and
# XenMan's capacity per type and whether a host's VMs fit on the others.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xgpu-data; FX=/var/tmp/xgpu-fake
PORT=3197; XPORT=4497
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xgpu-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/vgpu-model"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xgpu-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xgpu-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xgpu-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }

echo "=== the pool ==="
check "answers" 200 "$(x gpu_overview)"
check "the placement policy as XenCenter says it, two groups differing" "Placement policy: Mixed: different settings for different GPU groups" "$(field d.placement < $BODY)"
check "one row: the GPUs with the same settings, named by their PCI device" "1 GA107GL [A2 / A16] true" "$(field 'd.rows.length+" "+d.rows[0].name+" "+d.rows[0].vgpuCapable' < $BODY)"
check "  the vGPU types in XenCenter's order, the one not enabled marked" \
  "Pass-through whole GPU:true|NVIDIA A16-16Q virtual GPU (1 per GPU):true|NVIDIA A16-8Q virtual GPU (2 per GPU):false|NVIDIA A16-1B virtual GPU (16 per GPU):true" \
  "$(field 'd.rows[0].types.map(t=>t.name+":"+t.enabled).join("|")' < $BODY)"
check "  \"On <host>:\" for each server, two GPUs each" "true xs-01:2 xs-02:2" "$(field 'd.hostLabels+" "+d.rows[0].hosts.map(h=>h.hostName+":"+h.bars.length).join(" ")' < $BODY)"
check "  a GPU in use: the slots of its type, the VM and its model" "16 OpaqueRef:vm-1 NVIDIA A16-1B" \
  "$(field 'const b=d.rows[0].hosts[0].bars[0]; b.slots+" "+b.vgpus.map(v=>v.vmRef+" "+v.model).join()' < $BODY)"
check "  an empty one: as many slots as any type allows" "16 0" "$(field 'const b=d.rows[0].hosts[0].bars[1]; b.slots+" "+b.vgpus.length' < $BODY)"

echo "=== what is left (XenMan) ==="
check "per type in use: running, and how many more could start" "NVIDIA A16-1B virtual GPU (16 per GPU) 2 62" \
  "$(field 'd.capacity.map(c=>c.name+" "+c.used+" "+c.free).join("|")' < $BODY)"
check "  each host away: its vGPU VMs fit on the others" "xs-01:1/0 xs-02:1/0" \
  "$(field 'd.away.map(a=>a.hostName+":"+a.types.map(t=>t.vms+"/"+t.short).join()).join(" ")' < $BODY)"

echo "=== one host ==="
check "its GPUs only, no host label, no away reckoning" "200 false xs-01 0" \
  "$(x gpu_overview '"hostRef":"OpaqueRef:host-1"') $(field 'd.hostLabels+" "+d.rows[0].hosts.map(h=>h.hostName).join()+" "+d.away.length' < $BODY)"

echo "=== a pool without GPUs ==="
rm -f "$FX/vgpu-model"
check "no rows, no placement policy" "200 0 null" "$(x gpu_overview) $(field 'd.rows.length+" "+d.placement' < $BODY)"
touch "$FX/vgpu-model"

echo "=== the placement policy (PoolGpuEditPage, SetGpuPlacementPolicyAction) ==="
check "not a policy: refused" 400 "$(x gpu_set_placement '"algorithm":"mixed"')"
: > "$FX/calls.log"
check "maximum density: set on every GPU group" "200 2" "$(x gpu_set_placement '"algorithm":"depth_first"') $(grep -c '^set_allocation_algorithm OpaqueRef:gg-[12] depth_first$' "$FX/calls.log")"
x gpu_overview >/dev/null
check "  the tab says so, no longer mixed" "depth_first Placement policy: Maximum density: put as many VMs as possible on the same GPU" "$(field 'd.algorithm+" "+d.placement' < $BODY)"

echo "=== allowed vGPU types (GpuConfiguration, VgpuConfigurationAction) ==="
check "the dialog's columns: per GPU and video RAM" "NVIDIA A16-1B 16 1073741824 | Pass-through whole GPU null 0" \
  "$(field 'const t=d.rows[0].types; [t.find(x=>x.label==="NVIDIA A16-1B"), t.find(x=>x.perGpu===null)].map(x=>x.label+" "+x.perGpu+" "+x.videoRam).join(" | ")' < $BODY)"
check "a type in use on the chosen GPUs cannot be disallowed" 409 \
  "$(x gpu_set_enabled_types '"pgpuRefs":["OpaqueRef:pgpu-xs-01-a"],"enable":[],"disable":["OpaqueRef:vt-1b"]')"
: > "$FX/calls.log"
check "A16-8Q allowed on the two empty GPUs" 200 \
  "$(x gpu_set_enabled_types '"pgpuRefs":["OpaqueRef:pgpu-xs-01-b","OpaqueRef:pgpu-xs-02-b"],"enable":["OpaqueRef:vt-8q"],"disable":[]')"
check "  PGPU.set_enabled_VGPU_types on each, the others kept" 2 \
  "$(grep -c '^set_enabled_VGPU_types OpaqueRef:pgpu-xs-0[12]-b OpaqueRef:vt-16q,OpaqueRef:vt-1b,OpaqueRef:vt-8q,OpaqueRef:vt-pt$' "$FX/calls.log")"
x gpu_overview >/dev/null
check "  the GPUs now differ: two rows, one with A16-8Q allowed" "2 1" \
  "$(field 'd.rows.length+" "+d.rows.filter(r=>r.types.some(t=>t.label==="NVIDIA A16-8Q"&&t.enabled)).length' < $BODY)"

echo "=== who may look ==="
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"viewer1","password":"Pass-12345-xm","role":"viewer"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/viewer1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xgpu-v -X POST $B/api/auth/login $J -d '{"username":"viewer1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xgpu-v -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
VS=$(field d.sessionRef < $BODY)
check "a viewer sees the GPUs" "200 2" "$(x gpu_overview '' "-b /var/tmp/xgpu-v" "$VS") $(field 'd.rows.length' < $BODY)"
check "  but may not change them" "403 403" \
  "$(x gpu_set_placement '"algorithm":"breadth_first"' "-b /var/tmp/xgpu-v" "$VS") $(x gpu_set_enabled_types '"pgpuRefs":["OpaqueRef:pgpu-xs-01-b"],"enable":[],"disable":[]' "-b /var/tmp/xgpu-v" "$VS")"

echo; echo "$pass passed, $fail failed"
exit $fail
