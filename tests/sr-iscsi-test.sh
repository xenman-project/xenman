#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# A new iSCSI SR as XenCenter's New Storage wizard makes it (lib/sr-iscsi.ts),
# against the fake's stand-in iSCSI target (fake-xapi.js, sr-model + iscsi-model):
# Scan Target Host (the IQNs from SR.create's SR_BACKEND_FAILURE_96), the LUNs
# (_107), XenCenter's labels and order, "LUN in use", what is on a LUN (SR.probe),
# then Format (CHAP password as a secret) or Reattach (introduce, or PBDs for an
# SR this pool knows) -- and who may, and what the audit log says.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xis-data; FX=/var/tmp/xis-fake
PORT=3195; XPORT=4495
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xis-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/sr-model" "$FX/iscsi-model"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xis-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xis-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xis-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op7","password":"Maple-Root-2468","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/op7 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xis-op7 -X POST $B/api/auth/login $J -d '{"username":"op7","password":"Maple-Root-2468"}' >/dev/null
session() { code ${1:-$A} -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; field d.sessionRef < $BODY; }
S=$(session); OS=$(session "-b /var/tmp/xis-op7")
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
ours() { grep '^iscsi ' "$FX/calls.log"; }
TGT='"target":"192.0.2.30"'
IQN2='"target":"192.0.2.30","iscsiPort":3261,"targetIQN":"iqn.2026-11.com.cybernetics:isan.tgt2"'

echo "=== Scan Target Host ==="
: > "$FX/calls.log"
check "the IQNs" 200 "$(x sr_iscsi_scan_iqns "$TGT")"
check "  asked as XenCenter asks: SR.create on the coordinator, no targetIQN, never meant to be made" \
  'iscsi SR.create on xs-01 name=__gui__ desc=SHOULD NEVER BE CREATED size=0 content=user shared=true dconf={"target":"192.0.2.30","port":"3260"}' "$(ours)"
check "  sorted by IQN naturally (tgt2 before tgt10), * last, the empty one left out, IPv6 in brackets" \
  "iqn.2026-11.com.cybernetics:isan.tgt2 (192.0.2.30:3261)|iqn.2026-11.com.cybernetics:isan.tgt2 ([fd00::30]:3260)|iqn.2026-11.com.cybernetics:isan.tgt10 (192.0.2.31:3260)|* (192.0.2.30:3260)" \
  "$(field 'd.iqns.map(q=>q.label).join("|")' < $BODY)"
check "another port typed: sent" '"port":"3270"' "$(: > $FX/calls.log; x sr_iscsi_scan_iqns "$TGT,\"iscsiPort\":3270" >/dev/null; ours | grep -o '"port":"3270"')"
check "a host that does not resolve: XenCenter's words, at the host field" "409 host DNS lookup failed: the given servername could not be resolved." \
  "$(x sr_iscsi_scan_iqns '"target":"bad.example"') $(field 'd.field+" "+d.error' < $BODY)"
check "no iSCSI service there" "409 host Unable to connect to iSCSI service on target" "$(x sr_iscsi_scan_iqns '"target":"192.0.2.99"') $(field 'd.field+" "+d.error' < $BODY)"
check "no target host: refused, nothing asked" "400 0" "$(: > $FX/calls.log; x sr_iscsi_scan_iqns '"target":" "') $(ours | wc -l)"
check "a port that is no port" 400 "$(x sr_iscsi_scan_iqns "$TGT,\"iscsiPort\":70000")"

echo "=== CHAP ==="
touch "$FX/iscsi-chap"
check "wrong password: at the CHAP fields" "409 chap Logging in to the iSCSI target failed. Check your user name and password." \
  "$(x sr_iscsi_scan_iqns "$TGT,\"chapuser\":\"xen\",\"chappassword\":\"nope\"") $(field 'd.field+" "+d.error' < $BODY)"
check "  the password not in the audit log" 0 "$(grep -c 'nope' $DATA/audit.jsonl)"
check "right: the IQNs" 200 "$(x sr_iscsi_scan_iqns "$TGT,\"chapuser\":\"xen\",\"chappassword\":\"s3cret\"")"
rm -f "$FX/iscsi-chap"

echo "=== The LUNs ==="
: > "$FX/calls.log"
check "behind tgt2, at the IQN entry's own address and port (multi-homing)" 200 "$(x sr_iscsi_scan_luns "$IQN2")"
check "  asked with targetIQN, no SCSIid" \
  'iscsi SR.create on xs-01 name=__gui__ desc=SHOULD NEVER BE CREATED size=0 content=user shared=true dconf={"target":"192.0.2.30","port":"3261","targetIQN":"iqn.2026-11.com.cybernetics:isan.tgt2"}' "$(ours)"
check "  sorted by LUN id, XenCenter's labels" "LUN 0: aaaa: 2 TB (CYBERNET)|LUN 1: beef: 100 GB (CYBERNET)|LUN 2: cccc: 512 GB (CYBERNET)|LUN 3: dddd: 64 GB (CYBERNET)" \
  "$(field 'd.luns.map(l=>l.label).join("|")' < $BODY)"
check "  LUN 0 in use by iSCSI-A, the others free" "This LUN is already in use as SR iSCSI-A on pool Production.|null|null|null" "$(field 'd.luns.map(l=>String(l.inUse)).join("|")' < $BODY)"
check "without an IQN: refused" 400 "$(x sr_iscsi_scan_luns "$TGT")"

echo "=== What is on a LUN ==="
: > "$FX/calls.log"
check "LUN 1, empty: nothing found" "200 null null" "$(x sr_iscsi_probe "$IQN2,\"scsiId\":\"36001405bbbb\"") $(field 'd.found+" "+d.inUse' < $BODY)"
check "  SR.probe on the coordinator, as XenCenter" 'iscsi SR.probe on xs-01 type=lvmoiscsi dconf={"target":"192.0.2.30","port":"3261","targetIQN":"iqn.2026-11.com.cybernetics:isan.tgt2","SCSIid":"36001405bbbb"}' "$(ours)"
check "LUN 2: another pool's SR, unknown here" "uuid-foreign 549755813888 null null" "$(x sr_iscsi_probe "$IQN2,\"scsiId\":\"36001405cccc\"" >/dev/null; field '[d.found.uuid,d.found.size,String(d.found.known),String(d.inUse)].join(" ")' < $BODY)"
check "LUN 3: iSCSI-Gone, known here without PBDs: no Format (in use)" "iSCSI-Gone false This LUN is already in use as SR iSCSI-Gone on pool Production." \
  "$(x sr_iscsi_probe "$IQN2,\"scsiId\":\"36001405dddd\"" >/dev/null; field 'd.found.known.name+" "+d.found.known.hasPbds+" "+d.inUse' < $BODY)"
check "LUN 0, in use: refused before anything is asked" "409 lun" "$(x sr_iscsi_probe "$IQN2,\"scsiId\":\"36001405aaaa\"") $(field d.field < $BODY)"

echo "=== Format ==="
NEW="$IQN2,\"scsiId\":\"36001405bbbb\",\"nameLabel\":\"Cyber 1\",\"nameDescription\":\"\""
check "not confirmed: refused" "409 true" "$(x sr_iscsi_create "$NEW,\"mode\":\"format\"") $(field d.needsConfirm < $BODY)"
check "an operator may not" 403 "$(x sr_iscsi_create "$NEW,\"mode\":\"format\",\"confirm\":true" "-b /var/tmp/xis-op7" "$OS")"
touch "$FX/iscsi-chap"
: > "$FX/calls.log"
check "formatted, with CHAP" 200 "$(x sr_iscsi_create "$NEW,\"mode\":\"format\",\"confirm\":true,\"chapuser\":\"xen\",\"chappassword\":\"s3cret\"")"
check "  the password as a secret: Secret.create with its value, only chappassword_secret in the SR's config, the secret gone after" \
  'iscsi Secret.create fields=other_config,value|iscsi SR.create on xs-01 name=Cyber 1 desc= size=0 content= shared=true dconf={"target":"192.0.2.30","port":"3261","targetIQN":"iqn.2026-11.com.cybernetics:isan.tgt2","SCSIid":"36001405bbbb","chapuser":"xen","chappassword_secret":"secret-uuid-1"}|iscsi Secret.destroy secret-uuid-1' \
  "$(ours | grep -v 'SR.probe\|set_other_config' | paste -sd'|')"
check "  checked first what is on the LUN" 1 "$(ours | grep -c 'SR.probe')"
check "  auto-scan off, as SrCreateAction" 'iscsi SR.set_other_config Cyber 1 {"auto-scan":"false"}' "$(ours | grep set_other_config)"
check "  not the pool's first shared SR: the default stays" 0 "$(grep -c 'set_default_SR' $FX/calls.log)"
check "  the password nowhere in the audit log" 0 "$(grep -c 's3cret' $DATA/audit.jsonl)"
rm -f "$FX/iscsi-chap"
check "the LUN of Cyber 1 now in use" "This LUN is already in use as SR Cyber 1 on pool Production." "$(x sr_iscsi_scan_luns "$IQN2" >/dev/null; field 'd.luns.find(l=>l.scsiId==="36001405bbbb").inUse' < $BODY)"

echo "=== Reattach ==="
: > "$FX/calls.log"
check "LUN 2: the other pool's SR brought in" 200 "$(x sr_iscsi_create "$IQN2,\"scsiId\":\"36001405cccc\",\"nameLabel\":\"Foreign\",\"nameDescription\":\"d\",\"mode\":\"reattach\",\"uuid\":\"uuid-foreign\"")"
check "  introduced as XenCenter does, a PBD per host, each plugged" \
  'iscsi SR.introduce uuid-foreign name=Foreign type=lvmoiscsi content= shared=true|iscsi PBD.create Foreign on xs-01 dconf={"target":"192.0.2.30","port":"3261","targetIQN":"iqn.2026-11.com.cybernetics:isan.tgt2","SCSIid":"36001405cccc"}|iscsi PBD.plug Foreign on xs-01|iscsi PBD.create Foreign on xs-02 dconf={"target":"192.0.2.30","port":"3261","targetIQN":"iqn.2026-11.com.cybernetics:isan.tgt2","SCSIid":"36001405cccc"}|iscsi PBD.plug Foreign on xs-02' \
  "$(ours | grep -v 'SR.probe' | paste -sd'|')"
check "a reattach for an SR that is not on the LUN: refused" "409" "$(x sr_iscsi_create "$IQN2,\"scsiId\":\"36001405bbbb\",\"nameLabel\":\"X\",\"mode\":\"reattach\",\"uuid\":\"uuid-other\"")"
: > "$FX/calls.log"
check "LUN 3: iSCSI-Gone, known here: PBDs for it, renamed (SrReattachAction)" 200 "$(x sr_iscsi_create "$IQN2,\"scsiId\":\"36001405dddd\",\"nameLabel\":\"Gone again\",\"nameDescription\":\"back\",\"mode\":\"reattach\",\"uuid\":\"uuid-iscsigone\"")"
check "  no introduce; PBDs, then the name" "0 2 iscsi SR.set_name_label iSCSI-Gone -> Gone again" \
  "$(ours | grep -c introduce) $(ours | grep -c 'PBD.plug') $(ours | grep set_name_label)"
check "  and no Format over it: refused while in use" "409 lun" "$(x sr_iscsi_create "$IQN2,\"scsiId\":\"36001405dddd\",\"nameLabel\":\"X\",\"mode\":\"format\",\"confirm\":true") $(field d.field < $BODY)"

echo "=== The interrogation made an SR after all ==="
touch "$FX/iscsi-create-succeeds"; : > "$FX/calls.log"
check "an error, as XenCenter's" "409 Interrogation failed -- call succeeded!" "$(x sr_iscsi_scan_iqns "$TGT") $(field d.error < $BODY)"
check "  and the SR forgotten again, nothing destroyed" "1 0" "$(ours | grep -c 'SR.forget __gui__') $(grep -c 'SR.destroy' $FX/calls.log)"
rm -f "$FX/iscsi-create-succeeds"

echo "=== The audit log ==="
check "a format: where, and what became of it" true "$(grep '"action":"sr_iscsi_create"' $DATA/audit.jsonl | grep '"outcome":"success"' | grep -q 'formatted 192.0.2.30:3261 iqn.2026-11.com.cybernetics:isan.tgt2 LUN 36001405bbbb as a new SR (CHAP password as a secret)' && echo true || echo false)"
check "reattaches: which SR" 2 "$(grep '"action":"sr_iscsi_create"' $DATA/audit.jsonl | grep -c 'reattached SR uuid-')"
check "successful scans are not logged, failed ones are" "0 true" "$(grep '"action":"sr_iscsi_scan' $DATA/audit.jsonl | grep -c '"outcome":"success"') $(grep '"action":"sr_iscsi_scan_iqns"' $DATA/audit.jsonl | grep -q 'DNS lookup failed' && echo true || echo false)"
check "an operator's scan: denied and logged" "403 true" "$(x sr_iscsi_scan_iqns "$TGT" "-b /var/tmp/xis-op7" "$OS") $(grep '"action":"sr_iscsi_scan_iqns"' $DATA/audit.jsonl | grep -q '"outcome":"denied"' && echo true || echo false)"

echo; echo "$pass passed, $fail failed"
exit $fail
