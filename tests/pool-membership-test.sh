#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Adding a server to a pool and removing one, as XenCenter does (Add New
# Server, Remove From Pool): PoolJoinRules with XenCenter's texts, pool.join
# with the coordinator's address and the pool's credentials, ClearNonSharedSrs,
# pool.eject, the removed server kept as a connection of its own.
# Two fakes: the pool (xs-01, xs-02) and a standalone server xs-03, whose
# pool.join makes it the pool's third host.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xpm-data; FX=/var/tmp/xpm-fake; FX2=/var/tmp/xpm-fake2
PORT=3199; XPORT=4496; XPORT2=4497
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xpm-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX" "$FX2"; mkdir -p "$DATA" "$FX" "$FX2"
echo normal > "$FX/mode"; echo normal > "$FX2/mode"
touch "$FX/local-addresses" "$FX/local-default-sr" "$FX2/standalone"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xpm-fake.log 2>&1 & FPID=$!
FAKE_JOIN_DIR="$FX" "$NODE" $TESTS/fake-xapi.js $XPORT2 "$FX2" >> /var/tmp/xpm-fake2.log 2>&1 & F2PID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 XENMAN_JOIN_WAIT_MS=20000 XENMAN_MEMBER_POLL_MS=300 \
  XENMAN_EJECT_FIRST_WAIT_MS=0 XENMAN_EJECT_POLL_MS=300 XENMAN_EJECT_TRIES=3 \
  npx next start -p $PORT >> /var/tmp/xpm-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID $F2PID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xpm-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
NEW="\"address\":\"127.0.0.1\",\"port\":$XPORT2,\"useSsl\":false,\"username\":\"root\""
reason() { x pool_add_server_check "$NEW,\"password\":\"secret\"" >/dev/null; field 'd.verdict ? d.verdict.reason : d.error' < $BODY; }

echo "=== Add Server: what XenCenter checks first ==="
check "no password: refused" 400 "$(x pool_add_server_check "$NEW")"
check "a wrong password: the login says so" "400 true" "$(x pool_add_server_check "$NEW,\"password\":\"nope\"") $(field '/did not accept the login of "root"/.test(d.error)' < $BODY)"
check "xs-03 as it is: allowed, no question" "null null xs-03" "$(x pool_add_server_check "$NEW,\"password\":\"secret\"" >/dev/null; field 'd.verdict.reason+" "+d.verdict.cpuQuestion+" "+d.verdict.name' < $BODY)"
for f in "named-pool|Cannot add server xs-03 to pool Production: server is already in pool Lab." \
         "joiner-shared-sr|This server has shared storage" \
         "joiner-running-vm|This server has running VMs" \
         "joiner-old-version|This server is a different version to the coordinator" \
         "joiner-free|You cannot add an unlicensed server to a licensed pool"; do
  flagname=${f%%|*}; want=${f#*|}
  touch "$FX2/$flagname"
  check "  $flagname: XenCenter's reason" "$want" "$(reason)"
  rm -f "$FX2/$flagname"
done
touch "$FX2/member-login"
check "  a pool member (HOST_IS_SLAVE): already in a pool" "Cannot add server 127.0.0.1 to pool Production: server is already in pool 127.0.0.1." "$(reason)"
rm -f "$FX2/member-login"
touch "$FX/ha"
check "  HA on in the pool" "HA is enabled on the pool" "$(reason)"
check "  and adding is refused the same" "409 HA is enabled on the pool" "$(x pool_add_server "$NEW,\"password\":\"secret\"") $(field d.error < $BODY)"
rm -f "$FX/ha"
touch "$FX2/joiner-fewer-cpu"
check "  fewer CPU features: allowed, with XenCenter's question" "null true" \
  "$(x pool_add_server_check "$NEW,\"password\":\"secret\"" >/dev/null; field 'd.verdict.reason+" "+d.verdict.cpuQuestion.includes("a pool that is using newer CPUs")' < $BODY)"
check "  adding without the answer: refused" "409 true" "$(x pool_add_server "$NEW,\"password\":\"secret\"") $(field 'd.needsConfirm' < $BODY)"
rm -f "$FX2/joiner-fewer-cpu"

echo "=== Add Server: joining ==="
: > "$FX/calls.log"; : > "$FX2/calls.log"
c=$(x pool_add_server "$NEW,\"password\":\"secret\""); id=$(field d.job.id < $BODY)
for _ in $(seq 60); do x pool_member_job_status "\"jobId\":\"$id\"" >/dev/null; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
check "xs-03 added: done" "202 done" "$c $(field d.job.state < $BODY)"
check "  pool.join on xs-03, with the coordinator's address and the pool's user" 1 "$(grep -c '^join 127.0.0.1 root$' "$FX2/calls.log")"
check "  the pool's default SR was local: default, crash dump and suspend SR cleared" "3" \
  "$(grep -cE '^pool\.set_(default|crash_dump|suspend_image)_SR OpaqueRef:NULL$' "$FX/calls.log")"
x connect '' >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
check "  the pool has three hosts now" "xs-01 xs-02 xs-03" "$(field 'd.hosts.map(h=>h.nameLabel).sort().join(" ")' < $BODY)"
S=$(field d.sessionRef < $BODY)
check "  audited, without the password" "1 0" \
  "$(grep -c '"action":"pool_add_server_finished".*"outcome":"success"' "$DATA/audit.jsonl") $(grep -c 'secret' "$DATA/audit.jsonl")"

echo "=== Remove From Pool ==="
check "the coordinator: refused" "409 You cannot remove the coordinator from the pool." \
  "$(x pool_remove_server '"hostRef":"OpaqueRef:host-1","confirmName":"xs-01"') $(field d.error < $BODY)"
check "xs-02, db-01 running on it: refused" "409 This server has running VMs" \
  "$(x pool_remove_server '"hostRef":"OpaqueRef:host-2","confirmName":"xs-02"') $(field d.error < $BODY)"
check "xs-03 without its name typed: refused" "409 true" "$(x pool_remove_server '"hostRef":"OpaqueRef:host-3"') $(field d.needsConfirm < $BODY)"
check "  with another name: refused" 409 "$(x pool_remove_server '"hostRef":"OpaqueRef:host-3","confirmName":"xs-02"')"
: > "$FX/calls.log"
c=$(x pool_remove_server '"hostRef":"OpaqueRef:host-3","confirmName":"XS-03"'); id=$(field d.job.id < $BODY)
for _ in $(seq 60); do x pool_member_job_status "\"jobId\":\"$id\"" >/dev/null; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.5; done
check "xs-03 removed (the name in any case): done" "202 done" "$c $(field d.job.state < $BODY)"
NEWID=$(field d.job.newHostId < $BODY)
check "  pool.eject" 1 "$(grep -c '^eject xs-03$' "$FX/calls.log")"
check "  kept as a connection of its own, with the pool's credentials" "xs-03 127.0.0.1 $XPORT root" \
  "$("$NODE" -e "const h=JSON.parse(require('fs').readFileSync('$DATA/hosts.json','utf8')).find(h=>h.id==='$NEWID'); console.log([h.name,h.address,h.port,h.username].join(' '))")"
check "  audited" 1 "$(grep -c '"action":"pool_remove_server_finished".*"outcome":"success"' "$DATA/audit.jsonl")"

echo "=== who may ==="
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"op1","password":"Pass-12345-xm","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/op1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xpm-o -X POST $B/api/auth/login $J -d '{"username":"op1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xpm-o -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
OS=$(field d.sessionRef < $BODY)
check "an operator may neither add nor remove" "403 403" \
  "$(x pool_add_server_check "$NEW,\"password\":\"secret\"" "-b /var/tmp/xpm-o" "$OS") $(x pool_remove_server '"hostRef":"OpaqueRef:host-2","confirmName":"xs-02"' "-b /var/tmp/xpm-o" "$OS")"

echo; echo "$pass passed, $fail failed"
exit $fail
