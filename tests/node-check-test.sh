#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# appliance/check-node.sh against made-up release lists: up to date, a newer
# release without and with security fixes, nodejs.org out of reach, a broken
# list, and the real list from node-dist when it is there.
set -u
APPL=$REPO/appliance
export NODE=$NODE_BIN
W=/var/tmp/node-check-test
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
rm -rf "$W"; mkdir -p "$W/stub"
. "$APPL/node-version"
MAJOR=${NODE_VERSION%%.*}
next_patch() { echo "$NODE_VERSION" | awk -F. '{print $1"."$2"."$3+1}'; }
N1=$(next_patch)
list() { # list <json entries...>: a release list with the pinned one in it
  printf '[%s{"version":"v%s","security":false,"lts":"Krypton"}]' "$*" "$NODE_VERSION" > "$W/index.json"
}
run() { NODE_INDEX_FILE="$W/index.json" bash "$APPL/check-node.sh"; }

list ''
OUT=$(run); RC=$?
check "up to date: said so" "0 1" "$RC $(echo "$OUT" | grep -c "Node.js $NODE_VERSION: the newest $MAJOR.x")"

list "{\"version\":\"v$N1\",\"security\":false,\"lts\":\"Krypton\"},"
check "a newer release without security fixes: mentioned, no alarm" "1 0" "$(run | grep -c "Node.js $N1 is out (no security fixes over $NODE_VERSION)") $(run | grep -c '!!')"

list "{\"version\":\"v$N1\",\"security\":true,\"lts\":\"Krypton\"},"
OUT=$(run); RC=$?
check "a missed security release: loud, and what to do" "0 2" "$RC $(echo "$OUT" | grep -c '!!')"
check "  names the release" 1 "$(echo "$OUT" | grep -c "misses security releases: v$N1")"

list "{\"version\":\"v$((MAJOR + 2)).1.0\",\"security\":true,\"lts\":\"Next\"},"
OUT=$(run)
check "a newer major line: only mentioned, never an alarm" "1 0 1" "$(echo "$OUT" | grep -c "Node.js $((MAJOR + 2)) is an LTS line too") $(echo "$OUT" | grep -c '!!') $(echo "$OUT" | grep -c 'the newest')"

printf '#!/bin/sh\nexit 7\n' > "$W/stub/curl"; chmod +x "$W/stub/curl"
OUT=$(PATH="$W/stub:$PATH" bash "$APPL/check-node.sh"); RC=$?
check "nodejs.org out of reach: said, the build goes on" "0 1" "$RC $(echo "$OUT" | grep -c 'could not check for newer releases')"

echo "not json" > "$W/index.json"
OUT=$(run 2>/dev/null); RC=$?
check "a broken list: said, the build goes on" "0 1" "$RC $(echo "$OUT" | grep -c 'could not read the release list')"

REAL=$NODE_DIST/index.json
if [ -f "$REAL" ]; then
  echo "  (the real list, $(date -r "$REAL" +%F): $(NODE_INDEX_FILE="$REAL" bash "$APPL/check-node.sh" | tr -s ' ' | tr '\n' ' '))"
fi

echo; echo "$pass passed, $fail failed"
exit $fail
