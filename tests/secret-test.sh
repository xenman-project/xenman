#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The stored passwords: a key of their own, outside the data directory on the
# appliance (xenman-credential + systemd-creds), old values re-encrypted, a
# copy of the data directory useless elsewhere, files XenMan's alone.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
D=/var/tmp/sec-data; FX=/var/tmp/sec-fake; RUN=/var/tmp/sec-run; ETC=/var/tmp/sec-etc
PORT=3170; XPORT=4488
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
SRC=$REPO
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/sec-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }
audit() { $NODE -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval(process.argv[2]))' $D/audit.jsonl "$1"; }
stored() { $NODE -pe "JSON.parse(require('fs').readFileSync('$D/hosts.json'))[0].password"; }
mode() { stat -c %a "$1"; }
hex() { od -An -tx1 -v "$@" | tr -d ' 
'; }

rm -rf $D $FX $RUN $ETC; mkdir -p $D $FX $ETC; echo normal > $FX/mode
$NODE $TESTS/fake-xapi.js $XPORT $FX > /var/tmp/sec-fake.log 2>&1 & FPID=$!

echo "=== the appliance script, with the real systemd-creds ==="
run_cred() { CRED=$ETC/secret-key.cred OUT_DIR=$RUN XENMAN_GROUP=root bash $SRC/appliance/xenman-credential 2>/dev/null; }
run_cred
check "the key made once, encrypted, root's alone" "600 false" "$(mode $ETC/secret-key.cred) $(grep -qaF "$(hex $RUN/secret-key)" $ETC/secret-key.cred && echo true || echo false)"
check "  decrypted for XenMan: 32 bytes, 0440, in a 0750 directory" "32 440 750" "$(stat -c %s $RUN/secret-key) $(mode $RUN/secret-key) $(mode $RUN)"
K1=$(sha256sum $RUN/secret-key | cut -c1-16)
run_cred
check "  a second boot: the same key, not a new one" "$K1" "$(sha256sum $RUN/secret-key | cut -c1-16)"
cp $ETC/secret-key.cred /var/tmp/sec-cred.bak
echo "garbage" > $ETC/secret-key.cred
check "a credential that does not decrypt: XenMan still starts, no key handed over" "0 no" "$(run_cred; echo $?) $([ -e $RUN/secret-key ] && echo yes || echo no)"
check "  and it is kept, not replaced by a new key" garbage "$(cat $ETC/secret-key.cred)"
cp /var/tmp/sec-cred.bak $ETC/secret-key.cred; run_cred

echo "=== passwords from before: re-encrypted at start ==="
# As an earlier XenMan left them: encrypted with SHA-256 of the login secret.
SECRET=$(head -c 32 /dev/urandom | hex)
printf '%s' "$SECRET" > $D/.jwt-secret
LEGACY=$($NODE -e '
const c=require("crypto"), k=c.createHash("sha256").update(process.argv[1]).digest(), iv=c.randomBytes(12);
const x=c.createCipheriv("aes-256-gcm",k,iv), ct=Buffer.concat([x.update("secret","utf8"),x.final()]);
console.log(`enc:${iv.toString("hex")}:${ct.toString("hex")}:${x.getAuthTag().toString("hex")}`)' "$SECRET")
echo "[{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"$LEGACY\",\"useSsl\":false}]" > $D/hosts.json
echo "{\"host\":\"127.0.0.1\",\"port\":25,\"from\":\"x@example.org\",\"encryption\":\"none\",\"validateCertificate\":false,\"username\":\"u\",\"password\":\"$LEGACY\"}" > $D/smtp.json
chmod 644 $D/hosts.json $D/smtp.json
start() { # start [key file]
  # The npx wrapper and the next-server under it: a server left over would answer with the old key.
  [ -n "${PID:-}" ] && { kill $PID; pkill -f next-server; for _ in $(seq 20); do curl -s -o /dev/null "$B/login" || break; sleep 0.5; done; }
  cd $W
  env DATA_DIR=$D NEXT_TELEMETRY_DISABLED=1 ${1:+XENMAN_HOST_KEY_FILE=$1} npx next start -p $PORT > /var/tmp/sec-server.log 2>&1 & PID=$!
  for _ in $(seq 40); do curl -sS -o /dev/null "$B/login" 2>/dev/null && break; sleep 1; done
  cd /
}
start $RUN/secret-key
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
KID=$(sha256sum $RUN/secret-key | cut -c1-8)
check "the pool password: now with the appliance's key" "enc2:$KID" "$(stored | cut -d: -f1,2)"
check "  the mail password too" "enc2:$KID" "$($NODE -pe "JSON.parse(require('fs').readFileSync('$D/smtp.json')).password" | cut -d: -f1,2)"
check "  audited" 1 "$(audit "l.filter(x=>x.action==='host_passwords_resealed'&&x.detail.includes('outside the data directory')).length")"
check "files with secrets: XenMan's alone" "600 600 600" "$(mode $D/hosts.json) $(mode $D/smtp.json) $(mode $D/.jwt-secret)"
C=/var/tmp/sec-cookie
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
A="-b $C"
check "  users.json as well" 600 "$(mode $D/users.json)"
check "the password still right: connects" 200 "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}')"
check "  the login secret alone no longer opens it" false "$($NODE -e '
const c=require("crypto"), k=c.createHash("sha256").update(process.argv[1]).digest(), [, , iv, ct, tag]=process.argv[2].split(":");
try { const x=c.createDecipheriv("aes-256-gcm",k,Buffer.from(iv,"hex")); x.setAuthTag(Buffer.from(tag,"hex")); x.update(Buffer.from(ct,"hex")); x.final(); console.log(true) } catch { console.log(false) }' "$SECRET" "$(stored)")"
check "  nor anything else in the data directory" 0 "$(grep -rlF "$(hex $RUN/secret-key)" $D 2>/dev/null | wc -l)"

echo "=== the data directory without the appliance's key (a backup elsewhere) ==="
BEFORE=$(stored)
start ""
check "the pool is still listed, its password marked unreadable" "Production true" "$(curl -s $A $B/api/hosts | field 'd[0].name+" "+d[0].passwordUnreadable')"
check "  connecting says what to do" "409 true" "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}') $(field 'd.error.includes("Enter it again")' < $BODY)"
check "  nothing was sent to the host with an empty password" 0 "$(grep -c 'session.login_with_password \[\"root\",\"\"' $FX/calls.log)"
curl -s $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool2\",\"name\":\"Other\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
check "  saving the list keeps the unreadable one as it was" "$BEFORE" "$($NODE -pe "JSON.parse(require('fs').readFileSync('$D/hosts.json')).find(h=>h.id==='pool1').password")"
check "  a new one is stored with a key of the data directory's own" "true 600" "$($NODE -pe "JSON.parse(require('fs').readFileSync('$D/hosts.json')).find(h=>h.id==='pool2').password.startsWith('enc2:')") $(mode $D/.secret-key)"
check "  and is not the login secret's key" false "$([ "$(sha256sum $D/.secret-key | cut -c1-8)" = "$($NODE -e "console.log(require('crypto').createHash('sha256').update(require('crypto').createHash('sha256').update('$SECRET').digest()).digest('hex').slice(0,8))")" ] && echo true || echo false)"

echo "=== the appliance's key back ==="
start $RUN/secret-key
check "readable again, connects" 200 "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}')"
check "  the one stored meanwhile moved to the appliance's key" "enc2:$KID" "$($NODE -pe "JSON.parse(require('fs').readFileSync('$D/hosts.json')).find(h=>h.id==='pool2').password" | cut -d: -f1,2)"
check "  and connects too" 200 "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool2"}')"
check "editing without a new password keeps it" 200 "$(curl -s $A -X POST $B/api/hosts $J -d "{\"action\":\"update\",\"host\":{\"id\":\"pool1\",\"name\":\"Production 2\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"\",\"useSsl\":false}}" >/dev/null; code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}')"
check "the password never reaches the browser" false "$(curl -s $A $B/api/hosts | grep -q '"password"' && echo true || echo false)"

echo; echo "$pass passed, $fail failed"
exit $fail
