/**
 * Importing a VM from an XVA file, as XenCenter's Import wizard does it for
 * XVA (ImportSelectHostPage, StoragePickerPage, NetworkPickerPage, ImportVmAction):
 *
 * 1. Home server and storage: the SR list follows SrPickerVmItem -- seen from
 *    the home server (without one: shared SRs only), new disks possible, not
 *    broken, not full.
 * 2. The upload: task.create("put_import_task"), then an HTTP PUT of the file
 *    to /import on the SR's own host (the coordinator for shared storage).
 * 3. Then the VM: a unique name (ImportVmAction.DefaultVMName), the home server.
 * 4. Its network interfaces moved to the networks chosen (VIF.move), networks the
 *    import brought along and nothing uses any more removed, the VM started if asked.
 *
 * Texts are XenCenter's (Messages.resx).
 */

import { xenApiCall } from "./xen-client";
import { xenPutStream } from "./xen-tls";
import { reachableAt } from "./nat";
import { XapiTaskError, type XapiCall } from "./xen-network-actions";
import { diskSize } from "./vm-copy";

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v) || 0;
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
const oc = (r: Rec | undefined) => (r?.other_config ?? {}) as Record<string, string>;
const NULL_REF = "OpaqueRef:NULL";
const GIB = 1024 ** 3;
/** ImportVmAction.IMPORT_TASK: the other_config key XAPI marks objects of an import with. */
const IMPORT_TASK = "import_task";

export interface ImportRecords {
  pool: Rec;
  hosts: Recs;
  hostMetrics: Recs;
  srs: Recs;
  pbds: Recs;
  sms: Recs;
  networks: Recs;
  pifs: Recs;
}

export interface ImportHost {
  ref: string;
  name: string;
  live: boolean;
}

export interface ImportSr {
  ref: string;
  name: string;
  enabled: boolean;
  description: string;
}

export interface ImportTargets {
  hosts: ImportHost[];
  srs: ImportSr[];
  defaultSr: string | null;
}

export async function loadImportRecords(call: XapiCall): Promise<ImportRecords> {
  const all = (cls: string) => call<Recs>(`${cls}.get_all_records`, []);
  const [pools, hosts, hostMetrics, srs, pbds, sms, networks, pifs] = await Promise.all([
    all("pool"), all("host"), all("host_metrics"), all("SR"), all("PBD"), all("SM"), all("network"), all("PIF"),
  ]);
  return { pool: Object.values(pools)[0] ?? {}, hosts, hostMetrics, srs, pbds, sms, networks, pifs };
}

const hostName = (r: ImportRecords, ref: string) => str(r.hosts[ref]?.name_label) || ref;
const hostLive = (r: ImportRecords, ref: string) => r.hostMetrics[str(r.hosts[ref]?.metrics)]?.live === true;
const smCan = (r: ImportRecords, srType: string, cap: string) =>
  Object.values(r.sms).some((sm) => str(sm.type) === srType && list(sm.capabilities).includes(cap));

/** SR.IsBroken: not one attached PBD per host it should be on. */
function broken(r: ImportRecords, sr: Rec): boolean {
  const pbds = list(sr.PBDs);
  if (pbds.length === 0) return true;
  const hostCount = Object.keys(r.hosts).length;
  if (sr.shared === true ? pbds.length !== hostCount : pbds.length !== 1) return true;
  return pbds.some((p) => r.pbds[p]?.currently_attached !== true);
}

/** SrPickerVmItem.CanBeEnabled for an SR the list shows: the reason it cannot hold the VM, or null. */
function cannotHold(r: ImportRecords, sr: Rec, affinity: string | null): string | null {
  // CanBeSeenFromAffinity.
  if (affinity === null) {
    if (sr.shared !== true) return "VMs without a home server cannot have disks on local storage";
  } else {
    const pbd = list(sr.PBDs).map((p) => r.pbds[p]).find((p) => str(p?.host) === affinity);
    if (!pbd) return `This storage repository cannot be seen from ${hostName(r, affinity)}`;
    if (pbd.currently_attached !== true) return `The SR is currently unplugged from ${hostName(r, affinity)}`;
  }
  if (broken(r, sr)) return "This SR is broken or not fully attached.";
  // CanFitDisks without disks known yet: only SR.IsFull.
  const free = num(sr.physical_size) - num(sr.physical_utilisation);
  if (!["dummy", "ebs"].includes(str(sr.type)) && free < GIB / 2) return "This storage repository is full";
  return null;
}

/** The home servers and SRs XenCenter's Import wizard offers for an XVA. */
export function importTargets(r: ImportRecords, affinity: string | null): ImportTargets {
  const hosts = Object.entries(r.hosts)
    .map(([ref, h]) => ({ ref, name: str(h.name_label), live: hostLive(r, ref) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const srs: ImportSr[] = [];
  for (const [ref, sr] of Object.entries(r.srs)) {
    // SrPickerItem.Update: what cannot take a new disk is not listed.
    if (str(sr.type) === "rawhba" || str(sr.type) === "tmpfs" || str(sr.type) === "local" || str(sr.content_type) === "iso") continue;
    if (!smCan(r, str(sr.type), "VDI_CREATE")) continue;
    if (str(sr.name_label).startsWith("__gui__") || oc(sr).HideFromXenCenter === "true") continue;
    const reason = cannotHold(r, sr, affinity);
    const size = num(sr.physical_size);
    srs.push({
      ref,
      name: str(sr.name_label),
      enabled: reason === null,
      description: reason ?? `${diskSize(size - num(sr.physical_utilisation))} free of ${diskSize(size)}`,
    });
  }
  srs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const poolDefault = str(r.pool.default_SR);
  const pick = poolDefault && poolDefault !== NULL_REF && r.srs[poolDefault] ? srs.find((s) => s.ref === poolDefault) : srs[0];
  return { hosts, srs, defaultSr: pick?.enabled ? pick.ref : null };
}

/** SR.GetStorageHost: the host of a local SR; none for shared storage. */
function storageHost(r: ImportRecords, srRef: string): string | null {
  const sr = r.srs[srRef];
  if (!sr || sr.shared === true) return null;
  const pbds = list(sr.PBDs);
  return pbds.length === 1 ? str(r.pbds[pbds[0]]?.host) || null : null;
}

export interface ImportContext {
  poolId: string;
  address: string;
  port: number;
  useSsl: boolean;
  sessionRef: string;
}

export interface ImportedVm {
  vmRef: string;
  name: string;
  isTemplate: boolean;
  importTask: string;
}

/**
 * ImportVmAction.Run up to the wizard's network page: the upload, then the
 * VM's name and home server. Throws with XenCenter's reason when the target
 * cannot take it.
 */
export async function runImport(
  ctx: ImportContext,
  upload: { body: NodeJS.ReadableStream; length: number; srRef: string; affinity: string | null; signal?: AbortSignal },
): Promise<ImportedVm> {
  const call: XapiCall = <T>(method: string, params: unknown[]) =>
    xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [ctx.sessionRef, ...params]);
  const r = await loadImportRecords(call);
  const sr = r.srs[upload.srRef];
  if (!sr) throw new ImportRefused("Choose a storage repository");
  if (upload.affinity !== null && !r.hosts[upload.affinity]) throw new ImportRefused("That server is not in this pool");
  const target = importTargets(r, upload.affinity).srs.find((s) => s.ref === upload.srRef);
  if (!target) throw new ImportRefused(`${str(sr.name_label)} cannot hold a VM`);
  if (!target.enabled) throw new ImportRefused(`${target.name}: ${target.description}`);

  // UploadFile: to the SR's own host, else to the coordinator the session is on.
  const viaHost = storageHost(r, upload.srRef);
  // Behind NAT: at the address that host is reached at (lib/nat.ts).
  const at = viaHost && str(r.hosts[viaHost]?.address) ? reachableAt(ctx.poolId, str(r.hosts[viaHost]?.address)) : null;
  const address = at?.host || ctx.address;
  const port = at?.port ?? ctx.port;
  const importTask = await call<string>("task.create", ["put_import_task", address]);
  const scheme = ctx.useSsl ? "https" : "http";
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  const query = new URLSearchParams({ session_id: ctx.sessionRef, task_id: importTask, sr_id: upload.srRef, restore: "false", force: "false" });
  const url = `${scheme}://${host}:${port}/import?${query}`;
  let answer: { status: number; text: string };
  try {
    answer = await xenPutStream(url, upload.body, upload.length, ctx.poolId, upload.signal);
  } catch (err) {
    await call("task.cancel", [importTask]).catch(() => {});
    throw err;
  }
  const vmRef = await waitForImport(call, importTask, answer.status);

  // ImportVmAction: the name made unique, the home server set (not for a template).
  const vm = await call<Rec>("VM.get_record", [vmRef]);
  const isTemplate = vm.is_a_template === true;
  if (isTemplate && vm.is_default_template === true && oc(vm)[IMPORT_TASK] !== importTask) {
    throw new ImportRefused("The XenServer Template that you are attempting to import already exists in the selected pool.");
  }
  const all = await call<Recs>("VM.get_all_records", []);
  const name = defaultVmName(str(vm.name_label), Object.values(all).map((v) => str(v.name_label)));
  if (name !== str(vm.name_label)) await call("VM.set_name_label", [vmRef, name]);
  if (!isTemplate && upload.affinity !== null) await call("VM.set_affinity", [vmRef, upload.affinity]);
  return { vmRef, name, isTemplate, importTask };
}

/** The import task to its end: the new VM's ref, or why it failed. */
async function waitForImport(call: XapiCall, task: string, putStatus: number): Promise<string> {
  const until = Date.now() + 12 * 60 * 60 * 1000;
  for (;;) {
    const t = await call<Rec>("task.get_record", [task]);
    const status = str(t.status);
    if (status === "success") {
      await call("task.destroy", [task]).catch(() => {});
      const ref = /OpaqueRef:[\w-]+/.exec(str(t.result))?.[0];
      if (!ref) throw new Error("The import finished without a VM");
      return ref;
    }
    if (status === "failure" || status === "cancelled") {
      await call("task.destroy", [task]).catch(() => {});
      const info = list(t.error_info);
      throw new XapiTaskError(info[0] || (status === "cancelled" ? "Import canceled." : status), info.slice(1));
    }
    if (putStatus >= 400) {
      await call("task.cancel", [task]).catch(() => {});
      throw new Error(`The server refused the upload (HTTP ${putStatus})`);
    }
    if (Date.now() > until) throw new Error("The import did not finish in time");
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** ImportVmAction.DefaultVMName: "name", or "name (1)" if another VM has it already. */
export function defaultVmName(name: string, allNames: string[]): string {
  const count = (n: string) => allNames.filter((x) => x === n).length;
  if (count(name) <= 1) return name;
  for (let i = 1; ; i++) {
    const candidate = `${name} (${i})`;
    if (count(candidate) === 0) return candidate;
  }
}

/** Refused before anything was imported: the caller answers 409 with the reason. */
export class ImportRefused extends Error {}

export interface ImportVif {
  ref: string;
  device: string;
  mac: string;
  network: string;
}

export interface ImportNetwork {
  ref: string;
  name: string;
}

/** Network.Show / IsMember / Host.CanSeeNetwork / AllHostsCanSeeNetwork, as NetworkPickerPage.ShowNetwork uses them. */
export function networksFor(r: ImportRecords, affinity: string | null): ImportNetwork[] {
  const out: ImportNetwork[] = [];
  for (const [ref, net] of Object.entries(r.networks)) {
    const o = oc(net);
    if (o.is_guest_installer_network === "true" || o.is_host_internal_management_network === "true" || o.HideFromXenCenter === "true") continue;
    const pifs = list(net.PIFs).map((p) => r.pifs[p]).filter((p): p is Rec => !!p);
    // IsMember: the network of a bond's member interface.
    if (pifs.some((p) => str(p.bond_slave_of) && str(p.bond_slave_of) !== NULL_REF)) continue;
    // IsSriov: only for a VM that recommends it, which an XVA does not say here.
    if (pifs.some((p) => list(p.sriov_logical_PIF_of).length > 0)) continue;
    if (pifs.length > 0) {
      const onHost = (h: string) => pifs.some((p) => str(p.host) === h);
      if (affinity !== null ? !onHost(affinity) : !Object.keys(r.hosts).every(onHost)) continue;
    }
    out.push({ ref, name: str(net.name_label) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The imported VM's interfaces and the networks they may go to (NetworkPickerPage.AddVIFRow). */
export async function importNetworks(call: XapiCall, vmRef: string, affinity: string | null) {
  const r = await loadImportRecords(call);
  const vm = await call<Rec>("VM.get_record", [vmRef]);
  const networks = networksFor(r, affinity);
  const fallback = networks[0]?.ref ?? null;
  const vifs: ImportVif[] = [];
  for (const ref of list(vm.VIFs)) {
    const v = await call<Rec>("VIF.get_record", [ref]);
    const current = str(v.network);
    // CA-66962: a network the VM may not use is replaced by the default one.
    const network = networks.some((n) => n.ref === current) ? current : fallback;
    vifs.push({ ref, device: str(v.device), mac: str(v.MAC), network: network ?? "" });
  }
  vifs.sort((a, b) => Number(a.device) - Number(b.device));
  return { vifs, networks };
}

/**
 * ImportVmAction after the wizard: each interface moved to its network,
 * networks the import made and nothing uses any more removed, the VM started
 * if asked. Returns the start's task, for the task list.
 */
export async function finishImport(
  ctx: ImportContext,
  vmRef: string,
  importTask: string,
  chosen: Record<string, string>,
  start: boolean,
): Promise<string | null> {
  const call: XapiCall = <T>(method: string, params: unknown[]) =>
    xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [ctx.sessionRef, ...params]);
  const vm = await call<Rec>("VM.get_record", [vmRef]);
  const vifs = list(vm.VIFs);
  for (const vif of Object.keys(chosen)) {
    if (!vifs.includes(vif)) throw new ImportRefused("That interface does not belong to this VM");
  }
  const formerNetworks = new Set<string>();
  for (const vif of vifs) {
    const now = await call<string>("VIF.get_network", [vif]);
    formerNetworks.add(now);
    const to = chosen[vif];
    if (to && to !== now) await call("VIF.move", [vif, to]);
  }
  for (const net of formerNetworks) {
    try {
      const rec = await call<Rec>("network.get_record", [net]);
      if (oc(rec)[IMPORT_TASK] !== importTask) continue;
      if (list(rec.VIFs).length > 0 || list(rec.PIFs).length > 0) continue;
      await call("network.destroy", [net]);
    } catch (err) {
      // ImportVmAction: "Squashing."
      console.error(`[vm-import] removing network ${net}:`, err instanceof Error ? err.message : err);
    }
  }
  if (!start || vm.is_a_template === true) return null;
  return str(vm.power_state) === "Suspended"
    ? call<string>("Async.VM.resume", [vmRef, false, false])
    : call<string>("Async.VM.start", [vmRef, false, false]);
}
