// Creating, changing and removing a pool's networks the way XenCenter does it:
// the same XAPI calls in the same order (xenadmin: XenModel/Actions/Network/
// NetworkAction.cs and UnplugPlugNetworkAction.cs, XenAdmin/Wizards/
// NewNetworkWizard.cs, SettingsPanels/EditNetworkPage.cs, Controls/
// NetworkingTab/NetworkList.cs). Everything is checked against the records
// first, so a refused request writes nothing. Where XenMan refuses more than
// XenCenter does, the comment says so.

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

/** One XAPI call on the request's session. */
export type XapiCall = <T = unknown>(method: string, params: unknown[]) => Promise<T>;

export interface NetworkRecords {
  networks: Recs;
  pifs: Recs;
  vifs: Recs;
  vms: Recs;
  pool: Rec;
  /** For VLANs on an SR-IOV network: the VLAN and network_sriov records. */
  vlans?: Recs;
  sriovs?: Recs;
}

/** A request XenCenter would not allow (or XenMan does not): nothing was written. */
export class NetworkRefused extends Error {}

const NULL = "OpaqueRef:NULL";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const refs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== NULL) : []);
const map = (v: unknown): Record<string, string> => (v && typeof v === "object" ? (v as Record<string, string>) : {});

// Network.CREATE_IN_PROGRESS: set while a bond's network is being built.
export const CREATE_IN_PROGRESS = "XenCenterCreateInProgress";

// Network.MTU_MIN / MTU_MAX.
export const MTU_MIN = 1500;
export const MTU_MAX = 9216;
const VLAN_MAX = 4094;

const vlanOf = (p: Rec) => Number(p.VLAN ?? -1);
const isTunnelAccess = (p: Rec) => refs(p.tunnel_access_PIF_of).length > 0;
const isSriovLogical = (p: Rec) => refs(p.sriov_logical_PIF_of).length > 0;
// PIF.IsPhysical(): a NIC or a bond, not a VLAN, tunnel or SR-IOV PIF on one.
const isPhysical = (p: Rec) => vlanOf(p) === -1 && !isTunnelAccess(p) && !isSriovLogical(p);
const isBondNic = (p: Rec) => refs(p.bond_master_of).length > 0;
const isBondMember = (p: Rec) => str(p.bond_slave_of) !== "" && str(p.bond_slave_of) !== NULL;
const pifShown = (p: Rec) => p.managed !== false && (map(p.other_config).HideFromXenCenter ?? "").toLowerCase() !== "true";
// PIF.IsManagementInterface(): the primary one, or a secondary one with an address.
const carriesIp = (p: Rec) => p.management === true || !["", "None"].includes(str(p.ip_configuration_mode));
const interfaceName = (p: Rec) => (p.management === true ? "Management" : map(p.other_config).management_purpose || "Unknown");

function ints(v: unknown, min: number, max: number, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw new NetworkRefused(`${what}: Invalid number`);
  if (n < min || n > max) throw new NetworkRefused(`${what}: allowed range ${min} to ${max}`);
  return n;
}

function text(v: unknown, what: string, max: number, required: boolean): string {
  if (typeof v !== "string") throw new NetworkRefused(`${what} is missing`);
  const t = v.trim();
  if (required && !t) throw new NetworkRefused(`${what} must not be empty`);
  if (t.length > max) throw new NetworkRefused(`${what} is too long`);
  return t;
}

/** The pool's coordinator, whose NICs the wizard and the properties use (as XenCenter's do). */
function coordinatorOf(r: NetworkRecords): string {
  const c = str(r.pool.master);
  if (!c) throw new NetworkRefused("The pool coordinator could not be found");
  return c;
}

/** A NIC of the coordinator a VLAN may sit on: physical (or a bond), shown, not in a bond. */
function vlanBase(r: NetworkRecords, pifRef: unknown): [string, Rec] {
  const p = typeof pifRef === "string" ? r.pifs[pifRef] : undefined;
  if (!p || str(p.host) !== coordinatorOf(r) || !isPhysical(p) || !pifShown(p) || isBondMember(p)) {
    throw new NetworkRefused("Choose one of the coordinator's NICs");
  }
  return [pifRef as string, p];
}

// PIF.NetworkSriov() for a VLAN: whether it sits on an SR-IOV network's logical PIF.
function onSriov(r: NetworkRecords, p: Rec): boolean {
  if (isSriovLogical(p)) return true;
  const tagged = r.pifs[str(r.vlans?.[str(p.VLAN_master_of)]?.tagged_PIF)];
  return Boolean(tagged && isSriovLogical(tagged));
}

/** NetWDetails.GetVLANList / NetworkAction: a tag already on that device anywhere in the pool --
 * counted apart for VLANs on the SR-IOV network of that device. */
function assertVlanFree(r: NetworkRecords, base: Rec, vlan: number, sriov = false) {
  const taken = Object.values(r.pifs).some((p) => str(p.device) === str(base.device) && vlanOf(p) === vlan && onSriov(r, p) === sriov);
  if (taken) throw new NetworkRefused("This VLAN number is already in use");
}

// The SR-IOV network's logical PIF on a NIC (NewNetworkWizard.CreateNonBonded, CreateVlanOnSriovNetwork).
function sriovLogicalOf(r: NetworkRecords, physical: Rec): string | null {
  const sriov = r.sriovs?.[refs(physical.sriov_physical_PIF_of)[0] ?? ""];
  const logical = str(sriov?.logical_PIF);
  return logical && r.pifs[logical] ? logical : null;
}

const autoValue = (auto: boolean) => (auto ? "true" : "false");

/* ── Add Network: External or Single-Server Private (NewNetworkWizard.CreateNonBonded) ── */

export interface CreateInput {
  type: unknown;
  name: unknown;
  description: unknown;
  auto: unknown;
  pifRef?: unknown;
  vlan?: unknown;
  mtu?: unknown;
  /** "Create the VLAN on the SR-IOV network" of the NIC. */
  onSriov?: unknown;
}

export async function createNetwork(call: XapiCall, r: NetworkRecords, input: CreateInput): Promise<string> {
  const external = input.type === "external";
  if (!external && input.type !== "private") throw new NetworkRefused("Choose External or Single-Server Private");
  const name = text(input.name, "Name", 255, true);
  const description = text(input.description ?? "", "Description", 1000, false);
  if (typeof input.auto !== "boolean") throw new NetworkRefused("Automatically add: true or false");

  let base: [string, Rec] | null = null;
  let vlan = 0;
  let mtu = MTU_MIN;
  if (external) {
    base = vlanBase(r, input.pifRef);
    vlan = ints(input.vlan, 0, VLAN_MAX, "VLAN");
    const sriov = input.onSriov === true;
    assertVlanFree(r, base[1], vlan, sriov);
    // The MTU goes up to the NIC's own (NetWDetails: Maximum = min(PIF.MTU, MTU_MAX)).
    const max = Math.max(MTU_MIN, Math.min(Number(base[1].MTU ?? MTU_MIN), MTU_MAX));
    mtu = input.mtu === undefined ? MTU_MIN : ints(input.mtu, MTU_MIN, max, "MTU");
    if (sriov) {
      const logical = sriovLogicalOf(r, base[1]);
      if (!logical) throw new NetworkRefused("This NIC has no SR-IOV network");
      base = [logical, r.pifs[logical]];
    }
  }

  // CreateNetworkObject(): name, description, managed, other_config.automatic, MTU.
  const networkRef = await call<string>("network.create", [
    { name_label: name, name_description: description, MTU: mtu, other_config: { automatic: autoValue(input.auto) }, bridge: "", managed: true, tags: [] },
  ]);
  if (base) {
    try {
      await call("pool.create_VLAN_from_PIF", [base[0], networkRef, vlan]);
    } catch (err) {
      // XenCenter leaves the new network behind when the VLAN fails; XenMan
      // takes it away again -- it has no PIFs yet and nothing uses it.
      await call("network.destroy", [networkRef]).catch(() => {});
      throw err;
    }
  }
  return networkRef;
}

/* ── Properties: General and Network Settings (PropertiesDialog, EditNetworkPage) ── */

export interface UpdateInput {
  name?: unknown;
  description?: unknown;
  folder?: unknown;
  tags?: unknown;
  auto?: unknown;
  mtu?: unknown;
  /** "internal", or a PIF of the coordinator for a VLAN on it. */
  nic?: unknown;
  vlan?: unknown;
  /** A bond's mode, and with LACP its load balancing. */
  bondMode?: unknown;
  hashing?: unknown;
}

function networkFacts(r: NetworkRecords, ref: string) {
  const n = r.networks[ref];
  if (!n) throw new NetworkRefused("The network no longer exists");
  const oc = map(n.other_config);
  const pifs = refs(n.PIFs).filter((p) => r.pifs[p]).map((p) => [p, r.pifs[p]] as [string, Rec]);
  const coordinator = coordinatorOf(r);
  const own = pifs.find(([, p]) => str(p.host) === coordinator) ?? null;
  // EditNetworkButton.Enabled: not a bond member's network, not being created, not the installer network.
  if (oc.is_guest_installer_network === "true") throw new NetworkRefused("The guest installer network cannot be changed");
  if (pifs.some(([, p]) => isBondMember(p))) throw new NetworkRefused("The network of a bond member cannot be changed");
  if (oc[CREATE_IN_PROGRESS] === "true") throw new NetworkRefused("The network is still being created");
  const attachedVifs = refs(n.VIFs).filter((v) => r.vifs[v]?.currently_attached === true);
  const runningVms = [
    ...new Set(
      attachedVifs
        .map((v) => r.vms[str(r.vifs[v].VM)])
        .filter((vm) => vm && str(vm.power_state) === "Running")
        .map((vm) => str(vm!.name_label)),
    ),
  ];
  const management = pifs.find(([, p]) => carriesIp(p));
  return { n, oc, pifs, own, attachedVifs, runningVms, management: management ? interfaceName(management[1]) : null };
}

/** EditNetworkPage.Editable(): only a VLAN, or a network without PIFs, may change its NIC and VLAN. */
const editable = (own: [string, Rec] | null) => !own || (!isPhysical(own[1]) && !isTunnelAccess(own[1]) && !isSriovLogical(own[1]));

export async function updateNetwork(call: XapiCall, r: NetworkRecords | BondRecords, ref: string, input: UpdateInput): Promise<string[]> {
  const f = networkFacts(r, ref);
  const changes: string[] = [];
  // Checked with everything else, written after the network's own fields.
  const bondPlan = input.bondMode === undefined ? null : planBondMode(r as BondRecords, ref, input.bondMode, input.hashing);

  // General.
  const name = input.name === undefined ? null : text(input.name, "Name", 255, true);
  const description = input.description === undefined ? null : text(input.description, "Description", 1000, false);
  const folder = input.folder === undefined ? null : text(input.folder, "Folder", 500, false).replace(/\/+/g, "/");
  let tags: string[] | null = null;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 50) throw new NetworkRefused("Tags: a list");
    tags = [...new Set(input.tags.map((t) => text(t, "Tag", 100, true)))];
  }
  if (input.auto !== undefined && typeof input.auto !== "boolean") throw new NetworkRefused("Automatically add: true or false");

  // MTU (EditNetworkPage.SetMTUControlEnablement).
  const curMtu = Number(f.n.MTU ?? MTU_MIN);
  const mtu = input.mtu === undefined ? null : ints(input.mtu, Math.min(curMtu, MTU_MIN), Math.max(curMtu, MTU_MAX), "MTU");
  const mtuChanged = mtu !== null && mtu !== curMtu;

  // NIC and VLAN (SetNetSettingsEnablement, InternalToExternal / ExternalToInternal / ExternalChangedDeviceOrVlan).
  let pifChange: { external: boolean; base: [string, Rec] | null; vlan: number } | null = null;
  if (input.nic !== undefined) {
    const toInternal = input.nic === "internal";
    const base = toInternal ? null : vlanBase(r, input.nic);
    const vlan = toInternal ? -1 : ints(input.vlan, 0, VLAN_MAX, "VLAN");
    const same = toInternal
      ? f.pifs.length === 0
      : f.own !== null && vlanOf(f.own[1]) === vlan && str(f.own[1].device) === str(base![1].device);
    if (!same) {
      if (!editable(f.own)) throw new NetworkRefused("The NIC and VLAN of this network cannot be changed");
      if (f.pifs.length) {
        if (f.management) {
          throw new NetworkRefused(`(The network's NIC and VLAN cannot be changed as it is in use as the management interface '${f.management}')`);
        }
        if (f.attachedVifs.length) throw new NetworkRefused("(The network's NIC and VLAN cannot be changed as there are active VMs attached)");
      }
      if (base) assertVlanFree(r, base[1], vlan);
      pifChange = { external: !toInternal, base, vlan };
    }
  }

  if (mtuChanged) {
    if (f.pifs.some(([, p]) => isTunnelAccess(p))) throw new NetworkRefused("The MTU of this network cannot be changed");
    const internalNow = pifChange ? !pifChange.external : f.pifs.length === 0;
    if (internalNow) throw new NetworkRefused("The MTU of a private network cannot be changed");
    if (!pifChange) {
      if (f.management) {
        throw new NetworkRefused(`(The network's MTU cannot be changed because it is in use as the management interface '${f.management}')`);
      }
      // Stricter than XenCenter, which unplugs and replugs the VMs' interfaces
      // when the VMs have tools: XenMan does not touch running VMs' networks.
      if (f.runningVms.length) {
        throw new NetworkRefused(`(The network's MTU cannot be changed while running VMs are attached: ${f.runningVms.slice(0, 5).join(", ")}${f.runningVms.length > 5 ? ", …" : ""})`);
      }
      // Stricter as well: replugging a NIC takes the VLANs on it down too --
      // not while one of them carries an IP address (storage, say).
      const devices = new Map(f.pifs.filter(([, p]) => vlanOf(p) === -1).map(([, p]) => [str(p.host), str(p.device)]));
      const above = Object.values(r.pifs).find((p) => vlanOf(p) >= 0 && devices.get(str(p.host)) === str(p.device) && carriesIp(p));
      if (above) {
        throw new NetworkRefused(`(The network's MTU cannot be changed because VLAN ${vlanOf(above)} on its NIC carries the interface '${interfaceName(above)}')`);
      }
    }
  }

  // Validated: now write, in XenCenter's order -- the object's own fields
  // first (SaveChangesAction), then the PIFs (NetworkAction) or the replug
  // that applies a new MTU (UnplugPlugNetworkAction).
  if (name !== null && name !== str(f.n.name_label)) {
    await call("network.set_name_label", [ref, name]);
    changes.push("name");
  }
  if (description !== null && description !== str(f.n.name_description)) {
    await call("network.set_name_description", [ref, description]);
    changes.push("description");
  }
  if (mtuChanged) {
    await call("network.set_MTU", [ref, mtu]);
    changes.push(`MTU ${mtu}`);
  }
  if (input.auto !== undefined && (f.oc.automatic === "true") !== input.auto) {
    await call("network.remove_from_other_config", [ref, "automatic"]);
    await call("network.add_to_other_config", [ref, "automatic", autoValue(input.auto as boolean)]);
    changes.push(`automatic ${autoValue(input.auto as boolean)}`);
  }
  if (folder !== null && folder !== (f.oc.folder ?? "")) {
    if (f.oc.folder !== undefined) await call("network.remove_from_other_config", [ref, "folder"]);
    if (folder) await call("network.add_to_other_config", [ref, "folder", folder]);
    changes.push("folder");
  }
  if (tags !== null) {
    const cur = Array.isArray(f.n.tags) ? (f.n.tags as string[]) : [];
    for (const t of cur.filter((t) => !tags!.includes(t))) await call("network.remove_tags", [ref, t]);
    for (const t of tags.filter((t) => !cur.includes(t))) await call("network.add_tags", [ref, t]);
    if (cur.length !== tags.length || cur.some((t) => !tags!.includes(t))) changes.push("tags");
  }

  if (bondPlan) changes.push(...(await bondPlan(call)));

  if (pifChange) {
    await destroyPifs(call, f.pifs);
    if (pifChange.external) await call("pool.create_VLAN_from_PIF", [pifChange.base![0], ref, pifChange.vlan]);
    changes.push(pifChange.external ? `VLAN ${pifChange.vlan} on ${str(pifChange.base![1].device)}` : "internal");
  } else if (mtuChanged) {
    await replug(call, f.pifs);
  }
  return changes;
}

/** UnplugPlugNetworkAction, PIFs only (no running VM is attached, checked above). */
async function replug(call: XapiCall, pifs: [string, Rec][]) {
  const attached = pifs.filter(([, p]) => p.currently_attached === true);
  // As XenCenter: carry on through errors to leave as much plugged as can be, then report the first.
  let first: unknown = null;
  for (const [ref] of attached) await call("PIF.unplug", [ref]).catch((e) => (first ??= e));
  for (const [ref] of attached) await call("PIF.plug", [ref]).catch((e) => (first ??= e));
  if (first) throw first;
}

/** NetworkAction.destroyPIFs(). */
async function destroyPifs(call: XapiCall, pifs: [string, Rec][]) {
  for (const [ref, p] of pifs) {
    if (isTunnelAccess(p)) {
      for (const t of refs(p.tunnel_access_PIF_of)) await call("tunnel.destroy", [t]);
    } else if (p.physical !== true) {
      if (vlanOf(p) !== -1) await call("VLAN.destroy", [str(p.VLAN_master_of)]);
      if (isSriovLogical(p)) await call("network_sriov.destroy", [refs(p.sriov_logical_PIF_of)[0]]);
    } else {
      await call("PIF.forget", [ref]);
    }
  }
}

/* ── Remove Network (NetworkList.RemoveNetworkButton, NetworkAction destroy) ── */

export async function destroyNetwork(call: XapiCall, r: NetworkRecords, ref: string): Promise<void> {
  const f = networkFacts(r, ref);
  // NetworkList.HasPhysicalNonBondNIC.
  if (f.pifs.some(([, p]) => isPhysical(p) && !isBondNic(p))) throw new NetworkRefused("This network cannot be removed because it is a physical device");
  // XenCenter removes a bond with DestroyBondCommand -- a step of its own, not here yet.
  if (f.pifs.some(([, p]) => isBondNic(p))) throw new NetworkRefused("A bonded network is removed together with its bond; XenMan cannot do that yet");
  // Stricter than XenCenter, which leaves these to XAPI -- by then the VLANs would be gone already.
  if (f.management) throw new NetworkRefused(`The network carries the interface '${f.management}'. Remove its IP address first.`);
  const vifs = refs(f.n.VIFs).filter((v) => r.vifs[v]);
  if (vifs.length) {
    const names = [...new Set(vifs.map((v) => str(r.vms[str(r.vifs[v].VM)]?.name_label)).filter(Boolean))];
    throw new NetworkRefused(`VMs still have network interfaces on this network: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`);
  }
  await destroyPifs(call, f.pifs);
  await call("network.destroy", [ref]);
}

/* ── Configure IP Addresses: secondary interfaces (NetworkingProperties, ChangeNetworkingAction) ── */

export interface IpRecords extends NetworkRecords {
  hosts: Recs;
  clusterHosts: Recs;
  srs: Recs;
  pbds: Recs;
}

/** One secondary interface as the dialog leaves it (one page of NetworkingProperties). */
export interface IpPageInput {
  /** The interface the page started from (on the server configured); none for "Add IP address". */
  pifRef?: unknown;
  name: unknown;
  networkRef: unknown;
  mode: unknown;
  ip?: unknown;
  netmask?: unknown;
  gateway?: unknown;
}

/** An attached storage reached over an interface that is about to change. */
export interface StorageAtRisk {
  sr: string;
  server: string;
  host: string;
  interface: string;
}

export class StorageConfirmationNeeded extends Error {
  constructor(readonly storage: StorageAtRisk[]) {
    super("Storage is reached over the interfaces being changed");
  }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ipNum = (ip: string) => ip.split(".").reduce((a, b) => a * 256 + Number(b), 0);
// StringUtility.IsValidNetmask: ones, then zeros, not all zero.
function validNetmask(m: string): boolean {
  if (!IPV4.test(m)) return false;
  const n = ipNum(m);
  if (n === 0) return false;
  const hostPart = 0xffffffff - n;
  return ((hostPart + 1) & hostPart) === 0;
}
function sameSubnet(a: string, b: string, mask: string): boolean {
  if (!IPV4.test(a) || !IPV4.test(b) || !validNetmask(mask)) return false;
  const size = 0xffffffff - ipNum(mask) + 1;
  return Math.floor(ipNum(a) / size) === Math.floor(ipNum(b) / size);
}

// Network.Show(): not the installer network, not hidden, not a bond member's, every PIF shown.
function networkShown(r: NetworkRecords, n: Rec): boolean {
  const oc = map(n.other_config);
  if (oc.is_guest_installer_network === "true" || (oc.HideFromXenCenter ?? "").toLowerCase() === "true") return false;
  const ps = refs(n.PIFs).map((p) => r.pifs[p]).filter(Boolean);
  return !ps.some((p) => isBondMember(p) || !pifShown(p));
}

const networkLabel = (r: NetworkRecords, ref: string) => str(r.networks[ref]?.name_label) || ref;
const hasIp = (p: Rec) => !["", "None"].includes(str(p.ip_configuration_mode));

// Where a network SR's server is: NFS and SMB "server", iSCSI "target" (a list), an ISO
// library's "location" (//server/share, \\server\share or server:/path).
function storageServers(dc: Record<string, string>): string[] {
  const out = [dc.server ?? "", ...(dc.target ?? "").split(",")];
  const loc = dc.location ?? "";
  if (/^(\/\/|\\\\)/.test(loc) || /^[^/\\]+:\//.test(loc)) out.push(loc);
  return [
    ...new Set(
      out
        .map((s) => s.trim().replace(/^(\/\/|\\\\)/, "").split(/[/\\]/)[0].split(":")[0])
        .filter(Boolean),
    ),
  ];
}

// Host.CompareTo: by name, naturally -- the order ChangeNetworkingAction hands out an address range in.
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * The secondary interfaces of one server (hostRef), or of the pool (null: the
 * coordinator's, applied to every server, a static address as a range), as
 * XenCenter's Configure IP Addresses dialog leaves them. The management
 * interface is not touched here.
 */
export async function configureIpInterfaces(
  call: XapiCall,
  r: IpRecords,
  hostRef: string | null,
  pagesIn: unknown,
  confirmStorage: boolean,
  /** Name to IPv4 addresses, for SRs that name their server rather than give its address. */
  resolve: (name: string) => Promise<string[]> = async () => [],
): Promise<string[]> {
  const pool = hostRef === null;
  const H = hostRef ?? coordinatorOf(r);
  if (!r.hosts[H]) throw new NetworkRefused("The server no longer exists");
  if (!Array.isArray(pagesIn) || pagesIn.length > 32) throw new NetworkRefused("The interfaces: a list");
  const pifOnH = (netRef: string) => refs(r.networks[netRef]?.PIFs).find((p) => str(r.pifs[p]?.host) === H) ?? null;
  const managementNetwork = str(Object.values(r.pifs).find((p) => str(p.host) === H && p.management === true)?.network);

  // The secondary interfaces of this server now (PIF.IsSecondaryManagementInterface).
  const current = Object.entries(r.pifs)
    .filter(([, p]) => str(p.host) === H && p.management !== true && hasIp(p) && r.networks[str(p.network)] && networkShown(r, r.networks[str(p.network)]))
    .map(([ref]) => ref);

  type Page = { old: string | null; target: string; name: string; mode: "DHCP" | "Static"; ip: string; netmask: string; gateway: string };
  const pages: Page[] = [];
  const used = new Set<string>();
  const hostCount = Object.keys(r.hosts).length;
  for (const raw of pagesIn as IpPageInput[]) {
    const page = (raw ?? {}) as IpPageInput;
    const old = typeof page.pifRef === "string" && page.pifRef ? page.pifRef : null;
    if (old !== null && !current.includes(old)) throw new NetworkRefused("An interface changed meanwhile; open the dialog again");
    const name = text(page.name, "Name", 100, true);
    const netRef = typeof page.networkRef === "string" ? page.networkRef : "";
    const net = r.networks[netRef];
    const target = net ? pifOnH(netRef) : null;
    // RefreshNetworkComboBox / MakeProposedInUseMap: a network with a PIF here, no SR-IOV, no tunnel.
    if (!net || !target || !networkShown(r, net) || isTunnelAccess(r.pifs[target]) || isSriovLogical(r.pifs[target])) {
      throw new NetworkRefused(`${name}: choose a network of this server`);
    }
    if (netRef === managementNetwork) throw new NetworkRefused(`${networkLabel(r, netRef)} is currently in use by the primary interface`);
    if (used.has(netRef)) throw new NetworkRefused(`${networkLabel(r, netRef)} is currently in use by another interface`);
    used.add(netRef);
    if (page.mode !== "DHCP" && page.mode !== "Static") throw new NetworkRefused(`${name}: DHCP or Static`);
    let ip = "";
    let netmask = "";
    let gateway = "";
    if (page.mode === "Static") {
      ip = text(page.ip, "IP address", 15, true);
      netmask = text(page.netmask, "Subnet mask", 15, true);
      gateway = text(page.gateway ?? "", "Gateway", 15, false);
      if (!IPV4.test(ip)) throw new NetworkRefused(`${name}: the IP address is not valid`);
      if (!validNetmask(netmask)) throw new NetworkRefused(`${name}: the subnet mask is not valid`);
      if (gateway && !IPV4.test(gateway)) throw new NetworkRefused(`${name}: the gateway is not valid`);
      // XenMan: a pool's range may not run past .254 (XenCenter has IsInRange for it, but never calls it).
      if (pool && Number(ip.split(".")[3]) + hostCount - 1 > 254) {
        throw new NetworkRefused(`${name}: the range from ${ip} for ${hostCount} servers runs past .254`);
      }
    }
    pages.push({ old, target, name, mode: page.mode, ip, netmask, gateway });
  }

  // CollateChanges: brought up (new, other network, other address), only renamed, or brought down.
  const dnsOf = (pg: Page) => (pg.old ? str(r.pifs[pg.old].DNS) : "");
  const up: Page[] = [];
  const renamed: Page[] = [];
  for (const pg of pages) {
    const t = r.pifs[pg.target];
    let changed = pg.old !== pg.target || str(t.ip_configuration_mode) !== pg.mode;
    if (pg.mode === "Static" && (str(t.IP) !== pg.ip || str(t.netmask) !== pg.netmask || str(t.gateway) !== pg.gateway || str(t.DNS) !== dnsOf(pg))) changed = true;
    if (changed) up.push(pg);
    else if ((map(t.other_config).management_purpose ?? "") !== pg.name) renamed.push(pg);
  }
  const down = current.filter((ref) => !pages.some((pg) => pg.target === ref));

  // NetworkingActionHelpers.ForSomeHosts: this server's PIF of the network, or the other servers'.
  const reach = (pifRef: string, thisHost: boolean) =>
    refs(r.networks[str(r.pifs[pifRef].network)]?.PIFs).filter((p) => r.pifs[p] && (str(r.pifs[p].host) === H) === thisHost);
  const everywhere = (pifRef: string) => [...(pool ? reach(pifRef, false) : []), ...reach(pifRef, true)];
  const touched = [...up.map((pg) => pg.target), ...down].flatMap(everywhere);

  // ChangeNetworkingAction.DisableClustering: XenMan leaves clustered interfaces to XenCenter.
  const clustered = Object.values(r.clusterHosts).find((c) => touched.includes(str(c.PIF)));
  if (clustered) {
    throw new NetworkRefused(
      `The interface can only be changed when the host is in maintenance mode, because clustering is enabled on ${networkLabel(r, str(r.pifs[str(clustered.PIF)].network))}.`,
    );
  }

  // XenMan: attached storage reached over an interface that changes or goes away is named first and needs a yes.
  // A server given by name is looked up; one that cannot be is counted in -- better asked once too often.
  const atRisk: StorageAtRisk[] = [];
  const looked = new Map<string, string[]>();
  for (const pifRef of touched) {
    const p = r.pifs[pifRef];
    if (!hasIp(p)) continue;
    for (const pbd of Object.values(r.pbds)) {
      if (pbd.currently_attached !== true || str(pbd.host) !== str(p.host)) continue;
      for (const server of storageServers(map(pbd.device_config))) {
        let addresses = IPV4.test(server) ? [server] : looked.get(server);
        if (!addresses) {
          addresses = (await resolve(server).catch(() => [] as string[])).filter((a) => IPV4.test(a));
          looked.set(server, addresses);
        }
        const unknown = addresses.length === 0;
        if (!unknown && !addresses.some((a) => sameSubnet(a, str(p.IP), str(p.netmask)))) continue;
        atRisk.push({
          sr: str(r.srs[str(pbd.SR)]?.name_label) || "storage",
          server: unknown ? `${server} (address unknown)` : server === addresses[0] ? server : `${server}, ${addresses.join(", ")}`,
          host: str(r.hosts[str(p.host)]?.name_label),
          interface: map(p.other_config).management_purpose || "Unknown",
        });
      }
    }
  }
  if (atRisk.length && !confirmStorage) throw new StorageConfirmationNeeded(atRisk);

  // PIF.SaveChanges writes other_config and nothing else (disallow_unplug XenCenter sets only locally).
  const setPurpose = async (pifRef: string, purpose: string | null) => {
    const oc = { ...map(r.pifs[pifRef].other_config) };
    if ((oc.management_purpose ?? null) === purpose) return;
    if (purpose === null) delete oc.management_purpose;
    else oc.management_purpose = purpose;
    await call("PIF.set_other_config", [pifRef, oc]);
  };

  // NetworkingActionHelpers.BringUp: the name, the address, then plugged if it is not.
  const bringUp = async (pg: Page, pifRef: string) => {
    const existing = r.pifs[pifRef];
    let ip = str(existing.IP);
    if (pg.mode === "Static") {
      // GetIPInRange in a pool: the range's start plus the server's place among the pool's servers.
      const i = Object.entries(r.hosts)
        .sort(([, a], [, b]) => natural(str(a.name_label), str(b.name_label)))
        .findIndex(([ref]) => ref === str(existing.host));
      const bits = pg.ip.split(".");
      ip = pool ? `${bits[0]}.${bits[1]}.${bits[2]}.${Number(bits[3]) + i}` : pg.ip;
    }
    await setPurpose(pifRef, pg.name);
    // The new PIF's fields: for DHCP the ones it had, for Static the page's (DNS kept, as the page hides it).
    const fields = pg.mode === "Static" ? [ip, pg.netmask, pg.gateway, dnsOf(pg)] : [ip, str(existing.netmask), str(existing.gateway), str(existing.DNS)];
    await call("PIF.reconfigure_ip", [pifRef, pg.mode, ...fields]);
    if (!(await call<boolean>("PIF.get_currently_attached", [pifRef]))) await call("PIF.plug", [pifRef]);
  };
  // BringDown: the name taken away, then the address. XenMan skips a PIF that has none.
  const bringDown = async (pifRef: string) => {
    await setPurpose(pifRef, null);
    if (hasIp(r.pifs[pifRef])) await call("PIF.reconfigure_ip", [pifRef, "None", "", "", "", ""]);
  };

  const done: string[] = [];
  // SetSecondaryManagementPurposeAction: a new name alone, on every PIF of the network in a pool.
  for (const pg of renamed) {
    for (const p of everywhere(pg.target)) await setPurpose(p, pg.name);
    done.push(`renamed ${pg.name}`);
  }
  // AcceptBtn_Click reverses both lists. ChangeNetworkingAction: up on the other servers first, then
  // here; then down the same way.
  for (const pg of [...up].reverse()) {
    for (const p of everywhere(pg.target)) await bringUp(pg, p);
    done.push(`${pg.name} on ${networkLabel(r, str(r.pifs[pg.target].network))} (${pg.mode === "Static" ? pg.ip : "DHCP"})`);
  }
  for (const ref of [...down].reverse()) {
    for (const p of everywhere(ref)) await bringDown(p);
    done.push(`removed ${map(r.pifs[ref].other_config).management_purpose || "Unknown"}`);
  }
  return done;
}

/* ── Bonds (CreateBondAction, DestroyBondAction, BondDetails, DestroyBondCommand) ── */

export interface BondRecords extends NetworkRecords {
  hosts: Recs;
  bonds: Recs;
  clusterHosts: Recs;
}

export const BOND_MODES = ["balance-slb", "active-backup", "lacp"] as const;
export const HASHING = ["src_mac", "tcpudp_ports"] as const;

// Helpers.SupportsLinkAggregationBond / BondSizeLimit: LACP and four members on the vSwitch backend only.
export function vSwitch(r: { hosts: Recs; pool: Rec }): boolean {
  return map(r.hosts[str(r.pool.master)]?.software_version).network_backend === "openvswitch";
}
const bondSizeLimit = (r: BondRecords) => (vSwitch(r) ? 4 : 2);

/** What a bond change is confirmed with: the pool's name, or the coordinator's for a pool without one (Helpers.GetName). */
export function confirmationName(r: { hosts: Recs; pool: Rec }): string {
  return str(r.pool.name_label) || str(r.hosts[str(r.pool.master)]?.name_label);
}
function assertConfirmed(r: BondRecords, typed: unknown) {
  const want = confirmationName(r);
  if (typeof typed !== "string" || typed.trim().toLowerCase() !== want.toLowerCase()) {
    throw new NetworkRefused(`Type the pool's name, ${want}, to confirm`);
  }
}

const nicNumber = (p: Rec) => str(p.device).replace("eth", "");
// PIF.BondSuffix + Messages.PIF_BOND: "Bond 2+3".
const bondName = (members: Rec[]) => `Bond ${members.map(nicNumber).sort().join("+")}`;
// NetworkingHelper.Sort: by PIF name ("NIC 2" before "NIC 3").
const byName = (a: [string, Rec], b: [string, Rec]) => natural(`NIC ${nicNumber(a[1])}`, `NIC ${nicNumber(b[1])}`);

function hostsCoordinatorLast(r: BondRecords): string[] {
  const c = str(r.pool.master);
  return [...Object.keys(r.hosts).filter((h) => h !== c), c];
}

/**
 * An Async. call, its task followed to the end. A bond moves the management
 * interface, so the coordinator may not answer for a moment: errors while
 * polling are retried for a while (XenCenter: Connection.ExpectDisruption).
 */
export async function asyncCall(call: XapiCall, method: string, params: unknown[], waitMs = 180_000, everyMs = 500): Promise<string> {
  const task = await call<string>(`Async.${method}`, params);
  const until = Date.now() + waitMs;
  for (;;) {
    await new Promise((res) => setTimeout(res, everyMs));
    let t: Rec;
    try {
      t = await call<Rec>("task.get_record", [task]);
    } catch (err) {
      if (Date.now() > until) throw err;
      continue;
    }
    const status = str(t.status);
    if (status === "pending") {
      if (Date.now() > until) throw new Error(`${method} did not finish in time`);
      continue;
    }
    await call("task.destroy", [task]).catch(() => {});
    if (status === "success") return /OpaqueRef:[\w-]+/.exec(str(t.result))?.[0] ?? str(t.result);
    const info = Array.isArray(t.error_info) ? (t.error_info as unknown[]).map(String) : [status];
    throw new XapiTaskError(info[0] || status, info.slice(1));
  }
}

/** A task that ended in failure, as XAPI names it. */
export class XapiTaskError extends Error {
  constructor(code: string, readonly data: string[]) {
    super(code);
  }
}

// NetworkingActionHelpers.MoveManagementInterfaceName: a secondary interface's name goes with it.
async function moveInterfaceName(call: XapiCall, from: string, to: string) {
  const fromOc = await call<Record<string, string>>("PIF.get_other_config", [from]);
  const purpose = fromOc.management_purpose;
  if (!purpose) return;
  const toOc = await call<Record<string, string>>("PIF.get_other_config", [to]);
  await call("PIF.set_other_config", [to, { ...toOc, management_purpose: purpose }]);
  const rest = { ...fromOc };
  delete rest.management_purpose;
  await call("PIF.set_other_config", [from, rest]);
}

export interface BondInput {
  /** NICs of the coordinator (the wizard lists the coordinator's). */
  pifRefs: unknown;
  mode: unknown;
  hashing?: unknown;
  mtu?: unknown;
  auto: unknown;
  confirmName: unknown;
}

export async function createBond(call: XapiCall, r: BondRecords, input: BondInput): Promise<{ networkRef: string; name: string }> {
  const coordinator = coordinatorOf(r);
  if (!Array.isArray(input.pifRefs)) throw new NetworkRefused("Select the NICs for the bond");
  const chosen = [...new Set(input.pifRefs.map(String))];
  const limit = bondSizeLimit(r);
  if (chosen.length < 2 || chosen.length > limit) throw new NetworkRefused(`A bond has 2 to ${limit} NICs`);
  const devices: string[] = [];
  for (const ref of chosen) {
    const p = r.pifs[ref];
    // BondDetails: the coordinator's NICs, not bonds, not already in one.
    if (!p || str(p.host) !== coordinator || !isPhysical(p) || isBondNic(p) || !pifShown(p)) throw new NetworkRefused("Choose NICs of the coordinator");
    if (isBondMember(p)) throw new NetworkRefused(`NIC ${nicNumber(p)} is already in a bond`);
    devices.push(str(p.device));
  }
  // CreateBondAction takes the NICs of the same names on every server (NetworkingHelper.PIFsOnAllHosts).
  // XenMan: every server must have them, free -- a bond with members missing is not made.
  const members = new Map<string, [string, Rec][]>();
  for (const host of Object.keys(r.hosts)) {
    const mine = Object.entries(r.pifs).filter(([, p]) => str(p.host) === host && devices.includes(str(p.device)) && p.physical === true && isPhysical(p));
    const name = str(r.hosts[host].name_label);
    if (mine.length !== devices.length) throw new NetworkRefused(`${name} does not have all of these NICs`);
    const busy = mine.find(([, p]) => isBondMember(p));
    if (busy) throw new NetworkRefused(`NIC ${nicNumber(busy[1])} on ${name} is already in a bond`);
    members.set(host, mine.sort(byName));
  }
  const all = [...members.values()].flat();
  // BondDetails.CanCreateBond.
  const primary = all.some(([, p]) => p.management === true);
  const secondary = all.some(([, p]) => p.management !== true && carriesIp(p));
  if (primary && secondary) {
    throw new NetworkRefused(
      "This bond cannot be created because both management and secondary interfaces exist on your selected bond members.\n\nBoth types of interface cannot be added to the same bond. Choose different bond members, or move the management interfaces before creating the bond.",
    );
  }
  if (primary && r.pool.ha_enabled === true) {
    throw new NetworkRefused(
      "Can't create this bond while HA is enabled\n\nA management interface exists on one of the selected NICs. Moving the management interface to the bond could result in HA network heartbeat failure, so this action is not allowed while HA is on.\n\nTo continue, either select different NICs for the bond, or disable HA, create the bond, and then enable HA again.",
    );
  }
  // XenMan leaves clustered interfaces to XenCenter (it would have to stop clustering for this).
  if (Object.values(r.clusterHosts).some((c) => all.some(([ref]) => ref === str(c.PIF)))) {
    throw new NetworkRefused("Clustering uses one of these NICs; create this bond in XenCenter");
  }
  const mode = String(input.mode);
  if (!(BOND_MODES as readonly string[]).includes(mode)) throw new NetworkRefused("Bond mode: Active-active, Active-passive or LACP");
  if (mode === "lacp" && !vSwitch(r)) throw new NetworkRefused("LACP needs the vSwitch network backend");
  const hashing = mode === "lacp" ? String(input.hashing) : "";
  if (mode === "lacp" && !(HASHING as readonly string[]).includes(hashing)) throw new NetworkRefused("LACP: choose the load balancing");
  // BondDetails.UpdateMtuControls: up to the smallest MTU of the members.
  const mtuMax = Math.max(MTU_MIN, Math.min(MTU_MAX, ...chosen.map((ref) => Number(r.pifs[ref].MTU ?? MTU_MIN))));
  const mtu = input.mtu === undefined ? MTU_MIN : ints(input.mtu, MTU_MIN, mtuMax, "MTU");
  if (typeof input.auto !== "boolean") throw new NetworkRefused("Automatically add: true or false");
  assertConfirmed(r, input.confirmName);

  const name = bondName(chosen.map((ref) => r.pifs[ref]));
  // CreateBondAction.CreateNetwork, then the in-progress mark taken off again straight away.
  const networkRef = await call<string>("network.create", [
    {
      name_label: name,
      name_description: "",
      MTU: mtu,
      other_config: { automatic: autoValue(input.auto), [CREATE_IN_PROGRESS]: "true" },
      bridge: "",
      managed: true,
      tags: [],
    },
  ]);
  const made: { bond: string; master: string; members: string[] }[] = [];
  try {
    await call("network.remove_from_other_config", [networkRef, CREATE_IN_PROGRESS]);
    for (const host of hostsCoordinatorLast(r)) {
      const refsHere = members.get(host)!.map(([ref]) => ref);
      const bond = await asyncCall(call, "Bond.create", [networkRef, refsHere, "", mode, mode === "lacp" ? { hashing_algorithm: hashing } : {}]);
      const master = await call<string>("Bond.get_master", [bond]);
      made.push({ bond, master, members: refsHere });
    }
    for (const b of made) for (const m of b.members) await moveInterfaceName(call, m, b.master);
  } catch (err) {
    // As CreateBondAction: names back, the new bonds and the network taken away, each step on its own.
    for (const b of made) {
      const first = await call<string>("Bond.get_primary_slave", [b.bond]).catch(() => b.members[0]);
      await moveInterfaceName(call, b.master, first && first !== NULL ? first : b.members[0]).catch(() => {});
      await call("Bond.destroy", [b.bond]).catch(() => {});
    }
    await call("network.destroy", [networkRef]).catch(() => {});
    throw err;
  }
  return { networkRef, name };
}

/** The bonds of a bond's network on every server (NetworkingHelper.FindBond), the coordinator's last. */
function bondsOf(r: BondRecords, networkRef: string) {
  const out: { host: string; bond: string; master: string; members: string[]; first: string }[] = [];
  for (const pifRef of refs(r.networks[networkRef]?.PIFs)) {
    const p = r.pifs[pifRef];
    if (!p || !isBondNic(p)) continue;
    const bond = refs(p.bond_master_of)[0];
    const b = r.bonds[bond];
    if (!b) continue;
    const members = refs(b.slaves).filter((m) => r.pifs[m]).map((m) => [m, r.pifs[m]] as [string, Rec]).sort(byName).map(([m]) => m);
    const primary = str(b.primary_slave);
    out.push({ host: str(p.host), bond, master: pifRef, members, first: primary && primary !== NULL ? primary : members[0] });
  }
  const c = str(r.pool.master);
  return out.sort((a, b) => Number(a.host === c) - Number(b.host === c));
}

export async function destroyBond(call: XapiCall, r: BondRecords, networkRef: string, confirmName: unknown): Promise<string> {
  const n = r.networks[networkRef];
  if (!n) throw new NetworkRefused("The network no longer exists");
  const bonds = bondsOf(r, networkRef);
  if (!bonds.length) throw new NetworkRefused("This network is not a bond");
  const pifs = refs(n.PIFs).map((p) => r.pifs[p]).filter(Boolean);
  // DestroyBondCommand: not with the management interface on it while HA is on.
  if (pifs.some((p) => p.management === true) && r.pool.ha_enabled === true) {
    throw new NetworkRefused(
      "Can't delete this bond while HA is enabled\n\nA management interface exists on one of the bonded NICs. Deleting the bond could result in HA network heartbeat failure, so this action is not allowed while HA is on.\n\nTo continue, disable HA, delete the bond, and then enable HA again.",
    );
  }
  if (Object.values(r.clusterHosts).some((c) => bonds.some((b) => b.master === str(c.PIF)))) {
    throw new NetworkRefused("Clustering uses this bond; delete it in XenCenter");
  }
  // Stricter than XenCenter, as for any network: not while VMs have interfaces on it.
  const vifs = refs(n.VIFs).filter((v) => r.vifs[v]);
  if (vifs.length) {
    const names = [...new Set(vifs.map((v) => str(r.vms[str(r.vifs[v].VM)]?.name_label)).filter(Boolean))];
    throw new NetworkRefused(`VMs still have network interfaces on this network: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`);
  }
  assertConfirmed(r, confirmName);

  const name = bondName(bonds[0].members.map((m) => r.pifs[m]));
  // DestroyBondAction: the names to the first members, then every bond, then the network; errors collected.
  for (const b of bonds) await moveInterfaceName(call, b.master, b.first);
  const errors: unknown[] = [];
  for (const b of bonds) await asyncCall(call, "Bond.destroy", [b.bond]).catch((e) => errors.push(e));
  await call("network.destroy", [networkRef]).catch((e) => errors.push(e));
  if (errors.length) throw errors[0];
  return name;
}

/**
 * EditNetworkPage.SetBondModeActions / SetBondPropertiesActions: checked now,
 * written by the function returned (after the network's own fields, as XenCenter orders it).
 */
export function planBondMode(r: BondRecords, networkRef: string, modeIn: unknown, hashingIn: unknown): (call: XapiCall) => Promise<string[]> {
  const bonds = bondsOf(r, networkRef);
  if (!bonds.length) throw new NetworkRefused("This network is not a bond");
  const mode = String(modeIn);
  if (!(BOND_MODES as readonly string[]).includes(mode)) throw new NetworkRefused("Bond mode: Active-active, Active-passive or LACP");
  if (mode === "lacp" && !vSwitch(r)) throw new NetworkRefused("LACP needs the vSwitch network backend");
  const hashing = mode === "lacp" ? String(hashingIn) : "";
  if (mode === "lacp" && !(HASHING as readonly string[]).includes(hashing)) throw new NetworkRefused("LACP: choose the load balancing");
  const first = r.bonds[bonds[0].bond];
  return async (call: XapiCall) => {
    const done: string[] = [];
    if (str(first.mode) !== mode) {
      for (const b of bonds) await call("Bond.set_mode", [b.bond, mode]);
      done.push(`bond mode ${mode}`);
    }
    if (mode === "lacp" && map(first.properties).hashing_algorithm !== hashing) {
      for (const b of bonds) await call("Bond.set_property", [b.bond, "hashing_algorithm", hashing]);
      done.push(`hashing ${hashing}`);
    }
    return done;
  };
}

/* ── SR-IOV network (NewNetworkWizard.CreateSRIOV, NetWSriovDetails, CreateSriovAction) ── */

// Host.RestrictSriovNetwork: restricted unless the licence says otherwise (BoolKeyPreferTrue).
export function sriovLicensed(r: { hosts: Recs }): boolean {
  return Object.values(r.hosts).every((h) => map(h.license_params).restrict_network_sriov === "false");
}
const sriovCapable = (p: Rec) => Array.isArray(p.capabilities) && (p.capabilities as unknown[]).includes("sriov");
const sriovEnabled = (p: Rec) => refs(p.sriov_physical_PIF_of).length > 0;

export interface SriovInput {
  name: unknown;
  description?: unknown;
  auto: unknown;
  /** The coordinator's NIC (NetWSriovDetails lists the coordinator's). */
  pifRef: unknown;
  confirmName: unknown;
}

export async function createSriov(call: XapiCall, r: BondRecords, input: SriovInput): Promise<string> {
  if (!sriovLicensed(r)) throw new NetworkRefused("'SR-IOV' feature is disabled due to license restrictions on the server.");
  const name = text(input.name, "Name", 255, true);
  const description = text(input.description ?? "", "Description", 1000, false);
  if (typeof input.auto !== "boolean") throw new NetworkRefused("Automatically add: true or false");
  const coordinator = coordinatorOf(r);
  const chosen = typeof input.pifRef === "string" ? r.pifs[input.pifRef] : undefined;
  // NetWSriovDetails.PopulateHostNicList: the coordinator's NICs that can, and have no SR-IOV yet.
  // XenMan leaves out NICs in a bond as well.
  if (!chosen || str(chosen.host) !== coordinator || !isPhysical(chosen) || isBondNic(chosen) || isBondMember(chosen) || !sriovCapable(chosen)) {
    throw new NetworkRefused("Choose an SR-IOV capable NIC of the coordinator");
  }
  if (sriovEnabled(chosen)) throw new NetworkRefused("SR-IOV is already enabled on this NIC");
  assertConfirmed(r, input.confirmName);

  // NewNetworkWizard.CreateSRIOV: that NIC on every server that can; CreateSriovAction: the coordinator first.
  const pifs = Object.entries(r.pifs)
    .filter(([, p]) => isPhysical(p) && !isBondNic(p) && !isBondMember(p) && sriovCapable(p) && str(p.device) === str(chosen.device) && !sriovEnabled(p))
    .sort(([, a], [, b]) => Number(str(b.host) === coordinator) - Number(str(a.host) === coordinator))
    .map(([ref]) => ref);

  const networkRef = await call<string>("network.create", [
    { name_label: name, name_description: description, MTU: MTU_MIN, other_config: { automatic: autoValue(input.auto) }, bridge: "", managed: true, tags: [] },
  ]);
  let done = 0;
  try {
    for (const pif of pifs) {
      await asyncCall(call, "network_sriov.create", [pif, networkRef]);
      done++;
    }
  } catch (err) {
    // As CreateSriovAction: the network goes again only if no NIC got SR-IOV yet.
    if (done === 0) await call("network.destroy", [networkRef]).catch(() => {});
    throw err;
  }
  return networkRef;
}

/* ── The management interface (NetworkingProperties' primary page, ChangeNetworkingAction) ── */

export interface ManagementInput {
  /** One server: XenMan changes the management interface host by host. */
  hostRef: unknown;
  networkRef: unknown;
  mode: unknown;
  ip?: unknown;
  netmask?: unknown;
  gateway?: unknown;
  /** Preferred, alternate 1 and 2 (NetworkingPropertiesPage's DNS boxes). */
  dns?: unknown;
  /** The server's name, typed in. */
  confirmName: unknown;
}

export interface ManagementPlan {
  hostRef: string;
  hostName: string;
  coordinator: boolean;
  /** The management PIF now, and the one it goes to (the same one for a new address only). */
  oldPif: string;
  newPif: string;
  oldNic: string;
  newNic: string;
  newNetwork: string;
  move: boolean;
  mode: "DHCP" | "Static";
  ip: string;
  netmask: string;
  gateway: string;
  dns: string;
  oldIp: string;
  /** Where the server answers afterwards; null with DHCP. */
  newIp: string | null;
  /** management_purpose left on the PIFs, which ChangeNetworkingAction takes off (Depurpose). */
  oldPurpose: boolean;
  newPurpose: boolean;
}

// Host.RestrictManagementOnVLAN: restricted unless the licence says otherwise.
const managementOnVlanLicensed = (r: { hosts: Recs }) =>
  Object.values(r.hosts).every((h) => map(h.license_params).restrict_management_on_vlan === "false");

export function planManagementChange(r: BondRecords, input: ManagementInput): ManagementPlan {
  const hostRef = typeof input.hostRef === "string" ? input.hostRef : "";
  const host = r.hosts[hostRef];
  if (!host) throw new NetworkRefused("Change the management interface on one server, in its own Networking tab");
  const hostName = str(host.name_label);
  // NetworkingProperties: Type.PRIMARY_WITH_HA. XenCenter checks HA in the pool's dialog only; XenMan always.
  if (r.pool.ha_enabled === true) throw new NetworkRefused("The primary interface cannot be reconfigured because HA is enabled");
  const old = Object.entries(r.pifs).find(([, p]) => str(p.host) === hostRef && p.management === true);
  if (!old) throw new NetworkRefused(`${hostName} has no management interface XenMan can see`);
  const netRef = typeof input.networkRef === "string" ? input.networkRef : "";
  const net = r.networks[netRef];
  const target = net ? refs(net.PIFs).find((p) => str(r.pifs[p]?.host) === hostRef) : undefined;
  // RefreshNetworkComboBox: a network of this server, no SR-IOV, no tunnel; a VLAN only if the licence allows.
  if (!net || !target || !networkShown(r, net) || isTunnelAccess(r.pifs[target]) || isSriovLogical(r.pifs[target])) {
    throw new NetworkRefused("Choose a network of this server");
  }
  const t = r.pifs[target];
  if (vlanOf(t) >= 0 && !managementOnVlanLicensed(r)) throw new NetworkRefused("The licence does not allow the management interface on a VLAN");
  const move = target !== old[0];
  // FindOtherPurpose: a network another interface uses is not free for this one.
  if (move && carriesIp(t)) throw new NetworkRefused(`${networkLabel(r, netRef)} is currently in use by ${map(t.other_config).management_purpose || "Unknown"}`);
  if (Object.values(r.clusterHosts).some((c) => [old[0], target].includes(str(c.PIF)))) {
    throw new NetworkRefused("Clustering uses this interface; change it in XenCenter");
  }

  if (input.mode !== "DHCP" && input.mode !== "Static") throw new NetworkRefused("DHCP or Static");
  const mode = input.mode;
  let ip = str(t.IP);
  let netmask = str(t.netmask);
  let gateway = str(t.gateway);
  let dns = str(t.DNS);
  if (mode === "Static") {
    ip = text(input.ip, "IP address", 15, true);
    netmask = text(input.netmask, "Subnet mask", 15, true);
    gateway = text(input.gateway ?? "", "Gateway", 15, false);
    if (!IPV4.test(ip)) throw new NetworkRefused("The IP address is not valid");
    if (!validNetmask(netmask)) throw new NetworkRefused("The subnet mask is not valid");
    if (gateway && !IPV4.test(gateway)) throw new NetworkRefused("The gateway is not valid");
    const servers = Array.isArray(input.dns) ? input.dns.map((d) => String(d).trim()).filter(Boolean) : [];
    if (servers.length > 3 || servers.some((d) => !IPV4.test(d))) throw new NetworkRefused("A DNS server is not valid");
    dns = servers.join(",");
  }
  const coordinator = hostRef === str(r.pool.master);
  const o = old[1];
  const changed =
    move ||
    str(o.ip_configuration_mode) !== mode ||
    (mode === "Static" && (str(o.IP) !== ip || str(o.netmask) !== netmask || str(o.gateway) !== gateway || str(o.DNS) !== dns));
  if (!changed) throw new NetworkRefused("Nothing changed");
  // XenMan reaches the pool through its coordinator: it has to know where to find it again.
  if (coordinator && mode === "DHCP") {
    throw new NetworkRefused(
      `XenMan reaches the pool through ${hostName} and could not find it again under an address from DHCP. Give it a static address, or change it in XenCenter.`,
    );
  }
  if (typeof input.confirmName !== "string" || input.confirmName.trim().toLowerCase() !== hostName.toLowerCase()) {
    throw new NetworkRefused(`Type the server's name, ${hostName}, to confirm`);
  }
  const nicName = (p: Rec) => (isBondNic(p) ? "the bond" : `NIC ${nicNumber(p)}`) + (vlanOf(p) >= 0 ? ` VLAN ${vlanOf(p)}` : "");
  return {
    hostRef,
    hostName,
    coordinator,
    oldPif: old[0],
    newPif: target,
    oldNic: nicName(o),
    newNic: nicName(t),
    newNetwork: networkLabel(r, netRef),
    move,
    mode,
    ip,
    netmask,
    gateway,
    dns,
    oldIp: str(o.IP),
    newIp: mode === "Static" ? ip : null,
    oldPurpose: Boolean(map(o.other_config).management_purpose),
    newPurpose: Boolean(map(t.other_config).management_purpose),
  };
}
