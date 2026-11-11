import { NextRequest, NextResponse } from "next/server";
import { Client as SshClient } from "ssh2";
import { authenticateRequest } from "@/lib/api-auth";
import { loadHostsFromDisk } from "@/lib/host-storage";
import {
  loginToHost,
  logout,
  getAllVmRecords,
  getAllHostRecords,
  getAllPoolRecords,
  getAllSRRecords,
  srCreate,
  srScan,
  getAllNetworkRecords,
  getAllPIFRecords,
  getNetworkingRecords,
  getAllVBDRecords,
  getAllVDIRecords,
  getAllVIFRecords,
  getHostMetrics,
  vmPowerAction,
  vmStartOn,
  vmMigrateAsync,
  vmSetNameLabel,
  vmSetNameDescription,
  vmSetVCPUsMax,
  vmSetVCPUsAtStartup,
  vmSetMemoryLimits,
  vmAddTag,
  vmRemoveTag,
  vdiResize,
  vmSetHVMBootParams,
  vmGetHVMBootParams,
  vmGetPlatform,
  vmSetPlatform,
  vmGetNVRAM,
  vmSetNVRAM,
  getVmConsoles,
  getConsoleRecord,
  getHostConsoleUrl,
  vmGetAllowedVIFDevices,
  vifCreate,
  vifDestroy,
  vifPlug,
  vifUnplug,
  vdiCreate,
  vdiDestroy,
  vbdCreate,
  vbdPlug,
  vbdUnplug,
  vbdDestroy,
  vbdCreateCd,
  vmGetAllowedVBDDevices,
  vbdInsert,
  vbdEject,
  hostDisable,
  hostEnable,
  hostAddToOtherConfig,
  hostRemoveFromOtherConfig,
  hostEvacuateAsync,
  poolJoin,
  poolSetNameLabel,
  poolInitializeWlb,
  poolDeconfigureWlb,
  poolSetWlbEnabled,
  poolSetWlbVerifyCert,
  poolRetrieveWlbConfiguration,
  poolSendWlbConfiguration,
  poolRetrieveWlbRecommendations,
  poolAddToOtherConfig,
  poolRemoveFromOtherConfig,
  taskGetRecord,
  taskGetResult,
  vmCloneAsync,
  vmProvisionAsync,
  vmSetAffinity,
  vmDestroy,
  vmGetVBDs,
  vmGetVIFs,
  vbdGetRecord,
  XenApiError,
  loginRefusedMessage,
  srGetUuid,
  poolGetAll,
  poolGetDefaultSR,
  vmGetOtherConfig,
  vmRemoveFromOtherConfig,
  vmAddToOtherConfig,
  vmGetVTPMs,
  vtpmCreate,
  vmSetHVMBootParamsMap,
  vdiSetNameLabel,
  hostRestartAgent,
  hostShutdown,
  hostReboot,
  getAllVmMetrics,
  vmGetSnapshots,
  vmGetRecord,
  vmSnapshot,
  vmCheckpoint,
  vmRevert,
  vmGetGuestMetricsRecord,
  eventFrom,
  messageGetAllRecords,
  messageDestroy,
  taskGetAllRecords,
  xenApiCall,
} from "@/lib/xen-client";
import type { XenRawEvent } from "@/lib/xen-client";
import { fetchRrdCached, isRrdPeriod, perfCharts, poolCharts, type SourceRequest } from "@/lib/xen-rrd";
import { SOURCE_RE } from "@/lib/perf-sources";
import {
  XenVM,
  XenHostRecord,
  XenPoolRecord,
  XenSRRecord,
  XenNetworkRecord,
  XenPIFRecord,
  XenVBDRecord,
  XenVDIRecord,
  XenVIFRecord,
  XenHostMetrics,
  XenAlert,
  XenPoolTask,
  ParsedXenEvent,
} from "@/lib/types";
import { auditRequest, clientIp, type AuditCategory, type AuditOutcome } from "@/lib/audit";
import { getMgmtJob, runningMgmtJob, startManagementChange } from "@/lib/network-mgmt-job";
import { buildGpuOverview } from "@/lib/xen-gpu";
import { buildMemoryOverview } from "@/lib/xen-memory";
import { busyVm, getVmMemoryJob, needsReboot, startVmMemoryChange, valuesProblem } from "@/lib/vm-memory-job";
import { buildCopyPlan, convertBlockedReason, convertToTemplate, copyBlockedReason, loadCopyRecords, startCopy, uniqueName } from "@/lib/vm-copy";
import { finishImport, ImportRefused, importTargets, loadImportRecords } from "@/lib/vm-import";
import { applyVmGpus, buildVmGpuPage, changeProblem, loadVmGpuRecords } from "@/lib/vm-gpu";
import { buildSrStates, loadSrRecords, runSrCommand, SrRefused, type SrCommand } from "@/lib/sr-manage";
import { getMaintenanceJob, runningFor, startMaintenance } from "@/lib/host-maintenance-job";
import { getDom0MemoryJob, runningDom0Job, startDom0MemoryChange } from "@/lib/dom0-memory-job";
import { checkJoin, getMemberJob, runningMemberJob, startAddServer, startRemoveServer, type MemberContext } from "@/lib/pool-membership-job";
import { NotConfirmedError } from "@/lib/xen-tls";
import { buildLicenseRow } from "@/lib/xen-licensing";
import {
  recordPoolEvents,
  severityFromPriority,
  severityFromTaskStatus,
  type PoolEvent,
} from "@/lib/xen-events";
import { MAX_ALERTS_TO_CLIENT } from "@/lib/alert-format";
import { describeRef, nameByUuid, refName, rememberRefNames } from "@/lib/ref-names";
import { lookup } from "node:dns/promises";
import {
  configureIpInterfaces,
  createBond,
  createNetwork,
  createSriov,
  destroyBond,
  planManagementChange,
  destroyNetwork,
  NetworkRefused,
  StorageConfirmationNeeded,
  updateNetwork,
  XapiTaskError,
  type BondRecords,
} from "@/lib/xen-network-actions";
import { mayAccessHost } from "@/lib/pool-access";
import { buildHostNetworking } from "@/lib/xen-networking";
import { grantConsole, lookupSession, registerSession, removeSession } from "@/lib/xen-sessions";
import { drainPumps, stopPump, type PumpSpec } from "@/lib/xen-event-pump";
import { withPool } from "@/lib/xen-tls";
import { CertMismatchError, SshKeyMismatchError, checkSshKey, knownAddresses, sshKeyFingerprint } from "@/lib/host-trust";
import { natAddresses, reachable, reachableAt, reachableUrl } from "@/lib/nat";
import { learnPool } from "@/lib/host-trust-learn";

// XenServer's self-signed certificates are not checked against a CA but
// against the fingerprints each pool is trusted with (lib/host-trust.ts,
// lib/xen-tls.ts).

// ── Single-record parse helpers (used by both bulk parsers and event processing) ──

function parseSingleVm(ref: string, r: Record<string, unknown>, vmMetrics?: Record<string, Record<string, unknown>>): XenVM {
  const metricsRef = r.metrics as string;
  const metrics = vmMetrics && metricsRef ? vmMetrics[metricsRef] : undefined;
  const startTime = metrics?.start_time as string | undefined;
  return {
    uuid: r.uuid as string,
    ref,
    nameLabel: r.name_label as string,
    nameDescription: r.name_description as string,
    powerState: r.power_state as XenVM["powerState"],
    vcpusMax: Number(r.VCPUs_max),
    vcpusAtStartup: Number(r.VCPUs_at_startup),
    memoryStaticMax: Number(r.memory_static_max),
    memoryDynamicMax: Number(r.memory_dynamic_max),
    memoryDynamicMin: Number(r.memory_dynamic_min),
    residentOn: r.resident_on as string,
    affinity: r.affinity as string,
    isATemplate: r.is_a_template as boolean,
    isASnapshot: r.is_a_snapshot as boolean,
    isControlDomain: r.is_control_domain as boolean,
    domainType: r.domain_type as string,
    guestMetrics: r.guest_metrics as string,
    vifs: (r.VIFs as string[]) || [],
    vbds: (r.VBDs as string[]) || [],
    tags: (r.tags as string[]) || [],
    otherConfig: (r.other_config as Record<string, string>) || {},
    platform: (r.platform as Record<string, string>) || {},
    hvmBootParams: (r.HVM_boot_params as Record<string, string>) || {},
    VTPMs: (r.VTPMs as string[]) || [],
    ...(startTime && startTime !== "19700101T00:00:00Z" ? { startTime } : {}),
  };
}

function parseSingleHost(ref: string, r: Record<string, unknown>): XenHostRecord {
  return {
    uuid: r.uuid as string,
    ref,
    nameLabel: r.name_label as string,
    nameDescription: r.name_description as string,
    address: r.address as string,
    hostname: r.hostname as string,
    enabled: r.enabled as boolean,
    softwareVersion: (r.software_version as Record<string, string>) || {},
    residentVMs: (r.resident_VMs as string[]) || [],
    metrics: r.metrics as string,
    memoryTotal: 0,
    memoryFree: 0,
    cpuInfo: {
      socketCount: parseInt((r.cpu_info as Record<string, string>)?.socket_count || "0", 10),
      cpuCount: parseInt((r.cpu_info as Record<string, string>)?.cpu_count || "0", 10),
      vendor: (r.cpu_info as Record<string, string>)?.vendor || "",
      modelname: (r.cpu_info as Record<string, string>)?.modelname || "",
      speed: parseFloat((r.cpu_info as Record<string, string>)?.speed || "0"),
    },
    otherConfig: (r.other_config as Record<string, string>) || {},
    pbds: Array.isArray(r.PBDs) ? (r.PBDs as string[]) : [],
  };
}

function parseSinglePool(ref: string, r: Record<string, unknown>): XenPoolRecord {
  const oc = (r.other_config as Record<string, string>) ?? {};
  const emptyFolders = (oc.EMPTY_FOLDERS ?? "")
    .split(";")
    .map((p: string) => p.trim().replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/"))
    .filter(Boolean);
  return {
    uuid: r.uuid as string,
    ref,
    nameLabel: r.name_label as string,
    nameDescription: r.name_description as string,
    master: r.master as string,
    emptyFolders,
    wlbUrl: (r.wlb_url as string) ?? "",
    wlbUsername: (r.wlb_username as string) ?? "",
    wlbEnabled: Boolean(r.wlb_enabled),
    wlbVerifyCert: Boolean(r.wlb_verify_cert),
  };
}

// ── Workload Balancing ──

/** What a WLB error means, for the WLB tab: the pool reports them, WLB causes them. */
const WLB_ERRORS: Record<string, string> = {
  WLB_NOT_INITIALIZED: "No Workload Balancing server is connected to this pool.",
  WLB_DISABLED: "Workload Balancing is paused.",
  WLB_TIMEOUT: "The Workload Balancing server did not answer in time.",
  WLB_CONNECTION_REFUSED: "The Workload Balancing server refused the connection -- is it running, and is the port right?",
  WLB_CONNECTION_RESET: "The Workload Balancing server dropped the connection.",
  WLB_UNKNOWN_HOST: "The pool cannot resolve the Workload Balancing server's name.",
  WLB_URL_INVALID: "The Workload Balancing address is not valid -- give it as host:port.",
  WLB_AUTHENTICATION_FAILED: "The Workload Balancing server did not accept its user name or password.",
  WLB_AUTHORIZATION_FAILED: "The Workload Balancing account is not allowed to do this.",
  WLB_XENSERVER_AUTHENTICATION_FAILED: "Workload Balancing could not log in to the pool with the XenServer account.",
  WLB_XENSERVER_AUTHORIZATION_FAILED: "The XenServer account for Workload Balancing needs the pool-admin or pool-operator role.",
  WLB_XENSERVER_CONNECTION_REFUSED: "Workload Balancing could not reach the pool.",
  WLB_XENSERVER_UNKNOWN_HOST: "Workload Balancing cannot resolve the pool coordinator's name.",
  WLB_XENSERVER_TIMEOUT: "The pool did not answer Workload Balancing in time.",
  WLB_MALFORMED_REQUEST: "Workload Balancing did not understand the request.",
  WLB_MALFORMED_RESPONSE: "Workload Balancing sent an answer the pool could not read.",
  WLB_INTERNAL_ERROR: "Workload Balancing reported an internal error.",
};

function wlbErrorMessage(err: unknown): string {
  if (!(err instanceof XenApiError)) return err instanceof Error ? err.message : "Workload Balancing failed";
  const known = WLB_ERRORS[err.message];
  const data = (err.data ?? []).filter((d) => typeof d === "string" && d.trim()).join(" ");
  return known ? `${known}${data ? ` (${data})` : ""}` : `${err.message}${data ? `: ${data}` : ""}`;
}

/** What WLB reports about itself: shown, never sent back. */
const READ_ONLY_WLB = new Set(["WlbVersion", "PlatformVersion", "CredentialsValid"]);

/**
 * Per-host settings (host_<uuid>_<name>) XenMan may change, as XenCenter's
 * WlbHostConfiguration knows them. LastPowerOnSucceeded is WLB's own record.
 */
const WLB_HOST_SETTINGS = new Set([
  "ParticipatesInPowerManagement",
  "ExcludeFromPlacementRecommendations",
  "ExcludeFromEvacuationRecommendations",
  "ExcludeFromPoolOptimizations",
  "ExcludeFromPoolOptimizationAcceptVMs",
]);

/** "https://wlb.example.org:8012/" and "wlb.example.org:8012" alike, as XAPI wants it. */
function wlbAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const a = input.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9.-]+:\d{1,5}$/.test(a) || /^\[[0-9A-Fa-f:]+\]:\d{1,5}$/.test(a) ? a : null;
}

interface WlbRecommendation {
  vmRef: string;
  vmName: string;
  /** "move": a VM to another host. "host": power management, about a host itself. */
  kind: "move" | "host";
  fromHostRef: string;
  fromHost: string;
  toHostRef: string;
  toHost: string;
  reason: string;
}

/** The pool's recommendations, with names, in the order WLB gave them. */
async function describeWlbRecommendations(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  raw: Record<string, string[]>,
): Promise<WlbRecommendation[]> {
  const entries = Object.entries(raw).filter(([, v]) => Array.isArray(v) && String(v[0]).trim().toUpperCase() === "WLB");
  if (!entries.length) return [];
  const hosts = (await getAllHostRecords(host, port, useSsl, sessionRef)) as Record<string, Record<string, unknown>>;
  const hostName = (ref: string) => String(hosts[ref]?.name_label ?? ref);
  return Promise.all(
    entries.map(async ([vmRef, v]) => {
      const vm = (await vmGetRecord(host, port, useSsl, sessionRef, vmRef).catch(() => ({}))) as Record<string, unknown>;
      const from = String(vm.resident_on ?? "");
      return {
        vmRef,
        vmName: String(vm.name_label ?? vmRef),
        kind: vm.is_control_domain ? "host" : "move",
        fromHostRef: from,
        fromHost: hostName(from),
        toHostRef: String(v[1] ?? ""),
        toHost: hostName(String(v[1] ?? "")),
        reason: String(v[4] ?? ""),
      } satisfies WlbRecommendation;
    }),
  );
}

function parseSingleSR(ref: string, r: Record<string, unknown>): XenSRRecord {
  return {
    uuid: r.uuid as string,
    ref,
    nameLabel: r.name_label as string,
    nameDescription: r.name_description as string,
    type: r.type as string,
    physicalSize: Number(r.physical_size || 0),
    physicalUtilisation: Number(r.physical_utilisation || 0),
    virtualAllocation: Number(r.virtual_allocation || 0),
    pbds: Array.isArray(r.PBDs) ? (r.PBDs as string[]) : [],
    shared: r.shared === true,
  };
}

function parseSingleNetwork(ref: string, r: Record<string, unknown>): XenNetworkRecord {
  return {
    uuid: r.uuid as string,
    ref,
    nameLabel: r.name_label as string,
    nameDescription: r.name_description as string,
    bridge: r.bridge as string,
    mtu: Number(r.MTU || 1500),
    vifs: (r.VIFs as string[]) || [],
    pifs: (r.PIFs as string[]) || [],
  };
}

function parseSinglePIF(ref: string, r: Record<string, unknown>): XenPIFRecord {
  return {
    uuid: r.uuid as string,
    ref,
    device: r.device as string,
    network: r.network as string,
    host: r.host as string,
    mac: r.MAC as string,
    vlan: Number(r.VLAN ?? -1),
    ip: r.IP as string,
    netmask: r.netmask as string,
    gateway: r.gateway as string,
    dns: r.DNS as string,
    currentlyAttached: r.currently_attached as boolean,
    physical: r.physical as boolean,
    management: r.management as boolean,
    bondSlaveOf: typeof r.bond_slave_of === "string" ? r.bond_slave_of : "",
    bondMasterOf: Array.isArray(r.bond_master_of) && r.bond_master_of.length > 0
      ? (r.bond_master_of as string[])[0]
      : typeof r.bond_master_of === "string" ? r.bond_master_of : "",
  };
}

// ── Bulk parse functions (delegate to single-record helpers) ──

function parseVmRecords(
  raw: Record<string, Record<string, unknown>>,
  vmMetrics?: Record<string, Record<string, unknown>>,
): XenVM[] {
  return Object.entries(raw).map(([ref, r]) => parseSingleVm(ref, r, vmMetrics));
}

function parseHostRecords(
  raw: Record<string, Record<string, unknown>>,
): XenHostRecord[] {
  return Object.entries(raw).map(([ref, r]) => parseSingleHost(ref, r));
}

function parsePoolRecords(
  raw: Record<string, Record<string, unknown>>,
): XenPoolRecord[] {
  return Object.entries(raw).map(([ref, r]) => parseSinglePool(ref, r));
}

function parseSRRecords(
  raw: Record<string, Record<string, unknown>>,
): XenSRRecord[] {
  return Object.entries(raw).map(([ref, r]) => parseSingleSR(ref, r));
}

function parseNetworkRecords(
  raw: Record<string, Record<string, unknown>>,
): XenNetworkRecord[] {
  return Object.entries(raw).map(([ref, r]) => parseSingleNetwork(ref, r));
}

function parsePIFRecords(
  raw: Record<string, Record<string, unknown>>,
): XenPIFRecord[] {
  return Object.entries(raw).map(([ref, r]) => parseSinglePIF(ref, r));
}

// ── Alerts & pool tasks ──

/**
 * The XAPI epoch is what an unset DateTime carries — reported as either
 * `19700101T00:00:00Z` or `19700101T000000Z` depending on the version, so it is
 * matched after normalisation rather than as a literal.
 */
const XAPI_NEVER_PREFIX = "1970-01-01T00:00:00";

/**
 * XAPI DateTimes arrive as `20260806T13:24:07Z` — valid ISO-8601 basic format,
 * but `new Date()` in the browser only reliably parses the extended form.
 * Returns "" for missing or unset values so callers can test truthiness.
 */
function xapiTimeToIso(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return "";

  let iso: string;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2}):?(\d{2}):?(\d{2})/.exec(raw);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  } else {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return "";
    iso = parsed.toISOString();
  }

  return iso.startsWith(XAPI_NEVER_PREFIX) ? "" : iso;
}

function parseSingleMessage(ref: string, r: Record<string, unknown>): XenAlert {
  return {
    ref,
    uuid: r.uuid as string,
    name: (r.name as string) || "",
    priority: Number(r.priority ?? 5),
    cls: (r.cls as string) || "",
    objUuid: (r.obj_uuid as string) || "",
    timestamp: xapiTimeToIso(r.timestamp),
    body: (r.body as string) || "",
  };
}

function parseSingleTask(ref: string, r: Record<string, unknown>): XenPoolTask {
  return {
    ref,
    uuid: r.uuid as string,
    nameLabel: (r.name_label as string) || "",
    nameDescription: (r.name_description as string) || "",
    created: xapiTimeToIso(r.created),
    finished: xapiTimeToIso(r.finished),
    status: (r.status as XenPoolTask["status"]) || "pending",
    progress: Number(r.progress ?? 0),
    errorInfo: (r.error_info as string[]) || [],
    residentOn: (r.resident_on as string) || "",
  };
}

function parseMessageRecords(
  raw: Record<string, Record<string, unknown>>,
): XenAlert[] {
  return Object.entries(raw).map(([ref, r]) => parseSingleMessage(ref, r));
}

function parseTaskRecords(
  raw: Record<string, Record<string, unknown>>,
): XenPoolTask[] {
  return Object.entries(raw).map(([ref, r]) => parseSingleTask(ref, r));
}

/* ── Mapping onto the persistent pool-event store ── */

function alertToPoolEvent(alert: XenAlert): Omit<PoolEvent, "hostId"> {
  return {
    id: alert.uuid,
    ts: alert.timestamp || new Date().toISOString(),
    kind: "alert",
    severity: severityFromPriority(alert.priority),
    name: alert.name,
    ...(alert.cls ? { objectClass: alert.cls } : {}),
    ...(alert.objUuid ? { objectUuid: alert.objUuid } : {}),
    ...(nameByUuid(alert.objUuid) ? { target: nameByUuid(alert.objUuid) } : {}),
    ...(alert.body ? { body: alert.body } : {}),
  };
}

/**
 * A finished task becomes one history row. Running tasks are skipped — those
 * belong in the task widget, which tracks live progress; the store is a record
 * of what happened.
 */
function taskToPoolEvent(task: XenPoolTask): Omit<PoolEvent, "hostId"> | null {
  if (task.status === "pending" || task.status === "cancelling") return null;
  if (!task.finished) return null;

  const status: PoolEvent["status"] =
    task.status === "success" || task.status === "failure" ? task.status : "cancelled";

  const created = task.created ? Date.parse(task.created) : NaN;
  const finished = Date.parse(task.finished);
  const durationMs =
    Number.isNaN(created) || Number.isNaN(finished) ? undefined : finished - created;

  // "Async.VM.pool_migrate" → "VM": enough to filter the history by object kind
  // without XAPI telling us which object a task acted on.
  const parts = task.nameLabel.split(".");
  const objectClass = parts.length > 1 ? parts[parts.length - 2] : undefined;

  return {
    id: task.uuid,
    ts: task.finished,
    kind: "task",
    severity: severityFromTaskStatus(task.status),
    name: task.nameLabel,
    ...(objectClass ? { objectClass } : {}),
    ...(refName(task.residentOn) ? { target: refName(task.residentOn) } : {}),
    ...(task.nameDescription ? { body: task.nameDescription } : {}),
    status,
    ...(task.errorInfo.length ? { error: task.errorInfo.join(": ") } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * Alerts and pool tasks are a side dish: connect and refresh must still succeed
 * if a pool refuses these calls (older XAPI, restricted RBAC role). An empty
 * result costs the events view; a rejected promise would cost the whole app.
 */
async function fetchAlertsAndTasks(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<{ alerts: XenAlert[]; poolTasks: XenPoolTask[] }> {
  // A session XenServer no longer knows is passed on, not read as "no alerts":
  // the client connects again on it, and the bell is not emptied meanwhile.
  const sessionGone = (err: unknown) => err instanceof XenApiError && err.message === "SESSION_INVALID";
  const [msgRaw, taskRaw] = await Promise.all([
    messageGetAllRecords(host, port, useSsl, sessionRef).catch((err) => {
      if (sessionGone(err)) throw err;
      console.error(`[xen-events] message.get_all_records failed: ${err instanceof Error ? err.message : err}`);
      return {} as Record<string, Record<string, unknown>>;
    }),
    taskGetAllRecords(host, port, useSsl, sessionRef).catch((err) => {
      if (sessionGone(err)) throw err;
      console.error(`[xen-events] task.get_all_records failed: ${err instanceof Error ? err.message : err}`);
      return {} as Record<string, Record<string, unknown>>;
    }),
  ]);
  return {
    alerts: parseMessageRecords(msgRaw),
    poolTasks: parseTaskRecords(taskRaw),
  };
}

/** Persist alerts and finished tasks; duplicates are dropped by the store. */
function recordAlertsAndTasks(
  hostId: string,
  alerts: XenAlert[],
  tasks: XenPoolTask[],
): void {
  const rows = [
    ...alerts.map(alertToPoolEvent),
    ...tasks.map(taskToPoolEvent).filter((e): e is Omit<PoolEvent, "hostId"> => e !== null),
  ];
  recordPoolEvents(hostId, rows);
}

/**
 * Newest first and capped, plus the true count.
 *
 * The count is the point. A first attempt capped silently, which truncated the
 * alerts view without saying so; removing the cap outright then shipped all 35k.
 * Both were wrong in the same way -- the caller could not tell what it was
 * looking at. Every response now carries `total`, and the views name it.
 */
function alertPayload(alerts: XenAlert[]): { alerts: XenAlert[]; alertTotal: number } {
  const sorted = [...alerts].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    alerts: sorted.slice(0, MAX_ALERTS_TO_CLIENT),
    alertTotal: sorted.length,
  };
}

// ── Event parsing: convert raw XAPI events to typed ParsedXenEvent[] ──

const TRACKED_CLASSES = new Set([
  "vm", "host", "pool", "sr", "network", "pif", "host_metrics", "message", "task",
]);

function parseXenEvents(rawEvents: XenRawEvent[]): ParsedXenEvent[] {
  const parsed: ParsedXenEvent[] = [];
  for (const evt of rawEvents) {
    const cls = evt.class.toLowerCase();
    if (!TRACKED_CLASSES.has(cls)) continue;

    if (evt.operation === "del") {
      if (cls === "host_metrics") continue; // host_metrics del is not useful
      parsed.push({
        class: cls as "vm" | "host" | "pool" | "sr" | "network" | "pif" | "message" | "task",
        operation: "del",
        ref: evt.ref,
      });
      continue;
    }

    if (!evt.snapshot) continue;

    switch (cls) {
      case "vm": {
        const vm = parseSingleVm(evt.ref, evt.snapshot);
        // Skip templates, control domains, snapshots
        if (vm.isATemplate || vm.isControlDomain || vm.isASnapshot) continue;
        parsed.push({ class: "vm", operation: evt.operation, ref: evt.ref, data: vm });
        break;
      }
      case "host":
        parsed.push({ class: "host", operation: evt.operation, ref: evt.ref, data: parseSingleHost(evt.ref, evt.snapshot) });
        break;
      case "pool":
        parsed.push({ class: "pool", operation: evt.operation, ref: evt.ref, data: parseSinglePool(evt.ref, evt.snapshot) });
        break;
      case "sr": {
        const sr = parseSingleSR(evt.ref, evt.snapshot);
        if (sr.physicalSize <= 0 && evt.operation === "add") continue; // Skip zero-size SRs on add
        parsed.push({ class: "sr", operation: evt.operation, ref: evt.ref, data: sr });
        break;
      }
      case "network":
        parsed.push({ class: "network", operation: evt.operation, ref: evt.ref, data: parseSingleNetwork(evt.ref, evt.snapshot) });
        break;
      case "pif":
        parsed.push({ class: "pif", operation: evt.operation, ref: evt.ref, data: parseSinglePIF(evt.ref, evt.snapshot) });
        break;
      case "host_metrics":
        parsed.push({
          class: "host_metrics",
          operation: "mod",
          ref: evt.ref,
          data: {
            memoryTotal: Number(evt.snapshot.memory_total || 0),
            memoryFree: Number(evt.snapshot.memory_free || 0),
          },
        });
        break;
      case "message":
        parsed.push({ class: "message", operation: evt.operation, ref: evt.ref, data: parseSingleMessage(evt.ref, evt.snapshot) });
        break;
      case "task":
        parsed.push({ class: "task", operation: evt.operation, ref: evt.ref, data: parseSingleTask(evt.ref, evt.snapshot) });
        break;
    }
  }
  return parsed;
}

function parseVBDRecords(
  raw: Record<string, Record<string, unknown>>,
): XenVBDRecord[] {
  return Object.entries(raw).map(([ref, r]) => ({
    uuid: r.uuid as string,
    ref,
    vm: r.VM as string,
    vdi: r.VDI as string,
    device: r.device as string,
    type: r.type as string,
    mode: r.mode as string,
    currentlyAttached: r.currently_attached as boolean,
  }));
}

function parseVDIRecords(
  raw: Record<string, Record<string, unknown>>,
): XenVDIRecord[] {
  return Object.entries(raw).map(([ref, r]) => ({
    uuid: r.uuid as string,
    ref,
    nameLabel: r.name_label as string,
    sr: r.SR as string,
    virtualSize: Number(r.virtual_size || 0),
    physicalUtilisation: Number(r.physical_utilisation || 0),
    type: r.type as string,
  }));
}

function parseVIFRecords(
  raw: Record<string, Record<string, unknown>>,
): XenVIFRecord[] {
  return Object.entries(raw).map(([ref, r]) => ({
    uuid: r.uuid as string,
    ref,
    device: r.device as string,
    network: r.network as string,
    vm: r.VM as string,
    mac: r.MAC as string,
    currentlyAttached: r.currently_attached as boolean,
  }));
}

interface SshExportJob {
  status: "running" | "success" | "failure";
  error?: string;
  targetPath?: string;
  startedAt: number;
  finishedAt?: number;
}

// Use globalThis so the Map survives HMR module reloads in dev mode
const g = globalThis as typeof globalThis & { _sshExportJobs?: Map<string, SshExportJob> };
if (!g._sshExportJobs) g._sshExportJobs = new Map();
const sshExportJobs = g._sshExportJobs;

function runSshCommand(
  poolId: string,
  sshHost: string,
  sshPort: number,
  username: string,
  password: string,
  cmd: string,
  jobId: string,
) {
  const conn = new SshClient();
  // The host key seen first is remembered; another one later stops the
  // connection before the password is sent (lib/host-trust.ts).
  let keyRefused = false;
  conn.on("ready", () => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        const prev = sshExportJobs.get(jobId);
        sshExportJobs.set(jobId, { status: "failure", error: err.message, startedAt: prev?.startedAt ?? Date.now(), finishedAt: Date.now() });
        conn.end();
        return;
      }
      let stdout = "";
      let stderr = "";
      // Consume stdout — xe prints progress there; not reading it fills the SSH
      // channel buffer and blocks the remote process, preventing it from finishing.
      stream.on("data", (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      stream.on("close", (code: number) => {
        const prev = sshExportJobs.get(jobId);
        const startedAt = prev?.startedAt ?? Date.now();
        const targetPath = prev?.targetPath;
        if (code === 0) {
          sshExportJobs.set(jobId, { status: "success", startedAt, targetPath, finishedAt: Date.now() });
        } else {
          const errorMsg = stderr.trim() || stdout.trim() || `Exit code ${code}`;
          sshExportJobs.set(jobId, { status: "failure", error: errorMsg, startedAt, targetPath, finishedAt: Date.now() });
        }
        conn.end();
      });
    });
  });
  conn.on("error", (err) => {
    const prev = sshExportJobs.get(jobId);
    const error = keyRefused
      ? `The SSH host key of ${sshHost} has changed. XenMan did not connect. An admin can review it in Settings → Pools.`
      : err.message;
    sshExportJobs.set(jobId, { status: "failure", error, startedAt: prev?.startedAt ?? Date.now(), finishedAt: Date.now() });
  });
  conn.connect({
    host: sshHost,
    port: sshPort,
    username,
    password,
    readyTimeout: 15000,
    hostVerifier: (key: Buffer) => {
      const ok = checkSshKey(poolId, sshHost, sshKeyFingerprint(key));
      if (!ok) keyRefused = true;
      return ok;
    },
  });
}

const READ_ONLY_ACTIONS = new Set([
  "connect", "disconnect", "refresh", "host_metrics",
  "vm_isos", "vm_srs", "vm_disks", "vm_nics",
  "vm_templates", "vm_get_boot_params", "vm_get_platform",
  "pool_networks", "task_status", "network_job_status", "gpu_overview", "memory_overview", "vm_memory_job_status", "host_dom0_job_status", "pool_member_job_status", "license_overview",
  "vm_export_status", "vm_snapshots", "vm_guest_metrics", "pool_wlb_status", "host_networking",
  "vm_copy_check", "vm_snapshot_to_template_check", "vm_import_targets", "vm_gpu", "sr_states", "host_maintenance_job_status",
  "event_register", "event_poll", "event_poll_multi", "alerts_fetch", "rrd", "rrd_sources",
]);

/**
 * How long a bundled poll waits for any pool to have news.
 *
 * Under the pump's own event.from timeout, so the request returns regularly
 * even on a silent estate — which is also what tells the pump its browser is
 * still there and keeps it from shutting down as idle.
 */
const EVENT_DRAIN_TIMEOUT_MS = 25_000;

/**
 * Pools one event_poll_multi may cover. Not a tuning knob -- a bound on how much
 * work one request can ask for, so a malformed body cannot fan out arbitrarily.
 */
const MAX_POLLED_POOLS = 32;

const ADMIN_ONLY_ACTIONS = new Set([
  "pool_join", "pool_set_name_label", "sr_create",
  // XenCenter's SR menu: repair, detach, forget, destroy, set as default, reclaim space.
  "sr_command",
  "pool_wlb_connect", "pool_wlb_disconnect", "pool_wlb_set_enabled", "pool_wlb_configure", "pool_wlb_apply",
  // A pool's networks: what XenCenter's Networking tab changes.
  "network_create", "network_update", "network_destroy", "network_configure_ip", "network_management_change",
  "host_console", "host_evacuate", "host_disable", "host_enable",
  "host_maintenance_enter", "host_maintenance_exit",
  "host_restart_toolstack",
  // The control domain's memory, and with it a reboot of the server.
  "host_control_domain_memory",
  // Servers in and out of the pool (XenCenter's Add Server, Remove From Pool).
  "pool_add_server_check", "pool_add_server", "pool_remove_server",
  // The pool's licence (License Manager).
  "license_assign", "license_release",
  // GPUs: placement policy, allowed vGPU types.
  "gpu_set_placement", "gpu_set_enabled_types",
  // Recording a data source costs the host memory and disk for its RRD.
  "rrd_record",
]);

const isXenRef = (r: unknown): r is string => typeof r === "string" && /^OpaqueRef:[\w-]+$/.test(r);

// The SSH exports run `xe` in a shell on a pool host as root, with values the
// browser sends: each is checked to be what it claims, then quoted.
const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** An absolute directory of plain characters, no "..": or null. Trailing slashes dropped. */
function exportDirOf(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 1024) return null;
  const dir = v.trim().replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._ \/-]*$/.test(dir) || dir.split("/").includes("..")) return null;
  return dir;
}
/** A word for sh: in single quotes, which nothing inside can end. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The file name part from a VM's or disk's name: plain characters only. */
const exportFileStem = (v: unknown) => (typeof v === "string" && v ? v : "export").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);

/** The data sources a graph asks for with its data: none, or a short checked list. */
function parseSourceRequests(input: unknown): SourceRequest[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 32) return null;
  const out: SourceRequest[] = [];
  for (const raw of input) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.source !== "string" || !SOURCE_RE.test(r.source)) return null;
    if (typeof r.units !== "string" || r.units.length > 32) return null;
    if (!out.some((x) => x.source === r.source)) out.push({ source: r.source, units: r.units });
  }
  return out;
}

// The action dispatcher. Wrapped by POST() below, which audits the outcome —
// keeping the audit concern in one place instead of in each of the ~75 cases.
async function dispatch(request: NextRequest) {
  let actionName = "unknown";
  try {
    const body = await request.json();
    actionName = body.action || "unknown";
    const {
      action,
      sessionRef,
      vmRef,
      powerAction,
      metricsRef,
      hostRef,
    } = body;

    // The connection target is authoritative from the server side: for `connect`
    // it comes from the stored host record, for every other action from the
    // session registry. The body values are only a starting point and are
    // overwritten below — a client cannot aim a request at a pool of its choosing.
    let host = body.host;
    // The pool the session belongs to: for addresses behind NAT (lib/nat.ts).
    let poolOfSession: string | undefined;
    let port = body.port;
    let useSsl = body.useSsl;

    // Auth & role check
    const auth = authenticateRequest(request);
    if (!auth) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    if (ADMIN_ONLY_ACTIONS.has(action) && auth.role !== "admin") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    if (!READ_ONLY_ACTIONS.has(action) && !ADMIN_ONLY_ACTIONS.has(action) && auth.role === "viewer") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // Pool authorization for everything that runs on an existing session.
    // `connect` carries a hostId instead and checks itself; `event_poll_multi`
    // carries one session per pool and runs the same three checks on each.
    if (action !== "connect" && action !== "event_poll_multi") {
      const bound = lookupSession(sessionRef);
      if (!bound) {
        // Unknown ref — either never issued here or lost to a restart. The
        // client treats this like any connection error and reconnects.
        return NextResponse.json(
          { error: "Session expired, please reconnect" },
          { status: 401 },
        );
      }
      if (bound.actor.toLowerCase() !== auth.sub.toLowerCase()) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }
      // Re-checked per request so revoking a grant takes effect immediately,
      // without waiting for the user to reconnect.
      if (!mayAccessHost(auth, bound.hostId)) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }
      host = bound.address;
      port = bound.port;
      useSsl = bound.useSsl;
      poolOfSession = bound.hostId;
    }

    switch (action) {
      case "connect": {
        // The client sends only a host id; address and credentials are read
        // here so the browser never holds them.
        const { hostId } = body;
        if (!hostId) {
          return NextResponse.json({ error: "Missing hostId" }, { status: 400 });
        }
        if (!mayAccessHost(auth, hostId)) {
          return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
        }
        const configured = loadHostsFromDisk().find((h) => h.id === hostId);
        if (!configured) {
          return NextResponse.json({ error: "Host not found" }, { status: 404 });
        }
        if (configured.passwordUnreadable) {
          return NextResponse.json({ error: "The stored password of this pool could not be read -- it was saved by another XenMan installation. Enter it again under Settings → Pools → Edit." }, { status: 409 });
        }

        port = configured.port;
        useSsl = configured.useSsl;

        // Primary address first, then the optional backup. This loop used to
        // live in the client, which no longer knows any addresses.
        const candidates = [configured.address];
        if (configured.backupAddress?.trim()) {
          candidates.push(configured.backupAddress.trim());
        }

        let connectHost = configured.address;
        let session: string | null = null;
        let lastError: unknown = null;
        // A refused certificate does not stop the backup address from being
        // tried -- it is checked as well -- but is what is reported if nothing answers.
        let refused: CertMismatchError | null = null;

        for (const candidate of candidates) {
          try {
            connectHost = candidate;
            session = await loginToHost(
              candidate,
              port,
              useSsl,
              configured.username,
              configured.password,
            );
            break;
          } catch (err) {
            // A slave answers HOST_IS_SLAVE and names the pool master in
            // error.data[0] — retry there before trying the next address.
            if (
              err instanceof XenApiError &&
              err.message === "HOST_IS_SLAVE" &&
              err.data &&
              err.data.length > 0
            ) {
              // Behind NAT the member names the coordinator's own address (lib/nat.ts).
              const coordinatorAt = reachableAt(hostId, err.data[0] as string);
              connectHost = coordinatorAt.host;
              port = coordinatorAt.port ?? port;
              try {
                session = await loginToHost(
                  connectHost,
                  port,
                  useSsl,
                  configured.username,
                  configured.password,
                );
                break;
              } catch (masterErr) {
                if (masterErr instanceof CertMismatchError) refused = masterErr;
                lastError = masterErr;
                continue;
              }
            }
            if (err instanceof CertMismatchError) refused = err;
            lastError = err;
          }
        }

        if (!session) {
          if (refused) throw refused;
          if (lastError instanceof XenApiError && lastError.message === "SESSION_AUTHENTICATION_FAILED") {
            throw new Error(loginRefusedMessage(lastError, configured.username));
          }
          throw lastError instanceof Error
            ? lastError
            : new Error("Connection failed");
        }

        host = connectHost;
        const redirectedToMaster = connectHost !== configured.address;

        // Bind the session so later actions can be authorized without trusting
        // the client's host/port.
        registerSession(session, {
          hostId,
          actor: auth.sub,
          address: connectHost,
          port,
          useSsl,
        });

        // The members' certificates, from the pool over this checked connection,
        // so performance data and consoles on them are trusted too.
        await learnPool(hostId, connectHost, port, useSsl, session);

        const [vmRaw, hostRaw, poolRaw, srRaw, netRaw, pifRaw, vmMetricsRaw, poolEventData] = await Promise.all([
          getAllVmRecords(connectHost, port, useSsl, session),
          getAllHostRecords(connectHost, port, useSsl, session),
          getAllPoolRecords(connectHost, port, useSsl, session),
          getAllSRRecords(connectHost, port, useSsl, session),
          getAllNetworkRecords(connectHost, port, useSsl, session),
          getAllPIFRecords(connectHost, port, useSsl, session),
          getAllVmMetrics(connectHost, port, useSsl, session),
          fetchAlertsAndTasks(connectHost, port, useSsl, session),
        ]);

        const vms = parseVmRecords(vmRaw, vmMetricsRaw).filter(
          (vm) => !vm.isATemplate && !vm.isControlDomain,
        );
        const hosts = parseHostRecords(hostRaw);
        const pools = parsePoolRecords(poolRaw);
        const srs = parseSRRecords(srRaw).filter((sr) => sr.physicalSize > 0);
        const networks = parseNetworkRecords(netRaw);
        const pifs = parsePIFRecords(pifRaw);

        // Fetch metrics for each host
        const hostsWithMetrics = await Promise.all(
          hosts.map(async (h) => {
            try {
              const metrics = await getHostMetrics(
                connectHost,
                port,
                useSsl,
                session,
                h.metrics,
              );
              return {
                ...h,
                memoryTotal: Number(metrics.memory_total || 0),
                memoryFree: Number(metrics.memory_free || 0),
              };
            } catch {
              return h;
            }
          }),
        );

        // Feed the audit log's ref → name cache from records we already hold.
        rememberRefNames(vms);
        rememberRefNames(hosts);
        rememberRefNames(pools);
        rememberRefNames(srs);
        rememberRefNames(networks);

        // Recorded after rememberRefNames above: an alert only carries the
        // object uuid, and the store keeps the resolved name with the row.
        const { alerts, poolTasks } = poolEventData;
        recordAlertsAndTasks(hostId, alerts, poolTasks);

        return NextResponse.json({
          sessionRef: session,
          vms,
          hosts: hostsWithMetrics,
          pools,
          srs,
          networks,
          pifs,
          ...alertPayload(alerts),
          ...(redirectedToMaster && { redirectedTo: connectHost }),
        });
      }

      case "disconnect": {
        await logout(host, port, useSsl, sessionRef);
        removeSession(sessionRef);
        // The pump notices a removed session on its own, but only after its
        // current event.from returns. Stopping it here closes that gap.
        stopPump(sessionRef);
        return NextResponse.json({ success: true });
      }

      case "refresh": {
        // Deliberately no alerts or tasks here. A refresh runs after every
        // action, and on a pool with a thousand unacknowledged messages that
        // meant two extra XAPI round trips plus a few hundred KB of alerts per
        // VM start. `connect` seeds them, alerts_fetch and event_poll keep them
        // current, and both of those also feed the store — so nothing is lost.
        const [vmRaw, hostRaw, srRaw, netRaw, pifRaw, vmMetricsRaw] = await Promise.all([
          getAllVmRecords(host, port, useSsl, sessionRef),
          getAllHostRecords(host, port, useSsl, sessionRef),
          getAllSRRecords(host, port, useSsl, sessionRef),
          getAllNetworkRecords(host, port, useSsl, sessionRef),
          getAllPIFRecords(host, port, useSsl, sessionRef),
          getAllVmMetrics(host, port, useSsl, sessionRef),
        ]);

        const vms = parseVmRecords(vmRaw, vmMetricsRaw).filter(
          (vm) => !vm.isATemplate && !vm.isControlDomain,
        );
        const hosts = parseHostRecords(hostRaw);
        const srs = parseSRRecords(srRaw).filter((sr) => sr.physicalSize > 0);
        const networks = parseNetworkRecords(netRaw);
        const pifs = parsePIFRecords(pifRaw);

        const hostsWithMetrics = await Promise.all(
          hosts.map(async (h) => {
            try {
              const metrics = await getHostMetrics(
                host,
                port,
                useSsl,
                sessionRef,
                h.metrics,
              );
              return {
                ...h,
                memoryTotal: Number(metrics.memory_total || 0),
                memoryFree: Number(metrics.memory_free || 0),
              };
            } catch {
              return h;
            }
          }),
        );

        rememberRefNames(vms);
        rememberRefNames(hosts);
        rememberRefNames(srs);
        rememberRefNames(networks);

        return NextResponse.json({ vms, hosts: hostsWithMetrics, srs, networks, pifs });
      }

      case "vm_power": {
        await vmPowerAction(host, port, useSsl, sessionRef, vmRef, powerAction);
        return NextResponse.json({ success: true });
      }

      case "vm_start_on": {
        const { targetHostRef } = body;
        await vmStartOn(host, port, useSsl, sessionRef, vmRef, targetHostRef);
        return NextResponse.json({ success: true });
      }

      case "vm_delete": {
        // 1. Get all VBDs and VIFs for this VM
        const [vmVbds, vmVifs] = await Promise.all([
          vmGetVBDs(host, port, useSsl, sessionRef, vmRef),
          vmGetVIFs(host, port, useSsl, sessionRef, vmRef),
        ]);

        // 2. For each VBD: unplug if attached, get VDI ref, destroy VBD, destroy VDI (if non-shared disk)
        for (const vbdRef of vmVbds) {
          try {
            const vbdRec = await vbdGetRecord(host, port, useSsl, sessionRef, vbdRef) as {
              VDI: string; type: string; currently_attached: boolean;
            };
            // Unplug if attached
            if (vbdRec.currently_attached) {
              try { await vbdUnplug(host, port, useSsl, sessionRef, vbdRef); } catch { /* may fail if halted */ }
            }
            // Destroy the VBD
            await vbdDestroy(host, port, useSsl, sessionRef, vbdRef);
            // Destroy the VDI if it's a Disk type and has a valid VDI ref
            if (vbdRec.type === "Disk" && vbdRec.VDI && vbdRec.VDI !== "OpaqueRef:NULL") {
              try { await vdiDestroy(host, port, useSsl, sessionRef, vbdRec.VDI); } catch { /* VDI may be shared */ }
            }
          } catch {
            // Continue cleanup even if individual VBD fails
          }
        }

        // 3. Destroy all VIFs
        for (const vifRef of vmVifs) {
          try {
            try { await vifUnplug(host, port, useSsl, sessionRef, vifRef); } catch { /* may fail if halted */ }
            await vifDestroy(host, port, useSsl, sessionRef, vifRef);
          } catch {
            // Continue cleanup
          }
        }

        // 4. Destroy the VM itself
        await vmDestroy(host, port, useSsl, sessionRef, vmRef);
        return NextResponse.json({ success: true });
      }

      case "vm_migrate": {
        const { targetHostRef } = body;
        const taskRef = await vmMigrateAsync(host, port, useSsl, sessionRef, vmRef, targetHostRef);
        return NextResponse.json({ taskRef });
      }

      case "vm_set_name": {
        await vmSetNameLabel(host, port, useSsl, sessionRef, vmRef, body.value);
        return NextResponse.json({ success: true });
      }

      case "vm_set_description": {
        await vmSetNameDescription(host, port, useSsl, sessionRef, vmRef, body.value);
        return NextResponse.json({ success: true });
      }

      case "vm_set_vcpus_max": {
        await vmSetVCPUsMax(host, port, useSsl, sessionRef, vmRef, body.value);
        return NextResponse.json({ success: true });
      }

      case "vm_set_vcpus_startup": {
        await vmSetVCPUsAtStartup(host, port, useSsl, sessionRef, vmRef, body.value);
        return NextResponse.json({ success: true });
      }

      case "vm_set_memory_limits": {
        const { staticMin, staticMax, dynMin, dynMax } = body;
        await vmSetMemoryLimits(host, port, useSsl, sessionRef, vmRef, staticMin, staticMax, dynMin, dynMax);
        return NextResponse.json({ success: true });
      }

      case "vm_add_tag": {
        await vmAddTag(host, port, useSsl, sessionRef, vmRef, body.tag);
        return NextResponse.json({ success: true });
      }

      case "vm_remove_tag": {
        await vmRemoveTag(host, port, useSsl, sessionRef, vmRef, body.tag);
        return NextResponse.json({ success: true });
      }

      case "vm_set_folder": {
        const folder = body.folder as string | null;
        try { await vmRemoveFromOtherConfig(host, port, useSsl, sessionRef, vmRef, "folder"); } catch { /* key may not exist */ }
        if (folder) {
          await vmAddToOtherConfig(host, port, useSsl, sessionRef, vmRef, "folder", folder);
        }
        return NextResponse.json({ success: true });
      }

      case "pool_set_empty_folders": {
        const { poolRef, folders } = body as { poolRef: string; folders: string[] };
        const normalized = (folders ?? [])
          .map((f: string) => String(f).trim().replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/"))
          .filter(Boolean);
        try { await poolRemoveFromOtherConfig(host, port, useSsl, sessionRef, poolRef, "EMPTY_FOLDERS"); } catch { /* ok */ }
        if (normalized.length > 0) {
          await poolAddToOtherConfig(host, port, useSsl, sessionRef, poolRef, "EMPTY_FOLDERS", normalized.join(";"));
        }
        return NextResponse.json({ success: true });
      }

      case "vdi_resize": {
        await vdiResize(host, port, useSsl, sessionRef, body.vdiRef, body.size);
        return NextResponse.json({ success: true });
      }

      case "disk_create": {
        const { srRef, nameLabel: diskName, nameDescription: diskDesc, sizeBytes, bootable } = body;
        // Create VDI
        const vdiRef = await vdiCreate(
          host, port, useSsl, sessionRef,
          srRef, diskName || "New Disk", diskDesc || "", Number(sizeBytes), "user",
        );
        // Get next available device number for this VM
        const allowedDiskDevices = await vmGetAllowedVBDDevices(host, port, useSsl, sessionRef, vmRef);
        const device = allowedDiskDevices[0] || "0";
        // Create VBD to attach VDI to VM
        const vbdRef = await vbdCreate(
          host, port, useSsl, sessionRef,
          vmRef, vdiRef, device, !!bootable,
        );
        // If VM is running, plug the VBD
        const vmRecords = await getAllVmRecords(host, port, useSsl, sessionRef);
        const vmRecord = parseVmRecords(vmRecords).find((v) => v.ref === vmRef);
        if (vmRecord?.powerState === "Running") {
          try {
            await vbdPlug(host, port, useSsl, sessionRef, vbdRef);
          } catch {
            // VBD plug may fail if device not supported while running
          }
        }
        return NextResponse.json({ vdiRef, vbdRef, device });
      }

      case "disk_delete": {
        const { vbdRef: delVbdRef, vdiRef: delVdiRef, currentlyAttached } = body;
        if (currentlyAttached) {
          try {
            // Unplug VBD first if attached
            await vbdUnplug(host, port, useSsl, sessionRef, delVbdRef);
          } catch {
            // May fail if VM is halted
          }
        }
        await vbdDestroy(host, port, useSsl, sessionRef, delVbdRef);
        if (delVdiRef) {
          await vdiDestroy(host, port, useSsl, sessionRef, delVdiRef);
        }
        return NextResponse.json({ success: true });
      }

      case "vm_isos": {
        const [srRawIso, vdiRawIso] = await Promise.all([
          getAllSRRecords(host, port, useSsl, sessionRef),
          getAllVDIRecords(host, port, useSsl, sessionRef),
        ]);
        const allSrsIso = parseSRRecords(srRawIso);
        const isoSrRefs = new Set(allSrsIso.filter((sr) => sr.type === "iso").map((sr) => sr.ref));
        const allVdisIso = parseVDIRecords(vdiRawIso);
        const isos = allVdisIso
          .filter((vdi) => isoSrRefs.has(vdi.sr))
          .map((vdi) => {
            const sr = allSrsIso.find((s) => s.ref === vdi.sr);
            return { ref: vdi.ref, nameLabel: vdi.nameLabel, srRef: vdi.sr, srName: sr?.nameLabel || "" };
          })
          .sort((a, b) => a.nameLabel.localeCompare(b.nameLabel));
        return NextResponse.json({ isos });
      }

      case "cd_insert": {
        const { vbdRef: insertVbdRef, vdiRef: insertVdiRef } = body;
        await vbdInsert(host, port, useSsl, sessionRef, insertVbdRef, insertVdiRef);
        return NextResponse.json({ success: true });
      }

      case "cd_eject": {
        const { vbdRef: ejectVbdRef } = body;
        await vbdEject(host, port, useSsl, sessionRef, ejectVbdRef);
        return NextResponse.json({ success: true });
      }

      case "cd_add": {
        const allowedDevices = await vmGetAllowedVBDDevices(host, port, useSsl, sessionRef, vmRef);
        if (allowedDevices.length === 0) {
          return NextResponse.json({ error: "No available device slots" }, { status: 400 });
        }
        const cdDevice = allowedDevices[0];
        const cdVbdRef = await vbdCreateCd(host, port, useSsl, sessionRef, vmRef, cdDevice);
        return NextResponse.json({ vbdRef: cdVbdRef, device: cdDevice });
      }

      case "cd_remove": {
        const { vbdRef: rmVbdRef, currentlyAttached: rmAttached } = body;
        if (rmAttached) {
          try { await vbdUnplug(host, port, useSsl, sessionRef, rmVbdRef); } catch { /* ignore */ }
        }
        await vbdDestroy(host, port, useSsl, sessionRef, rmVbdRef);
        return NextResponse.json({ success: true });
      }

      case "vm_srs": {
        const srRaw = await getAllSRRecords(host, port, useSsl, sessionRef);
        const srs = parseSRRecords(srRaw)
          .filter((sr) => sr.physicalSize > 0 && !["iso", "udev"].includes(sr.type));
        return NextResponse.json({ srs });
      }

      case "sr_create": {
        const { hostRef, nameLabel: srName, nameDescription: srDesc, srType, deviceConfig, shared, contentType } = body;
        const srRef = await srCreate(
          host, port, useSsl, sessionRef,
          hostRef, deviceConfig || {}, srName || "", srDesc || "",
          srType, contentType || "", !!shared, {},
        );
        return NextResponse.json({ srRef });
      }

      case "sr_scan": {
        const { srRef: scanSrRef } = body;
        await srScan(host, port, useSsl, sessionRef, scanSrRef);
        return NextResponse.json({ success: true });
      }

      case "vm_set_boot_order": {
        const bootParams = await vmGetHVMBootParams(host, port, useSsl, sessionRef, vmRef);
        bootParams["order"] = body.value;
        await vmSetHVMBootParamsMap(host, port, useSsl, sessionRef, vmRef, bootParams);
        return NextResponse.json({ success: true });
      }

      case "vm_get_boot_params": {
        const params = await vmGetHVMBootParams(host, port, useSsl, sessionRef, vmRef);
        return NextResponse.json({ params });
      }

      case "vm_get_platform": {
        const platform = await vmGetPlatform(host, port, useSsl, sessionRef, vmRef);
        return NextResponse.json({ platform });
      }

      case "vm_set_firmware": {
        const { firmware: fwValue, secureboot } = body as { firmware: string; secureboot: boolean };

        // Set HVM boot params firmware (canonical firmware selector)
        const hvmParams = await vmGetHVMBootParams(host, port, useSsl, sessionRef, vmRef);
        hvmParams["firmware"] = fwValue === "bios" ? "bios" : "uefi";
        await vmSetHVMBootParamsMap(host, port, useSsl, sessionRef, vmRef, hvmParams);

        // Set platform secureboot flag — do NOT set platform["firmware"]
        const platform = await vmGetPlatform(host, port, useSsl, sessionRef, vmRef);
        platform["secureboot"] = secureboot ? "true" : "false";
        await vmSetPlatform(host, port, useSsl, sessionRef, vmRef, platform);

        // Create vTPM for Secure Boot if not already present
        if (secureboot) {
          const vtpms = await vmGetVTPMs(host, port, useSsl, sessionRef, vmRef);
          if (vtpms.length === 0) {
            try {
              await vtpmCreate(host, port, useSsl, sessionRef, vmRef, false);
            } catch (e) {
              console.warn("vTPM creation failed:", e instanceof Error ? e.message : e);
            }
          }
        }

        return NextResponse.json({ success: true });
      }

      case "rrd": {
        // Performance data, asked of the host that keeps it -- the VM's own,
        // or the host itself -- at the address XAPI gives for it, never one
        // the browser names. The pool session is valid on every member.
        const { period } = body;
        if (!isRrdPeriod(period)) {
          return NextResponse.json({ error: "Invalid period" }, { status: 400 });
        }
        const requests = parseSourceRequests(body.sources);
        if (!requests) {
          return NextResponse.json({ error: "Invalid data sources" }, { status: 400 });
        }
        const isRef = isXenRef;
        const xapi = <T,>(method: string, ...params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        if (body.pool === true) {
          // Every host's own export, side by side; one that does not answer
          // is left out and named rather than failing the whole pool.
          const [refs, master] = await Promise.all([
            xapi<string[]>("host.get_all"),
            xapi<string[]>("pool.get_all").then((p) => xapi<string>("pool.get_master", p[0])),
          ]);
          const results = await Promise.allSettled(
            refs.map(async (ref) => {
              const [name, uuid, address] = await Promise.all([
                xapi<string>("host.get_name_label", ref),
                xapi<string>("host.get_uuid", ref),
                xapi<string>("host.get_address", ref),
              ]);
              try {
                const at = reachableAt(poolOfSession, address);
                return { name, uuid, isCoordinator: ref === master, rrd: await fetchRrdCached(at.host, at.port ?? port, useSsl, sessionRef, period, poolOfSession) };
              } catch (err) {
                throw new Error(name, { cause: err });
              }
            }),
          );
          const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
          const missing = results.flatMap((r) => (r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : "a host"] : []));
          // The coordinator first, then by name.
          ok.sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator) || a.name.localeCompare(b.name));
          return NextResponse.json({ ...poolCharts(ok, requests), ...(missing.length ? { missing } : {}) });
        }
        let target: string;
        let kind: "host" | "vm";
        let uuid: string;
        if (isRef(vmRef)) {
          const [state, residentOn, vmUuid] = await Promise.all([
            xapi<string>("VM.get_power_state", vmRef),
            xapi<string>("VM.get_resident_on", vmRef),
            xapi<string>("VM.get_uuid", vmRef),
          ]);
          if (state !== "Running" && state !== "Paused") {
            return NextResponse.json({ notRunning: true, step: 0, times: [], charts: [] });
          }
          [target, kind, uuid] = [residentOn, "vm", vmUuid];
        } else if (isRef(hostRef)) {
          [target, kind, uuid] = [hostRef, "host", await xapi<string>("host.get_uuid", hostRef)];
        } else {
          return NextResponse.json({ error: "Missing vmRef or hostRef" }, { status: 400 });
        }
        const at = reachableAt(poolOfSession, await xapi<string>("host.get_address", target));
        const rrd = await fetchRrdCached(at.host, at.port ?? port, useSsl, sessionRef, period, poolOfSession);
        return NextResponse.json(perfCharts(rrd, kind, uuid, requests));
      }

      case "rrd_sources": {
        // What XenServer can record for a VM or a host, recorded or not; for
        // a pool the coordinator's list, the hosts' being alike.
        const xapi = <T,>(method: string, ...params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        let records: Record<string, unknown>[];
        if (isXenRef(vmRef)) {
          const state = await xapi<string>("VM.get_power_state", vmRef);
          if (state !== "Running" && state !== "Paused") return NextResponse.json({ notRunning: true, sources: [] });
          records = await xapi("VM.get_data_sources", vmRef);
        } else if (isXenRef(hostRef)) {
          records = await xapi("host.get_data_sources", hostRef);
        } else if (body.pool === true) {
          const pools = await xapi<string[]>("pool.get_all");
          records = await xapi("host.get_data_sources", await xapi<string>("pool.get_master", pools[0]));
        } else {
          return NextResponse.json({ error: "Missing vmRef or hostRef" }, { status: 400 });
        }
        const sources = records
          .map((r) => ({
            name: String(r.name_label ?? ""),
            description: String(r.name_description ?? ""),
            units: String(r.units ?? ""),
            enabled: r.enabled === true,
            standard: r.standard === true,
          }))
          .filter((r) => SOURCE_RE.test(r.name) && !r.name.includes("*"))
          .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
        return NextResponse.json({ sources });
      }

      case "rrd_record": {
        // Starts recording data sources that were not: on the VM, the host,
        // or for a pool on every host. Admins only (ADMIN_ONLY_ACTIONS).
        const names = body.sources;
        if (
          !Array.isArray(names) ||
          names.length === 0 ||
          names.length > 64 ||
          !names.every((n) => typeof n === "string" && SOURCE_RE.test(n) && !n.includes("*"))
        ) {
          return NextResponse.json({ error: "Invalid data sources" }, { status: 400 });
        }
        const xapi = <T,>(method: string, ...params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        let calls: [string, string][];
        if (isXenRef(vmRef)) calls = [["VM.record_data_source", vmRef]];
        else if (isXenRef(hostRef)) calls = [["host.record_data_source", hostRef]];
        else if (body.pool === true) calls = (await xapi<string[]>("host.get_all")).map((h) => ["host.record_data_source", h]);
        else return NextResponse.json({ error: "Missing vmRef or hostRef" }, { status: 400 });
        for (const [method, ref] of calls) {
          for (const n of names as string[]) await xapi(method, ref, n);
        }
        return NextResponse.json({ ok: true });
      }

      case "host_metrics": {
        const metrics = await getHostMetrics(
          host,
          port,
          useSsl,
          sessionRef,
          metricsRef,
        );
        const parsed: XenHostMetrics = {
          memoryTotal: Number(metrics.memory_total || 0),
          memoryFree: Number(metrics.memory_free || 0),
          live: metrics.live as boolean,
          lastUpdated: metrics.last_updated as string,
        };
        return NextResponse.json(parsed);
      }

      case "vm_console": {
        // A console takes keyboard and mouse: not for viewers (vm_console is
        // not read-only). A host's control domain only through host_console,
        // which is for administrators.
        if (await xenApiCall<boolean>(host, port, useSsl, "VM.get_is_control_domain", [sessionRef, vmRef])) {
          return NextResponse.json({ error: "The control domain's console is the host console" }, { status: 403 });
        }
        const consoleRefs = await getVmConsoles(
          host,
          port,
          useSsl,
          sessionRef,
          vmRef,
        );
        if (consoleRefs.length === 0) {
          return NextResponse.json({ available: false });
        }
        // Prefer rfb (VNC) console
        let bestConsole: { url: string; protocol: string } | null = null;
        for (const cRef of consoleRefs) {
          const record = await getConsoleRecord(
            host,
            port,
            useSsl,
            sessionRef,
            cRef,
          );
          const protocol = record.protocol as string;
          // Behind NAT: at the address the host is reached at (lib/nat.ts).
          const location = reachableUrl(poolOfSession, record.location as string);
          if (!bestConsole || protocol === "rfb") {
            bestConsole = { url: location, protocol };
          }
        }
        // The console proxy connects only to a console handed out here, for this session.
        if (bestConsole?.url) grantConsole(sessionRef, bestConsole.url);
        return NextResponse.json({
          available: !!bestConsole,
          url: bestConsole?.url || null,
          protocol: bestConsole?.protocol || null,
        });
      }

      case "host_console": {
        const result = await getHostConsoleUrl(
          host,
          port,
          useSsl,
          sessionRef,
          hostRef,
        );
        if (!result) {
          return NextResponse.json({ available: false });
        }
        result.url = reachableUrl(poolOfSession, result.url);
        grantConsole(sessionRef, result.url);
        return NextResponse.json({
          available: true,
          url: result.url,
          protocol: result.protocol,
        });
      }

      case "host_disable": {
        await hostDisable(host, port, useSsl, sessionRef, hostRef);
        return NextResponse.json({ success: true });
      }

      case "host_enable": {
        await hostEnable(host, port, useSsl, sessionRef, hostRef);
        return NextResponse.json({ success: true });
      }

      case "host_add_other_config": {
        const { key, value: val } = body;
        await hostAddToOtherConfig(host, port, useSsl, sessionRef, hostRef, key, val);
        return NextResponse.json({ success: true });
      }

      case "host_remove_other_config": {
        const { key } = body;
        await hostRemoveFromOtherConfig(host, port, useSsl, sessionRef, hostRef, key);
        return NextResponse.json({ success: true });
      }

      case "host_evacuate": {
        const taskRef = await hostEvacuateAsync(host, port, useSsl, sessionRef, hostRef);
        return NextResponse.json({ taskRef });
      }

      // Composite maintenance mode actions — matches XenCenter logic
      case "host_maintenance_enter": {
        // XenCenter's EvacuateHostAction as a job (lib/host-maintenance-job.ts): what stops it
        // asked first, WLB's recommendations followed, the host back out of maintenance on failure.
        if (!isXenRef(hostRef)) return NextResponse.json({ error: "No host given" }, { status: 400 });
        const poolId = lookupSession(sessionRef)?.hostId ?? "";
        const already = runningFor(poolId, hostRef);
        if (already) return NextResponse.json({ job: already });
        const job = await startMaintenance(
          { poolId, address: host, port, useSsl, sessionRef, actor: auth.sub, role: auth.role, ip: clientIp(request) },
          hostRef,
        );
        return NextResponse.json({ job }, { status: 202 });
      }

      case "host_maintenance_job_status": {
        const job = getMaintenanceJob(String(body.jobId ?? ""));
        if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
        return NextResponse.json({ job });
      }

      case "host_maintenance_exit": {
        // 1. Remove MAINTENANCE_MODE flag first (XenCenter order)
        try { await hostRemoveFromOtherConfig(host, port, useSsl, sessionRef, hostRef, "MAINTENANCE_MODE"); } catch { /* key may not exist */ }

        // 2. Enable the host after flag is removed
        await hostEnable(host, port, useSsl, sessionRef, hostRef);
        return NextResponse.json({ success: true });
      }

      case "host_restart_toolstack": {
        await hostRestartAgent(host, port, useSsl, sessionRef, hostRef);
        return NextResponse.json({ success: true });
      }

      case "host_shutdown": {
        await hostDisable(host, port, useSsl, sessionRef, hostRef);
        await hostShutdown(host, port, useSsl, sessionRef, hostRef);
        return NextResponse.json({ success: true });
      }

      case "host_reboot": {
        await hostDisable(host, port, useSsl, sessionRef, hostRef);
        await hostReboot(host, port, useSsl, sessionRef, hostRef);
        return NextResponse.json({ success: true });
      }

      case "pool_join": {
        // The client names the master by id and session; its credentials are
        // read here, never sent from the browser.
        const { masterHostId, masterSessionRef } = body;
        if (!masterHostId) {
          return NextResponse.json({ error: "Missing masterHostId" }, { status: 400 });
        }
        if (!mayAccessHost(auth, masterHostId)) {
          return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
        }
        const master = loadHostsFromDisk().find((h) => h.id === masterHostId);
        if (!master) {
          return NextResponse.json({ error: "Master host not found" }, { status: 404 });
        }
        // Use the address the master session actually resolved to, so a pool
        // reached via backup address or master redirect still joins correctly.
        const masterBound = lookupSession(masterSessionRef);
        if (masterBound && masterBound.actor.toLowerCase() !== auth.sub.toLowerCase()) {
          return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
        }
        const masterAddress = masterBound ? masterBound.address : master.address;
        await poolJoin(
          host, port, useSsl, sessionRef,
          masterAddress, master.username, master.password,
        );
        return NextResponse.json({ success: true });
      }

      case "pool_set_name_label": {
        const { poolRef, value } = body;
        await poolSetNameLabel(host, port, useSsl, sessionRef, poolRef, value);
        return NextResponse.json({ success: true });
      }

      case "host_networking": {
        // The Networking tab, as XenCenter fills it: one host (hostRef), or the pool.
        const hostRef = isXenRef(body.hostRef) ? body.hostRef : null;
        const [networks, pifs, rest, hostRecs, poolRecs] = await Promise.all([
          getAllNetworkRecords(host, port, useSsl, sessionRef),
          getAllPIFRecords(host, port, useSsl, sessionRef),
          getNetworkingRecords(host, port, useSsl, sessionRef),
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllPoolRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
        ]);
        const pool = Object.values(poolRecs)[0] ?? {};
        return NextResponse.json(buildHostNetworking({ networks, pifs, ...rest, hosts: hostRecs, pool }, hostRef));
      }

      case "network_create":
      case "network_update":
      case "network_destroy": {
        // Read fresh, checked in full before anything is written (lib/xen-network-actions.ts).
        const [networks, pifs, vifs, vms, poolRecs, hostRecs, bonds, clusterHosts, more] = await Promise.all([
          getAllNetworkRecords(host, port, useSsl, sessionRef),
          getAllPIFRecords(host, port, useSsl, sessionRef),
          getAllVIFRecords(host, port, useSsl, sessionRef),
          getAllVmRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllPoolRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, "Bond.get_all_records", [sessionRef]),
          // Pools without clustering may not know the class at all.
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, "Cluster_host.get_all_records", [sessionRef]).catch(() => ({})),
          getNetworkingRecords(host, port, useSsl, sessionRef),
        ]);
        const recs: BondRecords = {
          networks, pifs, vifs, vms, pool: Object.values(poolRecs)[0] ?? {}, hosts: hostRecs, bonds, clusterHosts,
          vlans: more.vlans, sriovs: more.sriovs,
        };
        rememberRefNames(Object.entries(networks).map(([ref, n]) => ({ ref, nameLabel: String(n.name_label ?? ""), uuid: String(n.uuid ?? "") })));
        const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        const networkRef = isXenRef(body.networkRef) ? body.networkRef : null;
        if (action !== "network_create" && !networkRef) return NextResponse.json({ error: "Missing networkRef" }, { status: 400 });
        try {
          if (action === "network_create" && body.type === "sriov") {
            const ref = await createSriov(call, recs, body);
            rememberRefNames([{ ref, nameLabel: String(body.name ?? "").trim() }]);
            return NextResponse.json({ success: true, networkRef: ref });
          }
          if (action === "network_create" && body.type === "bond") {
            const made = await createBond(call, recs, body);
            rememberRefNames([{ ref: made.networkRef, nameLabel: made.name }]);
            return NextResponse.json({ success: true, ...made });
          }
          if (action === "network_create") {
            const ref = await createNetwork(call, recs, body);
            rememberRefNames([{ ref, nameLabel: String(body.name ?? "").trim() }]);
            return NextResponse.json({ success: true, networkRef: ref });
          }
          if (action === "network_update") {
            const changes = await updateNetwork(call, recs, networkRef!, body.changes ?? {});
            return NextResponse.json({ success: true, changes });
          }
          // A bond's network goes with its bonds (NetworkList: DestroyBondCommand).
          const isBond = ((networks[networkRef!]?.PIFs as string[] | undefined) ?? []).some(
            (p) => ((pifs[p]?.bond_master_of as string[] | undefined) ?? []).length > 0,
          );
          if (isBond) {
            await destroyBond(call, recs, networkRef!, body.confirmName);
            return NextResponse.json({ success: true });
          }
          await destroyNetwork(call, recs, networkRef!);
          return NextResponse.json({ success: true });
        } catch (err) {
          if (err instanceof NetworkRefused) return NextResponse.json({ error: err.message }, { status: 409 });
          if (err instanceof XapiTaskError) {
            return NextResponse.json({ error: `${err.message}${err.data.length ? ` (${err.data.join(", ")})` : ""}` }, { status: 400 });
          }
          if (err instanceof XenApiError) {
            const data = Array.isArray(err.data) && err.data.length ? ` (${err.data.map(String).join(", ")})` : "";
            return NextResponse.json({ error: `${err.message}${data}` }, { status: 400 });
          }
          throw err;
        }
      }

      case "memory_overview": {
        // XenCenter's Memory tab: a row per live host of the pool; or one host
        // (hostRef) and its VMs -- for those not running, the storage tells where they belong.
        const all = (cls: string) =>
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, `${cls}.get_all_records`, [sessionRef]);
        const memHost = isXenRef(body.hostRef) ? body.hostRef : null;
        const none = Promise.resolve({} as Record<string, Record<string, unknown>>);
        const [pools, hostRecs, hostMetrics, vms, vmMetrics, guestMetrics, vbds, vdis, srs, pbds] = await Promise.all([
          all("pool"),
          all("host"),
          all("host_metrics"),
          all("VM"),
          all("VM_metrics"),
          all("VM_guest_metrics"),
          memHost ? all("VBD") : none,
          memHost ? all("VDI") : none,
          memHost ? all("SR") : none,
          memHost ? all("PBD") : none,
        ]);
        // A VM's own tab (vmRef): only its row.
        const memVm = !memHost && isXenRef(body.vmRef) ? body.vmRef : null;
        return NextResponse.json(
          buildMemoryOverview({ pools, hosts: hostRecs, hostMetrics, vms, vmMetrics, guestMetrics, vbds, vdis, srs, pbds }, memHost, memVm),
        );
      }

      case "vm_memory_change": {
        // XenCenter's "Edit..." on the Memory tab, for one VM or several (lib/vm-memory-job.ts).
        const poolId = lookupSession(sessionRef)?.hostId ?? "";
        const vmRefs: string[] = Array.isArray(body.vmRefs) && body.vmRefs.every(isXenRef) ? body.vmRefs : [];
        if (!vmRefs.length || vmRefs.length > 500) return NextResponse.json({ error: "No VMs chosen" }, { status: 400 });
        const values = { dynamicMin: Number(body.dynamicMin), dynamicMax: Number(body.dynamicMax), staticMax: Number(body.staticMax) };
        const busy = busyVm(poolId, vmRefs);
        if (busy) return NextResponse.json({ error: `The memory of ${busy} is being changed` }, { status: 409 });
        const records = await Promise.all(
          vmRefs.map((ref) => xenApiCall<Record<string, unknown>>(host, port, useSsl, "VM.get_record", [sessionRef, ref])),
        );
        for (const vm of records) {
          if (vm.is_a_template === true || vm.is_a_snapshot === true || vm.is_control_domain === true) {
            return NextResponse.json({ error: `${String(vm.name_label)} is not a VM` }, { status: 400 });
          }
          const problem = valuesProblem(vm, values);
          if (problem) return NextResponse.json({ error: problem }, { status: 400 });
        }
        // A reboot only after the question XenCenter asks has been answered.
        const rebooting = records.filter((vm) => needsReboot(vm, values));
        if (rebooting.length && body.confirmReboot !== true) {
          return NextResponse.json(
            { error: `${rebooting.map((vm) => String(vm.name_label)).join(", ")} would have to be rebooted`, needsConfirm: true },
            { status: 409 },
          );
        }
        const job = startVmMemoryChange(
          { poolId, address: host, port, useSsl, sessionRef, actor: auth.sub, role: auth.role, ip: clientIp(request) },
          vmRefs.map((ref, i) => ({ ref, record: records[i] })),
          values,
        );
        return NextResponse.json({ success: true, job }, { status: 202 });
      }

      case "pool_add_server_check":
      case "pool_add_server": {
        // XenCenter's Add New Server to a pool (lib/pool-membership-job.ts, lib/pool-join-rules.ts).
        const poolId = lookupSession(sessionRef)?.hostId ?? "";
        const entry = loadHostsFromDisk().find((h) => h.id === poolId);
        if (!entry) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
        const address = typeof body.address === "string" ? body.address.trim() : "";
        if (!/^[\w.:-]{1,253}$/.test(address)) return NextResponse.json({ error: "Enter the server's host name or IP address" }, { status: 400 });
        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!username || !password) return NextResponse.json({ error: "Enter the user name and password" }, { status: 400 });
        const joinPort = Number.isInteger(body.port) && body.port > 0 && body.port < 65536 ? body.port : 443;
        const joinSsl = body.useSsl !== false;
        const fingerprint = typeof body.fingerprint === "string" && body.fingerprint ? body.fingerprint : null;
        if (joinSsl && !fingerprint) return NextResponse.json({ error: "Confirm the server's certificate first" }, { status: 400 });
        const poolRecs = (await getAllPoolRecords(host, port, useSsl, sessionRef)) as Record<string, Record<string, unknown>>;
        const ctx: MemberContext = {
          poolId, poolName: String(Object.values(poolRecs)[0]?.name_label || entry.name || entry.address),
          address: host, port, useSsl, sessionRef, actor: auth.sub, role: auth.role, ip: clientIp(request),
        };
        let check;
        try {
          check = await checkJoin(ctx, { address, port: joinPort, useSsl: joinSsl, fingerprint, username, password });
        } catch (err) {
          if (err instanceof NotConfirmedError) return NextResponse.json({ error: err.message }, { status: 409 });
          if (err instanceof XenApiError && err.message === "SESSION_AUTHENTICATION_FAILED") {
            return NextResponse.json({ error: loginRefusedMessage(err, username) }, { status: 400 });
          }
          throw err;
        }
        const { verdict } = check;
        if (action === "pool_add_server_check") return NextResponse.json({ verdict });
        // Adding: the same rules once more, and XenCenter's CPU question answered.
        if (verdict.reason) return NextResponse.json({ error: verdict.reason }, { status: 409 });
        if (verdict.cpuQuestion && body.confirmCpu !== true) {
          return NextResponse.json({ error: verdict.cpuQuestion, needsConfirm: true }, { status: 409 });
        }
        if (runningMemberJob(poolId)) return NextResponse.json({ error: "A server is being added to or removed from this pool" }, { status: 409 });
        const job = startAddServer(ctx, check.joiner, check.coordinatorAddress, { username: entry.username, password: entry.password });
        return NextResponse.json({ success: true, job }, { status: 202 });
      }

      case "pool_remove_server": {
        // XenCenter's Remove From Pool (RemoveHostFromPoolCommand, EjectHostFromPoolAction).
        const poolId = lookupSession(sessionRef)?.hostId ?? "";
        const entry = loadHostsFromDisk().find((h) => h.id === poolId);
        if (!entry) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
        if (!isXenRef(hostRef)) return NextResponse.json({ error: "No server chosen" }, { status: 400 });
        const [poolRecs, hostRecs] = await Promise.all([
          getAllPoolRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
        ]);
        const pool = Object.values(poolRecs)[0] ?? {};
        const rec = hostRecs[hostRef];
        if (!rec) return NextResponse.json({ error: "No such server" }, { status: 404 });
        const name = String(rec.name_label ?? "");
        // GetCantRunReasonCore.
        if (pool.master === hostRef) return NextResponse.json({ error: "You cannot remove the coordinator from the pool." }, { status: 409 });
        const live = await xenApiCall<boolean>(host, port, useSsl, "host_metrics.get_live", [sessionRef, String(rec.metrics)]).catch(() => false);
        if (live !== true) return NextResponse.json({ error: "The server is unreachable." }, { status: 409 });
        if (Array.isArray(rec.resident_VMs) && rec.resident_VMs.length > 1) {
          return NextResponse.json({ error: "This server has running VMs" }, { status: 409 });
        }
        // XenMan: the name typed, as the data on the server's local storage goes.
        if (typeof body.confirmName !== "string" || body.confirmName.trim().toLowerCase() !== name.toLowerCase()) {
          return NextResponse.json({ error: `Type the server's name (${name}) to confirm`, needsConfirm: true }, { status: 409 });
        }
        if (runningMemberJob(poolId)) return NextResponse.json({ error: "A server is being added to or removed from this pool" }, { status: 409 });
        const ctx: MemberContext = {
          poolId, poolName: String(pool.name_label || entry.name || entry.address),
          address: host, port, useSsl, sessionRef, actor: auth.sub, role: auth.role, ip: clientIp(request),
        };
        const job = startRemoveServer(ctx, { hostRef, name, address: String(rec.address ?? "") });
        return NextResponse.json({ success: true, job }, { status: 202 });
      }

      case "license_assign": {
        // XenCenter's Apply License (ApplyLicenseEditionAction, for a pool): the licence
        // server on every host, then pool.apply_edition -- the edition "cloud", as the
        // XenServer 8 documentation applies it (xe pool-apply-edition edition=cloud).
        // If that fails, the licence servers go back to what they were.
        const address = typeof body.licenseServer === "string" ? body.licenseServer.trim() : "";
        if (!/^[\w.-]{1,253}$/.test(address)) return NextResponse.json({ error: "Enter the license server's host name or IP address" }, { status: 400 });
        const [hostRecs, poolRecs] = await Promise.all([
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllPoolRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
        ]);
        const [poolRef, pool] = Object.entries(poolRecs)[0] ?? [];
        if (!poolRef || !pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
        // The License Manager's verifiers.
        if (pool.ha_enabled === true) return NextResponse.json({ error: "The license for a host cannot be changed when HA is on" }, { status: 409 });
        const lives = await Promise.all(
          Object.values(hostRecs).map((h) => xenApiCall<boolean>(host, port, useSsl, "host_metrics.get_live", [sessionRef, String(h.metrics)]).catch(() => false)),
        );
        if (!lives.some((l) => l === true)) return NextResponse.json({ error: "A selected host is no longer active" }, { status: 409 });
        const master = hostRecs[String(pool.master)];
        const before = master?.license_server && typeof master.license_server === "object" ? (master.license_server as Record<string, string>) : {};
        const setServer = (server: Record<string, string>) =>
          Promise.all(Object.keys(hostRecs).map((ref) => xenApiCall(host, port, useSsl, "host.set_license_server", [sessionRef, ref, server])));
        try {
          await setServer({ address });
          await xenApiCall(host, port, useSsl, "pool.apply_edition", [sessionRef, poolRef, "cloud"]);
        } catch (err) {
          await setServer(before).catch(() => {});
          const poolName = String(pool.name_label || "the pool");
          const why = err instanceof XenApiError ? [err.message, ...(Array.isArray(err.data) ? err.data.map(String) : [])].join(" ") : String(err);
          return NextResponse.json({ error: `The licensing action for ${poolName} failed. ${why}` }, { status: 502 });
        }
        return NextResponse.json({ success: true });
      }

      case "license_release": {
        // XenCenter 8's Release License, as read on a test pool afterwards: the edition
        // "trial" (pool.apply_edition), the licence server left as it is.
        const [hostRecs, poolRecs] = await Promise.all([
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllPoolRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
        ]);
        const [poolRef, pool] = Object.entries(poolRecs)[0] ?? [];
        if (!poolRef || !pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
        if (pool.ha_enabled === true) return NextResponse.json({ error: "The license for a host cannot be changed when HA is on" }, { status: 409 });
        const lives = await Promise.all(
          Object.values(hostRecs).map((h) => xenApiCall<boolean>(host, port, useSsl, "host_metrics.get_live", [sessionRef, String(h.metrics)]).catch(() => false)),
        );
        if (!lives.some((l) => l === true)) return NextResponse.json({ error: "A selected host is no longer active" }, { status: 409 });
        // XenMan: asked first -- XenCenter releases without a question.
        if (body.confirmRelease !== true) return NextResponse.json({ error: "Confirm releasing the license", needsConfirm: true }, { status: 409 });
        try {
          await xenApiCall(host, port, useSsl, "pool.apply_edition", [sessionRef, poolRef, "trial"]);
        } catch (err) {
          const poolName = String(pool.name_label || "the pool");
          const why = err instanceof XenApiError ? [err.message, ...(Array.isArray(err.data) ? err.data.map(String) : [])].join(" ") : String(err);
          return NextResponse.json({ error: `The licensing action for ${poolName} failed. ${why}` }, { status: 502 });
        }
        return NextResponse.json({ success: true });
      }

      case "license_overview": {
        // XenCenter's License Manager, one pool: its hosts' licences, judged at the server's time.
        const [hostRecs, poolRecs] = await Promise.all([
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllPoolRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
        ]);
        const master = String(Object.values(poolRecs)[0]?.master ?? "");
        // Host.get_servertime (UTC), as XenCenter takes it.
        const serverTime = await xenApiCall<string>(host, port, useSsl, "host.get_servertime", [sessionRef, master]).catch(() => "");
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(serverTime);
        const now = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.now();
        // ha: the License Manager's HaOnVerifier keeps licences unchanged while HA is on.
        return NextResponse.json({ row: buildLicenseRow(hostRecs, master, now), ha: Object.values(poolRecs)[0]?.ha_enabled === true });
      }

      case "pool_member_job_status": {
        const job = typeof body.jobId === "string" ? getMemberJob(body.jobId) : undefined;
        if (!job || job.poolId !== lookupSession(sessionRef)?.hostId) return NextResponse.json({ error: "No such job" }, { status: 404 });
        return NextResponse.json({ job });
      }

      case "host_control_domain_memory": {
        // XenCenter's Control Domain Memory Settings (lib/dom0-memory-job.ts): set, then reboot.
        const poolId = lookupSession(sessionRef)?.hostId ?? "";
        if (!isXenRef(hostRef)) return NextResponse.json({ error: "No server chosen" }, { status: 400 });
        const memory = Number(body.memory);
        if (runningDom0Job(poolId, hostRef)) return NextResponse.json({ error: "The control domain memory of this server is being changed" }, { status: 409 });
        const all = (cls: string) =>
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, `${cls}.get_all_records`, [sessionRef]);
        const [pools, hostRecs, hostMetrics, vms, vmMetrics, guestMetrics] = await Promise.all([
          all("pool"), all("host"), all("host_metrics"), all("VM"), all("VM_metrics"), all("VM_guest_metrics"),
        ]);
        const row = buildMemoryOverview({ pools, hosts: hostRecs, hostMetrics, vms, vmMetrics, guestMetrics }, hostRef).hosts[0];
        const pool = Object.values(pools)[0] ?? {};
        const cd = row?.controlDomain;
        if (!row || !cd) return NextResponse.json({ error: "The server is not reachable" }, { status: 409 });
        // The dialog's rules, checked again here.
        if (!row.maintenance) return NextResponse.json({ error: "The server must be in maintenance mode to edit this setting." }, { status: 409 });
        if (pool.ha_enabled === true) {
          return NextResponse.json({ error: "HA is enabled on the pool. Disable HA first: rebooting the server would change what HA can tolerate." }, { status: 409 });
        }
        if (row.vms.length) {
          return NextResponse.json({ error: `VMs still run on ${row.hostName}: ${row.vms.map((v) => v.name).join(", ")}` }, { status: 409 });
        }
        if (!Number.isSafeInteger(memory) || memory < cd.staticMin || memory > cd.max) {
          return NextResponse.json({ error: "The memory is outside what the control domain may have" }, { status: 400 });
        }
        if (memory === cd.dynamicMin) return NextResponse.json({ error: "The memory is unchanged" }, { status: 400 });
        if (body.confirmReboot !== true) {
          return NextResponse.json({ error: "Changing the Control Domain memory will cause the server to be rebooted.", needsConfirm: true }, { status: 409 });
        }
        const job = startDom0MemoryChange(
          { poolId, address: host, port, useSsl, sessionRef, actor: auth.sub, role: auth.role, ip: clientIp(request) },
          { hostRef, hostName: row.hostName, dom0Ref: cd.vmRef, staticMin: cd.staticMin, coordinator: pool.master === hostRef },
          memory,
        );
        return NextResponse.json({ success: true, job }, { status: 202 });
      }

      case "host_dom0_job_status": {
        const job = typeof body.jobId === "string" ? getDom0MemoryJob(body.jobId) : undefined;
        if (!job || job.poolId !== lookupSession(sessionRef)?.hostId) return NextResponse.json({ error: "No such job" }, { status: 404 });
        return NextResponse.json({ job });
      }

      case "vm_memory_job_status": {
        const job = typeof body.jobId === "string" ? getVmMemoryJob(body.jobId) : undefined;
        if (!job || job.poolId !== lookupSession(sessionRef)?.hostId) return NextResponse.json({ error: "No such job" }, { status: 404 });
        return NextResponse.json({ job });
      }

      case "gpu_set_placement": {
        // XenCenter's SetGpuPlacementPolicyAction: the algorithm on every GPU group.
        const algorithm = body.algorithm;
        if (algorithm !== "depth_first" && algorithm !== "breadth_first") return NextResponse.json({ error: "Choose a placement policy" }, { status: 400 });
        const groups = await xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, "GPU_group.get_all_records", [sessionRef]);
        for (const ref of Object.keys(groups)) {
          await xenApiCall(host, port, useSsl, "GPU_group.set_allocation_algorithm", [sessionRef, ref, algorithm]);
        }
        return NextResponse.json({ success: true, groups: Object.keys(groups).length });
      }

      case "gpu_set_enabled_types": {
        // XenCenter's GpuConfiguration + VgpuConfigurationAction: for the chosen GPUs, each
        // type ticked is added to its enabled types, each unticked removed; a type a VM uses
        // on them stays (its row is greyed out there).
        const pgpuRefs: string[] = Array.isArray(body.pgpuRefs) && body.pgpuRefs.every(isXenRef) ? body.pgpuRefs : [];
        const enable: string[] = Array.isArray(body.enable) && body.enable.every(isXenRef) ? body.enable : [];
        const disable: string[] = Array.isArray(body.disable) && body.disable.every(isXenRef) ? body.disable : [];
        if (!pgpuRefs.length) return NextResponse.json({ error: "No GPUs chosen" }, { status: 400 });
        const [pgpus, vgpus] = await Promise.all([
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, "PGPU.get_all_records", [sessionRef]),
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, "VGPU.get_all_records", [sessionRef]),
        ]);
        const chosen = pgpuRefs.map((r) => [r, pgpus[r]] as const);
        if (chosen.some(([, p]) => !p)) return NextResponse.json({ error: "A GPU is gone" }, { status: 409 });
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
        const inUse = new Set(chosen.flatMap(([, p]) => list(p!.resident_VGPUs).map((v) => String(vgpus[v]?.type ?? ""))));
        const blocked = disable.filter((t) => inUse.has(t));
        if (blocked.length) return NextResponse.json({ error: "A virtual GPU type in use on these GPUs cannot be disallowed" }, { status: 409 });
        for (const [ref, p] of chosen) {
          const supported = new Set(list(p!.supported_VGPU_types));
          const next = list(p!.enabled_VGPU_types).filter((t) => !disable.includes(t));
          for (const t of enable) if (supported.has(t) && !next.includes(t)) next.push(t);
          await xenApiCall(host, port, useSsl, "PGPU.set_enabled_VGPU_types", [sessionRef, ref, next]);
        }
        return NextResponse.json({ success: true });
      }

      case "gpu_overview": {
        // XenCenter's GPU tab: one host (hostRef), or the pool. Pools without GPUs may not know the classes.
        const all = (cls: string) =>
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, `${cls}.get_all_records`, [sessionRef]).catch(() => ({}));
        const [pgpus, pcis, vgpuTypes, vgpus, groups, hostRecs] = await Promise.all([
          all("PGPU"),
          all("PCI"),
          all("VGPU_type"),
          all("VGPU"),
          all("GPU_group"),
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
        ]);
        const gpuHost = isXenRef(body.hostRef) ? body.hostRef : null;
        return NextResponse.json(buildGpuOverview({ pgpus, pcis, vgpuTypes, vgpus, groups, hosts: hostRecs }, gpuHost));
      }

      case "network_management_change": {
        // The management interface of one server, as a job (lib/network-mgmt-job.ts): its address may change under XenMan.
        const poolId = lookupSession(sessionRef)?.hostId ?? "";
        const busy = runningMgmtJob(poolId);
        if (busy) return NextResponse.json({ error: `The management interface of ${busy.hostName} is being changed` }, { status: 409 });
        const [networks, pifs, hostRecs, poolRecs, more, clusterHosts] = await Promise.all([
          getAllNetworkRecords(host, port, useSsl, sessionRef),
          getAllPIFRecords(host, port, useSsl, sessionRef),
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllPoolRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getNetworkingRecords(host, port, useSsl, sessionRef),
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, "Cluster_host.get_all_records", [sessionRef]).catch(() => ({})),
        ]);
        try {
          const plan = planManagementChange(
            { networks, pifs, vifs: {}, vms: {}, pool: Object.values(poolRecs)[0] ?? {}, hosts: hostRecs, bonds: more.bonds, clusterHosts, vlans: more.vlans, sriovs: more.sriovs },
            body,
          );
          const job = startManagementChange(
            { poolId, address: host, port, useSsl, sessionRef, actor: auth.sub, role: auth.role, ip: clientIp(request) },
            plan,
          );
          return NextResponse.json({ success: true, job }, { status: 202 });
        } catch (err) {
          if (err instanceof NetworkRefused) return NextResponse.json({ error: err.message }, { status: 409 });
          throw err;
        }
      }

      case "network_job_status": {
        const job = typeof body.jobId === "string" ? getMgmtJob(body.jobId) : undefined;
        // Only the pool's own jobs, for whoever may see the pool.
        if (!job || job.poolId !== lookupSession(sessionRef)?.hostId) return NextResponse.json({ error: "No such job" }, { status: 404 });
        return NextResponse.json({ job });
      }

      case "network_configure_ip": {
        // XenCenter's Configure IP Addresses: the secondary interfaces of one server, or of the pool.
        const all = (cls: string) =>
          xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, `${cls}.get_all_records`, [sessionRef]);
        const [networks, pifs, hostRecs, poolRecs, srs, pbds, clusterHosts] = await Promise.all([
          getAllNetworkRecords(host, port, useSsl, sessionRef),
          getAllPIFRecords(host, port, useSsl, sessionRef),
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          getAllPoolRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          all("SR"),
          all("PBD"),
          // Pools without clustering may not know the class at all.
          all("Cluster_host").catch(() => ({})),
        ]);
        const targetHost = isXenRef(body.hostRef) ? body.hostRef : null;
        try {
          const done = await configureIpInterfaces(
            (method, params) => xenApiCall(host, port, useSsl, method, [sessionRef, ...params]),
            { networks, pifs, vifs: {}, vms: {}, pool: Object.values(poolRecs)[0] ?? {}, hosts: hostRecs, srs, pbds, clusterHosts },
            targetHost,
            body.interfaces,
            body.confirmStorage === true,
            // SRs that name their server: looked up as the hosts would.
            (name) => lookup(name, { all: true, family: 4 }).then((a) => a.map((x) => x.address)),
          );
          return NextResponse.json({ success: true, done });
        } catch (err) {
          if (err instanceof StorageConfirmationNeeded) {
            return NextResponse.json({ error: err.message, storage: err.storage }, { status: 409 });
          }
          if (err instanceof NetworkRefused) return NextResponse.json({ error: err.message }, { status: 409 });
          if (err instanceof XenApiError) {
            const data = Array.isArray(err.data) && err.data.length ? ` (${err.data.map(String).join(", ")})` : "";
            return NextResponse.json({ error: `${err.message}${data}` }, { status: 400 });
          }
          throw err;
        }
      }

      case "pool_wlb_status": {
        const records = (await getAllPoolRecords(host, port, useSsl, sessionRef)) as Record<string, Record<string, unknown>>;
        const [poolRef, rec] = Object.entries(records)[0] ?? ["", {}];
        const base = {
          poolRef,
          url: String(rec.wlb_url ?? ""),
          username: String(rec.wlb_username ?? ""),
          enabled: Boolean(rec.wlb_enabled),
          verifyCert: Boolean(rec.wlb_verify_cert),
        };
        if (!base.url) return NextResponse.json({ ...base, configured: false });
        const [config, recs, hostRecs] = await Promise.allSettled([
          poolRetrieveWlbConfiguration(host, port, useSsl, sessionRef),
          base.enabled ? poolRetrieveWlbRecommendations(host, port, useSsl, sessionRef) : Promise.resolve({}),
          getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
        ]);
        const failed = [config, recs].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        // The settings name hosts by uuid (host_<uuid>_...): which is which, and
        // whether WLB could power one on at all.
        const hosts =
          hostRecs.status === "fulfilled"
            ? Object.entries(hostRecs.value)
                .map(([ref, h]) => ({
                  ref,
                  uuid: String(h.uuid ?? ""),
                  name: String(h.name_label ?? ref),
                  powerOnMode: String(h.power_on_mode ?? ""),
                  isCoordinator: ref === String(rec.master ?? ""),
                }))
                .sort((a, b) => a.name.localeCompare(b.name))
            : [];
        return NextResponse.json({
          ...base,
          configured: true,
          hosts,
          config: config.status === "fulfilled" ? config.value : null,
          recommendations:
            recs.status === "fulfilled" ? await describeWlbRecommendations(host, port, useSsl, sessionRef, recs.value) : [],
          error: failed ? wlbErrorMessage(failed.reason) : null,
        });
      }

      case "pool_wlb_connect": {
        const url = wlbAddress(body.wlbUrl);
        const { wlbUsername, wlbPassword, xsUsername, xsPassword, verifyCert } = body;
        if (!url) return NextResponse.json({ error: "Give the Workload Balancing server as host:port, e.g. wlb.example.org:8012" }, { status: 400 });
        if (![wlbUsername, wlbPassword, xsUsername, xsPassword].every((v) => typeof v === "string" && v.length > 0)) {
          return NextResponse.json({ error: "Enter both accounts with their passwords" }, { status: 400 });
        }
        const [poolRef] = await poolGetAll(host, port, useSsl, sessionRef);
        try {
          // Before connecting: the first connection already checks, or not.
          await poolSetWlbVerifyCert(host, port, useSsl, sessionRef, poolRef, verifyCert === true);
          await poolInitializeWlb(host, port, useSsl, sessionRef, url, wlbUsername, wlbPassword, xsUsername, xsPassword);
        } catch (err) {
          if (err instanceof XenApiError) return NextResponse.json({ error: wlbErrorMessage(err) }, { status: 400 });
          throw err;
        }
        return NextResponse.json({ success: true });
      }

      case "pool_wlb_disconnect": {
        try {
          await poolDeconfigureWlb(host, port, useSsl, sessionRef);
        } catch (err) {
          if (err instanceof XenApiError) return NextResponse.json({ error: wlbErrorMessage(err) }, { status: 400 });
          throw err;
        }
        return NextResponse.json({ success: true });
      }

      case "pool_wlb_set_enabled": {
        if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
        const [poolRef] = await poolGetAll(host, port, useSsl, sessionRef);
        try {
          await poolSetWlbEnabled(host, port, useSsl, sessionRef, poolRef, body.enabled);
        } catch (err) {
          if (err instanceof XenApiError) return NextResponse.json({ error: wlbErrorMessage(err) }, { status: 400 });
          throw err;
        }
        return NextResponse.json({ success: true });
      }

      case "pool_wlb_configure": {
        const cfg = body.config;
        const entries = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? Object.entries(cfg as Record<string, unknown>) : [];
        if (!entries.length || entries.length > 200) {
          return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
        }
        // Settings of the pool only if WLB already has them: one it does not
        // know it keeps all the same. Per host only the names XenCenter sets,
        // for hosts of this pool, true or false -- and sent the way XenCenter
        // sends them (WlbPage.SaveWLBConfig): every host's settings, with
        // set_host_configuration=true. Without that flag WLB files host_ keys
        // as settings of the pool, keeps them twice, and from then on cannot
        // hand the pool's settings out at all ("4014 An item with the same key
        // has already been added") -- seen twice in the field.
        let known: Record<string, string>;
        let uuids: Set<string>;
        try {
          const [cur, hostRecs] = await Promise.all([
            poolRetrieveWlbConfiguration(host, port, useSsl, sessionRef),
            getAllHostRecords(host, port, useSsl, sessionRef) as Promise<Record<string, Record<string, unknown>>>,
          ]);
          known = cur;
          uuids = new Set(Object.values(hostRecs).map((h) => String(h.uuid ?? "").toLowerCase()));
        } catch (err) {
          if (err instanceof XenApiError) return NextResponse.json({ error: wlbErrorMessage(err) }, { status: 400 });
          throw err;
        }
        const poolPart: Record<string, string> = {};
        const hostPart: Record<string, string> = {};
        const refused = (k: string, v: unknown): string | null => {
          if (typeof v !== "string" || v.length > 1000) return "its value";
          const perHost = /^host_([0-9a-fA-F-]{36})_(.+)$/.exec(k);
          if (perHost) {
            if (!WLB_HOST_SETTINGS.has(perHost[2])) return "a per-host setting XenMan does not set";
            if (!uuids.has(perHost[1].toLowerCase())) return "a host not in this pool";
            if (!/^(true|false)$/i.test(v)) return "not true or false";
            hostPart[k] = v.toLowerCase();
            return null;
          }
          if (/^host_/i.test(k)) return "a per-host setting XenMan does not set";
          if (!(k in known)) return "not a setting Workload Balancing has";
          if (READ_ONLY_WLB.has(k)) return "reported by Workload Balancing, not set";
          poolPart[k] = v;
          return null;
        };
        for (const [k, v] of entries) {
          const why = refused(k, v);
          if (why) {
            return NextResponse.json({ error: `XenMan does not pass on ${String(k).slice(0, 150)}: ${why}` }, { status: 400 });
          }
        }
        const payload: Record<string, string> = { ...poolPart };
        if (Object.keys(hostPart).length) {
          for (const [k, v] of Object.entries(known)) if (/^host_/i.test(k)) payload[k] = v;
          Object.assign(payload, hostPart);
          payload.set_host_configuration = "true";
        }
        try {
          await poolSendWlbConfiguration(host, port, useSsl, sessionRef, payload);
        } catch (err) {
          if (err instanceof XenApiError) return NextResponse.json({ error: wlbErrorMessage(err) }, { status: 400 });
          throw err;
        }
        return NextResponse.json({ success: true });
      }

      case "pool_wlb_apply": {
        // Only what WLB recommends right now, to the host it names: a list a
        // browser loaded minutes ago may be overtaken, and moving a VM on its
        // word alone would be moving it anywhere.
        const { targetHostRef } = body;
        if (!isXenRef(vmRef) || !isXenRef(targetHostRef)) return NextResponse.json({ error: "Missing VM or host" }, { status: 400 });
        let current: Record<string, string[]>;
        try {
          current = await poolRetrieveWlbRecommendations(host, port, useSsl, sessionRef);
        } catch (err) {
          if (err instanceof XenApiError) return NextResponse.json({ error: wlbErrorMessage(err) }, { status: 400 });
          throw err;
        }
        const rec = current[vmRef];
        if (!rec || String(rec[0]).trim().toUpperCase() !== "WLB" || rec[1] !== targetHostRef) {
          return NextResponse.json({ error: "Workload Balancing no longer recommends this move -- reload the recommendations." }, { status: 409 });
        }
        const vm = (await vmGetRecord(host, port, useSsl, sessionRef, vmRef)) as Record<string, unknown>;
        if (vm.is_control_domain) return NextResponse.json({ error: "Power recommendations are not applied by XenMan" }, { status: 400 });
        const taskRef = await vmMigrateAsync(host, port, useSsl, sessionRef, vmRef, targetHostRef);
        return NextResponse.json({ taskRef });
      }

      case "vm_templates": {
        const vmRaw = await getAllVmRecords(host, port, useSsl, sessionRef);
        const templates = parseVmRecords(vmRaw)
          .filter((vm) => vm.isATemplate && !vm.isControlDomain && !vm.isASnapshot)
          .map((t) => ({
            ref: t.ref,
            nameLabel: t.nameLabel,
            nameDescription: t.nameDescription,
            vcpusAtStartup: t.vcpusAtStartup,
            memoryStaticMax: t.memoryStaticMax,
            domainType: t.domainType,
            disksXml: t.otherConfig?.disks || "",
          }));
        templates.sort((a, b) => a.nameLabel.localeCompare(b.nameLabel));
        return NextResponse.json({ templates });
      }

      case "vm_create": {
        const { templateRef, vmName, vmDescription, vcpus, memoryBytes, startAfter, targetHostRef, firmware: fwMode, secureboot: fwSecureBoot } = body;

        // Step 1: Clone template (async, poll until done)
        const cloneTaskRef = await vmCloneAsync(host, port, useSsl, sessionRef, templateRef, vmName);
        let newVmRef: string | null = null;
        for (let i = 0; i < 120; i++) {
          const record = await taskGetRecord(host, port, useSsl, sessionRef, cloneTaskRef);
          if (record.status === "success") {
            const resultRaw = await taskGetResult(host, port, useSsl, sessionRef, cloneTaskRef);
            const match = String(resultRaw).match(/OpaqueRef:[^<"'\s]+/);
            newVmRef = match ? match[0] : String(resultRaw);
            break;
          }
          if (record.status === "failure") {
            const errInfo = record.error_info as string[] | undefined;
            throw new Error(errInfo?.join(": ") || "Clone failed");
          }
          if (record.status === "cancelled") throw new Error("Clone was cancelled");
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!newVmRef) throw new Error("Clone timed out");

        // Step 2: Configure the VM
        if (vmDescription) {
          await vmSetNameDescription(host, port, useSsl, sessionRef, newVmRef, vmDescription);
        }
        if (vcpus) {
          await vmSetVCPUsMax(host, port, useSsl, sessionRef, newVmRef, vcpus);
          await vmSetVCPUsAtStartup(host, port, useSsl, sessionRef, newVmRef, vcpus);
        }
        if (memoryBytes) {
          await vmSetMemoryLimits(host, port, useSsl, sessionRef, newVmRef, memoryBytes, memoryBytes, memoryBytes, memoryBytes);
        }
        if (targetHostRef) {
          await vmSetAffinity(host, port, useSsl, sessionRef, newVmRef, targetHostRef);
        }
        // Firmware - set UEFI in both platform and HVM-boot-params
        {
          const platform = await vmGetPlatform(host, port, useSsl, sessionRef, newVmRef);
          platform["firmware"] = "uefi";
          platform["secureboot"] = fwSecureBoot ? "true" : "false";
          await vmSetPlatform(host, port, useSsl, sessionRef, newVmRef, platform);

          const hvmParams = await vmGetHVMBootParams(host, port, useSsl, sessionRef, newVmRef);
          hvmParams["firmware"] = "uefi";
          await vmSetHVMBootParamsMap(host, port, useSsl, sessionRef, newVmRef, hvmParams);

          const nvram = await vmGetNVRAM(host, port, useSsl, sessionRef, newVmRef);
          if (!nvram["EFI-variables"]) {
            nvram["EFI-variables"] = "";
            await vmSetNVRAM(host, port, useSsl, sessionRef, newVmRef, nvram);
          }

          if (fwSecureBoot) {
            try {
              await vtpmCreate(host, port, useSsl, sessionRef, newVmRef, false);
            } catch (e) {
              console.warn("vTPM creation failed:", e instanceof Error ? e.message : e);
            }
          }
        }

        // Step 3: Provision (async — return task ref for client tracking)
        const provisionTaskRef = await vmProvisionAsync(host, port, useSsl, sessionRef, newVmRef);

        return NextResponse.json({ taskRef: provisionTaskRef, vmRef: newVmRef, startAfter: !!startAfter });
      }

      case "task_status": {
        const { taskRef } = body;
        const record = await taskGetRecord(host, port, useSsl, sessionRef, taskRef);
        return NextResponse.json({
          status: record.status,
          progress: Number(record.progress || 0),
          nameLabel: record.name_label,
          nameDescription: record.name_description,
          errorInfo: record.error_info,
        });
      }

      case "vm_disks": {
        const [vbdRaw, vdiRaw, srRaw] = await Promise.all([
          getAllVBDRecords(host, port, useSsl, sessionRef),
          getAllVDIRecords(host, port, useSsl, sessionRef),
          getAllSRRecords(host, port, useSsl, sessionRef),
        ]);

        const allVbds = parseVBDRecords(vbdRaw);
        const allVdis = parseVDIRecords(vdiRaw);
        const allSrs = parseSRRecords(srRaw);

        const vdiMap = new Map(allVdis.map((v) => [v.ref, v]));
        const srMap = new Map(allSrs.map((s) => [s.ref, s]));

        // Filter VBDs for this VM, resolve VDI and SR
        const vmVbds = allVbds.filter((vbd) => vbd.vm === vmRef);
        const disks = vmVbds
          .map((vbd) => {
            const vdi = vdiMap.get(vbd.vdi);
            const sr = vdi ? srMap.get(vdi.sr) : undefined;
            return {
              vbd: {
                ref: vbd.ref,
                device: vbd.device,
                type: vbd.type,
                mode: vbd.mode,
                currentlyAttached: vbd.currentlyAttached,
              },
              vdi: vdi
                ? {
                    ref: vdi.ref,
                    uuid: vdi.uuid,
                    nameLabel: vdi.nameLabel,
                    virtualSize: vdi.virtualSize,
                    physicalUtilisation: vdi.physicalUtilisation,
                    type: vdi.type,
                  }
                : null,
              sr: sr
                ? {
                    ref: sr.ref,
                    nameLabel: sr.nameLabel,
                    type: sr.type,
                  }
                : null,
            };
          })
          .filter((d) => d.vdi !== null || d.vbd.type === "CD");

        return NextResponse.json({ disks });
      }

      case "vm_nics": {
        const [vifRaw, netRaw, pifRaw] = await Promise.all([
          getAllVIFRecords(host, port, useSsl, sessionRef),
          getAllNetworkRecords(host, port, useSsl, sessionRef),
          getAllPIFRecords(host, port, useSsl, sessionRef),
        ]);

        const allVifs = parseVIFRecords(vifRaw);
        const allNets = parseNetworkRecords(netRaw);
        const allPifs = parsePIFRecords(pifRaw);
        const netMap = new Map(allNets.map((n) => [n.ref, n]));

        // Build set of networks whose PIFs are ALL bond slaves (hide these)
        const bondSlaveNetworks = new Set<string>();
        for (const net of allNets) {
          if (net.pifs.length > 0 && net.pifs.every((pifRef) => {
            const pif = allPifs.find((p) => p.ref === pifRef);
            return pif && pif.bondSlaveOf && pif.bondSlaveOf !== "OpaqueRef:NULL";
          })) {
            bondSlaveNetworks.add(net.ref);
          }
        }

        const vmVifs = allVifs
          .filter((vif) => vif.vm === vmRef)
          .sort((a, b) => a.device.localeCompare(b.device));

        const nics = vmVifs.map((vif) => {
          const net = netMap.get(vif.network);
          return {
            vif: {
              ref: vif.ref,
              device: vif.device,
              mac: vif.mac,
              currentlyAttached: vif.currentlyAttached,
            },
            network: net
              ? {
                  ref: net.ref,
                  nameLabel: net.nameLabel,
                  bridge: net.bridge,
                }
              : null,
          };
        });

        const networks = allNets
          .filter((n) => !bondSlaveNetworks.has(n.ref))
          .map((n) => ({
            ref: n.ref,
            nameLabel: n.nameLabel,
            bridge: n.bridge,
          }));

        return NextResponse.json({ nics, networks });
      }

      case "vif_create": {
        const { networkRef, device: vifDevice, mac } = body;
        const ref = await vifCreate(host, port, useSsl, sessionRef, vmRef, networkRef, vifDevice || "", mac || "");
        return NextResponse.json({ ref });
      }

      case "vif_destroy": {
        const { vifRef } = body;
        await vifDestroy(host, port, useSsl, sessionRef, vifRef);
        return NextResponse.json({ success: true });
      }

      case "vif_plug": {
        const { vifRef: plugRef } = body;
        await vifPlug(host, port, useSsl, sessionRef, plugRef);
        return NextResponse.json({ success: true });
      }

      case "vif_unplug": {
        const { vifRef: unplugRef } = body;
        await vifUnplug(host, port, useSsl, sessionRef, unplugRef);
        return NextResponse.json({ success: true });
      }

      case "pool_networks": {
        const [netRawPN, pifRawPN] = await Promise.all([
          getAllNetworkRecords(host, port, useSsl, sessionRef),
          getAllPIFRecords(host, port, useSsl, sessionRef),
        ]);
        const allNetsPN = parseNetworkRecords(netRawPN);
        const allPifsPN = parsePIFRecords(pifRawPN);
        const bondSlaveNetsPN = new Set<string>();
        for (const net of allNetsPN) {
          if (net.pifs.length > 0 && net.pifs.every((pifRef) => {
            const pif = allPifsPN.find((p) => p.ref === pifRef);
            return pif && pif.bondSlaveOf && pif.bondSlaveOf !== "OpaqueRef:NULL";
          })) {
            bondSlaveNetsPN.add(net.ref);
          }
        }
        const poolNetworks = allNetsPN
          .filter((n) => !bondSlaveNetsPN.has(n.ref))
          .map((n) => ({ ref: n.ref, nameLabel: n.nameLabel, bridge: n.bridge }));
        return NextResponse.json({ networks: poolNetworks });
      }

      case "vm_create_wizard": {
        const {
          templateRef: wzTemplate, vmName: wzName, vmDescription: wzDesc,
          vcpus: wzVcpus, memoryBytes: wzMemory, startAfter: wzStart,
          targetHostRef: wzHostRef, firmware: wzFw, secureboot: wzSb,
          provisionSrRef: wzProvSr, systemDiskSizeBytes: wzSysDiskSize,
          extraDisks, extraCds, extraNics,
        } = body as {
          templateRef: string; vmName: string; vmDescription: string;
          vcpus: number; memoryBytes: number; startAfter: boolean;
          targetHostRef?: string; firmware: string; secureboot: boolean;
          provisionSrRef?: string; systemDiskSizeBytes?: number;
          extraDisks: { srRef: string; nameLabel: string; sizeBytes: number }[];
          extraCds: { isoRef?: string }[];
          extraNics: { networkRef: string; mac?: string }[];
        };

        // 1. Clone template (async, poll until done)
        const wzCloneTask = await vmCloneAsync(host, port, useSsl, sessionRef, wzTemplate, wzName);
        let wzVmRef: string | null = null;
        for (let i = 0; i < 120; i++) {
          const rec = await taskGetRecord(host, port, useSsl, sessionRef, wzCloneTask);
          if (rec.status === "success") {
            const raw = await taskGetResult(host, port, useSsl, sessionRef, wzCloneTask);
            const m = String(raw).match(/OpaqueRef:[^<"'\s]+/);
            wzVmRef = m ? m[0] : String(raw);
            break;
          }
          if (rec.status === "failure") {
            const ei = rec.error_info as string[] | undefined;
            throw new Error(ei?.join(": ") || "Clone failed");
          }
          if (rec.status === "cancelled") throw new Error("Clone was cancelled");
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!wzVmRef) throw new Error("Clone timed out");

        // 2. Configure VM settings
        if (wzDesc) await vmSetNameDescription(host, port, useSsl, sessionRef, wzVmRef, wzDesc);
        if (wzVcpus) {
          await vmSetVCPUsMax(host, port, useSsl, sessionRef, wzVmRef, wzVcpus);
          await vmSetVCPUsAtStartup(host, port, useSsl, sessionRef, wzVmRef, wzVcpus);
        }
        if (wzMemory) {
          await vmSetMemoryLimits(host, port, useSsl, sessionRef, wzVmRef, wzMemory, wzMemory, wzMemory, wzMemory);
        }
        if (wzHostRef) await vmSetAffinity(host, port, useSsl, sessionRef, wzVmRef, wzHostRef);

        // 3. Inject SR UUID (and optionally resize) into provision XML
        const otherConfig = await vmGetOtherConfig(host, port, useSsl, sessionRef, wzVmRef);
        if (otherConfig["disks"]) {
          let disksXml = otherConfig["disks"];

          // Inject SR UUID (template disks have sr="" by default)
          if (disksXml.includes('sr=""')) {
            let provSrRef = wzProvSr;
            if (!provSrRef) {
              const pools = await poolGetAll(host, port, useSsl, sessionRef);
              if (pools.length > 0) {
                provSrRef = await poolGetDefaultSR(host, port, useSsl, sessionRef, pools[0]);
              }
            }
            if (!provSrRef || provSrRef === "OpaqueRef:NULL") {
              throw new Error("No SR specified for system disk and no pool default SR configured");
            }
            const srUuid = await srGetUuid(host, port, useSsl, sessionRef, provSrRef);
            disksXml = disksXml.replace(/sr=""/g, `sr="${srUuid}"`);
          }

          // Replace the first disk's size if user specified a custom size
          if (wzSysDiskSize && wzSysDiskSize > 0) {
            let replaced = false;
            disksXml = disksXml.replace(/size="(\d+)"/, (_match, _oldSize) => {
              if (!replaced) { replaced = true; return `size="${wzSysDiskSize}"`; }
              return _match;
            });
          }

          await vmRemoveFromOtherConfig(host, port, useSsl, sessionRef, wzVmRef, "disks");
          await vmAddToOtherConfig(host, port, useSsl, sessionRef, wzVmRef, "disks", disksXml);
        }

        // 4. Provision VM (async, poll until done)
        // Provision BEFORE setting boot params — matches XenCenter's order.
        // Provision processes the template's disk XML; firmware is set afterward.
        const wzProvTask = await vmProvisionAsync(host, port, useSsl, sessionRef, wzVmRef);
        for (let i = 0; i < 300; i++) {
          const rec = await taskGetRecord(host, port, useSsl, sessionRef, wzProvTask);
          if (rec.status === "success") break;
          if (rec.status === "failure") {
            const ei = rec.error_info as string[] | undefined;
            throw new Error(ei?.join(": ") || "Provision failed");
          }
          if (rec.status === "cancelled") throw new Error("Provision was cancelled");
          await new Promise((r) => setTimeout(r, 1000));
        }

        // 5. Rename provisioned disks to "{vmName} {device}" (matches XenCenter)
        try {
          const wzVbdRefs = await vmGetVBDs(host, port, useSsl, sessionRef, wzVmRef);
          const diskVbds: { device: string; vdiRef: string }[] = [];
          for (const vbdRef of wzVbdRefs) {
            const rec = await vbdGetRecord(host, port, useSsl, sessionRef, vbdRef);
            if (rec.type === "Disk" && rec.VDI && rec.VDI !== "OpaqueRef:NULL") {
              diskVbds.push({ device: String(rec.userdevice ?? rec.device ?? "0"), vdiRef: rec.VDI as string });
            }
          }
          diskVbds.sort((a, b) => Number(a.device) - Number(b.device));
          for (const vbd of diskVbds) {
            await vdiSetNameLabel(host, port, useSsl, sessionRef, vbd.vdiRef, `${wzName} ${vbd.device}`);
          }
        } catch (e) {
          console.warn("Disk rename failed:", e instanceof Error ? e.message : e);
        }

        // 6. Set boot params AFTER provision (matches XenCenter behavior)
        // Only HVM_boot_params["firmware"] is the canonical firmware selector.
        // platform["secureboot"] controls Secure Boot — do NOT set platform["firmware"].
        const wzFirmwareValue = wzFw === "bios" ? "bios" : "uefi";
        const hvmParams = await vmGetHVMBootParams(host, port, useSsl, sessionRef, wzVmRef);
        hvmParams["firmware"] = wzFirmwareValue;
        await vmSetHVMBootParamsMap(host, port, useSsl, sessionRef, wzVmRef, hvmParams);

        const plat = await vmGetPlatform(host, port, useSsl, sessionRef, wzVmRef);
        plat["secureboot"] = wzSb ? "true" : "false";
        await vmSetPlatform(host, port, useSsl, sessionRef, wzVmRef, plat);

        // 7. Add extra disks (after provision so device slots don't conflict)
        for (const disk of (extraDisks || [])) {
          const vdiRef = await vdiCreate(host, port, useSsl, sessionRef, disk.srRef, disk.nameLabel, "", disk.sizeBytes, "user");
          const devs = await vmGetAllowedVBDDevices(host, port, useSsl, sessionRef, wzVmRef);
          if (devs.length === 0) throw new Error("No available device slots for disk");
          await vbdCreate(host, port, useSsl, sessionRef, wzVmRef, vdiRef, devs[0], false);
        }

        // 8. Add extra CD drives (after provision)
        for (const cd of (extraCds || [])) {
          const cdDevs = await vmGetAllowedVBDDevices(host, port, useSsl, sessionRef, wzVmRef);
          if (cdDevs.length === 0) throw new Error("No available device slots for CD");
          const cdRef = await vbdCreateCd(host, port, useSsl, sessionRef, wzVmRef, cdDevs[0]);
          if (cd.isoRef) {
            await vbdInsert(host, port, useSsl, sessionRef, cdRef, cd.isoRef);
          }
        }

        // 9. Add extra NICs (use allowed VIF devices to avoid conflicts with template NICs)
        for (const nic of (extraNics || [])) {
          const vifDevs = await vmGetAllowedVIFDevices(host, port, useSsl, sessionRef, wzVmRef);
          if (vifDevs.length === 0) throw new Error("No available device slots for NIC");
          await vifCreate(host, port, useSsl, sessionRef, wzVmRef, nic.networkRef, vifDevs[0], nic.mac || "");
        }

        // 10. Assign vTPM for Secure Boot (after provision, disks, NICs — matches XenCenter)
        if (wzSb) {
          try {
            await vtpmCreate(host, port, useSsl, sessionRef, wzVmRef, false);
          } catch (e) {
            console.warn("vTPM creation failed (may not be supported):", e instanceof Error ? e.message : e);
          }
        }

        // 11. Start VM if requested
        if (wzStart) {
          if (wzHostRef) {
            await vmStartOn(host, port, useSsl, sessionRef, wzVmRef, wzHostRef);
          } else {
            await vmPowerAction(host, port, useSsl, sessionRef, wzVmRef, "start");
          }
        }

        return NextResponse.json({ vmRef: wzVmRef, success: true });
      }

      case "vdi_export_ssh": {
        const { hostId: vdiHostId, sshHost: vdiSshHost, vdiUuid, vdiName, exportDir: vdiExportDir } = body;
        // This action names its own host instead of riding the bound session,
        // so it needs its own grant check.
        if (!mayAccessHost(auth, vdiHostId)) {
          return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
        }
        const vdiHosts = loadHostsFromDisk();
        const vdiHost = vdiHosts.find((h) => h.id === vdiHostId);
        if (!vdiHost) {
          return NextResponse.json({ error: "Host not found" }, { status: 404 });
        }
        if (!isUuid(vdiUuid)) return NextResponse.json({ error: "Not a disk UUID" }, { status: 400 });
        const vdiDir = exportDirOf(vdiExportDir);
        if (!vdiDir) {
          return NextResponse.json({ error: "The export directory must be an absolute path of letters, digits, spaces and . _ - /" }, { status: 400 });
        }
        const vdiTs = new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "");
        const vdiTargetPath = `${vdiDir}/${exportFileStem(vdiName)}_${vdiTs}.raw`;
        const vdiTarget = (typeof vdiSshHost === "string" && vdiSshHost) || vdiHost.address;
        // Only a host of this pool: the address comes from the browser.
        if (![...knownAddresses(vdiHost.id), ...natAddresses(vdiHost.id)].some((a) => a.toLowerCase() === vdiTarget.toLowerCase())) {
          return NextResponse.json({ error: `${vdiTarget} is not a known host of this pool` }, { status: 400 });
        }
        const vdiJobId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        sshExportJobs.set(vdiJobId, { status: "running", targetPath: vdiTargetPath, startedAt: Date.now() });
        runSshCommand(
          vdiHost.id,
          reachable(vdiHost.id, vdiTarget),
          vdiHost.sshPort || 22,
          vdiHost.username,
          vdiHost.password,
          `xe vdi-export uuid=${vdiUuid} filename=${shellQuote(vdiTargetPath)} format=raw`,
          vdiJobId,
        );
        return NextResponse.json({ jobId: vdiJobId, targetPath: vdiTargetPath });
      }

      case "vm_export_ssh": {
        const { hostId: exportHostId, sshHost, vmUuid, vmName, exportDir } = body;
        // Same as vdi_export_ssh: own host id, own grant check.
        if (!mayAccessHost(auth, exportHostId)) {
          return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
        }
        const hosts = loadHostsFromDisk();
        const exportHost = hosts.find((h) => h.id === exportHostId);
        if (!exportHost) {
          return NextResponse.json({ error: "Host not found" }, { status: 404 });
        }
        if (!isUuid(vmUuid)) return NextResponse.json({ error: "Not a VM UUID" }, { status: 400 });
        const dir = exportDirOf(exportDir);
        if (!dir) {
          return NextResponse.json({ error: "The export directory must be an absolute path of letters, digits, spaces and . _ - /" }, { status: 400 });
        }
        const ts = new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "");
        const targetPath = `${dir}/${exportFileStem(vmName)}_${ts}.xva`;
        const exportTarget = (typeof sshHost === "string" && sshHost) || exportHost.address;
        // Only a host of this pool: the address comes from the browser.
        if (![...knownAddresses(exportHost.id), ...natAddresses(exportHost.id)].some((a) => a.toLowerCase() === exportTarget.toLowerCase())) {
          return NextResponse.json({ error: `${exportTarget} is not a known host of this pool` }, { status: 400 });
        }
        const jobId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        sshExportJobs.set(jobId, { status: "running", targetPath, startedAt: Date.now() });
        runSshCommand(
          exportHost.id,
          reachable(exportHost.id, exportTarget),
          exportHost.sshPort || 22,
          exportHost.username,
          exportHost.password,
          `xe vm-export vm=${vmUuid} filename=${shellQuote(targetPath)}`,
          jobId,
        );
        return NextResponse.json({ jobId, targetPath });
      }

      case "vm_export_status": {
        const { jobId: statusJobId } = body;
        const job = sshExportJobs.get(statusJobId as string);
        if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
        return NextResponse.json(job);
      }

      case "vm_snapshots": {
        const snapshotRefs = await vmGetSnapshots(host, port, useSsl, sessionRef, vmRef);
        const snapshots = await Promise.all(
          snapshotRefs.map(async (ref) => {
            const rec = await vmGetRecord(host, port, useSsl, sessionRef, ref);
            return {
              ref,
              uuid: rec.uuid as string,
              nameLabel: rec.name_label as string,
              nameDescription: rec.name_description as string,
              snapshotTime: rec.snapshot_time as string,
              hasMemory: rec.power_state === "Suspended",
            };
          })
        );
        // Sort by snapshot time ascending
        snapshots.sort((a, b) => (a.snapshotTime > b.snapshotTime ? 1 : -1));
        return NextResponse.json({ snapshots });
      }

      case "vm_snapshot_create": {
        const { snapshotName, snapshotDescription, withMemory } = body;
        let snapRef: string;
        if (withMemory) {
          snapRef = await vmCheckpoint(host, port, useSsl, sessionRef, vmRef, snapshotName as string);
        } else {
          snapRef = await vmSnapshot(host, port, useSsl, sessionRef, vmRef, snapshotName as string);
        }
        if (snapshotDescription) {
          await vmSetNameDescription(host, port, useSsl, sessionRef, snapRef, snapshotDescription as string);
        }
        return NextResponse.json({ ref: snapRef });
      }

      case "vm_snapshot_revert": {
        const { snapshotRef: revertRef } = body;
        await vmRevert(host, port, useSsl, sessionRef, revertRef as string);
        return NextResponse.json({ success: true });
      }

      case "vm_copy_check":
      case "vm_copy": {
        // XenCenter's Copy VM dialog (lib/vm-copy.ts): fast clone or full copy within the pool.
        if (!isXenRef(vmRef)) return NextResponse.json({ error: "No VM given" }, { status: 400 });
        const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        const records = await loadCopyRecords(call, vmRef);
        const blocked = copyBlockedReason(records.vm);
        const plan = buildCopyPlan(records);
        if (action === "vm_copy_check") return NextResponse.json({ blocked, plan });
        if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
        const name = typeof body.nameLabel === "string" ? body.nameLabel.trim() : "";
        const description = typeof body.description === "string" ? body.description : "";
        if (!name || name.length > 255) return NextResponse.json({ error: "Enter a name for the copy" }, { status: 400 });
        if (description.length > 1024) return NextResponse.json({ error: "The description is too long" }, { status: 400 });
        const mode = body.mode === "copy" ? "copy" : body.mode === "clone" ? "clone" : null;
        if (!mode) return NextResponse.json({ error: "Choose fast clone or full copy" }, { status: 400 });
        if (mode === "clone" && !plan.cloneEnabled) return NextResponse.json({ error: plan.cloneUnavailable }, { status: 409 });
        let srRef: string | undefined;
        if (mode === "copy") {
          const sr = plan.srs.find((s) => s.ref === body.srRef);
          if (!plan.copyEnabled) return NextResponse.json({ error: "A full copy is not possible for this VM" }, { status: 409 });
          if (!sr) return NextResponse.json({ error: "Choose a storage repository" }, { status: 400 });
          if (!sr.enabled) return NextResponse.json({ error: `${sr.name}: ${sr.description}` }, { status: 409 });
          srRef = sr.ref;
        }
        const taskRef = await startCopy({ address: host, port, useSsl, sessionRef }, vmRef, { mode, name, description, srRef });
        return NextResponse.json({ taskRef });
      }

      case "sr_states": {
        // XenCenter's SR menu: which commands each SR allows, and why not (lib/sr-manage.ts).
        const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        return NextResponse.json({ srs: buildSrStates(await loadSrRecords(call)) });
      }

      case "sr_command": {
        const srRef = body.srRef;
        const command = body.command as SrCommand;
        if (!isXenRef(srRef)) return NextResponse.json({ error: "No SR given" }, { status: 400 });
        if (!["repair", "detach", "forget", "destroy", "setDefault", "trim"].includes(command)) {
          return NextResponse.json({ error: "Unknown command" }, { status: 400 });
        }
        const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        // XenCenter asks before these; Destroy loses every disk, so the SR's name is typed as well.
        if (["detach", "forget", "destroy", "trim"].includes(command) && body.confirm !== true) {
          return NextResponse.json({ error: "Not confirmed", needsConfirm: true }, { status: 409 });
        }
        if (command === "destroy") {
          const name = String((await call<Record<string, unknown>>("SR.get_record", [srRef])).name_label ?? "");
          if (typeof body.confirmName !== "string" || body.confirmName.trim().toLowerCase() !== name.toLowerCase()) {
            return NextResponse.json({ error: `Type the SR's name, ${name}, to destroy it` }, { status: 409 });
          }
        }
        try {
          const failures = await runSrCommand(call, srRef, command);
          if (failures.length) return NextResponse.json({ error: failures.join("; "), failures }, { status: 502 });
          return NextResponse.json({ success: true });
        } catch (err) {
          if (err instanceof SrRefused) return NextResponse.json({ error: err.message }, { status: 409 });
          throw err;
        }
      }

      case "vm_gpu":
      case "vm_gpu_set": {
        // XenCenter's VM Properties → GPU (lib/vm-gpu.ts).
        if (!isXenRef(vmRef)) return NextResponse.json({ error: "No VM given" }, { status: 400 });
        const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        const records = await loadVmGpuRecords(call, vmRef);
        if (records.vm.is_a_template === true || records.vm.is_a_snapshot === true || records.vm.is_control_domain === true) {
          return NextResponse.json({ error: "Only a VM can have virtual GPUs" }, { status: 400 });
        }
        const page = buildVmGpuPage(records, vmRef);
        if (action === "vm_gpu") return NextResponse.json(page);
        const keep = Array.isArray(body.keep) && body.keep.every(isXenRef) ? (body.keep as string[]) : null;
        const add = Array.isArray(body.add)
          ? (body.add as Record<string, unknown>[]).filter((a) => isXenRef(a?.group) && isXenRef(a?.type)).map((a) => ({ group: a.group as string, type: a.type as string }))
          : null;
        if (!keep || !add || add.length !== (body.add as unknown[]).length || add.length > 8) {
          return NextResponse.json({ error: "Unknown virtual GPUs" }, { status: 400 });
        }
        const problem = changeProblem(page, { keep, add });
        if (problem) return NextResponse.json({ error: problem }, { status: 409 });
        await applyVmGpus(call, vmRef, page, { keep, add });
        return NextResponse.json({ success: true });
      }

      case "vm_import_targets": {
        // XenCenter's Import wizard for an XVA: home servers and the SRs a VM may go to (lib/vm-import.ts).
        const affinity = isXenRef(body.affinity) ? body.affinity : null;
        const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        return NextResponse.json(importTargets(await loadImportRecords(call), affinity));
      }

      case "vm_import_finish": {
        // After the upload (/api/xen/import): the interfaces to their networks, then start if asked.
        if (!isXenRef(vmRef) || !isXenRef(body.importTask)) return NextResponse.json({ error: "No import given" }, { status: 400 });
        const chosen: Record<string, string> = {};
        if (body.networks && typeof body.networks === "object") {
          for (const [vif, net] of Object.entries(body.networks as Record<string, unknown>)) {
            if (!isXenRef(vif) || !isXenRef(net)) return NextResponse.json({ error: "Unknown network" }, { status: 400 });
            chosen[vif] = net;
          }
        }
        const poolId = lookupSession(sessionRef)?.hostId ?? "";
        try {
          const taskRef = await finishImport({ poolId, address: host, port, useSsl, sessionRef }, vmRef, body.importTask, chosen, body.start === true);
          return NextResponse.json({ taskRef });
        } catch (err) {
          if (err instanceof ImportRefused) return NextResponse.json({ error: err.message }, { status: 409 });
          throw err;
        }
      }

      case "vm_convert_to_template": {
        // XenCenter's Convert to Template: asked first, as it cannot be undone.
        if (!isXenRef(vmRef)) return NextResponse.json({ error: "No VM given" }, { status: 400 });
        const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        const vm = await call<Record<string, unknown>>("VM.get_record", [vmRef]);
        const blocked = convertBlockedReason(vm);
        if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
        if (body.confirm !== true) return NextResponse.json({ error: "Converting to a template cannot be undone", needsConfirm: true }, { status: 409 });
        await convertToTemplate(call, vmRef);
        return NextResponse.json({ success: true });
      }

      case "vm_snapshot_to_template_check":
      case "vm_snapshot_to_template": {
        // XenCenter's Create Template From Snapshot: a clone of the snapshot, which is a template.
        const snapRef = body.snapshotRef;
        if (!isXenRef(snapRef)) return NextResponse.json({ error: "No snapshot given" }, { status: 400 });
        const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(host, port, useSsl, method, [sessionRef, ...params]);
        const snap = await call<Record<string, unknown>>("VM.get_record", [snapRef]);
        if (snap.is_a_snapshot !== true) return NextResponse.json({ error: "Only a snapshot can be saved as a template" }, { status: 400 });
        const snapName = String(snap.name_label ?? "");
        if (action === "vm_snapshot_to_template_check") {
          const all = await call<Record<string, Record<string, unknown>>>("VM.get_all_records", []);
          return NextResponse.json({ name: uniqueName(`Template from snapshot '${snapName}'`, Object.values(all).map((v) => String(v.name_label ?? ""))) });
        }
        const name = typeof body.nameLabel === "string" ? body.nameLabel.trim() : "";
        if (!name || name.length > 255) return NextResponse.json({ error: "Enter a name for the new template" }, { status: 400 });
        const taskRef = await startCopy({ address: host, port, useSsl, sessionRef }, snapRef, {
          mode: "clone",
          name,
          description: `Template generated by XenMan from snapshot '${snapName}'`,
          instant: true,
        });
        return NextResponse.json({ taskRef });
      }

      case "vm_snapshot_delete": {
        const { snapshotRef: delRef } = body;
        await vmDestroy(host, port, useSsl, sessionRef, delRef as string);
        return NextResponse.json({ success: true });
      }

      case "vm_guest_metrics": {
        const vmRec = await vmGetRecord(host, port, useSsl, sessionRef, vmRef);
        const gmRef = vmRec.guest_metrics as string;
        if (!gmRef || gmRef === "OpaqueRef:NULL") {
          return NextResponse.json({ osVersion: null, ipAddresses: [], rdpEnabled: null });
        }
        const gm = await vmGetGuestMetricsRecord(host, port, useSsl, sessionRef, gmRef);
        const osVersion = ((gm.os_version as Record<string, string>)?.name || null)
          ?.split("|")[0].trim() || null;
        const networks = (gm.networks as Record<string, string>) || {};
        const ipAddresses = Object.entries(networks)
          .filter(([k]) => /^[0-9]+\/ip$/.test(k))
          .map(([, v]) => v)
          .filter(Boolean);
        // As XenCenter reads it: "data-ts" is the guest agent's word on
        // whether Remote Desktop is switched on; absent, nobody knows.
        const other = (gm.other as Record<string, string>) || {};
        const rdpEnabled = "data-ts" in other ? other["data-ts"] === "1" : null;
        return NextResponse.json({ osVersion, ipAddresses, rdpEnabled });
      }

      case "event_register": {
        // Get initial event token (discard events — state is fresh from connect/refresh)
        // Use short timeout (0.001s): we only need the token, not the events.
        // With empty token, event.from returns immediately regardless of timeout.
        try {
          const regResult = await eventFrom(host, port, useSsl, sessionRef, ["*"], "", 0.001);
          const regObj = regResult as unknown as Record<string, unknown>;
          const regToken = regObj.token as string | undefined;
          if (!regToken) {
            console.error("[event_register] Unexpected event.from response:", JSON.stringify(regObj).slice(0, 500));
            return NextResponse.json({ error: "event.from returned no token" }, { status: 500 });
          }
          return NextResponse.json({ token: regToken });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error("[event_register] event.from failed:", msg, err instanceof XenApiError ? `code=${err.code}` : "");
          return NextResponse.json({ error: `event_register: ${msg}` }, { status: 500 });
        }
      }

      case "event_poll": {
        const { token } = body;
        try {
          const pollResult = await eventFrom(host, port, useSsl, sessionRef, ["*"], token, 30.0);
          const resultObj = pollResult as unknown as Record<string, unknown>;
          const rawEvents = (Array.isArray(resultObj.events) ? resultObj.events : []) as XenRawEvent[];
          const newToken = resultObj.token as string;
          const events = parseXenEvents(rawEvents);

          // Persist while we have them: this is the live path, so the history
          // stays complete for as long as any browser holds an event loop.
          const polled = lookupSession(sessionRef);
          if (polled) {
            recordAlertsAndTasks(
              polled.hostId,
              events
                .filter((e) => e.class === "message" && e.operation !== "del")
                .map((e) => (e as { data: XenAlert }).data),
              events
                .filter((e) => e.class === "task" && e.operation !== "del")
                .map((e) => (e as { data: XenPoolTask }).data),
            );
          }

          // Tasks stay on the server. XAPI emits a `mod` per progress step, so a
          // single migration produces a burst of them — forwarding those would
          // rebuild the connection state (and re-render every useXen() consumer,
          // the 2000-line sidebar included) many times a second for data no view
          // reads. The history view gets tasks from the store instead.
          const clientEvents = events.filter((e) => e.class !== "task");

          return NextResponse.json({ token: newToken, events: clientEvents });
        } catch (err) {
          // EVENTS_LOST: client must re-register
          if (err instanceof XenApiError && err.message === "EVENTS_LOST") {
            return NextResponse.json({ error: "EVENTS_LOST" }, { status: 200 });
          }
          throw err;
        }
      }

      /**
       * One poll covering every connected pool, replacing one poll per pool.
       *
       * A browser allows six concurrent HTTP/1.1 connections per origin, and
       * server.js speaks HTTP/1.1. A long poll per pool therefore held a
       * connection slot each: at five pools a single slot was left for the rest
       * of the application, and every navigation queued behind the polls --
       * measured at up to 18 seconds for a 372-byte response.
       *
       * This does not call the pools. lib/xen-event-pump.ts keeps one event.from
       * per session running across requests and parks what it delivers; this
       * only drains it. Driving XAPI from here instead was the first attempt and
       * was wrong: the bundled round ends as soon as any pool has news, so every
       * other pool was asked again on every round -- 120 calls a minute against
       * a silent pool rather than 2, four fifths of them aborted mid-wait.
       */
      case "event_poll_multi": {
        const { pools } = body as { pools?: { sessionRef?: string }[] };
        if (!Array.isArray(pools) || pools.length === 0) {
          return NextResponse.json({ error: "Missing pools" }, { status: 400 });
        }
        if (pools.length > MAX_POLLED_POOLS) {
          return NextResponse.json(
            { error: `At most ${MAX_POLLED_POOLS} pools per poll` },
            { status: 400 },
          );
        }

        const specs: (PumpSpec & { index: number })[] = [];
        const results: Record<string, unknown>[] = [];

        // Each entry runs the same three checks the single-session preamble
        // does, and the address comes from the session registry rather than the
        // body. Bundling must not become a way to aim a poll at another pool.
        pools.forEach((entry, index) => {
          const bound = entry.sessionRef ? lookupSession(entry.sessionRef) : null;
          if (
            !bound ||
            bound.actor.toLowerCase() !== auth.sub.toLowerCase() ||
            !mayAccessHost(auth, bound.hostId)
          ) {
            results.push({ index, error: "SESSION_INVALID" });
            return;
          }
          specs.push({
            index,
            sessionRef: entry.sessionRef as string,
            hostId: bound.hostId,
            host: bound.address,
            port: bound.port,
            useSsl: bound.useSsl,
          });
        });

        if (specs.length === 0) return NextResponse.json({ results });

        const drained = await drainPumps(
          specs.map(({ index: _index, ...spec }) => spec),
          EVENT_DRAIN_TIMEOUT_MS,
        );

        for (const spec of specs) {
          const drainResult = drained.get(spec.sessionRef);
          if (!drainResult) continue; // Pool stayed quiet for the whole window.

          if (drainResult.lost) {
            results.push({ index: spec.index, hostId: spec.hostId, error: "EVENTS_LOST" });
            continue;
          }
          if (drainResult.error) {
            results.push({ index: spec.index, hostId: spec.hostId, error: drainResult.error });
            continue;
          }

          const events = parseXenEvents(drainResult.events);

          // Persist while we hold them: this is the live path, and the history
          // stays complete for as long as any browser runs an event loop.
          recordAlertsAndTasks(
            spec.hostId,
            events
              .filter((e) => e.class === "message" && e.operation !== "del")
              .map((e) => (e as { data: XenAlert }).data),
            events
              .filter((e) => e.class === "task" && e.operation !== "del")
              .map((e) => (e as { data: XenPoolTask }).data),
          );

          // Tasks stay on the server -- see event_poll above.
          const clientEvents = events.filter((e) => e.class !== "task");
          if (clientEvents.length > 0) {
            results.push({ index: spec.index, hostId: spec.hostId, events: clientEvents });
          }
        }

        return NextResponse.json({ results });
      }


      case "alerts_fetch": {
        // Fallback for clients with the event loop switched off (autoRefresh is
        // off by default), so the bell still updates without a full refresh.
        const { alerts, poolTasks } = await fetchAlertsAndTasks(host, port, useSsl, sessionRef);
        const bound = lookupSession(sessionRef);
        if (bound) recordAlertsAndTasks(bound.hostId, alerts, poolTasks);
        return NextResponse.json(alertPayload(alerts));
      }

      case "alerts_dismiss_all": {
        // Clearing a backlog: a pool that nobody ever acknowledged holds
        // thousands of `message` objects, and one click per row is no workflow.
        const { severity } = body as { severity?: string };
        const bound = lookupSession(sessionRef);

        const { alerts, poolTasks } = await fetchAlertsAndTasks(host, port, useSsl, sessionRef);

        // Record BEFORE destroying. message.destroy is irreversible, and some of
        // these may never have passed through an event poll — writing them to
        // the store first is what keeps the history complete.
        if (bound) recordAlertsAndTasks(bound.hostId, alerts, poolTasks);

        const targets =
          severity && severity !== "all"
            ? alerts.filter((a) => severityFromPriority(a.priority) === severity)
            : alerts;

        // Bounded concurrency: a thousand serial round trips would take minutes,
        // a thousand parallel ones would bury the pool master.
        const DISMISS_CONCURRENCY = 8;
        let dismissed = 0;
        let failed = 0;
        for (let i = 0; i < targets.length; i += DISMISS_CONCURRENCY) {
          const results = await Promise.allSettled(
            targets
              .slice(i, i + DISMISS_CONCURRENCY)
              .map((a) => messageDestroy(host, port, useSsl, sessionRef, a.ref)),
          );
          for (const r of results) {
            if (r.status === "fulfilled") dismissed++;
            else failed++;
          }
        }

        // Report what is actually left rather than assuming: another client may
        // have acknowledged something while this ran.
        const remaining = await messageGetAllRecords(host, port, useSsl, sessionRef).catch(
          () => ({}) as Record<string, Record<string, unknown>>,
        );

        return NextResponse.json({
          dismissed,
          failed,
          ...alertPayload(parseMessageRecords(remaining)),
        });
      }

      case "alert_dismiss": {
        // XAPI has no read flag on messages — acknowledging one destroys it.
        const { alertRef } = body;
        if (!alertRef) {
          return NextResponse.json({ error: "Missing alertRef" }, { status: 400 });
        }
        await messageDestroy(host, port, useSsl, sessionRef, alertRef as string);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    // A host that is not the one trusted: said as such, for the warning in the UI.
    if (error instanceof CertMismatchError || error instanceof SshKeyMismatchError) {
      console.error(`[xen-api] action=${actionName} refused: ${error.message}`);
      return NextResponse.json({ error: error.message, code: error.code, poolId: error.poolId }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    const cause = error instanceof Error && error.cause ? ` cause=${error.cause}` : "";
    console.error(`[xen-api] action=${actionName} error: ${message}${cause}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/* ── Audit wrapper ───────────────────────────────────────────────────────── */

// Successful read-only actions are far too chatty for an audit trail: a
// connected client issues event_poll every 30 seconds per host plus a refresh
// after every task. Session start/end stays, and a *denied* read is always
// recorded — a rejected access attempt is exactly what the log is for.
//
// vm_console is read-only in the XAPI sense and anything but routine in the
// operational one: it hands out the address of a VM's keyboard. It is issued
// once, when somebody opens a console, so it is not chatty either.
const AUDIT_EXEMPT_ACTIONS = new Set(
  [...READ_ONLY_ACTIONS].filter(
    (a) => a !== "connect" && a !== "disconnect" && a !== "vm_console",
  ),
);

/** The subset of the request body that identifies what an action touched. */
interface XenActionFields {
  action?: string;
  sessionRef?: string;
  host?: string;
  hostId?: string;
  vmRef?: string;
  hostRef?: string;
  srRef?: string;
  vdiRef?: string;
  networkRef?: string;
  targetHostRef?: string;
  powerAction?: string;
  masterHostId?: string;
  value?: unknown;
  nameLabel?: string;
  severity?: string;
  sources?: unknown;
  // Copying a VM, templates from VMs and snapshots.
  snapshotRef?: unknown;
  confirm?: unknown;
  // Import.
  networks?: unknown;
  start?: unknown;
  // A VM's vGPUs.
  keep?: unknown;
  add?: unknown;
  // SR commands.
  command?: unknown;
  // Workload Balancing; its passwords are deliberately not listed here.
  wlbUrl?: unknown;
  wlbUsername?: unknown;
  xsUsername?: unknown;
  enabled?: unknown;
  config?: unknown;
  // Networks.
  type?: unknown;
  name?: unknown;
  vlan?: unknown;
  mtu?: unknown;
  changes?: unknown;
  interfaces?: unknown;
  confirmStorage?: unknown;
  mode?: unknown;
  pifRefs?: unknown;
  pifRef?: unknown;
  onSriov?: unknown;
  ip?: unknown;
  netmask?: unknown;
  gateway?: unknown;
  // VM memory settings.
  vmRefs?: unknown;
  dynamicMin?: unknown;
  dynamicMax?: unknown;
  staticMax?: unknown;
  confirmReboot?: unknown;
  memory?: unknown;
  // Adding a server to the pool (its password is deliberately not listed here).
  address?: unknown;
  username?: unknown;
  confirmCpu?: unknown;
  licenseServer?: unknown;
  // GPUs.
  algorithm?: unknown;
  pgpuRefs?: unknown;
  enable?: unknown;
  disable?: unknown;
}

function auditCategory(action: string): AuditCategory {
  // Pool/session-level actions. These only reach the log when denied, but the
  // category should still say where the attempt was aimed.
  if (
    action === "connect" ||
    action === "disconnect" ||
    action === "refresh" ||
    action.startsWith("event_")
  ) {
    return "host";
  }
  // Alerts belong to the pool as a whole, not to any one object class.
  if (action.startsWith("alert")) return "system";
  if (action.startsWith("host_")) return "host";
  if (action.startsWith("pool_")) return "pool";
  if (
    action.startsWith("sr_") ||
    action.startsWith("disk_") ||
    action.startsWith("vdi_") ||
    action.startsWith("cd_")
  ) {
    return "storage";
  }
  if (action.startsWith("vif_") || action.startsWith("network_")) return "network";
  if (action.startsWith("vm_")) return "vm";
  return "config";
}

/** Name a configured pool by its host id, falling back to the raw id. */
function describePool(hostId?: string): string | undefined {
  if (!hostId) return undefined;
  const configured = loadHostsFromDisk().find((h) => h.id === hostId);
  if (!configured) return `pool ${hostId}`;
  return `pool "${configured.name || configured.address}"`;
}

/** Most specific identifiable object in the request, for the target column. */
function auditTarget(f: XenActionFields): string | undefined {
  return (
    describeRef("VM", f.vmRef) ??
    describeRef("host", f.hostRef) ??
    describeRef("SR", f.srRef) ??
    describeRef("VDI", f.vdiRef) ??
    describeRef("network", f.networkRef) ??
    // `connect` identifies its pool by id; everything else rides a session
    // whose address the client still echoes back to us.
    describePool(f.hostId) ??
    (f.host ? `pool @ ${f.host}` : undefined)
  );
}

function auditDetail(f: XenActionFields): string | undefined {
  const parts: string[] = [];
  if (f.powerAction) parts.push(`powerAction=${f.powerAction}`);
  if (f.targetHostRef) {
    parts.push(`to ${describeRef("host", f.targetHostRef) ?? f.targetHostRef}`);
  }
  if (f.masterHostId) {
    parts.push(`master=${describePool(f.masterHostId) ?? f.masterHostId}`);
  }
  if (f.nameLabel) parts.push(`name=${f.nameLabel}`);
  // A bulk dismiss destroys messages irreversibly; the trail should say which.
  if (f.severity) parts.push(`severity=${f.severity}`);
  if (f.action === "rrd_record" && Array.isArray(f.sources)) {
    parts.push(`sources=${f.sources.slice(0, 10).map(String).join(",")}${f.sources.length > 10 ? ",…" : ""}`);
  }
  if (typeof f.value === "string" || typeof f.value === "number") {
    parts.push(`value=${f.value}`);
  }
  if (f.action?.startsWith("pool_wlb_")) {
    if (typeof f.wlbUrl === "string") parts.push(`wlb=${f.wlbUrl}`);
    if (typeof f.wlbUsername === "string") parts.push(`wlbUser=${f.wlbUsername}`);
    if (typeof f.xsUsername === "string") parts.push(`xenserverUser=${f.xsUsername}`);
    if (typeof f.enabled === "boolean") parts.push(f.enabled ? "resumed" : "paused");
    if (f.config && typeof f.config === "object") {
      const e = Object.entries(f.config as Record<string, unknown>);
      parts.push(`settings: ${e.slice(0, 12).map(([k, v]) => `${k}=${String(v)}`).join(", ")}${e.length > 12 ? ", …" : ""}`);
    }
  }
  if (f.action === "network_create") {
    parts.push(`type=${String(f.type)}`);
    if (typeof f.name === "string") parts.push(`name=${f.name}`);
    if (f.type === "external") parts.push(`vlan=${String(f.vlan)}`, `mtu=${String(f.mtu)}`);
    if (f.onSriov === true) parts.push("on SR-IOV");
    if (f.type === "sriov" && typeof f.pifRef === "string") parts.push(`nic=${describeRef("PIF", f.pifRef) ?? f.pifRef}`);
    if (f.type === "bond") {
      parts.push(`mode=${String(f.mode)}`, `mtu=${String(f.mtu)}`);
      if (Array.isArray(f.pifRefs)) parts.push(`nics=${f.pifRefs.length}`);
    }
  }
  if (f.action === "network_update" && f.changes && typeof f.changes === "object") {
    const e = Object.entries(f.changes as Record<string, unknown>);
    parts.push(`changes: ${e.slice(0, 10).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`).join(", ")}`);
  }
  if (f.action === "network_management_change") {
    parts.push(`network=${describeRef("network", typeof f.networkRef === "string" ? f.networkRef : undefined) ?? String(f.networkRef)}`);
    parts.push(f.mode === "Static" ? `${String(f.ip)}/${String(f.netmask)}${f.gateway ? ` gw ${String(f.gateway)}` : ""}` : String(f.mode));
  }
  if (f.action === "network_configure_ip") {
    if (!f.hostRef) parts.push("pool-wide");
    if (Array.isArray(f.interfaces)) {
      const shown = (f.interfaces as Record<string, unknown>[]).slice(0, 8).map((i) =>
        `${String(i?.name)}=${i?.mode === "Static" ? `${String(i?.ip)}/${String(i?.netmask)}` : String(i?.mode)}`,
      );
      parts.push(`interfaces: ${shown.join(", ") || "none"}`);
    }
    if (f.confirmStorage === true) parts.push("storage warning confirmed");
  }
  if (f.action === "vm_memory_change") {
    if (Array.isArray(f.vmRefs)) {
      const names = f.vmRefs.slice(0, 10).map((r) => describeRef("VM", typeof r === "string" ? r : undefined) ?? String(r));
      parts.push(`VMs: ${names.join(", ")}${f.vmRefs.length > 10 ? `, … (${f.vmRefs.length})` : ""}`);
    }
    parts.push(`min=${String(f.dynamicMin)}`, `max=${String(f.dynamicMax)}`, `static max=${String(f.staticMax)}`);
    if (f.confirmReboot === true) parts.push("reboot confirmed");
  }
  if (f.action === "pool_add_server" || f.action === "pool_add_server_check") {
    parts.push(`server=${String(f.address)}`, `user=${String(f.username)}`);
    if (f.confirmCpu === true) parts.push("CPU levelling confirmed");
  }
  if (f.action === "license_assign") parts.push(`license server=${String(f.licenseServer)}`, "edition=cloud");
  if (f.action === "license_release") parts.push("edition=trial");
  if (f.action === "gpu_set_placement") parts.push(`placement=${String(f.algorithm)}`);
  if (f.action === "gpu_set_enabled_types") {
    const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    parts.push(`GPUs=${n(f.pgpuRefs)}`, `allowed+=${n(f.enable)}`, `allowed-=${n(f.disable)}`);
  }
  if (f.action === "vm_copy") {
    parts.push(f.mode === "copy" ? `full copy to ${describeRef("SR", typeof f.srRef === "string" ? f.srRef : undefined) ?? String(f.srRef)}` : "fast clone");
  }
  if (f.action === "vm_snapshot_to_template" && typeof f.snapshotRef === "string") {
    parts.push(`snapshot=${describeRef("VM", f.snapshotRef) ?? f.snapshotRef}`);
  }
  if (f.action === "vm_convert_to_template" && f.confirm === true) parts.push("confirmed");
  if (f.action === "sr_command") {
    parts.push(`command=${String(f.command)}`, `sr=${describeRef("SR", typeof f.srRef === "string" ? f.srRef : undefined) ?? String(f.srRef)}`);
    if (f.confirm === true) parts.push("confirmed");
  }
  if (f.action === "vm_gpu_set") {
    const kept = Array.isArray(f.keep) ? f.keep.length : 0;
    const added = Array.isArray(f.add)
      ? (f.add as Record<string, unknown>[]).map((a) => describeRef("VGPU_type", typeof a?.type === "string" ? a.type : undefined) ?? String(a?.type))
      : [];
    parts.push(`kept=${kept}`, added.length ? `added: ${added.join(", ")}` : "added none");
  }
  if (f.action === "vm_import_finish") {
    const n = f.networks && typeof f.networks === "object" ? Object.keys(f.networks as object).length : 0;
    parts.push(`interfaces=${n}`, f.start === true ? "start" : "no start");
  }
  if (f.action === "host_control_domain_memory") {
    parts.push(`memory=${String(f.memory)}`);
    if (f.confirmReboot === true) parts.push("reboot confirmed");
  }
  // `connect`/`disconnect` name the pool address in target, not here.
  if (f.action !== "connect" && f.action !== "disconnect" && f.host) {
    parts.push(`via ${f.host}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

export async function POST(request: NextRequest) {
  // Peek at the body for audit metadata. dispatch() consumes the real body, so
  // the clone is what keeps both readers happy.
  let fields: XenActionFields = {};
  try {
    fields = (await request.clone().json()) as XenActionFields;
  } catch {
    // Malformed body — dispatch() will produce the error response.
  }

  // Everything the action does runs on behalf of the pool its session (or,
  // for connect, its host id) belongs to: the certificates checked are that pool's.
  const poolId = fields.action === "connect" ? fields.hostId : fields.sessionRef ? lookupSession(fields.sessionRef)?.hostId : undefined;
  const response = poolId ? await withPool(poolId, () => dispatch(request)) : await dispatch(request);
  const action = fields.action;

  // 499 means the client vanished mid-request (an aborted event long-poll):
  // nothing was decided, so there is nothing to record.
  if (!action || response.status === 499) {
    return response;
  }

  let outcome: AuditOutcome = "success";
  if (response.status === 401 || response.status === 403) outcome = "denied";
  else if (!response.ok) outcome = "failure";

  // Skip only the chatty successes. A denied or failed read-only call still
  // belongs in the trail.
  if (outcome === "success" && AUDIT_EXEMPT_ACTIONS.has(action)) {
    return response;
  }

  // Surface the server's own error text on the failure paths.
  let failureReason: string | undefined;
  if (outcome !== "success") {
    try {
      const body = (await response.clone().json()) as { error?: string };
      failureReason = body.error;
    } catch {
      failureReason = `HTTP ${response.status}`;
    }
  }

  const detail = [auditDetail(fields), failureReason]
    .filter(Boolean)
    .join(" — ");

  auditRequest(request, {
    category: auditCategory(action),
    action,
    target: auditTarget(fields),
    outcome,
    detail: detail || undefined,
  });

  return response;
}
