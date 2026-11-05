import { JsonRpcRequest, JsonRpcResponse } from "./types";
import { NotConfirmedError, xenFetch, type XenResponse } from "./xen-tls";
import { CertMismatchError } from "./host-trust";

let requestId = 0;

function nextId(): number {
  return ++requestId;
}

export async function xenApiCall<T = unknown>(
  host: string,
  port: number,
  useSsl: boolean,
  method: string,
  params: unknown[],
  signal?: AbortSignal,
): Promise<T> {
  const protocol = useSsl ? "https" : "http";
  const url = `${protocol}://${host}:${port}/jsonrpc`;

  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
    params,
    id: nextId(),
  };

  let response: XenResponse;
  try {
    // Only once the host has shown a certificate of its pool (lib/xen-tls.ts).
    response = await xenFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // A refused certificate is said as it is, not as a network failure to retry.
    if (err instanceof CertMismatchError || err instanceof NotConfirmedError) throw err;
    // Enhance fetch errors with the underlying cause for debugging
    const cause = err instanceof Error && err.cause ? ` (${err.cause})` : "";
    throw new Error(`fetch to ${method} failed: ${err instanceof Error ? err.message : err}${cause}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = parseXapiJson(await response.text()) as JsonRpcResponse<T>;

  if (data.error) {
    throw new XenApiError(data.error.message, data.error.code, data.error.data);
  }

  return data.result as T;
}

/**
 * XAPI's JSON, which is not always JSON: floats it has no value for come as
 * bare NaN or Infinity (seen in host.get_data_sources: "max":Infinity).
 * Parsed as it is when it can be; otherwise those words outside strings
 * become null.
 */
export function parseXapiJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        // A string, copied as it is, escapes included.
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const m = /^-?(?:NaN|Infinity)/.exec(text.slice(i, i + 9));
      if (m) {
        out += "null";
        i += m[0].length;
        continue;
      }
      out += c;
      i++;
    }
    if (out === text) throw err;
    return JSON.parse(out);
  }
}

export class XenApiError extends Error {
  code: number;
  data?: unknown[];

  constructor(message: string, code: number, data?: unknown[]) {
    super(message);
    this.name = "XenApiError";
    this.code = code;
    this.data = data;
  }
}

/**
 * A refused login, said with what XenServer gave as the reason (error.data:
 * [user, reason]) -- for a domain user that reason is the only clue -- and
 * what a domain user needs, which joining the domain alone does not give.
 */
export function loginRefusedMessage(err: XenApiError, username: string): string {
  const reason = typeof err.data?.[1] === "string" ? err.data[1].trim() : "";
  const domainUser = username.includes("\\") || username.includes("@");
  return (
    `XenServer did not accept the login of "${username}"${reason ? `: ${reason}` : ""}. ` +
    (domainUser
      ? "A domain user (or a group of it) has to be added to the pool's users with the pool-admin role, and the password entered with it."
      : "A domain user is written DOMAIN\\user or user@domain.")
  );
}

export async function loginToHost(
  host: string,
  port: number,
  useSsl: boolean,
  username: string,
  password: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "session.login_with_password", [
    username,
    password,
    "1.0",
    "XenMan",
  ]);
}

export async function logout(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "session.logout", [sessionRef]);
}

export async function getAllVmRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "VM.get_all_records", [sessionRef]);
}

export async function getAllVmMetrics(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "VM_metrics.get_all_records", [sessionRef]);
}

export async function getAllHostRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "host.get_all_records", [sessionRef]);
}

export async function getAllPoolRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "pool.get_all_records", [sessionRef]);
}

export async function getAllSRRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "SR.get_all_records", [sessionRef]);
}

export async function srCreate(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, hostRef: string,
  deviceConfig: Record<string, string>, nameLabel: string, nameDescription: string,
  srType: string, contentType: string, shared: boolean, smConfig: Record<string, string>,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "SR.create", [
    sessionRef, hostRef, deviceConfig, "0", nameLabel, nameDescription, srType, contentType, shared, smConfig,
  ]);
}

export async function srScan(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, srRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "SR.scan", [sessionRef, srRef]);
}

export async function srGetUuid(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, srRef: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "SR.get_uuid", [sessionRef, srRef]);
}

export async function poolGetDefaultSR(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, poolRef: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "pool.get_default_SR", [sessionRef, poolRef]);
}

export async function poolGetAll(
  host: string, port: number, useSsl: boolean,
  sessionRef: string,
): Promise<string[]> {
  return xenApiCall<string[]>(host, port, useSsl, "pool.get_all", [sessionRef]);
}

export async function vmGetOtherConfig(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<Record<string, string>> {
  return xenApiCall<Record<string, string>>(host, port, useSsl, "VM.get_other_config", [sessionRef, vmRef]);
}

export async function vmRemoveFromOtherConfig(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, key: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.remove_from_other_config", [sessionRef, vmRef, key]);
}

export async function vmAddToOtherConfig(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, key: string, value: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.add_to_other_config", [sessionRef, vmRef, key, value]);
}

export async function getAllNetworkRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "network.get_all_records", [sessionRef]);
}

export async function getAllPIFRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "PIF.get_all_records", [sessionRef]);
}

/**
 * The rest of a pool's networking, for the Networking tab: link state and NIC
 * details, bonds, VLANs, SR-IOV. Each class whole, as get_all_records gives it;
 * a class this XenServer does not know (network_sriov before 7.5) is empty.
 */
export async function getNetworkingRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<{
  pifMetrics: Record<string, Record<string, unknown>>;
  bonds: Record<string, Record<string, unknown>>;
  vlans: Record<string, Record<string, unknown>>;
  sriovs: Record<string, Record<string, unknown>>;
}> {
  const all = (cls: string) =>
    xenApiCall<Record<string, Record<string, unknown>>>(host, port, useSsl, `${cls}.get_all_records`, [sessionRef]).catch(() => ({}));
  const [pifMetrics, bonds, vlans, sriovs] = await Promise.all([all("PIF_metrics"), all("Bond"), all("VLAN"), all("network_sriov")]);
  return { pifMetrics, bonds, vlans, sriovs };
}

export async function getAllVBDRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "VBD.get_all_records", [sessionRef]);
}

export async function getAllVDIRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "VDI.get_all_records", [sessionRef]);
}

export async function getAllVIFRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "VIF.get_all_records", [sessionRef]);
}

export async function vmGetAllowedVIFDevices(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<string[]> {
  return xenApiCall<string[]>(host, port, useSsl, "VM.get_allowed_VIF_devices", [sessionRef, vmRef]);
}

export async function vifCreate(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vmRef: string,
  networkRef: string,
  device: string,
  mac: string,
): Promise<string> {
  const record: Record<string, unknown> = {
    VM: vmRef,
    network: networkRef,
    device,
    MAC: mac,
    MTU: "1500",
    other_config: {},
    qos_algorithm_type: "",
    qos_algorithm_params: {},
    locking_mode: "network_default",
    ipv4_allowed: [],
    ipv6_allowed: [],
  };
  return xenApiCall<string>(host, port, useSsl, "VIF.create", [sessionRef, record]);
}

export async function vifDestroy(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vifRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VIF.destroy", [sessionRef, vifRef]);
}

export async function vifPlug(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vifRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VIF.plug", [sessionRef, vifRef]);
}

export async function vifUnplug(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vifRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VIF.unplug", [sessionRef, vifRef]);
}

export async function getHostMetrics(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  metricsRef: string,
): Promise<Record<string, unknown>> {
  return xenApiCall(host, port, useSsl, "host_metrics.get_record", [
    sessionRef,
    metricsRef,
  ]);
}

export async function vmPowerAction(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vmRef: string,
  action:
    | "start"
    | "clean_shutdown"
    | "hard_shutdown"
    | "clean_reboot"
    | "hard_reboot"
    | "suspend"
    | "resume"
    | "pause"
    | "unpause",
): Promise<void> {
  const methodMap: Record<string, { method: string; params: unknown[] }> = {
    start: { method: "VM.start", params: [sessionRef, vmRef, false, false] },
    clean_shutdown: {
      method: "VM.clean_shutdown",
      params: [sessionRef, vmRef],
    },
    hard_shutdown: { method: "VM.hard_shutdown", params: [sessionRef, vmRef] },
    clean_reboot: { method: "VM.clean_reboot", params: [sessionRef, vmRef] },
    hard_reboot: { method: "VM.hard_reboot", params: [sessionRef, vmRef] },
    suspend: { method: "VM.suspend", params: [sessionRef, vmRef] },
    resume: { method: "VM.resume", params: [sessionRef, vmRef, false, false] },
    pause: { method: "VM.pause", params: [sessionRef, vmRef] },
    unpause: { method: "VM.unpause", params: [sessionRef, vmRef] },
  };

  const { method, params } = methodMap[action];
  await xenApiCall(host, port, useSsl, method, params);
}

export async function vmStartOn(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vmRef: string,
  targetHostRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.start_on", [
    sessionRef,
    vmRef,
    targetHostRef,
    false,
    false,
  ]);
}

export async function vmMigrateAsync(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vmRef: string,
  targetHostRef: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "Async.VM.pool_migrate", [
    sessionRef,
    vmRef,
    targetHostRef,
    { live: "true" },
  ]);
}

// ── Host Operations ──

export async function hostDisable(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  hostRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "host.disable", [sessionRef, hostRef]);
}

export async function hostEnable(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  hostRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "host.enable", [sessionRef, hostRef]);
}

export async function hostAddToOtherConfig(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  hostRef: string,
  key: string,
  value: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "host.add_to_other_config", [sessionRef, hostRef, key, value]);
}

export async function hostRemoveFromOtherConfig(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  hostRef: string,
  key: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "host.remove_from_other_config", [sessionRef, hostRef, key]);
}

export async function hostEvacuateAsync(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  hostRef: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "Async.host.evacuate", [sessionRef, hostRef]);
}

export async function hostRestartAgent(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, hostRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "host.restart_agent", [sessionRef, hostRef]);
}

export async function hostShutdown(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, hostRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "host.shutdown", [sessionRef, hostRef]);
}

export async function hostReboot(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, hostRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "host.reboot", [sessionRef, hostRef]);
}

// ── Pool Operations ──

export async function poolJoin(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  masterAddress: string,
  masterUsername: string,
  masterPassword: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.join", [sessionRef, masterAddress, masterUsername, masterPassword]);
}

export async function poolSetNameLabel(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  poolRef: string,
  name: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.set_name_label", [sessionRef, poolRef, name]);
}

export async function poolAddToOtherConfig(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  poolRef: string,
  key: string,
  value: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.add_to_other_config", [sessionRef, poolRef, key, value]);
}

export async function poolRemoveFromOtherConfig(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  poolRef: string,
  key: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.remove_from_other_config", [sessionRef, poolRef, key]);
}

// ── Workload Balancing ──
//
// The pool talks to the WLB server itself; XenMan only asks the pool. The
// initialize/deconfigure/configuration/recommendation messages are static on
// the pool class (no pool ref), the two setters are ordinary field setters.

/**
 * Connects the pool to a WLB server. Two accounts: the pool logs in to WLB
 * with the first, WLB logs back in to the pool with the second (pool-admin or
 * pool-operator). Neither is kept by XenMan.
 */
export async function poolInitializeWlb(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  wlbUrl: string,
  wlbUsername: string,
  wlbPassword: string,
  xenserverUsername: string,
  xenserverPassword: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.initialize_wlb", [
    sessionRef, wlbUrl, wlbUsername, wlbPassword, xenserverUsername, xenserverPassword,
  ]);
}

export async function poolDeconfigureWlb(host: string, port: number, useSsl: boolean, sessionRef: string): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.deconfigure_wlb", [sessionRef]);
}

/** XenCenter's "Pause" and "Resume": WLB stays configured, and stops or starts acting. */
export async function poolSetWlbEnabled(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  poolRef: string,
  enabled: boolean,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.set_wlb_enabled", [sessionRef, poolRef, enabled]);
}

export async function poolSetWlbVerifyCert(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  poolRef: string,
  verify: boolean,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.set_wlb_verify_cert", [sessionRef, poolRef, verify]);
}

export async function poolRetrieveWlbConfiguration(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, string>> {
  return xenApiCall<Record<string, string>>(host, port, useSsl, "pool.retrieve_wlb_configuration", [sessionRef]);
}

/** Only the keys given are changed; WLB keeps the rest. */
export async function poolSendWlbConfiguration(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  config: Record<string, string>,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "pool.send_wlb_configuration", [sessionRef, config]);
}

/** VM ref -> ["WLB", target host ref, optimization id, recommendation id, reason]. */
export async function poolRetrieveWlbRecommendations(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, string[]>> {
  return xenApiCall<Record<string, string[]>>(host, port, useSsl, "pool.retrieve_wlb_recommendations", [sessionRef]);
}

// ── Event Polling (event.from) ──

export interface XenRawEvent {
  id: string;
  timestamp: string;
  class: string;
  operation: "add" | "mod" | "del";
  ref: string;
  snapshot: Record<string, unknown> | null;
}

export interface EventFromResult {
  events: XenRawEvent[];
  token: string;
  valid_ref_counts: Record<string, number>;
}

export async function eventFrom(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  classes: string[],
  token: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<EventFromResult> {
  return xenApiCall<EventFromResult>(host, port, useSsl, "event.from", [
    sessionRef,
    classes,
    token,
    timeout,
  ], signal);
}

// ── Alerts (XAPI `message` objects) ──

export async function messageGetAllRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "message.get_all_records", [sessionRef]);
}

/** Acknowledge an alert. XAPI has no "read" flag — dismissing means destroying. */
export async function messageDestroy(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  messageRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "message.destroy", [sessionRef, messageRef]);
}

// ── Task Polling ──

export async function taskGetRecord(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  taskRef: string,
): Promise<Record<string, unknown>> {
  return xenApiCall<Record<string, unknown>>(host, port, useSsl, "task.get_record", [sessionRef, taskRef]);
}

export async function taskGetAllRecords(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
): Promise<Record<string, Record<string, unknown>>> {
  return xenApiCall(host, port, useSsl, "task.get_all_records", [sessionRef]);
}

export async function taskGetResult(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  taskRef: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "task.get_result", [sessionRef, taskRef]);
}

// ── VM Creation ──

export async function vmCloneAsync(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  templateRef: string,
  newName: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "Async.VM.clone", [sessionRef, templateRef, newName]);
}

export async function vmProvisionAsync(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vmRef: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "Async.VM.provision", [sessionRef, vmRef]);
}

export async function vmSetAffinity(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vmRef: string,
  hostRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_affinity", [sessionRef, vmRef, hostRef]);
}

// ── VM Settings ──

export async function vmSetNameLabel(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, value: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_name_label", [sessionRef, vmRef, value]);
}

export async function vmSetNameDescription(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, value: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_name_description", [sessionRef, vmRef, value]);
}

export async function vmSetVCPUsMax(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, value: number,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_VCPUs_max", [sessionRef, vmRef, String(value)]);
}

export async function vmSetVCPUsAtStartup(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, value: number,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_VCPUs_at_startup", [sessionRef, vmRef, String(value)]);
}

export async function vmSetMemoryLimits(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
  staticMin: number, staticMax: number, dynMin: number, dynMax: number,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_memory_limits", [
    sessionRef, vmRef,
    String(staticMin), String(staticMax), String(dynMin), String(dynMax),
  ]);
}

export async function vmAddTag(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, tag: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.add_tags", [sessionRef, vmRef, tag]);
}

export async function vmRemoveTag(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, tag: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.remove_tags", [sessionRef, vmRef, tag]);
}

export async function vdiResize(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vdiRef: string, size: number,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VDI.resize", [sessionRef, vdiRef, String(size)]);
}

export async function vdiCreate(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, srRef: string, nameLabel: string, nameDescription: string, virtualSize: number, type: string,
): Promise<string> {
  const record: Record<string, unknown> = {
    SR: srRef,
    name_label: nameLabel,
    name_description: nameDescription,
    virtual_size: String(virtualSize),
    type,
    sharable: false,
    read_only: false,
    other_config: {},
    tags: [],
  };
  return xenApiCall<string>(host, port, useSsl, "VDI.create", [sessionRef, record]);
}

export async function vdiDestroy(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vdiRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VDI.destroy", [sessionRef, vdiRef]);
}

export async function vdiSetNameLabel(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vdiRef: string, nameLabel: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VDI.set_name_label", [sessionRef, vdiRef, nameLabel]);
}

export async function vbdCreate(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, vdiRef: string, device: string, bootable: boolean,
): Promise<string> {
  const record: Record<string, unknown> = {
    VM: vmRef,
    VDI: vdiRef,
    userdevice: device,
    bootable,
    mode: "RW",
    type: "Disk",
    empty: false,
    other_config: {},
    qos_algorithm_type: "",
    qos_algorithm_params: {},
  };
  return xenApiCall<string>(host, port, useSsl, "VBD.create", [sessionRef, record]);
}

export async function vmGetAllowedVBDDevices(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<string[]> {
  return xenApiCall<string[]>(host, port, useSsl, "VM.get_allowed_VBD_devices", [sessionRef, vmRef]);
}

export async function vbdCreateCd(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, device: string,
): Promise<string> {
  const record: Record<string, unknown> = {
    VM: vmRef,
    VDI: "OpaqueRef:NULL",
    userdevice: device,
    bootable: false,
    mode: "RO",
    type: "CD",
    empty: true,
    other_config: {},
    qos_algorithm_type: "",
    qos_algorithm_params: {},
  };
  return xenApiCall<string>(host, port, useSsl, "VBD.create", [sessionRef, record]);
}

export async function vbdPlug(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vbdRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VBD.plug", [sessionRef, vbdRef]);
}

export async function vbdUnplug(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vbdRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VBD.unplug", [sessionRef, vbdRef]);
}

export async function vbdDestroy(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vbdRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VBD.destroy", [sessionRef, vbdRef]);
}

export async function vbdInsert(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vbdRef: string, vdiRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VBD.insert", [sessionRef, vbdRef, vdiRef]);
}

export async function vbdEject(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vbdRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VBD.eject", [sessionRef, vbdRef]);
}

export async function vmSetHVMBootParams(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, key: string, value: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.add_to_HVM_boot_params", [sessionRef, vmRef, key, value]);
}

export async function vmGetHVMBootParams(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<Record<string, string>> {
  return xenApiCall(host, port, useSsl, "VM.get_HVM_boot_params", [sessionRef, vmRef]);
}

export async function vmGetPlatform(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<Record<string, string>> {
  return xenApiCall(host, port, useSsl, "VM.get_platform", [sessionRef, vmRef]);
}

export async function vmSetPlatform(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, platform: Record<string, string>,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_platform", [sessionRef, vmRef, platform]);
}

export async function vmGetNVRAM(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<Record<string, string>> {
  return xenApiCall(host, port, useSsl, "VM.get_NVRAM", [sessionRef, vmRef]);
}

export async function vmSetNVRAM(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, nvram: Record<string, string>,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_NVRAM", [sessionRef, vmRef, nvram]);
}

export async function vmGetVTPMs(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<string[]> {
  return xenApiCall(host, port, useSsl, "VM.get_VTPMs", [sessionRef, vmRef]);
}

export async function vtpmCreate(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, isUnique: boolean,
): Promise<string> {
  return xenApiCall(host, port, useSsl, "VTPM.create", [sessionRef, vmRef, isUnique]);
}

export async function vmSetHVMBootParamsMap(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, params: Record<string, string>,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.set_HVM_boot_params", [sessionRef, vmRef, params]);
}

export async function vmDestroy(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.destroy", [sessionRef, vmRef]);
}

export async function vmGetVBDs(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<string[]> {
  return xenApiCall(host, port, useSsl, "VM.get_VBDs", [sessionRef, vmRef]);
}

export async function vmGetVIFs(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<string[]> {
  return xenApiCall(host, port, useSsl, "VM.get_VIFs", [sessionRef, vmRef]);
}

export async function vbdGetRecord(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vbdRef: string,
): Promise<Record<string, unknown>> {
  return xenApiCall(host, port, useSsl, "VBD.get_record", [sessionRef, vbdRef]);
}

export async function getVmConsoles(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  vmRef: string,
): Promise<string[]> {
  return xenApiCall<string[]>(host, port, useSsl, "VM.get_consoles", [
    sessionRef,
    vmRef,
  ]);
}

export async function getConsoleRecord(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  consoleRef: string,
): Promise<Record<string, unknown>> {
  return xenApiCall(host, port, useSsl, "console.get_record", [
    sessionRef,
    consoleRef,
  ]);
}

// ── Snapshot Operations ──

export async function vmGetSnapshots(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<string[]> {
  return xenApiCall<string[]>(host, port, useSsl, "VM.get_snapshots", [sessionRef, vmRef]);
}

export async function vmGetRecord(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string,
): Promise<Record<string, unknown>> {
  return xenApiCall<Record<string, unknown>>(host, port, useSsl, "VM.get_record", [sessionRef, vmRef]);
}

export async function vmSnapshot(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, nameLabel: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "VM.snapshot", [sessionRef, vmRef, nameLabel]);
}

export async function vmCheckpoint(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, vmRef: string, nameLabel: string,
): Promise<string> {
  return xenApiCall<string>(host, port, useSsl, "VM.checkpoint", [sessionRef, vmRef, nameLabel]);
}

export async function vmRevert(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, snapshotRef: string,
): Promise<void> {
  await xenApiCall(host, port, useSsl, "VM.revert", [sessionRef, snapshotRef]);
}

export async function vmGetGuestMetricsRecord(
  host: string, port: number, useSsl: boolean,
  sessionRef: string, guestMetricsRef: string,
): Promise<Record<string, unknown>> {
  return xenApiCall<Record<string, unknown>>(host, port, useSsl, "VM_guest_metrics.get_record", [sessionRef, guestMetricsRef]);
}

export async function getHostConsoleUrl(
  host: string,
  port: number,
  useSsl: boolean,
  sessionRef: string,
  hostRef: string,
): Promise<{ url: string; protocol: string } | null> {
  // Dom0 (control domain) VMs hold the host console
  const allVms = await xenApiCall<Record<string, Record<string, unknown>>>(
    host,
    port,
    useSsl,
    "VM.get_all_records",
    [sessionRef],
  );

  // Find the control domain resident on this host
  const dom0Entry = Object.entries(allVms).find(
    ([, r]) => r.is_control_domain === true && r.resident_on === hostRef,
  );
  if (!dom0Entry) return null;

  const dom0Ref = dom0Entry[0];
  const consoleRefs = await xenApiCall<string[]>(
    host,
    port,
    useSsl,
    "VM.get_consoles",
    [sessionRef, dom0Ref],
  );
  if (consoleRefs.length === 0) return null;

  // Prefer rfb (VNC) console, same as VM console logic
  let bestConsole: { url: string; protocol: string } | null = null;
  for (const cRef of consoleRefs) {
    const record = await xenApiCall<Record<string, unknown>>(
      host,
      port,
      useSsl,
      "console.get_record",
      [sessionRef, cRef],
    );
    const protocol = record.protocol as string;
    const location = record.location as string;
    if (!bestConsole || protocol === "rfb") {
      bestConsole = { url: location, protocol };
    }
  }

  return bestConsole;
}

