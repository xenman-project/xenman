#!/bin/bash
# run-suites.sh [name...]: runs test suites -- by default those listed in
# ci-suites.txt -- shows only failures and totals, and exits non-zero when one
# failed. SHARD=i/n runs every n-th suite of the list from the i-th (CI
# splits the list this way). Full logs: $LOGS/<name>.log.
#
# Servers of an earlier suite are stopped first: "kill" in a suite reaches only
# the npx wrapper, and a next-server left behind would answer with old code.
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LOGS=${LOGS:-/var/tmp/xenman-suites}; mkdir -p "$LOGS"
[ $# -gt 0 ] || set -- $(grep -v '^\s*#' "$TESTS/ci-suites.txt")
if [ -n "${SHARD:-}" ]; then
  i=${SHARD%/*}; n=${SHARD#*/}; k=0; picked=()
  for t in "$@"; do k=$((k+1)); [ $(( (k-1) % n + 1 )) -eq "$i" ] && picked+=("$t"); done
  set -- "${picked[@]}"
fi
stop() { pkill -f next-server 2>/dev/null; pkill -f "next start" 2>/dev/null; pkill -f fake-xapi.js 2>/dev/null; sleep 1; }
bad=()
for t in "$@"; do
  stop
  echo "### $t"
  timeout 1500 bash "$TESTS/$t-test.sh" > "$LOGS/$t.log" 2>&1; rc=$?
  grep -E "FAIL|passed|failed" "$LOGS/$t.log" | tail -40
  [ $rc -eq 0 ] || bad+=("$t (exit $rc)")
done
stop
if [ ${#bad[@]} -gt 0 ]; then echo; echo "failed: ${bad[*]}"; exit 1; fi
echo; echo "all $# suites passed"
