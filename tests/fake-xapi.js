// A stand-in XenServer 8 pool for tests: JSON-RPC on /jsonrpc and the /updates
// handler. Two hosts (xs-01 coordinator, xs-02), three VMs, an update channel,
// and the XAPI rules that matter for installing updates:
//   - apply_updates refuses while host.pending_guidances is not empty,
//     and while VMs run on a host whose update needs RebootHost/EvacuateHost;
//   - a host restart takes it away for a while -- the coordinator's takes the
//     whole API away (connections are dropped);
//   - a restart clears what was pending; a toolstack restart clears restart_toolstack.
// Steered by files in STATE_DIR: mode (normal|license|norepo|nosync|slow),
// ha, h2-offline, stuck-vm, apply-fails, h1-no-reboot-guidance.
// Every call goes to STATE_DIR/calls.log.
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || 4480);
const DIR = process.argv[3] || "/var/tmp/fake-xapi";
const DOWN_MS = Number(process.env.FAKE_DOWN_MS || 3000);
const USER = "root", PASS = "secret";
fs.mkdirSync(DIR, { recursive: true });

const flag = (n) => fs.existsSync(path.join(DIR, n));
const mode = () => { try { return fs.readFileSync(path.join(DIR, "mode"), "utf8").trim(); } catch { return "normal"; } };
const log = (s) => fs.appendFileSync(path.join(DIR, "calls.log"), s + "\n");

const POOL = "OpaqueRef:pool", H1 = "OpaqueRef:host-1", H2 = "OpaqueRef:host-2", REPO = "OpaqueRef:repo";
const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const st = {
  synced: mode() !== "nosync",
  lastSync: "20260928T08:00:00Z",
  tasks: {},
  n: 0,
  apiDownUntil: 0,
  hosts: {
    [H1]: { name: "xs-01", address: "10.0.0.11", enabled: true, pending: [], updates: ["XSU-2026-001", "XSU-2026-002"], guidance: ["RebootHost"], downUntil: 0, reboots: 0 },
    [H2]: { name: "xs-02", address: "10.0.0.12", enabled: true, pending: ["reboot_host"], updates: ["XSU-2026-002"], guidance: ["RestartToolstack"], downUntil: 0, reboots: 0 },
  },
  vms: {
    "OpaqueRef:vm-1": { name: "web-01", resident: H1, power: "Running" },
    "OpaqueRef:vm-2": { name: "db-01", resident: H2, power: "Running" },
    "OpaqueRef:vm-3": { name: "old", resident: "OpaqueRef:NULL", power: "Halted" },
    "OpaqueRef:dom0-1": { name: "Control domain on xs-01", resident: H1, power: "Running", dom0: true },
    "OpaqueRef:dom0-2": { name: "Control domain on xs-02", resident: H2, power: "Running", dom0: true },
  },
};
// field-state: the pool as a first, failed run left it -- the coordinator in
// maintenance mode with its update installed and a toolstack restart pending.
// left-in-maintenance: as the second run left it -- toolstack done, the
// coordinator still in maintenance mode, its VMs on the other host.
if (flag("left-in-maintenance")) {
  Object.assign(st.hosts[H1], { enabled: false, pending: [], updates: [] });
  Object.assign(st.hosts[H2], { pending: [] });
  st.vms["OpaqueRef:vm-1"].resident = H2;
}
// memory-model: web-02 runs on xs-01 beside web-01, with the same settings;
// hidden-01 is halted and hidden from XenCenter (other_config).
if (flag("memory-model")) {
  st.vms["OpaqueRef:vm-4"] = { name: "web-02", resident: H1, power: "Running" };
  st.vms["OpaqueRef:vm-5"] = { name: "hidden-01", resident: "OpaqueRef:NULL", power: "Halted" };
}
// standalone: this fake is a server of its own, xs-03 (the uuid the pool's fake
// gives H3), to be added to the other fake's pool. joiner-running-vm: a VM runs on it.
const STANDALONE = flag("standalone");
if (STANDALONE) {
  st.hosts = { "OpaqueRef:host-3": { name: "xs-03", address: "127.0.0.1", enabled: true, pending: [], updates: [], guidance: [], downUntil: 0, reboots: 0 } };
  st.vms = { "OpaqueRef:dom0-3": { name: "Control domain on xs-03", resident: "OpaqueRef:host-3", power: "Running", dom0: true } };
}
// local-addresses: the hosts answer at 127.0.0.1 (a removed server is waited for there).
if (flag("local-addresses")) for (const x of Object.values(st.hosts)) x.address = "127.0.0.1";
// vm3-running: "old" runs on xs-01 too, so two VMs share a host.
if (flag("vm3-running")) Object.assign(st.vms["OpaqueRef:vm-3"], { resident: H1, power: "Running" });
if (flag("field-state")) {
  Object.assign(st.hosts[H1], { enabled: false, pending: ["restart_toolstack"], updates: [] });
  Object.assign(st.hosts[H2], { pending: [] });
}
// Workload Balancing: wlb-on connects a server that acts, wlb-paused one that is
// paused. wlb-unreachable makes the server refuse, wlb-rec has it recommend
// moving web-01 to xs-02, wlb-pause-fails refuses set_wlb_enabled.
st.wlb = {
  url: flag("wlb-on") || flag("wlb-paused") ? "wlb21.example.org:8012" : "",
  username: flag("wlb-on") || flag("wlb-paused") ? "wlbuser" : "",
  enabled: flag("wlb-on"),
  verifyCert: false,
  config: { OptimizationMode: "0", AutoBalanceEnabled: "true", PowerManagementEnabled: "false", AutoBalanceSeverity: "High",
    HostCpuThresholdCritical: "0.9", HostCpuThresholdHigh: "0.76", CpuHighThresholdFactor: ".85", WlbVersion: "8.4.0", CredentialsValid: "true",
    [`host_${U1}_ParticipatesInPowerManagement`]: "False", [`host_${U2}_ParticipatesInPowerManagement`]: "False" },
  // A per-host key WLB does not know: kept twice, as the real one did -- and
  // from then on every retrieve fails with 4014.
  broken: null,
  sent: [],
  enabledLog: [],
};
const WLB_HOST_KEYS = ["ParticipatesInPowerManagement", "ExcludeFromPlacementRecommendations", "ExcludeFromEvacuationRecommendations",
  "ExcludeFromPoolOptimizations", "ExcludeFromPoolOptimizationAcceptVMs"];
const wlbReachable = () => {
  if (!st.wlb.url) fail("WLB_NOT_INITIALIZED");
  if (st.wlb.broken) fail("WLB_INTERNAL_ERROR", "4014", `An item with the same key has already been added. Key: ${st.wlb.broken}`);
  if (flag("wlb-unreachable")) fail("WLB_CONNECTION_REFUSED", "wlb21.example.org:8012");
};
// Networking, laid out like a real pool (xen-inf-18): per host eth0+eth1 bonded
// for management, eth2+eth3 bonded for storage with VLAN 2232 and a secondary
// interface on it, eth4 on its own; a private network without PIFs, the guest
// installer network (hidden) and the bond members' own networks (hidden).
// net-eth4-down: xs-02's eth4 has no carrier.
st.net = { networks: {}, pifs: {}, metrics: {}, bonds: {}, vlans: {}, vifs: {}, sriovs: {}, n: 0 };
{
  const N = st.net;
  const net = (ref, name, extra = {}) => (N.networks[ref] = { uuid: `uuid-${ref}`, name_label: name, name_description: "", bridge: `xenbr-${ref}`, MTU: "1500", PIFs: [], VIFs: [], other_config: { automatic: "false" }, tags: [], ...extra });
  const pif = (ref, host, network, extra = {}) => {
    N.pifs[ref] = { uuid: `uuid-${ref}`, host, network, device: "", MAC: "", VLAN: "-1", IP: "", netmask: "", gateway: "", DNS: "", ip_configuration_mode: "None",
      management: false, physical: false, currently_attached: true, metrics: `OpaqueRef:pm-${ref}`, bond_master_of: [], bond_slave_of: "OpaqueRef:NULL",
      VLAN_master_of: "OpaqueRef:NULL", sriov_logical_PIF_of: [], sriov_physical_PIF_of: [], tunnel_access_PIF_of: [], capabilities: [], other_config: {}, disallow_unplug: false, managed: true, ...extra };
    N.metrics[`OpaqueRef:pm-${ref}`] = { carrier: true, speed: "10000", duplex: true, vendor_name: "Intel Corporation", device_name: "Ethernet 10G 2P X520", pci_bus_path: `0000:0${ref.slice(-1)}:00.0` };
    N.networks[network].PIFs.push(ref);
  };
  net("OpaqueRef:net-mgmt", "Bond_Management");
  net("OpaqueRef:net-nfs", "Bond_NFS", { other_config: { automatic: "true" } });
  net("OpaqueRef:net-2232", "vlan2232N");
  net("OpaqueRef:net-eth4", "Pool-wide network associated with eth4", { other_config: {} });
  net("OpaqueRef:net-private", "Private", { other_config: { automatic: "false" }, name_description: "VMs on one host" });
  net("OpaqueRef:net-installer", "Host internal management network", { other_config: { is_guest_installer_network: "true" } });
  for (let d = 0; d < 4; d++) net(`OpaqueRef:net-eth${d}`, `Pool-wide network associated with eth${d}`);
  for (const [i, h] of [[1, H1], [2, H2]]) {
    const ip = (n) => `10.0.0.${n}${i}`;
    for (let d = 0; d < 5; d++) {
      pif(`OpaqueRef:pif-${i}-eth${d}`, h, `OpaqueRef:net-eth${d === 4 ? "4" : d}`, { device: `eth${d}`, MAC: `00:25:b5:aa:0${i}:0${d}`, physical: true,
        capabilities: d === 4 ? ["sriov"] : [], currently_attached: d !== 4 });
    }
    N.bonds[`OpaqueRef:bond-${i}-m`] = { master: `OpaqueRef:pif-${i}-bm`, slaves: [`OpaqueRef:pif-${i}-eth0`, `OpaqueRef:pif-${i}-eth1`], mode: "active-backup", properties: {}, primary_slave: `OpaqueRef:pif-${i}-eth0` };
    N.bonds[`OpaqueRef:bond-${i}-n`] = { master: `OpaqueRef:pif-${i}-bn`, slaves: [`OpaqueRef:pif-${i}-eth2`, `OpaqueRef:pif-${i}-eth3`], mode: "balance-slb", properties: {}, primary_slave: `OpaqueRef:pif-${i}-eth2` };
    pif(`OpaqueRef:pif-${i}-bm`, h, "OpaqueRef:net-mgmt", { device: "bond0", MAC: `00:25:b5:aa:0${i}:7c`, physical: false, bond_master_of: [`OpaqueRef:bond-${i}-m`],
      management: true, ip_configuration_mode: "Static", IP: ip(1), netmask: "255.255.255.0", gateway: "10.0.0.1", DNS: "10.0.0.53,10.0.0.54" });
    pif(`OpaqueRef:pif-${i}-bn`, h, "OpaqueRef:net-nfs", { device: "bond1", MAC: `00:25:b5:aa:0${i}:7d`, physical: false, bond_master_of: [`OpaqueRef:bond-${i}-n`] });
    for (const d of [0, 1]) N.pifs[`OpaqueRef:pif-${i}-eth${d}`].bond_slave_of = `OpaqueRef:bond-${i}-m`;
    for (const d of [2, 3]) N.pifs[`OpaqueRef:pif-${i}-eth${d}`].bond_slave_of = `OpaqueRef:bond-${i}-n`;
    N.vlans[`OpaqueRef:vlan-${i}`] = { tagged_PIF: `OpaqueRef:pif-${i}-bn`, untagged_PIF: `OpaqueRef:pif-${i}-v`, tag: "2232" };
    pif(`OpaqueRef:pif-${i}-v`, h, "OpaqueRef:net-2232", { device: "bond1", VLAN: "2232", VLAN_master_of: `OpaqueRef:vlan-${i}`, MAC: `00:25:b5:aa:0${i}:7d`,
      ip_configuration_mode: "Static", IP: `192.0.2.11${i}`, netmask: "255.255.255.0", other_config: { management_purpose: `xs-0${i}_NFS` }, disallow_unplug: true });
  }
  // eth6, eth7: free NICs, to make a bond of.
  for (const d of [6, 7]) {
    net(`OpaqueRef:net-eth${d}`, `Pool-wide network associated with eth${d}`, { other_config: {} });
    for (const i of [1, 2]) pif(`OpaqueRef:pif-${i}-eth${d}`, i === 1 ? H1 : H2, `OpaqueRef:net-eth${d}`, { device: `eth${d}`, MAC: `00:25:b5:cc:0${i}:0${d}`, physical: true });
  }
  // eth5: a NIC XAPI does not manage (managed=false) -- XenCenter hides its network.
  net("OpaqueRef:net-eth5", "Pool-wide network associated with eth5", { other_config: {} });
  for (const i of [1, 2]) pif(`OpaqueRef:pif-${i}-eth5`, i === 1 ? H1 : H2, "OpaqueRef:net-eth5", { device: "eth5", MAC: `00:25:b5:bb:0${i}:05`, physical: true, managed: false });
  // The physical PIFs are physical; their bond interfaces are not (XAPI: physical=false for bonds).
  for (const p of Object.values(N.pifs)) if (/eth\d$/.test(p.device) && p.VLAN === "-1") p.physical = true;
  if (flag("net-eth4-down")) N.metrics["OpaqueRef:pm-OpaqueRef:pif-2-eth4"].carrier = false;
  if (flag("h1-ip-local")) Object.assign(N.pifs["OpaqueRef:pif-1-bm"], { IP: "127.0.0.1", netmask: "255.0.0.0", gateway: "" });
  N.vifs["OpaqueRef:vif-1"] = { VM: "OpaqueRef:vm-1", network: "OpaqueRef:net-private", device: "0", currently_attached: true };
  N.networks["OpaqueRef:net-private"].VIFs.push("OpaqueRef:vif-1");
}
const live = (h) => Date.now() >= st.hosts[h].downUntil && !(h === H2 && flag("h2-offline"));
// The pool's update settings (Configure Updates): its repositories, which are
// enabled, the synchronization schedule and the proxy. "norepo": none enabled.
// VM snapshot schedules (vmss-model): the schedules, and which VM is in which.
function vmssModel() {
  return (st.vmss ??= {
    recs: flag("vmss-model")
      ? { "OpaqueRef:vmss-nightly": { uuid: "vmss-uuid-nightly", name_label: "Nightly", name_description: "", enabled: true, type: "snapshot",
          retained_snapshots: "7", frequency: "daily", schedule: { hour: "2", min: "0" }, last_run_time: "20261121T02:00:00Z" } }
      : {},
    vmOf: flag("vmss-model") ? { "OpaqueRef:vm-2": "OpaqueRef:vmss-nightly" } : {},
  });
}
function vmssRecord(ref) {
  const m = vmssModel();
  return { ...m.recs[ref], VMs: Object.keys(m.vmOf).filter((vm) => m.vmOf[vm] === ref) };
}
function vmssLicensed() {
  if (flag("vmss-restricted")) fail("LICENCE_RESTRICTION", "VMSS");
}
// xapi_vmss.ml: the keys each frequency takes, and their values.
const VMSS_KEYS = { hourly: ["min"], daily: ["hour", "min"], weekly: ["hour", "min", "days"] };
const VMSS_DAY_ENUM = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
function vmssCheck(frequency, schedule, retained, type) {
  if (!VMSS_KEYS[frequency]) fail("INVALID_VALUE", "frequency", frequency);
  if (!["snapshot", "checkpoint", "snapshot_with_quiesce"].includes(type)) fail("INVALID_VALUE", "type", type);
  if (!(retained >= 1 && retained <= 10)) fail("INVALID_VALUE", "retained_snapshots", String(retained));
  for (const k of Object.keys(schedule)) if (!VMSS_KEYS[frequency].includes(k)) fail("INVALID_VALUE", "schedule", k);
  for (const k of VMSS_KEYS[frequency]) if (schedule[k] === undefined) fail("MAP_KEY_MISSING", "schedule", k);
  if (!["0", "15", "30", "45"].includes(String(schedule.min))) fail("INVALID_VALUE", "min", String(schedule.min));
  if (schedule.hour !== undefined && !(Number(schedule.hour) >= 0 && Number(schedule.hour) <= 23)) fail("INVALID_VALUE", "hour", String(schedule.hour));
  if (schedule.days !== undefined && !String(schedule.days).split(",").every((d) => VMSS_DAY_ENUM.includes(d.toLowerCase()))) fail("INVALID_VALUE", "days", schedule.days);
}
function updConf(m) {
  return (st.updConf ??= {
    repos: { [REPO]: { name_label: "Normal", name_description: "", binary_url: "https://repo.ops.xenserver.com/xs8/normal", source_url: "https://repo-src.ops.xenserver.com/xs8/normal", update: true } },
    enabled: m === "norepo" ? [] : [REPO],
    syncEnabled: true, frequency: "weekly", day: "0",
    proxyUrl: "", proxyUser: "", proxySecret: "OpaqueRef:NULL", secrets: {},
  });
}
const UPDATE_META = {
  "XSU-2026-001": { id: "XSU-2026-001", summary: "Xen security fix", description: "Fixes XSA-999.\nRestart required.", severity: "High", type: "SecurityFix",
    issued: "20260920T00:00:00Z", URL: "https://support.example/XSU-2026-001", guidance: { mandatory: ["RebootHost"], recommended: [], full: ["RebootHost"], livepatch: [] } },
  "XSU-2026-002": { id: "XSU-2026-002", summary: "Toolstack improvements", description: "Better things.", severity: "None", type: "Improvement",
    issued: "2026-09-25T00:00:00Z", URL: "javascript:alert(1)", guidance: { mandatory: ["RestartToolstack"], recommended: [], full: [], livepatch: [] } },
  "XSU-2025-900": { id: "XSU-2025-900", summary: "Already everywhere", severity: "None", type: "Bugfix", issued: "2025-01-01T00:00:00Z" },
};
// What the metadata says a host's updates need. no-guidance: it says nothing
// (and apply still leaves restart_toolstack pending, as seen in the field).
// full-reboot: nothing mandatory or recommended, a host restart only for full
// effectiveness, and live patches for Xen and the kernel (as XenCenter showed
// for a pool in the field, 2026-11-20).
function hostGuidance(ref) {
  const h = st.hosts[ref];
  if (!h.updates.length || flag("no-guidance") || flag("hidden-reboot") || flag("full-reboot")) return [];
  return h.guidance;
}
const fullGuidance = (ref) => (st.hosts[ref].updates.length && flag("full-reboot") ? ["RebootHost"] : []);
const LIVEPATCHES = [
  { component: "xen", "base-build-id": "aaaa", base: "4.17.5-10", to: "4.17.5-11" },
  { component: "kernel", "base-build-id": "bbbb", base: "4.19.19-8.0.40", to: "4.19.19-8.0.41" },
];
const livepatchesOf = (ref) => (st.hosts[ref].updates.length && flag("full-reboot") ? LIVEPATCHES : []);
function updatesJson() {
  const legacy = flag("legacy-format");
  const meta = Object.values(UPDATE_META).map((u) => {
    if (flag("no-guidance") || flag("hidden-reboot")) return { ...u, guidance: { mandatory: [], recommended: [], full: [], livepatch: [] } };
    if (flag("full-reboot")) return { ...u, guidance: { mandatory: [], recommended: [], full: ["RebootHost"], livepatch: [] } };
    if (!legacy || !u.guidance) return u;
    const { guidance, URL, ...rest } = u;
    return { ...rest, url: URL, "recommended-guidance": guidance.mandatory[0] || "", "livepatch-guidance": "" };
  });
  return {
    hosts: Object.keys(st.hosts).map((ref) => legacy
      ? { ref, "recommended-guidance": hostGuidance(ref), "absolute-guidance": [], RPMS: [], updates: st.hosts[ref].updates, livepatches: [] }
      : { ref, guidance: { mandatory: hostGuidance(ref), recommended: [], full: fullGuidance(ref), livepatch: [] }, RPMS: [], updates: st.hosts[ref].updates, livepatches: livepatchesOf(ref) }),
    updates: meta,
    hash: "abc123hash",
  };
}
// The method being answered: a task is named after it, as XAPI names Async calls.
let currentMethod = "";
// XAPI's datetime: 20261120T13:32:35Z.
const xapiNow = () => new Date().toISOString().replace(/-/g, "").replace(/\.\d+Z$/, "Z");
function task(polls, done) {
  const id = "OpaqueRef:task-" + (++st.n);
  st.tasks[id] = { polls, done, name_label: currentMethod, created: xapiNow(), resident_on: H1, other_config: {} };
  return id;
}
// foreign-task: tasks of other clients -- XenCenter migrating web-01 (its
// XenCenterUUID, applies_to as XenCenter writes it), an evacuation by xe on
// xs-02, a subtask and an operation the list does not show. Running until cancelled.
function foreignTasks() {
  if (st.foreignMade) return;
  st.foreignMade = true;
  const mk = (ref, name_label, resident_on, other_config, subtask_of) =>
    (st.tasks[ref] = { polls: 1e9, done: () => "", name_label, created: xapiNow(), resident_on, other_config, subtask_of });
  mk("OpaqueRef:task-xc-migrate", "Async.VM.pool_migrate", H1, { XenCenterUUID: "c0ffee", applies_to: "OpaqueRef:vm-1,OpaqueRef:host-2" });
  mk("OpaqueRef:task-xe-evacuate", "Async.host.evacuate", H2, {});
  mk("OpaqueRef:task-xc-sub", "Async.VM.start", H1, {}, "OpaqueRef:task-xc-migrate");
  mk("OpaqueRef:task-xc-scan", "Async.SR.scan", H1, {});
}
const H3 = "OpaqueRef:host-3";
const HOST_UUID = { [H1]: "11111111-1111-4111-8111-111111111111", [H2]: "22222222-2222-4222-8222-222222222222", [H3]: "33333333-3333-4333-8333-333333333333" };
if (flag("three-hosts")) {
  st.hosts[H3] = { name: "xs-03", address: "10.0.0.13", enabled: true, pending: [], updates: ["XSU-2026-002"], guidance: ["RebootHost"], downUntil: 0, reboots: 0 };
}
// full-reboot: no restart left over from earlier either, so only the full one is in play.
if (flag("full-reboot")) for (const x of Object.values(st.hosts)) x.pending = [];
// vmss-model: a template too, which no schedule may take.
if (flag("vmss-model")) st.vms["OpaqueRef:vm-tpl"] = { name: "base-template", resident: "OpaqueRef:NULL", power: "Halted", template: true };
// single-host: a pool of xs-01 alone (issue #8), xs-02's VMs running there instead;
// vms-off: every VM shut down.
if (flag("single-host")) {
  delete st.hosts[H2];
  delete st.vms["OpaqueRef:dom0-2"];
  for (const v of Object.values(st.vms)) if (v.resident === H2) v.resident = H1;
}
if (flag("vms-off")) for (const v of Object.values(st.vms)) if (!v.dom0) Object.assign(v, { power: "Halted", resident: "OpaqueRef:NULL" });
// The other two lists of left-over tasks (XenServer 8.4): recommended and full.
for (const x of Object.values(st.hosts)) Object.assign(x, { pendingRecommended: x.pendingRecommended ?? [], pendingFull: x.pendingFull ?? [] });
const vmUuid = (ref) => "aaaaaaaa-0000-4000-8000-00000000000" + ref.slice(-1);
// Data sources as VM.get_data_sources / host.get_data_sources list them: the
// recorded ones are the columns rrdXml writes; the others start out off and
// are written once record_data_source switched them on (per VM or host).
const DS_VM = [
  ["cpu0", "(fraction)", true], ["cpu1", "(fraction)", true], ["memory", "B", true], ["memory_internal_free", "KiB", true],
  ["vif_0_rx", "B/s", true], ["vif_0_tx", "B/s", true], ["vif_1_rx", "B/s", true],
  ["vbd_xvda_read", "B/s", true], ["vbd_xvda_write", "B/s", true], ["vbd_xvdb_read", "B/s", true],
  ["vbd_xvda_read_latency", "μs", false], ["vbd_xvdb_read_latency", "μs", false],
];
const DS_HOST = [
  ["cpu0", "(fraction)", true], ["cpu1", "(fraction)", true], ["memory_total_kib", "KiB", true], ["memory_free_kib", "KiB", true],
  ["pif_eth0_rx", "B/s", true], ["pif_eth0_tx", "B/s", true], ["pif_aggr_rx", "B/s", true], ["pif_aggr_tx", "B/s", true],
  ["loadavg", "(fraction)", true], ["iops_total_c8ae5f3b", "requests/s", true], ["xapi_open_fds", "", false],
];
const recordedNow = new Set();
const isRecorded = (ref, ds) => ds[2] || recordedNow.has(ref + "|" + ds[0]);
// As a real XenServer 8 sends them: no maximum is a bare Infinity, no value a
// bare NaN -- not JSON (marked here, written out below).
const dsRecords = (ref, list) => list.map((d) => ({ name_label: d[0], name_description: "About " + d[0] + " (max Infinity, else NaN)", enabled: isRecorded(ref, d), standard: d[2], units: d[1], min: "__NINF__", max: "__INF__", value: "__NAN__" }));
// A window of rrd_updates as XAPI writes it: the host and the VMs on it (or one
// VM), three rows newest first, NaN where nothing was recorded.
function rrdXml(hostRef, onlyVm, interval, json = false) {
  const cols = [];
  const add = (kind, uuid, name, f) => cols.push([`AVERAGE:${kind}:${uuid}:${name}`, f]);
  if (!onlyVm) {
    const u = HOST_UUID[hostRef];
    add("host", u, "cpu0", (i) => 0.1 + 0.1 * i);
    add("host", u, "cpu1", (i) => 0.3 + 0.1 * i);
    add("host", u, "memory_total_kib", () => 64 * 1024 * 1024);
    add("host", u, "memory_free_kib", () => 48 * 1024 * 1024);
    add("host", u, "pif_eth0_rx", () => 1000);
    add("host", u, "pif_eth0_tx", () => 2000);
    add("host", u, "pif_aggr_rx", () => 1500);
    add("host", u, "pif_aggr_tx", () => 2500);
    add("host", u, "loadavg", (i) => (i === 1 ? NaN : 0.5));
    add("host", u, "iops_total_c8ae5f3b", () => (hostRef === H1 ? 120 : 80));
    if (recordedNow.has(hostRef + "|xapi_open_fds")) add("host", u, "xapi_open_fds", () => 42);
  }
  for (const [ref, v] of Object.entries(st.vms)) {
    if (v.dom0 || v.power !== "Running") continue;
    if (onlyVm ? vmUuid(ref) !== onlyVm : v.resident !== hostRef) continue;
    const u = vmUuid(ref);
    add("vm", u, "cpu0", () => 0.5);
    add("vm", u, "cpu1", () => 0.25);
    add("vm", u, "memory", () => 4 * 1024 ** 3);
    add("vm", u, "memory_internal_free", () => 1024 * 1024);
    add("vm", u, "vif_0_rx", () => 100);
    add("vm", u, "vif_0_tx", () => 200);
    add("vm", u, "vif_1_rx", () => 50);
    add("vm", u, "vbd_xvda_read", () => 4096);
    add("vm", u, "vbd_xvda_write", () => 8192);
    add("vm", u, "vbd_xvdb_read", () => 1024);
    if (recordedNow.has(ref + "|vbd_xvda_read_latency")) add("vm", u, "vbd_xvda_read_latency", () => 1500);
    if (recordedNow.has(ref + "|vbd_xvdb_read_latency")) add("vm", u, "vbd_xvdb_read_latency", () => 500);
  }
  const end = Math.floor(Date.now() / 1000);
  const fmt = (x) => (Number.isNaN(x) ? "NaN" : x.toExponential(10).toUpperCase());
  if (json) {
    const data = [0, 1, 2].map((k) => `{"t":"${end - k * interval}","values":[${cols.map((c) => { const x = c[1](2 - k); return Number.isNaN(x) ? "NaN" : `"${fmt(x)}"`; }).join(",")}]}`);
    return `{"meta":{"start":"${end - 3 * interval}","step":"${interval}","end":"${end}","rows":"3","columns":"${cols.length}","legend":${JSON.stringify(cols.map((c) => c[0]))}},"data":[${data.join(",")}]}`;
  }
  const rows = [0, 1, 2].map((k) => `<row><t>${end - k * interval}</t>${cols.map((c) => `<v>${fmt(c[1](2 - k))}</v>`).join("")}</row>`);
  return `<?xml version="1.0" encoding="UTF-8"?><xport><meta><start>${end - 3 * interval}</start><step>${interval}</step><end>${end}</end><rows>3</rows><columns>${cols.length}</columns><legend>${cols.map((c) => `<entry>${c[0]}</entry>`).join("")}</legend></meta><data>${rows.join("")}</data></xport>`;
}
// vgpu-model: two NVIDIA A16 GPUs per host as XAPI describes them -- pass-through,
// A16-16Q (1 per GPU), A16-8Q (2, not enabled) and A16-1B (16); web-01 and db-01
// each with an A16-1B on their host's first GPU; two GPU groups with different
// placement policies ("Mixed").
function gpuModel() {
  const caps = { "OpaqueRef:vt-pt": 1, "OpaqueRef:vt-16q": 1, "OpaqueRef:vt-8q": 2, "OpaqueRef:vt-1b": 16 };
  const types = {
    "OpaqueRef:vt-pt": { model_name: "passthrough", max_resolution_x: 0, max_resolution_y: 0, framebuffer_size: "0" },
    "OpaqueRef:vt-16q": { model_name: "NVIDIA A16-16Q", max_resolution_x: 7680, max_resolution_y: 4320, framebuffer_size: String(16 * 1024 ** 3) },
    "OpaqueRef:vt-8q": { model_name: "NVIDIA A16-8Q", max_resolution_x: 7680, max_resolution_y: 4320, framebuffer_size: String(8 * 1024 ** 3) },
    "OpaqueRef:vt-1b": { model_name: "NVIDIA A16-1B", max_resolution_x: 5120, max_resolution_y: 2880, framebuffer_size: String(1024 ** 3) },
  };
  const pgpus = {}, pcis = {}, vgpus = {};
  for (const [ref, x] of Object.entries(st.hosts)) {
    for (const g of ["a", "b"]) {
      const id = `OpaqueRef:pgpu-${x.name}-${g}`;
      pcis[`OpaqueRef:pci-${x.name}-${g}`] = { device_name: "GA107GL [A2 / A16]", vendor_name: "NVIDIA Corporation", pci_id: `0000:${g === "a" ? "41" : "42"}:00.0` };
      pgpus[id] = { uuid: `uuid-${id}`, host: ref, PCI: `OpaqueRef:pci-${x.name}-${g}`, GPU_group: g === "a" ? "OpaqueRef:gg-1" : "OpaqueRef:gg-2",
        supported_VGPU_types: Object.keys(caps), enabled_VGPU_types: st.gpuEnabled?.[id] ?? ["OpaqueRef:vt-pt", "OpaqueRef:vt-16q", "OpaqueRef:vt-1b"],
        supported_VGPU_max_capacities: caps, resident_VGPUs: [], compatibility_metadata: x.gpuData === false ? {} : { nvidia: "bWV0YQ==" } };
    }
  }
  for (const [vm, v] of Object.entries(st.vms)) {
    if (v.dom0 || v.power !== "Running" || !st.hosts[v.resident]) continue;
    const vg = `OpaqueRef:vgpu-${vm.slice(-1)}`;
    const on = `OpaqueRef:pgpu-${st.hosts[v.resident].name}-a`;
    vgpus[vg] = { VM: vm, type: "OpaqueRef:vt-1b", resident_on: on, device: "0", currently_attached: true };
    pgpus[on].resident_VGPUs.push(vg);
  }
  for (const t of Object.keys(types)) Object.assign(types[t], { supported_on_PGPUs: Object.keys(pgpus) });
  const groups = {
    "OpaqueRef:gg-1": { name_label: "Group of NVIDIA Corporation GA107GL [A2 / A16] GPUs", allocation_algorithm: st.gpuAlg?.["OpaqueRef:gg-1"] ?? "depth_first" },
    "OpaqueRef:gg-2": { name_label: "Group of NVIDIA Corporation GA107GL [A2 / A16] GPUs", allocation_algorithm: st.gpuAlg?.["OpaqueRef:gg-2"] ?? "breadth_first" },
  };
  return { pgpus, pcis, types, vgpus, groups };
}
const residentRunning = (h) => Object.entries(st.vms).filter(([, v]) => v.resident === h && v.power === "Running" && !v.dom0);
const fail = (...e) => { throw e; };

// Pool membership (pool-membership-test.sh). The pool's fake: a server joined
// through the standalone fake (file "joined") is its xs-03 from then on.
function membership(method, p) {
  const H3_ = "OpaqueRef:host-3";
  if (!STANDALONE && flag("joined") && !st.hosts[H3_]) {
    st.hosts[H3_] = { name: "xs-03", address: "127.0.0.1", enabled: true, pending: [], updates: [], guidance: [], downUntil: 0, reboots: 0 };
    st.vms["OpaqueRef:dom0-3"] = { name: "Control domain on xs-03", resident: H3_, power: "Running", dom0: true };
  }
  if (STANDALONE) {
    // joiner-running-vm: a VM runs on it.
    if (flag("joiner-running-vm")) st.vms["OpaqueRef:vm-9"] ??= { name: "busy-01", resident: H3_, power: "Running" };
    else delete st.vms["OpaqueRef:vm-9"];
    switch (method) {
      // named-pool: it is a pool of its own (XenCenter: "already in pool").
      case "pool.get_all_records":
        return { [POOL]: { name_label: flag("named-pool") ? "Lab" : "", master: H3_, ha_enabled: false, tls_verification_enabled: false, default_SR: "OpaqueRef:NULL", cpu_info: {} } };
      case "SR.get_all_records":
        return flag("joiner-shared-sr")
          ? { "OpaqueRef:sr-nfs-j": { name_label: "NFS", shared: true, type: "nfs" } }
          : { "OpaqueRef:sr-local-j": { name_label: "Local storage", shared: false, type: "lvm" } };
      case "PIF.get_all_records":
        return { "OpaqueRef:pif-j0": { physical: true, management: true, device: "eth0", VLAN: "-1", ip_configuration_mode: "DHCP", host: H3_ } };
      case "Async.pool.join": {
        log(`join ${p[1]} ${p[2]}`);
        if (p[2] !== USER || p[3] !== PASS) fail("POOL_JOINING_HOST_CANNOT_HAVE_RUNNING_OR_SUSPENDED_VMS"); // any refusal will do
        return task(1, () => { if (process.env.FAKE_JOIN_DIR) fs.writeFileSync(path.join(process.env.FAKE_JOIN_DIR, "joined"), ""); return ""; });
      }
    }
    return undefined;
  }
  switch (method) {
    // The GPU tab's edits (vgpu-model).
    case "GPU_group.set_allocation_algorithm":
      log(`set_allocation_algorithm ${p[1]} ${p[2]}`);
      (st.gpuAlg ??= {})[p[1]] = p[2];
      return "";
    case "PGPU.set_enabled_VGPU_types":
      log(`set_enabled_VGPU_types ${p[1]} ${[...p[2]].sort().join(",")}`);
      (st.gpuEnabled ??= {})[p[1]] = p[2];
      return "";
    // License Manager: the licence server per host, the pool's edition.
    case "host.set_license_server":
      log(`set_license_server ${st.hosts[p[1]].name} ${JSON.stringify(p[2])}`);
      (st.licServer ??= {})[p[1]] = p[2];
      return "";
    case "pool.apply_edition":
      log(`apply_edition ${p[2]}`);
      if (flag("lic-apply-fails")) fail("LICENSE_CHECKOUT_ERROR", p[2]);
      st.licEdition = p[2];
      return "";
    // local-default-sr: the pool's default SR is a host's local one.
    case "SR.get_shared": return p[1] !== "OpaqueRef:sr-local";
    case "pool.set_default_SR": case "pool.set_crash_dump_SR": case "pool.set_suspend_image_SR":
      log(`${method} ${p[2]}`); return "";
    case "pool.eject": {
      const x = st.hosts[p[1]];
      if (!x) fail("HANDLE_INVALID", "host", p[1]);
      log(`eject ${x.name}`);
      delete st.hosts[p[1]];
      for (const v of Object.values(st.vms)) if (v.resident === p[1]) Object.assign(v, { resident: "OpaqueRef:NULL", power: v.dom0 ? "Halted" : v.power });
      return "";
    }
  }
  return undefined;
}

let inMemoryModel = false;
// memory-model: what XenCenter's Memory tab reads, for 64 GiB hosts. Each host
// 512 MiB overhead, its control domain 4 GiB; web-01 and web-02 balloon (2-4
// GiB, static 8 GiB, now 4 and 3 GiB), db-01 does not (8 GiB); each VM 64 MiB
// overhead. "old" (halted) has its disk on xs-02's local storage but xs-01 as
// affinity; hidden-01 has xs-01 as affinity.
// Static minimum 1 GiB (512 MiB for "old"); db-01 may only be shut down hard;
// web-01 and web-02 have current VM Tools. VM.set_memory_limits and
// set_memory_dynamic_range change these (memory-fails: set_memory_limits fails).
const GiB_ = 1024 ** 3, MiB_ = 1024 ** 2;
function memState() {
  return (st.mem ??= {
    "OpaqueRef:vm-1": { smin: GiB_, min: 2 * GiB_, max: 4 * GiB_, smax: 8 * GiB_, actual: 4 * GiB_, balloon: true },
    "OpaqueRef:vm-4": { smin: GiB_, min: 2 * GiB_, max: 4 * GiB_, smax: 8 * GiB_, actual: 3 * GiB_, balloon: true },
    "OpaqueRef:vm-2": { smin: GiB_, min: 8 * GiB_, max: 8 * GiB_, smax: 8 * GiB_, actual: 8 * GiB_ },
    "OpaqueRef:vm-3": { smin: 512 * MiB_, min: GiB_, max: GiB_, smax: GiB_, actual: GiB_ },
    // The control domains: 4 GiB, at least 2 GiB.
    "OpaqueRef:dom0-1": { smin: 2 * GiB_, min: 4 * GiB_, max: 4 * GiB_, smax: 8 * GiB_, actual: 4 * GiB_ },
    "OpaqueRef:dom0-2": { smin: 2 * GiB_, min: 4 * GiB_, max: 4 * GiB_, smax: 8 * GiB_, actual: 4 * GiB_ },
  });
}
function memoryVmRecord(r) {
  const v = st.vms[r];
  const m = memState()[r] || { smin: GiB_, min: 4 * GiB_, max: 4 * GiB_, smax: 4 * GiB_ };
  return { name_label: v.name, power_state: v.power, resident_on: v.resident, is_control_domain: Boolean(v.dom0), domid: v.dom0 ? "0" : "5",
    memory_overhead: String(v.dom0 ? 0 : 64 * MiB_), memory_static_min: String(m.smin), memory_dynamic_min: String(m.min), memory_dynamic_max: String(m.max),
    memory_static_max: String(m.smax), HVM_boot_policy: v.dom0 ? "" : "BIOS order",
    // vm-tools (screenshots): guests as HVM, as XenServer reports them.
    ...(flag("vm-tools") && !v.dom0 ? { domain_type: "hvm" } : {}),
    allowed_operations: r === "OpaqueRef:vm-2" ? ["hard_shutdown", "start", "start_on"] : ["clean_shutdown", "hard_shutdown", "start", "start_on"],
    current_operations: {},
    metrics: `OpaqueRef:vmm-${r.slice(10)}`, guest_metrics: v.dom0 ? "OpaqueRef:NULL" : `OpaqueRef:gm-${r.slice(10)}`,
    affinity: r === "OpaqueRef:vm-3" || r === "OpaqueRef:vm-5" ? H1 : "OpaqueRef:NULL",
    VBDs: r === "OpaqueRef:vm-3" ? ["OpaqueRef:vbd-mem-3"] : [],
    other_config: r === "OpaqueRef:vm-5" ? { HideFromXenCenter: "true" } : {} };
}
// rdp-model: a Windows VM for Remote Desktop in the console window (lib/vm-rdp.ts).
//   win-01 (OpaqueRef:rdp-vm-1, uuid rdp-uuid-1) runs on xs-01 with three VIFs:
//   0 on a network whose PIF on xs-01 has its link up -- 127.0.0.4 and ::1;
//   1 on a network whose PIF's link is down -- 127.0.0.6 (to be left out);
//   2 on a network without a PIF on xs-01 -- 127.0.0.5.
//   So XenCenter's order is 127.0.0.4, ::1, 127.0.0.5. Guest flags: feature-ts,
//   feature-ts2, data-ts all "1"; rdp-model-off: data-ts "0"; rdp-model-old: no
//   feature-ts2 (an old agent). VM.call_plugin is logged as "rdp plugin <fn> <name>".
const RDP_VM = "OpaqueRef:rdp-vm-1";
function rdpModel(method, p) {
  const ref = p[1];
  if (method === "VM.get_record" && ref === RDP_VM) {
    return { uuid: "rdp-uuid-1", name_label: "win-01", power_state: flag("rdp-model-halted") ? "Halted" : "Running", is_control_domain: false,
      resident_on: H1, guest_metrics: "OpaqueRef:rdp-gm-1", VIFs: ["OpaqueRef:rdp-vif-0", "OpaqueRef:rdp-vif-1", "OpaqueRef:rdp-vif-2"], memory_dynamic_max: "4294967296" };
  }
  if (method === "VM_guest_metrics.get_record" && ref === "OpaqueRef:rdp-gm-1") {
    const other = { "feature-ts": "1", "data-ts": flag("rdp-model-off") ? "0" : "1" };
    if (!flag("rdp-model-old")) other["feature-ts2"] = "1";
    return { os_version: { name: "Windows Server 2022 Standard|C:\\Windows" }, other,
      networks: { "0/ip": "127.0.0.4", "0/ipv6/0": "::1", "1/ip": "127.0.0.6", "2/ip": "127.0.0.5" } };
  }
  if (method === "VIF.get_record" && /^OpaqueRef:rdp-vif-\d$/.test(ref)) {
    const d = ref.slice(-1);
    return { device: d, network: `OpaqueRef:rdp-net-${d}`, VM: RDP_VM };
  }
  if (method === "network.get_PIFs" && /^OpaqueRef:rdp-net-\d$/.test(ref)) {
    const d = ref.slice(-1);
    // net-2 has a PIF only on xs-02: none on the VM's host.
    return d === "2" ? ["OpaqueRef:rdp-pif-2-h2"] : [`OpaqueRef:rdp-pif-${d}`];
  }
  if (method === "PIF.get_record" && /^OpaqueRef:rdp-pif-/.test(ref)) {
    return { host: ref.endsWith("-h2") ? H2 : H1, metrics: `OpaqueRef:rdp-pm-${ref.slice(-1)}` };
  }
  if (method === "PIF_metrics.get_carrier" && /^OpaqueRef:rdp-pm-/.test(ref)) return ref.endsWith("-1") ? false : true;
  if (method === "VM.call_plugin" && ref === RDP_VM) {
    log(`rdp plugin ${p[2]} ${p[3]} ${JSON.stringify(p[4])}`);
    return "";
  }
  return undefined;
}

// pvs-model: PVS-Accelerator, as XenCenter's PVS tab reads and changes it.
//   Site A: complete (a PVS uuid, a server, cache storage on both hosts); web-01
//   caches through it on xs-01 (attached: that storage is in use). Site B: made
//   in XenServer, not yet completed in PVS (no PVS uuid, no storage). db-01 has
//   VIF 0 and no proxy; "old" has no VIF. xs-01's control domain may grow by
//   2 GiB (memory cache possible), xs-02's by 512 MiB (not).
//   pvs-unlicensed: restrict_pvs_proxy "true"; pvs-old: platform 3.2.0.
let inPvs = false;
function pvsState() {
  if (st.pvs) return st.pvs;
  const G = 1024 ** 3;
  st.pvs = {
    n: 0,
    sites: {
      "OpaqueRef:pvs-site-a": { uuid: "site-a", name_label: "Site A", name_description: "", PVS_uuid: "pvs-uuid-a" },
      "OpaqueRef:pvs-site-b": { uuid: "site-b", name_label: "Site B", name_description: "", PVS_uuid: "" },
    },
    servers: { "OpaqueRef:pvs-srv-1": { uuid: "srv-1", addresses: ["10.0.0.50", "10.0.0.51"], first_port: 6890, last_port: 6909, site: "OpaqueRef:pvs-site-a" } },
    proxies: { "OpaqueRef:pvs-proxy-1": { uuid: "proxy-1", site: "OpaqueRef:pvs-site-a", VIF: "OpaqueRef:pvs-vif-1", currently_attached: true, status: "caching" } },
    storages: {
      "OpaqueRef:pvs-cs-a1": { uuid: "cs-a1", host: H1, SR: "OpaqueRef:pvs-sr-mem1", site: "OpaqueRef:pvs-site-a", size: 10 * G, VDI: "OpaqueRef:NULL" },
      "OpaqueRef:pvs-cs-a2": { uuid: "cs-a2", host: H2, SR: "OpaqueRef:pvs-sr-local2", site: "OpaqueRef:pvs-site-a", size: 20 * G, VDI: "OpaqueRef:NULL" },
    },
    vifs: {
      "OpaqueRef:pvs-vif-1": { device: "0", VM: "OpaqueRef:vm-1" },
      "OpaqueRef:pvs-vif-2": { device: "0", VM: "OpaqueRef:vm-2" },
    },
    srs: {
      "OpaqueRef:pvs-sr-mem1": { name_label: "MemorySR", type: "tmpfs", content_type: "", physical_size: "0", physical_utilisation: "0", PBDs: ["OpaqueRef:pvs-pbd-m1"], other_config: {} },
      "OpaqueRef:pvs-sr-local1": { name_label: "Local storage on xs-01", type: "lvm", content_type: "user", physical_size: String(500 * G), physical_utilisation: String(100 * G), PBDs: ["OpaqueRef:pvs-pbd-l1"], other_config: {} },
      "OpaqueRef:pvs-sr-local2": { name_label: "Local storage on xs-02", type: "lvm", content_type: "user", physical_size: String(300 * G), physical_utilisation: String(250 * G), PBDs: ["OpaqueRef:pvs-pbd-l2"], other_config: {} },
      "OpaqueRef:pvs-sr-iso": { name_label: "ISO library", type: "iso", content_type: "iso", physical_size: "0", physical_utilisation: "0", PBDs: ["OpaqueRef:pvs-pbd-i1"], other_config: {} },
    },
    pbds: {
      "OpaqueRef:pvs-pbd-m1": { host: H1, SR: "OpaqueRef:pvs-sr-mem1", currently_attached: true },
      "OpaqueRef:pvs-pbd-l1": { host: H1, SR: "OpaqueRef:pvs-sr-local1", currently_attached: true },
      "OpaqueRef:pvs-pbd-l2": { host: H2, SR: "OpaqueRef:pvs-sr-local2", currently_attached: true },
      "OpaqueRef:pvs-pbd-i1": { host: H1, SR: "OpaqueRef:pvs-sr-iso", currently_attached: true },
    },
  };
  return st.pvs;
}
function pvsModel(method, p) {
  const s = pvsState();
  const G = 1024 ** 3;
  const ref = (kind) => `OpaqueRef:pvs-${kind}-new${++s.n}`;
  const name = (r) => s.sites[r]?.name_label ?? r;
  const hostName = (h) => st.hosts[h]?.name ?? h;
  const sites = () =>
    Object.fromEntries(Object.entries(s.sites).map(([r, x]) => [r, {
      ...x,
      cache_storage: Object.keys(s.storages).filter((c) => s.storages[c].site === r),
      servers: Object.keys(s.servers).filter((c) => s.servers[c].site === r),
      proxies: Object.keys(s.proxies).filter((c) => s.proxies[c].site === r),
    }]));
  switch (method) {
    case "PVS_site.get_all_records": return sites();
    case "PVS_server.get_all_records": return s.servers;
    case "PVS_proxy.get_all_records": return s.proxies;
    case "PVS_cache_storage.get_all_records": return s.storages;
    case "VIF.get_all_records": return s.vifs;
    case "SR.get_all_records": return s.srs;
    case "PBD.get_all_records": return s.pbds;
    case "SM.get_all_records": return {
      "OpaqueRef:sm-lvm": { type: "lvm", capabilities: ["VDI_CREATE", "VDI_DELETE"] },
      "OpaqueRef:sm-iso": { type: "iso", capabilities: [] },
      "OpaqueRef:sm-tmpfs": { type: "tmpfs", capabilities: [] },
    };
    case "pool_update.get_all_records": return {};
    case "VM.get_VIFs": return Object.keys(s.vifs).filter((v) => s.vifs[v].VM === p[1]);
    case "VM.get_all_records":
    case "host.get_all_records": {
      inPvs = true;
      let base;
      try { base = rpc(method, p); } finally { inPvs = false; }
      if (method === "host.get_all_records") {
        for (const h of Object.values(base)) {
          h.license_params = { ...(h.license_params ?? {}), restrict_pvs_proxy: flag("pvs-unlicensed") ? "true" : "false" };
          h.software_version = { ...(h.software_version ?? {}), platform_version: flag("pvs-old") ? "3.2.0" : "3.4.0" };
          h.updates = [];
        }
        return base;
      }
      for (const [r, v] of Object.entries(base)) {
        v.is_a_template = false;
        v.is_a_snapshot = false;
        v.other_config = v.other_config ?? {};
        v.VIFs = Object.keys(s.vifs).filter((x) => s.vifs[x].VM === r);
        if (v.is_control_domain) {
          v.memory_static_min = String(1 * G);
          v.memory_static_max = String(v.resident_on === H1 || flag("pvs-roomy") ? 3 * G : 1.5 * G);
        }
      }
      return base;
    }
    case "Async.PVS_proxy.create": {
      const [site, vif] = [p[1], p[2]];
      log(`pvs proxy.create ${name(site)} ${s.vifs[vif]?.VM}`);
      if (Object.values(s.proxies).some((x) => x.VIF === vif)) return task(1, () => fail("PVS_PROXY_ALREADY_PRESENT", vif));
      return task(1, () => { const r = ref("proxy"); s.proxies[r] = { uuid: r, site, VIF: vif, currently_attached: false, status: "initialised" }; return r; });
    }
    case "Async.PVS_proxy.destroy":
      log(`pvs proxy.destroy ${s.vifs[s.proxies[p[1]]?.VIF]?.VM}`);
      return task(1, () => { delete s.proxies[p[1]]; return ""; });
    case "Async.PVS_site.introduce":
      log(`pvs site.introduce ${p[1]} desc="${p[2]}" pvs_uuid="${p[3]}"`);
      return task(1, () => { const r = ref("site"); s.sites[r] = { uuid: r, name_label: p[1], name_description: p[2], PVS_uuid: p[3] }; return r; });
    case "PVS_site.set_name_label":
      log(`pvs site.set_name_label ${name(p[1])} -> ${p[2]}`);
      s.sites[p[1]].name_label = p[2];
      return "";
    case "Async.PVS_server.forget":
      log(`pvs server.forget ${p[1]}`);
      return task(1, () => { delete s.servers[p[1]]; return ""; });
    case "Async.PVS_site.forget": {
      log(`pvs site.forget ${name(p[1])}`);
      const site = p[1];
      if (Object.values(s.proxies).some((x) => x.site === site)) return task(1, () => fail("PVS_SITE_CONTAINS_RUNNING_PROXIES", site));
      if (Object.values(s.servers).some((x) => x.site === site)) return task(1, () => fail("PVS_SITE_CONTAINS_SERVERS", site));
      return task(1, () => { delete s.sites[site]; for (const c of Object.keys(s.storages)) if (s.storages[c].site === site) delete s.storages[c]; return ""; });
    }
    case "Async.PVS_cache_storage.destroy": {
      const c = s.storages[p[1]];
      log(`pvs cache_storage.destroy ${name(c?.site)} ${hostName(c?.host)}`);
      return task(1, () => { delete s.storages[p[1]]; return ""; });
    }
    case "Async.PVS_cache_storage.create": {
      const rec = p[1] || {};
      log(`pvs cache_storage.create ${name(rec.site)} ${hostName(rec.host)} ${s.srs[rec.SR]?.name_label ?? rec.SR} ${rec.size / G}GiB uuid="${rec.uuid}" VDI=${rec.VDI}`);
      if (Object.values(s.storages).some((x) => x.site === rec.site && x.host === rec.host)) return task(1, () => fail("PVS_CACHE_STORAGE_ALREADY_PRESENT", rec.site, rec.host));
      return task(1, () => { const r = ref("cs"); s.storages[r] = { uuid: r, host: rec.host, SR: rec.SR, site: rec.site, size: rec.size, VDI: "OpaqueRef:NULL" }; return r; });
    }
    case "Async.SR.create": {
      const [host, dc, size, label, desc, type, content, shared, sm] = p.slice(1);
      log(`pvs SR.create ${hostName(host)} ${JSON.stringify(dc)} ${size} ${label} "${desc}" ${type} "${content}" ${shared} ${JSON.stringify(sm)}`);
      return task(1, () => {
        const r = ref("sr"), b = ref("pbd");
        s.srs[r] = { name_label: label, type, content_type: content, physical_size: "0", physical_utilisation: "0", PBDs: [b], other_config: {} };
        s.pbds[b] = { host, SR: r, currently_attached: true };
        return r;
      });
    }
  }
  return undefined;
}

function memoryModel(method, p) {
  const GiB = GiB_, MiB = MiB_;
  const vm = memState();
  const running = (r) => st.vms[r].power === "Running" && st.hosts[st.vms[r].resident];
  switch (method) {
    case "VM.get_record": return st.vms[p[1]] ? memoryVmRecord(p[1]) : undefined;
    case "host.get_all_records": {
      const out = {};
      // dmc-unlicensed: the licence does not allow memory ranges.
      // h2-maintenance: xs-02 in maintenance mode (disabled, MAINTENANCE_MODE).
      if (flag("h2-maintenance")) st.hosts[H2].enabled = false;
      for (const [ref, x] of Object.entries(st.hosts)) out[ref] = {
        enabled: x.enabled, other_config: { ...(ref === H2 && flag("h2-maintenance") ? { MAINTENANCE_MODE: "true" } : {}), ...(st.hostOc?.[ref] ?? {}) }, name_label: x.name, metrics: `OpaqueRef:m${ref.slice(-1)}`, memory_overhead: String(512 * MiB),
        control_domain: `OpaqueRef:dom0-${ref.slice(-1)}`, resident_VMs: Object.keys(st.vms).filter((r) => st.vms[r].resident === ref && running(r)),
        license_params: { restrict_network_sriov: "false", restrict_dmc: flag("dmc-unlicensed") ? "true" : "false",
          ...(flag("vmss-model") ? { restrict_vmss: flag("vmss-restricted") ? "true" : "false", restrict_checkpoint: flag("checkpoint-restricted") ? "true" : "false" } : {}),
          ...(flag("vm-gpu-model") ? { restrict_gpu: "false", restrict_vgpu: flag("vgpu-unlicensed") ? "true" : "false" } : {}) },
        PBDs: ref === H2 ? ["OpaqueRef:pbd-mem-local2"] : [] };
      return out;
    }
    case "host_metrics.get_all_records":
      return Object.fromEntries(Object.keys(st.hosts).map((ref) => [`OpaqueRef:m${ref.slice(-1)}`, { memory_total: String(64 * GiB), memory_free: String(30 * GiB), live: live(ref) }]));
    case "VM.get_all_records":
      return Object.fromEntries(Object.keys(st.vms).map((r) => [r, memoryVmRecord(r)]));
    case "VBD.get_all_records": return { "OpaqueRef:vbd-mem-3": { VM: "OpaqueRef:vm-3", VDI: "OpaqueRef:vdi-mem-3", type: "Disk" } };
    case "VDI.get_all_records": return { "OpaqueRef:vdi-mem-3": { name_label: "old disk", SR: "OpaqueRef:sr-mem-local2", missing: false, managed: true } };
    case "SR.get_all_records":
      return { "OpaqueRef:sr-mem-local2": { name_label: "Local storage on xs-02", type: "lvm", shared: false, PBDs: ["OpaqueRef:pbd-mem-local2"],
        physical_size: String(500 * GiB), physical_utilisation: String(100 * GiB) } };
    case "PBD.get_all_records": return { "OpaqueRef:pbd-mem-local2": { host: H2, SR: "OpaqueRef:sr-mem-local2", currently_attached: true } };
    case "VM_metrics.get_all_records":
      return Object.fromEntries(Object.keys(st.vms).filter(running).map((r) => [`OpaqueRef:vmm-${r.slice(10)}`,
        { memory_actual: String(st.vms[r].dom0 ? 4 * GiB : vm[r]?.actual ?? vm[r]?.max ?? 4 * GiB), start_time: "20260101T00:00:00Z" }]));
    case "VM_guest_metrics.get_all_records":
      return Object.fromEntries(Object.keys(st.vms).filter((r) => !st.vms[r].dom0).map((r) => [`OpaqueRef:gm-${r.slice(10)}`, vm[r]?.balloon
        ? { other: { "feature-balloon": "1" }, PV_drivers_version: { major: "9", minor: "4" }, PV_drivers_up_to_date: true }
        : { other: { "feature-shutdown": "1" } }]));
  }
  return undefined;
}

// What XAPI checks when memory is set: the order, and for the static range a halted VM.
function setMemory(r, smin, smax, dmin, dmax) {
  const m = memState()[r];
  if (!(smin <= dmin && dmin <= dmax && dmax <= smax)) fail("MEMORY_CONSTRAINT_VIOLATION", "Memory limits must satisfy: static_min <= dynamic_min <= dynamic_max <= static_max");
  if ((smin !== m.smin || smax !== m.smax) && st.vms[r].power !== "Halted") fail("VM_BAD_POWER_STATE", r, "halted", st.vms[r].power.toLowerCase());
  Object.assign(m, { smin, smax, min: dmin, max: dmax, actual: Math.min(m.actual ?? dmax, dmax) });
}

// copy-model: storage for XenCenter's Copy VM, Convert to Template and
// Create Template From Snapshot. "old" (vm-3, halted) has a 40 GiB disk on
// the local LVM SR of xs-01 and a CD drive, and a snapshot "before update".
// The SRs cover each case of the copy SR list: the pool's default (NFS),
// full, without room enough (Small), smaller than the disk (Tiny), detached, an ISO library and an HBA SR (both not listed).
// copy-no-fastclone: the LVM SM cannot VDI_CLONE. copy-fails: a full copy ends in SR_FULL.
let inCopyModel = false;
function copyState() {
  if (st.cp) return st.cp;
  const G = GiB_;
  const sr = (name, type, size, used, extra = {}) => ({ name_label: name, type, physical_size: String(size), physical_utilisation: String(used), content_type: type === "iso" ? "iso" : "user", shared: false, other_config: {}, ...extra });
  st.cp = {
    n: 0,
    extra: {},      // VMs made by clone/copy
    desc: {},       // name_description per VM
    oc: {},         // other_config per VM
    template: {},   // VMs made templates
    srs: {
      "OpaqueRef:sr-local1": sr("Local storage", "lvm", 500 * G, 100 * G, { PBDs: ["OpaqueRef:pbd-local1"] }),
      "OpaqueRef:sr-nfs": sr("NFS-Storage", "nfs", 1024 * G, 200 * G, { shared: true, PBDs: ["OpaqueRef:pbd-nfs1", "OpaqueRef:pbd-nfs2"] }),
      "OpaqueRef:sr-full": sr("Full SR", "lvm", 100 * G, 99.8 * G, { PBDs: ["OpaqueRef:pbd-full"] }),
      "OpaqueRef:sr-small": sr("Small SR", "lvm", 50 * G, 20 * G, { PBDs: ["OpaqueRef:pbd-small"] }),
      "OpaqueRef:sr-tiny": sr("Tiny SR", "lvm", 30 * G, 0, { PBDs: ["OpaqueRef:pbd-tiny"] }),
      "OpaqueRef:sr-detached": sr("Detached SR", "nfs", 1024 * G, 0, { shared: true, PBDs: ["OpaqueRef:pbd-det"] }),
      "OpaqueRef:sr-iso": sr("ISO library", "iso", 10 * G, 5 * G, { PBDs: ["OpaqueRef:pbd-iso"] }),
      "OpaqueRef:sr-hba": sr("HBA LUNs", "rawhba", 2048 * G, 0, { PBDs: ["OpaqueRef:pbd-hba"] }),
    },
    pbds: {
      "OpaqueRef:pbd-local1": { host: H1, SR: "OpaqueRef:sr-local1", currently_attached: true },
      "OpaqueRef:pbd-nfs1": { host: H1, SR: "OpaqueRef:sr-nfs", currently_attached: true },
      "OpaqueRef:pbd-nfs2": { host: H2, SR: "OpaqueRef:sr-nfs", currently_attached: true },
      "OpaqueRef:pbd-full": { host: H1, SR: "OpaqueRef:sr-full", currently_attached: true },
      "OpaqueRef:pbd-small": { host: H1, SR: "OpaqueRef:sr-small", currently_attached: true },
      "OpaqueRef:pbd-tiny": { host: H1, SR: "OpaqueRef:sr-tiny", currently_attached: true },
      "OpaqueRef:pbd-det": { host: H1, SR: "OpaqueRef:sr-detached", currently_attached: false },
      "OpaqueRef:pbd-iso": { host: H1, SR: "OpaqueRef:sr-iso", currently_attached: true },
      "OpaqueRef:pbd-hba": { host: H1, SR: "OpaqueRef:sr-hba", currently_attached: true },
    },
    vdis: { "OpaqueRef:cvdi-3": { name_label: "old disk", SR: "OpaqueRef:sr-local1", virtual_size: String(40 * G), physical_utilisation: String(40 * G) } },
    vbds: {
      "OpaqueRef:cvbd-3": { VM: "OpaqueRef:vm-3", VDI: "OpaqueRef:cvdi-3", type: "Disk" },
      "OpaqueRef:cvbd-3cd": { VM: "OpaqueRef:vm-3", VDI: "OpaqueRef:NULL", type: "CD" },
    },
  };
  return st.cp;
}
const SNAP = "OpaqueRef:snap-3";
function copySms() {
  const lvm = ["VDI_CREATE", "VDI_DELETE", "VDI_SNAPSHOT", ...(flag("copy-no-fastclone") ? [] : ["VDI_CLONE"])];
  return {
    "OpaqueRef:sm-lvm": { type: "lvm", capabilities: lvm },
    "OpaqueRef:sm-nfs": { type: "nfs", capabilities: ["VDI_CREATE", "VDI_DELETE", "VDI_CLONE", "VDI_SNAPSHOT", "THIN_PROVISIONING"] },
    "OpaqueRef:sm-iso": { type: "iso", capabilities: ["VDI_INTRODUCE"] },
    "OpaqueRef:sm-hba": { type: "rawhba", capabilities: ["VDI_CREATE"] },
  };
}
/** A VM record as the copy dialog reads it, for base VMs, copies and the snapshot. */
function copyVmRecord(ref) {
  const c = copyState();
  const base = st.vms[ref], made = c.extra[ref];
  let rec;
  if (ref === SNAP) {
    rec = { name_label: "before update", power_state: "Halted", is_a_snapshot: true, is_a_template: true, snapshot_of: "OpaqueRef:vm-3", VBDs: [], allowed_operations: ["clone", "copy", "export"] };
  } else if (made) {
    rec = { ...made };
  } else if (base) {
    const halted = base.power === "Halted";
    rec = {
      name_label: base.name, power_state: base.power, resident_on: base.resident, is_control_domain: Boolean(base.dom0), is_a_snapshot: false, is_a_template: false,
      VBDs: Object.entries(c.vbds).filter(([, v]) => v.VM === ref).map(([r]) => r),
      allowed_operations: halted ? ["start", "start_on", "export", "copy", "clone", "make_into_template", "destroy"] : ["clean_shutdown", "hard_shutdown", "clean_reboot", "pool_migrate", "snapshot"],
    };
  } else return undefined;
  if (c.template[ref]) Object.assign(rec, { is_a_template: true, allowed_operations: ["clone", "copy", "export", "destroy"] });
  rec.current_operations = {};
  rec.name_description = c.desc[ref] ?? rec.name_description ?? (ref === "OpaqueRef:vm-3" ? "An old VM" : "");
  rec.other_config = { ...(rec.other_config || {}), ...(c.oc[ref] || {}) };
  return rec;
}
/** A task that finishes once -- in success or failure -- however often it is polled after. */
function onceTask(polls, fn) {
  let done = false, result, error;
  return task(polls, () => {
    if (!done) { done = true; try { result = fn(); } catch (e) { error = e; } }
    if (error !== undefined) throw error;
    return result;
  });
}
function copyModel(method, p) {
  const c = copyState();
  const ref = p[1];
  const name = (r) => copyVmRecord(r)?.name_label ?? r;
  const madeFrom = (src, newName, srRef) => {
    const from = copyVmRecord(src);
    const r = `OpaqueRef:copy-${++c.n}`;
    // A clone of a template (a snapshot is one) is a template; of a VM, a halted VM.
    c.extra[r] = { name_label: newName, power_state: "Halted", is_a_snapshot: false, is_a_template: from.is_a_template === true, VBDs: [], allowed_operations: ["start", "export", "copy", "clone", "make_into_template"], name_description: from.name_description, other_config: {} };
    if (srRef) c.extra[r].copied_to = srRef;
    st.vms[r] = { name: newName, resident: "OpaqueRef:NULL", power: "Halted", copy: true, template: from.is_a_template === true };
    return r;
  };
  switch (method) {
    case "VM.get_record": return copyVmRecord(ref);
    case "VM.get_all_records": {
      let base = {};
      inCopyModel = true;
      try { base = rpc(method, p) || {}; } catch { base = {}; } finally { inCopyModel = false; }
      const out = {};
      for (const r of new Set([...Object.keys(base), ...Object.keys(c.extra), SNAP])) out[r] = { ...(base[r] || {}), ...copyVmRecord(r) };
      return out;
    }
    case "VBD.get_all_records": return c.vbds;
    case "VDI.get_all_records": return c.vdis;
    case "SR.get_all_records": return c.srs;
    case "PBD.get_all_records": return c.pbds;
    case "SM.get_all_records": return copySms();
    case "pool.get_all_records": {
      let base = {};
      inCopyModel = true;
      try { base = rpc(method, p) || {}; } catch { base = {}; } finally { inCopyModel = false; }
      for (const r of Object.keys(base)) base[r] = { ...base[r], default_SR: "OpaqueRef:sr-nfs" };
      return base;
    }
    case "Async.VM.clone": {
      const from = copyVmRecord(ref);
      if (!from) fail("HANDLE_INVALID", "VM", ref);
      if (from.power_state !== "Halted") fail("VM_BAD_POWER_STATE", ref, "halted", from.power_state.toLowerCase());
      log(`clone ${name(ref)} as ${p[2]}`);
      return onceTask(1, () => madeFrom(ref, p[2]));
    }
    case "Async.VM.copy": {
      const from = copyVmRecord(ref);
      if (!from) fail("HANDLE_INVALID", "VM", ref);
      if (from.power_state !== "Halted") fail("VM_BAD_POWER_STATE", ref, "halted", from.power_state.toLowerCase());
      log(`copy ${name(ref)} as ${p[2]} to ${c.srs[p[3]]?.name_label ?? p[3]}`);
      return onceTask(2, () => {
        if (flag("copy-fails")) fail("SR_FULL", String(40 * GiB_), String(1 * GiB_));
        return madeFrom(ref, p[2], p[3]);
      });
    }
    case "VM.set_name_description": c.desc[ref] = p[2]; log(`description ${name(ref)} = ${p[2]}`); return "";
    case "VM.add_to_other_config": {
      const oc = (c.oc[ref] ??= {});
      if (p[2] in oc) fail("MAP_DUPLICATE_KEY", "VM", "other_config", ref, p[2]);
      oc[p[2]] = p[3];
      log(`other_config ${name(ref)} ${p[2]}=${p[3]}`);
      return "";
    }
    case "VM.remove_from_other_config": if (c.oc[ref]) delete c.oc[ref][p[2]]; return "";
    case "VM.set_is_a_template": {
      if (copyVmRecord(ref)?.power_state !== "Halted") fail("VM_BAD_POWER_STATE", ref, "halted", "running");
      c.template[ref] = p[2] === true;
      if (st.vms[ref]) st.vms[ref].template = true;
      log(`set_is_a_template ${name(ref)} ${p[2]}`);
      return "";
    }
  }
  return undefined;
}

// import-model (with copy-model for the SRs): XenCenter's XVA import. task.create
// gives a task that stays pending until a PUT /import for it has arrived; the
// VM it makes is "old" (a name taken: the import must make it unique) with two
// interfaces, each on a network the import brought along (other_config
// import_task, no PIFs) -- as XAPI does for networks it does not know.
// import-fails: the task fails (IMPORT_ERROR). import-refused: the PUT gets 500.
function importState() {
  if (!st.imp) {
    st.imp = { n: 0, tasks: {} };
    // import-h1-localhost: xs-01 answers as "localhost", so an upload to it shows apart from one to the coordinator.
    if (flag("import-h1-localhost")) st.hosts[H1].address = "localhost";
  }
  return st.imp;
}
function importModel(method, p) {
  const s = importState();
  const ref = p[1];
  switch (method) {
    case "task.create": {
      const id = "OpaqueRef:task-" + (++st.n);
      s.tasks[id] = { label: p[1], host: p[2] };
      // Pending until the PUT is done (see importPut).
      st.tasks[id] = { polls: 1e9, done: () => fail("INTERNAL_ERROR", "no upload") };
      log(`task.create ${p[1]} ${p[2]}`);
      return id;
    }
    // Which hosts are live: for the home server page.
    case "host_metrics.get_all_records":
      return Object.fromEntries(Object.keys(st.hosts).map((h) => [`OpaqueRef:m${h.slice(-1)}`, { memory_total: String(64 * GiB_), memory_free: String(30 * GiB_), live: live(h) }]));
    case "VIF.get_record": { const v = st.net.vifs[ref]; return v ? { ...v } : undefined; }
    case "VIF.get_network": return st.net.vifs[ref] ? st.net.vifs[ref].network : undefined;
    case "VIF.move": {
      const v = st.net.vifs[ref];
      if (!v) return undefined;
      const from = st.net.networks[v.network], to = st.net.networks[p[2]];
      if (!to) fail("HANDLE_INVALID", "network", p[2]);
      if (from) from.VIFs = from.VIFs.filter((x) => x !== ref);
      to.VIFs.push(ref);
      v.network = p[2];
      log(`VIF.move ${v.device} to ${to.name_label}`);
      return "";
    }
    case "network.get_record": return st.net.networks[ref] ? { ...st.net.networks[ref] } : undefined;
    case "network.destroy": {
      const n = st.net.networks[ref];
      if (!n || !(n.other_config || {}).import_task) return undefined;
      if (n.VIFs.length) fail("NETWORK_CONTAINS_VIF", ref);
      log(`network.destroy ${n.name_label}`);
      delete st.net.networks[ref];
      return "";
    }
    case "VM.set_name_label": {
      if (!st.vms[ref]) return undefined;
      log(`VM.set_name_label ${st.vms[ref].name} ${p[2]}`);
      st.vms[ref].name = p[2];
      if (st.cp?.extra[ref]) st.cp.extra[ref].name_label = p[2];
      return "";
    }
    case "VM.set_affinity": {
      if (!st.vms[ref]) return undefined;
      log(`VM.set_affinity ${st.vms[ref].name} ${st.hosts[p[2]]?.name ?? p[2]}`);
      if (st.cp?.extra[ref]) st.cp.extra[ref].affinity = p[2];
      return "";
    }
  }
  return undefined;
}
/** PUT /import: the body counted, then the task finishes as XAPI's would. */
function importPut(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  const s = importState();
  const task = q.get("task_id"), sr = q.get("sr_id");
  let bytes = 0;
  req.on("data", (d) => (bytes += d.length));
  req.on("end", () => {
    const on = String(req.headers.host || "");
    log(`PUT /import on ${on} task=${s.tasks[task] ? "known" : "unknown"} sr=${st.cp?.srs[sr]?.name_label ?? sr} bytes=${bytes} length=${req.headers["content-length"]}`);
    if (!String(q.get("session_id") || "").startsWith("OpaqueRef:session-") || !s.tasks[task]) { res.writeHead(401); return res.end(); }
    if (flag("import-refused")) { res.writeHead(500); return res.end("Internal error"); }
    st.tasks[task] = {
      polls: 1,
      done: (() => {
        let made;
        return () => {
          if (flag("import-fails")) fail("IMPORT_ERROR", "Some disks could not be imported");
          if (made) return made;
          const vm = `OpaqueRef:imp-${++s.n}`;
          const vifs = [];
          for (const dev of ["0", "1"]) {
            const net = `OpaqueRef:net-imp-${s.n}-${dev}`;
            const vif = `OpaqueRef:vif-imp-${s.n}-${dev}`;
            st.net.networks[net] = { uuid: `uuid-${net}`, name_label: `imported eth${dev}`, name_description: "", bridge: `xapi-imp${dev}`, MTU: "1500", PIFs: [], VIFs: [vif], other_config: { import_task: task }, tags: [] };
            st.net.vifs[vif] = { VM: vm, device: dev, MAC: `aa:bb:cc:00:0${s.n}:0${dev}`, network: net, currently_attached: false, other_config: {} };
            vifs.push(vif);
          }
          st.vms[vm] = { name: "old", resident: "OpaqueRef:NULL", power: "Halted" };
          copyState().extra[vm] = { name_label: "old", power_state: "Halted", is_a_snapshot: false, is_a_template: false, VBDs: [], VIFs: vifs, allowed_operations: ["start", "export", "copy", "clone", "make_into_template"], name_description: "", other_config: {}, imported_to: sr };
          made = vm;
          return vm;
        };
      })(),
    };
    res.writeHead(200);
    res.end();
  });
}

// vm-gpu-model (with vgpu-model): XenCenter's VM → GPU page. The groups get
// the fields a real GPU_group has (PGPUs, supported/enabled types); the types
// which they may share a VM with (1B: with itself, 16Q and 8Q: alone; 8Q is
// in Tech Preview); VMs are HVM. vGPUs made with VGPU.create stay with their
// VM. vgpu-unlicensed: restrict_vgpu; vm-no-vgpu-template: "old" comes from a
// template that forbids vGPUs; vm-ha-restart: HA would restart "old".
let inVmGpuModel = false;
function vmGpuState() {
  return (st.vg ??= { n: 0, vgpus: {} });
}
function vmGpuBase(method, p) {
  inVmGpuModel = true;
  try { return rpc(method, p); } catch { return undefined; } finally { inVmGpuModel = false; }
}
const VG_TEMPLATE = "OpaqueRef:tmpl-win";
function vmGpuModel(method, p) {
  const s = vmGpuState();
  const ref = p[1];
  const vgpusOf = (vm) => Object.entries({ ...gpuModel().vgpus, ...s.vgpus }).filter(([, v]) => v.VM === vm).map(([r]) => r);
  switch (method) {
    case "VM.get_record": {
      const base = vmGpuBase(method, p);
      if (!base) return undefined;
      return {
        ...base, HVM_boot_policy: "BIOS order", VGPUs: vgpusOf(ref),
        reference_label: ref === "OpaqueRef:vm-3" && flag("vm-no-vgpu-template") ? "win-novgpu" : "",
        ha_restart_priority: ref === "OpaqueRef:vm-3" && flag("vm-ha-restart") ? "restart" : "",
        is_a_template: false, is_a_snapshot: false,
      };
    }
    case "VM.get_all_records": {
      const base = vmGpuBase(method, p) || {};
      if (flag("vm-no-vgpu-template")) {
        base[VG_TEMPLATE] = { name_label: "Windows (no vGPU)", is_a_template: true, reference_label: "win-novgpu",
          recommendations: '<restrictions><restriction field="allow-vgpu" value="0"/><restriction field="memory-static-max" max="137438953472"/></restrictions>' };
      }
      return base;
    }
    case "VGPU.get_all_records": return { ...gpuModel().vgpus, ...s.vgpus };
    case "GPU_group.get_all_records": {
      const m = gpuModel();
      const out = {};
      for (const [g, rec] of Object.entries(m.groups)) {
        const pgpus = Object.keys(m.pgpus).filter((x) => m.pgpus[x].GPU_group === g);
        const enabled = [...new Set(pgpus.flatMap((x) => m.pgpus[x].enabled_VGPU_types))];
        out[g] = { ...rec, PGPUs: pgpus, supported_VGPU_types: Object.keys(m.types), enabled_VGPU_types: enabled };
      }
      return out;
    }
    case "VGPU_type.get_all_records": {
      const m = gpuModel();
      const compat = { "OpaqueRef:vt-1b": ["OpaqueRef:vt-1b"], "OpaqueRef:vt-16q": [], "OpaqueRef:vt-8q": [], "OpaqueRef:vt-pt": [] };
      return Object.fromEntries(Object.entries(m.types).map(([t, rec]) => [t, { ...rec, compatible_types_in_vm: compat[t] ?? [], experimental: t === "OpaqueRef:vt-8q" }]));
    }
    case "VGPU.destroy": {
      if (!s.vgpus[ref]) return undefined;
      log(`VGPU.destroy ${st.vms[s.vgpus[ref].VM]?.name} ${gpuModel().types[s.vgpus[ref].type]?.model_name}`);
      delete s.vgpus[ref];
      return "";
    }
    case "Async.VGPU.create": {
      const [vm, group, device, , type] = p.slice(1);
      if (!st.vms[vm]) fail("HANDLE_INVALID", "VM", vm);
      if (st.vms[vm].power !== "Halted") fail("VM_BAD_POWER_STATE", vm, "halted", st.vms[vm].power.toLowerCase());
      log(`VGPU.create ${st.vms[vm].name} ${group} device=${device} ${type ? gpuModel().types[type]?.model_name : "(no type)"}`);
      return task(1, () => {
        const r = `OpaqueRef:vg-new-${++s.n}`;
        s.vgpus[r] = { VM: vm, GPU_group: group, type: type || "OpaqueRef:vt-pt", device, resident_on: "OpaqueRef:NULL", currently_attached: false };
        return r;
      });
    }
  }
  return undefined;
}

// sr-model: storage for XenCenter's SR menu. On the two hosts:
//   NFS-Storage   nfs, shared, attached, a disk web-01 (running) uses; the pool's default
//   iSCSI-A       lvmoiscsi, shared, its PBD on xs-02 unplugged: broken
//   iSCSI-B       lvmoiscsi, shared, no PBD for xs-02 at all: broken
//   Old NFS       nfs, shared, both PBDs unplugged: detached (XAPI allows forget)
//   Local storage lvm on xs-01, may be trimmed
//   Spare NFS     nfs, shared, attached, empty (XAPI allows destroy)
// XAPI's allowed_operations: forget only while detached, destroy only while attached.
// trim-fails: the trim plugin answers with an error.
function srState() {
  if (st.sr) return st.sr;
  const G = GiB_;
  const sr = (name, type, shared, extra = {}) => ({
    uuid: `uuid-${name.replace(/\W/g, "").toLowerCase()}`, name_label: name, name_description: "", type, shared, content_type: "user",
    physical_size: String(500 * G), physical_utilisation: String(100 * G), virtual_allocation: String(100 * G),
    other_config: {}, sm_config: {}, VDIs: [], PBDs: [], current_operations: {}, ...extra,
  });
  const s = {
    n: 0,
    srs: {
      "OpaqueRef:sr-nfs": sr("NFS-Storage", "nfs", true, { VDIs: ["OpaqueRef:vdi-web"] }),
      "OpaqueRef:sr-isa": sr("iSCSI-A", "lvmoiscsi", true),
      "OpaqueRef:sr-isb": sr("iSCSI-B", "lvmoiscsi", true),
      "OpaqueRef:sr-old": sr("Old NFS", "nfs", true),
      "OpaqueRef:sr-local": sr("Local storage", "lvm", false),
      "OpaqueRef:sr-spare": sr("Spare NFS", "nfs", true),
    },
    pbds: {},
    vdis: { "OpaqueRef:vdi-web": { name_label: "web-01 disk", SR: "OpaqueRef:sr-nfs", type: "user", VBDs: ["OpaqueRef:vbd-web"], virtual_size: String(40 * G), physical_utilisation: String(40 * G) } },
    vbds: { "OpaqueRef:vbd-web": { VM: "OpaqueRef:vm-1", VDI: "OpaqueRef:vdi-web", type: "Disk" } },
  };
  const pbd = (srRef, host, attached) => {
    const r = `OpaqueRef:pbd-${srRef.slice(13)}-${host.slice(-1)}`;
    s.pbds[r] = { host, SR: srRef, currently_attached: attached, device_config: { server: "192.0.2.10", serverpath: `/export/${srRef.slice(13)}`, target: "192.0.2.20" }, other_config: {} };
    s.srs[srRef].PBDs.push(r);
  };
  pbd("OpaqueRef:sr-nfs", H1, true); pbd("OpaqueRef:sr-nfs", H2, true);
  pbd("OpaqueRef:sr-isa", H1, true); pbd("OpaqueRef:sr-isa", H2, false);
  if (flag("iscsi-model")) {
    for (const x of s.srs["OpaqueRef:sr-isa"].PBDs) s.pbds[x].device_config = { target: "192.0.2.30", targetIQN: "iqn.2026-11.com.cybernetics:isan.tgt2", SCSIid: "36001405aaaa" };
    s.srs["OpaqueRef:sr-isa"].uuid = "uuid-iscsia";
    s.srs["OpaqueRef:sr-isgone"] = sr("iSCSI-Gone", "lvmoiscsi", true, { uuid: "uuid-iscsigone" });
  }
  pbd("OpaqueRef:sr-isb", H1, true);
  pbd("OpaqueRef:sr-old", H1, false); pbd("OpaqueRef:sr-old", H2, false);
  pbd("OpaqueRef:sr-local", H1, true);
  pbd("OpaqueRef:sr-spare", H1, true); pbd("OpaqueRef:sr-spare", H2, true);
  st.sr = s;
  st.srDefault ??= "OpaqueRef:sr-nfs";
  return s;
}
function srAllowed(s, ref) {
  const sr = s.srs[ref];
  const attached = sr.PBDs.some((p) => s.pbds[p]?.currently_attached);
  const ops = ["scan", "plug", "unplug", "vdi_create"];
  if (!attached) ops.push("forget");
  else ops.push("destroy");
  return ops;
}
// The stand-in iSCSI target behind the sr-model (iscsi-model flag), as lvmoiscsi
// answers XenCenter's interrogation: SR.create without targetIQN fails with
// SR_BACKEND_FAILURE_96 and the IQNs as XML, without SCSIid with _107 and the LUNs.
//   Portals: 192.0.2.30 (tgt2 on port 3261, and "*"), 192.0.2.31 (tgt10), fd00::30 (tgt2).
//   LUNs: 0 aaaa 2 TiB (iSCSI-A uses it), 1 beef 100 GiB (empty), 2 cccc 512 GiB (an SR
//   of another pool on it: uuid-foreign), 3 dddd (iSCSI-Gone, known here without PBDs).
//   bad.example: DNS fails (140); 192.0.2.99: no connection (141). iscsi-chap: CHAP
//   user xen / password s3cret (or its secret) needed, else 68. iscsi-create-succeeds:
//   the interrogation makes an SR after all.
const ISCSI_IQNS = '<?xml version="1.0" ?><iscsi-target-iqns>' +
  "<TGT><Index>0</Index><IPAddress>192.0.2.31</IPAddress><TargetIQN>iqn.2026-11.com.cybernetics:isan.tgt10</TargetIQN></TGT>" +
  "<TGT><Index>1</Index><IPAddress>192.0.2.30</IPAddress><Port>3261</Port><TargetIQN>iqn.2026-11.com.cybernetics:isan.tgt2</TargetIQN></TGT>" +
  "<TGT><Index>2</Index><IPAddress>fd00::30</IPAddress><TargetIQN>iqn.2026-11.com.cybernetics:isan.tgt2</TargetIQN></TGT>" +
  "<TGT><Index>3</Index><IPAddress>192.0.2.30</IPAddress><TargetIQN>*</TargetIQN></TGT>" +
  "<TGT><Index>4</Index><IPAddress>192.0.2.30</IPAddress><TargetIQN></TargetIQN></TGT></iscsi-target-iqns>";
const ISCSI_LUN = (id, serial, gib, scsi) => `<LUN><vendor>CYBERNET</vendor><serial>${serial}</serial><LUNid>${id}</LUNid><size>${gib * GiB_}</size><SCSIid>${scsi}</SCSIid></LUN>`;
const ISCSI_LUNS = '<?xml version="1.0" ?><iscsi-target>' + ISCSI_LUN(1, "beef", 100, "36001405bbbb") + ISCSI_LUN(0, "aaaa", 2048, "36001405aaaa") +
  ISCSI_LUN(2, "cccc", 512, "36001405cccc") + ISCSI_LUN(3, "dddd", 64, "36001405dddd") + "</iscsi-target>";
function iscsiCheck(s, dc) {
  if (dc.target === "bad.example") fail("SR_BACKEND_FAILURE_140", "", "Incorrect DNS name, unable to resolve.", "");
  if (dc.target === "192.0.2.99") fail("SR_BACKEND_FAILURE_141", "", "Unable to connect to ISCSI service on target", "");
  if (flag("iscsi-chap")) {
    const pw = dc.chappassword ?? Object.values(s.secrets).find((x) => x.uuid === dc.chappassword_secret)?.value;
    if (dc.chapuser !== "xen" || pw !== "s3cret") fail("SR_BACKEND_FAILURE_68", "", "ISCSI login failed, verify CHAP credentials", "");
  }
}
function iscsiModel(s, method, p) {
  const shown = (dc) => JSON.stringify(dc);
  switch (method) {
    case "SR.create": {
      const [, host, dc, size, nameLabel, desc, type, ct, shared] = p;
      if (type !== "lvmoiscsi") return undefined;
      log(`iscsi SR.create on ${st.hosts[host]?.name} name=${nameLabel} desc=${desc} size=${size} content=${ct} shared=${shared} dconf=${shown(dc)}`);
      iscsiCheck(s, dc);
      if (!flag("iscsi-create-succeeds")) {
        // iscsi-many: a target with 40 IQNs, as a big iSAN shows them.
        const many = () => '<?xml version="1.0" ?><iscsi-target-iqns>' + Array.from({ length: 40 }, (_, i) => `<TGT><Index>${i}</Index><IPAddress>192.0.2.30</IPAddress><TargetIQN>iqn.2026-11.com.cybernetics:isan.vol${i}</TargetIQN></TGT>`).join("") + "</iscsi-target-iqns>";
        if (!dc.targetIQN) fail("SR_BACKEND_FAILURE_96", "", "The request is missing or has an incorrect target IQN parameter", flag("iscsi-many") ? many() : ISCSI_IQNS);
        if (!dc.SCSIid && !dc.LUNSerial) fail("SR_BACKEND_FAILURE_107", "", "The SCSIid parameter is missing or incorrect", ISCSI_LUNS);
      }
      const r = `OpaqueRef:sr-iscsi-${++s.n}`;
      s.srs[r] = { uuid: `uuid-iscsi-${s.n}`, name_label: nameLabel, name_description: desc, type, shared, content_type: ct, physical_size: "0", physical_utilisation: "0", virtual_allocation: "0", other_config: {}, sm_config: {}, VDIs: [], PBDs: [], current_operations: {} };
      for (const h of Object.keys(st.hosts)) {
        const pr = `OpaqueRef:pbd-iscsi-${s.n}-${h.slice(-1)}`;
        s.pbds[pr] = { host: h, SR: r, currently_attached: !(flag("iscsi-plug-fails") && h === H2), device_config: { ...dc }, other_config: {} };
        s.srs[r].PBDs.push(pr);
      }
      return r;
    }
    case "SR.probe": {
      const [, host, dc, type] = p;
      log(`iscsi SR.probe on ${st.hosts[host]?.name} type=${type} dconf=${shown(dc)}`);
      iscsiCheck(s, dc);
      if (dc.SCSIid === "36001405cccc") return '<?xml version="1.0" ?><SRlist><SR><UUID>uuid-foreign</UUID><Devlist>/dev/sdc</Devlist><size>549755813888</size></SR></SRlist>';
      if (dc.SCSIid === "36001405dddd") return '<?xml version="1.0" ?><SRlist><SR><UUID>uuid-iscsigone</UUID><size>68719476736</size></SR></SRlist>';
      if (dc.SCSIid === "36001405aaaa") return '<?xml version="1.0" ?><SRlist><SR><UUID>uuid-iscsia</UUID><size>536870912000</size></SR></SRlist>';
      return '<?xml version="1.0" ?><SRlist></SRlist>';
    }
    case "SR.introduce": {
      const [, uuid, nameLabel, desc, type, ct, shared] = p;
      log(`iscsi SR.introduce ${uuid} name=${nameLabel} type=${type} content=${ct} shared=${shared}`);
      const r = `OpaqueRef:sr-iscsi-${++s.n}`;
      s.srs[r] = { uuid, name_label: nameLabel, name_description: desc, type, shared, content_type: ct, physical_size: "0", physical_utilisation: "0", virtual_allocation: "0", other_config: {}, sm_config: {}, VDIs: [], PBDs: [], current_operations: {} };
      return r;
    }
    case "PBD.create": {
      const rec = p[1];
      log(`iscsi PBD.create ${s.srs[rec.SR]?.name_label} on ${st.hosts[rec.host]?.name} dconf=${shown(rec.device_config)}`);
      const r = `OpaqueRef:pbd-new-${++s.n}`;
      s.pbds[r] = { host: rec.host, SR: rec.SR, currently_attached: false, device_config: rec.device_config, other_config: rec.other_config || {} };
      s.srs[rec.SR].PBDs.push(r);
      return r;
    }
    case "PBD.plug": {
      const x = s.pbds[p[1]];
      log(`iscsi PBD.plug ${s.srs[x.SR]?.name_label} on ${st.hosts[x.host]?.name}`);
      if (flag("iscsi-plug-fails")) fail("SR_BACKEND_FAILURE_47", "", "The SR is not available", "");
      x.currently_attached = true;
      return "";
    }
    case "PBD.unplug": { const x = s.pbds[p[1]]; log(`iscsi PBD.unplug ${s.srs[x.SR]?.name_label} on ${st.hosts[x.host]?.name}`); x.currently_attached = false; return ""; }
    case "PBD.get_currently_attached": return Boolean(s.pbds[p[1]]?.currently_attached);
    case "SR.get_PBDs": return [...(s.srs[p[1]]?.PBDs ?? [])];
    case "SR.forget": {
      log(`iscsi SR.forget ${s.srs[p[1]]?.name_label}`);
      for (const x of s.srs[p[1]]?.PBDs ?? []) delete s.pbds[x];
      delete s.srs[p[1]];
      return "";
    }
    case "SR.set_other_config": log(`iscsi SR.set_other_config ${s.srs[p[1]]?.name_label} ${shown(p[2])}`); s.srs[p[1]].other_config = p[2]; return "";
    case "SR.set_name_label": log(`iscsi SR.set_name_label ${s.srs[p[1]]?.name_label} -> ${p[2]}`); s.srs[p[1]].name_label = p[2]; return "";
    case "SR.set_name_description": log(`iscsi SR.set_name_description ${p[2]}`); s.srs[p[1]].name_description = p[2]; return "";
    case "Secret.create": {
      const r = `OpaqueRef:secret-${++s.n}`;
      s.secrets[r] = { uuid: `secret-uuid-${s.n}`, value: p[1].value };
      log(`iscsi Secret.create fields=${Object.keys(p[1]).sort().join(",")}`);
      return r;
    }
    case "Secret.get_uuid": return s.secrets[p[1]].uuid;
    case "Secret.get_by_uuid": return Object.entries(s.secrets).find(([, x]) => x.uuid === p[1])?.[0] ?? fail("UUID_INVALID", "secret", p[1]);
    case "Secret.destroy": log(`iscsi Secret.destroy ${s.secrets[p[1]]?.uuid}`); delete s.secrets[p[1]]; return "";
  }
  return undefined;
}
function srModel(method, p) {
  const s = srState();
  s.secrets ??= {};
  const ref = p[1];
  const name = (r) => s.srs[r]?.name_label ?? r;
  if (flag("iscsi-model")) {
    const r = iscsiModel(s, method, p);
    if (r !== undefined) return r;
  }
  switch (method) {
    case "SR.get_all_records":
      return Object.fromEntries(Object.entries(s.srs).map(([r, x]) => [r, { ...x, allowed_operations: srAllowed(s, r) }]));
    case "SR.get_record": return s.srs[ref] ? { ...s.srs[ref], allowed_operations: srAllowed(s, ref) } : undefined;
    case "PBD.get_all_records": return s.pbds;
    case "VDI.get_all_records": return s.vdis;
    case "VBD.get_all_records": return s.vbds;
    case "SM.get_all_records":
      return {
        "OpaqueRef:sm-nfs": { type: "nfs", capabilities: ["VDI_CREATE", "VDI_DELETE", "VDI_CLONE"], features: {} },
        "OpaqueRef:sm-iscsi": { type: "lvmoiscsi", capabilities: ["VDI_CREATE", "VDI_DELETE"], features: {} },
        "OpaqueRef:sm-lvm": { type: "lvm", capabilities: ["VDI_CREATE", "VDI_DELETE"], features: { SR_TRIM: "2" } },
      };
    case "pool.get_all_records": {
      let base = {};
      inSrModel = true;
      try { base = rpc(method, p) || {}; } catch { base = {}; } finally { inSrModel = false; }
      for (const r of Object.keys(base)) base[r] = { ...base[r], default_SR: st.srDefault, crash_dump_SR: st.srCrash ?? "OpaqueRef:NULL", suspend_image_SR: st.srSuspend ?? "OpaqueRef:NULL" };
      return base;
    }
    case "Async.PBD.unplug": {
      const x = s.pbds[ref]; if (!x) fail("HANDLE_INVALID", "PBD", ref);
      log(`PBD.unplug ${name(x.SR)} on ${st.hosts[x.host].name}`);
      return task(1, () => { x.currently_attached = false; return ""; });
    }
    case "Async.PBD.plug": {
      const x = s.pbds[ref]; if (!x) fail("HANDLE_INVALID", "PBD", ref);
      log(`PBD.plug ${name(x.SR)} on ${st.hosts[x.host].name}`);
      return task(1, () => { x.currently_attached = true; return ""; });
    }
    case "Async.PBD.create": {
      const rec = p[1];
      log(`PBD.create ${name(rec.SR)} on ${st.hosts[rec.host]?.name} device_config=${JSON.stringify(rec.device_config)}`);
      return task(1, () => {
        const r = `OpaqueRef:pbd-new-${++s.n}`;
        s.pbds[r] = { host: rec.host, SR: rec.SR, currently_attached: false, device_config: rec.device_config, other_config: rec.other_config || {} };
        s.srs[rec.SR].PBDs.push(r);
        return r;
      });
    }
    case "Async.SR.forget": {
      if (!srAllowed(s, ref).includes("forget")) fail("SR_HAS_PBD", ref);
      log(`SR.forget ${name(ref)}`);
      return task(1, () => { for (const x of s.srs[ref].PBDs) delete s.pbds[x]; delete s.srs[ref]; return ""; });
    }
    case "Async.SR.destroy": {
      if (!srAllowed(s, ref).includes("destroy")) fail("SR_NOT_ATTACHED", ref);
      log(`SR.destroy ${name(ref)}`);
      return task(1, () => { for (const x of s.srs[ref].PBDs) delete s.pbds[x]; delete s.srs[ref]; return ""; });
    }
    case "pool.set_default_SR": log(`pool.set_default_SR ${name(p[2])}`); st.srDefault = p[2]; return "";
    case "pool.set_crash_dump_SR": log(`pool.set_crash_dump_SR ${name(p[2])}`); st.srCrash = p[2]; return "";
    case "pool.set_suspend_image_SR": log(`pool.set_suspend_image_SR ${name(p[2])}`); st.srSuspend = p[2]; return "";
    case "host.call_plugin": {
      if (p[2] !== "trim") return undefined;
      const sr = Object.values(s.srs).find((x) => x.uuid === p[4]?.sr_uuid);
      log(`trim ${p[3]} on ${st.hosts[ref]?.name} ${sr?.name_label ?? p[4]?.sr_uuid}`);
      if (flag("trim-fails")) return "<trim_response><key_value_pair><key>errcode</key><value>UnsupportedSRForTrim</value></key_value_pair><key_value_pair><key>errmsg</key><value>Trim on [" + p[4]?.sr_uuid + "] not supported</value></key_value_pair></trim_response>";
      return "True";
    }
  }
  return undefined;
}
let inSrModel = false;

// maint-model: entering maintenance mode as XenCenter's EvacuateHostAction.
// host.disable/enable as tasks, MAINTENANCE_MODE kept per host, and WLB's
// evacuation recommendations -- wlb-recs: each running VM to the other host;
// wlb-recs-error: one entry is WLB's reason why a VM cannot go;
// wlb-recs-offline: the recommended host is not up; wlb-recs-nomem: WLB has no
// host for one VM. With evac-no-plan, the
// evacuation fails as seen in the field; vm1-too-big: no host takes web-01.
let inMaintModel = false;
function maintBase(method, p) {
  inMaintModel = true;
  try { return rpc(method, p); } finally { inMaintModel = false; }
}
function maintModel(method, p) {
  const h = p[1];
  const hname = (r) => st.hosts[r]?.name ?? r;
  const vname = (r) => st.vms[r]?.name ?? r;
  st.hostOc ??= {};
  // No update guidance pending: a host taken out of maintenance mode is enabled again.
  if (!st.maintInit) { for (const x of Object.values(st.hosts)) x.pending = []; st.maintInit = true; }
  switch (method) {
    case "Async.host.disable": log(`host.disable ${hname(h)}`); return task(1, () => maintBase("host.disable", p));
    case "Async.host.enable": log(`host.enable ${hname(h)}`); return task(1, () => maintBase("host.enable", p));
    case "host.add_to_other_config": {
      const oc = (st.hostOc[h] ??= {});
      if (p[2] in oc) fail("MAP_DUPLICATE_KEY", "host", "other_config", h, p[2]);
      oc[p[2]] = p[3];
      log(`${p[2]}=${p[3]} on ${hname(h)}`);
      return "";
    }
    case "host.remove_from_other_config":
      if (st.hostOc[h]?.[p[2]] !== undefined) log(`${p[2]} removed on ${hname(h)}`);
      if (st.hostOc[h]) delete st.hostOc[h][p[2]];
      return "";
    case "host_metrics.get_all_records":
      return Object.fromEntries(Object.keys(st.hosts).map((r) => [`OpaqueRef:m${r.slice(-1)}`, { live: live(r), memory_total: String(64 * GiB_), memory_free: String(30 * GiB_) }]));
    case "VM.get_is_control_domain": return Boolean(st.vms[h]?.dom0);
    case "host.retrieve_wlb_evacuate_recommendations": {
      if (!flag("wlb-recs") && !flag("wlb-recs-error") && !flag("wlb-recs-offline") && !flag("wlb-recs-nomem")) { log(`wlb recommendations for ${hname(h)}: none`); return {}; }
      const other = Object.keys(st.hosts).find((r) => r !== h);
      const out = {};
      for (const [vm] of residentRunning(h)) out[vm] = ["WLB", HOST_UUID[other], "0.62", "12345"];
      const first = Object.keys(out)[0];
      if (first && flag("wlb-recs-error")) out[first] = ["VM_REQUIRES_SR", "OpaqueRef:sr-local"];
      // wlb-recs-nomem: as xapi fills in a VM WLB left out of its plan.
      if (first && flag("wlb-recs-nomem")) out[first] = ["HOST_NOT_ENOUGH_FREE_MEMORY", first];
      if (first && flag("wlb-recs-offline")) out[first] = ["WLB", "99999999-9999-4999-8999-999999999999", "0.5", "1"];
      log(`wlb recommendations for ${hname(h)}: ${Object.keys(out).map(vname).join(",") || "none"}`);
      return out;
    }
    case "Async.host.evacuate": log(`host.evacuate ${hname(h)}`); return undefined;
    case "Async.VM.pool_migrate": log(`VM.pool_migrate ${vname(h)} to ${hname(p[2])} live=${p[3]?.live}`); return undefined;
  }
  return undefined;
}

// coord-model: a new pool coordinator (Pool.designate_new_master), as
// XenCenter's EvacuateHostAction calls it. The pool names st.master; a change
// makes the sessions opened so far invalid (session-floor), as the old
// coordinator hands over. psr-pending: a pool secret rotation pending;
// ha-enabling: HA being switched on (designate_new_master not allowed);
// designate-fails: the task fails; designate-drops: the old coordinator stops
// answering at once, before its task reports back. The hosts' licences do not
// restrict pool secret rotation, so the pool's word counts (EnableComboBox).
let inCoordModel = false;
function coordBase(method, p) {
  inCoordModel = true;
  try { return rpc(method, p); } finally { inCoordModel = false; }
}
function coordModel(method, p) {
  st.master ??= H1;
  const hname = (r) => st.hosts[r]?.name ?? r;
  const dropSessions = () => fs.writeFileSync(path.join(DIR, "session-floor"), String(st.n));
  switch (method) {
    case "pool.get_master": return st.master;
    case "pool.get_all_records": {
      const base = coordBase(method, p);
      const busy = flag("ha-enabling");
      for (const r of Object.values(base)) Object.assign(r, {
        master: st.master,
        is_psr_pending: flag("psr-pending"),
        allowed_operations: busy ? ["ha_disable"] : ["ha_enable", "designate_new_master", "cluster_create"],
        current_operations: busy ? { "OpaqueRef:task-ha": "ha_enable" } : {},
      });
      return base;
    }
    case "host.get_all_records": {
      const base = coordBase(method, p);
      for (const x of Object.values(base)) x.license_params = { ...(x.license_params ?? {}), restrict_pool_secret_rotation: "false" };
      return base;
    }
    case "Async.pool.designate_new_master": {
      const to = p[1];
      log(`pool.designate_new_master ${hname(to)}`);
      if (flag("designate-drops")) {
        st.master = to;
        // The task is made first, so the session that asked is gone as well.
        const t = task(5, () => "");
        dropSessions();
        return t;
      }
      return task(1, () => {
        if (flag("designate-fails")) fail("INTERNAL_ERROR", "designate refused");
        st.master = to;
        dropSessions();
        return "";
      });
    }
  }
  return undefined;
}

function rpc(method, p) {
  currentMethod = method;
  const m = mode();
  if (method === "session.login_with_password") {
    if (p[0] !== USER || p[1] !== PASS) fail("SESSION_AUTHENTICATION_FAILED", p[0], "bad");
    // member-login: this one is a pool member, as XAPI says: ask the coordinator.
    if (flag("member-login")) fail("HOST_IS_SLAVE", process.env.FAKE_COORDINATOR || "127.0.0.1");
    const s = "OpaqueRef:session-" + (++st.n);
    if (flag("log-logins")) log(`login ${s}`);
    return s;
  }
  if (method === "session.logout") {
    // log-logouts: which sessions XenMan ends at the pool (session-handle-test.sh).
    if (flag("log-logouts")) log(`logout ${p[0]}`);
    return "";
  }
  if (!String(p[0] || "").startsWith("OpaqueRef:session-")) fail("SESSION_INVALID", p[0]);
  // session-floor N: sessions up to N are gone, as after a toolstack restart.
  let floor = 0;
  try { floor = Number(fs.readFileSync(path.join(DIR, "session-floor"), "utf8").trim()) || 0; } catch {}
  if (floor && Number(String(p[0]).slice("OpaqueRef:session-".length)) <= floor) fail("SESSION_INVALID", p[0]);
  const h = p[1];
  if (flag("coord-model") && !inCoordModel) {
    const r = coordModel(method, p);
    if (r !== undefined) return r;
  }
  if (flag("maint-model") && !inMaintModel) {
    const r = maintModel(method, p);
    if (r !== undefined) return r;
  }
  // Before membership, which answers the pool's SR settings itself.
  if (flag("sr-model") && !inSrModel) {
    const r = srModel(method, p);
    if (r !== undefined) return r;
  }
  {
    const r = membership(method, p);
    if (r !== undefined) return r;
  }
  if (flag("pvs-model") && !inPvs) {
    const r = pvsModel(method, p);
    if (r !== undefined) return r;
  }
  if (flag("rdp-model")) {
    const r = rdpModel(method, p);
    if (r !== undefined) return r;
  }
  if (flag("vm-gpu-model") && !inVmGpuModel) {
    const r = vmGpuModel(method, p);
    if (r !== undefined) return r;
  }
  if (flag("import-model")) {
    const r = importModel(method, p);
    if (r !== undefined) return r;
  }
  if (flag("copy-model") && !inCopyModel) {
    const r = copyModel(method, p);
    if (r !== undefined) return r;
  }
  // memory-model: the usual records, with the memory fields added.
  if (flag("memory-model") && !inMemoryModel) {
    if (method === "VM.set_memory_limits") {
      log(`set_memory_limits ${st.vms[p[1]].name} ${p.slice(2).join(" ")}`);
      if (flag("memory-fails")) fail("INTERNAL_ERROR", "memory-fails");
      setMemory(p[1], ...p.slice(2).map(Number));
      return "";
    }
    if (method === "VM.set_memory_dynamic_range") {
      const m = memState()[p[1]];
      log(`set_memory_dynamic_range ${st.vms[p[1]].name} ${p.slice(2).join(" ")}`);
      setMemory(p[1], m.smin, m.smax, Number(p[2]), Number(p[3]));
      return "";
    }
    if (/^Async\.VM\.(clean_shutdown|hard_shutdown|start_on|start)$/.test(method)) log(`${method.slice(9)} ${st.vms[p[1]].name}`);
    // The control domain's memory (XenCenter: VM.set_memory, then the host reboots).
    if (method === "VM.set_memory") {
      const m = (memState()[p[1]] ??= { smin: 2 * GiB_, min: 4 * GiB_, max: 4 * GiB_, smax: 8 * GiB_, actual: 4 * GiB_ });
      const v = Number(p[2]);
      log(`set_memory ${st.vms[p[1]].name} ${v}`);
      if (v < m.smin) fail("MEMORY_CONSTRAINT_VIOLATION", "Memory limits must satisfy: static_min <= dynamic_min <= dynamic_max <= static_max");
      Object.assign(m, { min: v, max: v, smax: Math.max(m.smax, v) });
      return "";
    }
    if (method === "Async.host.reboot") {
      log(`reboot ${st.hosts[p[1]].name}`);
      return task(1, () => rpc("host.reboot", p));
    }
    if (method === "VM.hard_shutdown") { Object.assign(st.vms[p[1]], { power: "Halted", resident: "OpaqueRef:NULL" }); return ""; }
    const extra = memoryModel(method, p);
    if (extra !== undefined) {
      let base = {};
      inMemoryModel = true;
      try { base = rpc(method, p) || {}; } catch { base = {}; } finally { inMemoryModel = false; }
      if (method.endsWith(".get_record")) return { ...base, ...extra };
      for (const [r, rec] of Object.entries(extra)) base[r] = { ...(base[r] || {}), ...rec };
      return base;
    }
  }
  switch (method) {
    case "pool.get_all": return [POOL];
    case "pool.get_master": return H1;
    case "pool.get_all_records": {
      const u = updConf(m);
      return { [POOL]: { name_label: "Production", master: H1, ha_enabled: flag("ha"), repositories: m === "norepo" ? [] : [...u.enabled],
        default_SR: flag("local-default-sr") ? "OpaqueRef:sr-local" : "OpaqueRef:NULL", tls_verification_enabled: false,
        cpu_info: { vendor: "GenuineIntel", features_hvm: "ffffffff-ffffffff" },
        last_update_sync: st.lastSync,
        // no-sync-schedule: a XenServer before XAPI 23.18, without these fields.
        ...(flag("no-sync-schedule") ? {} : { update_sync_enabled: u.syncEnabled, update_sync_frequency: u.frequency, update_sync_day: u.day }),
        repository_proxy_url: u.proxyUrl, repository_proxy_username: u.proxyUser, repository_proxy_password: u.proxySecret,
        wlb_url: st.wlb.url, wlb_username: st.wlb.username, wlb_enabled: st.wlb.enabled, wlb_verify_cert: st.wlb.verifyCert } };
    }
    // Configure Updates, with XenServer's checks where XenMan relies on them.
    case "Repository.introduce": {
      const u = updConf(m);
      if (Object.values(u.repos).some((r) => r.name_label === p[1])) fail("MAP_DUPLICATE_KEY", "Repository", "name_label", "", p[1]);
      const ref = `OpaqueRef:repo-${++st.n}`;
      u.repos[ref] = { name_label: p[1], name_description: p[2], binary_url: p[3], source_url: p[4], update: Boolean(p[5]), gpgkey_path: p[6] };
      return ref;
    }
    case "pool.add_repository": {
      const u = updConf(m);
      if (!u.repos[p[2]]) fail("HANDLE_INVALID", "repository", p[2]);
      if (!u.enabled.includes(p[2])) u.enabled.push(p[2]);
      return "";
    }
    case "pool.remove_repository": {
      const u = updConf(m);
      u.enabled = u.enabled.filter((r) => r !== p[2]);
      return "";
    }
    case "pool.configure_update_sync": {
      const u = updConf(m);
      if (!["daily", "weekly"].includes(p[2]) || !/^[0-6]$/.test(String(p[3]))) fail("INVALID_UPDATE_SYNC_DAY", String(p[3]));
      u.frequency = p[2]; u.day = String(p[3]);
      return "";
    }
    case "pool.set_update_sync_enabled": updConf(m).syncEnabled = Boolean(p[2]); return "";
    case "pool.configure_repository_proxy": {
      const u = updConf(m);
      // As xapi_pool.ml: http(s) only; a username and a password, or neither.
      if (!/^https?:\/\//.test(p[2])) fail("INVALID_REPOSITORY_PROXY_URL", p[2]);
      if (Boolean(p[3]) !== Boolean(p[4])) fail("INVALID_REPOSITORY_PROXY_CREDENTIAL");
      u.proxyUrl = p[2]; u.proxyUser = p[3];
      u.proxySecret = p[4] ? `OpaqueRef:proxy-secret-${++st.n}` : "OpaqueRef:NULL";
      if (p[4]) u.secrets[u.proxySecret] = p[4];
      return "";
    }
    case "pool.disable_repository_proxy": {
      const u = updConf(m);
      Object.assign(u, { proxyUrl: "", proxyUser: "", proxySecret: "OpaqueRef:NULL" });
      return "";
    }
    case "Secret.get_record": {
      const v = updConf(m).secrets[p[1]];
      if (v === undefined) fail("HANDLE_INVALID", "secret", p[1]);
      return { uuid: "proxy-secret", value: v, other_config: {} };
    }
    case "pool.get_wlb_url": return st.wlb.url;
    case "pool.get_wlb_enabled": return st.wlb.enabled;
    case "pool.set_wlb_enabled":
      if (flag("wlb-pause-fails")) fail("INTERNAL_ERROR", "no");
      st.wlb.enabled = Boolean(p[2]); st.wlb.enabledLog.push(st.wlb.enabled); return "";
    case "pool.set_wlb_verify_cert": st.wlb.verifyCert = Boolean(p[2]); return "";
    case "pool.initialize_wlb":
      if (p[1] === "nowhere.example.org:8012") fail("WLB_CONNECTION_REFUSED", p[1]);
      if (p[3] !== "wlbpass") fail("WLB_AUTHENTICATION_FAILED");
      Object.assign(st.wlb, { url: p[1], username: p[2], enabled: true, xsUser: p[4], xsPassLength: String(p[5]).length });
      return "";
    case "pool.deconfigure_wlb": Object.assign(st.wlb, { url: "", username: "", enabled: false }); return "";
    case "pool.retrieve_wlb_configuration": wlbReachable(); return st.wlb.config;
    case "pool.send_wlb_configuration": {
      // As the real one: host_ keys belong to the hosts only with
      // set_host_configuration=true (XenCenter's way); without it they are
      // kept a second time, and every retrieve fails from then on.
      wlbReachable(); st.wlb.sent.push(p[1]);
      const { set_host_configuration: hostFlag, ...rest } = p[1];
      for (const k of Object.keys(rest)) if (/^host_/i.test(k) && hostFlag !== "true") st.wlb.broken = k;
      Object.assign(st.wlb.config, rest);
      return "";
    }
    case "pool.retrieve_wlb_recommendations":
      wlbReachable();
      if (!st.wlb.enabled) fail("WLB_DISABLED");
      if (flag("wlb-rec") && st.vms["OpaqueRef:vm-1"].resident !== H2) return { "OpaqueRef:vm-1": ["WLB", H2, "7", "71", "CpuUsage"] };
      return {};
    case "host.get_all_records": {
      const out = {};
      for (const [ref, x] of Object.entries(st.hosts)) out[ref] = { name_label: x.name, address: x.address, enabled: x.enabled,
        uuid: HOST_UUID[ref], power_on_mode: ref === H2 ? "IPMI" : "",
        metrics: `OpaqueRef:m${ref.slice(-1)}`,
        // joiner-old-version / joiner-free / joiner-fewer-cpu: the standalone server differs so.
        software_version: { product_brand: "XenServer", product_version: "8.4.0", network_backend: "openvswitch", db_schema: "5.785",
          platform_version: STANDALONE && flag("joiner-old-version") ? "3.3.0" : "3.4.0" },
        API_version_major: "2", API_version_minor: "21",
        edition: STANDALONE && flag("joiner-free") ? "free" : flag("license-model") ? (ref === H2 && flag("lic-partial") ? "free" : (st.licEdition ?? "cloud")) : "premium-per-socket",
        license_server: flag("license-model") ? (st.licServer?.[ref] ?? { address: "license.example.com" }) : {},
        cpu_info: { vendor: "GenuineIntel", features_hvm: STANDALONE && flag("joiner-fewer-cpu") ? "0fffffff-ffffffff" : "ffffffff-ffffffff" },
        external_auth_type: "", external_auth_service_name: "",
        resident_VMs: Object.keys(st.vms).filter((r) => st.vms[r].resident === ref && st.vms[r].power === "Running"),
        // sriov-unlicensed: the licence does not allow SR-IOV networks.
        license_params: { restrict_network_sriov: flag("sriov-unlicensed") ? "true" : "false",
          ...(flag("vmss-model") ? { restrict_vmss: flag("vmss-restricted") ? "true" : "false", restrict_checkpoint: flag("checkpoint-restricted") ? "true" : "false" } : {}),
          ...(flag("vm-gpu-model") ? { restrict_gpu: "false", restrict_vgpu: flag("vgpu-unlicensed") ? "true" : "false" } : {}), ...(STANDALONE ? { restrict_pooling: "false", restrict_management_on_vlan: "false" } : {}),
          ...(flag("license-model") ? {
            sockets: "2", grace: flag("lic-expiring") ? "regular grace" : "no", license_type: "CXS_ENT2_CCS", active_subscription: "true",
            sku_marketing_name: "XenServer Premium Edition (cloud-based)",
            expiry: flag("lic-expiring") ? "20261115T00:00:00Z" : "20280209T00:00:00Z",
            css_expiry: flag("lic-css-expired") ? "2026.0101" : "2028.0125",
          } : {}) },
        pending_guidances: x.pending, pending_guidances_recommended: x.pendingRecommended ?? [], pending_guidances_full: x.pendingFull ?? [],
        latest_synced_updates_applied: x.updates.length ? "no" : "yes",
        last_software_update: ref === H1 ? "20260901T10:00:00Z" : "19700101T00:00:00Z",
        // evac-hang: XenServer keeps the host marked as being evacuated.
        current_operations: x.evacTask ? { [x.evacTask]: "evacuate" } : {} };
      return out;
    }
    case "Repository.get_all_records": return updConf(m).repos;
    case "host.get_metrics": return `OpaqueRef:m${h.slice(-1)}`;
    case "host.get_pending_guidances": return st.hosts[h].pending;
    case "host.get_pending_guidances_recommended": return st.hosts[h].pendingRecommended ?? [];
    case "host.get_pending_guidances_full": return st.hosts[h].pendingFull ?? [];
    // One NVIDIA GPU per host; its migration data is gone after a toolstack
    // start that came before the GPU monitor (gpumon-late-once: the first such
    // start; gpumon-broken: every one).
    case "PGPU.get_all_records": {
      if (flag("vgpu-model")) return gpuModel().pgpus;
      const out = {};
      for (const [ref, x] of Object.entries(st.hosts)) out["OpaqueRef:pgpu-" + x.name] = { host: ref, compatibility_metadata: x.gpuData === false ? {} : { nvidia: "bWV0YQ==" } };
      return out;
    }
    case "PCI.get_all_records": return flag("vgpu-model") ? gpuModel().pcis : {};
    case "VGPU_type.get_all_records": return flag("vgpu-model") ? gpuModel().types : {};
    case "GPU_group.get_all_records": return flag("vgpu-model") ? gpuModel().groups : {};
    case "host_metrics.get_live": return live(`OpaqueRef:host-${h.slice(-1)}`);
    case "host.disable": if (!live(h)) fail("HOST_OFFLINE", h); st.hosts[h].enabled = false; return "";
    case "host.enable":
      if (!live(h)) fail("HOST_OFFLINE", h);
      if (Date.now() < (st.hosts[h].bootingUntil || 0)) fail("HOST_STILL_BOOTING");
      if (st.hosts[h].pending.length) fail("HOST_PENDING_MANDATORY_GUIDANCE_NOT_EMPTY", h);
      st.hosts[h].enabled = true; return "";
    case "host.get_resident_VMs": return Object.entries(st.vms).filter(([, v]) => v.resident === h).map(([r]) => r);
    case "host.get_vms_which_prevent_evacuation": {
      if (flag("stuck-vm")) return { "OpaqueRef:vm-1": ["VM_REQUIRES_SR", "OpaqueRef:sr-local"] };
      // no-tools: web-01 has no VM Tools -- no PV drivers, so no live migration.
      const vm1 = st.vms["OpaqueRef:vm-1"];
      if (flag("no-tools") && vm1.resident === h && vm1.power === "Running") return { "OpaqueRef:vm-1": ["VM_LACKS_FEATURE", "OpaqueRef:vm-1"] };
      // busy-vm: web-01 is starting (as a VDI desktop does), while the file is there.
      if (flag("busy-vm") && st.vms["OpaqueRef:vm-1"].resident === h) return { "OpaqueRef:vm-1": ["OTHER_OPERATION_IN_PROGRESS", "VM", "OpaqueRef:vm-1", "start"] };
      const running = residentRunning(h);
      // Like XAPI: with no other host enabled, nothing can go anywhere.
      const target = Object.keys(st.hosts).some((x) => x !== h && live(x) && st.hosts[x].enabled);
      if (!target) return Object.fromEntries(running.map(([r]) => [r, ["NO_HOSTS_AVAILABLE"]]));
      if (flag("gpu-stuck") && h === H2) return Object.fromEntries(running.map(([r]) => [r, ["VGPU_TYPE_NOT_SUPPORTED", "OpaqueRef:vgpu"]]));
      return {};
    }
    case "VM.get_record": { const v = st.vms[h]; return { name_label: v.name, power_state: v.power, is_control_domain: Boolean(v.dom0), resident_on: v.resident, memory_dynamic_max: v.dom0 ? "0" : "4294967296", guest_metrics: v.power === "Running" && !v.dom0 ? `OpaqueRef:gm-${h}` : "OpaqueRef:NULL" }; }
    // What the VM tools report: its addresses, and ("data-ts") whether Remote
    // Desktop is on -- off with the flag rdp-off.
    case "VM_guest_metrics.get_record": {
      const n = Number(String(h).replace(/\D/g, "")) || 0;
      return { os_version: { name: "Windows 11 Enterprise|C:\\Windows" }, networks: { "0/ip": `10.0.0.${100 + n}`, "0/ipv6/0": "fe80::1" }, other: { "data-ts": flag("rdp-off") ? "0" : "1" },
        // vm-tools: the XenServer VM Tools as a Windows guest reports them (agent, then each driver).
        ...(flag("vm-tools") ? { PV_drivers_detected: true, PV_drivers_version: { major: "9", minor: "4", micro: "2", build: "17", xennet: "XenServer 9.4.2.17", xeniface: "XenServer 9.4.2.17", xenvif: "XenServer 9.4.2.17", xenvbd: "XenServer 9.4.1.152", xenbus: "XenServer 9.4.1.152" } } : {}) };
    }
    case "VM.get_power_state": return st.vms[h].power;
    case "VM.get_all_records":
      return Object.fromEntries(Object.entries(st.vms).map(([r, v]) => [r, { name_label: v.name, power_state: v.power, resident_on: v.resident, is_control_domain: Boolean(v.dom0),
        is_a_template: Boolean(v.template), is_a_snapshot: false, snapshot_schedule: vmssModel().vmOf[r] ?? "OpaqueRef:NULL" }]));
    // has-vgpu: web-01 runs with a vGPU.
    case "VGPU.get_all_records":
      if (flag("vgpu-model")) return gpuModel().vgpus;
      return flag("has-vgpu") ? { "OpaqueRef:vgpu-1": { VM: "OpaqueRef:vm-1", PCI: "OpaqueRef:NULL" } } : {};
    case "VM.get_VGPUs": return flag("has-vgpu") && h === "OpaqueRef:vm-1" ? ["OpaqueRef:vgpu-1"] : [];
    case "VM.get_resident_on": return st.vms[h].resident;
    case "host.get_enabled": return st.hosts[h].enabled;
    case "host.get_name_label": return st.hosts[h].name;
    case "VM.get_name_label": return st.vms[h].name;
    case "Async.host.evacuate": {
      if (st.hosts[h].enabled) fail("HOST_NOT_DISABLED");
      if ((flag("pool-stuck") || (flag("pool-stuck-members") && h !== H1)) && !st.unstuck) {
        log(`pool blocked: evacuation of ${st.hosts[h].name}`);
        return task(1, () => fail("OTHER_OPERATION_IN_PROGRESS", "Pool", POOL, "OpaqueRef:task-stale"));
      }
      // evacuate-fails holds how many attempts still fail; evacuate-slow-once makes the next one hang.
      const failsFile = path.join(DIR, "evacuate-fails");
      if (fs.existsSync(failsFile)) {
        const n = Number(fs.readFileSync(failsFile, "utf8")) || 0;
        if (n > 0) { fs.writeFileSync(failsFile, String(n - 1)); return task(1, () => fail("VM_MIGRATE_FAILED", "OpaqueRef:vm-1", "migration timed out")); }
      }
      if (flag("evacuate-slow-once")) { fs.rmSync(path.join(DIR, "evacuate-slow-once")); return task(100000, () => {}); }
      const other = Object.keys(st.hosts).find((x) => x !== h && live(x) && st.hosts[x].enabled);
      if (!other) fail("HOST_NOT_ENOUGH_FREE_MEMORY");
      const vm1 = st.vms["OpaqueRef:vm-1"];
      if (flag("no-tools") && vm1.resident === h && vm1.power === "Running") return task(1, () => fail("VM_LACKS_FEATURE", "OpaqueRef:vm-1"));
      // evac-no-plan: XenServer's evacuation finds no plan, naming web-01, as seen in the field.
      if (flag("evac-no-plan") && vm1.resident === h && vm1.power === "Running") {
        log("evacuation without a plan");
        return task(1, () => fail("HOST_NOT_ENOUGH_FREE_MEMORY", "OpaqueRef:vm-1"));
      }
      // evac-vgpu-fails: web-01's vGPU live migration fails, as seen in the field.
      if (flag("evac-vgpu-fails") && vm1.resident === h && vm1.power === "Running") {
        log("vgpu migration of web-01 failed");
        return task(1, () => fail("INTERNAL_ERROR", 'xenopsd internal error: Domain.Emu_manager_failure("Received error from emu-manager: vgpu erroneous")'));
      }
      // evac-hang / evac-hang-cancels: the first evacuation empties the host and
      // then never ends, as seen in the field (97 % for an hour). With
      // evac-hang a cancel is ignored and the host stays marked as being
      // evacuated until the coordinator's toolstack restarts.
      if ((flag("evac-hang") || flag("evac-hang-cancels")) && !st.evacHung) {
        st.evacHung = true;
        for (const [, v] of residentRunning(h)) v.resident = other;
        const id = task(1e9, () => {});
        st.tasks[id].hang = flag("evac-hang");
        st.hosts[h].evacTask = id;
        log(`evacuation of ${st.hosts[h].name} hangs`);
        return id;
      }
      // evacuate-slow: takes a few seconds, long enough to be stopped.
      return task(flag("evacuate-slow") ? 2 : 1, () => { for (const [, v] of residentRunning(h)) v.resident = other; });
    }
    case "Async.host.apply_updates": {
      const x = st.hosts[h];
      if (p[2] !== "abc123hash") fail("UPDATEINFO_HASH_MISMATCH");
      if (x.pending.length) fail("HOST_PENDING_MANDATORY_GUIDANCES_NOT_EMPTY", h);
      // XenServer's own idea of what is needed, whatever the metadata said.
      const guidance = x.updates.length && !flag("no-guidance") && !flag("hidden-reboot") && !flag("full-reboot") ? x.guidance : [];
      const full = fullGuidance(h);
      if ((guidance.includes("RebootHost") || guidance.includes("EvacuateHost")) && residentRunning(h).length) fail("HOST_EVACUATION_IS_REQUIRED", h);
      if (flag("apply-fails")) return task(1, () => fail("APPLY_UPDATES_FAILED", h));
      // h2-apply-fails: xs-02's install fails that many more times (-1: always).
      const h2fails = path.join(DIR, "h2-apply-fails");
      if (h === H2 && fs.existsSync(h2fails)) {
        const n = Number(fs.readFileSync(h2fails, "utf8")) || 0;
        if (n !== 0) {
          if (n > 0) fs.writeFileSync(h2fails, String(n - 1));
          return task(1, () => fail("APPLY_UPDATES_FAILED", h, "yum transaction failed"));
        }
      }
      return task(2, () => {
        x.updates = [];
        x.pending = (flag("hidden-reboot") ? ["RebootHost"] : flag("no-guidance") ? ["RestartToolstack"] : guidance)
          .map((g) => ({ RebootHost: "reboot_host", RestartToolstack: "restart_toolstack", RestartDeviceModel: "restart_device_model" })[g]).filter(Boolean);
        // As XAPI: each kind of task into its own list; a failed live patch
        // (livepatch-fail) is a recommended host restart.
        x.pendingFull = [...new Set([...(x.pendingFull ?? []), ...full.map((g) => ({ RebootHost: "reboot_host", RestartToolstack: "restart_toolstack" })[g]).filter(Boolean)])];
        if (flag("livepatch-fail")) x.pendingRecommended = [...new Set([...(x.pendingRecommended ?? []), "reboot_host_on_livepatch_failure"])];
        return "[]";
      });
    }
    case "host.restart_agent":
      if (h === H1) st.unstuck = true;
      // The coordinator's toolstack restart clears what XenServer held on to.
      if (h === H1) for (const x of Object.values(st.hosts)) if (x.evacTask) { log(`evacuation mark of ${x.name} cleared`); delete st.tasks[x.evacTask]; delete x.evacTask; }
      st.hosts[h].pending = st.hosts[h].pending.filter((g) => g !== "restart_toolstack");
      // As seen in the field: the toolstack answers before it is ready, and a
      // member counts as offline until it has reported back to the coordinator.
      st.hosts[h].bootingUntil = Date.now() + 2500;
      if (flag("gpumon-broken")) st.hosts[h].gpuData = false;
      else if (flag("gpumon-late-once") && !st.gpumonLateUsed) { st.hosts[h].gpuData = false; st.gpumonLateUsed = true; }
      else st.hosts[h].gpuData = true;
      if (h !== H1) st.hosts[h].downUntil = Date.now() + 3000;
      if (h === H1) st.apiDownUntil = Date.now() + 1500;
      return "";
    case "host.reboot": {
      const x = st.hosts[h];
      if (x.enabled) fail("HOST_NOT_DISABLED");
      if (residentRunning(h).length) fail("HOST_IN_USE", h);
      x.reboots++;
      x.pending = [];
      x.pendingRecommended = [];
      x.pendingFull = [];
      x.downUntil = Date.now() + DOWN_MS;
      x.enabled = true; // xapi enables a host again when it starts
      if (h === H1) st.apiDownUntil = x.downUntil;
      return "";
    }
    case "Async.VM.pool_migrate": {
      const target = p[2];
      if (flag("pci-vm") && h === "OpaqueRef:vm-2") return task(1, () => fail("VM_HAS_PCI_ATTACHED", h));
      if (flag("vgpu-fails") && h === "OpaqueRef:vm-2") return task(1, () => fail("INTERNAL_ERROR", 'xenopsd internal error: Domain.Emu_manager_failure("Received error from emu-manager: vgpu erroneous")'));
      if (!st.hosts[target].enabled || !live(target)) fail("HOST_DISABLED", target);
      if (flag("no-tools") && h === "OpaqueRef:vm-1") return task(1, () => fail("VM_LACKS_FEATURE", h));
      // A host still marked as being evacuated takes no VM (evac-hang).
      if (st.hosts[target].evacTask) {
        log(`migrate refused ${st.vms[h].name}: ${st.hosts[target].name} marked as being evacuated`);
        return task(1, () => fail("OTHER_OPERATION_IN_PROGRESS", "host", target, "evacuate", st.hosts[target].evacTask));
      }
      // migrate-slow: each migration takes a few polls, long enough to overlap.
      log(`migrate start ${st.vms[h].name}`);
      return task(flag("migrate-slow") ? 4 : 1, () => { st.vms[h].resident = target; log(`migrate done ${st.vms[h].name}`); });
    }
    // Started where XenServer places it: an enabled host that is up.
    case "Async.VM.start": {
      if (st.vms[h].power !== "Halted") fail("VM_BAD_POWER_STATE", h, "halted", st.vms[h].power.toLowerCase());
      const target = Object.keys(st.hosts).find((x) => live(x) && st.hosts[x].enabled);
      if (!target) fail("NO_HOSTS_AVAILABLE");
      log(`started ${st.vms[h].name} on ${st.hosts[target].name}`);
      return task(1, () => { st.vms[h].power = "Running"; st.vms[h].resident = target; });
    }
    case "Async.VM.clean_shutdown":
      if (st.vms[h].power !== "Running") fail("VM_BAD_POWER_STATE", h, "running", st.vms[h].power.toLowerCase());
      if (flag("shutdown-hangs")) return task(100000, () => {});
      return task(1, () => { st.vms[h].power = "Halted"; st.vms[h].resident = "OpaqueRef:NULL"; });
    case "Async.VM.hard_shutdown":
      return task(1, () => { st.vms[h].power = "Halted"; st.vms[h].resident = "OpaqueRef:NULL"; });
    case "Async.VM.start_on": {
      const target = p[2];
      if (st.vms[h].power !== "Halted") fail("VM_BAD_POWER_STATE", h, "halted", st.vms[h].power.toLowerCase());
      if (!st.hosts[target].enabled || !live(target)) fail("HOST_DISABLED", target);
      if (flag("start-fails")) return task(1, () => fail("VGPU_GUEST_DRIVER_LIMIT", h));
      return task(1, () => { st.vms[h].power = "Running"; st.vms[h].resident = target; });
    }
    case "network.get_all_records": return st.net.networks;
    case "PIF.get_all_records": return st.net.pifs;
    case "PIF_metrics.get_all_records": return st.net.metrics;
    case "Bond.get_all_records": return st.net.bonds;
    case "VLAN.get_all_records": return st.net.vlans;
    case "network_sriov.get_all_records": return st.net.sriovs;
    // SR-IOV as XAPI enables it: a logical PIF on the new network for the NIC. sriov-fails-h2: not on xs-02.
    case "Async.network_sriov.create": {
      const [pifRef, netRef] = p.slice(1);
      return task(1, () => {
        const phys = st.net.pifs[pifRef];
        if (!phys.capabilities.includes("sriov")) fail("PIF_IS_NOT_SRIOV_CAPABLE", pifRef);
        if (phys.sriov_physical_PIF_of.length) fail("NETWORK_SRIOV_ALREADY_ENABLED", pifRef);
        if (phys.host === H2 && flag("sriov-fails-h2")) fail("INTERNAL_ERROR", "sriov-fails-h2");
        const n = ++st.net.n, sriov = `OpaqueRef:sriov-new-${n}`, logical = `OpaqueRef:pif-sriov-new-${n}`;
        st.net.pifs[logical] = { ...phys, uuid: `uuid-${logical}`, network: netRef, physical: false, management: false, ip_configuration_mode: "None", IP: "", netmask: "",
          gateway: "", DNS: "", sriov_logical_PIF_of: [sriov], sriov_physical_PIF_of: [], capabilities: [], other_config: {}, currently_attached: true };
        phys.sriov_physical_PIF_of = [sriov];
        st.net.sriovs[sriov] = { physical_PIF: pifRef, logical_PIF: logical, requires_reboot: false, configuration_mode: "sysfs" };
        st.net.networks[netRef].PIFs.push(logical);
        return sriov;
      });
    }
    case "network_sriov.destroy": {
      const x = st.net.sriovs[h];
      if (!x) fail("HANDLE_INVALID", "network_sriov", h);
      const logical = st.net.pifs[x.logical_PIF];
      const net = st.net.networks[logical.network];
      net.PIFs = net.PIFs.filter((r) => r !== x.logical_PIF);
      delete st.net.pifs[x.logical_PIF];
      st.net.pifs[x.physical_PIF].sriov_physical_PIF_of = [];
      delete st.net.sriovs[h];
      return "";
    }
    case "VIF.get_all_records": return st.net.vifs;
    // nfs-sr: an NFS SR attached on both hosts, its server on the storage VLAN (192.0.2.0/24).
    case "SR.get_all_records":
      return flag("nfs-sr") || flag("nfs-sr-name") ? { "OpaqueRef:sr-nfs": { name_label: "NFS-Storage", type: "nfs", PBDs: ["OpaqueRef:pbd-1", "OpaqueRef:pbd-2"] } } : {};
    case "PBD.get_all_records":
      return flag("nfs-sr") || flag("nfs-sr-name")
        ? Object.fromEntries([[1, H1], [2, H2]].map(([i, host]) => [`OpaqueRef:pbd-${i}`, { SR: "OpaqueRef:sr-nfs", host, currently_attached: true, device_config: { server: flag("nfs-sr-name") ? "nfs.invalid" : "192.0.2.5", serverpath: "/export/xen" } }]))
        : {};
    case "PIF.set_other_config": st.net.pifs[h].other_config = { ...p[2] }; return "";
    case "PIF.get_currently_attached": return st.net.pifs[h].currently_attached;
    case "PIF.get_other_config": return st.net.pifs[h].other_config;
    case "PIF.get_record": return st.net.pifs[h];
    // The coordinator's management address changed to another 127.x one: from now on
    // only that address answers (the server handler below), as a real host would.
    case "Async.PIF.reconfigure_ip":
      return task(1, () => {
        rpc("PIF.reconfigure_ip", p);
        const pif = st.net.pifs[h];
        if (pif.host === H1 && pif.management && /^127\./.test(pif.IP)) st.listenOnly = pif.IP;
        return "";
      });
    case "Async.host.management_reconfigure":
      return task(1, () => {
        const pif = st.net.pifs[h];
        if (!pif || pif.ip_configuration_mode === "None") fail("PIF_HAS_NO_NETWORK_CONFIGURATION", h);
        for (const q of Object.values(st.net.pifs)) if (q.host === pif.host) q.management = false;
        pif.management = true;
        if (pif.host === H1 && /^127\./.test(pif.IP)) st.listenOnly = pif.IP;
        return "";
      });
    // Bonds as XAPI makes them (xapi_bond.ml): the bond interface takes over the
    // address (and the management interface) of the member that had one.
    // bond-fails-h1: making the bond on xs-01 fails.
    case "Async.Bond.create": {
      const [netRef, members, , mode, props] = p.slice(1);
      return task(1, () => {
        const ms = members.map((m) => st.net.pifs[m]);
        if (ms.some((m) => !m || !m.physical)) fail("PIF_IS_NOT_PHYSICAL", members);
        if (ms.some((m) => m.bond_slave_of !== "OpaqueRef:NULL")) fail("PIF_ALREADY_BONDED", members);
        const host = ms[0].host;
        if (host === H1 && flag("bond-fails-h1")) fail("INTERNAL_ERROR", "bond-fails-h1");
        const n = ++st.net.n, bond = `OpaqueRef:bond-new-${n}`, master = `OpaqueRef:pif-bond-new-${n}`;
        const withIp = members.find((m) => st.net.pifs[m].ip_configuration_mode !== "None") ?? members[0];
        const from = st.net.pifs[withIp];
        st.net.pifs[master] = { uuid: `uuid-${master}`, host, network: netRef, device: `bond${n}`, MAC: ms[0].MAC, VLAN: "-1", physical: false, managed: true,
          currently_attached: true, metrics: "OpaqueRef:NULL", bond_master_of: [bond], bond_slave_of: "OpaqueRef:NULL", VLAN_master_of: "OpaqueRef:NULL",
          sriov_logical_PIF_of: [], tunnel_access_PIF_of: [], capabilities: [], other_config: {}, disallow_unplug: false, MTU: "1500",
          management: from.management, ip_configuration_mode: from.ip_configuration_mode, IP: from.IP, netmask: from.netmask, gateway: from.gateway, DNS: from.DNS };
        Object.assign(from, { management: false, ip_configuration_mode: "None", IP: "", netmask: "", gateway: "", DNS: "" });
        for (const m of ms) m.bond_slave_of = bond;
        st.net.bonds[bond] = { master, slaves: [...members], mode, properties: { ...props }, primary_slave: withIp };
        st.net.networks[netRef].PIFs.push(master);
        return bond;
      });
    }
    case "Bond.get_master": return st.net.bonds[h].master;
    case "Bond.get_primary_slave": return st.net.bonds[h].primary_slave;
    case "Bond.set_mode": st.net.bonds[h].mode = p[2]; return "";
    case "Bond.set_property": st.net.bonds[h].properties[p[2]] = p[3]; return "";
    case "Async.Bond.destroy": case "Bond.destroy": {
      const undo = () => {
        const b = st.net.bonds[h];
        if (!b) fail("HANDLE_INVALID", "Bond", h);
        const master = st.net.pifs[b.master], to = st.net.pifs[b.primary_slave];
        Object.assign(to, { management: master.management, ip_configuration_mode: master.ip_configuration_mode, IP: master.IP, netmask: master.netmask, gateway: master.gateway, DNS: master.DNS });
        for (const m of b.slaves) st.net.pifs[m].bond_slave_of = "OpaqueRef:NULL";
        const net = st.net.networks[master.network];
        net.PIFs = net.PIFs.filter((x) => x !== b.master);
        delete st.net.pifs[b.master];
        delete st.net.bonds[h];
        return "";
      };
      return method.startsWith("Async.") ? task(1, undo) : undo();
    }
    case "PIF.reconfigure_ip": {
      const pif = st.net.pifs[h];
      if (!["None", "DHCP", "Static"].includes(p[2])) fail("INVALID_VALUE", "mode", p[2]);
      if (pif.management && p[2] === "None") fail("PIF_IS_MANAGEMENT_INTERFACE", h);
      if (p[2] === "Static" && (!p[3] || !p[4])) fail("INVALID_VALUE", "IP", p[3]);
      Object.assign(pif, { ip_configuration_mode: p[2], IP: p[2] === "None" ? "" : p[3], netmask: p[2] === "None" ? "" : p[4], gateway: p[2] === "None" ? "" : p[5], DNS: p[2] === "None" ? "" : p[6] });
      return "";
    }
    // Writing networks, with XAPI's own refusals (xapi_network.ml, xapi_vlan.ml, xapi_pif.ml).
    case "network.create": {
      const r = p[1], ref = `OpaqueRef:net-new-${++st.net.n}`;
      st.net.networks[ref] = { uuid: `uuid-new-${st.net.n}`, name_label: r.name_label, name_description: r.name_description, bridge: r.bridge || `xapi${st.net.n}`,
        MTU: String(r.MTU), PIFs: [], VIFs: [], other_config: { ...r.other_config }, tags: [...(r.tags || [])], managed: r.managed };
      return ref;
    }
    case "pool.create_VLAN_from_PIF": {
      const base = st.net.pifs[p[1]], net = st.net.networks[p[2]], tag = String(p[3]);
      if (!base || !net) fail("HANDLE_INVALID", base ? "network" : "PIF", base ? p[2] : p[1]);
      if (flag("vlan-fails")) fail("INTERNAL_ERROR", "vlan-fails");
      // A VLAN on an SR-IOV network's logical PIF is apart from the NIC's own VLANs.
      const sriov = (q) => (q.sriov_logical_PIF_of || []).length > 0;
      const taggedOf = (q) => st.net.pifs[st.net.vlans[q.VLAN_master_of]?.tagged_PIF];
      if (Object.values(st.net.pifs).some((q) => q.device === base.device && q.VLAN === tag && taggedOf(q) && sriov(taggedOf(q)) === sriov(base))) fail("PIF_VLAN_EXISTS", p[1]);
      const made = [];
      for (const host of [H1, H2]) {
        const tagged = Object.entries(st.net.pifs).find(([, q]) => q.host === host && q.device === base.device && q.VLAN === "-1" && sriov(q) === sriov(base) && !(q.bond_master_of || []).length === !(base.bond_master_of || []).length);
        if (!tagged) continue;
        const n = ++st.net.n, vref = `OpaqueRef:vlan-new-${n}`, pref = `OpaqueRef:pif-new-${n}`;
        st.net.vlans[vref] = { tagged_PIF: tagged[0], untagged_PIF: pref, tag };
        st.net.pifs[pref] = { ...tagged[1], uuid: `uuid-${pref}`, network: p[2], VLAN: tag, VLAN_master_of: vref, physical: false, management: false, IP: "", netmask: "",
          gateway: "", DNS: "", ip_configuration_mode: "None", bond_master_of: [], bond_slave_of: "OpaqueRef:NULL", other_config: {}, disallow_unplug: false, currently_attached: true,
          sriov_logical_PIF_of: [], sriov_physical_PIF_of: [] };
        net.PIFs.push(pref);
        made.push(pref);
      }
      return made;
    }
    case "VLAN.destroy": {
      const v = st.net.vlans[h];
      if (!v) fail("HANDLE_INVALID", "VLAN", h);
      const pif = st.net.pifs[v.untagged_PIF];
      if (pif.management) fail("PIF_IS_MANAGEMENT_INTERFACE", v.untagged_PIF);
      const net = st.net.networks[pif.network];
      net.PIFs = net.PIFs.filter((x) => x !== v.untagged_PIF);
      delete st.net.pifs[v.untagged_PIF];
      delete st.net.vlans[h];
      return "";
    }
    case "network.destroy": {
      const net = st.net.networks[h];
      if (!net) fail("HANDLE_INVALID", "network", h);
      if (net.PIFs.length) fail("NETWORK_CONTAINS_PIF", net.PIFs);
      if (net.VIFs.length) fail("NETWORK_CONTAINS_VIF", net.VIFs);
      delete st.net.networks[h];
      return "";
    }
    case "network.set_name_label": st.net.networks[h].name_label = p[2]; return "";
    case "network.set_name_description": st.net.networks[h].name_description = p[2]; return "";
    case "network.set_MTU": st.net.networks[h].MTU = String(p[2]); return "";
    case "network.add_to_other_config":
      if (p[2] in st.net.networks[h].other_config) fail("MAP_DUPLICATE_KEY", "network", "other_config", h, p[2]);
      st.net.networks[h].other_config[p[2]] = p[3]; return "";
    case "network.remove_from_other_config": delete st.net.networks[h].other_config[p[2]]; return "";
    case "network.add_tags": if (!st.net.networks[h].tags.includes(p[2])) st.net.networks[h].tags.push(p[2]); return "";
    case "network.remove_tags": st.net.networks[h].tags = st.net.networks[h].tags.filter((t) => t !== p[2]); return "";
    case "PIF.unplug": st.net.pifs[h].currently_attached = false; return "";
    case "PIF.plug": st.net.pifs[h].currently_attached = true; return "";
    // vmss-model: VM snapshot schedules, with xapi_vmss.ml's checks. "Nightly"
    // holds db-01 and has two alerts; vmss-restricted: the licence says no.
    case "VMSS.get_all_records": {
      if (!flag("vmss-model")) fail("MESSAGE_METHOD_UNKNOWN", method);
      const m = vmssModel();
      return Object.fromEntries(Object.keys(m.recs).map((r) => [r, vmssRecord(r)]));
    }
    case "VMSS.get_record": {
      if (!vmssModel().recs[h]) fail("HANDLE_INVALID", "VMSS", h);
      return vmssRecord(h);
    }
    case "VMSS.create": {
      vmssLicensed();
      const r = p[1];
      vmssCheck(r.frequency, r.schedule, Number(r.retained_snapshots), r.type);
      const ref = `OpaqueRef:vmss-${++st.n}`;
      vmssModel().recs[ref] = { uuid: `vmss-uuid-${st.n}`, name_label: r.name_label, name_description: r.name_description, enabled: Boolean(r.enabled),
        type: r.type, retained_snapshots: String(r.retained_snapshots), frequency: r.frequency, schedule: { ...r.schedule }, last_run_time: "19700101T00:00:00Z" };
      return ref;
    }
    case "VMSS.destroy": {
      vmssLicensed();
      const m = vmssModel();
      if (Object.values(m.vmOf).includes(h)) fail("VMSS_HAS_VM");
      delete m.recs[h];
      return "";
    }
    case "VMSS.set_name_label": case "VMSS.set_name_description": case "VMSS.set_enabled": case "VMSS.set_type": case "VMSS.set_retained_snapshots": {
      vmssLicensed();
      const rec = vmssModel().recs[h];
      if (!rec) fail("HANDLE_INVALID", "VMSS", h);
      const field = method.slice("VMSS.set_".length);
      if (field === "retained_snapshots" && !(Number(p[2]) >= 1 && Number(p[2]) <= 10)) fail("INVALID_VALUE", "retained_snapshots", String(p[2]));
      rec[field] = field === "enabled" ? Boolean(p[2]) : String(p[2]);
      return "";
    }
    case "VMSS.set_frequency": {
      vmssLicensed();
      const rec = vmssModel().recs[h];
      // As assert_set_frequency: the keys of the new frequency, kept where present, else XAPI's defaults.
      const keys = VMSS_KEYS[p[2]];
      if (!keys) fail("INVALID_VALUE", "frequency", p[2]);
      const defaults = { min: "0", hour: "0", days: "Monday" };
      rec.frequency = p[2];
      rec.schedule = Object.fromEntries(keys.map((k) => [k, rec.schedule[k] ?? defaults[k]]));
      return "";
    }
    case "VMSS.set_schedule": {
      vmssLicensed();
      const rec = vmssModel().recs[h];
      vmssCheck(rec.frequency, p[2], Number(rec.retained_snapshots), rec.type);
      rec.schedule = { ...p[2] };
      return "";
    }
    // Synchronous only, as in XenServer (no Async.VMSS.snapshot_now): the answer comes once
    // the snapshots are taken -- held back by the server below; "vmss-snapshot-fails" fails it.
    case "VMSS.snapshot_now": {
      vmssLicensed();
      if (!vmssModel().recs[h]) fail("HANDLE_INVALID", "VMSS", h);
      if (flag("vmss-snapshot-fails")) fail("SR_FULL", "OpaqueRef:sr-nfs");
      return "";
    }
    case "VM.set_snapshot_schedule": {
      vmssLicensed();
      const m = vmssModel();
      if (p[2] === "OpaqueRef:NULL") delete m.vmOf[h];
      else {
        if (!m.recs[p[2]]) fail("HANDLE_INVALID", "VMSS", p[2]);
        m.vmOf[h] = p[2];
      }
      return "";
    }
    // A fixed time for the tests; "live-clock" (screenshots): the coordinator's clock now, in UTC.
    case "host.get_server_localtime": return flag("live-clock") ? new Date().toISOString().replace(/-/g, "").replace(/\.\d+Z$/, "") : "20261121T10:07:00";
    case "message.get_all_records":
      if (!flag("vmss-model")) return {};
      return {
        "OpaqueRef:msg-vmss-1": { cls: "VMSS", obj_uuid: "vmss-uuid-nightly", name: "VMSS_SNAPSHOT_SUCCEEDED", body: "Snapshots of 1 VM taken.", priority: "5", timestamp: "20261121T02:00:09Z" },
        "OpaqueRef:msg-vmss-2": { cls: "VMSS", obj_uuid: "vmss-uuid-nightly", name: "VMSS_SNAPSHOT_FAILED", body: "db-01: SR full", priority: "3", timestamp: "20261120T02:00:07Z" },
        "OpaqueRef:msg-other": { cls: "Host", obj_uuid: "11111111-1111-4111-8111-111111111111", name: "HA_HOST_FAILED", body: "", priority: "1", timestamp: "20261121T01:00:00Z" },
      };
    case "VM_metrics.get_all_records":
      return {};
    case "host_metrics.get_record":
      return { memory_total: "68719476736", memory_free: "34359738368", live: true, last_updated: "20261005T10:00:00Z" };
    case "host.get_uuid": return HOST_UUID[h];
    case "host.get_servertime": return "20261105T10:00:00Z";
    // tls.crt is what this fake serves; the second host may report its own
    // (h2.crt), as a member of a real pool would.
    case "host.get_server_certificate": {
      const f = h === H2 && fs.existsSync(path.join(DIR, "h2.crt")) ? "h2.crt" : "tls.crt";
      return fs.readFileSync(path.join(DIR, f), "utf8");
    }
    case "host.get_all": return Object.keys(st.hosts);
    case "VM.get_data_sources": return dsRecords(h, DS_VM);
    case "host.get_data_sources": return dsRecords(h, DS_HOST);
    case "VM.record_data_source":
    case "host.record_data_source": {
      if (!(method.startsWith("VM") ? DS_VM : DS_HOST).some((d) => d[0] === p[2])) fail("INVALID_VALUE", p[2]);
      recordedNow.add(h + "|" + p[2]);
      return "";
    }
    case "VM.get_uuid": return vmUuid(h);
    // Both hosts answer on this fake's port; the name tells them apart.
    // nat-addresses: the hosts report their own (unreachable) addresses, as behind NAT.
    case "host.get_address": return flag("nat-addresses") ? st.hosts[h].address : h === H1 ? "127.0.0.1" : "localhost";
    case "Async.pool.sync_updates":
      if (m === "license") fail("LICENSE_RESTRICTION", "Updates");
      return task(m === "slow" ? 4 : 1, () => { st.synced = true; st.lastSync = "20261002T12:00:00Z"; fs.writeFileSync(path.join(DIR, "mode"), "normal"); return "abc123hash"; });
    case "host.compute_free_memory": return h === H1 ? "34359738368" : "17179869184";
    // vm1-too-big: no host takes web-01.
    case "VM.assert_can_boot_here": {
      const target = p[2];
      if (!st.hosts[target].enabled || !live(target)) fail("HOST_DISABLED", target);
      if (flag("vm1-too-big") && h === "OpaqueRef:vm-1") fail("HOST_NOT_ENOUGH_FREE_MEMORY", "68719476736", "17179869184");
      return "";
    }
    case "VM.get_current_operations":
      return flag("busy-vm") && h === "OpaqueRef:vm-1" ? { "OpaqueRef:task-busy": "start" } : {};
    case "task.get_record": {
      // busy-stale: the start is long over, its task gone, the VM still marked.
      if (h === "OpaqueRef:task-busy") {
        if (flag("busy-stale")) fail("HANDLE_INVALID", "task", h);
        return { status: "pending", progress: 0.35, created: "20261014T08:02:00Z", name_label: "Async.VM.start" };
      }
      const t = st.tasks[h];
      if (!t) fail("HANDLE_INVALID", "task", h);
      // As XAPI: the whole record, its name and what may be done with it included.
      if (t.polls-- > 0) {
        return { status: "pending", progress: 0.4, name_label: t.name_label ?? "", created: t.created, resident_on: t.resident_on,
          other_config: t.other_config ?? {}, allowed_operations: ["cancel"] };
      }
      try { const r = t.done(); t.final = { status: "success" }; return { status: "success", progress: 1, result: r ?? "" }; }
      catch (e) {
        const error_info = Array.isArray(e) ? e : [String(e)];
        t.final = { status: "failure", error_info };
        return { status: "failure", progress: 1, error_info };
      }
    }
    // task-list: the pool's tasks as XAPI lists them (Recent Tasks); without
    // it none, as before (the event store would record them otherwise).
    case "task.get_all_records": {
      if (!flag("task-list")) return {};
      if (flag("foreign-task")) foreignTasks();
      const out = {};
      for (const [ref, t] of Object.entries(st.tasks)) {
        if (!t.name_label) continue;
        const status = t.cancelled ? "cancelled" : t.final ? t.final.status : "pending";
        out[ref] = {
          name_label: t.name_label, name_description: "", status, progress: status === "pending" ? 0.4 : 1,
          created: t.created, finished: status === "pending" ? "19700101T00:00:00Z" : t.created,
          resident_on: t.resident_on, other_config: t.other_config, subtask_of: t.subtask_of || "OpaqueRef:NULL",
          allowed_operations: status === "pending" ? ["cancel"] : [], error_info: t.final?.error_info ?? [],
        };
      }
      return out;
    }
    case "task.destroy": delete st.tasks[h]; return "";
    case "task.cancel": {
      const t = st.tasks[h];
      if (t?.hang) { log("cancel ignored " + h); return ""; }
      if (t) { t.polls = 0; t.done = () => fail("TASK_CANCELLED", h); t.cancelled = true; }
      for (const x of Object.values(st.hosts)) if (x.evacTask === h) delete x.evacTask;
      log("cancelled " + h);
      return "";
    }
    // One RFB console per VM, served by this fake (CONNECT /console). Its
    // address: console-host in STATE_DIR (a test may need a non-loopback one).
    case "VM.get_consoles": return ["OpaqueRef:c1"];
    case "console.get_record": {
      let at = "127.0.0.1";
      try { at = fs.readFileSync(path.join(DIR, "console-host"), "utf8").trim() || at; } catch {}
      return { protocol: "rfb", location: `${TLS ? "https" : "http"}://${at}:${PORT}/console?ref=${h}`, VM: "OpaqueRef:vm-1" };
    }
    case "VM.get_is_control_domain": return /dom0/.test(h) || Boolean(st.vms?.[h]?.dom0);
    default: fail("MESSAGE_METHOD_UNKNOWN", method);
  }
}

// Steps of the tests read this to see the state the pool was left in.
function dump() {
  fs.writeFileSync(path.join(DIR, "state.json"), JSON.stringify({
    hosts: Object.fromEntries(Object.values(st.hosts).map((x) => [x.name, { enabled: x.enabled, pending: x.pending, pendingRecommended: x.pendingRecommended ?? [], pendingFull: x.pendingFull ?? [], updates: x.updates, reboots: x.reboots }])),
    vms: Object.fromEntries(Object.values(st.vms).filter((v) => !v.dom0).map((v) => [v.name, st.hosts[v.resident]?.name ?? null])),
    wlb: st.wlb,
  }, null, 2));
}
dump();

// HTTPS when STATE_DIR has tls.key + tls.crt, as a real XenServer serves XAPI.
const TLS = fs.existsSync(path.join(DIR, "tls.key"))
  ? { key: fs.readFileSync(path.join(DIR, "tls.key")), cert: fs.readFileSync(path.join(DIR, "tls.crt")) }
  : null;
const server = (TLS ? https.createServer.bind(null, TLS) : http.createServer)((req, res) => {
  // The coordinator restarting: nothing answers.
  if (Date.now() < st.apiDownUntil) { req.socket.destroy(); return; }
  // The coordinator's management address moved: the old one is gone.
  if (st.listenOnly && !String(req.socket.localAddress).endsWith(st.listenOnly)) { req.socket.destroy(); return; }
  // As XAPI does (seen in the field): a body sent in chunks gets the line hung up.
  if (req.headers["transfer-encoding"]) { log(`hung up on a chunked ${req.method} ${req.url}`); req.socket.destroy(); return; }
  if (req.method === "GET" && req.url.startsWith("/rrd_updates")) {
    const q = new URL(req.url, "http://x").searchParams;
    const hostRef = String(req.headers.host || "").startsWith("localhost") ? H2 : H1;
    log(`GET /rrd_updates ${st.hosts[hostRef].name} ${q.get("vm_uuid") ? "vm_uuid=" + q.get("vm_uuid") : "host=" + q.get("host")} interval=${q.get("interval")} cf=${q.get("cf")}`);
    if (!String(q.get("session_id") || "").startsWith("OpaqueRef:session-")) { res.writeHead(401); return res.end(); }
    if (hostRef === H2 && flag("rrd-h2-down")) { res.writeHead(503); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/xml" });
    if (flag("rrd-empty")) return res.end("<xport><meta><step>5</step><legend></legend></meta><data></data></xport>");
    if (q.get("vm_uuid")) return res.end(rrdXml(hostRef, "none", 5).replace(/<entry>[^<]*<\/entry>/g, ""));
    return res.end(rrdXml(hostRef, null, Number(q.get("interval")) || 5, flag("rrd-json")));
  }
  if (req.method === "PUT" && req.url.startsWith("/import") && flag("import-model")) return importPut(req, res);
  if (req.method === "GET" && req.url.startsWith("/updates")) {
    const sid = new URL(req.url, "http://x").searchParams.get("session_id") || "";
    log(`GET /updates ${sid.startsWith("OpaqueRef:session-") ? "with-session" : "no-session"}`);
    if (!sid.startsWith("OpaqueRef:session-")) { res.writeHead(401); return res.end(); }
    if (!st.synced) { res.writeHead(500); return res.end("Internal error"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(updatesJson()));
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    // events-tick (with sr-model): event.from answers every second with NFS-Storage
    // changed, as a busy pool keeps sending -- the browser's pool data changes all the time.
    if (msg.method === "event.from" && flag("events-tick") && flag("sr-model")) {
      const s = srState();
      const ref = "OpaqueRef:sr-nfs";
      s.srs[ref].physical_utilisation = String(Number(s.srs[ref].physical_utilisation) + 1048576);
      const tok = String(Date.now());
      return setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { events: [{ id: tok, timestamp: tok, class: "sr", operation: "mod", ref, snapshot: { ...s.srs[ref], allowed_operations: srAllowed(s, ref) } }], token: tok, valid_ref_counts: {} } }));
      }, 1000);
    }
    log(`${msg.method} ${JSON.stringify((msg.params || []).slice(1))}`);
    let out;
    try { out = { jsonrpc: "2.0", id: msg.id, result: rpc(msg.method, msg.params || []) }; }
    catch (e) { const d = Array.isArray(e) ? e : ["INTERNAL_ERROR", String(e)]; out = { jsonrpc: "2.0", id: msg.id, error: { code: 1, message: d[0], data: d.slice(1) } }; }
    dump();
    // A synchronous call that takes its time (VMSS.snapshot_now): the answer 1.5 s later.
    if (msg.method === "VMSS.snapshot_now") {
      return setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      }, 1500);
    }
    dump();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out).replace(/"__INF__"/g, "Infinity").replace(/"__NINF__"/g, "-Infinity").replace(/"__NAN__"/g, "NaN"));
  });
});
// A console: CONNECT /console?ref=...&session_id=..., then RFB as qemu speaks
// it: security None, a 640x480 screen, a picture only when one was asked for
// -- requests in between merely set "wanted", at most one picture per 10 ms.
// What the client sent goes to $FX/rfb.log; "vnc-big" makes each picture 1 MB.
const RFB_FIXED = { 0: 20, 3: 10, 4: 8, 5: 6, 150: 10, 250: 4 };
server.on("connect", (req, socket) => {
  log(`CONNECT ${req.url.replace(/session_id=[^&]*/, "session_id=*")}`);
  // log-logins: which session the console was asked for with (session-handle-test.sh).
  if (flag("log-logins")) log(`console session ${new URL(req.url, "http://x").searchParams.get("session_id")}`);
  socket.write("HTTP/1.1 200 OK\r\n\r\nRFB 003.008\n");
  socket.on("error", () => {});
  const rlog = (line) => fs.appendFileSync(path.join(DIR, "rfb.log"), line + "\n");
  let phase = "version";
  let buf = Buffer.alloc(0);
  let wanted = false;
  let garbage = 0;
  let sent = 0;
  const big = flag("vnc-big");
  const picture = () => {
    const w = big ? 512 : 1, h = big ? 512 : 1;
    const m = Buffer.alloc(16 + w * h * 4);
    m.writeUInt8(0, 0); m.writeUInt16BE(1, 2);
    m.writeUInt16BE(w, 8); m.writeUInt16BE(h, 10); m.writeInt32BE(0, 12);
    return m;
  };
  const timer = setInterval(() => {
    if (!wanted || socket.destroyed || socket.writableLength > 4 * 1024 * 1024) return;
    wanted = false;
    sent++;
    socket.write(picture());
  }, 10);
  // http's sockets stay half open: the client gone, close this side too.
  socket.on("end", () => socket.end());
  socket.on("close", () => {
    clearInterval(timer);
    rlog(`closed pictures=${sent} written=${socket.bytesWritten}`);
  });
  socket.on("data", (chunk) => {
    if (phase === "garbage") { garbage += chunk.length; rlog(`garbage ${garbage}`); return; }
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (phase === "version") {
        if (buf.length < 12) return;
        rlog(`version ${buf.subarray(0, 11).toString()}`);
        buf = buf.subarray(12); phase = "security";
        socket.write(Buffer.from([1, 1]));
        continue;
      }
      if (phase === "security") {
        if (buf.length < 1) return;
        buf = buf.subarray(1); phase = "init";
        socket.write(Buffer.from([0, 0, 0, 0]));
        continue;
      }
      if (phase === "init") {
        if (buf.length < 1) return;
        buf = buf.subarray(1); phase = "messages";
        const init = Buffer.alloc(24 + 4);
        init.writeUInt16BE(640, 0); init.writeUInt16BE(480, 2);
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
        init.writeUInt32BE(4, 20); init.write("fake", 24);
        socket.write(init);
        continue;
      }
      if (!buf.length) return;
      const t = buf[0];
      let len = RFB_FIXED[t];
      if (!len) {
        if (t === 2) len = buf.length < 4 ? 0 : 4 + 4 * buf.readUInt16BE(2);
        else if (t === 6) len = buf.length < 8 ? 0 : 8 + Math.abs(buf.readInt32BE(4));
        else if (t === 255) len = 12;
        else { phase = "garbage"; garbage = buf.length; rlog(`unknown ${t}`); rlog(`garbage ${garbage}`); return; }
        if (!len) return;
      }
      if (buf.length < len) return;
      const m = buf.subarray(0, len);
      buf = buf.subarray(len);
      if (t === 3) { wanted = true; rlog(`request ${m[1]}`); }
      else if (t === 2) {
        const encs = [];
        for (let i = 4; i < m.length; i += 4) encs.push(m.readInt32BE(i));
        rlog(`encodings ${encs.join(",")}`);
      } else if (t === 6) rlog(`cut ${len - 8} ${require("crypto").createHash("md5").update(m.subarray(8)).digest("hex")}`);
      else rlog(`message ${t}`);
    }
  });
});
server.listen(PORT, process.env.FAKE_LISTEN || "127.0.0.1");
