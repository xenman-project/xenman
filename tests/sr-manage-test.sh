#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# XenCenter's SR menu against the fake's storage (fake-xapi.js, sr-model):
# which commands each SR allows and XenCenter's reasons, then Repair, Detach,
# Forget, Destroy, Set as Default and Reclaim freed space as XenCenter runs them.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xsr-data; FX=/var/tmp/xsr-fake
PORT=3194; XPORT=4494
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xsr-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/sr-model"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xsr-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xsr-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xsr-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
cmd() { x sr_command "\"srRef\":\"$1\",\"command\":\"$2\"${3:+,$3}"; }
ours() { grep -v '^[A-Za-z_.]* \[' "$FX/calls.log"; }
# st <SR name>: its commands as "name=reason|…" (ok when it may run).
st() { x sr_states >/dev/null; field 'const s=d.srs.find(s=>s.name==="'"$1"'"); s ? Object.entries(s.commands).map(([k,v])=>k+"="+(v===null?"ok":v)).join("|") : "gone"' < $BODY; }
NFS=OpaqueRef:sr-nfs; ISA=OpaqueRef:sr-isa; ISB=OpaqueRef:sr-isb; OLD=OpaqueRef:sr-old; LOC=OpaqueRef:sr-local; SPARE=OpaqueRef:sr-spare

echo "=== What each SR allows (XenCenter's reasons) ==="
check "the SRs, sorted; the default marked" "iSCSI-A iSCSI-B Local storage NFS-Storage Old NFS Spare NFS|NFS-Storage" \
  "$(x sr_states >/dev/null; field 'd.srs.map(s=>s.name).join(" ")+"|"+d.srs.filter(s=>s.isDefault).map(s=>s.name).join(",")' < $BODY)"
check "NFS-Storage: a running VM uses it" \
  "detach=This SR contains running VMs.|forget=This SR contains running VMs.|destroy=This SR contains running VMs." "$(st NFS-Storage)"
check "iSCSI-A: broken (a PBD unplugged)" \
  "repair=ok|detach=ok|forget=XenServer does not allow forgetting this SR now. Detach it first.|destroy=ok|setDefault=ok" "$(st iSCSI-A)"
check "  Repair's hosts, coordinator first" "xs-01 Connected|xs-02 Unplugged" \
  "$(field 'd.srs.find(s=>s.name==="iSCSI-A").hosts.map(h=>h.name+" "+h.status).join("|")' < $BODY)"
check "iSCSI-B: a host without PBD" "xs-01 Connected|xs-02 Connection Missing" \
  "$(field 'd.srs.find(s=>s.name==="iSCSI-B").hosts.map(h=>h.name+" "+h.status).join("|")' < $BODY)"
check "Old NFS: detached" \
  "repair=ok|detach=The SR is currently detached.|forget=ok|destroy=XenServer does not allow destroying this SR now.|setDefault=ok" "$(st 'Old NFS')"
check "Local storage: not a type XenCenter makes; local; trim" \
  "detach=ok|forget=This SR cannot be forgotten with XenMan.|destroy=This SR cannot be destroyed with XenMan.|setDefault=Only a shared SR can be the default of a pool.|trim=ok" "$(st 'Local storage')"

echo "=== Refused ==="
: > "$FX/calls.log"
check "detach without the question answered" "409 true" "$(cmd $SPARE detach) $(field d.needsConfirm < $BODY)"
check "detach an SR a running VM uses" "409 This SR contains running VMs." "$(cmd $NFS detach '"confirm":true') $(field d.error < $BODY)"
check "forget a local SR" "409 This SR cannot be forgotten with XenMan." "$(cmd $LOC forget '"confirm":true') $(field d.error < $BODY)"
check "local SR as the default" "409 Only a shared SR can be the default of a pool." "$(cmd $LOC setDefault) $(field d.error < $BODY)"
check "destroy without the name typed" "409 Type the SR's name, iSCSI-B, to destroy it" "$(cmd $ISB destroy '"confirm":true') $(field d.error < $BODY)"
check "repair an SR that is not broken" "409 This command is not available for this SR" "$(cmd $SPARE repair) $(field d.error < $BODY)"
check "  nothing reached XAPI" 0 "$(ours | grep -cE '^(PBD|SR|pool|trim)')"

echo "=== Repair ==="
: > "$FX/calls.log"
check "iSCSI-A: the unplugged PBD plugged" "200 PBD.plug iSCSI-A on xs-02" "$(cmd $ISA repair) $(ours | grep '^PBD' | paste -sd'|')"
: > "$FX/calls.log"
check "iSCSI-B: a PBD made from the first one's device_config, then plugged" \
  '200 PBD.create iSCSI-B on xs-02 device_config={"server":"192.0.2.10","serverpath":"/export/isb","target":"192.0.2.20"}|PBD.plug iSCSI-B on xs-02' \
  "$(cmd $ISB repair) $(ours | grep '^PBD' | paste -sd'|')"
check "  both whole again: no Repair offered" "no no" \
  "$(st iSCSI-A | grep -q repair && echo yes || echo no) $(st iSCSI-B | grep -q repair && echo yes || echo no)"

echo "=== Set as Default ==="
: > "$FX/calls.log"
check "default, crash dump and suspend image SR together" "200 pool.set_default_SR iSCSI-A|pool.set_crash_dump_SR iSCSI-A|pool.set_suspend_image_SR iSCSI-A" \
  "$(cmd $ISA setDefault) $(ours | grep '^pool\.' | paste -sd'|')"
check "  now marked, no longer offered" "true false" \
  "$(x sr_states >/dev/null; field 'const s=d.srs.find(s=>s.name==="iSCSI-A"); [s.isDefault, "setDefault" in s.commands].join(" ")' < $BODY)"

echo "=== Detach, then Forget ==="
: > "$FX/calls.log"
check "detached: every PBD unplugged, the coordinator's last" "200 PBD.unplug Spare NFS on xs-02|PBD.unplug Spare NFS on xs-01" \
  "$(cmd $SPARE detach '"confirm":true') $(ours | grep '^PBD' | paste -sd'|')"
check "  now forget is possible, detach is not; Repair offered (unplugged PBDs: broken, as XenCenter)" "repair=ok|detach=The SR is currently detached.|forget=ok|destroy=XenServer does not allow destroying this SR now.|setDefault=ok" "$(st 'Spare NFS')"
check "forgotten" "200 SR.forget Spare NFS gone" "$(cmd $SPARE forget '"confirm":true') $(ours | grep '^SR.forget') $(st 'Spare NFS')"

echo "=== Destroy ==="
check "a detached SR: XenServer would not" "409 XenServer does not allow destroying this SR now." "$(cmd $OLD destroy '"confirm":true,"confirmName":"Old NFS"') $(field d.error < $BODY)"
: > "$FX/calls.log"
check "destroyed, the name typed (any case)" "200 SR.destroy iSCSI-B gone" "$(cmd $ISB destroy '"confirm":true,"confirmName":"iscsi-b"') $(ours | grep '^SR.destroy') $(st iSCSI-B)"

echo "=== Reclaim freed space ==="
: > "$FX/calls.log"
check "the trim plugin on the host the SR is attached to" "200 trim do_trim on xs-01 Local storage" "$(cmd $LOC trim '"confirm":true') $(ours | grep '^trim')"
touch "$FX/trim-fails"
check "  its error, as the plugin says it" "Trim on [uuid-localstorage] not supported" "$(cmd $LOC trim '"confirm":true' >/dev/null; field d.error < $BODY)"
rm -f "$FX/trim-fails"

echo "=== Audit and who may ==="
check "commands audited, with the SR" "1 1" \
  "$(grep '"action":"sr_command"' "$DATA/audit.jsonl" | grep '"outcome":"success"' | grep -c 'command=destroy') $(grep '"action":"sr_command"' "$DATA/audit.jsonl" | grep '"outcome":"success"' | grep -c 'command=repair.*iSCSI-A\|command=repair.*sr-isa')"
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Pass-12345-xm","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xsr-o -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xsr-o -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; OS=$(field d.sessionRef < $BODY)
check "an operator may look, not run them (admins only, as creating SRs)" "200 403" \
  "$(x sr_states '' "-b /var/tmp/xsr-o" "$OS") $(x sr_command "\"srRef\":\"$OLD\",\"command\":\"forget\",\"confirm\":true" "-b /var/tmp/xsr-o" "$OS")"

echo; echo "$pass passed, $fail failed"
exit $fail
