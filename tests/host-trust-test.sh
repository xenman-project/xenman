#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Checking XenServer hosts by their certificates: against server.js in the
# appliance layout (the console proxy lives there) and the stand-in pool
# serving HTTPS with certificates the test swaps.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
SRC=$BUILD
APP=/var/tmp/ht-app; D=/var/tmp/ht-data; FX=/var/tmp/ht-fake; K=/var/tmp/ht-keys; MAIL=/var/tmp/ht-mail
PORT=3160; XPORT=4486; SPORT=2526; SSHPORT=2228
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
W=$TESTS
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3') body: $(head -c 300 $BODY 2>/dev/null)"; fail=$((fail+1)); fi; }
BODY=/var/tmp/ht-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }
audit() { $NODE -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval(process.argv[2]))' $D/audit.jsonl "$1"; }

rm -rf $APP $D $FX $K $MAIL; mkdir -p $APP $D $FX $K $MAIL
# Certificates: A the pool's coordinator, C its second host, B someone else's, E C renewed.
for n in A B C E; do
  openssl req -x509 -newkey rsa:2048 -nodes -keyout $K/$n.key -out $K/$n.crt -subj "/CN=xs-$n" -days 30 2>/dev/null
done
fp() { openssl x509 -noout -fingerprint -sha256 -in $K/$1.crt | cut -d= -f2; }
openssl genrsa -traditional -out $K/ssh1 2048 2>/dev/null; openssl genrsa -traditional -out $K/ssh2 2048 2>/dev/null

serve_fake() { # serve_fake <cert>
  [ -n "${FPID:-}" ] && kill $FPID 2>/dev/null && sleep 0.5
  cp $K/$1.key $FX/tls.key; cp $K/$1.crt $FX/tls.crt
  $NODE $W/fake-xapi.js $XPORT $FX >> /var/tmp/ht-fake.log 2>&1 & FPID=$!
  for _ in $(seq 20); do curl -sk -o /dev/null https://127.0.0.1:$XPORT/ && break; sleep 0.2; done
}
serve_ssh() { # serve_ssh <key>
  [ -n "${SSHPID:-}" ] && kill $SSHPID 2>/dev/null && sleep 0.5
  local n; n=$(grep -c listening $FX/ssh.log 2>/dev/null || echo 0)
  $NODE $W/fake-ssh.js $SSHPORT $K/$1 $FX/ssh.log >> /var/tmp/ht-ssh.log 2>&1 & SSHPID=$!
  for _ in $(seq 25); do [ "$(grep -c listening $FX/ssh.log 2>/dev/null)" -gt "$n" ] && break; sleep 0.2; done
}
start_xenman() {
  [ -n "${P:-}" ] && kill $P 2>/dev/null && sleep 1
  cd $APP
  PORT=$PORT HTTPS_PORT=0 DATA_DIR=$D NODE_ENV=production XENMAN_TRUST_LEARN_MS=1 \
    $NODE server.js >> /var/tmp/ht-server.log 2>&1 & P=$!
  cd /
  for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done
}
echo normal > $FX/mode
cp $K/C.crt $FX/h2.crt
serve_fake A
serve_ssh ssh1
$NODE $W/smtp-sink.js $SPORT $MAIL & SPID=$!
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js
cp $REPO/server.js $REPO/vnc-proxy.js $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
start_xenman
trap 'kill $P $FPID $SPID $SSHPID 2>/dev/null' EXIT

C=/var/tmp/ht-cookie
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
A="-b $C"
TOKEN=$(grep xenman-auth $C | awk '{print $7}')
curl -s $A -X POST $B/api/smtp $J -d "{\"host\":\"127.0.0.1\",\"port\":$SPORT,\"from\":\"xenman@example.org\",\"encryption\":\"none\",\"validateCertificate\":false,\"username\":\"\",\"password\":\"\"}" >/dev/null
curl -s $A -X PUT $B/api/auth/users/admin $J -d '{"email":"admin@example.org"}' >/dev/null
calls() { grep -c "$1" "$FX/calls.log" 2>/dev/null || echo 0; }
xen() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",$2}"; }
trust() { curl -s ${1:-$A} $B/api/host-trust > $BODY; }
HOST="{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":true,\"sshPort\":$SSHPORT}"

echo "=== adding a pool: the certificate first ==="
check "the certificate is shown" "200 $(fp A)" "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"probe\",\"address\":\"127.0.0.1\",\"port\":$XPORT}") $(field d.certificate.fingerprint < $BODY)"
check "  with subject and validity" "true true" "$(field 'd.certificate.subject.includes("xs-A")+" "+(Date.parse(d.certificate.validTo)>Date.now())' < $BODY)"
check "  nothing was sent to the host for it" 0 "$(calls 'session.login')"
check "a probe of nothing: said" 502 "$(code $A -X POST $B/api/hosts $J -d '{"action":"probe","address":"127.0.0.1","port":1}')"
check "added over HTTPS without a confirmed certificate: refused" 400 "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":$HOST}")"
check "added with the confirmed one" 200 "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":$HOST,\"fingerprint\":\"$(fp A)\"}")"
trust
check "  trusted, as confirmed" "1 $(fp A) admin" "$(field 'const p=d.pools[0]; p.certs.length+" "+p.certs[0].fingerprint+" "+p.certs[0].source' < $BODY)"
check "  audited with the fingerprint" 1 "$(audit "l.filter(x=>x.action==='host_added'&&x.detail.includes('$(fp A)')).length")"

echo "=== connecting: checked ==="
check "connects" 200 "$(xen connect '"hostId":"pool1"')"
S=$(field d.sessionRef < $BODY)
trust
check "the members' certificates learned from the pool" "xs-01:$(fp A):admin xs-02:$(fp C):pool" "$(field 'd.pools[0].certs.map(c=>c.host+":"+c.fingerprint+":"+c.source).sort().join(" ")' < $BODY)"
check "  audited" 1 "$(audit "l.filter(x=>x.action==='host_cert_learned'&&x.target.includes('xs-02')).length")"
check "performance data from a member" 200 "$(xen rrd "\"sessionRef\":\"$S\",\"hostRef\":\"OpaqueRef:host-2\",\"period\":\"10m\"")"
check "the update list" "200 0" "$(code $A "$B/api/xen-updates?hostId=pool1&fresh=1") $(grep -c certificate $BODY | awk '{print ($1>0)}')"
WS="ws://127.0.0.1:$PORT/api/vnc-proxy?consoleUrl=$($NODE -pe "encodeURIComponent('https://127.0.0.1:$XPORT/console?ref=OpaqueRef:c1')")"
# The proxy only connects to a console XenMan handed out on the session.
xen vm_console "\"sessionRef\":\"$S\",\"vmRef\":\"OpaqueRef:vm-1\"" >/dev/null
check "a console" "data RFB 003.008" "$($NODE $W/vnc-client.js "$WS&sessionId=$S&useSsl=true" $TOKEN)"
# Refused before the upgrade since the review of 2026-11 (server.js consoleRefusal).
check "a console with a session XenMan did not open: refused" "error Unexpected server response: 403" "$($NODE $W/vnc-client.js "$WS&sessionId=OpaqueRef:forged&useSsl=true" $TOKEN)"

echo "=== the SSH export: the host key ==="
xen vm_export_ssh "\"sessionRef\":\"$S\",\"hostId\":\"pool1\",\"sshHost\":\"127.0.0.1\",\"vmUuid\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"vmName\":\"web-01\",\"exportDir\":\"/tmp\"" >/dev/null
JOB=$(field d.jobId < $BODY); sleep 2
check "first export: runs, the key is remembered" "success 1" "$(xen vm_export_status "\"sessionRef\":\"$S\",\"jobId\":\"$JOB\"" >/dev/null; field d.status < $BODY) $(audit "l.filter(x=>x.action==='ssh_hostkey_learned').length")"
check "an address that is not the pool's: refused" 400 "$(xen vm_export_ssh "\"sessionRef\":\"$S\",\"hostId\":\"pool1\",\"sshHost\":\"192.0.2.66\",\"vmUuid\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"vmName\":\"web-01\",\"exportDir\":\"/tmp\"")"
serve_ssh ssh2
N=$(grep -c password $FX/ssh.log)
xen vm_export_ssh "\"sessionRef\":\"$S\",\"hostId\":\"pool1\",\"sshHost\":\"127.0.0.1\",\"vmUuid\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"vmName\":\"web-01\",\"exportDir\":\"/tmp\"" >/dev/null
JOB=$(field d.jobId < $BODY); sleep 2
xen vm_export_status "\"sessionRef\":\"$S\",\"jobId\":\"$JOB\"" >/dev/null
check "another host key: refused, said why" "failure true" "$(field 'd.status+" "+d.error.includes("SSH host key")' < $BODY)"
check "  the password was not sent" "$N" "$(grep -c password $FX/ssh.log)"
trust
check "  shown for the admin" true "$(field 'd.pools[0].sshMismatch.fingerprint.startsWith("SHA256:")' < $BODY)"
check "  mailed to the admins" 1 "$(grep -l 'SSH host key of 127.0.0.1 changed' $MAIL/*.eml 2>/dev/null | wc -l)"
check "  accepted by the admin" 200 "$(code $A -X POST $B/api/host-trust $J -d '{"action":"accept_ssh","poolId":"pool1","address":"127.0.0.1"}')"
xen vm_export_ssh "\"sessionRef\":\"$S\",\"hostId\":\"pool1\",\"sshHost\":\"127.0.0.1\",\"vmUuid\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"vmName\":\"web-01\",\"exportDir\":\"/tmp\"" >/dev/null
JOB=$(field d.jobId < $BODY); sleep 2
check "  then it runs" success "$(xen vm_export_status "\"sessionRef\":\"$S\",\"jobId\":\"$JOB\"" >/dev/null; field d.status < $BODY)"

echo "=== another certificate: refused before anything is sent ==="
serve_fake B
L=$(calls 'session.login'); R=$(calls 'GET /rrd_updates'); V=$(calls CONNECT)
check "connect refused, said why" "502 CERT_CHANGED" "$(xen connect '"hostId":"pool1"') $(field d.code < $BODY)"
check "  the message names the host" true "$(field 'd.error.includes("127.0.0.1") && d.error.includes("certificate")' < $BODY)"
check "  the password never reached it" "$L" "$(calls 'session.login')"
xen connect '"hostId":"pool1"' >/dev/null
check "performance data refused" "502 $R" "$(xen rrd "\"sessionRef\":\"$S\",\"hostRef\":\"OpaqueRef:host-1\",\"period\":\"10m\"") $(calls 'GET /rrd_updates')"
check "the console refused" "close 1008 Host certificate changed $V" "$($NODE $W/vnc-client.js "$WS&sessionId=$S&useSsl=true" $TOKEN) $(calls CONNECT)"
code $A "$B/api/xen-updates?hostId=pool1&fresh=1" >/dev/null
check "the update list: refused, said why" true "$(grep -q 'certificate of 127.0.0.1 has changed' $BODY && echo true)"
trust
check "shown: what was presented, what is trusted" "$(fp B) 2" "$(field 'd.pools[0].mismatch.fingerprint+" "+d.pools[0].mismatch.expected.length' < $BODY)"
check "audited once, however often it was tried" 1 "$(audit "l.filter(x=>x.action==='host_cert_mismatch').length")"
sleep 1
M=$(grep -l 'Certificate of 127.0.0.1 changed' $MAIL/*.eml 2>/dev/null)
check "one mail to the admins, with the fingerprint" "1 true" "$(echo "$M" | grep -c eml) $(grep -q "$(fp B | cut -c1-20)" $M && echo true)"

echo "=== accepting it ==="
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Maple-Root-1357","role":"operator"}' >/dev/null
curl -s -c /var/tmp/ht-op -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Maple-Root-1357"}' >/dev/null
check "an operator may not" 403 "$(code -b /var/tmp/ht-op -X POST $B/api/host-trust $J -d "{\"action\":\"accept\",\"poolId\":\"pool1\",\"fingerprint\":\"$(fp B)\"}")"
check "  nor add a pool" 403 "$(code -b /var/tmp/ht-op -X POST $B/api/hosts $J -d '{"action":"probe","address":"127.0.0.1","port":443}')"
check "an admin may not accept another than the one refused" 400 "$(code $A -X POST $B/api/host-trust $J -d "{\"action\":\"accept\",\"poolId\":\"pool1\",\"fingerprint\":\"$(fp E)\"}")"
check "an admin accepts the one refused" 200 "$(code $A -X POST $B/api/host-trust $J -d "{\"action\":\"accept\",\"poolId\":\"pool1\",\"fingerprint\":\"$(fp B)\"}")"
check "  audited" 1 "$(audit "l.filter(x=>x.action==='host_cert_accepted'&&x.actor==='admin').length")"
check "connects again" 200 "$(xen connect '"hostId":"pool1"')"
S=$(field d.sessionRef < $BODY)
trust
check "  the old certificate is no longer trusted" false "$(field 'd.pools[0].certs.some(c=>c.fingerprint==="'"$(fp A)"'")' < $BODY)"
check "  nothing refused any more" false "$(field '"mismatch" in d.pools[0]' < $BODY)"

echo "=== a member renews its certificate ==="
cp $K/E.crt $FX/h2.crt
xen connect '"hostId":"pool1"' >/dev/null
trust
check "taken over, as the pool reports it" "$(fp E)" "$(field 'd.pools[0].certs.find(c=>c.host==="xs-02").fingerprint' < $BODY)"
check "  audited as a renewal" 1 "$(audit "l.filter(x=>x.action==='host_cert_renewed'&&x.detail.includes('$(fp C)')).length")"

echo "=== pools from before the update ==="
kill $P; sleep 1; P=
rm $D/host-trust.json
start_xenman
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
check "connects" 200 "$(xen connect '"hostId":"pool1"')"
trust
check "the certificate taken over, to be compared" "true" "$(field 'd.pools[0].pendingReview' < $BODY)"
check "  audited" 1 "$(audit "l.filter(x=>x.action==='host_cert_taken_over'&&x.detail.includes('$(fp B)')).length")"
check "compared by the admin" "200 false" "$(code $A -X POST $B/api/host-trust $J -d '{"action":"reviewed","poolId":"pool1"}') $(field '"pendingReview" in d' < $BODY)"
serve_fake A
check "taken over only once: another certificate later is refused" 502 "$(xen connect '"hostId":"pool1"')"

echo "=== removing the pool ==="
curl -s $A -X POST $B/api/hosts $J -d '{"action":"remove","hostId":"pool1"}' >/dev/null
check "its certificates are forgotten" false "$($NODE -pe "'pool1' in JSON.parse(require('fs').readFileSync('$D/host-trust.json')).pools")"

echo "=== adding a pool through a member's address ==="
# A second stand-in on 127.0.0.2 with its own certificate C, a member that
# names 127.0.0.1 as its coordinator; the pool reports C for it.
FX2=/var/tmp/ht-fake2; rm -rf $FX2; mkdir -p $FX2; echo normal > $FX2/mode; touch $FX2/member-login
cp $K/C.key $FX2/tls.key; cp $K/C.crt $FX2/tls.crt; cp $K/C.crt $FX/h2.crt
FAKE_LISTEN=127.0.0.2 $NODE $W/fake-xapi.js $XPORT $FX2 >> /var/tmp/ht-fake2.log 2>&1 & F2PID=$!
trap 'kill $P $FPID $SPID $SSHPID $F2PID 2>/dev/null' EXIT
for _ in $(seq 20); do curl -sk -o /dev/null https://127.0.0.2:$XPORT/ && break; sleep 0.2; done
verify() { # verify <fingerprint> [password] [coordinator fingerprint]
  local extra=""; [ -n "${3:-}" ] && extra=",\"coordinator\":{\"fingerprint\":\"$3\"}"
  code $A -X POST $B/api/hosts $J -d "{\"action\":\"verify\",\"address\":\"127.0.0.2\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"${2:-secret}\",\"fingerprint\":\"$1\"$extra}"
}
check "the member's certificate shown first" "200 $(fp C)" "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"probe\",\"address\":\"127.0.0.2\",\"port\":$XPORT}") $(field d.certificate.fingerprint < $BODY)"
check "another certificate than confirmed: refused, the password not sent" "409 0" "$(verify "$(fp B)") $(grep -c session.login $FX2/calls.log 2>/dev/null || echo 0)"
check "a wrong password: said" "400 true" "$(verify "$(fp C)" wrong) $(field 'd.error.includes("did not accept the login of \"root\": bad.")' < $BODY)"
check "confirmed: the member names its coordinator, whose certificate is shown" "200 true 127.0.0.1 $(fp A)" "$(verify "$(fp C)") $(field 'd.member+" "+d.coordinator+" "+d.certificate.fingerprint' < $BODY)"
L=$(calls 'session.login')
check "  another coordinator certificate than confirmed: refused before the password" "409 $L" "$(verify "$(fp C)" secret "$(fp B)") $(calls 'session.login')"
check "  both confirmed: the login works" "200 true 127.0.0.1" "$(verify "$(fp C)" secret "$(fp A)") $(field 'd.ok+" "+d.coordinator' < $BODY)"
POOL3="{\"id\":\"pool3\",\"name\":\"Via member\",\"address\":\"127.0.0.2\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":true}"
check "added with both" 200 "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":$POOL3,\"fingerprint\":\"$(fp C)\",\"coordinator\":{\"address\":\"127.0.0.1\",\"fingerprint\":\"$(fp A)\"}}")"
check "  audited with both" 1 "$(audit "l.filter(x=>x.action==='host_added'&&x.detail.includes('coordinator 127.0.0.1')).length")"
M=$(audit "l.filter(x=>x.action==='host_cert_mismatch').length")
check "connects through the member, no warning" "200 $M" "$(xen connect '"hostId":"pool3"') $(audit "l.filter(x=>x.action==='host_cert_mismatch').length")"
check "  again, after learning the pool" 200 "$(xen connect '"hostId":"pool3"')"

echo "=== a pool from before, configured with a member's address ==="
kill $P; sleep 1; P=
$NODE -e '
const fs=require("fs"), f=process.argv[1], h=JSON.parse(fs.readFileSync(f));
fs.writeFileSync(f, JSON.stringify(h.filter(x=>x.id==="pool3").map(x=>({...x,id:"pool4",name:"From before"})), null, 2));' $D/hosts.json
rm $D/host-trust.json
start_xenman
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
check "connects: the member and the coordinator it names taken over" 200 "$(xen connect '"hostId":"pool4"')"
trust
check "  both to be compared, no warning" "true 0" "$(field 'd.pools[0].pendingReview+" "+("mismatch" in d.pools[0] ? 1 : 0)' < $BODY)"
check "  the set as the pool reports it" "$(printf '%s
' "$(fp A)" "$(fp C)" | LC_ALL=C sort | tr '
' ' ' | sed 's/ $//')" "$(field 'd.pools[0].certs.map(c=>c.fingerprint).sort().join(" ")' < $BODY)"
check "  taken over: the address and the coordinator, audited" 2 "$(audit "l.filter(x=>x.action==='host_cert_taken_over'&&x.target.includes('From before')).length")"
serve_fake B
check "after that first login nothing more is taken over" 502 "$(xen connect '"hostId":"pool4"')"

echo; echo "$pass passed, $fail failed"
exit $fail
