#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
# Host networking as XenCenter's Networking tab shows it, against the fake
# pool's networks (fake-xapi.js: bonds for management and storage, a VLAN with
# a secondary interface, a NIC on its own, a private network, hidden ones).
# (network-test.sh is the appliance's own network; this is the pools'.)
# Then adding, changing and removing networks: the XAPI calls in XenCenter's
# order (calls.log), what XenCenter blocks, what XenMan blocks besides, admins only.
set -u
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
W=$BUILD
DATA=/var/tmp/xnet-data; FX=/var/tmp/xnet-fake
PORT=3196; XPORT=4496
B="http://127.0.0.1:$PORT"; J='-H Content-Type:application/json'; NODE=$NODE_BIN
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
BODY=/var/tmp/xnet-body.json
field() { "$NODE" -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1" 2>/dev/null; }
code() { curl -sS -o $BODY -w "%{http_code}" "$@"; }

rm -rf "$DATA" "$FX"; mkdir -p "$DATA" "$FX"; echo normal > "$FX/mode"; touch "$FX/net-eth4-down"
"$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xnet-fake.log 2>&1 & FPID=$!
sleep 0.5; rm -f "$FX/net-eth4-down"
cd "$W"
DATA_DIR="$DATA" XENMAN_MGMT_WAIT_MS=5000 XENMAN_MGMT_POLL_MS=200 NEXT_TELEMETRY_DISABLED=1 npx next start -p $PORT >> /var/tmp/xnet-server.log 2>&1 & PID=$!
cd /
trap 'kill $PID $FPID 2>/dev/null; pkill -f "next start -p $PORT"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "$B/login" && break; sleep 0.5; done

C=/var/tmp/xnet-cookie; A="-b $C"
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"admin"}' >/dev/null
curl -s -b $C -c $C -X POST $B/api/auth/change-password $J -d '{"currentPassword":"admin","newPassword":"Cobalt-Test-4242"}' >/dev/null
curl -s -c $C -X POST $B/api/auth/login $J -d '{"username":"admin","password":"Cobalt-Test-4242"}' >/dev/null
code $A -X POST $B/api/hosts $J -d "{\"action\":\"add\",\"host\":{\"id\":\"pool1\",\"name\":\"Production\",\"address\":\"127.0.0.1\",\"port\":$XPORT,\"username\":\"root\",\"password\":\"secret\",\"useSsl\":false}}" >/dev/null
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
S=$(field d.sessionRef < $BODY)
x() { code ${3:-$A} -X POST $B/api/xen $J -d "{\"action\":\"$1\",\"sessionRef\":\"${4:-$S}\"${2:+,$2}}"; }
row() { field "const r=d.networks.find(n=>n.name==='$1'); r ? [$2].join(' | ') : 'missing'" < $BODY; }

echo "=== a host's networks ==="
check "answers" 200 "$(x host_networking '"hostRef":"OpaqueRef:host-1"')"
check "the networks shown, sorted by NIC; bond members', hidden and installer networks left out" \
  "Private,Bond_Management,Bond_NFS,vlan2232N,Network 4,Network 6,Network 7" "$(field 'd.networks.map(n=>n.name).join()' < $BODY)"
check "a bond: NIC, VLAN, Auto, Link Status, MAC, MTU, SR-IOV as XenCenter" \
  "Bond 0+1 | - | false | Connected | 00:25:b5:aa:01:7c | 1500 | No | bond" "$(row Bond_Management 'r.nic,r.vlan,r.auto,r.linkStatus,r.mac,r.mtu,r.sriov,r.kind')"
check "a VLAN: the NIC it sits on, its tag, no MAC" "Bond 2+3 | 2232 | - | vlan" "$(row vlan2232N 'r.nic,r.vlan,r.mac,r.kind')"
check "a NIC on its own; no automatic in other_config: Auto No, as XenCenter shows it" "NIC 4 | false | 00:25:b5:aa:01:04 | physical" "$(row 'Network 4' 'r.nic,r.auto,r.mac,r.kind')"
check "  automatic=true: Auto Yes; automatic=false: No" "true false" "$(row Bond_NFS 'r.auto') $(row Bond_Management 'r.auto')"
check "  XenServer's default name read as XenCenter does" "Network 4" "$(field 'd.networks.find(n=>n.nic==="NIC 4").name' < $BODY)"
check "  the network of a NIC XAPI does not manage (eth5): left out" 0 "$(field 'd.networks.filter(n=>n.name==="Network 5"||n.name.includes("eth5")).length' < $BODY)"
check "a private network: no NIC, no link" " | <None> | internal" "$(row Private 'r.nic,r.linkStatus,r.kind')"
check "  the management network marked" "true false" "$(row Bond_Management 'r.management') $(row Bond_NFS 'r.management')"
check "  bond mode for the properties" "active-backup balance-slb" "$(row Bond_Management 'r.bondMode') $(row Bond_NFS 'r.bondMode')"

echo "=== the interfaces with an IP address ==="
check "management first, then the secondary interface" \
  "Management|Bond_Management|Bond 0+1|Static|10.0.0.11|255.255.255.0|10.0.0.1|10.0.0.53,10.0.0.54;xs-01_NFS|vlan2232N|Bond 2+3|Static|192.0.2.111|255.255.255.0||" \
  "$(field 'd.interfaces.map(i=>[i.interface,i.network,i.nic,i.ipSetup,i.ip,i.netmask,i.gateway,i.dns].join("|")).join(";")' < $BODY)"
check "  the server named" "xs-01 xs-01" "$(field 'd.interfaces.map(i=>i.server).join(" ")' < $BODY)"

echo "=== the NICs (for bonds and SR-IOV) ==="
check "physical NICs and bonds, the members marked" "Bond 0+1,Bond 2+3,NIC 0,NIC 1,NIC 2,NIC 3,NIC 4,NIC 6,NIC 7 / false,false,true,true,true,true,false,false,false" \
  "$(field 'd.nics.map(n=>n.nic).join()+" / "+d.nics.map(n=>n.bonded).join()' < $BODY)"
check "  details as XenCenter's table, SR-IOV capable marked" "10000 Mbit/s|Full|Intel Corporation|0000:04:00.0|true" \
  "$(field 'const n=d.nics.find(n=>n.nic==="NIC 4"); [n.speed,n.duplex,n.vendor,n.pciBusPath,n.sriovCapable].join("|")' < $BODY)"

echo "=== the pool view ==="
check "answers" 200 "$(x host_networking)"
check "the coordinator's NIC, the link over all hosts" "NIC 4 | Partially connected" "$(row 'Network 4' 'r.nic,r.linkStatus')"
check "  every host's interfaces" "xs-01:Management xs-01:xs-01_NFS xs-02:Management xs-02:xs-02_NFS" \
  "$(field 'd.interfaces.map(i=>i.server+":"+i.interface).join(" ")' < $BODY)"
check "  on xs-02 alone: its NIC 4 is down" "Disconnected" "$(x host_networking '"hostRef":"OpaqueRef:host-2"' >/dev/null; row 'Network 4' 'r.linkStatus')"

# The writing calls since a mark: method names, or with their parameters.
mark() { wc -l < "$FX/calls.log"; }
since() { tail -n +$(( $1 + 1 )) "$FX/calls.log" | grep -E '^(network\.(create|destroy|set_|add_|remove_)|pool\.create_VLAN|VLAN\.destroy|PIF\.(un)?plug|PIF\.forget|PIF\.set_other_config|PIF\.reconfigure_ip|network_sriov\.destroy|tunnel\.destroy|Async\.Bond\.|Bond\.(destroy|set_)|Async\.network_sriov\.|Async\.PIF\.|Async\.host\.management)'; }
names() { since "$1" | sed 's/ .*//' | tr '\n' ' ' | sed 's/ $//'; }
err() { field d.error < $BODY; }
upd() { x network_update "\"networkRef\":\"$1\",\"changes\":{$2}"; }
H1='"hostRef":"OpaqueRef:host-1"'

echo "=== Add Network: External ==="
M=$(mark)
check "a VLAN already on that NIC: refused, nothing written" "409 This VLAN number is already in use |" \
  "$(x network_create '"type":"external","name":"Again","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-bn","vlan":2232,"mtu":1500') $(err) |$(names $M)"
check "  a NIC in a bond: refused" "409 Choose one of the coordinator's NICs" \
  "$(x network_create '"type":"external","name":"X","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-eth2","vlan":100,"mtu":1500') $(err)"
check "  a NIC of a pool member (the wizard lists the coordinator's): refused" 409 \
  "$(x network_create '"type":"external","name":"X","description":"","auto":false,"pifRef":"OpaqueRef:pif-2-bn","vlan":100,"mtu":1500')"
check "  an MTU above the NIC's own: refused" "409 MTU: allowed range 1500 to 1500" \
  "$(x network_create '"type":"external","name":"X","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-bn","vlan":100,"mtu":9000') $(err)"
check "  VLAN 4095, an empty name: refused" "409 409" \
  "$(x network_create '"type":"external","name":"X","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-bn","vlan":4095,"mtu":1500') $(x network_create '"type":"external","name":"  ","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-bn","vlan":100,"mtu":1500')"
check "  nothing written by any of them" "" "$(names $M)"

M=$(mark)
check "VLAN 100 on Bond 2+3: created" 200 "$(x network_create '"type":"external","name":"Storage 100","description":"for NFS","auto":true,"pifRef":"OpaqueRef:pif-1-bn","vlan":100,"mtu":1500')"
NREF=$(field d.networkRef < $BODY)
check "  network.create, then pool.create_VLAN_from_PIF (NetworkAction)" "network.create pool.create_VLAN_from_PIF" "$(names $M)"
check "  the network as XenCenter's CreateNetworkObject: name, description, MTU, automatic, managed" \
  'network.create [{"name_label":"Storage 100","name_description":"for NFS","MTU":1500,"other_config":{"automatic":"true"},"bridge":"","managed":true,"tags":[]}]' \
  "$(since $M | head -1)"
check "  the VLAN on the coordinator's NIC, tag as a number" "pool.create_VLAN_from_PIF [\"OpaqueRef:pif-1-bn\",\"$NREF\",100]" "$(since $M | tail -1)"
x host_networking "$H1" >/dev/null
check "  listed: NIC, VLAN, Auto as asked" "Bond 2+3 | 100 | true | vlan" "$(row 'Storage 100' 'r.nic,r.vlan,r.auto,r.kind')"
check "  on xs-02 as well" "Bond 2+3 | 100" "$(x host_networking '"hostRef":"OpaqueRef:host-2"' >/dev/null; row 'Storage 100' 'r.nic,r.vlan')"
check "  audited, category network" 1 "$(grep '"action":"network_create"' $DATA/audit.jsonl | grep '"category":"network"' | grep '"outcome":"success"' | grep -c 'type=external, name=Storage 100, vlan=100')"

echo "=== Add Network: Single-Server Private ==="
M=$(mark)
check "created with network.create alone" "200 network.create" "$(x network_create '"type":"private","name":"Lab","description":"","auto":false') $(names $M)"
LREF=$(field d.networkRef < $BODY)
check "  listed without NIC" " | - | internal" "$(x host_networking "$H1" >/dev/null; row Lab 'r.nic,r.vlan,r.kind')"

echo "=== a VLAN that fails ==="
touch "$FX/vlan-fails"; M=$(mark)
check "XAPI refuses the VLAN: the error, and the new network taken away again" "400 network.create pool.create_VLAN_from_PIF network.destroy" \
  "$(x network_create '"type":"external","name":"Broken","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-bn","vlan":101,"mtu":1500') $(names $M)"
rm -f "$FX/vlan-fails"
check "  not listed" missing "$(x host_networking "$H1" >/dev/null; row Broken 'r.name')"

echo "=== Properties: General ==="
M=$(mark)
check "name, description, Auto, folder and tags changed" 200 \
  "$(upd "$NREF" '"name":"Storage 100b","description":"NFS","auto":false,"folder":"/Storage","tags":["nfs","lab"]')"
check "  each by its own call; automatic replaced (XAPI refuses a key twice)" \
  "network.set_name_label network.set_name_description network.remove_from_other_config network.add_to_other_config network.add_to_other_config network.add_tags network.add_tags" "$(names $M)"
check "  shown" "NFS | false | /Storage | nfs,lab" "$(x host_networking "$H1" >/dev/null; row 'Storage 100b' 'r.description,r.auto,r.folder,r.tags')"
M=$(mark)
check "  unchanged values: nothing written" "200 " "$(upd "$NREF" '"name":"Storage 100b","description":"NFS","auto":false,"folder":"/Storage","tags":["nfs","lab"]') $(names $M)"
check "  a folder taken away, a tag less" "200 network.remove_from_other_config network.remove_tags" "$(upd "$NREF" '"folder":"","tags":["nfs"]') $(names $M)"
check "  audited with the changes (both requests carried them)" 2 "$(grep '"action":"network_update"' $DATA/audit.jsonl | grep -c 'changes: name=Storage 100b, description=NFS, auto=false, folder=/Storage, tags=nfs|lab')"

echo "=== Properties: Network Settings ==="
M=$(mark)
check "another VLAN: the old VLANs destroyed, the new one made (NetworkAction update)" \
  "200 VLAN.destroy VLAN.destroy pool.create_VLAN_from_PIF" "$(upd "$NREF" '"nic":"OpaqueRef:pif-1-bn","vlan":120') $(names $M)"
check "  listed on VLAN 120, its name kept" "Bond 2+3 | 120" "$(x host_networking "$H1" >/dev/null; row 'Storage 100b' 'r.nic,r.vlan')"
M=$(mark)
check "  a VLAN in use: refused, nothing written" "409 This VLAN number is already in use |" "$(upd "$NREF" '"nic":"OpaqueRef:pif-1-bn","vlan":2232') $(err) |$(names $M)"
check "  the same NIC and VLAN again: nothing to do" "200 " "$(upd "$NREF" '"nic":"OpaqueRef:pif-1-bn","vlan":120') $(names $M)"
check "a new MTU: set, then the PIFs unplugged and plugged (UnplugPlugNetworkAction)" \
  "200 network.set_MTU PIF.unplug PIF.unplug PIF.plug PIF.plug" "$(upd "$NREF" '"mtu":1600') $(names $M)"
check "  shown" 1600 "$(x host_networking "$H1" >/dev/null; row 'Storage 100b' 'r.mtu')"
M=$(mark)
check "a private network onto NIC 4, VLAN 300: only the VLAN made" "200 pool.create_VLAN_from_PIF" "$(upd "$LREF" '"nic":"OpaqueRef:pif-1-eth4","vlan":300') $(names $M)"
check "  listed on NIC 4" "NIC 4 | 300 | vlan" "$(x host_networking "$H1" >/dev/null; row Lab 'r.nic,r.vlan,r.kind')"
M=$(mark)
check "  and back to <internal>: the VLANs destroyed" "200 VLAN.destroy VLAN.destroy" "$(upd "$LREF" '"nic":"internal"') $(names $M)"
check "  listed without NIC" " | internal" "$(x host_networking "$H1" >/dev/null; row Lab 'r.nic,r.kind')"

echo "=== Network Settings XenCenter blocks ==="
M=$(mark)
check "the NIC of a physical network" "409 The NIC and VLAN of this network cannot be changed" "$(upd OpaqueRef:net-eth4 '"nic":"OpaqueRef:pif-1-bn","vlan":400') $(err)"
check "the NIC of a network with an IP interface" "409 (The network's NIC and VLAN cannot be changed as it is in use as the management interface 'xs-01_NFS')" \
  "$(upd OpaqueRef:net-2232 '"nic":"OpaqueRef:pif-1-bn","vlan":2233') $(err)"
check "the MTU of the management network" "409 (The network's MTU cannot be changed because it is in use as the management interface 'Management')" \
  "$(upd OpaqueRef:net-mgmt '"mtu":9000') $(err)"
check "the MTU of a private network" "409 The MTU of a private network cannot be changed" "$(upd OpaqueRef:net-private '"mtu":9000') $(err)"
check "  XenMan: not under a VLAN with an IP interface (storage)" "409 (The network's MTU cannot be changed because VLAN 2232 on its NIC carries the interface 'xs-01_NFS')" \
  "$(upd OpaqueRef:net-nfs '"mtu":9000') $(err)"
check "  a refused change writes nothing, not even the name sent with it" "409 " "$(upd OpaqueRef:net-mgmt '"name":"Renamed","mtu":9000') $(names $M)"

echo "=== Remove Network ==="
M=$(mark)
check "a physical network: refused as XenCenter does" "409 This network cannot be removed because it is a physical device" "$(x network_destroy '"networkRef":"OpaqueRef:net-eth4"') $(err)"
check "  a bond: not here" 409 "$(x network_destroy '"networkRef":"OpaqueRef:net-nfs"')"
check "  XenMan: one carrying an IP interface" "409 The network carries the interface 'xs-01_NFS'. Remove its IP address first." "$(x network_destroy '"networkRef":"OpaqueRef:net-2232"') $(err)"
check "  XenMan: one VMs are on" "409 VMs still have network interfaces on this network: web-01" "$(x network_destroy '"networkRef":"OpaqueRef:net-private"') $(err)"
check "  nothing written" "" "$(names $M)"
M=$(mark)
check "a VLAN network: its VLANs, then the network (NetworkAction destroy)" "200 VLAN.destroy VLAN.destroy network.destroy" "$(x network_destroy "\"networkRef\":\"$NREF\"") $(names $M)"
check "  gone, and VLAN 120 free on the NIC again" "missing 2232" "$(x host_networking >/dev/null; row 'Storage 100b' 'r.name') $(field 'd.nics.find(n=>n.nic==="Bond 2+3").vlans.join()' < $BODY)"
M=$(mark)
check "a private network: network.destroy alone" "200 network.destroy" "$(x network_destroy "\"networkRef\":\"$LREF\"") $(names $M)"
check "  audited" 2 "$(grep '"action":"network_destroy"' $DATA/audit.jsonl | grep -c '"outcome":"success"')"

echo "=== Configure IP Addresses: one server ==="
ipc() { x network_configure_ip "$1"; }
NFS1='{"pifRef":"OpaqueRef:pif-1-v","name":"xs-01_NFS","networkRef":"OpaqueRef:net-2232","mode":"Static","ip":"192.0.2.111","netmask":"255.255.255.0","gateway":""}'
ifaces() { x host_networking "$1" >/dev/null; field 'd.interfaces.map(i=>[i.server,i.interface,i.network,i.ipSetup,i.ip].join(" ")).join("; ")' < $BODY; }
M=$(mark)
check "the dialog left as it was: nothing written" "200 " "$(ipc "$H1,\"interfaces\":[$NFS1]") $(names $M)"
check "a new name alone: other_config, on this server only (SetSecondaryManagementPurposeAction)" \
  'PIF.set_other_config ["OpaqueRef:pif-1-v",{"management_purpose":"xs-01_Storage"}]' \
  "$(ipc "$H1,\"interfaces\":[${NFS1/xs-01_NFS/xs-01_Storage}]" >/dev/null; since $M)"
NFS1=${NFS1/xs-01_NFS/xs-01_Storage}
M=$(mark)
check "Add IP address on Network 4: the name, the address, then plugged (BringUp)" \
  'PIF.set_other_config ["OpaqueRef:pif-1-eth4",{"management_purpose":"Backup"}]|PIF.reconfigure_ip ["OpaqueRef:pif-1-eth4","Static","10.4.0.11","255.255.0.0","",""]|PIF.plug ["OpaqueRef:pif-1-eth4"]' \
  "$(ipc "$H1,\"interfaces\":[$NFS1,{\"name\":\"Backup\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"Static\",\"ip\":\"10.4.0.11\",\"netmask\":\"255.255.0.0\",\"gateway\":\"\"}]" >/dev/null; since $M | paste -sd'|')"
check "  listed after the management interface" "xs-01 Management Bond_Management Static 10.0.0.11; xs-01 Backup Network 4 Static 10.4.0.11; xs-01 xs-01_Storage vlan2232N Static 192.0.2.111" "$(ifaces "$H1")"
M=$(mark)
check "  to DHCP: the address only, it is plugged already" 'PIF.reconfigure_ip ["OpaqueRef:pif-1-eth4","DHCP","10.4.0.11","255.255.0.0","",""]' \
  "$(ipc "$H1,\"interfaces\":[$NFS1,{\"pifRef\":\"OpaqueRef:pif-1-eth4\",\"name\":\"Backup\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"DHCP\"}]" >/dev/null; since $M)"
M=$(mark)
check "Remove IP Address: the name taken away, then the address (BringDown)" \
  'PIF.set_other_config ["OpaqueRef:pif-1-eth4",{}]|PIF.reconfigure_ip ["OpaqueRef:pif-1-eth4","None","","","",""]' \
  "$(ipc "$H1,\"interfaces\":[$NFS1]" >/dev/null; since $M | paste -sd'|')"
check "  xs-02 untouched throughout" "xs-02 Management Bond_Management Static 10.0.0.12; xs-02 xs-02_NFS vlan2232N Static 192.0.2.112" "$(ifaces '"hostRef":"OpaqueRef:host-2"')"

echo "=== what the dialog does not allow ==="
M=$(mark)
check "the management network" "409 Bond_Management is currently in use by the primary interface" \
  "$(ipc "$H1,\"interfaces\":[{\"name\":\"X\",\"networkRef\":\"OpaqueRef:net-mgmt\",\"mode\":\"DHCP\"}]") $(err)"
check "one network twice" "409 Network 4 is currently in use by another interface" \
  "$(ipc "$H1,\"interfaces\":[{\"name\":\"A\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"DHCP\"},{\"name\":\"B\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"DHCP\"}]") $(err | sed 's/Pool-wide network associated with eth4/Network 4/')"
check "a subnet mask with a gap, an empty name, a bad gateway" "409 409 409" \
  "$(ipc "$H1,\"interfaces\":[{\"name\":\"A\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"Static\",\"ip\":\"10.4.0.1\",\"netmask\":\"255.0.255.0\"}]") $(ipc "$H1,\"interfaces\":[{\"name\":\" \",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"DHCP\"}]") $(ipc "$H1,\"interfaces\":[{\"name\":\"A\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"Static\",\"ip\":\"10.4.0.1\",\"netmask\":\"255.255.0.0\",\"gateway\":\"10.4.0\"}]")"
check "a network without a PIF here (private)" "409 A: choose a network of this server" \
  "$(ipc "$H1,\"interfaces\":[{\"name\":\"A\",\"networkRef\":\"OpaqueRef:net-private\",\"mode\":\"DHCP\"}]") $(err)"
check "an interface that is not one of this server's" "409 An interface changed meanwhile; open the dialog again" \
  "$(ipc "$H1,\"interfaces\":[{\"pifRef\":\"OpaqueRef:pif-2-v\",\"name\":\"A\",\"networkRef\":\"OpaqueRef:net-2232\",\"mode\":\"DHCP\"}]") $(err)"
check "  nothing written by any of them" "" "$(names $M)"

echo "=== storage over the interface ==="
touch "$FX/nfs-sr"; M=$(mark)
NEW121=${NFS1/192.0.2.111/192.0.2.121}
check "a new address for the NFS interface: named first, nothing written" "409 NFS-Storage|192.0.2.5|xs-01|xs-01_Storage " \
  "$(ipc "$H1,\"interfaces\":[$NEW121]") $(field 'd.storage.map(s=>[s.sr,s.server,s.host,s.interface].join("|")).join()' < $BODY) $(names $M)"
check "  removing it: named as well" "409 NFS-Storage" "$(ipc "$H1,\"interfaces\":[]") $(field 'd.storage[0].sr' < $BODY)"
check "  a page elsewhere is no reason to ask" "200" "$(ipc "$H1,\"interfaces\":[$NFS1,{\"name\":\"Backup\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"DHCP\"}]")"
M=$(mark)
check "  confirmed: done" 'PIF.reconfigure_ip ["OpaqueRef:pif-1-v","Static","192.0.2.121","255.255.255.0","",""]' \
  "$(ipc "$H1,\"interfaces\":[$NEW121,{\"pifRef\":\"OpaqueRef:pif-1-eth4\",\"name\":\"Backup\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"DHCP\"}],\"confirmStorage\":true" >/dev/null; since $M)"
check "  audited as confirmed" 1 "$(grep '"action":"network_configure_ip"' $DATA/audit.jsonl | grep '"outcome":"success"' | grep -c 'xs-01_Storage=192.0.2.121/255.255.255.0, Backup=DHCP, storage warning confirmed')"
rm -f "$FX/nfs-sr"
NFS1=$NEW121
touch "$FX/nfs-sr-name"; M=$(mark)
check "an SR that names its server, and the name does not resolve: asked for every interface touched" \
  "409 NFS-Storage|nfs.invalid (address unknown)|xs-01_Storage,NFS-Storage|nfs.invalid (address unknown)|Backup " \
  "$(ipc "$H1,\"interfaces\":[${NFS1/192.0.2.121/192.0.2.131}]") $(field 'd.storage.map(s=>[s.sr,s.server,s.interface].join("|")).join()' < $BODY) $(names $M)"
rm -f "$FX/nfs-sr-name"

echo "=== Configure IP Addresses: the pool ==="
M=$(mark)
check "a range past .254 for two servers: refused" "409 Range: the range from 10.9.0.254 for 2 servers runs past .254" \
  "$(ipc "\"interfaces\":[$NFS1,{\"name\":\"Range\",\"networkRef\":\"OpaqueRef:net-nfs\",\"mode\":\"Static\",\"ip\":\"10.9.0.254\",\"netmask\":\"255.255.255.0\"}]") $(err)"
check "Add IP address for the pool on Bond 2+3: xs-02 first with the next address, then the coordinator" \
  'PIF.set_other_config ["OpaqueRef:pif-2-bn",{"management_purpose":"Replication"}]|PIF.reconfigure_ip ["OpaqueRef:pif-2-bn","Static","10.9.0.21","255.255.255.0","",""]|PIF.set_other_config ["OpaqueRef:pif-1-bn",{"management_purpose":"Replication"}]|PIF.reconfigure_ip ["OpaqueRef:pif-1-bn","Static","10.9.0.20","255.255.255.0","",""]' \
  "$(ipc "\"interfaces\":[$NFS1,{\"pifRef\":\"OpaqueRef:pif-1-eth4\",\"name\":\"Backup\",\"networkRef\":\"OpaqueRef:net-eth4\",\"mode\":\"DHCP\"},{\"name\":\"Replication\",\"networkRef\":\"OpaqueRef:net-nfs\",\"mode\":\"Static\",\"ip\":\"10.9.0.20\",\"netmask\":\"255.255.255.0\"}]" >/dev/null; since $M | paste -sd'|')"
check "  every server has it" "xs-01 Replication 10.9.0.20; xs-02 Replication 10.9.0.21" \
  "$(x host_networking >/dev/null; field 'd.interfaces.filter(i=>i.interface==="Replication").map(i=>i.server+" "+i.interface+" "+i.ip).join("; ")' < $BODY)"
M=$(mark)
check "removed for the pool: xs-02 first, then the coordinator; Network 4 brought down on xs-01 only (xs-02 has no address there)" \
  'PIF.set_other_config ["OpaqueRef:pif-2-bn",{}]|PIF.reconfigure_ip ["OpaqueRef:pif-2-bn","None","","","",""]|PIF.set_other_config ["OpaqueRef:pif-1-bn",{}]|PIF.reconfigure_ip ["OpaqueRef:pif-1-bn","None","","","",""]|PIF.set_other_config ["OpaqueRef:pif-1-eth4",{}]|PIF.reconfigure_ip ["OpaqueRef:pif-1-eth4","None","","","",""]' \
  "$(ipc "\"interfaces\":[$NFS1]" >/dev/null; since $M | paste -sd'|')"
check "  audited as pool-wide" 1 "$(grep '"action":"network_configure_ip"' $DATA/audit.jsonl | grep -c 'pool-wide, interfaces: xs-01_Storage=192.0.2.121/255.255.255.0"')"

echo "=== Bonded Network ==="
BOND='"type":"bond","pifRefs":["OpaqueRef:pif-1-eth6","OpaqueRef:pif-1-eth7"],"mode":"balance-slb","mtu":1500,"auto":false'
M=$(mark)
check "without the pool's name typed in: refused" "409 Type the pool's name, Production, to confirm" "$(x network_create "$BOND") $(err)"
check "  one NIC only" "409 A bond has 2 to 4 NICs" "$(x network_create '"type":"bond","pifRefs":["OpaqueRef:pif-1-eth6"],"mode":"balance-slb","auto":false,"confirmName":"Production"') $(err)"
check "  a NIC already in a bond" "409 NIC 2 is already in a bond" \
  "$(x network_create '"type":"bond","pifRefs":["OpaqueRef:pif-1-eth2","OpaqueRef:pif-1-eth6"],"mode":"balance-slb","auto":false,"confirmName":"Production"') $(err)"
check "  LACP without its load balancing" "409 LACP: choose the load balancing" "$(x network_create "${BOND/balance-slb/lacp},\"confirmName\":\"Production\"") $(err)"
check "  nothing written" "" "$(names $M)"

touch "$FX/bond-fails-h1"; M=$(mark)
check "the bond fails on the coordinator: xs-02's bond and the network taken away again (CreateBondAction)" \
  "400 INTERNAL_ERROR (bond-fails-h1) network.create network.remove_from_other_config Async.Bond.create Async.Bond.create Bond.destroy network.destroy" \
  "$(x network_create "$BOND,\"confirmName\":\"production\"") $(err) $(names $M)"
rm -f "$FX/bond-fails-h1"
check "  NIC 6 and 7 free again on both servers" "missing Network 6" "$(x host_networking '"hostRef":"OpaqueRef:host-2"' >/dev/null; row 'Bond 6+7' 'r.name') $(field 'd.networks.find(n=>n.nic==="NIC 6").name' < $BODY)"

# A secondary interface on xs-01's NIC 6, to see its name move with the bond.
ipc "$H1,\"interfaces\":[$NFS1,{\"name\":\"Repl\",\"networkRef\":\"OpaqueRef:net-eth6\",\"mode\":\"Static\",\"ip\":\"10.6.0.11\",\"netmask\":\"255.255.255.0\"}]" >/dev/null
M=$(mark)
check "Bond 6+7 created" "200 Bond 6+7" "$(x network_create "$BOND,\"confirmName\":\"Production\"") $(field d.name < $BODY)"
BREF=$(field d.networkRef < $BODY)
check "  the network marked while it is made, the mark off; the coordinator's bond last; the interface's name moved to the bond" \
  "network.create network.remove_from_other_config Async.Bond.create Async.Bond.create PIF.set_other_config PIF.set_other_config" "$(names $M)"
check "  the network as CreateBondAction makes it" \
  'network.create [{"name_label":"Bond 6+7","name_description":"","MTU":1500,"other_config":{"automatic":"false","XenCenterCreateInProgress":"true"},"bridge":"","managed":true,"tags":[]}]' \
  "$(since $M | head -1)"
check "  xs-02 first, its NICs by name; no MAC; the mode" \
  "Async.Bond.create [\"$BREF\",[\"OpaqueRef:pif-2-eth6\",\"OpaqueRef:pif-2-eth7\"],\"\",\"balance-slb\",{}]" "$(since $M | sed -n 3p)"
check "  listed as a bond; the members' networks gone from the list" "Bond 6+7 | bond | balance-slb | no-member-networks" \
  "$(x host_networking "$H1" >/dev/null; row 'Bond 6+7' 'r.nic,r.kind,r.bondMode') | $(field 'd.networks.some(n=>n.name==="Network 6"||n.name==="Network 7") ? "member-networks" : "no-member-networks"' < $BODY)"
check "  the interface on the bond, under its name" "Repl Bond 6+7 10.6.0.11" "$(field 'const i=d.interfaces.find(i=>i.interface==="Repl"); i ? [i.interface,i.nic,i.ip].join(" ") : "missing"' < $BODY)"
check "  audited" 1 "$(grep '"action":"network_create"' $DATA/audit.jsonl | grep '"outcome":"success"' | grep -c 'type=bond, mode=balance-slb, mtu=1500, nics=2')"

M=$(mark)
check "bond mode LACP, load balancing by IP and port: set_mode on each bond, then the property" \
  "200 Bond.set_mode Bond.set_mode Bond.set_property Bond.set_property" "$(upd "$BREF" '"bondMode":"lacp","hashing":"tcpudp_ports"') $(names $M)"
check "  shown" "lacp tcpudp_ports" "$(x host_networking "$H1" >/dev/null; row 'Bond 6+7' 'r.bondMode,r.hashing' | tr -d '|' | tr -s ' ')"
M=$(mark)
check "  the load balancing alone" "200 Bond.set_property Bond.set_property" "$(upd "$BREF" '"bondMode":"lacp","hashing":"src_mac"') $(names $M)"

touch "$FX/ha"; M=$(mark)
check "deleting the management bond while HA is on: refused, nothing written" "409 |" \
  "$(x network_destroy '"networkRef":"OpaqueRef:net-mgmt","confirmName":"Production"') |$(names $M)"
rm -f "$FX/ha"
check "deleting without the pool's name: refused" "409 Type the pool's name, Production, to confirm" "$(x network_destroy "\"networkRef\":\"$BREF\"") $(err)"
M=$(mark)
check "deleted: the interface's name back on the first member, the bonds (coordinator last), the network (DestroyBondAction)" \
  "200 PIF.set_other_config PIF.set_other_config Async.Bond.destroy Async.Bond.destroy network.destroy" \
  "$(x network_destroy "\"networkRef\":\"$BREF\",\"confirmName\":\"Production\"") $(names $M)"
check "  the interface back on NIC 6 with its address" "Repl NIC 6 10.6.0.11" \
  "$(x host_networking "$H1" >/dev/null; field 'const i=d.interfaces.find(i=>i.interface==="Repl"); i ? [i.interface,i.nic,i.ip].join(" ") : "missing"' < $BODY)"
check "  Network 6 and 7 listed again" "Network 6 Network 7" "$(row 'Network 6' 'r.name') $(row 'Network 7' 'r.name')"
ipc "$H1,\"interfaces\":[$NFS1]" >/dev/null

echo "=== SR-IOV Network ==="
SR='"type":"sriov","name":"SRIOV 4","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-eth4"'
touch "$FX/sriov-unlicensed"; M=$(mark)
check "the licence does not allow it: refused, and the list says so" "409 'SR-IOV' feature is disabled due to license restrictions on the server. false" \
  "$(x network_create "$SR,\"confirmName\":\"Production\"") $(err) $(x host_networking >/dev/null; field d.sriovLicensed < $BODY)"
rm -f "$FX/sriov-unlicensed"
check "  without the pool's name typed in" "409 Type the pool's name, Production, to confirm" "$(x network_create "$SR") $(err)"
check "  a NIC that cannot do SR-IOV" "409 Choose an SR-IOV capable NIC of the coordinator" "$(x network_create "${SR/eth4/eth6},\"confirmName\":\"Production\"") $(err)"
check "  nothing written" "" "$(names $M)"

touch "$FX/sriov-fails-h2"; M=$(mark)
check "SR-IOV fails on xs-02: the error; the network stays, the coordinator has it (CreateSriovAction)" \
  "400 INTERNAL_ERROR (sriov-fails-h2) network.create Async.network_sriov.create Async.network_sriov.create" \
  "$(x network_create "$SR,\"confirmName\":\"Production\"") $(err) $(names $M)"
rm -f "$FX/sriov-fails-h2"
FREF=$(x host_networking >/dev/null; field 'd.networks.find(n=>n.name==="SRIOV 4").ref' < $BODY)
M=$(mark)
check "  removed with Remove Network: its SR-IOV, then the network (NetworkAction)" "200 network_sriov.destroy network.destroy" \
  "$(x network_destroy "\"networkRef\":\"$FREF\"") $(names $M)"

M=$(mark)
check "SR-IOV network on NIC 4: created" 200 "$(x network_create "$SR,\"confirmName\":\"Production\"")"
SREF=$(field d.networkRef < $BODY)
check "  the network, then SR-IOV on each server's NIC 4, the coordinator first" \
  "network.create|Async.network_sriov.create [\"OpaqueRef:pif-1-eth4\",\"$SREF\"]|Async.network_sriov.create [\"OpaqueRef:pif-2-eth4\",\"$SREF\"]" \
  "$(since $M | sed 's/^network.create .*/network.create/' | paste -sd'|')"
check "  listed: NIC 4, SR-IOV Yes, on both servers" "NIC 4 | Yes | sriov / NIC 4 | Yes" \
  "$(x host_networking "$H1" >/dev/null; row 'SRIOV 4' 'r.nic,r.sriov,r.kind') / $(x host_networking '"hostRef":"OpaqueRef:host-2"' >/dev/null; row 'SRIOV 4' 'r.nic,r.sriov')"
check "  NIC 4 marked as SR-IOV enabled; no other to choose" "true 409" \
  "$(x host_networking >/dev/null; field 'd.nics.find(n=>n.nic==="NIC 4").sriovEnabled' < $BODY) $(x network_create "$SR,\"confirmName\":\"Production\"")"

M=$(mark)
check "an External network on the SR-IOV network, VLAN 300: the VLAN on its logical PIF" "200 pool.create_VLAN_from_PIF OpaqueRef:pif-sriov-new" \
  "$(x network_create '"type":"external","name":"VF 300","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-eth4","vlan":300,"mtu":1500,"onSriov":true') $(since $M | sed -n 2p | grep -o '^pool.create_VLAN_from_PIF \[\"OpaqueRef:pif-sriov-new' | tr -d '[\"')"
VREF=$(field d.networkRef < $BODY)
check "  its tag counted apart from the NIC's own" "300 /" \
  "$(x host_networking >/dev/null; field 'const n=d.nics.find(n=>n.nic==="NIC 4"); n.sriovVlans.join()+" /"+n.vlans.join()' < $BODY)"
check "  VLAN 300 again on the SR-IOV network: in use" "409 This VLAN number is already in use" \
  "$(x network_create '"type":"external","name":"VF 300b","description":"","auto":false,"pifRef":"OpaqueRef:pif-1-eth4","vlan":300,"mtu":1500,"onSriov":true') $(err)"
M=$(mark)
check "removed again: the VLAN network, then the SR-IOV network" "200 200 VLAN.destroy VLAN.destroy network.destroy network_sriov.destroy network_sriov.destroy network.destroy" \
  "$(x network_destroy "\"networkRef\":\"$VREF\"") $(x network_destroy "\"networkRef\":\"$SREF\"") $(names $M)"
check "  NIC 4 free of SR-IOV again" false "$(x host_networking >/dev/null; field 'd.nics.find(n=>n.nic==="NIC 4").sriovEnabled' < $BODY)"

echo "=== the management interface of a member ==="
mg() { x network_management_change "\"hostRef\":\"OpaqueRef:host-2\",$1"; }
jobwait() {
  for _ in $(seq 80); do x network_job_status "\"jobId\":\"$1\"" >/dev/null; [ "$(field d.job.state < $BODY)" != running ] && break; sleep 0.25; done
  field 'd.job.state+" "+d.job.steps.map(s=>s.state).join(",")' < $BODY
}
STATIC22='"networkRef":"OpaqueRef:net-mgmt","mode":"Static","ip":"10.0.0.22","netmask":"255.255.255.0","gateway":"10.0.0.1","dns":["10.0.0.53"]'
M=$(mark)
check "for the pool as a whole: refused (host by host)" "409 Change the management interface on one server, in its own Networking tab" \
  "$(x network_management_change "$STATIC22,\"confirmName\":\"xs-02\"") $(err)"
check "  without the server's name typed in" "409 Type the server's name, xs-02, to confirm" "$(mg "$STATIC22,\"confirmName\":\"xs-01\"") $(err)"
check "  the same settings: nothing to do" "409 Nothing changed" \
  "$(mg '"networkRef":"OpaqueRef:net-mgmt","mode":"Static","ip":"10.0.0.12","netmask":"255.255.255.0","gateway":"10.0.0.1","dns":["10.0.0.53","10.0.0.54"],"confirmName":"xs-02"') $(err)"
check "  a VLAN, which the licence does not allow (no restrict_management_on_vlan=false)" "409 The licence does not allow the management interface on a VLAN" \
  "$(mg '"networkRef":"OpaqueRef:net-2232","mode":"Static","ip":"192.0.2.200","netmask":"255.255.255.0","confirmName":"xs-02"') $(err)"
NFS2='{"pifRef":"OpaqueRef:pif-2-v","name":"xs-02_NFS","networkRef":"OpaqueRef:net-2232","mode":"Static","ip":"192.0.2.112","netmask":"255.255.255.0","gateway":""}'
x network_configure_ip "\"hostRef\":\"OpaqueRef:host-2\",\"interfaces\":[$NFS2,{\"name\":\"Repl2\",\"networkRef\":\"OpaqueRef:net-eth7\",\"mode\":\"Static\",\"ip\":\"10.7.0.12\",\"netmask\":\"255.255.255.0\"}]" >/dev/null
M=$(mark)
check "  a network with a secondary interface on it" "409 Network 7 is currently in use by Repl2" \
  "$(mg '"networkRef":"OpaqueRef:net-eth7","mode":"Static","ip":"10.7.0.13","netmask":"255.255.255.0","confirmName":"xs-02"') $(err | sed 's/Pool-wide network associated with eth7/Network 7/')"
x network_configure_ip "\"hostRef\":\"OpaqueRef:host-2\",\"interfaces\":[$NFS2]" >/dev/null
M=$(mark)
check "  a DNS server that is none" "409 A DNS server is not valid" "$(mg "${STATIC22/10.0.0.53/10.0.0},\"confirmName\":\"xs-02\"") $(err)"
check "  the coordinator by DHCP: XenMan would lose the pool" 409 \
  "$(x network_management_change '"hostRef":"OpaqueRef:host-1","networkRef":"OpaqueRef:net-mgmt","mode":"DHCP","confirmName":"xs-01"')"
touch "$FX/ha"
check "  HA on" "409 The primary interface cannot be reconfigured because HA is enabled" "$(mg "$STATIC22,\"confirmName\":\"xs-02\"") $(err)"
rm -f "$FX/ha"
check "  nothing written" "" "$(names $M)"

M=$(mark)
check "a new address: started as a job" 202 "$(mg "$STATIC22,\"confirmName\":\"xs-02\"")"
JOB=$(field d.job.id < $BODY)
check "  a second change meanwhile: refused" "409 The management interface of xs-02 is being changed" "$(mg "${STATIC22/.22/.23},\"confirmName\":\"xs-02\"") $(err)"
check "  done: configured, then waited for the server" "done done,done" "$(jobwait "$JOB")"
check "  reconfigure_ip on the management PIF, as XenCenter's BringUp" \
  'Async.PIF.reconfigure_ip ["OpaqueRef:pif-2-bm","Static","10.0.0.22","255.255.255.0","10.0.0.1","10.0.0.53"]' "$(since $M)"
check "  shown" "xs-02 Management Bond_Management Static 10.0.0.22" \
  "$(x host_networking '"hostRef":"OpaqueRef:host-2"' >/dev/null; field 'd.interfaces.filter(i=>i.management).map(i=>[i.server,i.interface,i.network,i.ipSetup,i.ip].join(" ")).join()' < $BODY)"
check "  audited when started and when done" "1 1" \
  "$(grep '"action":"network_management_change"' $DATA/audit.jsonl | grep '"outcome":"success"' | grep -c '10.0.0.22/255.255.255.0 gw 10.0.0.1') $(grep '"action":"network_management_finished"' $DATA/audit.jsonl | grep '"outcome":"success"' | grep -c 'host \\"xs-02\\"')"

M=$(mark)
check "moved to Network 6: started" 202 "$(mg '"networkRef":"OpaqueRef:net-eth6","mode":"Static","ip":"10.0.6.12","netmask":"255.255.255.0","confirmName":"xs-02"')"
check "  done: the new NIC configured, the move, the wait, the old address cleared" "done done,done,done,done" "$(jobwait "$(field d.job.id < $BODY)")"
check "  in XenCenter's order (ChangeNetworkingAction)" \
  'Async.PIF.reconfigure_ip ["OpaqueRef:pif-2-eth6","Static","10.0.6.12","255.255.255.0","",""]|Async.host.management_reconfigure ["OpaqueRef:pif-2-eth6"]|Async.PIF.reconfigure_ip ["OpaqueRef:pif-2-bm","None","","","",""]' \
  "$(since $M | paste -sd'|')"
check "  Management on Network 6" "Management Network 6 NIC 6 10.0.6.12" \
  "$(x host_networking '"hostRef":"OpaqueRef:host-2"' >/dev/null; field 'd.interfaces.filter(i=>i.management).map(i=>[i.interface,i.network,i.nic,i.ip].join(" ")).join()' < $BODY)"

touch "$FX/h2-offline"
check "a server that does not come back: failed, with where to look" "failed done,failed true" \
  "$(mg '"networkRef":"OpaqueRef:net-eth6","mode":"Static","ip":"10.0.6.13","netmask":"255.255.255.0","confirmName":"xs-02"' >/dev/null; jobwait "$(field d.job.id < $BODY)") $(field 'd.job.error.includes("xsconsole")' < $BODY)"
rm -f "$FX/h2-offline"
check "  audited as failed" 1 "$(grep '"action":"network_management_finished"' $DATA/audit.jsonl | grep -c '"outcome":"failure"')"

echo "=== who may change ==="
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"oper1","password":"Pass-12345-xm","role":"operator"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/oper1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xnet-o -X POST $B/api/auth/login $J -d '{"username":"oper1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xnet-o -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
OS=$(field d.sessionRef < $BODY); M=$(mark)
check "an operator may not add, change or remove a network, nor configure addresses" "403 403 403 403 403" \
  "$(x network_create '"type":"private","name":"Op","description":"","auto":false' "-b /var/tmp/xnet-o" "$OS") $(x network_update '"networkRef":"OpaqueRef:net-private","changes":{"name":"Op"}' "-b /var/tmp/xnet-o" "$OS") $(x network_destroy '"networkRef":"OpaqueRef:net-private"' "-b /var/tmp/xnet-o" "$OS") $(x network_configure_ip '"interfaces":[]' "-b /var/tmp/xnet-o" "$OS") $(x network_management_change '"hostRef":"OpaqueRef:host-2"' "-b /var/tmp/xnet-o" "$OS")"
check "  nothing written" "" "$(names $M)"

echo "=== who may look ==="
curl -s $A -X POST $B/api/auth/users $J -d '{"username":"viewer1","password":"Pass-12345-xm","role":"viewer"}' >/dev/null
curl -s $A -X PUT $B/api/auth/users/viewer1 $J -d '{"pools":["pool1"]}' >/dev/null
curl -s -c /var/tmp/xnet-v -X POST $B/api/auth/login $J -d '{"username":"viewer1","password":"Pass-12345-xm"}' >/dev/null
code -b /var/tmp/xnet-v -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null
VS=$(field d.sessionRef < $BODY)
check "a viewer sees the networks" "200 7" "$(x host_networking '"hostRef":"OpaqueRef:host-1"' "-b /var/tmp/xnet-v" "$VS") $(field 'd.networks.length' < $BODY)"

echo "=== the coordinator's management address ==="
# A fresh stand-in, its coordinator at 127.0.0.1 -- the address XenMan reaches the pool at --,
# answering on every 127.x address until that moves.
kill $FPID 2>/dev/null; sleep 0.5
rm -rf "$FX"; mkdir -p "$FX"; echo normal > "$FX/mode"; touch "$FX/h1-ip-local"
FAKE_LISTEN=0.0.0.0 "$NODE" $TESTS/fake-xapi.js $XPORT "$FX" >> /var/tmp/xnet-fake.log 2>&1 & FPID=$!
sleep 0.7
code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}' >/dev/null; S=$(field d.sessionRef < $BODY)
check "xs-01 to 127.0.0.2: started" 202 \
  "$(x network_management_change '"hostRef":"OpaqueRef:host-1","networkRef":"OpaqueRef:net-mgmt","mode":"Static","ip":"127.0.0.2","netmask":"255.0.0.0","gateway":"","dns":[],"confirmName":"xs-01"')"
JOB=$(field d.job.id < $BODY)
check "  done: XenMan found the coordinator at its new address and took it as the pool's" "done done,done,done" "$(jobwait "$JOB")"
check "  the old address answers no more" 000 "$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:$XPORT/jsonrpc)"
check "  the pool's address in XenMan is the new one" 127.0.0.2 "$("$NODE" -pe "JSON.parse(require('fs').readFileSync('$DATA/hosts.json')).find(h=>h.id==='pool1').address")"
check "  connecting again works, the management interface shown there" "200 127.0.0.2" \
  "$(code $A -X POST $B/api/xen $J -d '{"action":"connect","hostId":"pool1"}'; S=$(field d.sessionRef < $BODY); x host_networking '"hostRef":"OpaqueRef:host-1"' >/dev/null; echo " $(field 'd.interfaces.find(i=>i.management).ip' < $BODY)")"

echo; echo "$pass passed, $fail failed"
exit $fail
