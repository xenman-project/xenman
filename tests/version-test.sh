#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# /api/version: only for signed-in users, and the build's commit inlined into
# the page bundle rather than looked up at run time.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
B=http://127.0.0.1:3119; C=/var/tmp/ver-c; J='-H Content-Type:application/json'
cd "$BUILD"
D=/var/tmp/ver-data; rm -rf $D; mkdir -p $D
DATA_DIR=$D NEXT_TELEMETRY_DISABLED=1 npx next start -p 3119 > /var/tmp/ver.log 2>&1 & PID=$!
trap 'kill $PID 2>/dev/null; pkill -f "next start -p 3119"' EXIT
for _ in $(seq 40); do curl -s -o /dev/null $B/login && break; sleep 1; done

check "without login: refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/version)"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
check "signed in: the version" string "$(curl -s -b $C $B/api/version | "$NODE_BIN" -pe 'typeof JSON.parse(require("fs").readFileSync(0)).version' 2>/dev/null)"
chunk=$(grep -rl '/api/version' .next/static/chunks | head -1)
check "the commit inlined into the page bundle, not read at run time" 0 "$(grep -c 'NEXT_PUBLIC_GIT_COMMIT' "$chunk")"

echo; echo "$pass passed, $fail failed"
exit $fail
