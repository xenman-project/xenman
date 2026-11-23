#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# xenman-os-policy: validation, the generated timer, and the window arithmetic.
set -u
APPL=$REPO/appliance
NODE=$NODE_BIN
W=/var/tmp/policy-test
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1))
  else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi
}
has() { grep -qF -- "$2" "$3" && { echo "  PASS  $1"; pass=$((pass+1)); } || { echo "  FAIL  $1 ('$2' missing)"; fail=$((fail+1)); }; }

reset() {
  rm -rf "$W"; mkdir -p "$W/stub" "$W/data"
  printf '#!/bin/sh\necho "systemctl $*" >> %s/systemctl.log\n' "$W" > "$W/stub/systemctl"
  chmod +x "$W/stub/systemctl"
}
pol() {
  PATH="$W/stub:$PATH" OS_POLICY_FILE="$W/policy.json" OS_POLICY_DROPIN="$W/dropin.conf" \
  AUDIT_FILE="$W/data/audit.jsonl" AUDIT_APPEND="$APPL/audit-append.js" \
  "$NODE" "$APPL/os-policy.js" "$@"
}
calendar() { grep '^OnCalendar=.' "$W/dropin.conf" | cut -d= -f2-; }
systemd_ok() { systemd-analyze calendar "$(calendar)" >/dev/null 2>&1 && echo yes || echo no; }
reloads() { grep -c daemon-reload "$W/systemctl.log" 2>/dev/null || echo 0; }
at() { XENMAN_NOW="$1" pol in-window >/dev/null 2>&1 && echo in || echo out; }

echo "=== defaults ==="
reset
check "without a file: the default window" "policy:    window Sun 02:00 Europe/Berlin, no automatic restart" "$(pol show | head -1)"

echo "=== the web interface's copy of the default ==="
UI=$REPO/src/components/os-updates.tsx
ui_default=$("$NODE" -e '
  const src = require("fs").readFileSync(process.argv[1], "utf8");
  const block = src.match(/const DEFAULT_POLICY = \{([\s\S]*?)\} as const;/)[1];
  const get = (k) => (block.match(new RegExp(k + ":\\s*([^,\\n]+)")) || [])[1].trim();
  process.stdout.write([get("mode"), get("days"), get("time"), get("timezone"), get("rebootInWindow")].join(" ").replace(/"/g, ""));
' "$UI")
root_default=$(pol show | sed -n '/^{/,$p' | "$NODE" -pe 'const d=JSON.parse(require("fs").readFileSync(0)); [d.mode, "["+d.days.join(", ")+"]", d.time, d.timezone, d.rebootInWindow].join(" ")')
check "UI default matches os-policy.js" "$root_default" "$ui_default"

echo "=== apply ==="
pol apply >/dev/null
check "policy file written" yes "$([ -f "$W/policy.json" ] && echo yes || echo no)"
check "policy file mode" 644 "$(stat -c %a "$W/policy.json")"
check "timer on the window, in its zone" "Sun *-*-* 02:00:00 Europe/Berlin" "$(calendar)"
has "no random delay" "RandomizedDelaySec=0" "$W/dropin.conf"
has "missed windows are not caught up" "Persistent=false" "$W/dropin.conf"
has "resets apt's own schedule first" "OnCalendar=" "$W/dropin.conf"
check "systemd accepts the schedule" yes "$(systemd_ok)"
check "daemon-reload once" 1 "$(reloads)"
pol apply >/dev/null
check "second apply changes nothing" 1 "$(reloads)"

echo "=== set ==="
pol set --days Sat,sun,MON --time 03:30 >/dev/null
check "days in calendar order" "Mon,Sat,Sun *-*-* 03:30:00 Europe/Berlin" "$(calendar)"
check "systemd accepts it" yes "$(systemd_ok)"
check "audited" 1 "$(grep -c os_update_policy_changed "$W/data/audit.jsonl")"
has "audit says what it was before" "changed from: window Sun 02:00" "$W/data/audit.jsonl"
pol set --days daily >/dev/null
check "daily has no weekday" "*-*-* 03:30:00 Europe/Berlin" "$(calendar)"
check "systemd accepts it" yes "$(systemd_ok)"
pol set --timezone America/New_York >/dev/null
check "another zone" "*-*-* 03:30:00 America/New_York" "$(calendar)"
check "systemd accepts it" yes "$(systemd_ok)"
pol set --reboot yes >/dev/null
check "restart setting" true "$(pol get rebootInWindow)"

echo "=== bad input is refused and changes nothing ==="
before=$(cat "$W/policy.json")
for args in "--days Funday" "--time 25:00" "--time 2:30" "--timezone Mars/Olympus" \
            "--mode sometimes" "--reboot maybe" "--colour blue"; do
  pol set $args >/dev/null 2>&1
  rc=$?
  check "refuses $args" 1 "$rc"
done
check "policy untouched" "$before" "$(cat "$W/policy.json")"

echo "=== manual ==="
pol set --mode manual --timezone Europe/Berlin >/dev/null
check "mode" manual "$(pol get mode)"
check "a daily check still runs" "*-*-* 03:30:00 Europe/Berlin" "$(calendar)"
check "never in the window" out "$(at 2026-10-04T01:40:00Z)"
check "and says why" 1 "$(XENMAN_NOW=2026-10-04T01:40:00Z pol in-window 2>&1 | grep -c manual)"

echo "=== the window: Sun 02:00 Europe/Berlin, two hours to start ==="
pol set --mode window --days Sun --time 02:00 --timezone Europe/Berlin >/dev/null
check "summer, 02:30 CEST"            in  "$(at 2026-10-04T00:30:00Z)"
check "summer, 03:59 CEST"            in  "$(at 2026-10-04T01:59:00Z)"
check "summer, 04:00 CEST: too late"  out "$(at 2026-10-04T02:00:00Z)"
check "summer, 01:59 CEST: too early" out "$(at 2026-10-03T23:59:00Z)"
check "winter, 02:30 CET"             in  "$(at 2026-01-04T01:30:00Z)"
check "winter, 01:30 CET: too early"  out "$(at 2026-01-04T00:30:00Z)"
check "Monday 02:30: wrong day"       out "$(at 2026-10-05T00:30:00Z)"

echo "=== a window across midnight: Sat 23:30 ==="
pol set --days Sat --time 23:30 >/dev/null
check "Sat 23:45"                     in  "$(at 2026-01-03T22:45:00Z)"
check "Sun 00:45, same window"        in  "$(at 2026-01-03T23:45:00Z)"
check "Sun 01:31, past it"            out "$(at 2026-01-04T00:31:00Z)"

echo "=== a damaged policy file ==="
echo "{ not json" > "$W/policy.json"
check "falls back to the defaults" "policy:    window Sun 02:00 Europe/Berlin, no automatic restart" "$(pol show | head -1)"
check "and says so" 1 "$(pol show | grep -c unreadable)"

echo
echo "$pass passed, $fail failed"
exit $fail
