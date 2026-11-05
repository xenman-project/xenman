// A pool's memory as XenCenter's Memory tab shows it for a pool: one row per
// live host with a bar -- Xen, the control domain, each resident VM, the rest
// free -- and its figures. Rules after xenadmin (TabPages/BallooningPage.cs,
// Controls/Ballooning/HostMemoryControls.cs and HostShinyBar.cs,
// XenAPI-Extensions/Host.cs: memory_free_calc, xen_memory_calc,
// memory_available_calc, tot_dyn_min/max, dom0_memory; VM.SupportsBallooning).

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

const NULL = "OpaqueRef:NULL";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const refs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== NULL) : []);
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export interface MemorySegment {
  vmRef: string;
  name: string;
  /** VM_metrics.memory_actual. */
  bytes: number;
  /** Set when the VM balloons (XenCenter's tooltip then adds these). */
  dynamicMin?: number;
  dynamicMax?: number;
  /** Only when it differs from the dynamic maximum. */
  staticMax?: number;
}

export interface HostMemory {
  hostRef: string;
  hostName: string;
  total: number;
  /** "Currently used": total less free. */
  used: number;
  /** "Available memory": what is left with every ballooning VM at its minimum. */
  available: number;
  /** "Total max memory": every VM at its maximum, plus Xen. */
  totalMax: number;
  /** "(n% of total memory)". */
  overcommit: number;
  /** "Control domain memory". */
  dom0: number;
  /** The bar's first segment: Xen and the overheads, without the control domain. */
  xen: number;
  vms: MemorySegment[];
  /** ControlDomainMemoryDialog: what the spinner starts at and may reach. */
  controlDomain: ControlDomainMemory | null;
  /** Host.MaintenanceMode (other_config MAINTENANCE_MODE). */
  maintenance: boolean;
}

/** XenCenter's Control Domain Memory Settings for one host. */
export interface ControlDomainMemory {
  vmRef: string;
  /** The spinner's value: the control domain's dynamic minimum. */
  dynamicMin: number;
  /** Lower bound: its static minimum. */
  staticMin: number;
  /** Upper bound: dynamic minimum plus the host's available memory, at most 256 GiB. */
  max: number;
}

/** ControlDomainMemoryDialog.MAXIMUM_DOM0_MEMORY_GB. */
export const MAX_DOM0_MEMORY = 256 * 1024 ** 3;

/** What XenCenter's "Edit..." knows of a VM (VMMemoryControlsEdit, VMMemoryControlsBasic). */
export interface VmMemoryEditVm {
  ref: string;
  name: string;
  power: string;
  dynamicMin: number;
  /** VM.GetVirtualizationStatus: I/O drivers in, none, or not known yet. */
  tools: "io" | "none" | "unknown";
  /** VM.HasNewVirtualizationStates (a Windows VM). */
  windows: boolean;
  /** VM.MaxMemAllowed: the template restriction "memory-static-max", else 1 TiB. */
  maxMemAllowed: number;
  /** HVM_boot_policy set: memory-ratio-hvm applies, else memory-ratio-pv. */
  hvm: boolean;
}

/** A host's VMs with the same memory settings and power state (BallooningPage's MemSettings). */
export interface VmMemoryRow {
  vms: VmMemoryEditVm[];
  power: string;
  /** VM.SupportsBallooning of the first: then minimum and maximum, else "Memory" (the static maximum). */
  ballooning: boolean;
  /** VMShinyBar: the average memory_actual of those running or paused. */
  used: number;
  staticMin: number;
  staticMax: number;
  dynamicMin: number;
  dynamicMax: number;
  /** VMMemoryControlsNoEdit: "Edit..." for halted VMs, or running ones whose tools status is known. */
  editable: boolean;
  /** VM.UsesBallooning of the first (dynamic max below static max, with ballooning). */
  usesBallooning: boolean;
}

/** The pool's side of "Edit...": the licence, the ratios, and for running VMs their host's memory. */
export interface MemoryEditContext {
  /** Host.RestrictDMC on any host: no memory ranges. */
  dmcRestricted: boolean;
  /** pool other_config memory-ratio-hvm / -pv, 0.25 when absent or nonsensical. */
  ratioHvm: number;
  ratioPv: number;
  /** CalcMaxDynMin: the host's memory, and what is spoken for without the VMs being edited. */
  hostTotal: number;
  /** Overheads, control domain, and every resident VM's dynamic minimum. */
  hostCommitted: number;
}

export interface MemoryOverview {
  hosts: HostMemory[];
  /** For one host only: its VMs, running first, then paused, suspended, halted. */
  vmRows: VmMemoryRow[];
  /** For one host only. */
  edit: MemoryEditContext | null;
}

export interface MemoryInput {
  pools: Recs;
  hosts: Recs;
  hostMetrics: Recs;
  vms: Recs;
  vmMetrics: Recs;
  guestMetrics: Recs;
  /** For one host: where a VM that is not running belongs (VM.Home). */
  vbds?: Recs;
  vdis?: Recs;
  srs?: Recs;
  pbds?: Recs;
}

const POWER_ORDER = ["Running", "Paused", "Suspended", "Halted"];
const GUI_TEMP = "__gui__";
const isTrue = (v: unknown) => String(v).toLowerCase() === "true";

export function buildMemoryOverview(raw: MemoryInput, onlyHost: string | null = null, onlyVm: string | null = null): MemoryOverview {
  const coordinator = str(Object.values(raw.pools)[0]?.master);

  // VM.SupportsBallooning: the VM tools report "feature-balloon".
  const balloons = (vm: Rec) => {
    const other = raw.guestMetrics[str(vm.guest_metrics)]?.other;
    return Boolean(other && typeof other === "object" && "feature-balloon" in (other as Rec));
  };
  const actual = (vm: Rec) => {
    const m = raw.vmMetrics[str(vm.metrics)];
    return m ? num(m.memory_actual) : null;
  };
  const live = (hostRef: string) => hostLive(raw, hostRef);

  const rows: HostMemory[] = [];
  for (const [hostRef, h] of Object.entries(raw.hosts)) {
    if (onlyHost && hostRef !== onlyHost) continue;
    // BallooningPage: hosts without live metrics get no row.
    const metrics = raw.hostMetrics[str(h.metrics)];
    if (!live(hostRef)) continue;
    const total = num(metrics.memory_total);
    const resident = refs(h.resident_VMs)
      .map((ref) => [ref, raw.vms[ref]] as const)
      .filter((e): e is readonly [string, Rec] => Boolean(e[1]));

    let used = num(h.memory_overhead);
    let xenMemory = num(h.memory_overhead);
    let totDynMin = 0;
    let totDynMax = 0;
    for (const [, vm] of resident) {
      const overhead = num(vm.memory_overhead);
      const mem = actual(vm);
      used += overhead + (mem ?? 0);
      xenMemory += overhead;
      if (vm.is_control_domain === true) {
        xenMemory += mem ?? 0;
      } else {
        const b = balloons(vm);
        totDynMin += b ? num(vm.memory_dynamic_min) : num(vm.memory_static_max);
        totDynMax += b ? num(vm.memory_dynamic_max) : num(vm.memory_static_max);
      }
    }
    const free = total > used ? total - used : 0;

    // dom0_memory: the control domain of domain 0 (host.control_domain, else by domid).
    const dom0Ref = str(h.control_domain) && h.control_domain !== NULL
      ? str(h.control_domain)
      : resident.find(([, vm]) => vm.is_control_domain === true && num(vm.domid) === 0)?.[0];
    const dom0Vm = dom0Ref ? raw.vms[dom0Ref] : undefined;
    const dom0 = dom0Vm ? actual(dom0Vm) ?? num(dom0Vm.memory_dynamic_min) : 0;

    const totalMax = totDynMax + xenMemory;
    const vms: MemorySegment[] = resident
      .filter(([, vm]) => vm.is_control_domain !== true && actual(vm) !== null)
      .sort(([, a], [, b]) => natural(str(a.name_label), str(b.name_label)))
      .map(([vmRef, vm]) => {
        const seg: MemorySegment = { vmRef, name: str(vm.name_label), bytes: actual(vm) ?? 0 };
        if (balloons(vm)) {
          seg.dynamicMin = num(vm.memory_dynamic_min);
          seg.dynamicMax = num(vm.memory_dynamic_max);
          if (num(vm.memory_dynamic_max) !== num(vm.memory_static_max)) seg.staticMax = num(vm.memory_static_max);
        }
        return seg;
      });

    const available = Math.max(0, total - totDynMin - xenMemory);
    // ControlDomainMemoryDialog.Populate: the range never leaves the current value out (CA-40041).
    let controlDomain: ControlDomainMemory | null = null;
    if (dom0Ref && dom0Vm && num(dom0Vm.memory_dynamic_max) >= num(dom0Vm.memory_dynamic_min)) {
      const value = num(dom0Vm.memory_dynamic_min);
      controlDomain = {
        vmRef: dom0Ref,
        dynamicMin: value,
        staticMin: Math.min(num(dom0Vm.memory_static_min), value),
        max: Math.max(Math.min(value + available, MAX_DOM0_MEMORY), value),
      };
    }
    const other = h.other_config && typeof h.other_config === "object" ? (h.other_config as Rec) : {};

    rows.push({
      hostRef,
      hostName: str(h.name_label),
      total,
      used: total - free,
      available,
      totalMax,
      overcommit: total > 0 ? Math.round((totalMax / total) * 100) : 0,
      dom0,
      xen: xenMemory - dom0,
      vms,
      controlDomain,
      maintenance: isTrue(other.MAINTENANCE_MODE),
    });
  }

  // Host.CompareTo: the coordinator first, then by name.
  rows.sort((a, b) =>
    a.hostRef === coordinator ? -1 : b.hostRef === coordinator ? 1 : natural(a.hostName, b.hostName),
  );
  if (onlyVm) {
    // A VM's tab: its row only; CalcMaxDynMin looks at the host it runs on.
    const vm = raw.vms[onlyVm];
    if (!vm) return { hosts: [], vmRows: [], edit: null };
    return { hosts: [], vmRows: vmRowsOf(raw, { vm: onlyVm }, balloons, actual), edit: editContext(raw, str(vm.resident_on), actual) };
  }
  if (!onlyHost) return { hosts: rows, vmRows: [], edit: null };
  return { hosts: rows, vmRows: vmRowsOf(raw, { host: onlyHost }, balloons, actual), edit: editContext(raw, onlyHost, actual) };
}

/** Whether a host's metrics say it is live (Host.IsLive). */
export function hostLive(raw: Pick<MemoryInput, "hosts" | "hostMetrics">, hostRef: string): boolean {
  const metrics = raw.hostMetrics[str(raw.hosts[hostRef]?.metrics)];
  return Boolean(metrics) && metrics.live !== false && metrics.live !== "false";
}

/**
 * VM.Home: where it runs; else the host of its local storage (SR.GetStorageHost:
 * not shared, one PBD; VDI.Show(true)); else its affinity, if that host is live.
 */
export function vmHome(raw: Pick<MemoryInput, "hosts" | "hostMetrics" | "vbds" | "vdis" | "srs" | "pbds">, vm: Rec): string | null {
  if (vm.power_state === "Running") return str(vm.resident_on) || null;
  for (const vbdRef of refs(vm.VBDs)) {
    const vdi = raw.vdis?.[str(raw.vbds?.[vbdRef]?.VDI)];
    if (!vdi) continue;
    const sr = raw.srs?.[str(vdi.SR)];
    const type = str(sr?.type);
    if (str(vdi.name_label).startsWith(GUI_TEMP) || type === "local" || type === "tmpfs" || isTrue(vdi.missing) || vdi.managed === false) continue;
    const pbds = refs(sr?.PBDs);
    if (!sr || isTrue(sr.shared) || pbds.length !== 1) continue;
    const host = str(raw.pbds?.[pbds[0]]?.host);
    if (raw.hosts[host]) return host;
  }
  const affinity = str(vm.affinity);
  return raw.hosts[affinity] && hostLive(raw, affinity) ? affinity : null;
}

/** XAPI's "20261104T10:00:00Z". */
function xapiTime(v: unknown): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(str(v));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

const TIB = 1024 ** 4;

/** BallooningPage for a host (its real, shown VMs whose home it is) or one VM, grouped by settings. */
function vmRowsOf(
  raw: MemoryInput,
  scope: { host?: string; vm?: string },
  balloons: (vm: Rec) => boolean,
  actual: (vm: Rec) => number | null,
): VmMemoryRow[] {
  const home = (vm: Rec) => vmHome(raw, vm);
  const guest = (vm: Rec) => raw.guestMetrics[str(vm.guest_metrics)];
  // VM.IsWindows, for HasNewVirtualizationStates.
  const windows = (vm: Rec) => {
    const os = guest(vm)?.os_version;
    const o = os && typeof os === "object" ? (os as Rec) : {};
    const platform = vm.platform && typeof vm.platform === "object" ? (vm.platform as Rec) : {};
    return /windows/i.test(`${str(o.distro)} ${str(o.name)}`) || isTrue(platform.viridian);
  };
  // VM.GetVirtualizationStatus, as far as "Edit..." asks: not running, or the
  // first two minutes without drivers, is "unknown"; out-of-date drivers count as none.
  const tools = (vm: Rec): VmMemoryEditVm["tools"] => {
    const metrics = raw.vmMetrics[str(vm.metrics)];
    if (vm.power_state !== "Running" || !metrics) return "unknown";
    const gm = guest(vm);
    const recent = Date.now() - xapiTime(metrics.start_time) < 120_000;
    if (windows(vm)) return gm && isTrue(gm.PV_drivers_detected) ? "io" : recent ? "unknown" : "none";
    const version = gm?.PV_drivers_version && typeof gm.PV_drivers_version === "object" ? (gm.PV_drivers_version as Rec) : {};
    if (!gm || !("major" in version)) return recent ? "unknown" : "none";
    return isTrue(gm.PV_drivers_up_to_date) || gm.PV_drivers_up_to_date === undefined ? "io" : "none";
  };
  // VM.MaxMemAllowed: the matching template's restriction, else the largest any template has, at least 1 TiB.
  const restriction = (vm: Rec): number | null => {
    const tag = /<restriction\b[^>]*\bfield="memory-static-max"[^>]*>/.exec(str(vm.recommendations));
    const max = tag && /\bmax="(\d+)"/.exec(tag[0]);
    return max ? Number(max[1]) : null;
  };
  const templates = Object.values(raw.vms).filter((v) => v.is_a_template === true);
  const acrossTemplates = Math.max(TIB, ...templates.map(restriction).filter((n): n is number => n !== null));
  const maxMemAllowed = (vm: Rec) => {
    const label = str(vm.reference_label);
    const matching = label ? templates.find((t) => str(t.reference_label) === label) : undefined;
    return (matching && restriction(matching)) ?? acrossTemplates;
  };

  // A VM's own tab: that VM, as it is (BallooningPage adds it without asking).
  // A host's: VMWanted -- IsRealVm, Show (no "__gui__" objects, not HideFromXenCenter), and at home here.
  const wanted = Object.entries(raw.vms)
    .filter(([ref, vm]) => {
      if (scope.vm) return ref === scope.vm;
      if (vm.is_a_template === true || vm.is_a_snapshot === true || vm.is_control_domain === true) return false;
      if (str(vm.name_label).startsWith(GUI_TEMP)) return false;
      const other = vm.other_config && typeof vm.other_config === "object" ? (vm.other_config as Rec) : {};
      if (isTrue(other.HideFromXenCenter)) return false;
      return home(vm) === scope.host;
    })
    .sort(([ra, a], [rb, b]) => natural(str(a.name_label), str(b.name_label)) || ra.localeCompare(rb));

  // Grouped by settings: with ballooning all four, without it only the static maximum.
  const groups = new Map<string, [string, Rec][]>();
  for (const entry of wanted) {
    const vm = entry[1];
    const key = balloons(vm)
      ? ["b", vm.power_state, vm.memory_static_min, vm.memory_static_max, vm.memory_dynamic_min, vm.memory_dynamic_max].join("|")
      : ["n", vm.power_state, vm.memory_static_max].join("|");
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const rank = (power: string) => (POWER_ORDER.includes(power) ? POWER_ORDER.indexOf(power) : POWER_ORDER.length);
  return [...groups.values()]
    .map((members) => {
      const vm0 = members[0][1];
      const used = members
        .filter(([, vm]) => vm.power_state === "Running" || vm.power_state === "Paused")
        .map(([, vm]) => actual(vm))
        .filter((n): n is number => n !== null);
      const vms: VmMemoryEditVm[] = members.map(([ref, vm]) => ({
        ref,
        name: str(vm.name_label),
        power: str(vm.power_state),
        dynamicMin: num(vm.memory_dynamic_min),
        tools: tools(vm),
        windows: windows(vm),
        maxMemAllowed: maxMemAllowed(vm),
        hvm: str(vm.HVM_boot_policy) !== "",
      }));
      return {
        vms,
        power: str(vm0.power_state),
        ballooning: balloons(vm0),
        used: used.length ? Math.round(used.reduce((a, b) => a + b, 0) / used.length) : 0,
        staticMin: num(vm0.memory_static_min),
        staticMax: num(vm0.memory_static_max),
        dynamicMin: num(vm0.memory_dynamic_min),
        dynamicMax: num(vm0.memory_dynamic_max),
        editable: vms.every((v) => v.power === "Halted" || (v.power === "Running" && v.tools !== "unknown")),
        usesBallooning: balloons(vm0) && num(vm0.memory_dynamic_max) !== num(vm0.memory_static_max),
      };
    })
    .sort((a, b) => rank(a.power) - rank(b.power)); // stable: the order of first appearance within a state
}

/** The pool's licence and ratios, and the host's committed memory (VMMemoryControlsEdit.CalcMaxDynMin). */
function editContext(raw: MemoryInput, hostRef: string, actual: (vm: Rec) => number | null): MemoryEditContext {
  // Host.RestrictDMC is BoolKeyPreferTrue: restricted unless the key says "false".
  const dmcRestricted = Object.values(raw.hosts).some((h) => {
    const lp = h.license_params && typeof h.license_params === "object" ? (h.license_params as Rec) : {};
    return str(lp.restrict_dmc).toLowerCase() !== "false";
  });
  const poolOther = Object.values(raw.pools)[0]?.other_config;
  const other = poolOther && typeof poolOther === "object" ? (poolOther as Rec) : {};
  const ratio = (key: string) => {
    const n = Number(str(other[key]) || NaN);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.25;
  };
  const h = raw.hosts[hostRef] ?? {};
  let committed = num(h.memory_overhead);
  for (const ref of refs(h.resident_VMs)) {
    const vm = raw.vms[ref];
    if (!vm) continue;
    committed += num(vm.memory_overhead) + (vm.is_control_domain === true ? actual(vm) ?? 0 : num(vm.memory_dynamic_min));
  }
  return {
    dmcRestricted,
    ratioHvm: ratio("memory-ratio-hvm"),
    ratioPv: ratio("memory-ratio-pv"),
    hostTotal: num(raw.hostMetrics[str(h.metrics)]?.memory_total),
    hostCommitted: committed,
  };
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

/** Util.MemorySizeStringSuitableUnits, with GiB/MiB as XenCenter now shows them. */
export function memorySize(bytes: number, showPoint0Decimal: boolean): string {
  if (bytes >= GIB) {
    // One decimal up to 100 GiB; "{0:F1}" (30.0) only when asked for, else "{0}" (30, 15.5).
    const gb = bytes / GIB;
    if (gb > 100) return `${Math.round(gb)} GiB`;
    const rounded = Math.round(gb * 10) / 10;
    return `${showPoint0Decimal ? rounded.toFixed(1) : rounded} GiB`;
  }
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MiB`;
  if (bytes >= KIB) return `${Math.round(bytes / KIB)} KiB`;
  return bytes === 0 ? "0" : `${bytes} B`;
}
