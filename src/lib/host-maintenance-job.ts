/**
 * Entering maintenance mode, as XenCenter's EvacuateHostAction does it, as a
 * job that keeps running on the server:
 *
 * 1. What would stop it, asked first (WlbEvacuateRecommendationsAction): with
 *    WLB, its evacuation recommendations; else -- or when WLB has none --
 *    host.get_vms_which_prevent_evacuation. A VM named there stops it before
 *    anything changed.
 * 2. host.disable, then other_config MAINTENANCE_MODE=true.
 * 3. With WLB's recommendations: each VM migrated live to the host WLB names,
 *    three tries ten seconds apart. Otherwise host.evacuate -- and, as
 *    XenMan's update jobs do, when XenServer's evacuation finds no plan for
 *    all VMs at once (HOST_NOT_ENOUGH_FREE_MEMORY naming one of them, seen
 *    with memory free on the other hosts), the VMs moved one by one to the
 *    host XenServer accepts each on (VM.assert_can_boot_here) with the most
 *    memory free. Live only: no VM is shut down.
 * 4. Anything failed: the host taken out of maintenance mode again (flag
 *    removed, host enabled) and the VM named -- as XenCenter does.
 */

import { audit } from "./audit";
import type { UserRole } from "./auth";
import { xenApiCall } from "./xen-client";
import { asyncCall, XapiTaskError, type XapiCall } from "./xen-network-actions";

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const MIGRATE_MS = Number(process.env.XENMAN_MAINT_MIGRATE_MS) || 60 * 60 * 1000;
const EVACUATE_MS = Number(process.env.XENMAN_MAINT_EVACUATE_MS) || 4 * 60 * 60 * 1000;
/** EvacuateHostAction: ten seconds between the three tries of a WLB move. */
const RETRY_PAUSE_MS = process.env.XENMAN_MAINT_RETRY_MS !== undefined ? Number(process.env.XENMAN_MAINT_RETRY_MS) : 10_000;

export interface MaintenanceJob {
  id: string;
  poolId: string;
  hostRef: string;
  hostName: string;
  state: "running" | "done" | "failed";
  /** What it is doing now, or what it did. */
  step: string;
  /** 0..1, for the task list. */
  progress: number;
  error?: string;
  startedAt: number;
}

export interface MaintenanceContext {
  poolId: string;
  address: string;
  port: number;
  useSsl: boolean;
  sessionRef: string;
  actor: string;
  role: UserRole;
  ip: string;
}

const g = globalThis as unknown as { _xenmanMaintenanceJobs?: Map<string, MaintenanceJob> };
const jobs = (g._xenmanMaintenanceJobs ??= new Map());

export function getMaintenanceJob(id: string): MaintenanceJob | undefined {
  return jobs.get(id);
}

/** A maintenance job already running for this host. */
export function runningFor(poolId: string, hostRef: string): MaintenanceJob | undefined {
  return [...jobs.values()].find((j) => j.poolId === poolId && j.hostRef === hostRef && j.state === "running");
}

/** Said with the VM's name instead of its OpaqueRef. */
async function explain(call: XapiCall, err: unknown): Promise<string> {
  const code = err instanceof Error ? err.message : String(err);
  const data = err instanceof XapiTaskError ? err.data : ((err as { data?: unknown[] })?.data ?? []).map(String);
  const named: string[] = [];
  for (const d of data) {
    if (/^OpaqueRef:/.test(d)) {
      const name = await call<string>("VM.get_name_label", [d]).catch(() => null);
      named.push(name ?? d);
    } else named.push(d);
  }
  if (code === "HOST_NOT_ENOUGH_FREE_MEMORY" && named.length) return `No host has room for ${named[0]} (HOST_NOT_ENOUGH_FREE_MEMORY)`;
  return [code, ...named].filter(Boolean).join(" ");
}

export async function startMaintenance(ctx: MaintenanceContext, hostRef: string): Promise<MaintenanceJob> {
  const call: XapiCall = <T>(method: string, params: unknown[]) =>
    xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [ctx.sessionRef, ...params]);
  const hostName = await call<string>("host.get_name_label", [hostRef]);
  const job: MaintenanceJob = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    poolId: ctx.poolId,
    hostRef,
    hostName,
    state: "running",
    step: "Checking which VMs can be moved",
    progress: 0,
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  void run(job, ctx, call);
  return job;
}

function finish(job: MaintenanceJob, ctx: MaintenanceContext, state: "done" | "failed", text: string) {
  job.state = state;
  if (state === "failed") job.error = text;
  else job.step = text;
  job.progress = 1;
  audit({
    actor: ctx.actor,
    role: ctx.role,
    ip: ctx.ip,
    category: "host",
    action: "host_maintenance_enter_finished",
    target: `host "${job.hostName}"`,
    outcome: state === "done" ? "success" : "failure",
    detail: text,
  });
  // Kept a while for the browser to read; then gone.
  setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref?.();
}

async function run(job: MaintenanceJob, ctx: MaintenanceContext, call: XapiCall) {
  const h = job.hostRef;
  const vmName = (vm: string) => call<string>("VM.get_name_label", [vm]).catch(() => vm);
  let disabled = false;
  try {
    // 1. WlbEvacuateRecommendationsAction.
    const pools = await call<Record<string, Rec>>("pool.get_all_records", []);
    const pool = Object.values(pools)[0] ?? {};
    const wlb = pool.wlb_enabled === true && str(pool.wlb_url) !== "";
    let recs: Record<string, string[]> = {};
    if (wlb) recs = await call<Record<string, string[]>>("host.retrieve_wlb_evacuate_recommendations", [h]).catch(() => ({}));
    const hosts = await call<Record<string, Rec>>("host.get_all_records", []);
    const metrics = await call<Record<string, Rec>>("host_metrics.get_all_records", []).catch(() => ({}) as Record<string, Rec>);
    const byUuid = (uuid: string) => Object.keys(hosts).find((r) => str(hosts[r].uuid) === uuid);
    const live = (ref: string) => metrics[str(hosts[ref]?.metrics)]?.live === true;
    // ValidRecommendation: every VM is to go to a host that is up. XenCenter
    // also follows recommendations that power a host on first; XenMan powers
    // no hosts on, so such a plan is not followed -- as without recommendations.
    const vmRecs = Object.entries(recs);
    let useWlb = vmRecs.length > 0;
    for (const [vm, v] of vmRecs) {
      if (!useWlb) break;
      if (str(v[0]).trim().toLowerCase() !== "wlb") continue;
      if (await call<boolean>("VM.get_is_control_domain", [vm]).catch(() => false)) continue;
      const to = byUuid(str(v[1]));
      if (!to || !live(to)) useWlb = false;
    }
    if (useWlb) {
      // NoRecommendationError: an entry that is not a move is WLB's reason why not.
      const wrong = vmRecs.find(([, v]) => str(v[0]).trim().toLowerCase() !== "wlb");
      if (wrong) {
        throw new Refused(`${await vmName(wrong[0])}: ${wrong[1].filter(Boolean).join(" ")}`);
      }
    } else {
      const prevent = await call<Record<string, string[]>>("host.get_vms_which_prevent_evacuation", [h]).catch(() => ({}));
      const blockers = Object.entries(prevent);
      if (blockers.length) {
        const named = await Promise.all(blockers.map(async ([vm, why]) => `${await vmName(vm)} (${why.filter(Boolean).join(" ")})`));
        throw new Refused(`These VMs cannot be moved off ${job.hostName}: ${named.join(", ")}`);
      }
    }

    // 2. Disable, then the flag (EvacuateHostAction.Disable).
    job.step = `Disabling ${job.hostName}`;
    job.progress = 0.1;
    await asyncCall(call, "host.disable", [h], 120_000);
    disabled = true;
    await call("host.remove_from_other_config", [h, "MAINTENANCE_MODE"]).catch(() => {});
    await call("host.add_to_other_config", [h, "MAINTENANCE_MODE", "true"]);
    job.progress = 0.2;

    // 3. The VMs off the host.
    let how: string;
    if (useWlb) how = await moveByWlb(job, call, recs, hosts, byUuid);
    else how = await evacuate(job, call);

    // Nothing running left but the control domain.
    const left: string[] = [];
    for (const vm of await call<string[]>("host.get_resident_VMs", [h])) {
      const r = await call<Rec>("VM.get_record", [vm]).catch(() => null);
      if (r && r.is_control_domain !== true && str(r.power_state) === "Running") left.push(str(r.name_label));
    }
    if (left.length) throw new Error(`Still running on ${job.hostName}: ${left.join(", ")}`);
    finish(job, ctx, "done", `${job.hostName} is in maintenance mode; ${how}`);
  } catch (err) {
    const why = err instanceof Refused ? err.message : await explain(call, err);
    if (disabled) {
      // EvacuateHostAction: on failure the host leaves maintenance mode again.
      job.step = `Taking ${job.hostName} out of maintenance mode again`;
      await call("host.remove_from_other_config", [h, "MAINTENANCE_MODE"]).catch(() => {});
      await asyncCall(call, "host.enable", [h], 120_000).catch(() => {});
    }
    finish(job, ctx, "failed", `${job.hostName} was not put into maintenance mode: ${why}`);
  }
}

class Refused extends Error {}

/** EvacuateHostAction with WLB: each VM to the host WLB names, three tries. */
async function moveByWlb(
  job: MaintenanceJob,
  call: XapiCall,
  recs: Record<string, string[]>,
  hosts: Record<string, Rec>,
  byUuid: (uuid: string) => string | undefined,
): Promise<string> {
  const moves: { vm: string; to: string }[] = [];
  for (const [vm, v] of Object.entries(recs)) {
    const to = byUuid(str(v[1]));
    if (!to) continue;
    const isDom0 = await call<boolean>("VM.get_is_control_domain", [vm]).catch(() => false);
    // A control domain's entry asks for its host to be powered on: XenMan does not power hosts on.
    if (isDom0) continue;
    moves.push({ vm, to });
  }
  let done = 0;
  for (const { vm, to } of moves) {
    const name = await call<string>("VM.get_name_label", [vm]).catch(() => vm);
    job.step = `Migrating ${name} to ${str(hosts[to]?.name_label)} (WLB)`;
    let last: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await asyncCall(call, "VM.pool_migrate", [vm, to, { live: "true" }], MIGRATE_MS);
        last = null;
        break;
      } catch (err) {
        last = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
      }
    }
    if (last) throw last;
    done++;
    job.progress = 0.2 + (0.8 * done) / Math.max(moves.length, 1);
  }
  return `${done} VM${done === 1 ? "" : "s"} migrated as WLB recommended`;
}

/** host.evacuate; when it finds no plan for all VMs at once, one by one. */
async function evacuate(job: MaintenanceJob, call: XapiCall): Promise<string> {
  const h = job.hostRef;
  job.step = `Migrating all VMs off ${job.hostName}`;
  try {
    await asyncCall(call, "host.evacuate", [h], EVACUATE_MS);
    return "all VMs migrated";
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "HOST_NOT_ENOUGH_FREE_MEMORY") throw err;
  }
  // As the update jobs' moveOneByOne: the biggest first, live, to the host
  // XenServer accepts the VM on with the most memory free.
  const vms: { vm: string; name: string; mem: number }[] = [];
  for (const vm of await call<string[]>("host.get_resident_VMs", [h])) {
    const r = await call<Rec>("VM.get_record", [vm]).catch(() => null);
    if (!r || r.is_control_domain === true || str(r.power_state) !== "Running") continue;
    vms.push({ vm, name: str(r.name_label), mem: Number(r.memory_dynamic_max ?? r.memory_static_max ?? 0) });
  }
  vms.sort((a, b) => b.mem - a.mem);
  const others = (await call<string[]>("host.get_all", [])).filter((x) => x !== h);
  let done = 0;
  for (const { vm, name } of vms) {
    let best: string | null = null;
    let bestFree = -1;
    let why = "";
    for (const x of others) {
      if (!(await call<boolean>("host.get_enabled", [x]).catch(() => false))) continue;
      try {
        await call("VM.assert_can_boot_here", [vm, x]);
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
        continue;
      }
      const free = Number(await call<string>("host.compute_free_memory", [x]).catch(() => "0"));
      if (free > bestFree) {
        best = x;
        bestFree = free;
      }
    }
    if (!best) throw new Refused(`No host takes ${name}${why ? ` (${why})` : ""}`);
    const target = await call<string>("host.get_name_label", [best]).catch(() => best);
    job.step = `Migrating ${name} to ${target} (one by one: XenServer found no plan for all VMs at once)`;
    await asyncCall(call, "VM.pool_migrate", [vm, best, { live: "true" }], MIGRATE_MS);
    done++;
    job.progress = 0.2 + (0.8 * done) / vms.length;
  }
  return `${done} VM${done === 1 ? "" : "s"} migrated one by one (XenServer found no plan for all at once)`;
}
