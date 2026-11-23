#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Workload Balancing through /api/xen against the fake pool: status, connecting
# (no password in the audit log), pausing, settings, recommendations and
# applying them only while they stand, a server out of reach, and who may.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/wlb-data; FX=/var/tmp/wlb-fake
PORT=3195; XPORT=4495
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/wlb-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }
pool() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync('$FX/state.json','utf8')); $1"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/wlb-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/wlb-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/wlb-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
check "the pool record carries the WLB fields" "true false" "$(field '"wlbUrl" in d.pools[0]' < $BODY) $(field 'd.pools[0].wlbEnabled' < $BODY)"
x() { # x <cookie args> <action> [json fields] [session]
  code $1 -X POST $B/api/xen $J -d "{\"action\":\"$2\",\"sessionRef\":\"${4:-$S}\"${3:+,$3}}"
}
status() { x "$A" pool_wlb_status >/dev/null; }

echo "=== not connected ==="
status
check "said so" "false" "$(field 'd.configured' < $BODY)"

echo "=== connecting ==="
check "an address without a port: refused" 400 "$(x "$A" pool_wlb_connect '"wlbUrl":"wlb21.example.org","wlbUsername":"wlbuser","wlbPassword":"wlbpass","xsUsername":"svc","xsPassword":"Svc-Pass-9"')"
check "a server that refuses: said why" "400 true" "$(x "$A" pool_wlb_connect '"wlbUrl":"nowhere.example.org:8012","wlbUsername":"wlbuser","wlbPassword":"wlbpass","xsUsername":"svc","xsPassword":"Svc-Pass-9"') $(field 'd.error.includes("refused the connection")' < $BODY)"
check "a wrong WLB password: said why" "400 true" "$(x "$A" pool_wlb_connect '"wlbUrl":"wlb21.example.org:8012","wlbUsername":"wlbuser","wlbPassword":"nope","xsUsername":"svc","xsPassword":"Svc-Pass-9"') $(field 'd.error.includes("did not accept its user name or password")' < $BODY)"
check "connected" 200 "$(x "$A" pool_wlb_connect '"wlbUrl":"https://wlb21.example.org:8012/","wlbUsername":"wlbuser","wlbPassword":"wlbpass","xsUsername":"svc","xsPassword":"Svc-Pass-9","verifyCert":true')"
check "  as given, the address as XAPI wants it" "wlb21.example.org:8012 wlbuser svc 10 true true" "$(pool 'd.wlb.url+" "+d.wlb.username+" "+d.wlb.xsUser+" "+d.wlb.xsPassLength+" "+d.wlb.verifyCert+" "+d.wlb.enabled')"
check "  audited with server and accounts" 1 "$(grep '"action":"pool_wlb_connect"' $DATA/audit.jsonl | grep '"outcome":"success"' | grep -c 'wlb=https://wlb21.example.org:8012/, wlbUser=wlbuser, xenserverUser=svc')"
check "  no password in the audit log, not even a refused one" 0 "$(grep -c -e 'wlbpass' -e 'Svc-Pass-9' -e '"nope"' $DATA/audit.jsonl)"

echo "=== status ==="
status
check "connected, acting, the settings read" "true true wlb21.example.org:8012 0 true null" "$(field 'd.configured+" "+d.enabled+" "+d.url+" "+d.config.OptimizationMode+" "+d.config.AutoBalanceEnabled+" "+d.error' < $BODY)"
check "  no recommendations" 0 "$(field 'd.recommendations.length' < $BODY)"
U1=11111111-1111-4111-8111-111111111111; U2=22222222-2222-4222-8222-222222222222
check "  the hosts, for the settings named by uuid" "xs-01:$U1::true xs-02:$U2:IPMI:false" "$(field 'd.hosts.map(h=>h.name+":"+h.uuid+":"+h.powerOnMode+":"+h.isCoordinator).join(" ")' < $BODY)"

echo "=== pause and resume ==="
check "paused" "200 false" "$(x "$A" pool_wlb_set_enabled '"enabled":false') $(pool 'd.wlb.enabled')"
status
check "  the status says so, and asks WLB nothing it would refuse" "false null 0" "$(field 'd.enabled+" "+d.error+" "+d.recommendations.length' < $BODY)"
check "  audited as paused" 1 "$(grep '"action":"pool_wlb_set_enabled"' $DATA/audit.jsonl | grep -c 'paused')"
check "resumed" "200 true" "$(x "$A" pool_wlb_set_enabled '"enabled":true') $(pool 'd.wlb.enabled')"
check "not a boolean: refused" 400 "$(x "$A" pool_wlb_set_enabled '"enabled":"yes"')"

echo "=== settings ==="
check "sent" 200 "$(x "$A" pool_wlb_configure '"config":{"OptimizationMode":"1","AutoBalanceEnabled":"false"}')"
check "  only what was given" '[{"OptimizationMode":"1","AutoBalanceEnabled":"false"}]' "$(pool 'JSON.stringify(d.wlb.sent)')"
check "  audited with what changed" 1 "$(grep '"action":"pool_wlb_configure"' $DATA/audit.jsonl | grep -c 'OptimizationMode=1, AutoBalanceEnabled=false')"
last_sent() { pool "JSON.stringify(d.wlb.sent[d.wlb.sent.length-1])"; }
EX="host_${U2}_ExcludeFromPlacementRecommendations host_${U2}_ExcludeFromEvacuationRecommendations host_${U2}_ExcludeFromPoolOptimizations host_${U2}_ExcludeFromPoolOptimizationAcceptVMs"
excl() { # excl <true|false|True> -- the four keys for xs-02, as the dialog sends them
  local j=""; for k in $EX; do j="$j\"$k\":\"$1\","; done
  x "$A" pool_wlb_configure "\"config\":{${j%,}}"
}
check "excluding a host: accepted" 200 "$(excl true)"
check "  sent as XenCenter does: with set_host_configuration, every host's settings" "true False" "$(pool "d.wlb.sent[d.wlb.sent.length-1].set_host_configuration") $(pool "d.wlb.sent[d.wlb.sent.length-1]['host_${U1}_ParticipatesInPowerManagement']")"
check "  the four set, kept per host -- not twice" "true,true,true,true null" "$(pool "'$EX'.split(' ').map(k=>d.wlb.config[k]).join()") $(pool 'd.wlb.broken')"
check "  the settings still readable" "200 null" "$(x "$A" pool_wlb_status) $(field 'd.error' < $BODY)"
check "  the status says the host is excluded" true "$(field "'$EX'.split(' ').every(k=>d.config[k]==='true')" < $BODY)"
check "included again, a value written True arrives as true" "200 false,false,false,false" "$(excl False) $(pool "'$EX'.split(' ').map(k=>d.wlb.config[k]).join()")"
check "a pool setting alone: no host settings, no flag" "200 false" "$(x "$A" pool_wlb_configure '"config":{"OptimizationMode":"0"}') $(last_sent | "$NODE" -pe 'const d=JSON.parse(require("fs").readFileSync(0)); "set_host_configuration" in d || Object.keys(d).some(k=>k.startsWith("host_"))')"
check "power management for a host" "200 true" "$(x "$A" pool_wlb_configure "\"config\":{\"host_${U2}_ParticipatesInPowerManagement\":\"true\"}") $(pool "d.wlb.config['host_${U2}_ParticipatesInPowerManagement']")"
check "a misspelt per-host key (the one that broke a pool): refused, not sent" "400 true null" "$(x "$A" pool_wlb_configure "\"config\":{\"host_${U1}_ExcludedFromPoolOptimizationAcceptVMs\":\"true\"}") $(field 'd.error.includes("does not set")' < $BODY) $(pool 'd.wlb.broken')"
check "WLB's own record (LastPowerOnSucceeded): refused" 400 "$(x "$A" pool_wlb_configure "\"config\":{\"host_${U1}_LastPowerOnSucceeded\":\"true\"}")"
check "a host not in this pool: refused" "400 true" "$(x "$A" pool_wlb_configure '"config":{"host_5f3cd463-8962-42d9-8143-b86df75b1e7b_ExcludeFromPoolOptimizations":"true"}') $(field 'd.error.includes("not in this pool")' < $BODY)"
check "a per-host value not true or false: refused" 400 "$(x "$A" pool_wlb_configure "\"config\":{\"host_${U1}_ExcludeFromPoolOptimizations\":\"yes\"}")"
check "the flag itself, from outside: refused" 400 "$(x "$A" pool_wlb_configure '"config":{"set_host_configuration":"true"}')"
check "  nothing broke on the way" "200 null" "$(x "$A" pool_wlb_status) $(field 'd.error' < $BODY)"
check "a pool setting WLB does not have: refused" "400 true" "$(x "$A" pool_wlb_configure '"config":{"MadeUpSetting":"1"}') $(field 'd.error.includes("not a setting Workload Balancing has")' < $BODY)"
check "what WLB reports about itself: refused" 400 "$(x "$A" pool_wlb_configure '"config":{"WlbVersion":"9.9"}')"
check "a key with a space: refused, named" "400 true" "$(x "$A" pool_wlb_configure '"config":{"bad key":"1"}') $(field 'd.error.includes("bad key")' < $BODY)"
check "a key with a space: refused" 400 "$(x "$A" pool_wlb_configure '"config":{"bad key":"1"}')"
check "a value not a string: refused" 400 "$(x "$A" pool_wlb_configure '"config":{"OptimizationMode":1}')"
check "nothing: refused" 400 "$(x "$A" pool_wlb_configure '"config":{}')"

echo "=== recommendations ==="
touch "$FX/wlb-rec"
status
check "named: VM, from, to, why" "1 move web-01 xs-01 xs-02 CpuUsage" "$(field 'const r=d.recommendations; r.length+" "+r[0].kind+" "+r[0].vmName+" "+r[0].fromHost+" "+r[0].toHost+" "+r[0].reason' < $BODY)"
check "applied to another host than WLB says: refused" "409 xs-01" "$(x "$A" pool_wlb_apply '"vmRef":"OpaqueRef:vm-1","targetHostRef":"OpaqueRef:host-1"') $(pool 'd.vms["web-01"]')"
check "a VM WLB has nothing for: refused" 409 "$(x "$A" pool_wlb_apply '"vmRef":"OpaqueRef:vm-2","targetHostRef":"OpaqueRef:host-1"')"
check "applied as recommended" 200 "$(x "$A" pool_wlb_apply '"vmRef":"OpaqueRef:vm-1","targetHostRef":"OpaqueRef:host-2"')"
T=$(field d.taskRef < $BODY)
for _ in $(seq 30); do x "$A" task_status "\"taskRef\":\"$T\"" >/dev/null; [ "$(field d.status < $BODY)" != pending ] && break; sleep 0.3; done
check "  moved" "success xs-02" "$(field d.status < $BODY) $(pool 'd.vms["web-01"]')"
status
check "  and recommended no more" 0 "$(field 'd.recommendations.length' < $BODY)"
rm -f "$FX/wlb-rec"

echo "=== the WLB server out of reach ==="
touch "$FX/wlb-unreachable"
check "the status still answers, with the reason" "200 true true" "$(x "$A" pool_wlb_status) $(field 'd.configured' < $BODY) $(field 'd.error.includes("refused the connection")' < $BODY)"
rm -f "$FX/wlb-unreachable"

echo "=== who may ==="
for u in op1:operator viewer1:viewer; do
  n=${u%%:*}; r=${u##*:}
  curl -s $A -X POST $B/api/auth/users $J -d "{\"username\":\"$n\",\"password\":\"Pass-12345-xm\",\"role\":\"$r\"}" >/dev/null
  curl -s $A -X PUT $B/api/auth/users/$n $J -d '{"pools":["pool1"]}' >/dev/null
  curl -s -c /var/tmp/wlb-$n -X POST $B/api/auth/login $J -d "{\"username\":\"$n\",\"password\":\"Pass-12345-xm\"}" >/dev/null
  code -b /var/tmp/wlb-$n -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
  US=$(field d.sessionRef < $BODY)
  check "$r: sees the status" "200 true" "$(x "-b /var/tmp/wlb-$n" pool_wlb_status "" "$US") $(field 'd.configured' < $BODY)"
  got=""
  for a in pool_wlb_connect pool_wlb_disconnect pool_wlb_set_enabled pool_wlb_configure pool_wlb_apply; do
    got="$got $(x "-b /var/tmp/wlb-$n" $a '"enabled":false,"config":{"OptimizationMode":"0"},"vmRef":"OpaqueRef:vm-1","targetHostRef":"OpaqueRef:host-1"' "$US")"
  done
  check "  changes nothing" " 403 403 403 403 403" "$got"
done
check "  WLB untouched by them" "true wlb21.example.org:8012" "$(pool 'd.wlb.enabled+" "+d.wlb.url')"

echo "=== disconnecting ==="
check "disconnected" "200 " "$(x "$A" pool_wlb_disconnect) $(pool 'd.wlb.url')"
status
check "  not connected any more" false "$(field 'd.configured' < $BODY)"

echo; echo "$pass passed, $fail failed"
exit $fail
