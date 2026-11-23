#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# xenman-os-request: every action, and every way the request file can be hostile.
set -u
APPL=$REPO/appliance
NODE=$NODE_BIN
W=/var/tmp/request-test
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1))
  else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi
}
result() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync('$W/data/updates/os-request-result.json','utf8')); $1" 2>/dev/null; }
gone() { [ -e "$W/data/updates/os-request.json" ] || [ -L "$W/data/updates/os-request.json" ] && echo present || echo gone; }

reset() {
  rm -rf "$W"; mkdir -p "$W/data/updates" "$W/stub" "$W/backup"
  printf '#!/bin/sh\necho "systemctl $*" >> %s/systemctl.log\n' "$W" > "$W/stub/systemctl"
  printf '#!/bin/sh\ntouch %s/update-ran\necho "xenman-os-update: 2 packages changed"\n' "$W" > "$W/stub/os-update-ok"
  printf '#!/bin/sh\necho "xenman-os-update: unattended-upgrade failed (exit 100)"\nexit 100\n' > "$W/stub/os-update-fail"
  printf '#!/bin/sh\necho "$*" > %s/apt-args\necho "Hit:1 http://deb.debian.org/debian-security trixie-security InRelease"\n' "$W" > "$W/stub/apt-ok"
  printf '#!/bin/sh\necho "Ign:1 http://deb.debian.org/debian-security trixie-security InRelease" >&2\necho "W: Failed to fetch http://deb.debian.org/debian-security/dists/trixie-security/InRelease  Could not connect to deb.debian.org:80" >&2\necho "E: Some index files failed to download." >&2\nexit 100\n' > "$W/stub/apt-fail"
  chmod +x "$W/stub/"*
}
req() { printf '%s' "$1" > "$W/data/updates/os-request.json"; }
run() { # run [os-update stub]
  PATH="$W/stub:$PATH" \
  OS_REQUEST_FILE="$W/data/updates/os-request.json" OS_RESULT_FILE="$W/data/updates/os-request-result.json" \
  OS_POLICY="$APPL/xenman-os-policy" OS_POLICY_JS="$APPL/os-policy.js" NODE="$NODE" \
  OS_POLICY_FILE="$W/policy.json" OS_POLICY_DROPIN="$W/dropin.conf" \
  OS_UPDATE="$W/stub/${1:-os-update-ok}" APT_GET="$W/stub/${2:-apt-ok}" UPDATE_STAMP="$W/periodic/update-success-stamp" PROXY_CONF="$W/apt/90xenman-proxy" PROXY_INFO="$W/etc/proxy.json" NTP_CONF="$W/timesyncd/50-xenman.conf" ZONEINFO="$W/zoneinfo" TIMEDATECTL="$W/stub/timedatectl" APP_UPDATE_MARKER="$W/backup/pending" \
  AUDIT_FILE="$W/data/audit.jsonl" AUDIT_APPEND="$APPL/audit-append.js" \
  timeout 20 "$NODE" "$APPL/os-request.js" > "$W/out.txt" 2>&1
  echo $?
}

echo "=== nothing to do ==="
reset
check "exit" 0 "$(run)"
check "no result written" no "$([ -f "$W/data/updates/os-request-result.json" ] && echo yes || echo no)"

echo "=== set-policy ==="
reset
req '{"id":"r1","action":"set-policy","requestedBy":"admin","policy":{"mode":"window","days":["Sat","Sun"],"time":"03:30","timezone":"Europe/Berlin","rebootInWindow":true}}'
run >/dev/null
check "done" done "$(result 'd.state')"
check "result carries the id" r1 "$(result 'd.id')"
check "request consumed" gone "$(gone)"
check "policy applied" "Sat,Sun 03:30 true" "$("$NODE" -pe 'const p=JSON.parse(require("fs").readFileSync("'"$W"'/policy.json","utf8")); p.days.join(",")+" "+p.time+" "+p.rebootInWindow')"
check "timer follows" "OnCalendar=Sat,Sun *-*-* 03:30:00 Europe/Berlin" "$(grep '^OnCalendar=.' "$W/dropin.conf")"
check "audit names who asked" 1 "$(grep os_update_policy_changed "$W/data/audit.jsonl" | grep -c 'requested by admin in the web interface')"

reset
req '{"id":"r2","action":"set-policy","requestedBy":"admin","policy":{"time":"25:00"}}'
run >/dev/null
check "invalid time refused" failed "$(result 'd.state')"
check "with the reason" 1 "$(result 'd.message' | grep -c 'HH:MM')"
check "no policy written" no "$([ -f "$W/policy.json" ] && echo yes || echo no)"

reset
req '{"id":"r3","action":"set-policy","requestedBy":"admin","policy":{"days":["Sun; rm -rf /"]}}'
run >/dev/null
check "shell text in days refused" failed "$(result 'd.state')"

echo "=== check ==="
reset
req '{"id":"c1","action":"check","requestedBy":"admin"}'
run >/dev/null
check "done" "done package lists refreshed" "$(result 'd.state+" "+d.message')"
check "apt asked to fail on any unreachable source" "update -q --error-on=any" "$(cat "$W/apt-args")"
check "stamp written for last checked" yes "$([ -f "$W/periodic/update-success-stamp" ] && echo yes || echo no)"
check "installs nothing" no "$([ -f "$W/update-ran" ] && echo yes || echo no)"
reset
req '{"id":"c2","action":"check","requestedBy":"admin"}'
run os-update-ok apt-fail >/dev/null
check "unreachable source reported" failed "$(result 'd.state')"
check "with the reason apt gave for the source" "could not refresh the package lists: Could not connect to deb.debian.org:80" "$(result 'd.message')"
check "no stamp on failure" no "$([ -f "$W/periodic/update-success-stamp" ] && echo yes || echo no)"
reset
touch "$W/backup/pending"
req '{"id":"c3","action":"check","requestedBy":"admin"}'
run >/dev/null
check "not during an application update" failed "$(result 'd.state')"
check "apt not run then" no "$([ -f "$W/apt-args" ] && echo yes || echo no)"

echo "=== set-time ==="
treset() {
  reset
  mkdir -p "$W/zoneinfo/Europe" "$W/outside"
  touch "$W/zoneinfo/UTC" "$W/zoneinfo/Europe/Berlin" "$W/outside/Evil"
  ln -s ../outside/Evil "$W/zoneinfo/Europe/Link"
  printf '#!/bin/sh\necho "$*" >> %s/timedatectl.log\n' "$W" > "$W/stub/timedatectl"
  chmod +x "$W/stub/timedatectl"
}
NTP="$W/timesyncd/50-xenman.conf"
treset
req '{"id":"t1","action":"set-time","requestedBy":"admin","time":{"timezone":"Europe/Berlin","ntpServers":["ntp1.example.com","10.0.0.5","fd00::123"]}}'
run >/dev/null
check "done" "done saved: time zone Europe/Berlin; NTP ntp1.example.com, 10.0.0.5, fd00::123" "$(result 'd.state+" "+d.message')"
check "zone set through timedatectl" 1 "$(grep -c '^set-timezone Europe/Berlin$' "$W/timedatectl.log")"
check "NTP switched on" 1 "$(grep -c '^set-ntp true$' "$W/timedatectl.log")"
check "servers in the drop-in" "NTP=ntp1.example.com 10.0.0.5 fd00::123" "$(grep '^NTP=' "$NTP")"
check "drop-in has its section" 1 "$(grep -c '^\[Time\]$' "$NTP")"
check "drop-in readable" 644 "$(stat -c %a "$NTP")"
check "timesyncd restarted" 1 "$(grep -c 'systemctl restart systemd-timesyncd' "$W/systemctl.log")"
check "audited with who asked" 1 "$(grep os_time_changed "$W/data/audit.jsonl" | grep -c 'requested by admin')"

req '{"id":"t2","action":"set-time","requestedBy":"admin","time":{"ntpServers":[]}}'
run >/dev/null
check "empty list: back to Debian defaults" "done no" "$(result 'd.state') $([ -e "$NTP" ] && echo yes || echo no)"
check "zone left alone" 1 "$(grep -c set-timezone "$W/timedatectl.log")"

for tz in '"Mars/Olympus"' '"../../etc/shadow"' '"Europe/Link"' '"Europe/Berlin; rm -rf /"' '""' '42'; do
  req "{\"id\":\"tz\",\"action\":\"set-time\",\"requestedBy\":\"admin\",\"time\":{\"timezone\":$tz}}"
  run >/dev/null
  check "zone $tz refused" "failed unknown time zone" "$(result 'd.state+" "+d.message')"
done
check "  and timedatectl never asked" 1 "$(grep -c set-timezone "$W/timedatectl.log")"
for srv in '["a\nNTP=evil"]' '["-x"]' '["a b"]' '["[fd00::1]"]' '["a","b","c","d","e","f"]' '"ntp.example.org"' '[42]'; do
  req "{\"id\":\"ts\",\"action\":\"set-time\",\"requestedBy\":\"admin\",\"time\":{\"ntpServers\":$srv}}"
  run >/dev/null
  check "servers $srv refused" failed "$(result 'd.state')"
done
check "  and no drop-in written" no "$([ -e "$NTP" ] && echo yes || echo no)"
req '{"id":"t3","action":"set-time","requestedBy":"admin","time":{}}'
run >/dev/null
check "nothing to change refused" "failed the time request changes nothing" "$(result 'd.state+" "+d.message')"

echo "=== set-proxy ==="
reset
CONF="$W/apt/90xenman-proxy"; INFO="$W/etc/proxy.json"
info() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync('$INFO','utf8')); $1" 2>/dev/null; }
req '{"id":"p1","action":"set-proxy","requestedBy":"admin","proxy":{"host":"proxy.example.com","port":8080}}'
run >/dev/null
check "saved and tested" "done proxy proxy.example.com:8080 saved, package lists refreshed" "$(result 'd.state+" "+d.message')"
check "apt configured" 'Acquire::http::Proxy "http://proxy.example.com:8080/";' "$(grep '^Acquire::http::' "$CONF")"
check "https too" 1 "$(grep -c '^Acquire::https::Proxy "http://proxy.example.com:8080/";$' "$CONF")"
check "the connection was tested" "update -q --error-on=any" "$(cat "$W/apt-args")"
check "info for the web" "proxy.example.com 8080 null false" "$(info 'd.host+" "+d.port+" "+d.username+" "+d.hasPassword')"
check "audited" 1 "$(grep os_proxy_changed "$W/data/audit.jsonl" | grep -c 'proxy.example.com:8080')"

req '{"id":"p2","action":"set-proxy","requestedBy":"admin","proxy":{"host":"10.0.0.1","port":3128,"username":"me@dom","password":"p@ss:w\"rd/%x"}}'
run >/dev/null
check "login and password encoded" 'Acquire::http::Proxy "http://me%40dom:p%40ss%3Aw%22rd%2F%25x@10.0.0.1:3128/";' "$(grep '^Acquire::http::' "$CONF")"
check "apt file root only" 600 "$(stat -c %a "$CONF")"
check "info readable" 644 "$(stat -c %a "$INFO")"
check "no password in the info" "me@dom true" "$(info 'd.username+" "+d.hasPassword')"
check "no password in the info file" 0 "$(grep -c 'p@ss' "$INFO")"
check "no password in the result" 0 "$(grep -c 'p@ss\|p%40ss' "$W/data/updates/os-request-result.json")"
check "no password in the audit" 0 "$(grep -c 'p@ss\|p%40ss' "$W/data/audit.jsonl")"
check "login in the audit" 1 "$(grep os_proxy_changed "$W/data/audit.jsonl" | grep -c 'with login me@dom')"

req '{"id":"p3","action":"set-proxy","requestedBy":"admin","proxy":{"host":"10.0.0.2","port":3128,"username":"me@dom"}}'
run >/dev/null
check "password kept when only the host changes" 'Acquire::http::Proxy "http://me%40dom:p%40ss%3Aw%22rd%2F%25x@10.0.0.2:3128/";' "$(grep '^Acquire::http::' "$CONF")"
req '{"id":"p4","action":"set-proxy","requestedBy":"admin","proxy":{"host":"10.0.0.2","port":3128,"username":"other"}}'
run >/dev/null
check "not carried over to another login" 'Acquire::http::Proxy "http://other@10.0.0.2:3128/";' "$(grep '^Acquire::http::' "$CONF")"
check "info: no password" "other false" "$(info 'd.username+" "+d.hasPassword')"

req '{"id":"p5","action":"set-proxy","requestedBy":"admin","proxy":{"host":"10.0.0.3","port":3128}}'
run os-update-ok apt-fail >/dev/null
check "saved even if the test fails" 2 "$(grep -c '10.0.0.3:3128' "$CONF")"
check "and says so" "failed proxy 10.0.0.3:3128 saved, but the package lists could not be refreshed: Could not connect to deb.debian.org:80" "$(result 'd.state+" "+d.message')"

for bad in '"evil\"; APT::Foo \"1"' '"a\nAcquire::x \"1\""' '"proxy host"' '"-rf"' '""' '"a..b"' '"[::1"'; do
  cp "$CONF" "$W/conf.before"
  req "{\"id\":\"pb\",\"action\":\"set-proxy\",\"requestedBy\":\"admin\",\"proxy\":{\"host\":$bad,\"port\":3128}}"
  run >/dev/null
  check "host $bad refused" failed "$(result 'd.state')"
  check "  and nothing changed" same "$(cmp -s "$CONF" "$W/conf.before" && echo same || echo changed)"
done
for port in 0 65536 '"80; x"' 1.5 null; do
  req "{\"id\":\"pp\",\"action\":\"set-proxy\",\"requestedBy\":\"admin\",\"proxy\":{\"host\":\"10.0.0.9\",\"port\":$port}}"
  run >/dev/null
  check "port $port refused" "failed the proxy port must be between 1 and 65535" "$(result 'd.state+" "+d.message')"
done
req '{"id":"pn","action":"set-proxy","requestedBy":"admin","proxy":{"host":"10.0.0.9","port":80,"username":"u","password":"a\nAcquire::x \"1\""}}'
run >/dev/null
check "newline in the password refused" "failed the proxy password is not valid" "$(result 'd.state+" "+d.message')"
req '{"id":"p6","action":"set-proxy","requestedBy":"admin","proxy":{"host":"[fd00::1]","port":3128}}'
run >/dev/null
check "IPv6 address accepted" 'Acquire::http::Proxy "http://[fd00::1]:3128/";' "$(grep '^Acquire::http::' "$CONF")"

req '{"id":"p7","action":"set-proxy","requestedBy":"admin","proxy":null}'
run >/dev/null
check "removed" "done proxy removed, package lists refreshed" "$(result 'd.state+" "+d.message')"
check "both files gone" "no no" "$([ -e "$CONF" ] && echo yes || echo no) $([ -e "$INFO" ] && echo yes || echo no)"
check "removal audited" 1 "$(grep os_proxy_changed "$W/data/audit.jsonl" | grep -c 'direct connection')"
req '{"id":"p8","action":"set-proxy","requestedBy":"admin"}'
run >/dev/null
check "no proxy in the request refused" "failed no proxy in the request" "$(result 'd.state+" "+d.message')"

echo "=== install-now ==="
reset
req '{"id":"r4","action":"install-now","requestedBy":"admin"}'
run >/dev/null
check "ran the update" yes "$([ -f "$W/update-ran" ] && echo yes || echo no)"
check "done" done "$(result 'd.state')"
check "reports what happened" "2 packages changed" "$(result 'd.message')"

reset
req '{"id":"r5","action":"install-now","requestedBy":"admin"}'
run os-update-fail >/dev/null
check "failure reported" failed "$(result 'd.state')"
check "with the reason" 1 "$(result 'd.message' | grep -c 'exit 100')"

echo "=== reboot ==="
reset
req '{"id":"r6","action":"reboot","requestedBy":"admin"}'
run >/dev/null
check "rebooted" 1 "$(cat "$W/systemctl.log" 2>/dev/null | grep -c 'systemctl reboot')"
check "audited before, with who asked" 1 "$(grep os_restart "$W/data/audit.jsonl" | grep -c 'requested by admin')"

echo "=== refused requests ==="
reset; req '{"id":"r7","action":"format-disk","requestedBy":"admin"}'; run >/dev/null
check "unknown action" failed "$(result 'd.state')"
reset; req '{"id":"../../x","action":"reboot"}'; run >/dev/null
check "bad id" failed "$(result 'd.state')"
check "and no reboot" 0 "$(cat "$W/systemctl.log" 2>/dev/null | grep -c reboot)"
reset; mkdir -p "$W/backup"; touch "$W/backup/pending"
req '{"id":"r8","action":"reboot","requestedBy":"admin"}'; run >/dev/null
check "refused during an application update" failed "$(result 'd.state')"
check "no reboot then" 0 "$(cat "$W/systemctl.log" 2>/dev/null | grep -c reboot)"

echo "=== a hostile request file ==="
reset; req 'not json at all SECRET-CONTENT'; run >/dev/null
check "garbage refused" failed "$(result 'd.state')"
check "content not echoed" 0 "$(grep -c SECRET-CONTENT "$W/data/updates/os-request-result.json")"
check "consumed anyway" gone "$(gone)"

reset; echo "root-only secret SHADOW-LINE" > "$W/secret"; chmod 600 "$W/secret"
ln -s "$W/secret" "$W/data/updates/os-request.json"; run >/dev/null
check "symlink refused" failed "$(result 'd.state')"
check "target not read into the result" 0 "$(grep -c SHADOW-LINE "$W/data/updates/os-request-result.json")"
check "symlink removed" gone "$(gone)"
check "target untouched" "root-only secret SHADOW-LINE" "$(cat "$W/secret")"

reset; mkfifo "$W/data/updates/os-request.json"
rc=$(run)
check "named pipe does not hang the service" 0 "$rc"
check "refused" failed "$(result 'd.state')"

reset; head -c 20000 /dev/zero | tr '\0' 'a' > "$W/data/updates/os-request.json"; run >/dev/null
check "oversized refused" failed "$(result 'd.state')"

reset
req '{"id":"r9","action":"set-policy","requestedBy":"<script>ad;min$(id)","policy":{"days":["Sun"]}}'
run >/dev/null
check "requester name sanitised in the audit" 1 "$(grep -c 'requested by scriptadminid in the web interface' "$W/data/audit.jsonl")"

echo
echo "$pass passed, $fail failed"
exit $fail
