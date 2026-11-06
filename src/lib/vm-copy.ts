/**
 * Copying a VM and turning VMs and snapshots into templates, as XenCenter does:
 *
 * - CopyVMDialog / CopyVMCommand: a fast clone (VM.clone, on the VM's own
 *   storage) or a full copy (VM.copy) onto an SR the SrPickerCopyItem rules
 *   allow, with the SR list, the default name and the description XenCenter offers.
 * - ConvertVMToTemplateCommand: other_config:instant=true, then VM.set_is_a_template.
 * - NewTemplateFromSnapshotCommand: VM.clone of the snapshot (a clone of a
 *   snapshot is a template), then other_config:instant=true.
 *
 * Texts are XenCenter's (Messages.resx, CopyVMDialog.resx).
 */

import { xenApiCall } from "./xen-client";
import { XapiTaskError, type XapiCall } from "./xen-network-actions";

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v) || 0;
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
const NULL_REF = "OpaqueRef:NULL";

const GIB = 1024 ** 3;
/** SR.DISK_MAX_SIZE: 2 TiB, unless the SR's SM can do LARGE_VDI. */
const DISK_MAX_SIZE = 2 * 1024 * GIB;
/** Helpers.GuiTempObjectPrefix: objects XenCenter creates and hides. */
const GUI_TEMP_PREFIX = "__gui__";

export const TEXTS = {
  copyVm: "Copy Virtual Machine",
  selectSr: "Create a full copy of the existing VM on this storage repository:",
  fastCloneDescription: "Clone the existing VM, using a storage-level fast disk clone operation",
  fastCloneUnavailable: "Fast clone is not supported by this storage type",
  convertTitle: "Convert VM to Template",
  convertText: (name: string) => `Are you sure you want to convert VM '${ellipsise(name, 25)}' to a template? This cannot be undone.`,
  saveAsTemplate: "Save as a Template",
  newTemplatePrompt: "Enter a name for the new template:",
};

/** Util.DiskSizeString with two decimals, as the SR picker shows it. */
export function diskSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} ${units[i]}` : `${Number(v.toFixed(2))} ${units[i]}`;
}

/** String.Ellipsise: at most `max` characters, "..." replacing the end. */
function ellipsise(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}

/** Helpers.MakeUniqueName: "name", then "name (1)", "name (2)", ... */
export function uniqueName(stub: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  let name = stub;
  for (let i = 1; names.has(name); i++) name = `${stub} (${i})`;
  return name;
}

export interface CopySr {
  ref: string;
  name: string;
  enabled: boolean;
  /** "{free} free of {size}", or why the SR cannot take the copy. */
  description: string;
}

export interface CopyPlan {
  name: string;
  description: string;
  isTemplate: boolean;
  /** "Full copy" can be chosen. */
  copyEnabled: boolean;
  /** "Fast clone" can be chosen; when not, the reason as its tooltip. */
  cloneEnabled: boolean;
  cloneUnavailable?: string;
  /** Which of the two is ticked when the dialog opens. */
  mode: "clone" | "copy";
  srs: CopySr[];
  defaultSr: string | null;
}

export interface CopyRecords {
  vm: Rec;
  vms: Recs;
  vbds: Recs;
  vdis: Recs;
  srs: Recs;
  pbds: Recs;
  sms: Recs;
  pool: Rec;
}

function smOf(r: CopyRecords, srType: string): Rec | null {
  return Object.values(r.sms).find((sm) => str(sm.type) === srType) ?? null;
}
const smCan = (sm: Rec | null, capability: string) => list(sm?.capabilities).includes(capability);

/** The VM's disks: VBDs of type Disk with a VDI, as CopyVMDialog collects them. */
function disksOf(r: CopyRecords): Rec[] {
  return list(r.vm.VBDs)
    .map((ref) => r.vbds[ref])
    .filter((vbd): vbd is Rec => !!vbd && str(vbd.type) !== "CD")
    .map((vbd) => r.vdis[str(vbd.VDI)])
    .filter((vdi): vdi is Rec => !!vdi);
}

/** VM.AnyDiskFastClonable: a disk on an SR whose SM can VDI_CLONE. */
function anyDiskFastClonable(r: CopyRecords): boolean {
  return list(r.vm.VBDs).some((ref) => {
    const vbd = r.vbds[ref];
    if (!vbd || str(vbd.type) !== "Disk") return false;
    const sr = r.srs[str(r.vdis[str(vbd.VDI)]?.SR)];
    return !!sr && smCan(smOf(r, str(sr.type)), "VDI_CLONE");
  });
}

/** VM.HasAtLeastOneDisk. */
const hasAtLeastOneDisk = (r: CopyRecords) => list(r.vm.VBDs).some((ref) => str(r.vbds[ref]?.type) === "Disk");

/** SR.SupportsVdiCreate: not an ISO library, not the memory SR, and its SM can VDI_CREATE. */
function supportsVdiCreate(r: CopyRecords, sr: Rec): boolean {
  if (str(sr.content_type) === "iso" || str(sr.type) === "tmpfs") return false;
  return smCan(smOf(r, str(sr.type)), "VDI_CREATE");
}

/** SR.Show: not a hidden GUI object, not the "local" CD SR or the memory SR. */
function shown(sr: Rec): boolean {
  if (str(sr.name_label).startsWith(GUI_TEMP_PREFIX)) return false;
  if (str(sr.type) === "local" || str(sr.type) === "tmpfs") return false;
  const oc = (sr.other_config ?? {}) as Record<string, string>;
  return oc.HideFromXenCenter !== "true";
}

/** SR.IsDetached: no PBD currently attached. */
function detached(r: CopyRecords, sr: Rec): boolean {
  return !list(sr.PBDs).some((ref) => r.pbds[ref]?.currently_attached === true);
}

/** SR.CanFitDisks: the reason the disks do not fit, or null. */
function cannotFit(r: CopyRecords, sr: Rec, disks: Rec[]): string | null {
  const sm = smOf(r, str(sr.type));
  if (!smCan(sm, "LARGE_VDI") && disks.some((d) => num(d.virtual_size) > DISK_MAX_SIZE)) {
    return `You cannot create a disk greater than ${diskSize(DISK_MAX_SIZE).replace(/\.\d+/, "")} on this SR.`;
  }
  const size = num(sr.physical_size);
  const free = size - num(sr.physical_utilisation);
  // SR.IsFull: under half a GiB left (the dummy and ebs SR types excepted).
  if (!["dummy", "ebs"].includes(str(sr.type)) && free < GIB / 2) return "This storage repository is full";
  const needed = smCan(sm, "THIN_PROVISIONING")
    ? disks.reduce((n, d) => n + num(d.physical_utilisation), 0)
    : disks.reduce((n, d) => n + num(d.virtual_size), 0);
  if (needed > size) return `Disk size (${diskSize(needed)}) exceeds SR size (${diskSize(size)})`;
  if (needed > free) return `${diskSize(needed)} required when only ${diskSize(free)} available`;
  return null;
}

/** What CopyVMDialog shows for this VM (or template). */
export function buildCopyPlan(r: CopyRecords): CopyPlan {
  const vm = r.vm;
  const isTemplate = vm.is_a_template === true;
  const allowCopy = !isTemplate || list(vm.allowed_operations).includes("copy");
  const anyFastClonable = anyDiskFastClonable(r);
  const hasDisk = hasAtLeastOneDisk(r);
  const copyEnabled = allowCopy && hasDisk;
  const cloneEnabled = !allowCopy || anyFastClonable || !hasDisk;

  const disks = disksOf(r);
  const srs: CopySr[] = [];
  for (const [ref, sr] of Object.entries(r.srs)) {
    // SrPickerItem.Update: SRs that cannot hold a new disk are not listed at all.
    if (str(sr.type) === "rawhba" || !supportsVdiCreate(r, sr) || !shown(sr)) continue;
    const size = num(sr.physical_size);
    let reason: string | null = null;
    if (detached(r, sr)) reason = "The SR is currently detached.";
    else reason = cannotFit(r, sr, disks);
    srs.push({
      ref,
      name: str(sr.name_label),
      enabled: reason === null,
      description: reason ?? `${diskSize(size - num(sr.physical_utilisation))} free of ${diskSize(size)}`,
    });
  }
  srs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  // SrPicker: the pool's default SR when there is one, otherwise the first SR listed.
  const poolDefault = str(r.pool.default_SR);
  const hasPoolDefault = poolDefault !== "" && poolDefault !== NULL_REF && !!r.srs[poolDefault];
  const pick = hasPoolDefault ? srs.find((s) => s.ref === poolDefault) : srs[0];
  const defaultSr = pick?.enabled ? pick.ref : null;

  // VM.DescriptionType: plain VMs, custom templates and snapshots carry their description over.
  const oc = (vm.other_config ?? {}) as Record<string, string>;
  const builtinTemplate = isTemplate && oc.default_template === "true";
  const description = builtinTemplate ? "" : str(vm.name_description);

  const taken = Object.values(r.vms).map((v) => str(v.name_label));
  return {
    name: uniqueName(`Copy of ${str(vm.name_label)}`, taken),
    description,
    isTemplate,
    copyEnabled,
    cloneEnabled,
    cloneUnavailable: cloneEnabled ? undefined : TEXTS.fastCloneUnavailable,
    // The designer ticks "Fast clone"; a disabled one leaves "Full copy".
    mode: cloneEnabled ? "clone" : "copy",
    srs,
    defaultSr,
  };
}

/**
 * CopyVMCommand.CanRun, without the cross-pool wizard: a VM (not a template),
 * not busy, that may be exported and is not suspended.
 */
export function copyBlockedReason(vm: Rec): string | null {
  if (vm.is_a_template === true || vm.is_a_snapshot === true || vm.is_control_domain === true) return "Only a VM can be copied.";
  if (Object.keys((vm.current_operations ?? {}) as Rec).length) return "The VM is busy with another operation.";
  if (str(vm.power_state) === "Suspended") return "A suspended VM cannot be copied.";
  if (!list(vm.allowed_operations).includes("export")) return "Shut the VM down to copy it.";
  return null;
}

/** ConvertVMToTemplateCommand.CanRun. */
export function convertBlockedReason(vm: Rec): string | null {
  if (vm.is_a_template === true || vm.is_a_snapshot === true || vm.is_control_domain === true) return "Only a VM can be converted to a template.";
  if (Object.keys((vm.current_operations ?? {}) as Rec).length) return "The VM is busy with another operation.";
  if (!list(vm.allowed_operations).includes("make_into_template")) return "Shut the VM down to convert it to a template.";
  return null;
}

/** Reads what buildCopyPlan needs. */
export async function loadCopyRecords(call: XapiCall, vmRef: string): Promise<CopyRecords> {
  const all = (cls: string) => call<Recs>(`${cls}.get_all_records`, []);
  const [vm, vms, vbds, vdis, srs, pbds, sms, pools] = await Promise.all([
    call<Rec>("VM.get_record", [vmRef]), all("VM"), all("VBD"), all("VDI"), all("SR"), all("PBD"), all("SM"), all("pool"),
  ]);
  return { vm, vms, vbds, vdis, srs, pbds, sms, pool: Object.values(pools)[0] ?? {} };
}

export interface CopyContext {
  address: string;
  port: number;
  useSsl: boolean;
  sessionRef: string;
}

/**
 * Starts the clone or copy and returns its task, for the task list. What
 * XenCenter does after the task -- the new VM's description, the instant flag
 * of a template from a snapshot -- follows on the server once the task is done.
 */
export async function startCopy(
  ctx: CopyContext,
  vmRef: string,
  how: { mode: "clone" | "copy"; name: string; description: string; srRef?: string; instant?: boolean },
): Promise<string> {
  const call: XapiCall = <T>(method: string, params: unknown[]) =>
    xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [ctx.sessionRef, ...params]);
  const task =
    how.mode === "clone"
      ? await call<string>("Async.VM.clone", [vmRef, how.name])
      : await call<string>("Async.VM.copy", [vmRef, how.name, how.srRef]);
  void followUp(call, task, how.description, how.instant === true).catch((err) =>
    console.error(`[vm-copy] after ${how.mode} of ${vmRef}:`, err instanceof Error ? err.message : err),
  );
  return task;
}

/** Waits for the task, then sets what VM.clone/VM.copy leave as they were. */
async function followUp(call: XapiCall, task: string, description: string, instant: boolean) {
  const until = Date.now() + 6 * 60 * 60 * 1000;
  for (;;) {
    await new Promise((res) => setTimeout(res, 2000));
    let t: Rec;
    try {
      t = await call<Rec>("task.get_record", [task]);
    } catch {
      // The task list (or XAPI) cleared it: nothing left to follow.
      return;
    }
    const status = str(t.status);
    if (status === "pending" || status === "cancelling") {
      if (Date.now() > until) return;
      continue;
    }
    if (status !== "success") {
      const info = list(t.error_info);
      throw new XapiTaskError(info[0] || status, info.slice(1));
    }
    const created = /OpaqueRef:[\w-]+/.exec(str(t.result))?.[0];
    if (!created) return;
    await call("VM.set_name_description", [created, description]);
    if (instant) await setInstant(call, created);
    // The follow-up is done; the task itself stays for the task list to read.
    return;
  }
}

/** SetVMOtherConfigAction(vm, "instant", "true"): XenServer's flag for templates made from a VM or snapshot. */
async function setInstant(call: XapiCall, vmRef: string) {
  await call("VM.remove_from_other_config", [vmRef, "instant"]).catch(() => {});
  await call("VM.add_to_other_config", [vmRef, "instant", "true"]);
}

/** ConvertVMToTemplateCommand: SetVMOtherConfigAction(instant=true), then VMToTemplateAction. */
export async function convertToTemplate(call: XapiCall, vmRef: string): Promise<void> {
  await setInstant(call, vmRef);
  await call("VM.set_is_a_template", [vmRef, true]);
}
