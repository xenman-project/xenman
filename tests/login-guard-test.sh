#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# The login throttle, against server.js in the appliance layout: only there is
# the client address the connection's own, not a header the client sends.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
SRC=$BUILD
APP=/var/tmp/lg-app; D=/var/tmp/lg-data
PORT=3150; B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
rm -rf $APP $D; mkdir -p $APP $D
cp -r $SRC/.next/standalone/. $APP/; cp -r $SRC/.next/static $APP/.next/static; cp -r $SRC/public $APP/public
mv $APP/server.js $APP/standalone-server.js
# server.js from the repo itself: the build copy only receives src/.
cp $REPO/server.js $REPO/vnc-proxy.js $APP/
mkdir -p $APP/node_modules; cp -r $SRC/node_modules/ws $APP/node_modules/ws
cd $APP
PORT=$PORT HTTPS_PORT=0 DATA_DIR=$D NODE_ENV=production \
  XENMAN_LOGIN_PAIR_BLOCK_MS=3000 XENMAN_LOGIN_IP_LIMIT=14 XENMAN_LOGIN_IP_BLOCK_MS=3000 \
  $NODE server.js > /var/tmp/lg-server.log 2>&1 & P=$!
trap 'kill $P 2>/dev/null' EXIT
for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done

login() { curl -s -o /var/tmp/lg-body -w '%{http_code}' -X POST $B/api/auth/login $J ${3:+-H "X-Forwarded-For: $3"} -d "{\"username\":\"$1\",\"password\":\"$2\"}"; }
audit() { $NODE -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval(process.argv[2]))' $D/audit.jsonl "$1"; }

# Set up: admin with its own password, and a second account.
curl -s -c /var/tmp/lg-c -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b /var/tmp/lg-c -c /var/tmp/lg-c -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -b /var/tmp/lg-c -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Maple-Root-0001","role":"operator"}' >/dev/null

echo "=== the client address ==="
login admin Cobalt-Test-4242 9.9.9.9 >/dev/null
check "audit shows the connection's address, not a header sent along" 127.0.0.1 "$(audit 'l.filter(x=>x.action==="login"&&x.outcome==="success").pop().ip')"

echo "=== a user's password guessed ==="
r=""; for i in 1 2 3 4; do r="$r$(login admin wrong$i) "; done
check "four wrong: refused as wrong" "401 401 401 401 " "$r"
check "a right one in between resets the count" 200 "$(login admin Cobalt-Test-4242)"
r=""; for i in 1 2 3 4; do r="$r$(login admin wrong$i) "; done
check "four more wrong: still only refused" "401 401 401 401 " "$r"
check "the fifth: blocked" 429 "$(login admin wrong5)"
check "  says how long" true "$($NODE -pe 'JSON.parse(require("fs").readFileSync("/var/tmp/lg-body","utf8")).error.startsWith("Too many failed attempts. Try again in")')"
check "  the right password does not help" 429 "$(login admin Cobalt-Test-4242)"
check "  nor another address in a header" 429 "$(login admin Cobalt-Test-4242 10.1.2.3)"
check "  audited once, with the address" "1 127.0.0.1" "$(login admin wrong6 >/dev/null; audit 'l.filter(x=>x.action==="login_blocked").length+" "+l.filter(x=>x.action==="login_blocked")[0].ip')"
check "another user from the same address may log in" 200 "$(login op1 Maple-Root-0001)"
sleep 3.5
check "after the block: in again" 200 "$(login admin Cobalt-Test-4242)"

echo "=== an address trying many users ==="
r=""; for i in 1 2 3 4 5; do r="$r$(login nobody$i x) "; done
check "the address reaches its limit" "401 401 401 401 429 " "$r"
check "  then nobody gets in from it" 429 "$(login op1 Maple-Root-0001)"
check "  audited as the address" true "$(audit 'l.filter(x=>x.action==="login_blocked").pop().detail.includes("this address is blocked")')"
sleep 3.5
check "  free again afterwards" 200 "$(login op1 Maple-Root-0001)"

echo "=== forgot password ==="
r=""; for i in 1 2 3 4 5 6; do r="$r$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/auth/forgot-password $J -d '{"usernameOrEmail":"admin"}') "; done
check "five requests, then a pause" "200 200 200 200 200 429 " "$r"

echo; echo "$pass passed, $fail failed"; exit $fail
