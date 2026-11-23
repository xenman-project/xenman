#!/bin/bash
# run-suites.sh [name...]: runs test suites -- by default those listed in
# ci-suites.txt -- shows only failures and totals, and exits non-zero when one
# failed. SHARD=i/n runs every n-th suite of the list from the i-th (CI
# splits the list this way). Full logs: $LOGS/<name>.log.
#
# A suite marked "root" in ci-suites.txt runs as root (sudo, with the same
# environment) when the runner is not root already.
#
# Servers of an earlier suite are stopped first: "kill" in a suite reaches only
# the npx wrapper, and a next-server left behind would answer with old code.
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LOGS=${LOGS:-/var/tmp/xenman-suites}; mkdir -p "$LOGS"
list=$(grep -v '^\s*#' "$TESTS/ci-suites.txt" | grep .)
[ $# -gt 0 ] || set -- $(awk '{print $1}' <<< "$list")
if [ -n "${SHARD:-}" ]; then
  i=${SHARD%/*}; n=${SHARD#*/}; k=0; picked=()
  for t in "$@"; do k=$((k+1)); [ $(( (k-1) % n + 1 )) -eq "$i" ] && picked+=("$t"); done
  set -- "${picked[@]}"
fi
stop() {
  for p in next-server "next start" fake-xapi.js; do pkill -f "$p" 2>/dev/null; [ "$(id -u)" = 0 ] || sudo -n pkill -f "$p" 2>/dev/null; done
  sleep 1
}
bad=()
for t in "$@"; do
  stop
  echo "### $t"
  as=()
  if [ "$(id -u)" != 0 ] && awk -v t="$t" '$1 == t && $2 == "root" { f = 1 } END { exit !f }' <<< "$list"; then
    as=(sudo -n -E env "PATH=$PATH")
  fi
  timeout 1500 "${as[@]}" bash "$TESTS/$t-test.sh" > "$LOGS/$t.log" 2>&1; rc=$?
  grep -E "FAIL|passed|failed" "$LOGS/$t.log" | tail -40
  # What a root suite left in the build (Next.js caches) must stay writable.
  [ ${#as[@]} -eq 0 ] || sudo -n chown -R "$(id -u):$(id -g)" "$BUILD/.next" 2>/dev/null
  [ $rc -eq 0 ] || bad+=("$t (exit $rc)")
done
stop
if [ ${#bad[@]} -gt 0 ]; then echo; echo "failed: ${bad[*]}"; exit 1; fi
echo; echo "all $# suites passed"
