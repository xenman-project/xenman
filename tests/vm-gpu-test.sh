#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# XenCenter's VM → GPU page against the fake's vGPU model (vgpu-model,
# vm-gpu-model): two groups of A16 GPUs; types pass-through, 16Q (alone),
# 8Q (Tech Preview, not allowed on the GPUs), 1B (16 per GPU, several per VM).
# "old" (vm-3) is shut down, web-01 (vm-1) runs with a 1B.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xvg-data; FX=/var/tmp/xvg-fake
PORT=3195; XPORT=4495
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xvg-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/vgpu-model" "$FX/vm-gpu-model"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xvg-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xvg-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xvg-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
OLD='"vmRef":"OpaqueRef:vm-3"'
G1=OpaqueRef:gg-1; PT=OpaqueRef:vt-pt; Q16=OpaqueRef:vt-16q; Q8=OpaqueRef:vt-8q; B1=OpaqueRef:vt-1b
ours() { grep -v '^[A-Za-z_.]* \[' "$FX/calls.log"; }
set_() { x vm_gpu_set "$OLD,\"keep\":$1,\"add\":$2"; }

echo "=== The page of a shut-down VM ==="
check "available, licensed, vGPUs allowed, not locked, none yet" "200 true true true null 0" \
  "$(x vm_gpu "$OLD") $(field '[d.available, d.licensed, d.vgpuAllowed, String(d.locked), d.current.length].join(" ")' < $BODY)"
check "  the group named without 'Group of '" "NVIDIA Corporation GA107GL [A2 / A16] GPUs" "$(field 'd.groups[0].name' < $BODY)"
check "  the types as AddVGPUDialog lists them: pass-through first, most per GPU last" "vt-pt vt-16q vt-8q vt-1b" \
  "$(field 'd.groups[0].types.map(t=>t.replace("OpaqueRef:","")).join(" ")' < $BODY)"
check "  8Q is not allowed on the GPUs" "vt-8q" "$(field 'd.groups[0].disabled.map(t=>t.replace("OpaqueRef:","")).join(" ")' < $BODY)"
check "  XenCenter's names" "Pass-through whole GPU|NVIDIA A16-16Q virtual GPU (1 per GPU)|NVIDIA A16-1B virtual GPU (16 per GPU, multiple vGPU support)" \
  "$(field '[d.types["'$PT'"].label, d.types["'$Q16'"].label, d.types["'$B1'"].label].join("|")' < $BODY)"
check "  video RAM and Tech Preview" "17179869184 true" "$(field 'd.types["'$Q16'"].videoRam+" "+d.types["'$Q8'"].experimental' < $BODY)"

echo "=== A running VM ==="
check "its vGPU shown, PCI slot = device + 11, locked" "200 1 11 The virtual GPUs can only be changed when the VM is shut down." \
  "$(x vm_gpu '"vmRef":"OpaqueRef:vm-1"') $(field '[d.current.length, d.current[0].slot, d.locked].join(" ")' < $BODY)"
check "  not changed" "409 The virtual GPUs can only be changed when the VM is shut down." \
  "$(x vm_gpu_set '"vmRef":"OpaqueRef:vm-1","keep":[],"add":[]') $(field d.error < $BODY)"

echo "=== Adding ==="
: > "$FX/calls.log"
check "a type not allowed on the GPUs" "409 NVIDIA A16-8Q virtual GPU (2 per GPU) is not allowed on the GPUs of NVIDIA Corporation GA107GL [A2 / A16] GPUs" \
  "$(set_ '[]' "[{\"group\":\"$G1\",\"type\":\"$Q8\"}]") $(field d.error < $BODY)"
check "a type the group does not have" 409 "$(set_ '[]' "[{\"group\":\"$G1\",\"type\":\"OpaqueRef:vt-x\"}]")"
check "two 1B (multiple vGPU support)" 200 "$(set_ '[]' "[{\"group\":\"$G1\",\"type\":\"$B1\"},{\"group\":\"$G1\",\"type\":\"$B1\"}]")"
check "  VGPU.create twice, device 0, with the type" "VGPU.create old $G1 device=0 NVIDIA A16-1B|VGPU.create old $G1 device=0 NVIDIA A16-1B" \
  "$(ours | grep '^VGPU.create' | paste -sd'|')"
check "  the page shows both" "2 11 11" "$(x vm_gpu "$OLD" >/dev/null; field '[d.current.length, ...d.current.map(c=>c.slot)].join(" ")' < $BODY)"
K=$(field 'JSON.stringify(d.current.map(c=>c.ref))' < $BODY)
check "16Q beside them: refused (they cannot share the VM with it)" \
  "409 NVIDIA A16-16Q virtual GPU (1 per GPU) cannot be added beside the virtual GPUs the VM has" \
  "$(set_ "$K" "[{\"group\":\"$G1\",\"type\":\"$Q16\"}]") $(field d.error < $BODY)"
check "a vGPU of another VM kept: refused" "409 That vGPU does not belong to this VM" "$(set_ '["OpaqueRef:vgpu-1"]' '[]') $(field d.error < $BODY)"

echo "=== Replacing ==="
: > "$FX/calls.log"
check "the two 1B for one 16Q" 200 "$(set_ '[]' "[{\"group\":\"$G1\",\"type\":\"$Q16\"}]")"
check "  destroyed first, then created (GpuAssignAction)" "VGPU.destroy old NVIDIA A16-1B|VGPU.destroy old NVIDIA A16-1B|VGPU.create old $G1 device=0 NVIDIA A16-16Q" \
  "$(ours | grep -E '^VGPU\.(destroy|create)' | paste -sd'|')"
K=$(x vm_gpu "$OLD" >/dev/null; field 'JSON.stringify(d.current.map(c=>c.ref))' < $BODY)
check "nothing beside a 16Q (no multiple vGPU support)" 409 "$(set_ "$K" "[{\"group\":\"$G1\",\"type\":\"$B1\"}]")"
: > "$FX/calls.log"
check "removed again" "200 0" "$(set_ '[]' '[]') $(x vm_gpu "$OLD" >/dev/null; field d.current.length < $BODY)"
check "  VGPU.destroy" 1 "$(ours | grep -c '^VGPU.destroy old NVIDIA A16-16Q')"

echo "=== Pass-through only ==="
touch "$FX/vgpu-unlicensed"
check "without a vGPU licence" "false false" "$(x vm_gpu "$OLD" >/dev/null; field '[d.vgpuAllowed, d.vgpuLicensed].join(" ")' < $BODY)"
check "  no vGPU type" "409 This VM can only have a GPU passed through" "$(set_ '[]' "[{\"group\":\"$G1\",\"type\":\"$B1\"}]") $(field d.error < $BODY)"
: > "$FX/calls.log"
check "  pass-through, created without the type (as XenCenter)" "200 VGPU.create old $G1 device=0 (no type)" \
  "$(set_ '[]' "[{\"group\":\"$G1\",\"type\":\"$PT\"}]") $(ours | grep '^VGPU.create')"
rm -f "$FX/vgpu-unlicensed"; set_ '[]' '[]' >/dev/null
touch "$FX/vm-no-vgpu-template"
check "a template that forbids vGPUs (allow-vgpu=0)" "false true" "$(x vm_gpu "$OLD" >/dev/null; field '[d.vgpuAllowed, d.vgpuLicensed].join(" ")' < $BODY)"
rm -f "$FX/vm-no-vgpu-template"
touch "$FX/ha" "$FX/vm-ha-restart"
check "HA would restart it: locked" "The virtual GPUs cannot be changed because the VM is currently protected by HA." \
  "$(x vm_gpu "$OLD" >/dev/null; field d.locked < $BODY)"
rm -f "$FX/ha" "$FX/vm-ha-restart"

echo "=== Audit and who may ==="
check "changes audited" 1 "$(grep '"action":"vm_gpu_set"' "$DATA/audit.jsonl" | grep '"outcome":"success"' | grep -c 'kept=0, added: .*, ')"
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Pass-12345-xm","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"view1","password":"Pass-12345-xm","role":"viewer"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/view1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xvg-o -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Pass-12345-xm"}' >/dev/null
curl -s -c /var/tmp/xvg-v -X POST $B/api/auth/login $J -d '{"username":"view1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xvg-o -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; OS=$(field d.sessionRef < $BODY)
code -b /var/tmp/xvg-v -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; VS=$(field d.sessionRef < $BODY)
check "an operator may change them" 200 "$(x vm_gpu_set "$OLD,\"keep\":[],\"add\":[{\"group\":\"$G1\",\"type\":\"$B1\"}]" "-b /var/tmp/xvg-o" "$OS")"
check "a viewer may look, not change" "200 403" "$(x vm_gpu "$OLD" "-b /var/tmp/xvg-v" "$VS") $(x vm_gpu_set "$OLD,\"keep\":[],\"add\":[]" "-b /var/tmp/xvg-v" "$VS")"

echo; echo "$pass passed, $fail failed"
exit $fail
