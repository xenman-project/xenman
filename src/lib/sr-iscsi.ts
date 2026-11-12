/**
 * A new iSCSI SR, as XenCenter's New Storage wizard makes one (Frontends/LVMoISCSI.cs):
 *
 * - "Scan Target Host": the target's IQNs (ISCSIPopulateIQNsAction), then the
 *   LUNs behind the IQN chosen (ISCSIPopulateLunsAction). XenServer has no call
 *   that lists them; XenCenter asks SR.create with the settings incomplete, and
 *   the storage backend refuses with the list as XML in the error
 *   (SR_BACKEND_FAILURE_96 for IQNs, _107 or _87 for LUNs, ErrorDescription[3]).
 * - Before anything is written: SR.probe on the LUN (SrProbeAction), and the
 *   question XenCenter asks (LVMoIsciWarningDialog): reattach the SR found there,
 *   or format the LUN for a new one.
 * - Format: SrCreateAction -- the CHAP password handed over as a secret.
 *   Reattach: SrReattachAction for an SR this pool knows without PBDs,
 *   SrIntroduceAction for one it does not know.
 *
 * Only lvmoiscsi: XenMan has no GFS2.
 */

import { XenApiError } from "./xen-client";
import type { XapiCall } from "./xen-network-actions";

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

/** XenCenter's Util.DEFAULT_ISCSI_PORT. */
export const ISCSI_PORT = 3260;

/** Helpers.GuiTempObjectPrefix and Messages.ISCSI_SHOULD_NO_BE_CREATED: the name of the SR that is never made. */
const PROBE_NAME = "__gui__";
const PROBE_DESCRIPTION = "SHOULD NEVER BE CREATED";

export const ISCSI_TEXTS = {
  noIqns: (target: string) => `No IQNs were found on ${target}.`,
  noLuns: (target: string) => `No LUNs were found on ${target}.`,
  badResponse: (target: string) => `The server '${target}' gave a bad response to the query.`,
  callSucceeded: "Interrogation failed -- call succeeded!",
  lunInUseOnPool: (sr: string, pool: string) => `This LUN is already in use as SR ${sr} on pool ${pool}.`,
  lunInUse: "This LUN is already in use.",
  // FriendlyErrorNames.resx, as LVMoISCSI.HandleFailure shows them.
  loginFailed: "Logging in to the iSCSI target failed. Check your user name and password.",
  dnsFailed: "DNS lookup failed: the given servername could not be resolved.",
  noConnect: "Unable to connect to iSCSI service on target",
} as const;

// --- The XML the storage backend answers with ---

interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m),
  );

/** Enough of XML for these flat answers: elements, text, entities; no attributes needed. Throws on bad nesting. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/\s*([\w:.-]+)\s*>|<\s*([\w:.-]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length < 2 || top.name !== m[2]) throw new Error("bad XML");
      stack.pop();
    } else if (m[3]) {
      const node: XmlNode = { name: m[3], children: [], text: "" };
      top.children.push(node);
      if (!m[4]) stack.push(node);
    } else if (m[5]) top.text += decode(m[5]);
  }
  if (stack.length !== 1) throw new Error("bad XML");
  return root;
}

/** Every element of that name, anywhere (XmlDocument.GetElementsByTagName). */
function byName(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    byName(c, name, out);
  }
  return out;
}

/** A child's text by its name, case-insensitive as XenCenter compares them. */
function field(node: XmlNode, name: string): string | undefined {
  const c = node.children.find((x) => x.name.toLowerCase() === name);
  return c ? c.text.trim() : undefined;
}

// --- IQNs ---

export interface IscsiIqn {
  index: number;
  iqn: string;
  /** IPv6 in brackets, as ParseIPAddress gives it. */
  address: string;
  port: number;
  /** "iqn (address:port)", as the IQN list shows it. */
  label: string;
}

/** ParseIPAddress: an IP address as written; IPv6 in brackets. */
function ipAddress(raw: string): string {
  const a = raw.trim().replace(/^\[|\]$/g, "");
  return a.includes(":") ? `[${a}]` : a;
}

/** StringUtility.NaturalCompare: digit runs as numbers. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/** <iscsi-target-iqns><TGT><Index/><IPAddress/><Port/><TargetIQN/></TGT>...; sorted as IScsiIqnInfo.CompareTo, without empty IQNs. */
export function parseIqns(xml: string): IscsiIqn[] {
  const out: IscsiIqn[] = [];
  for (const listNode of byName(parseXml(xml), "iscsi-target-iqns")) {
    for (const t of listNode.children) {
      const index = Number.parseInt(field(t, "index") ?? "-1", 10);
      const port = Number.parseInt(field(t, "port") ?? String(ISCSI_PORT), 10);
      if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error("bad port");
      const address = ipAddress(field(t, "ipaddress") ?? "");
      const iqn = field(t, "targetiqn") ?? "";
      out.push({ index: Number.isFinite(index) ? index : -1, iqn, address, port, label: `${iqn} (${address}:${port})` });
    }
  }
  out.sort((a, b) => (a.iqn === "*" && b.iqn !== "*" ? 1 : b.iqn === "*" && a.iqn !== "*" ? -1 : naturalCompare(a.iqn, b.iqn)));
  // PopulateIqnsAction_Completed_: entries without an IQN are not offered.
  return out.filter((x) => x.iqn);
}

// --- LUNs ---

export interface IscsiLun {
  lunId: number;
  scsiId: string;
  vendor: string;
  serial: string;
  size: number;
  label: string;
  /** XenCenter's "in use" text when an SR of this pool is on it already; null when free. */
  inUse: string | null;
}

/** Util.DiskSizeString: binary units, one decimal place. */
export function diskSize(bytes: number): string {
  const units: [number, string][] = [
    [1024 ** 4, "TB"],
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
    [1024, "kB"],
  ];
  for (const [n, unit] of units) if (bytes >= n) return `${Math.round((bytes / n) * 10) / 10} ${unit}`;
  return `${bytes} B`;
}

/** LVMoISCSI's LUN label: "LUN 0: serial: 100 GB (vendor)", each part only when known. */
export function lunLabel(l: Pick<IscsiLun, "lunId" | "serial" | "size" | "vendor">): string {
  let label = "LUN";
  if (l.lunId !== -1) label += ` ${l.lunId}`;
  if (l.serial) label += `: ${l.serial}`;
  if (l.size >= 0) label += `: ${diskSize(l.size)}`;
  if (l.vendor) label += ` (${l.vendor})`;
  return label;
}

/** <iscsi-target><LUN><LUNid/><vendor/><serial/><size/><SCSIid/></LUN>...; sorted by LUN id. */
export function parseLuns(xml: string): Omit<IscsiLun, "inUse">[] {
  const out: Omit<IscsiLun, "inUse">[] = [];
  for (const target of byName(parseXml(xml), "iscsi-target")) {
    for (const n of target.children) {
      const lunIdText = field(n, "lunid");
      const lunId = lunIdText === undefined ? -1 : Number.parseInt(lunIdText, 10);
      if (!Number.isFinite(lunId)) throw new Error("bad LUN id");
      const sizeText = field(n, "size");
      const size = sizeText !== undefined && /^\d+$/.test(sizeText) ? Number(sizeText) : -1;
      const lun = { lunId, scsiId: field(n, "scsiid") ?? "", vendor: field(n, "vendor") ?? "", serial: field(n, "serial") ?? "", size };
      out.push({ ...lun, label: lunLabel(lun) });
    }
  }
  return out.sort((a, b) => a.lunId - b.lunId);
}

// --- SRs found on a LUN (SR.ParseSRListXML) ---

export interface ProbedSr {
  uuid: string;
  size: number;
  nameLabel: string;
  nameDescription: string;
}

export function parseSrList(xml: string): ProbedSr[] {
  return byName(parseXml(xml), "SR").map((n) => ({
    uuid: field(n, "uuid") ?? "",
    size: Number(field(n, "size") ?? "0") || 0,
    nameLabel: field(n, "name_label") ?? "",
    nameDescription: field(n, "name_description") ?? "",
  }));
}

// --- Errors ---

/** A failure said as XenCenter says it, and which field it belongs to (LVMoISCSI.HandleFailure). */
export class IscsiError extends Error {
  constructor(
    message: string,
    readonly field: "host" | "chap" | "lun" | null = null,
  ) {
    super(message);
  }
}

function failure(err: unknown): { code: string; data: string[] } | null {
  if (err instanceof XenApiError) return { code: err.message, data: (err.data ?? []).map(String) };
  return null;
}

/** The error a scan or create turns into, unless it is the answer expected. */
function iscsiError(code: string, data: string[]): IscsiError {
  if (code === "SR_BACKEND_FAILURE_68") return new IscsiError(ISCSI_TEXTS.loginFailed, "chap");
  if (code === "SR_BACKEND_FAILURE_140") return new IscsiError(ISCSI_TEXTS.dnsFailed, "host");
  if (code === "SR_BACKEND_FAILURE_141") return new IscsiError(ISCSI_TEXTS.noConnect, "host");
  // The backend's own words (ErrorDescription[2], its stdout) when there are any.
  const said = data.slice(0, 2).map((s) => s.trim()).filter(Boolean).join(": ");
  return new IscsiError(said ? `${code}: ${said}` : code);
}

export interface IscsiTarget {
  target: string;
  port: number;
  chapuser?: string;
  chappassword?: string;
}

/** The device-config of a scan or an SR: target and port, and CHAP when a user name is given. */
function deviceConfig(t: IscsiTarget, extra: Record<string, string> = {}): Record<string, string> {
  const cfg: Record<string, string> = { target: t.target, port: String(t.port), ...extra };
  if (t.chapuser) {
    cfg.chapuser = t.chapuser;
    cfg.chappassword = t.chappassword ?? "";
  }
  return cfg;
}

/** An SR.create that must fail with the list the backend gives back; ErrorDescription[3] is data[2]. */
async function interrogate(call: XapiCall, coordinator: string, cfg: Record<string, string>, expected: string[], target: string, none: string) {
  let made: string | null = null;
  try {
    made = await call<string>("SR.create", [coordinator, cfg, "0", PROBE_NAME, PROBE_DESCRIPTION, "lvmoiscsi", "user", true, {}]);
  } catch (err) {
    const f = failure(err);
    if (!f) throw err;
    if (!expected.includes(f.code)) throw iscsiError(f.code, f.data);
    const xml = f.data[2] ?? "";
    if (!xml) throw new IscsiError(none);
    return xml;
  }
  // Made after all: take it away again, without touching the LUN (SR.forget).
  await forgetQuietly(call, made);
  throw new IscsiError(ISCSI_TEXTS.callSucceeded);
}

/** "Scan Target Host": the target's IQNs. */
export async function scanIqns(call: XapiCall, coordinator: string, t: IscsiTarget): Promise<IscsiIqn[]> {
  const xml = await interrogate(call, coordinator, deviceConfig(t), ["SR_BACKEND_FAILURE_96"], t.target, ISCSI_TEXTS.noIqns(t.target));
  let iqns: IscsiIqn[];
  try {
    iqns = parseIqns(xml);
  } catch {
    throw new IscsiError(ISCSI_TEXTS.badResponse(t.target));
  }
  if (!iqns.length) throw new IscsiError(ISCSI_TEXTS.noIqns(t.target));
  return iqns;
}

/** The LUNs behind an IQN; target and port are the IQN entry's own (multi-homing, CA-11607). */
export async function scanLuns(call: XapiCall, coordinator: string, t: IscsiTarget & { targetIQN: string }): Promise<Omit<IscsiLun, "inUse">[]> {
  const xml = await interrogate(
    call,
    coordinator,
    deviceConfig(t, { targetIQN: t.targetIQN }),
    ["SR_BACKEND_FAILURE_107", "SR_BACKEND_FAILURE_87"],
    t.target,
    ISCSI_TEXTS.noLuns(t.target),
  );
  let luns: Omit<IscsiLun, "inUse">[];
  try {
    luns = parseLuns(xml);
  } catch {
    throw new IscsiError(ISCSI_TEXTS.badResponse(t.target));
  }
  if (!luns.length) throw new IscsiError(ISCSI_TEXTS.noLuns(t.target));
  return luns;
}

// --- The pool as it is ---

export interface PoolSrView {
  poolRef: string;
  poolName: string;
  coordinator: string;
  hosts: string[];
  srs: Recs;
  pbds: Recs;
}

export async function loadPoolSrView(call: XapiCall): Promise<PoolSrView> {
  const [pools, hosts, srs, pbds] = await Promise.all([
    call<Recs>("pool.get_all_records", []),
    call<Recs>("host.get_all_records", []),
    call<Recs>("SR.get_all_records", []),
    call<Recs>("PBD.get_all_records", []),
  ]);
  const [poolRef, pool] = Object.entries(pools)[0] ?? ["", {}];
  const coordinator = str(pool.master);
  const poolName = str(pool.name_label) || str(hosts[coordinator]?.name_label);
  return { poolRef, poolName, coordinator, hosts: Object.keys(hosts), srs, pbds };
}

/** LVMoISCSI's "LUN in use" check: an iSCSI SR of this pool whose PBDs use that SCSI id. */
export function lunInUse(view: PoolSrView, scsiId: string): string | null {
  if (!scsiId) return null;
  for (const pbd of Object.values(view.pbds)) {
    const dc = (pbd.device_config ?? {}) as Record<string, string>;
    if (dc.SCSIid !== scsiId) continue;
    const sr = view.srs[str(pbd.SR)];
    if (!sr || (str(sr.type) !== "lvmoiscsi" && str(sr.type) !== "gfs2")) continue;
    return ISCSI_TEXTS.lunInUseOnPool(str(sr.name_label), view.poolName);
  }
  return null;
}

// --- Before anything is written: what is on the LUN ---

export interface IscsiLunConfig extends IscsiTarget {
  targetIQN: string;
  /** SCSIid, or, for a LUN without an id, its serial (GetDeviceConfig: LUNSerial). */
  scsiId?: string;
  lunSerial?: string;
}

export function lunDeviceConfig(c: IscsiLunConfig): Record<string, string> {
  const extra: Record<string, string> = { targetIQN: c.targetIQN };
  if (c.scsiId) extra.SCSIid = c.scsiId;
  else if (c.lunSerial) extra.LUNSerial = c.lunSerial;
  return deviceConfig(c, extra);
}

export interface ProbeOutcome {
  /** The SR on the LUN, if there is one (0 or 1, as XenCenter expects). */
  found: (ProbedSr & { known: { ref: string; name: string; attached: boolean; hasPbds: boolean } | null }) | null;
  /** When the SR found is in use by this pool: XenCenter then offers no Format. */
  inUse: string | null;
}

/** SrProbeAction: SR.probe on the coordinator with the LUN's device-config. */
export async function probeLun(call: XapiCall, view: PoolSrView, c: IscsiLunConfig): Promise<ProbeOutcome> {
  let xml: string;
  try {
    xml = await call<string>("SR.probe", [view.coordinator, lunDeviceConfig(c), "lvmoiscsi", {}]);
  } catch (err) {
    const f = failure(err);
    if (!f) throw err;
    throw iscsiError(f.code, f.data);
  }
  let srs: ProbedSr[];
  try {
    srs = parseSrList(xml);
  } catch {
    throw new IscsiError(ISCSI_TEXTS.badResponse(c.target));
  }
  const sr = srs[0];
  if (!sr) return { found: null, inUse: null };
  const entry = Object.entries(view.srs).find(([, r]) => str(r.uuid) === sr.uuid);
  let known: NonNullable<ProbeOutcome["found"]>["known"] = null;
  let inUse: string | null = null;
  if (entry) {
    const [ref, r] = entry;
    const pbds = list(r.PBDs).map((p) => view.pbds[p]).filter(Boolean);
    known = { ref, name: str(r.name_label), attached: pbds.some((p) => p.currently_attached === true), hasPbds: pbds.length > 0 };
    // SrWizardHelpers.SrInUse / GetSrInUseMessage.
    inUse = ISCSI_TEXTS.lunInUseOnPool(str(r.name_label), view.poolName);
  }
  return { found: { ...sr, known }, inUse };
}

// --- Format: SrCreateAction ---

/** SR.forget, PBDs unplugged first, failures ignored (SrCreateAction.ForgetFailedSR). */
async function forgetQuietly(call: XapiCall, sr: string) {
  try {
    for (const pbd of await call<string[]>("SR.get_PBDs", [sr])) {
      if (await call<boolean>("PBD.get_currently_attached", [pbd])) await call("PBD.unplug", [pbd]);
    }
    await call("SR.forget", [sr]);
  } catch {
    // as XenCenter: carry on
  }
}

/** isFirstSharedNonISOSR: no other shared SR but ISO libraries in the pool. */
async function firstSharedSr(call: XapiCall, sr: string): Promise<boolean> {
  const srs = await call<Recs>("SR.get_all_records", []);
  return !Object.entries(srs).some(([ref, r]) => ref !== sr && str(r.type) !== "iso" && r.shared === true);
}

/** SetSrAsDefaultAction, as sr-manage.ts does it. */
async function setDefault(call: XapiCall, poolRef: string, sr: string) {
  await call("pool.set_default_SR", [poolRef, sr]);
  await call("pool.set_crash_dump_SR", [poolRef, sr]);
  await call("pool.set_suspend_image_SR", [poolRef, sr]);
}

export interface NewIscsiSr {
  name: string;
  description: string;
}

/**
 * SrCreateAction: the CHAP password as a secret (chappassword_secret), which the
 * PBDs duplicate; the temporary one removed afterwards, best effort (CA-113396,
 * CA-145254). Then each PBD checked plugged, auto-scan off, and the first shared
 * SR made the default.
 */
export async function createIscsiSr(call: XapiCall, view: PoolSrView, c: IscsiLunConfig, sr: NewIscsiSr): Promise<string> {
  const dconf = lunDeviceConfig(c);
  let secretUuid: string | null = null;
  if ("chappassword" in dconf) {
    const value = dconf.chappassword;
    delete dconf.chappassword;
    const secretRef = await call<string>("Secret.create", [{ value, other_config: {} }]);
    secretUuid = await call<string>("Secret.get_uuid", [secretRef]);
    dconf.chappassword_secret = secretUuid;
  }
  let made: string;
  try {
    made = await call<string>("SR.create", [view.coordinator, dconf, "0", sr.name, sr.description, "lvmoiscsi", "", true, {}]);
  } catch (err) {
    const f = failure(err);
    throw f ? iscsiError(f.code, f.data) : err;
  } finally {
    if (secretUuid) {
      try {
        await call("Secret.destroy", [await call<string>("Secret.get_by_uuid", [secretUuid])]);
      } catch {
        // an unused secret left behind at worst
      }
    }
  }
  for (const pbd of await call<string[]>("SR.get_PBDs", [made])) {
    if (await call<boolean>("PBD.get_currently_attached", [pbd])) continue;
    try {
      await call("PBD.plug", [pbd]);
    } catch (err) {
      const f = failure(err);
      if (f && (f.code === "HOST_OFFLINE" || f.code === "HOST_STILL_BOOTING")) continue;
      await forgetQuietly(call, made);
      throw f ? iscsiError(f.code, f.data) : err;
    }
  }
  await call("SR.set_other_config", [made, { "auto-scan": "false" }]);
  if (await firstSharedSr(call, made)) await setDefault(call, view.poolRef, made);
  return made;
}

// --- Reattach: SrReattachAction / SrIntroduceAction ---

/** A PBD per host of the pool, each plugged (both actions do this alike). */
async function pbdsForAllHosts(call: XapiCall, view: PoolSrView, sr: string, dconf: Record<string, string>) {
  for (const host of view.hosts) {
    const pbd = await call<string>("PBD.create", [{ host, SR: sr, device_config: dconf, other_config: {} }]);
    await call("PBD.plug", [pbd]);
  }
}

export async function reattachIscsiSr(call: XapiCall, view: PoolSrView, c: IscsiLunConfig, uuid: string, sr: NewIscsiSr): Promise<string> {
  const dconf = lunDeviceConfig(c);
  const known = Object.entries(view.srs).find(([, r]) => str(r.uuid) === uuid);
  try {
    if (known) {
      const [ref, r] = known;
      // SrReattachAction is for an SR without PBDs; one with them is repaired instead.
      if (list(r.PBDs).length) throw new IscsiError(`SR ${str(r.name_label)} is already in this pool: use Repair in the Storage tab.`);
      await pbdsForAllHosts(call, view, ref, dconf);
      await call("SR.set_name_label", [ref, sr.name]);
      await call("SR.set_name_description", [ref, sr.description]);
      return ref;
    }
    const ref = await call<string>("SR.introduce", [uuid, sr.name, sr.description, "lvmoiscsi", "", true, {}]);
    await pbdsForAllHosts(call, view, ref, dconf);
    if (await firstSharedSr(call, ref)) await setDefault(call, view.poolRef, ref);
    return ref;
  } catch (err) {
    if (err instanceof IscsiError) throw err;
    const f = failure(err);
    throw f ? iscsiError(f.code, f.data) : err;
  }
}
