#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The XAPI session stays on the server (lib/xen-sessions.ts): the browser gets
# a handle in its place, worthless at the pool; /api/xen, the VM import and
# the console proxy turn it back into the session. A binding that ends --
# signing out, sign-out everywhere, a pool taken away, the account removed --
# ends the XAPI session at the pool too. Against server.js and the fake pool,
# which logs logins, logouts and the session a console was asked for.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
SRC=$BUILD
APP=/var/tmp/sh-app; D=/var/tmp/sh-data; FX=/var/tmp/sh-fake
PORT=3178; XPORT=4498
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
W=$TESTS
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/sh-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf $APP $D $FX; mkdir -p $APP $D $FX
echo normal > $FX/mode; touch $FX/log-logins $FX/log-logouts
# Not a loopback address: Next.js would rename 127.x in the console URL (as vnc-proxy-test.sh).
CONSOLE_IP=$(hostname -I | awk '{print $1}')
echo "$CONSOLE_IP" > $FX/console-host
FAKE_LISTEN=0.0.0.0 $NODE $W/fake-xapi.js $XPORT $FX >> /var/tmp/sh-fake.log 2>&1 & FPID=$!
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js
cp $REPO/{server.js,vnc-proxy.js} $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
start_xenman() {
  [ -n "${P:-}" ] && kill $P 2>/dev/null && sleep 1
  cd $APP
  PORT=$PORT HTTPS_PORT=0 DATA_DIR=$D NODE_ENV=production $NODE server.js >> /var/tmp/sh-server.log 2>&1 & P=$!
  cd /
  for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done
}
start_xenman
trap 'kill $P $FPID 2>/dev/null' EXIT

# signin <user> <password>: a fresh cookie jar /var/tmp/sh-<user>.
signin() { rm -f /var/tmp/sh-$1; curl -s -c /var/tmp/sh-$1 -X POST $B/api/auth/login $J -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null; }
# connect <user>: "<handle> <the XAPI session behind it, from the fake's log>".
connect() {
  local n; n=$(grep -c '^login ' $FX/calls.log 2>/dev/null || echo 0)
  code -b /var/tmp/sh-$1 -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
  echo "$(field d.sessionRef < $BODY) $(grep '^login ' $FX/calls.log | sed -n "$((n+1))p" | awk '{print $2}')"
}
xen() { code -b /var/tmp/sh-$1 -X POST $B/api/xen $J -d "{\"action\":\"$2\",\"sessionRef\":\"$3\"${4:+,$4}}"; }
loggedout() { sleep 1; grep -c "^logout $1\$" $FX/calls.log; }
leaks() { grep -c 'OpaqueRef:session-' $BODY; }

signin admin admin
curl -s -b /var/tmp/sh-admin -c /var/tmp/sh-admin -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
signin admin Cobalt-Test-4242
code -b /var/tmp/sh-admin -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
for u in op1 op2; do
  code -b /var/tmp/sh-admin -X POST $B/api/auth/users $J -d "{\"username\":\"$u\",\"password\":\"Pass-12345-xm\",\"role\":\"operator\"}" >/dev/null
  code -b /var/tmp/sh-admin -X PUT $B/api/auth/users/$u $J -d '{"pools":["pool1"]}' >/dev/null
done

echo "=== The browser gets a handle, never the session ==="
read S R < <(connect admin)
check "connect: a handle" "true" "$([[ "$S" == xs_* && ${#S} -gt 20 ]] && echo true || echo "$S")"
check "  the session behind it is the pool's" "true" "$([[ "$R" == OpaqueRef:session-* ]] && echo true || echo "$R")"
code -b /var/tmp/sh-admin -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
check "  nowhere in connect's answer" 0 "$(leaks)"
check "the handle works" "200 0" "$(xen admin refresh "$S") $(leaks)"
check "  a VM console handed out on it" "200 0" "$(xen admin vm_console "$S" '"vmRef":"OpaqueRef:vm-1"') $(leaks)"
check "  the update list" "200 0" "$(code -b /var/tmp/sh-admin "$B/api/xen-updates?hostId=pool1&fresh=1") $(leaks)"
check "  the events" "200 0" "$(code -b /var/tmp/sh-admin "$B/api/events?hostId=pool1") $(leaks)"
check "the pool's session itself, sent to XenMan: refused" 401 "$(xen admin refresh "$R")"
signin op1 Pass-12345-xm
check "another user's handle: refused" 403 "$(xen op1 refresh "$S")"

echo "=== The console: the handle in the browser, the session at the host ==="
CURL_ENC=$($NODE -pe "encodeURIComponent('http://$CONSOLE_IP:$XPORT/console?ref=OpaqueRef:c1')")
TOKEN=$(grep xenman-auth /var/tmp/sh-admin | awk '{print $7}')
check "the console with the handle" "data RFB 003.008" \
  "$($NODE $W/vnc-client.js "ws://127.0.0.1:$PORT/api/vnc-proxy?consoleUrl=$CURL_ENC&sessionId=$S&useSsl=false" $TOKEN)"
check "  the host was asked with the pool's session" "console session $R" "$(grep '^console session ' $FX/calls.log | tail -1)"
check "  the pool's session in the browser's place: refused" true \
  "$(r=$($NODE $W/vnc-client.js "ws://127.0.0.1:$PORT/api/vnc-proxy?consoleUrl=$CURL_ENC&sessionId=$R&useSsl=false" $TOKEN); [[ "$r" == *403* ]] && echo true || echo "$r")"

echo "=== The VM import ==="
check "with the pool's session: refused" 401 "$(code -b /var/tmp/sh-admin -X POST "$B/api/xen/import?sessionRef=$R&srRef=OpaqueRef:sr-1" -H 'Content-Type: application/octet-stream' --data-binary x)"
check "with the handle: past the session check" 400 "$(code -b /var/tmp/sh-admin -X POST "$B/api/xen/import?sessionRef=$S&srRef=bad" -H 'Content-Type: application/octet-stream' --data-binary x)"

echo "=== A binding that ends, ends the session at the pool ==="
read OS OR < <(connect op1)
curl -s -b /var/tmp/sh-op1 -X POST $B/api/auth/logout >/dev/null
check "signing out" 1 "$(loggedout "$OR")"
check "  the handle is dead" 401 "$(xen admin refresh "$OS")"
signin op1 Pass-12345-xm; read OS OR < <(connect op1)
code -b /var/tmp/sh-admin -X PUT $B/api/auth/users/op1 $J -d '{"signOut":true}' >/dev/null
check "sign-out everywhere" 1 "$(loggedout "$OR")"
signin op1 Pass-12345-xm; read OS OR < <(connect op1)
code -b /var/tmp/sh-admin -X PUT $B/api/auth/users/op1 $J -d '{"pools":[]}' >/dev/null
check "the pool taken away (the handle gone with it)" "1 401" "$(loggedout "$OR") $(xen op1 refresh "$OS")"
signin op2 Pass-12345-xm; read PS PR < <(connect op2)
code -b /var/tmp/sh-admin -X DELETE $B/api/auth/users/op2 >/dev/null
check "the account removed" 1 "$(loggedout "$PR")"
read DS DR < <(connect admin)
check "disconnect: once, not twice" "200 1" "$(xen admin disconnect "$DS") $(loggedout "$DR")"
check "  the admin's other session untouched" 0 "$(loggedout "$R")"

echo "=== After a restart of XenMan ==="
start_xenman
check "an old handle: expired, the browser connects again" 401 "$(xen admin refresh "$S")"
read S2 R2 < <(connect admin)
check "  connecting again: a new handle" "true" "$([[ "$S2" == xs_* && "$S2" != "$S" ]] && echo true || echo "$S2")"

echo; echo "$pass passed, $fail failed"
exit $fail
