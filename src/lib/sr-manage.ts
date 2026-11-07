/**
 * Managing storage repositories, as XenCenter's SR menu does it:
 * Repair (RepairSRCommand, SrRepairAction), Detach (DetachSrAction), Forget
 * (ForgetSrAction), Destroy (DestroySrAction), Set as Default
 * (SetSrAsDefaultAction) and Reclaim freed space (SrTrimAction).
 *
 * For each SR it says which of them may run and, if not, XenCenter's reason;
 * the commands check that again against the records as they are now.
 *
 * Not taken over: XenCenter also offers Repair when an SR's multipathing is
 * degraded (SR.MultipathAOK); here only for an SR that is broken.
 */

import { asyncCall, type XapiCall } from "./xen-network-actions";

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
const NULL_REF = "OpaqueRef:NULL";

export const SR_TEXTS = {
  detachTitle: "Detach Storage Repository",
  detach:
    "Detaching this storage repository will make the virtual disks that it contains inaccessible. The contents of the virtual disks themselves will remain intact.\n\nIf you subsequently reattach the storage repository, you will need to provide the correct device configuration details.\n\nAre you sure you want to detach this storage repository?",
  forgetTitle: "Forget Storage Repository",
  forget: (name: string) =>
    `Are you sure you want to forget '${name}'?\n\nForgetting this storage repository will permanently remove the information used to connect the virtual machines to the virtual disks in the storage repository. The contents of the virtual disks themselves will remain intact.\n\nThis action is final and unrecoverable.`,
  destroyTitle: "Destroy Storage Repository",
  destroy: (name: string) =>
    `Are you sure you want to destroy '${name}'?\n\nDestroying this storage repository will permanently remove all associated virtual disks from the underlying storage device.\n\nThis action is final and unrecoverable.`,
  trimTitle: "Reclaim freed space",
  trim: "The process of reclaiming space may place significant load on the storage controller, temporarily affecting the storage's performance.\nWould you like to carry out the operation at this time?",
  repairIntro:
    "Click Repair to have XenMan attempt to diagnose and resolve the connection problems with this storage repository. If the problem cannot be resolved, look at XenMan's logs for more detailed error messages.",
};

export type SrCommand = "repair" | "detach" | "forget" | "destroy" | "setDefault" | "trim";

export interface SrHostStatus {
  host: string;
  name: string;
  /** XenCenter's RepairSRDialog: Connected, Unplugged, Connection Missing. */
  status: "Connected" | "Unplugged" | "Connection Missing";
}

export interface SrState {
  ref: string;
  name: string;
  isDefault: boolean;
  /** Per command: null when it may run, else XenCenter's reason. Absent: not offered for this SR at all. */
  commands: Partial<Record<SrCommand, string | null>>;
  /** The hosts Repair looks at, with what it found. */
  hosts: SrHostStatus[];
}

export interface SrRecords {
  srs: Recs;
  pbds: Recs;
  hosts: Recs;
  vdis: Recs;
  vbds: Recs;
  vms: Recs;
  sms: Recs;
  pool: Rec;
  poolRef: string;
}

export async function loadSrRecords(call: XapiCall): Promise<SrRecords> {
  const all = (cls: string) => call<Recs>(`${cls}.get_all_records`, []);
  const [srs, pbds, hosts, vdis, vbds, vms, sms, pools] = await Promise.all([
    all("SR"), all("PBD"), all("host"), all("VDI"), all("VBD"), all("VM"), all("SM"), all("pool"),
  ]);
  const poolRef = Object.keys(pools)[0] ?? "";
  return { srs, pbds, hosts, vdis, vbds, vms, sms, pool: pools[poolRef] ?? {}, poolRef };
}

const sm = (r: SrRecords, type: string) => Object.values(r.sms).find((x) => str(x.type) === type);
const pbdsOf = (r: SrRecords, sr: Rec) => list(sr.PBDs).map((p) => [p, r.pbds[p]] as const).filter(([, p]) => !!p);

/** SR.IsDetached: no PBD attached. */
const detached = (r: SrRecords, sr: Rec) => !pbdsOf(r, sr).some(([, p]) => p.currently_attached === true);

/** SR.IsBroken: not one PBD per host it belongs on, or one of them unplugged. */
function broken(r: SrRecords, sr: Rec): boolean {
  const pbds = list(sr.PBDs);
  if (pbds.length === 0) return true;
  const hostCount = Object.keys(r.hosts).length;
  if (sr.shared === true && hostCount > 1 ? pbds.length !== hostCount : pbds.length !== 1) return true;
  return pbds.some((p) => r.pbds[p]?.currently_attached !== true);
}

/** SR.HasRunningVMs: a running VM uses one of its disks (the control domain's metadata disks aside). */
function hasRunningVms(r: SrRecords, sr: Rec): boolean {
  return list(sr.VDIs).some((v) => {
    const vdi = r.vdis[v];
    if (!vdi) return false;
    return list(vdi.VBDs).some((b) => {
      const vm = r.vms[str(r.vbds[b]?.VM)];
      if (!vm) return false;
      if (str(vdi.type) === "metadata" && vm.is_control_domain === true) return false;
      return str(vm.power_state) === "Running";
    });
  });
}

/** SR.CanCreateWithXenCenter: the types XenCenter's New SR wizard makes. */
const createdByWizard = (type: string) => ["iso", "lvmoiscsi", "nfs", "lvmohba", "smb", "lvmofcoe", "gfs2"].includes(type);

/** SR.SupportsVdiCreate. */
function supportsVdiCreate(r: SrRecords, sr: Rec): boolean {
  if (str(sr.content_type) === "iso" || str(sr.type) === "tmpfs") return false;
  return list(sm(r, str(sr.type))?.capabilities).includes("VDI_CREATE");
}

/** SR.SupportsTrim: the SM has the SR_TRIM feature. */
const supportsTrim = (r: SrRecords, sr: Rec) => Object.prototype.hasOwnProperty.call(sm(r, str(sr.type))?.features ?? {}, "SR_TRIM");

/** SR.GetFirstAttachedStorageHost. */
const firstAttachedHost = (r: SrRecords, sr: Rec) => pbdsOf(r, sr).find(([, p]) => p.currently_attached === true)?.[1].host as string | undefined;

/** SR.GetStorageHost: the host of a local SR. */
function storageHost(r: SrRecords, sr: Rec): string | null {
  const pbds = list(sr.PBDs);
  if (sr.shared === true || pbds.length !== 1) return null;
  return str(r.pbds[pbds[0]]?.host) || null;
}

/** Hidden SRs XenCenter does not list: its own temporary ones, tools and the memory SR. */
function listed(sr: Rec): boolean {
  if (str(sr.name_label).startsWith("__gui__")) return false;
  if (["tmpfs", "local"].includes(str(sr.type))) return false;
  return ((sr.other_config ?? {}) as Record<string, string>).HideFromXenCenter !== "true";
}

/** The hosts SrRepairAction works through -- coordinator first -- with their PBD's state. */
function repairHosts(r: SrRecords, sr: Rec): SrHostStatus[] {
  const coordinator = str(r.pool.master);
  const order = [coordinator, ...Object.keys(r.hosts).filter((h) => h !== coordinator)].filter((h) => r.hosts[h]);
  const sto = storageHost(r, sr);
  return order
    .filter((h) => sr.shared === true || h === sto)
    .map((h) => {
      const pbd = pbdsOf(r, sr).find(([, p]) => str(p.host) === h)?.[1];
      return {
        host: h,
        name: str(r.hosts[h]?.name_label),
        status: !pbd ? "Connection Missing" : pbd.currently_attached === true ? "Connected" : "Unplugged",
      };
    });
}

/** Which of XenCenter's SR commands may run on each SR, and why not. */
export function buildSrStates(r: SrRecords): SrState[] {
  const out: SrState[] = [];
  const defaultSr = str(r.pool.default_SR);
  for (const [ref, sr] of Object.entries(r.srs)) {
    if (!listed(sr)) continue;
    const type = str(sr.type);
    const ops = list(sr.allowed_operations);
    const running = hasRunningVms(r, sr);
    const hasPbds = list(sr.PBDs).length > 0;
    const isDefault = ref === defaultSr && defaultSr !== NULL_REF;
    const c: SrState["commands"] = {};

    // RepairSRCommand: offered for a broken SR that has PBDs.
    if (hasPbds && broken(r, sr)) c.repair = null;

    // DetachSRCommand.GetCantRunReasonCore.
    c.detach = detached(r, sr) ? "The SR is currently detached." : running ? "This SR contains running VMs." : null;

    // ForgetSRCommand: the wizard's types, while XAPI allows it.
    if (createdByWizard(type)) {
      c.forget = running
        ? "This SR contains running VMs."
        : !ops.includes("forget")
          ? "XenServer does not allow forgetting this SR now. Detach it first."
          : null;
    } else c.forget = "This SR cannot be forgotten with XenMan.";

    // DestroySRCommand.
    if (!hasPbds) c.destroy = "The SR is currently detached.";
    else if (running) c.destroy = "This SR contains running VMs.";
    else if (!createdByWizard(type)) c.destroy = "This SR cannot be destroyed with XenMan.";
    else if (!ops.includes("destroy")) c.destroy = "XenServer does not allow destroying this SR now.";
    else c.destroy = null;

    // SetAsDefaultSRCommand: offered unless it is the default already.
    if (!isDefault) {
      const hostCount = Object.keys(r.hosts).length;
      c.setDefault = !hasPbds
        ? "The SR is currently detached."
        : !supportsVdiCreate(r, sr)
          ? "Virtual disks cannot be created on this SR."
          : !(sr.shared === true || hostCount <= 1)
            ? "Only a shared SR can be the default of a pool."
            : null;
    }

    // TrimSRCommand.
    if (supportsTrim(r, sr)) c.trim = firstAttachedHost(r, sr) ? null : "Cannot reclaim freed space because the SR is detached.";

    out.push({ ref, name: str(sr.name_label), isDefault, commands: c, hosts: repairHosts(r, sr) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** DetachSrAction: every PBD unplugged, the coordinator's last. */
async function detach(call: XapiCall, r: SrRecords, sr: Rec) {
  const coordinator = str(r.pool.master);
  const pbds = pbdsOf(r, sr);
  const ordered = [...pbds.filter(([, p]) => str(p.host) !== coordinator), ...pbds.filter(([, p]) => str(p.host) === coordinator)];
  for (const [ref, p] of ordered) {
    if (p.currently_attached === true) await asyncCall(call, "PBD.unplug", [ref], 600_000);
  }
}

/**
 * SrRepairAction: for a shared SR, a PBD made for every host that has none
 * (from the first PBD's device_config), then each one not attached plugged --
 * the coordinator first. Every host is tried; the first failure is reported.
 */
async function repair(call: XapiCall, r: SrRecords, srRef: string, sr: Rec): Promise<string[]> {
  const failures: string[] = [];
  const template = pbdsOf(r, sr)[0]?.[1];
  for (const h of repairHosts(r, sr)) {
    let pbdRef = pbdsOf(r, sr).find(([, p]) => str(p.host) === h.host)?.[0] ?? null;
    let attached = pbdRef ? r.pbds[pbdRef].currently_attached === true : false;
    if (!pbdRef && sr.shared === true && template) {
      try {
        pbdRef = await asyncCall(call, "PBD.create", [
          { host: h.host, SR: srRef, device_config: template.device_config ?? {}, other_config: {} },
        ]);
        attached = false;
      } catch (err) {
        failures.push(`Creating PBD for ${h.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    if (pbdRef && !attached) {
      try {
        await asyncCall(call, "PBD.plug", [pbdRef], 600_000);
      } catch (err) {
        failures.push(`Plugging PBD for ${h.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return failures;
}

/** SrTrimAction: the host plugin "trim", on the first host the SR is attached to. */
async function trim(call: XapiCall, r: SrRecords, sr: Rec): Promise<void> {
  const host = firstAttachedHost(r, sr);
  if (!host) throw new SrRefused("Cannot reclaim freed space because the SR is detached.");
  const result = await call<string>("host.call_plugin", [host, "trim", "do_trim", { sr_uuid: str(sr.uuid) }]);
  if (str(result).toLowerCase() === "true") return;
  // <trim_response><key_value_pair><key>errmsg</key><value>…</value></key_value_pair></trim_response>
  const msg = /<key>\s*errmsg\s*<\/key>\s*<value>([\s\S]*?)<\/value>/.exec(str(result))?.[1];
  throw new Error(msg?.trim() || "An unknown error occurred.");
}

/** Refused before anything changed: the caller answers 409 with the reason. */
export class SrRefused extends Error {}

/**
 * Runs one of XenCenter's SR commands, after checking again that it may.
 * Returns what Repair could not do, if anything.
 */
export async function runSrCommand(call: XapiCall, srRef: string, command: SrCommand): Promise<string[]> {
  const r = await loadSrRecords(call);
  const sr = r.srs[srRef];
  if (!sr) throw new SrRefused("Unknown storage repository");
  const state = buildSrStates(r).find((s) => s.ref === srRef);
  if (!state || !(command in state.commands)) throw new SrRefused("This command is not available for this SR");
  const reason = state.commands[command];
  if (reason) throw new SrRefused(reason);
  switch (command) {
    case "detach":
      await detach(call, r, sr);
      return [];
    case "forget":
      await asyncCall(call, "SR.forget", [srRef], 600_000);
      return [];
    case "destroy":
      await asyncCall(call, "SR.destroy", [srRef], 1_800_000);
      return [];
    case "setDefault":
      // SetSrAsDefaultAction: default, crash dump and suspend image SR together.
      await call("pool.set_default_SR", [r.poolRef, srRef]);
      await call("pool.set_crash_dump_SR", [r.poolRef, srRef]);
      await call("pool.set_suspend_image_SR", [r.poolRef, srRef]);
      return [];
    case "trim":
      await trim(call, r, sr);
      return [];
    case "repair":
      return repair(call, r, srRef, sr);
  }
}
