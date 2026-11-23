#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# A pool behind NAT (issue #3): its hosts report addresses XenMan cannot reach
# (10.0.0.11, 10.0.0.12); the pool's NAT setting says where each is reached.
# Off, consoles and graphs go to the reported address, as before; on, to the
# one set. XenMan runs from server.js, for the console proxy.
set -u
export no_proxy='*' NO_PROXY='*'
SRC=$BUILD
APP=/var/tmp/nat-app; D=/var/tmp/nat-data; FX=/var/tmp/nat-fake
PORT=3181; XPORT=4477
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
W=$TESTS
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/nat-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }
calls() { grep -c "$1" "$FX/calls.log"; }

rm -rf $APP $D $FX; mkdir -p $APP $D $FX
echo normal > $FX/mode; touch $FX/nat-addresses; echo 10.0.0.11 > $FX/console-host
"$NODE" $W/fake-xapi.js $XPORT $FX >> /var/tmp/nat-fake.log 2>&1 & FPID=$!
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js
cp $REPO/server.js $REPO/vnc-proxy.js $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
cd $APP
PORT=$PORT HTTPS_PORT=0 DATA_DIR=$D NODE_ENV=production XENMAN_RRD_CACHE_MS=1 $NODE server.js >> /var/tmp/nat-server.log 2>&1 & P=$!
cd /
trap 'kill $P $FPID 2>/dev/null' EXIT
for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done
C=/var/tmp/nat-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
TOKEN=$(grep xenman-auth $C | awk '{print $7}')
POOL="\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"useSsl\":false"
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{$POOL,\"password\":\"secret\"}}" >/dev/null
connect() { code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; S=$(field d.sessionRef < $BODY); }
xen() { code $A -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"$S\"${2:+,$2}}"; }
enc() { "$NODE" -pe "encodeURIComponent(process.argv[1])" "$1"; }
wsurl() { echo "ws://127.0.0.1:$PORT/api/vnc-proxy?sessionId=$S&consoleUrl=$(enc "$1")"; }
update() { code $A -X POST $B/api/hosts $J -d "{\"action\":\"update\",\"host\":{$POOL,\"password\":\"\",\"nat\":$1}}"; }
connect

echo "=== NAT off: as before, at the address XenServer reports ==="
check "the console's address as reported" "http://10.0.0.11:$XPORT/console?ref=OpaqueRef:c1" "$(xen vm_console '"vmRef":"OpaqueRef:vm-1"' >/dev/null; field d.url < $BODY)"
check "  nothing shown to the browser" false "$(code $A $B/api/hosts >/dev/null; field 'Boolean(d[0].nat)' < $BODY)"

echo "=== the setting ==="
check "the pool's hosts, the coordinator first" "xs-01 10.0.0.11 true|xs-02 10.0.0.12 false" "$(code $A -X POST $B/api/hosts $J -d '{"action":"members","hostId":"pool1"}' >/dev/null; field 'd.members.map(m=>m.name+" "+m.address+" "+m.coordinator).join("|")' < $BODY)"
check "  of an unknown pool: 404" 404 "$(code $A -X POST $B/api/hosts $J -d '{"action":"members","hostId":"nope"}')"
check "not an address: refused" 400 "$(update '{"enabled":true,"hosts":{"10.0.0.11":"127.0.0.1; rm -rf /"}}')"
check "  nor a list instead of the hosts" 400 "$(update '{"enabled":true,"hosts":["127.0.0.1"]}')"
check "saved" 200 "$(update '{"enabled":true,"hosts":{"10.0.0.11":"127.0.0.1","10.0.0.12":"localhost","10.0.0.13":"  "}}')"
check "  as set, empty entries dropped" 'true {"10.0.0.11":"127.0.0.1","10.0.0.12":"localhost"}' "$(code $A $B/api/hosts >/dev/null; field 'd[0].nat.enabled+" "+JSON.stringify(d[0].nat.hosts)' < $BODY)"
check "  the stored password kept" 200 "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}')"
check "  audited, with the addresses" true "$(grep '"action":"host_updated"' $D/audit.jsonl | tail -1 | grep -q 'NAT: off → on (10.0.0.11 at 127.0.0.1, 10.0.0.12 at localhost)' && echo true || echo false)"
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op4","password":"Maple-Root-2468","role":"operator"}' >/dev/null
curl -s -c /var/tmp/nat-op -X POST $B/api/auth/login $J -d '{"username":"op4","password":"Maple-Root-2468"}' >/dev/null
check "an operator may neither read the hosts nor set it" "403 403" "$(code -b /var/tmp/nat-op -X POST $B/api/hosts $J -d '{"action":"members","hostId":"pool1"}') $(code -b /var/tmp/nat-op -X POST $B/api/hosts $J -d "{\"action\":\"update\",\"host\":{$POOL}}")"

echo "=== NAT on: consoles ==="
connect
check "the console at the address the host is reached at" "http://127.0.0.1:$XPORT/console?ref=OpaqueRef:c1" "$(xen vm_console '"vmRef":"OpaqueRef:vm-1"' >/dev/null; field d.url < $BODY)"
CURL=$(field d.url < $BODY)
check "  the proxy connects there" "data RFB 003.008" "$("$NODE" $W/vnc-client.js "$(wsurl "$CURL")" "$TOKEN")"
check "  the fake was reached" 1 "$(calls CONNECT)"
check "  the reported address itself is not handed out any more" "close 1008 Unknown console" "$("$NODE" $W/vnc-client.js "$(wsurl "http://10.0.0.11:$XPORT/console?ref=OpaqueRef:c1")" "$TOKEN")"
check "the host console too" "http://127.0.0.1:$XPORT" "$(xen host_console '"hostRef":"OpaqueRef:host-1"' >/dev/null; field 'd.url.split("/console")[0]' < $BODY)"

echo "=== NAT on: performance graphs ==="
check "a host's graphs" 200 "$(xen rrd '"hostRef":"OpaqueRef:host-1","period":"10m"')"
check "  asked of xs-01 where it is reached" 1 "$(calls 'GET /rrd_updates xs-01 host=true interval=5')"
check "the other host's" 200 "$(xen rrd '"hostRef":"OpaqueRef:host-2","period":"10m"')"
check "  asked of xs-02 where it is reached" 1 "$(calls 'GET /rrd_updates xs-02 host=true interval=5')"
check "a VM's, from the host it runs on" "200 2" "$(xen rrd '"vmRef":"OpaqueRef:vm-1","period":"10m"') $(calls 'GET /rrd_updates xs-01 host=true interval=5')"
check "the pool's, each host where it is reached" "200 3 2" "$(xen rrd '"pool":true,"period":"10m"') $(calls 'GET /rrd_updates xs-01 host=true interval=5') $(calls 'GET /rrd_updates xs-02 host=true interval=5')"

echo "=== one address, a port per host ==="
# The firewall's port forwarding: XPORT2 to the fake, each connection logged.
FWD=$FX/forwarded.log; XPORT2=$((XPORT + 1))
"$NODE" -e 'const net=require("net"),fs=require("fs");net.createServer(c=>{fs.appendFileSync(process.argv[2],"conn\n");const u=net.connect(+process.argv[3],"127.0.0.1");c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());}).listen(+process.argv[1],"127.0.0.1")' $XPORT2 $FWD $XPORT & FWPID=$!
trap 'kill $P $FPID $FWPID 2>/dev/null' EXIT
sleep 0.5
check "not a port: refused" 400 "$(update '{"enabled":true,"hosts":{"10.0.0.12":"localhost:99999"}}')"
check "saved, with ports" 200 "$(update "{\"enabled\":true,\"hosts\":{\"10.0.0.11\":\"127.0.0.1:$XPORT2\",\"10.0.0.12\":\"localhost:$XPORT2\"}}")"
connect
: > $FWD
check "the console at that address and port" "http://127.0.0.1:$XPORT2/console?ref=OpaqueRef:c1" "$(xen vm_console '"vmRef":"OpaqueRef:vm-1"' >/dev/null; field d.url < $BODY)"
CURL=$(field d.url < $BODY)
check "  the proxy goes through the forwarded port" "data RFB 003.008 true" "$("$NODE" $W/vnc-client.js "$(wsurl "$CURL")" "$TOKEN") $([ -s $FWD ] && echo true || echo false)"
: > $FWD
N2=$(calls 'GET /rrd_updates xs-02 host=true interval=5')
check "a member's graphs through its port" "200 $((N2 + 1)) true" "$(xen rrd '"hostRef":"OpaqueRef:host-2","period":"10m"') $(calls 'GET /rrd_updates xs-02 host=true interval=5') $([ -s $FWD ] && echo true || echo false)"

echo "=== set while adding a pool ==="
check "its hosts, read with the login typed" "xs-01 10.0.0.11 true|xs-02 10.0.0.12 false" "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"members\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"useSsl\":false,\"username\":\"root\",\"password\":\"secret\"}" >/dev/null; field 'd.members.map(m=>m.name+" "+m.address+" "+m.coordinator).join("|")' < $BODY)"
check "  a wrong password: refused" 400 "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"members\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"useSsl\":false,\"username\":\"root\",\"password\":\"wrong\"}")"
check "  over HTTPS only with a confirmed certificate" 400 "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"members\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\"}")"
check "  not for an operator" 403 "$(code -b /var/tmp/nat-op -X POST $B/api/hosts $J -d "{\"action\":\"members\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"useSsl\":false,\"username\":\"root\",\"password\":\"secret\"}")"
check "added with the setting" 200 "$(code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool2\",\"name\":\"Second\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false,\"nat\":{\"enabled\":true,\"hosts\":{\"10.0.0.11\":\"127.0.0.1\"}}}}")"
check "  stored, and audited" 'true {"10.0.0.11":"127.0.0.1"} true' "$(code $A $B/api/hosts >/dev/null; field 'const h=d.find(x=>x.id==="pool2"); h.nat.enabled+" "+JSON.stringify(h.nat.hosts)' < $BODY) $(grep '"action":"host_added"' $D/audit.jsonl | tail -1 | grep -q 'NAT on (10.0.0.11 at 127.0.0.1)' && echo true || echo false)"

echo "=== switched off again ==="
check "saved" 200 "$(update '{"enabled":false,"hosts":{"10.0.0.11":"127.0.0.1"}}')"
connect
check "the console as reported again, the addresses kept for later" "http://10.0.0.11:$XPORT/console?ref=OpaqueRef:c1 127.0.0.1" "$(xen vm_console '"vmRef":"OpaqueRef:vm-1"' >/dev/null; field d.url < $BODY) $(code $A $B/api/hosts >/dev/null; field 'd[0].nat.hosts["10.0.0.11"]' < $BODY)"

echo; echo "$pass passed, $fail failed"
exit $fail
