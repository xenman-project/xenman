#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The console proxy (vnc-proxy.js) between a client speaking RFB like noVNC
# and the fake host's qemu-like RFB server: update requests sent ahead for a
# long round trip, never inside a message of the browser's, nothing piled up
# for a browser that stopped reading, pings for a NetScaler's idle timeout.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
SRC=$BUILD
APP=/var/tmp/vp-app; D=/var/tmp/vp-data; FX=/var/tmp/vp-fake
PORT=3170; XPORT=4490
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
W=$TESTS
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/vp-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf $APP $D $FX; mkdir -p $APP $D $FX
echo normal > $FX/mode
# Next.js turns any 127.x.x.x in a URL into "localhost" -- query included --
# so the console's address must not be a loopback one: the viewer list would
# look under another name.
CONSOLE_IP=$(hostname -I | awk '{print $1}')
echo "$CONSOLE_IP" > $FX/console-host
FAKE_LISTEN=0.0.0.0 $NODE $W/fake-xapi.js $XPORT $FX >> /var/tmp/vp-fake.log 2>&1 & FPID=$!
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js
cp $REPO/server.js $REPO/vnc-proxy.js $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
start_xenman() { # start_xenman <pump ms> <ping ms>
  [ -n "${P:-}" ] && kill $P 2>/dev/null && sleep 1
  cd $APP
  PORT=$PORT HTTPS_PORT=0 DATA_DIR=$D NODE_ENV=production XENMAN_VNC_PUMP_MS=$1 XENMAN_VNC_PING_MS=$2 XENMAN_CONSOLE_RECHECK_MS=1000 \
    $NODE server.js >> /var/tmp/vp-server.log 2>&1 & P=$!
  cd /
  for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done
  # The pool's sessions live in XenMan's memory: a new one after each start.
  code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
  S=$(field d.sessionRef < $BODY)
  grant
}
# The proxy only connects to a console XenMan handed out on the session.
grant() { code $A -X POST $B/api/xen $J -d "{\"action\":\"vm_console\",\"sessionRef\":\"$S\",\"vmRef\":\"OpaqueRef:vm-1\"}" >/dev/null; }
trap 'kill $P $FPID 2>/dev/null' EXIT

C=/var/tmp/vp-cookie; A="-b $C"
start_xenman 33 300
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
TOKEN=$(grep xenman-auth $C | awk '{print $7}')
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
grant
CURL_ENC=$($NODE -pe "encodeURIComponent('http://$CONSOLE_IP:$XPORT/console?ref=OpaqueRef:c1')")
ws() { echo "ws://127.0.0.1:$PORT/api/vnc-proxy?consoleUrl=$CURL_ENC&sessionId=$S&useSsl=false"; }
client() { $NODE $W/vnc-rfb-client.js "$(ws)" $TOKEN "$@"; }
R=$FX/rfb.log
viewers() { code $A "$B/api/console/viewers?consoleUrl=$CURL_ENC"; }

echo "=== a long round trip (100 ms per picture) ==="
: > $R
WITH=$(client rate 3 100 | awk '{print $2}')
check "the handshake reached the host untouched" "version RFB 003.008" "$(head -1 $R)"
check "  extended mouse buttons not offered, the rest as sent" "encodings 0,1,7,-223" "$(grep encodings $R)"
check "  the browser's first request first" "request 0" "$(sed -n 3p $R)"
check "pictures with requests sent ahead: well over one per round trip (got $WITH)" true "$([ "${WITH:-0}" -gt 55 ] && echo true || echo false)"
check "  nothing misread by the host" 0 "$(grep -c 'unknown\|garbage' $R)"

echo "=== what the connection info shows ==="
stats() { code $A "$B/api/console/stats?id=$1"; }
SID=stats-$RANDOM-abcdef
$NODE $W/vnc-rfb-client.js "$(ws)&statsId=$SID" $TOKEN rate 4 100 > /dev/null &
CPID=$!
sleep 3
stats $SID > /dev/null
check "requests ahead on, the RFB version" "on RFB 003.008" "$(field 'd.ahead+" "+d.rfb' < $BODY)"
check "  the host's answer and the round trip to the browser measured" "true true" "$(field '(d.hostMs>=0&&d.hostMs<100)+" "+(d.netMs>=0&&d.netMs<100)' < $BODY)"
check "  requests ahead counted" true "$(field 'd.aheadRequests>20&&d.browserRequests>5' < $BODY)"
check "  the longest round trip and what waited for the browser" "true true" "$(field '(d.netMaxMs>=d.netMs)+" "+(Number.isInteger(d.queuedKB)&&d.queuedKB>=0)' < $BODY)"
wait $CPID
check "gone with the connection" 404 "$(stats $SID)"
check "an id nobody has" 404 "$(stats nobody-has-this-id)"
SID=stats-$RANDOM-garbage
$NODE $W/vnc-rfb-client.js "$(ws)&statsId=$SID" $TOKEN garbage > /dev/null &
CPID=$!
for _ in $(seq 30); do stats $SID > /dev/null; [ "$(field 'd.ahead' < $BODY)" = "off: unknown message type 99" ] && break; sleep 0.1; done
check "an unknown message: off, and why" "off: unknown message type 99" "$(field 'd.ahead' < $BODY)"
wait $CPID

echo "=== Remote Desktop ==="
gm() { code $A -X POST $B/api/xen $J -d "{\"action\":\"vm_guest_metrics\",\"sessionRef\":\"$S\",\"vmRef\":\"$1\"}" > /dev/null; }
gm OpaqueRef:vm-1
check "the VM tools' address and Remote Desktop on" "10.0.0.101 true" "$(field 'd.ipAddresses.join()+" "+d.rdpEnabled' < $BODY)"
touch $FX/rdp-off; gm OpaqueRef:vm-1; rm -f $FX/rdp-off
check "  switched off in the VM: said" false "$(field 'd.rdpEnabled' < $BODY)"
gm OpaqueRef:vm-3
check "a VM that is off: nothing to connect to" "0 null" "$(field 'd.ipAddresses.length+" "+d.rdpEnabled' < $BODY)"
RDP() { $NODE --experimental-strip-types --no-warnings -e "import('$REPO/src/lib/rdp-file.ts').then(m=>console.log(eval(process.argv[1])))" "$1" 2>/dev/null; }
check "IPv4 before IPv6" 10.0.0.5 "$(RDP 'm.rdpAddress(["fe80::1","10.0.0.5"])')"
check "the file: the address, credentials asked by the client" "full address:s:10.0.0.5|prompt for credentials:i:1" "$(RDP 'm.rdpFileText("10.0.0.5")' | tr -d '\r' | head -2 | tr '\n' '|' | sed 's/|$//')"
check "  an IPv6 address in brackets" "full address:s:[2001:db8::5]" "$(RDP 'm.rdpFileText("2001:db8::5")' | tr -d '\r' | head -1)"

echo "=== clipboard text in pieces, while requests go ahead ==="
: > $R
OUT=$(client cut 300000)
check "arrived whole and unchanged" "cut 300000 ${OUT#md5 }" "$(grep '^cut' $R)"
check "  no request put inside it" 0 "$(grep -c 'unknown\|garbage' $R)"
check "  requests went ahead meanwhile" true "$([ "$(grep -c 'request 1' $R)" -gt 20 ] && echo true || echo false)"

echo "=== a message XenMan does not know ==="
: > $R
check "passed on" "sent 8" "$(client garbage)"
check "  as it was, and nothing added after it" "unknown 99|garbage 8" "$(grep -E 'unknown|garbage' $R | tail -2 | tr '\n' '|' | sed 's/|$//')"

echo "=== keepalive ==="
client ping 3 > /var/tmp/vp-ping.out &
CPID=$!
for _ in $(seq 30); do [ "$(viewers)" = 200 ] && break; sleep 0.1; done
check "a console answering pings: kept, listed as viewer" 200 "$(viewers)"
wait $CPID
check "  pinged" true "$(n=$(awk '{print $2}' /var/tmp/vp-ping.out); [ "${n:-0}" -ge 6 ] && echo true || echo false)"
: > $R
client deaf 3 > /dev/null
check "a browser gone silent: closed, and the host's connection with it" 1 "$(grep -c '^closed' $R)"
check "  no longer listed" 403 "$(viewers)"

echo "=== a browser that stops reading ==="
start_xenman 33 0
touch $FX/vnc-big; : > $R
client stall 4 > /dev/null
sleep 0.5
WRITTEN=$(sed -n 's/^closed pictures=[0-9]* written=\([0-9]*\)/\1/p' $R | tail -1)
# Unchecked, 30 one-MB pictures a second would go out: 120 MB in 4 s.
check "the host was not asked for more than the browser took (wrote $((${WRITTEN:-0} / 1048576)) MB)" true "$([ "${WRITTEN:-999999999}" -lt $((24 * 1048576)) ] && echo true || echo false)"
rm -f $FX/vnc-big

echo "=== without requests ahead (XENMAN_VNC_PUMP_MS=0): as before ==="
start_xenman 0 0
: > $R
WITHOUT=$(client rate 3 100 | awk '{print $2}')
check "one picture per round trip at most (got $WITHOUT)" true "$([ "${WITHOUT:-99}" -le 30 ] && echo true || echo false)"
check "  requests ahead gave more than twice as many ($WITH vs $WITHOUT)" true "$([ "${WITH:-0}" -gt $((2 * ${WITHOUT:-99})) ] && echo true || echo false)"
check "  extended mouse buttons still not offered" "encodings 0,1,7,-223" "$(grep encodings $R)"

echo "=== a login XenServer refuses: why, said ==="
pool_user() { code $A -X POST $B/api/hosts $J -d "{\"action\":\"update\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"$1\",\"password\":\"\",\"useSsl\":false}}" > /dev/null; }
pool_user 'CORP\\svc-xenman'
check "a domain user: XenServer's reason and what the pool needs" "500 true true" "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}') $(field 'd.error.includes("did not accept the login of \"CORP\\svc-xenman\": bad.")' < $BODY) $(field 'd.error.includes("pool-admin role")' < $BODY)"
pool_user svc-xenman
check "  a bare name: how a domain user is written" true "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' > /dev/null; field 'd.error.includes("DOMAIN\\user or user@domain")' < $BODY)"
pool_user root
check "  back to root, the password kept" 200 "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}')"

echo "=== Review 2026-11: who may keep a console ==="
# signin <user> <password> <role>: an account with pool1, signed in; prints its cookie value.
signin() {
  curl -s $A -X POST $B/api/auth/users $J -d "{\"username\":\"$1\",\"password\":\"$2\",\"role\":\"$3\"}" >/dev/null
  curl -s $A -X PUT $B/api/auth/users/$1 $J -d '{"pools":["pool1"]}' >/dev/null
  curl -s -c /var/tmp/vp-$1 -X POST $B/api/auth/login $J -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
  grep xenman-auth /var/tmp/vp-$1 | awk '{print $7}'
}
# session <user> <console action> <ref>: connects as that user and has a console handed out; prints the session.
session() {
  local s; s=$(code -b /var/tmp/vp-$1 -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; field d.sessionRef < $BODY)
  code -b /var/tmp/vp-$1 -X POST $B/api/xen $J -d "{\"action\":\"$2\",\"sessionRef\":\"$s\",\"vmRef\":\"$3\",\"hostRef\":\"$3\"}" >/dev/null
  echo "$s"
}
wsfor() { echo "ws://127.0.0.1:$PORT/api/vnc-proxy?consoleUrl=$CURL_ENC&sessionId=$1&useSsl=false"; }
OT=$(signin op1 Pass-12345-xm operator); OS=$(session op1 vm_console OpaqueRef:vm-1)
check "an operator's VM console" "data RFB 003.008" "$($NODE $W/vnc-client.js "$(wsfor $OS)" $OT)"
$NODE $W/vnc-rfb-client.js "$(wsfor $OS)" $OT rate 20 100 > $FX/op-open.log 2>&1 & OPID=$!
sleep 2
curl -s -b /var/tmp/vp-op1 -X POST $B/api/auth/logout >/dev/null
for _ in $(seq 10); do kill -0 $OPID 2>/dev/null || break; sleep 0.5; done
check "  signed out: the open console is closed" "close 1008 Signed out" "$(tail -1 $FX/op-open.log)"
OT=$(curl -s -c /var/tmp/vp-op1 -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Pass-12345-xm"}' >/dev/null; grep xenman-auth /var/tmp/vp-op1 | awk '{print $7}')
OS=$(session op1 vm_console OpaqueRef:vm-1)
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"pools":[]}' >/dev/null
check "  the pool taken away: no new console on the session from before" true \
  "$(r=$($NODE $W/vnc-client.js "$(wsfor $OS)" $OT); [[ "$r" == *403* ]] && echo true || echo "$r")"
AT2=$(signin adm2 Pass-12345-xm admin); AS2=$(session adm2 host_console OpaqueRef:host-1)
check "an administrator's host console" "data RFB 003.008" "$($NODE $W/vnc-client.js "$(wsfor $AS2)" $AT2)"
$NODE $W/vnc-rfb-client.js "$(wsfor $AS2)" $AT2 rate 20 100 > $FX/adm-open.log 2>&1 & APID=$!
sleep 2
curl -s $A -X PUT $B/api/auth/users/adm2 $J -d '{"role":"operator"}' >/dev/null
for _ in $(seq 10); do kill -0 $APID 2>/dev/null || break; sleep 0.5; done
check "  made an operator: the open host console is closed" "close 1008 Not allowed" "$(tail -1 $FX/adm-open.log)"
check "  and the host console cannot be opened again on that session" true \
  "$(r=$($NODE $W/vnc-client.js "$(wsfor $AS2)" $AT2); [[ "$r" == *403* ]] && echo true || echo "$r")"

echo; echo "$pass passed, $fail failed"
exit $fail
