#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# xenman-os-update --scheduled: the policy decides whether a timer run installs.
set -u
APPL=$REPO/appliance
NODE=$NODE_BIN
W=/var/tmp/os-schedule-test
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1))
  else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi
}
json() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync('$W/data/updates/os-status.json','utf8')); $1" 2>/dev/null; }
ran() { [ -f "$W/uu-ran" ] && echo yes || echo no; }

reset() { # reset <policy-args...>
  rm -rf "$W"; mkdir -p "$W/stub" "$W/data/updates" "$W/run"
  printf 'install ok installed\topenssl\t3.5.1-1\n' > "$W/dpkg.db"
  cat > "$W/stub/unattended-upgrade" <<'EOS'
#!/bin/sh
touch "$UU_MARK"
sed -i 's/3.5.1-1$/3.5.1-1+deb13u1/' "$FAKE_DPKG"
EOS
  printf '#!/bin/sh\ncat "$FAKE_DPKG"\n' > "$W/stub/dpkg-query"
  printf '#!/bin/sh\necho "systemctl $*" >> "%s/systemctl.log"\n' "$W" > "$W/stub/systemctl"
  chmod +x "$W/stub/"*
  # an earlier real install, which a deferred run must not wipe from the status
  printf '{"lastRun":"2026-09-20T00:30:00.000Z","outcome":"installed","packages":["libc6 a -> b"]}\n' \
    > "$W/data/updates/os-status.json"
  # the log of that install, which a deferred run must leave alone as well
  mkdir -p "$W/log"; echo "== earlier run ==" > "$W/log/os-install.log"
  [ $# -gt 0 ] && env_pol set "$@" >/dev/null
}
env_pol() {
  PATH="$W/stub:$PATH" OS_POLICY_FILE="$W/policy.json" OS_POLICY_DROPIN="$W/dropin.conf" \
  AUDIT_FILE="$W/data/audit.jsonl" AUDIT_APPEND="$APPL/audit-append.js" \
  "$NODE" "$APPL/os-policy.js" "$@"
}
run() { # run <now> [args...]
  local now="$1"; shift
  PATH="$W/stub:$PATH" XENMAN_NOW="$now" UU_MARK="$W/uu-ran" FAKE_DPKG="$W/dpkg.db" \
  DATA_DIR="$W/data" AUDIT_APPEND="$APPL/audit-append.js" NODE="$NODE" \
  REBOOT_REQUIRED="$W/run/reboot-required" OS_INSTALL_LOG="$W/log/os-install.log" \
  OS_POLICY="$APPL/xenman-os-policy" OS_POLICY_JS="$APPL/os-policy.js" \
  OS_POLICY_FILE="$W/policy.json" OS_POLICY_DROPIN="$W/dropin.conf" AUDIT_FILE="$W/data/audit.jsonl" \
  bash "$APPL/xenman-os-update" "$@" > "$W/out.txt" 2>&1
  echo $?
}
INSIDE=2026-10-04T00:30:00Z     # Sun 02:30 Europe/Berlin
OUTSIDE=2026-10-05T04:30:00Z    # Mon 06:30, apt's old time

echo "=== manual mode ==="
reset --mode manual
check "exit" 0 "$(run "$INSIDE" --scheduled)"
check "nothing installed" no "$(ran)"
check "status says why" 1 "$(json 'd.deferred' | grep -c manual)"
check "check time recorded" yes "$(json 'd.lastCheck ? "yes" : "no"')"
check "last real install kept" "2026-09-20T00:30:00.000Z" "$(json 'd.lastRun')"
check "its log kept" "== earlier run ==" "$(cat "$W/log/os-install.log")"

echo "=== window, timer fired outside it ==="
reset --mode window --days Sun --time 02:00 --timezone Europe/Berlin
check "exit" 0 "$(run "$OUTSIDE" --scheduled)"
check "nothing installed" no "$(ran)"
check "status says why" 1 "$(json 'd.deferred' | grep -c 'outside the maintenance window')"
check "log of the last install kept" "== earlier run ==" "$(cat "$W/log/os-install.log")"

echo "=== window, inside it ==="
reset --mode window --days Sun --time 02:00 --timezone Europe/Berlin
check "exit" 0 "$(run "$INSIDE" --scheduled)"
check "installed" yes "$(ran)"
check "status" installed "$(json 'd.outcome')"
check "no stale deferral" undefined "$(json 'd.deferred')"
check "audited" 1 "$(grep -c os_security_update "$W/data/audit.jsonl")"
check "log names the window" 1 "$(head -1 "$W/log/os-install.log" | grep -c 'installing security updates (maintenance window)')"
check "log replaced, not appended" 0 "$(grep -c 'earlier run' "$W/log/os-install.log")"

echo "=== installing on request ignores the policy ==="
reset --mode manual
check "exit" 0 "$(run "$OUTSIDE")"
check "installed despite manual mode" yes "$(ran)"

echo "=== an updated appliance: no policy yet ==="
reset
check "exit" 0 "$(run "$OUTSIDE" --scheduled)"
check "policy created" yes "$([ -f "$W/policy.json" ] && echo yes || echo no)"
check "timer moved to the window" "OnCalendar=Sun *-*-* 02:00:00 Europe/Berlin" "$(grep '^OnCalendar=.' "$W/dropin.conf")"
check "and nothing installed at apt's old time" no "$(ran)"

echo "=== restart in the window ==="
reset --mode window --days Sun --time 02:00 --timezone Europe/Berlin --reboot yes
touch "$W/run/reboot-required"; echo "linux-image-6.12.108" > "$W/run/reboot-required.pkgs"
run "$INSIDE" --scheduled >/dev/null
check "restarted" 1 "$(cat "$W/systemctl.log" 2>/dev/null | grep -c 'systemctl reboot')"
check "restart audited with the reason" 1 "$(grep os_restart "$W/data/audit.jsonl" | grep -c linux-image)"

reset --mode window --days Sun --time 02:00 --timezone Europe/Berlin --reboot no
touch "$W/run/reboot-required"
run "$INSIDE" --scheduled >/dev/null
check "restart off: no restart" 0 "$(cat "$W/systemctl.log" 2>/dev/null | grep -c 'systemctl reboot')"

reset --mode window --days Sun --time 02:00 --timezone Europe/Berlin --reboot yes
touch "$W/run/reboot-required"
run "$INSIDE" >/dev/null
check "on request: never restarts" 0 "$(cat "$W/systemctl.log" 2>/dev/null | grep -c 'systemctl reboot')"

reset --mode window --days Sun --time 02:00 --timezone Europe/Berlin --reboot yes
touch "$W/run/reboot-required"
run "$OUTSIDE" --scheduled >/dev/null
check "outside the window: no restart" 0 "$(cat "$W/systemctl.log" 2>/dev/null | grep -c 'systemctl reboot')"

echo
echo "$pass passed, $fail failed"
exit $fail
