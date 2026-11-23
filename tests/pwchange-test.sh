#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# First start: admin/admin has to be changed before anything else.
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
cd $BUILD
D=/var/tmp/pwc-data; PORT=3121; B="http://127.0.0.1:$PORT"; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
st() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
J='-H Content-Type:application/json'
start() { DATA_DIR=$D NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT > /var/tmp/pwc.log 2>&1 & PID=$!; for _ in $(seq 40); do curl -s -o /dev/null $B/login && break; sleep 1; done; }
login() { curl -s -c $3 -X POST $B/api/auth/login $J -d "{\"username\":\"$1\",\"password\":\"$2\"}"; }
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }

echo "=== a fresh installation ==="
rm -rf $D; mkdir -p $D; start
check "admin/admin must change first" true "$(login admin admin /var/tmp/c1 | field d.mustChangePassword)"
check "  stored on the account" true "$(field 'd[0].mustChangePassword' < $D/users.json)"
check "pages lead to the change page" "307 /change-password" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b /var/tmp/c1 $B/ | sed 's#http://127.0.0.1:[0-9]*##')"
check "  the settings too" 307 "$(st -b /var/tmp/c1 $B/settings)"
check "the change page itself opens" 200 "$(st -b /var/tmp/c1 $B/change-password)"
check "APIs refused" "403 403 403" "$(st -b /var/tmp/c1 $B/api/hosts) $(st -b /var/tmp/c1 -X POST $B/api/xen $J -d '{}') $(st -b /var/tmp/c1 $B/api/auth/users)"
check "  also the update upload the proxy does not see" 403 "$(st -b /var/tmp/c1 $B/api/update)"
check "who am I still answers" 200 "$(st -b /var/tmp/c1 $B/api/auth/me)"
check "weak password refused" 400 "$(st -b /var/tmp/c1 -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"abc"}')"
check "wrong current password refused" 400 "$(st -b /var/tmp/c1 -X POST $B/api/auth/change-password $J -d '{"currentPassword":"nope","newPassword":"Cedar-Bark-1234"}')"
check "changed" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b /var/tmp/c1 -c /var/tmp/c1 -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cedar-Bark-1234"}')"
check "  the same session now opens everything" "200 200" "$(st -b /var/tmp/c1 $B/) $(st -b /var/tmp/c1 $B/api/hosts)"
check "  flag gone from the account" undefined "$(field 'd[0].mustChangePassword' < $D/users.json)"
check "  the old password no longer works" 401 "$(st -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}')"
check "  the new one logs in without restriction" false "$(login admin Cedar-Bark-1234 /var/tmp/c2 | field d.mustChangePassword)"
check "  audited" true "$(grep -q 'Default password replaced' $D/audit.jsonl && echo true)"
check "a normal user is not held up" "false 200" "$(curl -s -b /var/tmp/c2 -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Maple-Root-0001","role":"operator"}' >/dev/null; login op1 Maple-Root-0001 /var/tmp/c3 | field d.mustChangePassword) $(st -b /var/tmp/c3 $B/)"
kill $PID; sleep 1

echo "=== an installation from before, still on admin/admin ==="
rm -rf $D; mkdir -p $D
HASH=$(cd $BUILD && "$NODE" -e 'console.log(require("bcryptjs").hashSync("admin",10))')
echo "[{\"username\":\"admin\",\"passwordHash\":\"$HASH\",\"createdAt\":\"2026-01-01T00:00:00Z\",\"role\":\"admin\"}]" > $D/users.json
start
check "no flag on disk, still has to change" "true 307" "$(login admin admin /var/tmp/c4 | field d.mustChangePassword) $(st -b /var/tmp/c4 $B/)"
kill $PID
echo; echo "$pass passed, $fail failed"; exit $fail
