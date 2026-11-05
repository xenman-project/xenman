// A pool's networking as XenCenter's Networking tab shows it: the networks with
// NIC, VLAN, Auto, Link Status, MAC, MTU and SR-IOV, and the interfaces that
// carry an IP address. Built from the raw records only -- no XAPI calls -- so
// that every rule below can be checked against XenCenter's own (xenadmin:
// XenModel/XenAPI-Extensions/Network.cs and PIF.cs, Utils/Helpers.cs,
// XenAdmin/Controls/NetworkingTab/NetworkList.cs).

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

export interface NetworkRow {
  ref: string;
  uuid: string;
  name: string;
  description: string;
  /** "NIC 4", "Bond 0+1"; "" for a network with no PIF here (single-server private). */
  nic: string;
  /** "-" without one. */
  vlan: string;
  auto: boolean;
  /** "Connected", "Disconnected", "Unknown", "Partially connected", "<None>". */
  linkStatus: string;
  /** Physical PIFs only, "-" otherwise. */
  mac: string;
  mtu: number;
  /** "Yes", "No", or "Yes (Host needs reboot)". */
  sriov: string;
  /** What kind of network this is here, for the properties and what may be changed. */
  kind: "physical" | "bond" | "vlan" | "sriov" | "internal";
  /** The PIF shown (this host's, or the coordinator's in the pool view). */
  pifRef: string | null;
  /** Carries the primary management interface somewhere in the pool. */
  management: boolean;
  bridge: string;
  folder: string;
  tags: string[];
  /** XenCenter's custom fields (other_config XenCenter.CustomFields.<name>). */
  customFields: Record<string, string>;
  /** Bond mode of the bond this network sits on (bonds only). */
  bondMode: string | null;
  /** With LACP: "src_mac" or "tcpudp_ports". */
  hashing: string | null;
  vifCount: number;
  /** The VMs' interfaces on it (for which VMs are attached). */
  vifs: string[];
  /** An interface with an IP address on it anywhere in the pool ("Management", "xs-01_NFS"). */
  ipInterface: string | null;
  /** The device of the coordinator's PIF ("bond1"), for the NIC in the properties. */
  device: string;
}

export interface InterfaceRow {
  pifRef: string;
  hostRef: string;
  /** XenCenter's "Server" column. */
  server: string;
  /** "Management", the secondary interface's name, or "Unknown". */
  interface: string;
  network: string;
  networkRef: string;
  nic: string;
  /** "Static", "DHCP". */
  ipSetup: string;
  ip: string;
  netmask: string;
  gateway: string;
  dns: string;
  management: boolean;
}

export interface NicRow {
  pifRef: string;
  hostRef: string;
  nic: string;
  device: string;
  mac: string;
  linkStatus: string;
  speed: string;
  duplex: string;
  vendor: string;
  deviceName: string;
  pciBusPath: string;
  /** A member of a bond already. */
  bonded: boolean;
  /** A bond interface itself. */
  isBond: boolean;
  sriovCapable: boolean;
  networkRef: string;
  mtu: number;
  /** VLAN tags already on this device somewhere in the pool (NetWDetails.GetVLANList). */
  vlans: number[];
  /** The bond it is in ("Bond 0+1"), as BondDetails says "already in". */
  bond: string | null;
  /** The primary management interface is on it. */
  management: boolean;
  /** A secondary interface with an address is on it (its name). */
  secondary: string | null;
  /** SR-IOV is enabled on it (it has an SR-IOV network). */
  sriovEnabled: boolean;
  /** VLAN tags already on its SR-IOV network, counted apart (NetWDetails.GetVLANList). */
  sriovVlans: number[];
}

export interface HostNetworking {
  networks: NetworkRow[];
  interfaces: InterfaceRow[];
  /** The physical NICs (and bonds) of the host, or of the coordinator in the pool view. */
  nics: NicRow[];
  haEnabled: boolean;
  /** vSwitch backend: LACP bonds and four NICs per bond (Helpers.SupportsLinkAggregationBond). */
  vswitch: boolean;
  /** What a bond change is confirmed with: the pool's name, or the coordinator's. */
  confirmName: string;
  /** The licence allows SR-IOV networks on every server (Host.RestrictSriovNetwork). */
  sriovLicensed: boolean;
  /** The licence allows the management interface on a VLAN (Host.RestrictManagementOnVLAN). */
  managementOnVlan: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const refs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "OpaqueRef:NULL") : []);
const map = (v: unknown): Record<string, string> => (v && typeof v === "object" ? (v as Record<string, string>) : {});
const NULL = "OpaqueRef:NULL";

export function buildHostNetworking(
  raw: {
    networks: Recs;
    pifs: Recs;
    pifMetrics: Recs;
    bonds: Recs;
    vlans: Recs;
    sriovs: Recs;
    hosts: Recs;
    pool: Rec;
  },
  /** One host, or the pool as a whole (XenCenter's pool Networking tab). */
  hostRef: string | null,
): HostNetworking {
  const { networks, pifs, pifMetrics, bonds, vlans, sriovs, hosts, pool } = raw;
  const coordinator = str(pool.master);
  const pifOf = (ref: string) => pifs[ref];
  const vlanOf = (p: Rec) => Number(p.VLAN ?? -1);
  const isSriovLogical = (p: Rec) => refs(p.sriov_logical_PIF_of).length > 0;
  const isPhysical = (p: Rec) => vlanOf(p) === -1 && refs(p.tunnel_access_PIF_of).length === 0 && !isSriovLogical(p);
  // PIF.Show(): managed by XAPI, and not hidden from XenCenter.
  const pifShown = (p: Rec) => p.managed !== false && (map(p.other_config).HideFromXenCenter ?? "").toLowerCase() !== "true";
  const bondMemberOf = (p: Rec) => {
    const b = str(p.bond_slave_of);
    return b && b !== NULL ? bonds[b] ?? null : null;
  };

  // "NIC 4", "Bond 0+1"; a VLAN or SR-IOV PIF by the PIF it sits on (PIF.Name()).
  const pifName = (ref: string, depth = 0): string => {
    const p = pifOf(ref);
    if (!p || depth > 3) return "";
    if (isPhysical(p)) {
      const masterOf = refs(p.bond_master_of);
      if (!masterOf.length) return `NIC ${str(p.device).replace("eth", "")}`;
      const members = masterOf.flatMap((b) => refs(bonds[b]?.slaves)).map((s) => str(pifOf(s)?.device).replace("eth", ""));
      return `Bond ${members.sort().join("+")}`;
    }
    if (isSriovLogical(p)) {
      const sriov = sriovs[refs(p.sriov_logical_PIF_of)[0]];
      return sriov ? pifName(str(sriov.physical_PIF), depth + 1) : "";
    }
    const vlan = vlans[str(p.VLAN_master_of)];
    return vlan ? pifName(str(vlan.tagged_PIF), depth + 1) : "";
  };

  // NICIdentifier(): "4" for eth4, "0+1" for a bond of eth0 and eth1.
  const nicId = (ref: string): string => {
    const p = pifOf(ref);
    if (!p) return "";
    const masterOf = refs(p.bond_master_of);
    if (!masterOf.length) return str(p.device).replace("eth", "");
    return masterOf
      .flatMap((b) => refs(bonds[b]?.slaves))
      .map((m) => str(pifOf(m)?.device).replace("eth", ""))
      .sort()
      .join("+");
  };

  // Network.Name(): a name XenServer gave by default ("Pool-wide network
  // associated with eth4") reads "Network 4" -- or "Network 2+3 on VLAN 2232" --
  // after the coordinator's PIF, else the first one. A name someone chose stays.
  const networkName = (n: Rec): string => {
    const label = str(n.name_label);
    if (!label.startsWith("Network associated with ") && !label.startsWith("Pool-wide network associated with ")) return label;
    const pifRefs = refs(n.PIFs).filter((r) => pifOf(r));
    const pick = pifRefs.find((r) => str(pifOf(r)!.host) === coordinator) ?? pifRefs[0];
    if (!pick) return label;
    const p = pifOf(pick)!;
    return vlanOf(p) >= 0 ? `Network ${nicId(pick)} on VLAN ${vlanOf(p)}` : `Network ${nicId(pick)}`;
  };

  type Link = "Connected" | "Disconnected" | "Unknown";
  const linkState = (p: Rec): Link => {
    const metrics = pifMetrics[str(p.metrics)];
    if (isSriovLogical(p) || vlanOf(p) >= 0) {
      const sriovRef = isSriovLogical(p) ? refs(p.sriov_logical_PIF_of)[0] : "";
      if (!sriovRef && vlanOf(p) < 0) return "Disconnected";
      if (sriovRef) {
        const s = sriovs[sriovRef];
        if (!metrics) return "Unknown";
        if (!metrics.carrier || !s || str(s.configuration_mode) === "unknown" || s.requires_reboot === true) return "Disconnected";
      }
    }
    if (!metrics) return "Unknown";
    return metrics.carrier ? "Connected" : "Disconnected";
  };
  const networkLink = (pifRefs: string[]): string => {
    if (!pifRefs.length) return "<None>";
    const states = pifRefs.map((r) => (pifOf(r) ? linkState(pifOf(r)!) : "Unknown"));
    const c = states.includes("Connected"), d = states.includes("Disconnected"), u = states.includes("Unknown");
    if (c) return d || u ? "Partially connected" : "Connected";
    if (d) return u ? "Unknown" : "Disconnected";
    return "Unknown";
  };

  const sriovText = (p: Rec | undefined): string => {
    if (!p || !isSriovLogical(p)) return "No";
    const s = sriovs[refs(p.sriov_logical_PIF_of)[0]];
    if (!s) return "No";
    return s.requires_reboot === true ? "Yes (Host needs reboot)" : "Yes";
  };

  const rows: NetworkRow[] = [];
  for (const [ref, n] of Object.entries(networks)) {
    const oc = map(n.other_config);
    const netPifs = refs(n.PIFs).filter((r) => pifOf(r));
    // Network.Show(): the guest installer network, hidden ones and bond members' networks stay out.
    if (oc.is_guest_installer_network === "true") continue;
    if ((oc.HideFromXenCenter ?? "").toLowerCase() === "true") continue;
    if (netPifs.some((r) => bondMemberOf(pifOf(r)!))) continue;
    // Network.ShowAllPifs: one PIF XAPI does not manage, or a hidden one, hides the whole network.
    if (netPifs.some((r) => !pifShown(pifOf(r)!))) continue;
    // Network.CreateInProgress(): a bond XenCenter (or XenMan) is still building.
    if (oc.XenCenterCreateInProgress === "true") continue;

    // The PIF this view shows: the host's own, or in the pool view the coordinator's.
    const here = hostRef
      ? netPifs.find((r) => str(pifOf(r)!.host) === hostRef)
      : netPifs.find((r) => str(pifOf(r)!.host) === coordinator) ?? netPifs[0];
    // On a host: only networks that reach it, and the ones that need no NIC at all.
    if (hostRef && netPifs.length && !here) continue;
    const p = here ? pifOf(here) : undefined;
    const kind: NetworkRow["kind"] = !p
      ? "internal"
      : isSriovLogical(p)
        ? "sriov"
        : vlanOf(p) >= 0
          ? "vlan"
          : refs(p.bond_master_of).length
            ? "bond"
            : "physical";
    const bond = p && refs(p.bond_master_of).length ? bonds[refs(p.bond_master_of)[0]] : undefined;
    rows.push({
      ref,
      uuid: str(n.uuid),
      name: networkName(n),
      description: str(n.name_description),
      nic: here ? pifName(here) : "",
      vlan: p && vlanOf(p) !== -1 ? String(vlanOf(p)) : "-",
      // Yes only for automatic=true: the XenCenter in use shows "No" for a
      // network without the key (seen on a pool's "Network 4" with an empty
      // other_config), though the published xenadmin source reads it as true.
      auto: oc.automatic === "true",
      linkStatus: hostRef ? (p ? linkState(p) : "<None>") : networkLink(netPifs),
      mac: p && isPhysical(p) ? str(p.MAC) : "-",
      mtu: Number(n.MTU ?? 1500),
      sriov: sriovText(p),
      kind,
      pifRef: here ?? null,
      management: netPifs.some((r) => pifOf(r)!.management === true),
      bridge: str(n.bridge),
      folder: oc.folder ?? "",
      tags: Array.isArray(n.tags) ? (n.tags as string[]) : [],
      customFields: Object.fromEntries(
        Object.entries(oc)
          .filter(([k]) => k.startsWith("XenCenter.CustomFields."))
          .map(([k, v]) => [k.slice("XenCenter.CustomFields.".length), v]),
      ),
      bondMode: bond ? str(bond.mode) : null,
      hashing: bond ? (map(bond.properties).hashing_algorithm ?? null) : null,
      vifCount: refs(n.VIFs).length,
      vifs: refs(n.VIFs),
      ipInterface: (() => {
        const ip = netPifs.map((r) => pifOf(r)!).find((q) => q.management === true || !["", "None"].includes(str(q.ip_configuration_mode)));
        return ip ? (ip.management === true ? "Management" : map(ip.other_config).management_purpose || "Unknown") : null;
      })(),
      device: p ? str(p.device) : "",
    });
  }
  // XenCenter sorts the list by NIC.
  rows.sort((a, b) => a.nic.localeCompare(b.nic, undefined, { numeric: true }) || a.name.localeCompare(b.name));

  // Interfaces with an IP address (PIF.IsManagementInterface): the primary
  // management interface first, then the secondary ones.
  const interfaces: InterfaceRow[] = Object.entries(pifs)
    .filter(([, p]) => (!hostRef || str(p.host) === hostRef) && (p.management === true || (str(p.ip_configuration_mode) !== "None" && str(p.ip_configuration_mode) !== "")))
    .map(([ref, p]) => {
      const purpose = map(p.other_config).management_purpose ?? "";
      const net = networks[str(p.network)];
      const mode = str(p.ip_configuration_mode);
      return {
        pifRef: ref,
        hostRef: str(p.host),
        server: str(hosts[str(p.host)]?.name_label),
        interface: p.management === true ? "Management" : purpose || "Unknown",
        network: net ? networkName(net) : "",
        networkRef: str(p.network),
        nic: pifName(ref),
        ipSetup: mode === "DHCP" ? "DHCP" : mode === "Static" ? "Static" : mode,
        ip: str(p.IP),
        netmask: str(p.netmask),
        gateway: str(p.gateway),
        dns: str(p.DNS),
        management: p.management === true,
      };
    })
    .sort((a, b) => a.server.localeCompare(b.server) || Number(b.management) - Number(a.management) || a.interface.localeCompare(b.interface));

  // NICs for the bond and SR-IOV pages: the host's physical PIFs and bonds.
  const nicHost = hostRef ?? coordinator;
  const nics: NicRow[] = Object.entries(pifs)
    .filter(([, p]) => str(p.host) === nicHost && isPhysical(p) && pifShown(p))
    .map(([ref, p]) => {
      const m = pifMetrics[str(p.metrics)] ?? {};
      return {
        pifRef: ref,
        hostRef: nicHost,
        nic: pifName(ref),
        device: str(p.device),
        mac: str(p.MAC),
        linkStatus: linkState(p),
        speed: m.speed ? `${m.speed} Mbit/s` : "",
        duplex: m.duplex === true ? "Full" : m.duplex === false ? "Half" : "",
        vendor: str(m.vendor_name),
        deviceName: str(m.device_name),
        pciBusPath: str(m.pci_bus_path),
        bonded: Boolean(bondMemberOf(p)),
        isBond: refs(p.bond_master_of).length > 0,
        sriovCapable: Array.isArray(p.capabilities) && (p.capabilities as string[]).includes("sriov"),
        networkRef: str(p.network),
        mtu: Number(p.MTU ?? 1500),
        vlans: [
          ...new Set(
            Object.values(pifs)
              .filter((q) => str(q.device) === str(p.device) && vlanOf(q) >= 0 && !isSriovLogical(pifs[str(vlans[str(q.VLAN_master_of)]?.tagged_PIF)] ?? {}))
              .map(vlanOf),
          ),
        ].sort((a, b) => a - b),
        bond: (() => {
          const b = bondMemberOf(p);
          return b ? pifName(str(b.master)) : null;
        })(),
        sriovEnabled: refs(p.sriov_physical_PIF_of).length > 0,
        sriovVlans: [
          ...new Set(
            Object.values(pifs)
              .filter((q) => str(q.device) === str(p.device) && vlanOf(q) >= 0 && isSriovLogical(pifs[str(vlans[str(q.VLAN_master_of)]?.tagged_PIF)] ?? {}))
              .map(vlanOf),
          ),
        ].sort((a, b) => a - b),
        management: p.management === true,
        secondary: p.management !== true && !["", "None"].includes(str(p.ip_configuration_mode)) ? map(p.other_config).management_purpose || "Unknown" : null,
      };
    })
    .sort((a, b) => a.nic.localeCompare(b.nic, undefined, { numeric: true }));

  return {
    networks: rows,
    interfaces,
    nics,
    haEnabled: pool.ha_enabled === true,
    vswitch: map(hosts[coordinator]?.software_version).network_backend === "openvswitch",
    confirmName: str(pool.name_label) || str(hosts[coordinator]?.name_label),
    sriovLicensed: Object.values(hosts).every((h) => map(h.license_params).restrict_network_sriov === "false"),
    managementOnVlan: Object.values(hosts).every((h) => map(h.license_params).restrict_management_on_vlan === "false"),
  };
}
