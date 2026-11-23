#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The SSH exports (vm_export_ssh, vdi_export_ssh) run `xe` in a shell on a pool
# host as root. What the browser sends -- the directory, the UUID -- must not
# get anything else run there: refused unless it is what it claims to be.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xexp-data; FX=/var/tmp/xexp-fake
PORT=3196; XPORT=4496
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xexp-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xexp-fake.log 2>&1 & FPID=$!
# The pool's host over SSH: runs nothing, logs the command (fake-ssh.js).
SSHPORT=2231; openssl genrsa -traditional -out "$FX/sshkey" 2048 2>/dev/null
"$NODE" $TESTS/fake-ssh.js $SSHPORT "$FX/sshkey" "$FX/ssh.log" >> /var/tmp/xexp-ssh.log 2>&1 & SSHPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xexp-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID $SSHPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xexp-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false,\"sshPort\":$SSHPORT}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
UUID=aaaaaaaa-0000-4000-8000-000000000001
# exp <action> <uuid> <dir as JSON>: the export as the dialog asks for it.
exp() { code $A -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"$S\",\"hostId\":\"pool1\",\"sshHost\":\"127.0.0.1\",\"vmUuid\":\"$2\",\"vdiUuid\":\"$2\",\"vmName\":\"web-01\",\"vdiName\":\"disk\",\"exportDir\":$3}"; }

for a in vm_export_ssh vdi_export_ssh; do
  echo "=== $a ==="
  check "a command after the directory" 400 "$(exp $a $UUID '"/mnt/exports; touch /tmp/pwned"')"
  check "a command substitution" 400 "$(exp $a $UUID '"/mnt/$(id)"')"
  check "backquotes" 400 "$(exp $a $UUID '"/mnt/`id`"')"
  check "a quote" 400 "$(exp $a $UUID "\"/mnt/it's\"")"
  check "a relative path" 400 "$(exp $a $UUID '"exports"')"
  check "out of the directory with .." 400 "$(exp $a $UUID '"/mnt/../etc"')"
  check "not a string" 400 "$(exp $a $UUID '42')"
  check "a UUID with a command" 400 "$(exp $a "$UUID;reboot" '"/mnt/exports"')"
  check "a plain directory, with a space: accepted" "200 true" \
    "$(exp $a $UUID '"/var/run/sr-mount/Export Share/"') $(field '/^\/var\/run\/sr-mount\/Export Share\/(web-01|disk)_[0-9-]+\.(xva|raw)$/.test(d.targetPath)' < $BODY)"
done
check "the refusals are audited" 16 "$(grep -cE '"action":"(vm|vdi)_export_ssh".*"outcome":"failure"' "$DATA/audit.jsonl")"

echo "=== Operators: below a mount point, into a mounted file system; the job theirs ==="
lastcmd() { sleep 1; grep '^exec ' "$FX/ssh.log" | tail -1; }
check "an administrator's export: no such limit, the command as before" "200 0" \
  "$(exp vm_export_ssh $UUID '"/var/tmp"') $(lastcmd | grep -c 'stat -c')"
AJOB=$(exp vm_export_ssh $UUID '"/mnt/admin"' >/dev/null; field d.jobId < $BODY)
for u in op1 op2; do
  curl -s $A -X POST $B/api/auth/users $J -d "{\"username\":\"$u\",\"password\":\"Pass-12345-xm\",\"role\":\"operator\"}" >/dev/null
  curl -s $A -X PUT $B/api/auth/users/$u $J -d '{"pools":["pool1"]}' >/dev/null
  curl -s -c /var/tmp/xexp-$u -X POST $B/api/auth/login $J -d "{\"username\":\"$u\",\"password\":\"Pass-12345-xm\"}" >/dev/null
done
O="-b /var/tmp/xexp-op1"; O2="-b /var/tmp/xexp-op2"
OS=$(code $O -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; field d.sessionRef < $BODY)
OS2=$(code $O2 -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; field d.sessionRef < $BODY)
opexp() { code $O -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"$OS\",\"hostId\":\"pool1\",\"sshHost\":\"127.0.0.1\",\"vmUuid\":\"$UUID\",\"vdiUuid\":\"$UUID\",\"vmName\":\"web-01\",\"vdiName\":\"disk\",\"exportDir\":$2}"; }
for a in vm_export_ssh vdi_export_ssh; do
  check "$a: the host's root file system refused" 400 "$(opexp $a '"/"')"
  check "  /var/log refused" 400 "$(opexp $a '"/var/log"')"
  check "  /mnt itself refused" 400 "$(opexp $a '"/mnt/"')"
  check "  a share below /mnt accepted" 200 "$(opexp $a '"/mnt/backup"')"
  check "  run only if it is a mounted file system" 1 "$(lastcmd | grep -c "stat -c %d '/mnt/backup')\" != \"\$(stat -c %d /)\"")"
done
OJOB=$(opexp vm_export_ssh '"/run/sr-mount/abc"' >/dev/null; field d.jobId < $BODY)
st() { code $1 -X POST $B/api/xen $J -d "{\"action\":\"vm_export_status\",\"sessionRef\":\"$2\",\"jobId\":\"$3\"}"; }
check "the operator's job: its status for the operator" 200 "$(st "$O" "$OS" "$OJOB")"
check "  not for another operator of the pool" 404 "$(st "$O2" "$OS2" "$OJOB")"
check "  for an administrator" 200 "$(st "$A" "$S" "$OJOB")"
check "an administrator's job: not for an operator" 404 "$(st "$O" "$OS" "$AJOB")"
check "the pool and actor stay with the job, not in its status" "false false" \
  "$(st "$A" "$S" "$OJOB" >/dev/null; field '("poolId" in d)+" "+("actor" in d)' < $BODY)"

echo; echo "$pass passed, $fail failed"
exit $fail
