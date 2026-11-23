#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# PVS-Accelerator (lib/xen-pvs.ts) against the stand-in pool's pvs-model: the
# tab as XenCenter's, switching read caching on and off per VM, a site's cache
# storage per host, adding and removing sites -- and who may do what.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/pvs-data; FX=/var/tmp/pvs-fake
PORT=3183; XPORT=4479
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/pvs-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }
ours() { grep '^pvs ' "$FX/calls.log"; }

start_fake() { [ -n "${FPID:-}" ] && kill $FPID 2>/dev/null; sleep 0.3; rm -f "$FX/calls.log" "$FX/state.json"; "$NODE" $TESTS/fake-xapi.js $XPORT "$FX" > /dev/null 2>&1 & FPID=$!; sleep 0.5; }
rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/pvs-model"
start_fake
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT > /var/tmp/pvs-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null' EXIT
for _ in $(seq 60); do curl -s -o /dev/null $B/login && break; sleep 0.5; done
C=/var/tmp/pvs-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
curl -s $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
for u in op5:operator vw5:viewer; do
  curl -s $A -X POST $B/api/auth/users $J -d "{\"username\":\"${u%%:*}\",\"password\":\"Maple-Root-2468\",\"role\":\"${u##*:}\"}" >/dev/null
  curl -s $A -X PUT $B/api/auth/users/${u%%:*} $J -d '{"pools":["pool1"]}' >/dev/null
  curl -s -c /var/tmp/pvs-${u%%:*} -X POST $B/api/auth/login $J -d "{\"username\":\"${u%%:*}\",\"password\":\"Maple-Root-2468\"}" >/dev/null
done
session() { code ${1:-$A} -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; field d.sessionRef < $BODY; }
S=$(session); OS=$(session "-b /var/tmp/pvs-op5"); VS=$(session "-b /var/tmp/pvs-vw5")
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
ov() { x pvs_overview >/dev/null; field "$1" < $BODY; }
GIB=1073741824

echo "=== the tab ==="
check "answers" 200 "$(x pvs_overview)"
check "licensed and able" "true true" "$(field 'd.licensed+" "+d.capable' < $BODY)"
check "VMs: with PVS first, then by name; no dom0" "web-01 Yes Site A Caching|db-01 No - -|old No - -" \
  "$(field 'd.vms.map(v=>[v.name,v.enabled?"Yes":"No",v.siteLabel,v.status].join(" ")).join("|")' < $BODY)"
check "sites: B not completed in PVS" "Site A|Site B (Incomplete PVS configuration)" "$(field 'd.sites.map(s=>s.label).join("|")' < $BODY)"
check "  A's servers" "10.0.0.50,10.0.0.51 6890 6909" "$(field 'const s=d.sites[0].servers[0]; s.addresses+" "+s.firstPort+" "+s.lastPort' < $BODY)"
check "  A on xs-01: memory, 10 GB, in use" "memory 10 true" "$(field 'const h=d.sites[0].hosts.find(h=>h.hostName==="xs-01"); h.storage+" "+h.sizeGb+" "+h.inUse' < $BODY)"
check "  A on xs-02: its local SR, 20 GB, free to change" "OpaqueRef:pvs-sr-local2 20 false" "$(field 'const h=d.sites[0].hosts.find(h=>h.hostName==="xs-02"); h.storage+" "+h.sizeGb+" "+h.inUse' < $BODY)"
check "  xs-01 offers: none, memory (up to 2 GB), its local SR (up to 400 GB); no ISO" "none:- memory:2 OpaqueRef:pvs-sr-local1:400" \
  "$(field 'd.sites[0].hosts.find(h=>h.hostName==="xs-01").options.map(o=>o.value+":"+(o.disabled?"off":(o.maxGb??"-"))).join(" ")' < $BODY)"
check "  xs-02: memory not possible (512 MiB spare), its SR up to 50 GB" "Memory only (Not enough Control Domain memory) true 50" \
  "$(field 'const o=d.sites[0].hosts.find(h=>h.hostName==="xs-02").options; o[1].label+" "+o[1].disabled+" "+o.find(x=>x.value==="OpaqueRef:pvs-sr-local2").maxGb' < $BODY)"
check "a viewer may look" 200 "$(x pvs_overview "" "-b /var/tmp/pvs-vw5" "$VS")"
check "the VM's own status (overview)" "Caching null" "$(x pvs_vm_status '"vmRef":"OpaqueRef:vm-1"' >/dev/null; field d.status < $BODY) $(x pvs_vm_status '"vmRef":"OpaqueRef:vm-2"' >/dev/null; field d.status < $BODY)"

echo "=== read caching on and off ==="
: > "$FX/calls.log"
check "a viewer may not switch it on" 403 "$(x pvs_enable '"vms":["OpaqueRef:vm-2"],"site":"OpaqueRef:pvs-site-a"' "-b /var/tmp/pvs-vw5" "$VS")"
check "an operator may; web-01 already has it, old has no VIF 0" "200 1 web-01 (PVS-Accelerator is already enabled)|old (no network interface 0)" \
  "$(x pvs_enable '"vms":["OpaqueRef:vm-1","OpaqueRef:vm-2","OpaqueRef:vm-3"],"site":"OpaqueRef:pvs-site-a"' "-b /var/tmp/pvs-op5" "$OS") $(field 'd.enabled+" "+d.skipped.join("|")' < $BODY)"
check "  one proxy, on db-01's VIF 0, at site A" "pvs proxy.create Site A OpaqueRef:vm-2" "$(ours)"
check "  db-01 now listed with PVS" "db-01 Yes Site A Initialized" "$(ov 'const v=d.vms.find(v=>v.name==="db-01"); [v.name,v.enabled?"Yes":"No",v.siteLabel,v.status].join(" ")')"
check "without a site: refused" 400 "$(x pvs_enable '"vms":["OpaqueRef:vm-2"]')"
check "a site that is gone: refused" 409 "$(x pvs_enable '"vms":["OpaqueRef:vm-2"],"site":"OpaqueRef:pvs-site-x"')"
: > "$FX/calls.log"
check "switched off for db-01 and old (nothing to do for old)" "200 1" "$(x pvs_disable '"vms":["OpaqueRef:vm-2","OpaqueRef:vm-3"]' "-b /var/tmp/pvs-op5" "$OS") $(field d.disabled < $BODY)"
check "  that proxy destroyed" "pvs proxy.destroy OpaqueRef:vm-2" "$(ours)"

echo "=== a site's cache storage ==="
SA='"site":"OpaqueRef:pvs-site-a","name":"Site A"'
check "an operator may not configure" 403 "$(x pvs_site_save "$SA,\"hosts\":{}" "-b /var/tmp/pvs-op5" "$OS")"
: > "$FX/calls.log"
check "storage in use (xs-01) cannot change" 409 "$(x pvs_site_save "$SA,\"hosts\":{\"OpaqueRef:host-1\":{\"storage\":\"OpaqueRef:pvs-sr-local1\",\"sizeGb\":10}}")"
check "  said why, nothing done" "true 0" "$(field 'd.error.includes("cannot be changed on servers where it is in use")' < $BODY) $(ours | wc -l)"
check "too big for the SR" 409 "$(x pvs_site_save "$SA,\"hosts\":{\"OpaqueRef:host-2\":{\"storage\":\"OpaqueRef:pvs-sr-local2\",\"sizeGb\":60}}")"
check "memory where dom0 has no room" 409 "$(x pvs_site_save "$SA,\"hosts\":{\"OpaqueRef:host-2\":{\"storage\":\"memory\",\"sizeGb\":1}}")"
check "an SR of another host" 409 "$(x pvs_site_save "$SA,\"hosts\":{\"OpaqueRef:host-2\":{\"storage\":\"OpaqueRef:pvs-sr-local1\",\"sizeGb\":10}}")"
check "xs-02 to 30 GB, renamed" 200 "$(x pvs_site_save '"site":"OpaqueRef:pvs-site-a","name":"Site A1","hosts":{"OpaqueRef:host-1":{"storage":"memory","sizeGb":10},"OpaqueRef:host-2":{"storage":"OpaqueRef:pvs-sr-local2","sizeGb":30}}')"
check "  renamed, xs-02's storage destroyed and made again, xs-01 untouched" \
  'pvs site.set_name_label Site A -> Site A1|pvs cache_storage.destroy Site A1 xs-02|pvs cache_storage.create Site A1 xs-02 Local storage on xs-02 30GiB uuid="" VDI=OpaqueRef:NULL' "$(ours | paste -sd'|')"
: > "$FX/calls.log"
check "xs-02 not configured: only destroyed" 200 "$(x pvs_site_save '"site":"OpaqueRef:pvs-site-a","name":"Site A1","hosts":{"OpaqueRef:host-2":{"storage":"none","sizeGb":10}}')"
check "  nothing made instead" "pvs cache_storage.destroy Site A1 xs-02" "$(ours | paste -sd'|')"
check "  the site now incomplete" "Site A1 (Incomplete Cache Storage configuration)" "$(ov 'd.sites.find(s=>s.ref==="OpaqueRef:pvs-site-a").label')"

echo "=== a new site ==="
: > "$FX/calls.log"
check "added: memory on xs-01 (its memory SR), its SR... xs-02 to its local SR" 200 \
  "$(x pvs_site_save '"name":"PVS Site","hosts":{"OpaqueRef:host-1":{"storage":"memory","sizeGb":2},"OpaqueRef:host-2":{"storage":"OpaqueRef:pvs-sr-local2","sizeGb":5}}')"
NEW=$(field d.site < $BODY)
check "  introduced as XenCenter does, then the storage" \
  'pvs site.introduce PVS Site desc="" pvs_uuid=""|pvs cache_storage.create PVS Site xs-01 MemorySR 2GiB uuid="" VDI=OpaqueRef:NULL|pvs cache_storage.create PVS Site xs-02 Local storage on xs-02 5GiB uuid="" VDI=OpaqueRef:NULL' "$(ours | paste -sd'|')"
check "an empty name: refused" 409 "$(x pvs_site_save '"name":"  ","hosts":{}')"

echo "=== memory where there is no memory SR yet ==="
: > "$FX/calls.log"
check "site B on xs-01 in memory" 200 "$(x pvs_site_save '"site":"OpaqueRef:pvs-site-b","name":"Site B","hosts":{"OpaqueRef:host-1":{"storage":"memory","sizeGb":1}}')"
check "  the existing memory SR used, none made" "0" "$(ours | grep -c 'SR.create')"

touch "$FX/pvs-roomy"; : > "$FX/calls.log"
check "memory on xs-02, which has no memory SR yet" 200 "$(x pvs_site_save '"site":"OpaqueRef:pvs-site-b","name":"Site B","hosts":{"OpaqueRef:host-2":{"storage":"memory","sizeGb":1}}')"
check "  the memory SR made as XenCenter makes it, then used" 'pvs SR.create xs-02 {"uri":""} 0 MemorySR "" tmpfs "" false {}|pvs cache_storage.create Site B xs-02 MemorySR 1GiB uuid="" VDI=OpaqueRef:NULL' "$(ours | paste -sd'|')"
rm -f "$FX/pvs-roomy"

echo "=== removing a site ==="
: > "$FX/calls.log"
check "not while VMs are streamed from it" 409 "$(x pvs_site_remove '"site":"OpaqueRef:pvs-site-a"')"
check "  said so" true "$(field 'd.error.includes("there are VMs that are streamed from this site")' < $BODY)"
check "an operator may not" 403 "$(x pvs_site_remove "\"site\":\"$NEW\"" "-b /var/tmp/pvs-op5" "$OS")"
x pvs_disable '"vms":["OpaqueRef:vm-1"]' >/dev/null
: > "$FX/calls.log"
check "site A, nobody streamed any more: its servers forgotten first" 200 "$(x pvs_site_remove '"site":"OpaqueRef:pvs-site-a"')"
check "  then the site" "pvs server.forget OpaqueRef:pvs-srv-1|pvs site.forget Site A1" "$(ours | paste -sd'|')"
check "  gone from the tab (the new one waits for PVS too)" "PVS Site (Incomplete PVS configuration)|Site B (Incomplete PVS configuration)" "$(ov 'd.sites.map(s=>s.label).join("|")')"

echo "=== the audit log ==="
check "switching on, named" 1 "$(grep '"action":"pvs_enable"' $DATA/audit.jsonl | grep '"outcome":"success"' | grep -c 'PVS-Accelerator on for VM')"
check "a site's storage, named (renamed, then not configured)" 2 "$(grep '"action":"pvs_site_save"' $DATA/audit.jsonl | grep '"outcome":"success"' | grep -c 'Site A1')"
check "a refused change, with the reason" true "$(grep '"action":"pvs_site_save"' $DATA/audit.jsonl | grep -q 'in use' && echo true || echo false)"

echo "=== not licensed, too old ==="
touch "$FX/pvs-unlicensed"
check "not licensed: said, and nothing can be changed" "false 409" "$(ov d.licensed) $(x pvs_enable '"vms":["OpaqueRef:vm-2"],"site":"OpaqueRef:pvs-site-b"')"
rm -f "$FX/pvs-unlicensed"; touch "$FX/pvs-old"
check "older XenServer without the pack: not able" false "$(ov d.capable)"
rm -f "$FX/pvs-old"

echo; echo "$pass passed, $fail failed"
exit $fail
