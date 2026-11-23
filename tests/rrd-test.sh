#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Performance graphs: the rrd action of /api/xen against the stand-in pool --
# asked of the right host, shaped into charts, and only for who may see it.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/rrd-data
FX=/var/tmp/fake-xapi-rrd
PORT=3122; XPORT=4482
BASE="http://127.0.0.1:$PORT"
NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
B=/var/tmp/rrd-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $B -w "%{http_code}" "$@"; }
J='-H Content-Type:application/json'
X="$BASE/api/xen"

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" > /var/tmp/rrd-fake.log 2>&1 & FPID=$!
cd "$W"
DATA_DIR="$DATA" NEXT_TELEMETRY_DISABLED=1 XENMAN_RRD_CACHE_MS=1 npx next start -p $PORT > /var/tmp/rrd-server.log 2>&1 & PID=$!
trap 'kill $PID $FPID 2>/dev/null' EXIT
for _ in $(seq 40); do curl -sS -o /dev/null "$BASE/login" 2>/dev/null && break; sleep 1; done
C=/var/tmp/rrd-cookie
curl -sS -c $C -X POST "$BASE/api/auth/login" $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -sS -b $C -c $C -X POST "$BASE/api/auth/change-password" $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
A="-b $C"
curl -sS $A -X POST "$BASE/api/hosts" $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
check "connected" 200 "$(code $A -X POST $X $J -d '{"action":"connect","hostId":"pool1"}')"
S=$(field d.sessionRef < $B)
rrd() { code ${2:-$A} -X POST $X $J -d "{\"action\":\"rrd\",\"sessionRef\":\"${3:-$S}\",$1}"; }
calls() { grep -c "$1" "$FX/calls.log"; }

echo "=== a host ==="
check "answers" 200 "$(rrd '"hostRef":"OpaqueRef:host-1","period":"10m"')"
check "charts for a host" "cpu memory network load" "$(field 'd.charts.map(c=>c.id).join(" ")' < $B)"
check "asked of that host, 5 s steps" 1 "$(calls 'GET /rrd_updates xs-01 host=true interval=5 cf=AVERAGE')"
check "time oldest first" true "$(field 'd.times[0] < d.times[2]' < $B)"
check "CPU: average of the cores, in percent" "20 30 40" "$(field 'd.charts[0].lines[0].values.map(v=>Math.round(v)).join(" ")' < $B)"
check "  named by core count, scale to 100" "2 CPUs 100" "$(field 'd.charts[0].lines[0].label+" "+d.charts[0].max' < $B)"
check "memory used in bytes, scale the total" "17179869184 68719476736" "$(field 'd.charts[1].lines[0].values[0]+" "+d.charts[1].max' < $B)"
check "network: XenServer's own sum of the interfaces" "1500 2500" "$(field 'd.charts[2].lines[0].values[0]+" "+d.charts[2].lines[1].values[0]' < $B)"
check "a gap stays a gap" "0.5 null 0.5" "$(field 'd.charts[3].lines[0].values.map(String).join(" ")' < $B)"
check "the host's VMs are not mixed in" 1 "$(field 'd.charts[0].lines.length' < $B)"
rrd '"hostRef":"OpaqueRef:host-2","period":"2h"' >/dev/null
check "the other host asked at its own address, minute steps" 1 "$(calls 'GET /rrd_updates xs-02 host=true interval=60')"
rrd '"hostRef":"OpaqueRef:host-1","period":"1w"' >/dev/null
rrd '"hostRef":"OpaqueRef:host-1","period":"1y"' >/dev/null
check "week and year: hours and days" "1 1" "$(calls 'xs-01 host=true interval=3600') $(calls 'xs-01 host=true interval=86400')"

echo "=== a VM ==="
check "answers" 200 "$(rrd '"vmRef":"OpaqueRef:vm-1","period":"10m"')"
check "charts for a VM" "cpu memory network disk" "$(field 'd.charts.map(c=>c.id).join(" ")' < $B)"
check "asked of the host it runs on, its whole export, as XenCenter does" "2 0" "$(calls 'GET /rrd_updates xs-01 host=true interval=5') $(calls vm_uuid)"
check "CPU" 38 "$(field 'Math.round(d.charts[0].lines[0].values[0])' < $B)"
check "memory in use: assigned minus free inside" "Memory 3221225472 4294967296" "$(field 'd.charts[1].title+" "+d.charts[1].lines[0].values[0]+" "+d.charts[1].max' < $B)"
check "network: all its interfaces" "150 200" "$(field 'd.charts[2].lines[0].values[0]+" "+d.charts[2].lines[1].values[0]' < $B)"
check "disk: all its disks" "5120 8192" "$(field 'd.charts[3].lines[0].values[0]+" "+d.charts[3].lines[1].values[0]' < $B)"
rrd '"vmRef":"OpaqueRef:vm-2","period":"10m"' >/dev/null
check "a VM on the other host: asked there, only its data" "1 cpu memory network disk" "$(calls 'GET /rrd_updates xs-02 host=true interval=5') $(field 'd.charts.map(c=>c.id).join(" ")' < $B)"
check "  nothing to show: no diagnostics either" false "$(field '"received" in d' < $B)"
touch "$FX/rrd-empty"
rrd '"vmRef":"OpaqueRef:vm-1","period":"10m"' >/dev/null
check "an empty answer: said what came" "0 0 true" "$(field 'd.received.columns+" "+d.received.rows+" "+d.received.head.startsWith("<xport>")' < $B)"
rm -f "$FX/rrd-empty"
N=$(grep -c 'GET /rrd_updates' "$FX/calls.log")
check "a stopped VM: said, nothing asked" "200 true $N" "$(rrd '"vmRef":"OpaqueRef:vm-3","period":"10m"') $(field d.notRunning < $B) $(grep -c 'GET /rrd_updates' "$FX/calls.log")"

echo "=== the answer as JSON, as XenServer 8 sends it ==="
touch "$FX/rrd-json"
rrd '"hostRef":"OpaqueRef:host-1","period":"10m"' >/dev/null
check "host charts" "cpu memory network load" "$(field 'd.charts.map(c=>c.id).join(" ")' < $B)"
check "  the load's scale starts no lower than 0.5, the others as before" "0.5 undefined" "$(field 'd.charts.find(c=>c.id==="load").minTop+" "+d.charts.find(c=>c.id==="cpu").minTop' < $B)"
check "  values read, a bare NaN a gap" "20 30 40|0.5 null 0.5" "$(field 'd.charts[0].lines[0].values.map(v=>Math.round(v)).join(" ")+"|"+d.charts[3].lines[0].values.map(String).join(" ")' < $B)"
check "  oldest first" true "$(field 'd.times[0] < d.times[2]' < $B)"
rrd '"vmRef":"OpaqueRef:vm-1","period":"10m"' >/dev/null
check "VM charts" "cpu memory network disk 3221225472" "$(field 'd.charts.map(c=>c.id).join(" ")+" "+d.charts[1].lines[0].values[0]' < $B)"
rm -f "$FX/rrd-json"

echo "=== the whole pool ==="
check "answers" 200 "$(rrd '"pool":true,"period":"10m"')"
check "charts for a pool" "cpu memory network load" "$(field 'd.charts.map(c=>c.id).join(" ")' < $B)"
check "  the pool's load too" 0.5 "$(field 'd.charts.find(c=>c.id==="load").minTop' < $B)"
check "one line per host, the coordinator first" "xs-01 xs-02" "$(field 'd.charts[0].lines.map(l=>l.label).join(" ")' < $B)"
check "each host asked at its own address" "1 1" "$(calls 'GET /rrd_updates xs-01 host=true interval=5' >/dev/null; grep -c 'xs-01 host=true interval=5' "$FX/calls.log" | awk '{print ($1>0)}') $(grep -c 'xs-02 host=true interval=5' "$FX/calls.log" | awk '{print ($1>0)}')"
check "CPU per host, in percent" "20 30 40|20 30 40" "$(field 'd.charts[0].lines.map(l=>l.values.map(v=>Math.round(v)).join(" ")).join("|")' < $B)"
check "memory used in percent of each host" "25 100" "$(field 'Math.round(d.charts[1].lines[0].values[0])+" "+d.charts[1].max' < $B)"
check "network: in and out together" 4000 "$(field 'd.charts[2].lines[0].values[0]' < $B)"
check "  nothing missing" false "$(field '"missing" in d' < $B)"
touch "$FX/rrd-h2-down"
rrd '"pool":true,"period":"10m"' >/dev/null
check "a host that does not answer: left out and named" "xs-01|xs-02" "$(field 'd.charts[0].lines.map(l=>l.label).join(" ")+"|"+d.missing.join(" ")' < $B)"
rm -f "$FX/rrd-h2-down"

echo "=== data sources for graphs of one's own ==="
xen() { code ${3:-$A} -X POST $X $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\",$2}"; }
check "a VM's list" 200 "$(xen rrd_sources '"vmRef":"OpaqueRef:vm-1"')"
check "  name, unit, recorded or not" "12 cpu0:(fraction):true vbd_xvda_read_latency:μs:false" "$(field 'd.sources.length+" "+["cpu0","vbd_xvda_read_latency"].map(n=>{const x=d.sources.find(s=>s.name===n);return n+":"+x.units+":"+x.enabled}).join(" ")' < $B)"
check "  XenServer's bare Infinity and NaN read, strings untouched" "About cpu0 (max Infinity, else NaN)" "$(field 'd.sources[0].description' < $B)"
check "  sorted, cpu2 before cpu10 style" "cpu0 cpu1" "$(field 'd.sources.slice(0,2).map(s=>s.name).join(" ")' < $B)"
check "  a stopped VM: said" "200 true" "$(xen rrd_sources '"vmRef":"OpaqueRef:vm-3"') $(field d.notRunning < $B)"
check "a host's list" "200 true" "$(xen rrd_sources '"hostRef":"OpaqueRef:host-2"') $(field 'd.sources.some(s=>s.name==="iops_total_c8ae5f3b")' < $B)"
check "a pool's: the coordinator's" "200 1" "$(xen rrd_sources '"pool":true') $(calls 'host.get_data_sources \["OpaqueRef:host-1"\]')"

SRC='"sources":[{"source":"vbd_*_read","units":"B/s"},{"source":"cpu*","units":"(fraction)"},{"source":"vbd_*_read_latency","units":"\u03bcs"},{"source":"memory_internal_free","units":"KiB"}]'
check "a VM with sources asked for" 200 "$(rrd "\"vmRef\":\"OpaqueRef:vm-1\",\"period\":\"10m\",$SRC")"
check "  the built-in charts as before" "cpu memory network disk" "$(field 'd.charts.map(c=>c.id).join(" ")' < $B)"
check "  a pattern: every disk, one line each" "vbd_xvda_read=4096 vbd_xvdb_read=1024 bytesPerSecond" "$(field 'const s=d.sources["vbd_*_read"]; s.lines.map(l=>l.name+"="+l.values[0]).join(" ")+" "+s.unit' < $B)"
check "  cpu*: each core, in percent" "cpu0=50 cpu1=25 percent" "$(field 'const s=d.sources["cpu*"]; s.lines.map(l=>l.name+"="+l.values[0]).join(" ")+" "+s.unit' < $B)"
check "  KiB in bytes" "1073741824 bytes" "$(field 'const s=d.sources["memory_internal_free"]; s.lines[0].values[0]+" "+s.unit' < $B)"
check "  not recorded: no lines, no error" 0 "$(field 'd.sources["vbd_*_read_latency"].lines.length' < $B)"
HS='"sources":[{"source":"iops_total_*","units":"requests/s"},{"source":"loadavg","units":"(fraction)"},{"source":"memory_free_kib","units":"KiB"}]'
check "a host with sources asked for" 200 "$(rrd "\"hostRef\":\"OpaqueRef:host-1\",\"period\":\"10m\",$HS")"
check "  an SR's IOPS: per second, with what it counts" "120 perSecond requests" "$(field 'const s=d.sources["iops_total_*"]; s.lines[0].values[0]+" "+s.unit+" "+s.suffix' < $B)"
check "  the load stays a number, not percent" "0.5 number" "$(field 'const s=d.sources.loadavg; s.lines[0].values[0]+" "+s.unit' < $B)"
check "  the VMs' sources are not the host's" 1 "$(field 'd.sources["iops_total_*"].lines.length' < $B)"
PS='"sources":[{"source":"cpu*","units":"(fraction)"},{"source":"iops_total_*","units":"requests/s"}]'
check "the pool with sources asked for" 200 "$(rrd "\"pool\":true,\"period\":\"10m\",$PS")"
check "  one line per host, the cores averaged" "xs-01:20,30,40 xs-02:20,30,40" "$(field 'd.sources["cpu*"].lines.map(l=>l.name+":"+l.values.map(v=>Math.round(v))).join(" ")' < $B)"
check "  each host its own value" "xs-01:120 xs-02:80" "$(field 'd.sources["iops_total_*"].lines.map(l=>l.name+":"+l.values[0]).join(" ")' < $B)"
check "  on the pool's time axis" true "$(field 'd.sources["cpu*"].lines.every(l=>l.values.length===d.times.length)' < $B)"
check "an invalid source name" 400 "$(rrd '"vmRef":"OpaqueRef:vm-1","period":"10m","sources":[{"source":"a b","units":""}]')"
check "  a source without unit field" 400 "$(rrd '"vmRef":"OpaqueRef:vm-1","period":"10m","sources":[{"source":"cpu0"}]')"
MANY=$("$NODE" -e 'console.log(JSON.stringify(Array.from({length:33},(_,i)=>({source:"cpu"+i,units:""}))))')
check "  more than 32 sources" 400 "$(rrd "\"vmRef\":\"OpaqueRef:vm-1\",\"period\":\"10m\",\"sources\":$MANY")"

echo "=== switching recording on ==="
check "a pattern is not a name" 400 "$(xen rrd_record '"vmRef":"OpaqueRef:vm-1","sources":["vbd_*_read_latency"]')"
check "  nothing" 400 "$(xen rrd_record '"vmRef":"OpaqueRef:vm-1","sources":[]')"
check "  one XenServer does not know: refused by it" false "$(xen rrd_record '"vmRef":"OpaqueRef:vm-1","sources":["no_such_thing"]' | grep -q '^2' && echo true || echo false)"
check "on a VM, by an admin" 200 "$(xen rrd_record '"vmRef":"OpaqueRef:vm-1","sources":["vbd_xvda_read_latency","vbd_xvdb_read_latency"]')"
check "  XenServer asked for each" 2 "$(calls 'VM.record_data_source \["OpaqueRef:vm-1","vbd_xvd._read_latency"\]')"
xen rrd_sources '"vmRef":"OpaqueRef:vm-1"' >/dev/null
check "  listed as recorded now" true "$(field 'd.sources.find(s=>s.name==="vbd_xvda_read_latency").enabled' < $B)"
rrd "\"vmRef\":\"OpaqueRef:vm-1\",\"period\":\"10m\",$SRC" >/dev/null
check "  and drawn: microseconds in seconds" "vbd_xvda_read_latency=0.0015 vbd_xvdb_read_latency=0.0005 seconds" "$(field 'const s=d.sources["vbd_*_read_latency"]; s.lines.map(l=>l.name+"="+l.values[0]).join(" ")+" "+s.unit' < $B)"
check "  only on that VM" 0 "$(rrd "\"vmRef\":\"OpaqueRef:vm-2\",\"period\":\"10m\",$SRC" >/dev/null; field 'd.sources["vbd_*_read_latency"].lines.length' < $B)"
check "for a pool: on every host" "200 1 1" "$(xen rrd_record '"pool":true,"sources":["xapi_open_fds"]') $(calls 'host.record_data_source \["OpaqueRef:host-1","xapi_open_fds"\]') $(calls 'host.record_data_source \["OpaqueRef:host-2","xapi_open_fds"\]')"
check "audited, with the sources" 1 "$(grep '"action":"rrd_record"' "$DATA/audit.jsonl" | grep '"outcome":"success"' | grep -c 'sources=vbd_xvda_read_latency,vbd_xvdb_read_latency')"

echo "=== the graphs, the same for everyone ==="
G="$BASE/api/perf-graphs"
check "the defaults without a file" "200 cpu memory network disk|cpu memory network load|cpu memory network load" "$(code $A $G) $(field '["vm","host","pool"].map(k=>d.graphs[k].map(g=>g.builtin).join(" ")).join("|")' < $B)"
put() { code ${2:-$A} -X PUT $G $J -d "$1"; }
VMG='{"kind":"vm","graphs":[{"id":"cpu","builtin":"cpu"},{"id":"g1","name":"Disk latency","lines":[{"source":"vbd_*_read_latency","units":"\u03bcs","color":"var(--chart-2)"},{"source":"cpu0","units":"(fraction)","color":"#a855f7"}]},{"id":"memory","builtin":"memory","hidden":true}]}'
check "saved by an admin" 200 "$(put "$VMG")"
check "  read back, in the order given" "cpu g1 memory:hidden" "$(code $A $G >/dev/null; field 'd.graphs.vm.map(g=>g.id+(g.hidden?":hidden":"")).join(" ")' < $B)"
check "  the lines as given" "vbd_*_read_latency μs var(--chart-2)|cpu0 (fraction) #a855f7" "$(field 'd.graphs.vm[1].lines.map(l=>l.source+" "+l.units+" "+l.color).join("|")' < $B)"
check "  the other kinds untouched" "cpu memory network load" "$(field 'd.graphs.host.map(g=>g.id).join(" ")' < $B)"
check "an unknown built-in graph" 400 "$(put '{"kind":"vm","graphs":[{"id":"x","builtin":"load"}]}')"
check "an id twice" 400 "$(put '{"kind":"vm","graphs":[{"id":"cpu","builtin":"cpu"},{"id":"cpu","builtin":"memory"}]}')"
check "a pool graph with two sources" 400 "$(put '{"kind":"pool","graphs":[{"id":"p","name":"x","lines":[{"source":"cpu0","units":"","color":"#000000"},{"source":"cpu1","units":"","color":"#000000"}]}]}')"
check "no name" 400 "$(put '{"kind":"host","graphs":[{"id":"h","name":" ","lines":[{"source":"cpu0","units":"","color":"#000000"}]}]}')"
check "not a source name" 400 "$(put '{"kind":"host","graphs":[{"id":"h","name":"x","lines":[{"source":"cpu0;rm","units":"","color":"#000000"}]}]}')"
check "not a colour" 400 "$(put '{"kind":"host","graphs":[{"id":"h","name":"x","lines":[{"source":"cpu0","units":"","color":"red;x:url(y)"}]}]}')"
check "an unknown kind" 400 "$(put '{"kind":"sr","graphs":[]}')"
TOO=$("$NODE" -e 'console.log(JSON.stringify({kind:"host",graphs:Array.from({length:31},(_,i)=>({id:"g"+i,name:"g"+i,lines:[{source:"cpu0",units:"",color:"#000000"}]}))}))')
check "more than 30 graphs" 400 "$(put "$TOO")"
check "  nothing changed by what was refused" "cpu g1 memory" "$(code $A $G >/dev/null; field 'd.graphs.vm.map(g=>g.id).join(" ")' < $B)"
check "a pool graph of one host source" 200 "$(put '{"kind":"pool","graphs":[{"id":"p1","name":"SR IOPS","lines":[{"source":"iops_total_*","units":"requests/s","color":"var(--chart-1)"}]},{"id":"cpu","builtin":"cpu"}]}')"
check "back to the defaults" "200 cpu memory network disk" "$(put '{"kind":"vm","reset":true}') $(field 'd.graphs.vm.map(g=>g.id).join(" ")' < $B)"
check "  only that kind" "p1 cpu" "$(field 'd.graphs.pool.map(g=>g.id).join(" ")' < $B)"
check "audited" 3 "$(grep -c '"action":"perf_graphs_saved"' "$DATA/audit.jsonl")"
cp "$DATA/perf-graphs.json" /var/tmp/rrd-graphs.bak
echo '{"host":[{"id":"x","builtin":"nonsense"}],"pool":"garbage"}' > "$DATA/perf-graphs.json"
check "a broken file: the defaults" "cpu memory network load|cpu memory network load" "$(code $A $G >/dev/null; field 'd.graphs.host.map(g=>g.id).join(" ")+"|"+d.graphs.pool.map(g=>g.id).join(" ")' < $B)"
cp /var/tmp/rrd-graphs.bak "$DATA/perf-graphs.json"

echo "=== update state of all pools (dashboard) ==="
curl -s $A "$BASE/api/xen-updates/summary" > $B
check "per pool: name, hosts, version, last check" "Production 2 XenServer 8.4.0 true" "$(field 'const p=d.pools[0]; p.name+" "+p.hosts+" "+p.versions.join(",")+" "+Boolean(p.lastSync)' < $B)"
check "  and what is behind (hosts, distinct updates)" "2 2" "$(field 'd.pools[0].hostsBehind+" "+d.pools[0].updates' < $B)"

echo "=== what is refused ==="
check "an unknown period" 400 "$(rrd '"hostRef":"OpaqueRef:host-1","period":"5y"')"
check "neither host nor VM" 400 "$(rrd '"period":"10m"')"
check "not a ref" 400 "$(rrd '"hostRef":"http://evil/","period":"10m"')"
check "an address from the browser is ignored" 0 "$(rrd '"hostRef":"OpaqueRef:host-1","period":"10m","host":"203.0.113.9"' >/dev/null; grep -c 203.0.113.9 "$FX/calls.log")"
check "no session" 401 "$(rrd '"hostRef":"OpaqueRef:host-1","period":"10m"' "$A" "OpaqueRef:nothing")"

curl -sS $A -X POST "$BASE/api/auth/users" $J -d '{"username":"view1","password":"Birch-Leaf-1357","role":"viewer"}' >/dev/null
curl -sS $A -X PUT "$BASE/api/auth/users/view1" $J -d '{"pools":["pool1"]}' >/dev/null
curl -sS $A -X POST "$BASE/api/auth/users" $J -d '{"username":"view2","password":"Birch-Leaf-1357","role":"viewer"}' >/dev/null
curl -sS -c /var/tmp/rrd-v1 -X POST "$BASE/api/auth/login" $J -d '{"username":"view1","password":"Birch-Leaf-1357"}' >/dev/null
curl -sS -c /var/tmp/rrd-v2 -X POST "$BASE/api/auth/login" $J -d '{"username":"view2","password":"Birch-Leaf-1357"}' >/dev/null
code -b /var/tmp/rrd-v1 -X POST $X $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
V1=$(field d.sessionRef < $B)
check "a viewer with the pool may see it" 200 "$(rrd '"vmRef":"OpaqueRef:vm-1","period":"10m"' "-b /var/tmp/rrd-v1" "$V1")"
check "a viewer without the pool may not connect" 403 "$(code -b /var/tmp/rrd-v2 -X POST $X $J -d '{"action":"connect","hostId":"pool1"}')"
check "  nor use someone else's session" 403 "$(rrd '"vmRef":"OpaqueRef:vm-1","period":"10m"' "-b /var/tmp/rrd-v2" "$S")"
check "a viewer may list the data sources" 200 "$(xen rrd_sources '"vmRef":"OpaqueRef:vm-1"' "-b /var/tmp/rrd-v1" "$V1")"
check "  but not switch recording on" 403 "$(xen rrd_record '"vmRef":"OpaqueRef:vm-1","sources":["vbd_xvda_read_latency"]' "-b /var/tmp/rrd-v1" "$V1")"
check "  the refusal audited" 1 "$(grep '"action":"rrd_record"' "$DATA/audit.jsonl" | grep -c '"outcome":"denied"')"
check "a viewer sees the graphs" "200 p1" "$(code -b /var/tmp/rrd-v1 $G) $(field 'd.graphs.pool[0].id' < $B)"
check "  but does not change them" 403 "$(put '{"kind":"vm","reset":true}' "-b /var/tmp/rrd-v1")"
curl -sS $A -X POST "$BASE/api/auth/users" $J -d '{"username":"oper1","password":"Maple-Root-1357","role":"operator"}' >/dev/null
curl -sS -c /var/tmp/rrd-o1 -X POST "$BASE/api/auth/login" $J -d '{"username":"oper1","password":"Maple-Root-1357"}' >/dev/null
check "an operator does" 200 "$(put '{"kind":"host","graphs":[{"id":"load","builtin":"load"},{"id":"cpu","builtin":"cpu"}]}' "-b /var/tmp/rrd-o1")"
check "  not signed in: neither" "401 401" "$(code $G) $(put '{"kind":"vm","reset":true}' "-H X-Nobody:1")"
echo "=== a load graph's scale floor ==="
check "set on the built-in load graph, kept" "200 2" "$(put '{"kind":"host","graphs":[{"id":"load","builtin":"load","minTop":2},{"id":"cpu","builtin":"cpu"}]}') $(code $A $G >/dev/null; field 'd.graphs.host.find(g=>g.id==="load").minTop' < $B)"
check "  on a graph of only loadavg, kept" "200 0.8" "$(put '{"kind":"host","graphs":[{"id":"l2","name":"Load","minTop":0.8,"lines":[{"source":"loadavg","units":"","color":"#a855f7"}]}]}') $(code $A $G >/dev/null; field 'd.graphs.host[0].minTop' < $B)"
check "on CPU: refused" 400 "$(put '{"kind":"host","graphs":[{"id":"cpu","builtin":"cpu","minTop":5}]}')"
check "on a graph of other sources: refused" 400 "$(put '{"kind":"host","graphs":[{"id":"x","name":"X","minTop":1,"lines":[{"source":"memory_free_kib","units":"KiB","color":"#a855f7"}]}]}')"
check "0, below, or not a number: refused" "400 400 400" "$(put '{"kind":"host","graphs":[{"id":"load","builtin":"load","minTop":0}]}') $(put '{"kind":"host","graphs":[{"id":"load","builtin":"load","minTop":-1}]}') $(put '{"kind":"host","graphs":[{"id":"load","builtin":"load","minTop":"1"}]}')"
check "  more than 1000: refused" 400 "$(put '{"kind":"host","graphs":[{"id":"load","builtin":"load","minTop":5000}]}')"
check "left out: the default again" "200 undefined" "$(put '{"kind":"host","graphs":[{"id":"load","builtin":"load"}]}') $(code $A $G >/dev/null; field 'String(d.graphs.host[0].minTop)' < $B)"
put '{"kind":"host","reset":true}' >/dev/null
check "looking is not audited, only refusals" "0 8" "$(grep '"action":"rrd"' "$DATA/audit.jsonl" | grep -c '"outcome":"success"') $(grep '"action":"rrd"' "$DATA/audit.jsonl" | grep -vc '"outcome":"success"')"

echo; echo "$pass passed, $fail failed"
exit $fail
