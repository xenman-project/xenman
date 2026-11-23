#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# XenServer updates, stage 1: reading the update state of a pool and checking
# for updates, against a stand-in XenServer 8 coordinator (fake-xapi.js).
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xu-data
FX=/var/tmp/fake-xapi
PORT=3107; XPORT=4480
BASE="http://127.0.0.1:$PORT"
NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
B=/var/tmp/xu-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $B -w "%{http_code}" "$@"; }
J='-H Content-Type:application/json'
mode() { echo "$1" > "$FX/mode"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; mode nosync
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT > /var/tmp/xu-server.log 2>&1 &
PID=$!
trap 'kill $PID $FPID 2>/dev/null' EXIT
for _ in $(seq 40); do curl -sS -o /dev/null "$BASE/login" 2>/dev/null && break; sleep 1; done
curl -sS -c /var/tmp/xu-cookie -X POST "$BASE/api/auth/login" $J -d '{"username":"admin","password":"admin"}' >/dev/null; curl -sS -b /var/tmp/xu-cookie -c /var/tmp/xu-cookie -X POST "$BASE/api/auth/change-password" $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null; curl -sS -c /var/tmp/xu-cookie -X POST "$BASE/api/auth/login" $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
A="-b /var/tmp/xu-cookie"
add() { curl -sS $A -X POST "$BASE/api/hosts" $J -d "{\"action\":\"add\",\"host\":{\"id\":\"$1\",\"name\":\"$2\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"$3\",\"useSsl\":false}}" >/dev/null; }
add pool1 Production secret
add pool2 Other wrong
U="$BASE/api/xen-updates"

echo "=== before the first sync ==="
check "readable" 200 "$(code $A "$U?hostId=pool1")"
check "pool, channel, last sync" "Production Normal 2026-09-28T08:00:00.000Z" "$(field 'd.updates.pool.name+" "+d.updates.pool.channel.name+" "+d.updates.pool.lastSync' < $B)"
check "no list yet, said so" true "$(field 'd.updates.problem.includes("check for updates first")' < $B)"
check "hosts listed, coordinator first" "xs-01 true xs-02 false" "$(field 'd.updates.hosts.map(h=>h.name+" "+h.isCoordinator).join(" ")' < $B)"
check "pending restart from earlier" "reboot_host" "$(field 'd.updates.hosts[1].pending.join()' < $B)"
check "never-updated host: no date" null "$(field 'String(d.updates.hosts[1].lastUpdated)' < $B)"
check "session not left open" yes "$([ "$(grep -c 'session.login' "$FX/calls.log")" = "$(grep -c 'session.logout' "$FX/calls.log")" ] && echo yes || echo no)"

echo "=== checking for updates ==="
check "started" "200 running" "$(code $A -X POST "$U" $J -d '{"hostId":"pool1","action":"sync"}') $(field 'd.sync.state' < $B)"
check "async sync with empty credentials" 1 "$(grep -c '^Async.pool.sync_updates \["OpaqueRef:pool",false,"","","",""\]' "$FX/calls.log")"
check "a second click joins the running check" running "$(code $A -X POST "$U" $J -d '{"hostId":"pool1","action":"sync"}' >/dev/null; field 'd.sync.state' < $B)"
for _ in $(seq 20); do code $A "$U?hostId=pool1" >/dev/null; [ "$(field 'd.sync.state' < $B)" = done ] && break; sleep 1; done
check "finished" done "$(field 'd.sync.state' < $B)"
check "only one sync ran" 1 "$(grep -c '^Async.pool.sync_updates' "$FX/calls.log")"
check "task cleaned up" 1 "$(grep -c '^task.destroy' "$FX/calls.log")"
code $A "$U?hostId=pool1&fresh=1" >/dev/null
check "list always read with a session" "yes 0" "$([ $(grep -c 'GET /updates with-session' "$FX/calls.log") -ge 1 ] && echo yes || echo no) $(grep -c 'GET /updates no-session' "$FX/calls.log")"
check "new sync time" "2026-10-02T12:00:00.000Z" "$(field 'd.updates.pool.lastSync' < $B)"
check "no problem now" null "$(field 'String(d.updates.problem)' < $B)"
check "hash" abc123hash "$(field 'd.updates.hash' < $B)"
check "updates missing somewhere, newest first" "XSU-2026-002 XSU-2026-001" "$(field 'd.updates.updates.map(u=>u.id).join(" ")' < $B)"
check "one installed everywhere left out" 0 "$(field 'd.updates.updates.filter(u=>u.id==="XSU-2025-900").length' < $B)"
check "per update: hosts lacking it" "xs-01,xs-02 | xs-01" "$(field 'd.updates.updates.map(u=>u.hosts.map(r=>d.updates.hosts.find(h=>h.ref===r).name).join()).join(" | ")' < $B)"
check "severity, type, guidance" "High SecurityFix RebootHost" "$(field 'const u=d.updates.updates.find(x=>x.id==="XSU-2026-001"); [u.severity,u.type,u.guidance].join(" ")' < $B)"
check "advisory link kept if http(s)" "https://support.example/XSU-2026-001" "$(field 'd.updates.updates.find(x=>x.id==="XSU-2026-001").url' < $B)"
check "javascript: link dropped" null "$(field 'String(d.updates.updates.find(x=>x.id==="XSU-2026-002").url)' < $B)"
check "per host: count, high, guidance" "2 1 RebootHost | 1 0 RestartToolstack" "$(field 'd.updates.hosts.map(h=>[h.updates.length,h.highSeverity,h.guidance.join()].join(" ")).join(" | ")' < $B)"
check "sync audited (requested, done)" "1 1" "$(grep -c xen_updates_sync_requested "$DATA/audit.jsonl") $(grep xen_updates_synced "$DATA/audit.jsonl" | grep -c '"outcome":"success"')"

echo "=== cache ==="
before=$(grep -c 'GET /updates' "$FX/calls.log")
code $A "$U?hostId=pool1" >/dev/null
check "second read from the cache" "$before" "$(grep -c 'GET /updates' "$FX/calls.log")"
touch "$FX/h2-offline"
code $A "$U?hostId=pool1&fresh=1" >/dev/null
check "fresh read sees an offline host" false "$(field 'd.updates.hosts[1].live' < $B)"
rm -f "$FX/h2-offline"

echo "=== problems ==="
mode license
code $A -X POST "$U" $J -d '{"hostId":"pool1","action":"sync"}' >/dev/null
for _ in $(seq 10); do code $A "$U?hostId=pool1" >/dev/null; [ "$(field 'd.sync.state' < $B)" != running ] && break; sleep 1; done
check "licence explained" "failed The pool's XenServer license does not include updates." "$(field 'd.sync.state+" "+d.sync.error' < $B)"
check "failure audited" 1 "$(grep xen_updates_synced "$DATA/audit.jsonl" | grep -c '"outcome":"failure"')"
mode norepo
code $A "$U?hostId=pool1&fresh=1" >/dev/null
check "no channel explained" true "$(field 'd.updates.problem.includes("No update channel")' < $B)"
mode normal; touch "$FX/ha"
code $A "$U?hostId=pool1&fresh=1" >/dev/null
check "HA reported" true "$(field 'd.updates.pool.haEnabled' < $B)"
rm -f "$FX/ha"
check "wrong stored password: 502 with the reason" "502 The stored credentials for this pool were rejected." "$(code $A "$U?hostId=pool2") $(field 'd.error' < $B)"
check "unknown pool" 404 "$(code $A "$U?hostId=nope" )" # admins pass the grant check; then it is not found
check "bad action" 400 "$(code $A -X POST "$U" $J -d '{"hostId":"pool1","action":"apply"}')"

echo "=== sidebar summary ==="
check "summary" 200 "$(code $A "$U/summary")"
check "pool1: two hosts behind, one high, restart pending" "2 2 1 true" "$(field 'const p=d.pools.find(x=>x.hostId==="pool1"); [p.hostsBehind,p.updates,p.high,p.restartPending].join(" ")' < $B)"
check "pool2: unknown, not an error" true "$(field 'd.pools.find(x=>x.hostId==="pool2").unknown' < $B)"

echo "=== Configure Updates ==="
L="$FX/calls.log"
conf() { code $A -X POST "$U" $J -d "{\"hostId\":\"pool1\",\"action\":\"configure\",\"config\":$1}"; }
writes() { grep -c -E '^(Repository\.introduce|pool\.(add_repository|remove_repository|configure_update_sync|set_update_sync_enabled|configure_repository_proxy|disable_repository_proxy)) ' "$L"; }
code $A "$U?hostId=pool1&fresh=1" >/dev/null
check "channel shown by its name, not its key" "Normal normal" "$(field 'd.updates.pool.channel.name+" "+d.updates.pool.config.channel' < $B)"
check "settings read" '{"supported":true,"enabled":true,"frequency":"weekly","day":0} {"url":"","username":"","passwordSet":false}' "$(field 'JSON.stringify(d.updates.pool.config.sync)+" "+JSON.stringify(d.updates.pool.config.proxy)' < $B)"
: > "$L"
check "nothing changed: nothing written" "200 0 0" "$(conf '{"channel":"normal","sync":{"enabled":true,"frequency":"weekly","day":0},"proxy":{"url":"","username":""}}') $(field 'd.changed.length' < $B) $(writes)"
check "to Early Access: changed, sync offered" "200 true" "$(conf '{"channel":"early_access"}') $(field 'd.channelChanged' < $B)"
check "  Normal disabled first" 'pool.remove_repository ["OpaqueRef:pool","OpaqueRef:repo"]' "$(grep -m1 '^pool.remove_repository' "$L")"
check "  base introduced, not as the update repository" 'Repository.introduce ["base_repo","Base","https://repo.ops.xenserver.com/xs8/base","https://repo-src.ops.xenserver.com/xs8/base",false,""]' "$(grep -m1 '"base_repo"' "$L")"
check "  Early Access introduced as XenCenter does" 'Repository.introduce ["early_access_repo","Early Access","https://repo.ops.xenserver.com/xs8/earlyaccess","https://repo-src.ops.xenserver.com/xs8/earlyaccess",true,""]' "$(grep -m1 '"early_access_repo"' "$L")"
check "  in that order, then enabled" "remove base early add" "$(grep -E '^(pool.remove_repository|Repository.introduce|pool.add_repository)' "$L" | sed -E 's/^pool.remove_repository.*/remove/; s/^Repository.introduce \["base_repo".*/base/; s/^Repository.introduce \["early_access_repo".*/early/; s/^pool.add_repository.*/add/' | tr '\n' ' ' | sed 's/ $//')"
code $A "$U?hostId=pool1" >/dev/null
check "  the tab reads it at once" "Early Access early_access" "$(field 'd.updates.pool.channel.name+" "+d.updates.pool.config.channel' < $B)"
check "  audited" true "$(grep xen_updates_configured "$DATA/audit.jsonl" | tail -1 | grep -q 'channel: Early Access' && echo true)"
: > "$L"
check "back to Normal: the known repository, nothing introduced" "200 0 1 1" "$(conf '{"channel":"normal"}') $(grep -c '^Repository.introduce' "$L") $(grep -c '^pool.remove_repository' "$L") $(grep -c '^pool.add_repository \["OpaqueRef:pool","OpaqueRef:repo"\]' "$L")"
: > "$L"
check "weekly on Monday" "200 1 0" "$(conf '{"sync":{"enabled":true,"frequency":"weekly","day":1}}') $(grep -c '^pool.configure_update_sync \["OpaqueRef:pool","weekly","1"\]' "$L") $(grep -c '^pool.set_update_sync_enabled' "$L")"
check "  shown" "weekly 1" "$(code $A "$U?hostId=pool1" >/dev/null; field 'd.updates.pool.config.sync.frequency+" "+d.updates.pool.config.sync.day' < $B)"
check "  audited with the day" true "$(grep xen_updates_configured "$DATA/audit.jsonl" | tail -1 | grep -q 'weekly (Monday)' && echo true)"
: > "$L"
check "switched off: only that" "200 0 1" "$(conf '{"sync":{"enabled":false,"frequency":"weekly","day":1}}') $(grep -c '^pool.configure_update_sync' "$L") $(grep -c '^pool.set_update_sync_enabled \["OpaqueRef:pool",false\]' "$L")"
check "bad day" 400 "$(conf '{"sync":{"enabled":true,"frequency":"weekly","day":7}}')"
check "bad channel" 400 "$(conf '{"channel":"dev_team"}')"
check "proxy URL must be http(s)" 400 "$(conf '{"proxy":{"url":"ftp://proxy:21","username":""}}')"
: > "$L"
check "proxy with credentials" "200 1" "$(conf '{"proxy":{"url":"https://proxy.example:8080","username":"upd","password":"Pr0xy-Secret-77"}}') $(grep -c '^pool.configure_repository_proxy \["OpaqueRef:pool","https://proxy.example:8080","upd","Pr0xy-Secret-77"\]' "$L")"
code $A "$U?hostId=pool1" >/dev/null
check "  read back without the password" '{"url":"https://proxy.example:8080","username":"upd","passwordSet":true} 0' "$(field 'JSON.stringify(d.updates.pool.config.proxy)' < $B) $(grep -c Pr0xy-Secret-77 $B)"
check "  password never audited" 0 "$(grep -c Pr0xy-Secret-77 "$DATA/audit.jsonl")"
: > "$L"
check "new URL, password unchanged: the stored one, read on the server" "200 1 1" "$(conf '{"proxy":{"url":"http://proxy2.example:3128","username":"upd"}}') $(grep -c '^Secret.get_record' "$L") $(grep -c '^pool.configure_repository_proxy \["OpaqueRef:pool","http://proxy2.example:3128","upd","Pr0xy-Secret-77"\]' "$L")"
check "  the answer has no password either" 0 "$(grep -c Pr0xy-Secret-77 $B)"
check "username without a password: XenServer's reason" "502 Enter both a username and a password for the proxy, or neither." "$(conf '{"proxy":{"url":"http://proxy2.example:3128","username":"other","password":""}}') $(field 'd.error' < $B)"
: > "$L"
check "empty URL: proxy off" "200 1" "$(conf '{"proxy":{"url":"","username":""}}') $(grep -c '^pool.disable_repository_proxy' "$L")"
mode slow
code $A -X POST "$U" $J -d '{"hostId":"pool1","action":"sync"}' >/dev/null
check "while synchronizing: refused" 409 "$(conf '{"channel":"early_access"}')"
for _ in $(seq 20); do code $A "$U?hostId=pool1" >/dev/null; [ "$(field 'd.sync.state' < $B)" != running ] && break; sleep 1; done
mode normal
touch "$FX/no-sync-schedule"
code $A "$U?hostId=pool1&fresh=1" >/dev/null
check "older XenServer: no schedule" false "$(field 'd.updates.pool.config.sync.supported' < $B)"
: > "$L"
check "  a schedule sent anyway is not written" "200 0" "$(conf '{"sync":{"enabled":true,"frequency":"daily","day":0}}') $(writes)"
rm -f "$FX/no-sync-schedule"

echo "=== who may ==="
curl -sS $A -X POST "$BASE/api/auth/users" $J -d '{"username":"op1","password":"Maple-Root-2468","role":"operator"}' >/dev/null
curl -sS -c /var/tmp/xu-cookie2 -X POST "$BASE/api/auth/login" $J -d '{"username":"op1","password":"Maple-Root-2468"}' >/dev/null
O="-b /var/tmp/xu-cookie2"
check "operator without a grant: refused" 403 "$(code $O "$U?hostId=pool1")"
curl -sS $A -X PUT "$BASE/api/auth/users/op1" $J -d '{"pools":["pool1"]}' >/dev/null
check "operator with the grant: may read" 200 "$(code $O "$U?hostId=pool1")"
check "  but not start a check" 403 "$(code $O -X POST "$U" $J -d '{"hostId":"pool1","action":"sync"}')"
check "  nor configure updates" 403 "$(code $O -X POST "$U" $J -d '{"hostId":"pool1","action":"configure","config":{"channel":"early_access"}}')"
check "  summary only for granted pools" "pool1" "$(code $O "$U/summary" >/dev/null; field 'd.pools.map(p=>p.hostId).join()' < $B)"
check "anonymous refused" 401 "$(code "$U?hostId=pool1")"
check "no credentials in any answer" 0 "$(cat $B /var/tmp/xu-server.log | grep -c secret)"

echo; echo "$pass passed, $fail failed"
exit $fail
