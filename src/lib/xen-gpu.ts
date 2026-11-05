// A pool's GPUs as XenCenter's GPU tab shows them: the physical GPUs grouped
// by their settings, each as a bar of its vGPU slots with the VMs in them, and
// the vGPU types they allow; the placement policy above. Rules after xenadmin
// (TabPages/GpuPage.cs, Controls/GPU/GpuRow.cs and GpuShinyBar.cs,
// XenAPI-Extensions/PGPU.cs and VGPU_type.cs). Besides, XenMan's own reckoning:
// what is free per vGPU type, and whether a host's vGPU VMs fit on the others.

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

const NULL = "OpaqueRef:NULL";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const refs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== NULL) : []);
const nums = (v: unknown): Record<string, number> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Rec).map(([k, n]) => [k, Number(n)])) : {};
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export interface GpuVgpu {
  vgpuRef: string;
  vmRef: string;
  /** The type's model name ("NVIDIA A16-1B"), as the bar shows it under the VM. */
  model: string;
  typeRef: string;
}

export interface GpuBar {
  pgpuRef: string;
  /** Slots shown: the capacity of the type in use, or the largest any type allows. */
  slots: number;
  vgpus: GpuVgpu[];
}

export interface GpuRowData {
  /** The GPU's PCI device name ("GA107GL [A2 / A16]"). */
  name: string;
  /** It can be split into vGPUs (PGPU.HasVGpu). */
  vgpuCapable: boolean;
  /** The vGPU types, in XenCenter's order, with whether they are enabled. */
  types: GpuTypeInfo[];
  hosts: { hostRef: string; hostName: string; bars: GpuBar[] }[];
}

/** A vGPU type as GpuConfiguration lists it: name, vGPUs per GPU, video RAM. */
export interface GpuTypeInfo {
  ref: string;
  name: string;
  enabled: boolean;
  /** "Pass-through whole GPU", or the model name ("NVIDIA A16-1B"). */
  label: string;
  /** Virtual GPUs per GPU; null for pass-through. */
  perGpu: number | null;
  /** framebuffer_size in bytes; 0 when not given. */
  videoRam: number;
}

export interface TypeCapacity {
  typeRef: string;
  name: string;
  used: number;
  /** vGPUs of this type that could still be started in the pool now. */
  free: number;
}

export interface HostAway {
  hostRef: string;
  hostName: string;
  /** Its running vGPU VMs per type, and how many of them would find no slot on the other hosts. */
  types: { name: string; vms: number; short: number }[];
}

export interface GpuOverview {
  /** XenCenter's "Placement policy: …" line; null without GPU groups. */
  placement: string | null;
  algorithm: "breadth_first" | "depth_first" | "mixed" | null;
  rows: GpuRowData[];
  /** Several hosts: the rows say "On <host>:". */
  hostLabels: boolean;
  capacity: TypeCapacity[];
  /** Pool view only: each host that runs vGPU VMs, as if it were away. */
  away: HostAway[];
}

const PLACEMENT: Record<string, string> = {
  depth_first: "Maximum density: put as many VMs as possible on the same GPU",
  breadth_first: "Maximum performance: put VMs on as many GPUs as possible",
  mixed: "Mixed: different settings for different GPU groups",
};

export function buildGpuOverview(
  raw: { pgpus: Recs; pcis: Recs; vgpuTypes: Recs; vgpus: Recs; groups: Recs; hosts: Recs },
  /** One host, or the pool as a whole. */
  hostRef: string | null,
): GpuOverview {
  const { pgpus, pcis, vgpuTypes, vgpus, groups, hosts } = raw;
  const isPassthrough = (t: string) => str(vgpuTypes[t]?.model_name) === "passthrough";
  // VGPU_type.Capacity(): from the first PGPU that supports it.
  const capacityOf = (t: string): number => {
    const on = refs(vgpuTypes[t]?.supported_on_PGPUs)[0];
    return on ? (nums(pgpus[on]?.supported_VGPU_max_capacities)[t] ?? 0) : 0;
  };
  // VGPU_type.Name(): "Pass-through whole GPU", or "<model> virtual GPU (<n> per GPU)".
  const typeName = (t: string) =>
    isPassthrough(t) ? "Pass-through whole GPU" : `${str(vgpuTypes[t]?.model_name)} virtual GPU (${capacityOf(t)} per GPU)`;
  // VGPU_type.CompareTo, listed descending as GpuRow does: pass-through first, then fewer per GPU,
  // then the larger resolution, then the name.
  const typeOrder = (a: string, b: string) => {
    if (isPassthrough(a) !== isPassthrough(b)) return isPassthrough(a) ? -1 : 1;
    const ca = capacityOf(a), cb = capacityOf(b);
    if (ca !== cb) return ca - cb;
    const res = (t: string) => Number(vgpuTypes[t]?.max_resolution_x ?? 0) * Number(vgpuTypes[t]?.max_resolution_y ?? 0);
    if (res(a) !== res(b)) return res(b) - res(a);
    return -natural(str(vgpuTypes[a]?.model_name), str(vgpuTypes[b]?.model_name));
  };
  const pgpuName = (p: Rec) => str(pcis[str(p.PCI)]?.device_name) || str(p.uuid);
  const hostName = (h: string) => str(hosts[h]?.name_label) || h;

  // GpuPage.Rebuild: PGPUs that support any vGPU type, of this host or the pool, by host then name.
  const shown = Object.entries(pgpus)
    .filter(([, p]) => refs(p.supported_VGPU_types).length > 0 && (!hostRef || str(p.host) === hostRef))
    .sort(([, a], [, b]) => natural(hostName(str(a.host)), hostName(str(b.host))) || natural(pgpuName(a), pgpuName(b)) || natural(str(pcis[str(a.PCI)]?.pci_id), str(pcis[str(b.PCI)]?.pci_id)));

  // Grouped by settings: the same name, the same supported and enabled types (GpuSettings).
  const rowsByKey = new Map<string, GpuRowData>();
  for (const [ref, p] of shown) {
    const supported = refs(p.supported_VGPU_types);
    const enabled = new Set(refs(p.enabled_VGPU_types));
    const key = JSON.stringify([pgpuName(p), [...supported].sort(), [...enabled].sort()]);
    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        name: pgpuName(p),
        vgpuCapable: supported.some((t) => !isPassthrough(t)),
        types: [...supported].sort(typeOrder).map((t) => ({
          ref: t,
          name: typeName(t),
          enabled: enabled.has(t),
          label: isPassthrough(t) ? "Pass-through whole GPU" : str(vgpuTypes[t]?.model_name),
          perGpu: isPassthrough(t) ? null : capacityOf(t),
          videoRam: Number(vgpuTypes[t]?.framebuffer_size ?? 0) || 0,
        })),
        hosts: [],
      };
      rowsByKey.set(key, row);
    }
    // GpuShinyBar.Initialize: the slots of the type in use, else the most any type allows.
    const caps = nums(p.supported_VGPU_max_capacities);
    const resident = refs(p.resident_VGPUs).filter((v) => vgpus[v]);
    const maxCapacity = row.vgpuCapable ? Math.max(1, ...Object.values(caps)) : 1;
    const inUse = resident.length ? caps[str(vgpus[resident[0]].type)] : undefined;
    const bar: GpuBar = {
      pgpuRef: ref,
      slots: inUse ?? maxCapacity,
      vgpus: resident
        .sort((a, b) => natural(str(vgpus[a].device), str(vgpus[b].device)) || natural(a, b))
        .map((v) => ({ vgpuRef: v, vmRef: str(vgpus[v].VM), model: str(vgpuTypes[str(vgpus[v].type)]?.model_name), typeRef: str(vgpus[v].type) })),
    };
    const h = str(p.host);
    let hostEntry = row.hosts.find((x) => x.hostRef === h);
    if (!hostEntry) row.hosts.push((hostEntry = { hostRef: h, hostName: hostName(h), bars: [] }));
    hostEntry.bars.push(bar);
  }

  // GpuPlacementPolicyPanel: one algorithm for all groups, or "Mixed".
  const algorithms = [...new Set(Object.values(groups).map((g) => str(g.allocation_algorithm)).filter(Boolean))];
  const algorithm = algorithms.length === 0 ? null : algorithms.length === 1 ? (algorithms[0] as "breadth_first" | "depth_first") : "mixed";

  // XenMan: what is left per type. A physical GPU takes one vGPU type at a time: a GPU in use
  // has room for more of its own type only; an empty one for any type enabled on it.
  const pool = Object.entries(pgpus).filter(([, p]) => refs(p.supported_VGPU_types).length > 0);
  const residentOf = (p: Rec) => refs(p.resident_VGPUs).filter((v) => vgpus[v]);
  const roomFor = (p: Rec, t: string): number => {
    const caps = nums(p.supported_VGPU_max_capacities);
    const res = residentOf(p);
    if (!res.length) return refs(p.enabled_VGPU_types).includes(t) ? (caps[t] ?? 0) : 0;
    return res.every((v) => str(vgpus[v].type) === t) ? Math.max(0, (caps[t] ?? 0) - res.length) : 0;
  };
  const usable = (h: string) => hosts[h]?.enabled !== false;
  const inUseTypes = [...new Set(pool.flatMap(([, p]) => residentOf(p).map((v) => str(vgpus[v].type))))].filter((t) => vgpuTypes[t]);
  const capacity: TypeCapacity[] = inUseTypes
    .sort(typeOrder)
    .map((t) => ({
      typeRef: t,
      name: typeName(t),
      used: pool.reduce((n, [, p]) => n + residentOf(p).filter((v) => str(vgpus[v].type) === t).length, 0),
      free: pool.filter(([, p]) => usable(str(p.host))).reduce((n, [, p]) => n + roomFor(p, t), 0),
    }));

  // XenMan: a host away (an update, a fault): do its running vGPU VMs find slots on the others?
  // Counted per type against the others' room as it is now -- one type's VMs may take empty GPUs
  // another type would need, so with several types this is the best case.
  const away: HostAway[] = hostRef
    ? []
    : Object.keys(hosts)
        .sort((a, b) => natural(hostName(a), hostName(b)))
        .map((h) => {
          const mine = pool.filter(([, p]) => str(p.host) === h).flatMap(([, p]) => residentOf(p));
          const byType = new Map<string, number>();
          for (const v of mine) byType.set(str(vgpus[v].type), (byType.get(str(vgpus[v].type)) ?? 0) + 1);
          const others = pool.filter(([, p]) => str(p.host) !== h && usable(str(p.host)));
          return {
            hostRef: h,
            hostName: hostName(h),
            types: [...byType.entries()]
              .sort(([a], [b]) => typeOrder(a, b))
              .map(([t, n]) => ({ name: typeName(t), vms: n, short: Math.max(0, n - others.reduce((s, [, p]) => s + roomFor(p, t), 0)) })),
          };
        })
        .filter((x) => x.types.length > 0);

  return {
    placement: algorithm ? `Placement policy: ${PLACEMENT[algorithm]}` : null,
    algorithm,
    rows: [...rowsByKey.values()],
    hostLabels: !hostRef && Object.keys(hosts).length > 1,
    capacity,
    away,
  };
}
