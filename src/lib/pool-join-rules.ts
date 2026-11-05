// Whether a standalone server may join a pool, as XenCenter decides it
// (XenModel/PoolJoinRules.cs, CanJoinPool and ReasonMessage; AddNewHostToPoolCommand
// for a server that is in a pool already). XenCenter offers to license the
// server, mask its CPU or configure AD first; XenMan does not -- those cases are
// refused with their reason (allowLicenseUpgrade = allowSupporterAdConfig = false).
// Besides: whether the pool's CPU features would go down (HelpersGUI.
// GetPermissionForCpuFeatureLevelling), a question to answer, not a reason.

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

const NULL = "OpaqueRef:NULL";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Rec).map(([k, x]) => [k, String(x)])) : {};
const refs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== NULL) : []);

/** What one side (the joining server, or the pool) looks like. */
export interface JoinSide {
  pools: Recs;
  hosts: Recs;
  srs?: Recs;
  vms?: Recs;
  pifs?: Recs;
  clusters?: Recs;
  clusterHosts?: Recs;
  bonds?: Recs;
  vlans?: Recs;
  updates?: Recs;
}

export interface JoinVerdict {
  /** The joining server's name. */
  name: string;
  /** XenCenter's reason when it may not join (the first that applies), else null. */
  reason: string | null;
  /** XenCenter's question about CPU features, when there is one. */
  cpuQuestion: string | null;
  /** host uuid of the joining server, to find it in the pool afterwards. */
  uuid: string;
}

// Host.BoolKeyPreferTrue: restricted unless the key says "false".
const preferTrue = (lp: Record<string, string>, key: string) => (lp[key] ?? "true").toLowerCase() !== "false";
const boolKey = (lp: Record<string, string>, key: string) => (lp[key] ?? "").toLowerCase() === "true";

// Host.IsFreeLicense / GetEdition.
const isFree = (h: Rec) => ["free", "express", "trial"].includes(str(h.edition));
function edition(e: string): string {
  switch (e) {
    case "enterprise-per-socket":
    case "premium-per-socket":
      return "EnterprisePerSocket";
    case "enterprise-per-user":
    case "premium-per-user":
      return "EnterprisePerUser";
    case "xendesktop":
    case "per-socket":
    case "standard-per-socket":
    case "desktop":
    case "desktop-plus":
    case "desktop-cloud":
    case "premium":
    case "standard":
      return e;
    default:
      return "Free";
  }
}

// PoolJoinRules.FewerFeatures on two hex feature strings.
function fewerFeatures(a: string, b: string): boolean {
  if (!a || !b) return false;
  let x = a.replace(/[ -]/g, "");
  let y = b.replace(/[ -]/g, "");
  if (x.length < y.length) x = x.padEnd(y.length, "0");
  if (y.length < x.length) y = y.padEnd(x.length, "0");
  for (let i = 0; i < Math.floor(x.length / 8); i++) {
    const ia = parseInt(x.slice(8 * i, 8 * i + 8), 16) >>> 0;
    const ib = parseInt(y.slice(8 * i, 8 * i + 8), 16) >>> 0;
    if (((ia & ib) >>> 0) !== ib) return true;
  }
  return false;
}
function fewerFeatureSet(a: Record<string, string>, b: Record<string, string>): boolean {
  if ("features_hvm" in a && "features_hvm" in b && fewerFeatures(a.features_hvm, b.features_hvm)) return true;
  if ("features_pv" in a && "features_pv" in b && fewerFeatures(a.features_pv, b.features_pv)) return true;
  return false;
}

/** The single host of a standalone server's connection (its coordinator). */
function coordinatorOf(side: JoinSide): [string, Rec] | null {
  const master = str(Object.values(side.pools)[0]?.master);
  const rec = side.hosts[master];
  return rec ? [master, rec] : null;
}

export function canJoinPool(joiner: JoinSide, target: JoinSide, poolName: string): JoinVerdict {
  const j = coordinatorOf(joiner);
  const c = coordinatorOf(target);
  const name = j ? str(j[1].name_label) : "";
  const uuid = j ? str(j[1].uuid) : "";
  const verdict = (reason: string | null, cpuQuestion: string | null = null): JoinVerdict => ({ name, reason, cpuQuestion, uuid });
  if (!j) return verdict("Connecting...");
  if (!c) return verdict("The coordinator is not connected");
  const [, sup] = j;
  const [, coord] = c;
  const supLp = obj(sup.license_params);
  const supSw = obj(sup.software_version);
  const coordSw = obj(coord.software_version);
  const joinerPool = Object.values(joiner.pools)[0] ?? {};
  const targetPool = Object.values(target.pools)[0] ?? {};

  // AddNewHostToPoolCommand: a server that is in a pool (Pool.IsVisible: named, or more than one host).
  const joinerHostCount = Object.keys(joiner.hosts).length;
  if (str(joinerPool.name_label) !== "" || joinerHostCount > 1) {
    const other = str(joinerPool.name_label) || name;
    return verdict(`Cannot add server ${name} to pool ${poolName}: server is already in pool ${other}.`);
  }
  // WillBeCoordinator: the same server.
  if (Object.values(target.hosts).some((h) => str(h.uuid) === uuid)) return verdict(`Cannot add server ${name} to pool ${poolName}: server is already in pool ${poolName}.`);

  if (preferTrue(supLp, "restrict_pooling")) return verdict("Pooling is restricted with this server's license");
  // CompatibleCPUs: as of Dundee, the same vendor is enough (feature levelling).
  const supCpu = obj(sup.cpu_info);
  const coordCpu = obj(coord.cpu_info);
  if (supCpu.vendor !== undefined && coordCpu.vendor !== undefined && supCpu.vendor !== coordCpu.vendor) {
    return verdict("This server's hardware is incompatible with the coordinator's");
  }
  // DifferentServerVersion.
  if (
    str(sup.API_version_major) !== str(coord.API_version_major) ||
    str(sup.API_version_minor) !== str(coord.API_version_minor) ||
    !supSw.db_schema ||
    !coordSw.db_schema ||
    supSw.db_schema !== coordSw.db_schema ||
    supSw.platform_version !== coordSw.platform_version ||
    supSw.product_brand !== coordSw.product_brand
  ) {
    return verdict("This server is a different version to the coordinator");
  }
  // DifferentHomogeneousUpdates: the updates that must be the same on every server.
  const homogeneous = (side: JoinSide, h: Rec) =>
    refs(h.updates)
      .map((r) => side.updates?.[r])
      .filter((u): u is Rec => Boolean(u) && u!.enforce_homogeneity === true)
      .map((u) => str(u.uuid))
      .sort();
  const cu = homogeneous(target, coord);
  const su = homogeneous(joiner, sup);
  if (cu.length !== su.length || cu.some((u) => !su.includes(u))) {
    return verdict(
      Object.keys(target.hosts).length > 1
        ? "This server has different updates from servers already in the pool"
        : "This server has different updates from the coordinator",
    );
  }
  // Licences (no upgrade offered: refused).
  if (isFree(sup) && !isFree(coord)) return verdict("You cannot add an unlicensed server to a licensed pool");
  if (!isFree(sup) && isFree(coord)) return verdict("You cannot add a licensed server to an unlicensed pool");
  const se = edition(str(sup.edition));
  const ce = edition(str(coord.edition));
  if (se !== "Free" && ce !== "Free" && se !== ce) return verdict("This server does not have the same license as the pool coordinator");
  const poolSizeRestricted = Object.values(target.hosts).some((h) => boolKey(obj(h.license_params), "restrict_pool_size"));
  const hostCount = Object.keys(target.hosts).length;
  if (poolSizeRestricted && hostCount > 2) return verdict("The pool has already reached the maximum number of servers allowed by your license.");
  if (poolSizeRestricted && hostCount + 1 > 3) return verdict("The pool will exceed the maximum number of servers allowed by your license.");
  // SameLinuxPack.
  if ("xs:linux" in supSw !== "xs:linux" in coordSw) return verdict("This server's Linux pack installation state differs from that of the coordinator");
  // HasSharedStorage (the tools SR does not count).
  const shared = Object.values(joiner.srs ?? {}).some(
    (sr) => sr.shared === true && !(sr.is_tools_sr === true || str(sr.name_label) === "XenServer Tools"),
  );
  if (shared) return verdict("This server has shared storage");
  // HasRunningVMs (IsRealVm).
  const running = Object.values(joiner.vms ?? {}).some(
    (vm) => vm.is_a_template !== true && vm.is_a_snapshot !== true && vm.is_control_domain !== true && vm.power_state === "Running",
  );
  if (running) return verdict("This server has running VMs");
  // DifferentNetworkBackends.
  if (supSw.network_backend && coordSw.network_backend && supSw.network_backend !== coordSw.network_backend) {
    return verdict("This server's network backend is different from the coordinator's");
  }
  // CompatibleAdConfig (no AD set up for it: refused).
  if (str(sup.external_auth_type) !== str(coord.external_auth_type) || str(sup.external_auth_service_name) !== str(coord.external_auth_service_name)) {
    return verdict("This server has a different Active Directory configuration to the coordinator");
  }
  if (targetPool.ha_enabled === true) return verdict("HA is enabled on the pool");
  // The management interface: only physical NICs, or one VLAN that is the management one.
  const pifs = Object.values(joiner.pifs ?? {});
  const nonPhysical = pifs.filter((p) => p.physical !== true);
  if (preferTrue(supLp, "restrict_management_on_vlan")) {
    if (nonPhysical.length) return verdict("This server must not have any bonds, VLANs or cross-server private networks");
  } else if (nonPhysical.length && !(nonPhysical.length === 1 && nonPhysical[0].management === true && Number(nonPhysical[0].VLAN) !== -1)) {
    return verdict("This server must not have any bonds, non management VLANs, SR-IOV networks or cross-server private networks");
  }
  if (Object.keys(joiner.clusters ?? {}).length) return verdict("Clustering is enabled on this server.");
  // HasIpForClusterNetwork: with clustering in the pool, one IP on the cluster network's NIC(s).
  const clusterHost = Object.values(target.clusterHosts ?? {})[0];
  if (clusterHost) {
    let pif = target.pifs?.[str(clusterHost.PIF)];
    if (pif && Number(pif.VLAN) >= 0) {
      const vlan = target.vlans?.[str(pif.VLAN_master_of)];
      const tagged = vlan ? target.pifs?.[str(vlan.tagged_PIF)] : undefined;
      if (tagged) pif = tagged;
    }
    if (pif) {
      const inBond = refs(pif.bond_master_of).length > 0;
      const devices = inBond
        ? refs(pif.bond_master_of).flatMap((b) => refs(target.bonds?.[b]?.slaves).map((s) => str(target.pifs?.[s]?.device)))
        : [str(pif.device)];
      // PIF.IsManagementInterface(false): the management one, or one with an address.
      const withIp = pifs.filter(
        (p) => (p.management === true || (str(p.ip_configuration_mode) !== "None" && str(p.ip_configuration_mode) !== "")) && devices.includes(str(p.device)),
      ).length;
      if (withIp !== 1) {
        return verdict(
          inBond
            ? "This server needs to have an IP address assigned to one (and only one) of the interfaces that will be part of the bonded cluster network."
            : "This server needs to have one (and only one) IP address on the network that will be used for clustering.",
        );
      }
    }
  }
  // Certificate verification on one side only.
  const onPool = targetPool.tls_verification_enabled === true;
  const onJoiner = joinerPool.tls_verification_enabled === true;
  if (onPool && !onJoiner) {
    return verdict("Certificate verification is enabled on the pool, but not on this server. To add the server to the pool, first enable certificate verification on the server.");
  }
  if (!onPool && onJoiner) {
    return verdict("Certificate verification is enabled on this server, but not on the pool. To add the server to the pool, first enable certificate verification on the pool.");
  }

  // GetPermissionForCpuFeatureLevelling: the server's CPU features against the pool's.
  const poolCpu = obj(targetPool.cpu_info);
  const fewer = fewerFeatureSet(supCpu, poolCpu);
  const more = fewerFeatureSet(poolCpu, supCpu);
  let cpuQuestion: string | null = null;
  if (fewer && more) {
    cpuQuestion = `You are attempting to add the server '${name}' to a pool that is using different CPUs.\n\nVMs starting on the pool in future will only use the reduced set of CPU features common to all the servers in the pool. VMs already running in the pool will not be able to migrate to the new server until they are restarted.`;
  } else if (fewer) {
    cpuQuestion = `You are attempting to add the server '${name}' to a pool that is using newer CPUs.\n\nVMs starting on the pool in future will only use the reduced set of CPU features common to all the servers in the pool. VMs already running in the pool will not be able to migrate to the new server until they are restarted.`;
  } else if (more) {
    cpuQuestion = `You are attempting to add the server '${name}' to a pool that is using older CPUs.\n\nVMs running in the pool will only use the CPU features common to all the servers in the pool.`;
  }
  return verdict(null, cpuQuestion);
}
