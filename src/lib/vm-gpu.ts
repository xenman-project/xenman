/**
 * A VM's virtual GPUs, as XenCenter's VM Properties → GPU page shows and
 * changes them (GpuEditPage, AddVGPUDialog, GpuAssignAction):
 *
 * - Only for a VM that is shut down, and not while HA would restart it.
 * - "Add" offers, per GPU group, the vGPU types every vGPU the VM already has
 *   may share it with (compatible_types_in_vm); a type the pool has not
 *   allowed on the group's GPUs is shown, but cannot be chosen. Without a vGPU
 *   licence -- or for a VM whose template forbids vGPUs -- only pass-through.
 * - Saving destroys the vGPUs taken away and creates the new ones
 *   (VGPU.create with device "0", as GpuAssignAction does).
 *
 * Texts are XenCenter's (Messages.resx, GpuEditPage.resx).
 */

import { asyncCall, type XapiCall } from "./xen-network-actions";

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v) || 0;
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
const caps = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export const GPU_TEXTS = {
  rubric: "You can improve graphics performance by assigning one or more virtual graphics processing units to this VM.",
  stopVm: "The virtual GPUs can only be changed when the VM is shut down.",
  ha: "The virtual GPUs cannot be changed because the VM is currently protected by HA.",
  rdp: "Before making this change, you must make sure that you can connect to your VM over Remote Desktop. The Default (VNC) Desktop will not work with a dedicated GPU, so you will not be able to connect to your VM except over Remote Desktop.",
  needDriver: "It is essential that the appropriate graphics card drivers are installed on the VM once it has been booted.",
  needGpu: "If there is no available virtual GPU of the correct type when the VM is next booted, it will not be able to start.",
  experimental: "This type of vGPU is in Tech Preview, and is currently not suitable for production use.",
  multiple: "The selected virtual GPU type supports multiple instances.",
  single: "The selected virtual GPU type does not support multiple instances.",
  passthrough: "Pass-through whole GPU",
};

export interface VmGpuType {
  ref: string;
  /** VGPU_type.Description(): what the Add dialog lists. */
  label: string;
  /** The name column of the VM's list (VGpuDetailRow). */
  rowName: string;
  /** vGPUs per GPU; null for pass-through. */
  perGpu: number | null;
  videoRam: number;
  passthrough: boolean;
  experimental: boolean;
  /** compatible_types_in_vm: the types a VM may have beside this one. */
  compatible: string[];
}

export interface VmGpuGroup {
  ref: string;
  /** GPU_group.Name(): without "Group of ". */
  name: string;
  hasVgpu: boolean;
  hasPassthrough: boolean;
  /** supported_VGPU_types, in the order the Add dialog lists them. */
  types: string[];
  /** Supported, but not allowed on the group's GPUs (the GPU tab's "Edit"): listed greyed. */
  disabled: string[];
}

export interface VmGpuRow {
  /** null: not created yet. */
  ref: string | null;
  group: string;
  type: string;
  /** The PCI slot number column: device + 11 on XenServer 8; "-" for a new one. */
  slot: string;
}

export interface VmGpuPage {
  /** Helpers.GpusAvailable: a GPU group with GPUs and types. */
  available: boolean;
  /** Host.RestrictGpu on no host. */
  licensed: boolean;
  /** vGPUs at all (licence and the VM's template), else pass-through only. */
  vgpuAllowed: boolean;
  /** Host.RestrictVgpu on no host: VGPU.create may name the type. */
  vgpuLicensed: boolean;
  /** Why nothing can be changed now: shut down first, or HA. */
  locked: string | null;
  current: VmGpuRow[];
  groups: VmGpuGroup[];
  types: Record<string, VmGpuType>;
}

export interface VmGpuRecords {
  vm: Rec;
  vms: Recs;
  vgpus: Recs;
  types: Recs;
  groups: Recs;
  pgpus: Recs;
  hosts: Recs;
  pool: Rec;
}

export async function loadVmGpuRecords(call: XapiCall, vmRef: string): Promise<VmGpuRecords> {
  const all = (cls: string) => call<Recs>(`${cls}.get_all_records`, []);
  const [vm, vms, vgpus, types, groups, pgpus, hosts, pools] = await Promise.all([
    call<Rec>("VM.get_record", [vmRef]), all("VM"), all("VGPU"), all("VGPU_type"), all("GPU_group"), all("PGPU"), all("host"), all("pool"),
  ]);
  return { vm, vms, vgpus, types, groups, pgpus, hosts, pool: Object.values(pools)[0] ?? {} };
}

/** BoolKeyPreferTrue: restricted unless the licence says "false". */
const restricted = (hosts: Recs, key: string) =>
  Object.values(hosts).some((h) => (caps(h.license_params)[key] ?? "") !== "false");

/**
 * VM.GetRestrictionValueFromMatchingTemplate(field, "value"): the restriction
 * of the template the VM was made from (same reference_label), or of the
 * template itself.
 */
function templateRestriction(r: VmGpuRecords, field: string): number | null {
  const vm = r.vm;
  let source: Rec | undefined;
  if (vm.is_a_template === true) source = vm;
  else if (str(vm.reference_label)) {
    source = Object.values(r.vms).find((v) => v.is_a_template === true && str(v.reference_label) === str(vm.reference_label));
  }
  if (!source) return null;
  const re = new RegExp(`<restriction\\b[^>]*\\bfield="${field}"[^>]*>`);
  const tag = re.exec(str(source.recommendations))?.[0];
  const value = tag ? /\bvalue="([^"]*)"/.exec(tag)?.[1] : undefined;
  return value === undefined || value === "" ? null : Number(value);
}

/** VGPU_type.Capacity: what the first GPU it is supported on can hold of it. */
function capacityOf(r: VmGpuRecords, typeRef: string): number {
  const first = list(r.types[typeRef]?.supported_on_PGPUs)[0];
  return num(caps(r.pgpus[first]?.supported_VGPU_max_capacities)[typeRef]);
}

const groupName = (g: Rec) => str(g.name_label).replace(/^Group of /, "");

/** The VM's GPU page: what it has, what may be added, and whether anything may change now. */
export function buildVmGpuPage(r: VmGpuRecords, vmRef: string): VmGpuPage {
  const vm = r.vm;
  const isPassthrough = (t: string) => str(r.types[t]?.model_name) === "passthrough";
  const types: Record<string, VmGpuType> = {};
  for (const [ref, t] of Object.entries(r.types)) {
    const pt = isPassthrough(ref);
    const perGpu = pt ? null : capacityOf(r, ref);
    const compatible = list(t.compatible_types_in_vm);
    types[ref] = {
      ref,
      label: pt
        ? GPU_TEXTS.passthrough
        : compatible.length > 0
          ? `${str(t.model_name)} virtual GPU (${perGpu} per GPU, multiple vGPU support)`
          : `${str(t.model_name)} virtual GPU (${perGpu} per GPU)`,
      rowName: str(t.model_name),
      perGpu,
      videoRam: num(t.framebuffer_size),
      passthrough: pt,
      experimental: t.experimental === true,
      compatible,
    };
  }

  // VGPU_type.CompareTo, then reversed as AddVGPUDialog does: pass-through first,
  // then the most vGPUs per GPU last.
  const compare = (a: string, b: string) => {
    const pa = isPassthrough(a), pb = isPassthrough(b);
    if (pa !== pb) return pa ? 1 : -1;
    const ca = capacityOf(r, a), cb = capacityOf(r, b);
    if (ca !== cb) return cb - ca;
    const ra = num(r.types[a]?.max_resolution_x) * num(r.types[a]?.max_resolution_y);
    const rb = num(r.types[b]?.max_resolution_x) * num(r.types[b]?.max_resolution_y);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  };

  const groups: VmGpuGroup[] = [];
  for (const [ref, g] of Object.entries(r.groups)) {
    const supported = list(g.supported_VGPU_types).filter((t) => types[t]);
    if (list(g.PGPUs).length === 0 || supported.length === 0) continue;
    const enabled = new Set(list(g.enabled_VGPU_types));
    // PGPU.HasVGpu for any GPU of the group: a type other than pass-through.
    const hasVgpu = list(g.PGPUs).some((p) => list(r.pgpus[p]?.supported_VGPU_types).some((t) => types[t] && !isPassthrough(t)));
    groups.push({
      ref,
      name: groupName(g),
      hasVgpu,
      hasPassthrough: supported.some(isPassthrough),
      types: [...supported].sort(compare).reverse(),
      disabled: supported.filter((t) => !enabled.has(t)),
    });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.ref.localeCompare(b.ref));

  const current: VmGpuRow[] = list(vm.VGPUs)
    .map((ref) => [ref, r.vgpus[ref]] as const)
    .filter(([, v]) => !!v)
    .map(([ref, v]) => {
      const device = Number.parseInt(str(v.device), 10);
      return { ref, group: str(v.GPU_group), type: str(v.type), slot: Number.isNaN(device) ? "-" : String(device + 11) };
    });
  for (const row of current) {
    const t = types[row.type];
    // VGpuDetailRow: a pass-through vGPU is named after its group, unless the group also has vGPUs.
    if (t?.passthrough) {
      const g = groups.find((x) => x.ref === row.group);
      t.rowName = g && !g.hasVgpu ? g.name : GPU_TEXTS.passthrough;
    }
  }

  // VM.CanHaveGpu / CanHaveVGpu: an HVM VM, unless its template says otherwise.
  const hvm = str(vm.HVM_boot_policy) !== "";
  const canHaveGpu = hvm && (templateRestriction(r, "allow-gpu-passthrough") ?? 1) !== 0;
  const canHaveVgpu = canHaveGpu && (templateRestriction(r, "allow-vgpu") ?? 1) !== 0;

  let locked: string | null = null;
  if (str(vm.power_state) !== "Halted") locked = GPU_TEXTS.stopVm;
  else if (r.pool.ha_enabled === true && str(vm.ha_restart_priority) === "restart") locked = GPU_TEXTS.ha;
  void vmRef;

  return {
    available: groups.length > 0,
    licensed: !restricted(r.hosts, "restrict_gpu"),
    vgpuAllowed: !restricted(r.hosts, "restrict_vgpu") && canHaveVgpu,
    vgpuLicensed: !restricted(r.hosts, "restrict_vgpu"),
    locked,
    current,
    groups,
    types,
  };
}

/**
 * What AddVGPUDialog lists for a VM that has `have` (type refs): per group,
 * the types every one of them may share the VM with; without vGPUs allowed,
 * the group's pass-through only.
 */
export function addableTypes(page: VmGpuPage, have: string[]): { group: VmGpuGroup; types: { ref: string; enabled: boolean }[] }[] {
  const out: { group: VmGpuGroup; types: { ref: string; enabled: boolean }[] }[] = [];
  for (const g of page.groups) {
    if (!page.vgpuAllowed) {
      const pt = g.types.find((t) => page.types[t]?.passthrough);
      if (pt) out.push({ group: g, types: [{ ref: pt, enabled: !g.disabled.includes(pt) }] });
      continue;
    }
    const common = g.types.filter((t) => have.every((h) => page.types[h]?.compatible.includes(t)));
    if (common.length) out.push({ group: g, types: common.map((t) => ({ ref: t, enabled: !g.disabled.includes(t) })) });
  }
  return out;
}

/** GpuEditPage: "Add" only while every vGPU the VM has allows more than one. */
export const mayAddMore = (page: VmGpuPage, have: string[]) =>
  page.available && have.every((t) => (page.types[t]?.compatible.length ?? 0) > 0);

export interface VmGpuChange {
  /** The existing vGPUs to keep. */
  keep: string[];
  /** New ones: a group and one of its types. */
  add: { group: string; type: string }[];
}

/** Why the change cannot be made, checked against the records as they are now; or null. */
export function changeProblem(page: VmGpuPage, change: VmGpuChange): string | null {
  if (page.locked) return page.locked;
  if (!page.licensed) return "GPUs are not available with this pool's license.";
  const currentRefs = page.current.map((c) => c.ref);
  if (change.keep.some((k) => !currentRefs.includes(k))) return "That vGPU does not belong to this VM";
  const kept = page.current.filter((c) => change.keep.includes(c.ref!)).map((c) => c.type);
  const all = [...kept];
  for (const a of change.add) {
    const g = page.groups.find((x) => x.ref === a.group);
    if (!g || !g.types.includes(a.type)) return "That vGPU type is not offered by this GPU group";
    if (g.disabled.includes(a.type)) return `${page.types[a.type].label} is not allowed on the GPUs of ${g.name}`;
    if (!page.vgpuAllowed && !page.types[a.type].passthrough) return "This VM can only have a GPU passed through";
    // AddVGPUDialog: only types every vGPU already chosen may share the VM with.
    if (!mayAddMore(page, all) || !all.every((h) => page.types[h]?.compatible.includes(a.type))) {
      return `${page.types[a.type].label} cannot be added beside the virtual GPUs the VM has`;
    }
    all.push(a.type);
  }
  return null;
}

/** GpuAssignAction: the vGPUs taken away destroyed, the new ones created. */
export async function applyVmGpus(call: XapiCall, vmRef: string, page: VmGpuPage, change: VmGpuChange): Promise<void> {
  for (const c of page.current) {
    if (c.ref && !change.keep.includes(c.ref)) await call("VGPU.destroy", [c.ref]);
  }
  for (const a of change.add) {
    // Without a vGPU licence XenCenter leaves the type out: XenServer takes pass-through.
    const params = page.vgpuLicensed ? [vmRef, a.group, "0", {}, a.type] : [vmRef, a.group, "0", {}];
    await asyncCall(call, "VGPU.create", params, 60_000);
  }
}
