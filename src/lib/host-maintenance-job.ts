/**
 * Entering maintenance mode, as XenCenter's EvacuateHostAction does it, as a
 * job that keeps running on the server:
 *
 * 1. What would stop it, asked first (WlbEvacuateRecommendationsAction): with
 *    WLB, its evacuation recommendations; else -- or when WLB has none --
 *    host.get_vms_which_prevent_evacuation. A VM named there stops it before
 *    anything changed -- except, with WLB, for a lack of free memory.
 * 2. host.disable, then other_config MAINTENANCE_MODE=true.
 * 3. With WLB's recommendations: each VM migrated live to the host WLB names,
 *    three tries ten seconds apart; the VMs WLB has no host for
 *    (HOST_NOT_ENOUGH_FREE_MEMORY, where XenCenter stops) then one by one as
 *    below. Otherwise host.evacuate -- and, as
 *    XenMan's update jobs do, when XenServer's evacuation finds no plan for
 *    all VMs at once (HOST_NOT_ENOUGH_FREE_MEMORY naming one of them, seen
 *    with memory free on the other hosts), the VMs moved one by one to the
 *    host XenServer accepts each on (VM.assert_can_boot_here) with the most
 *    memory free. Live only: no VM is shut down.
 * 4. When the host is the coordinator and a new one was chosen: once the VMs
 *    are off, Pool.async_designate_new_master to it, as EvacuateHostAction
 *    does. The old coordinator stops answering for the pool as it hands over;
 *    the change is then confirmed over a new session (pool.get_master).
 * 5. Anything failed: the host taken out of maintenance mode again (flag
 *    removed, host enabled) and the VM named -- as XenCenter does.
 *
 * And, as a job of its own, only the change of coordinator (startDesignate),
 * for "Make Pool Coordinator" -- XenCenter has it only in the dialog above.
 */

import { audit } from "./audit";
import type { UserRole } from "./auth";
import { xenApiCall } from "./xen-client";
import { asyncCall, XapiTaskError, type XapiCall } from "./xen-network-actions";
import { call as poolCall, closePoolSession, openPoolSession } from "./xen-updates";
import { coordinatorCandidates, coordinatorChangeBlocked, type CoordinatorCandidate } from "./pool-coordinator";

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const MIGRATE_MS = Number(process.env.XENMAN_MAINT_MIGRATE_MS) || 60 * 60 * 1000;
const EVACUATE_MS = Number(process.env.XENMAN_MAINT_EVACUATE_MS) || 4 * 60 * 60 * 1000;
/** EvacuateHostAction: ten seconds between the three tries of a WLB move. */
const RETRY_PAUSE_MS = process.env.XENMAN_MAINT_RETRY_MS !== undefined ? Number(process.env.XENMAN_MAINT_RETRY_MS) : 10_000;
/** How long the change of coordinator may take; how long the pool may then take to name the new one. */
const DESIGNATE_MS = 10 * 60 * 1000;
const CONFIRM_MS = Number(process.env.XENMAN_COORD_CONFIRM_MS) || 2 * 60 * 1000;
const CONFIRM_POLL_MS = Number(process.env.XENMAN_COORD_POLL_MS) || 3000;

export interface MaintenanceJob {
  id: string;
  /** Maintenance mode, or only a new coordinator ("Make Pool Coordinator"). */
  kind: "maintenance" | "designate";
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
  /** The coordinator this job is to make, if any. */
  newCoordinator?: CoordinatorCandidate;
  /** The pool has a new coordinator: sessions with the old one are gone. */
  coordinatorChanged?: boolean;
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

/** Any job still running in this pool: one change of hosts at a time. */
export function runningInPool(poolId: string): MaintenanceJob | undefined {
  return [...jobs.values()].find((j) => j.poolId === poolId && j.state === "running");
}

export type CoordinatorCheck =
  | { ok: true; to: CoordinatorCandidate; from: CoordinatorCandidate }
  | { ok: false; status: number; error: string };

/**
 * Whether `toRef` can become the coordinator now -- and, given `fromRef`,
 * whether that host is the coordinator. What EvacuateHostDialog offers, asked
 * again on the server.
 */
export async function checkCoordinatorChange(call: XapiCall, toRef: string, fromRef?: string): Promise<CoordinatorCheck> {
  const pools = await call<Record<string, Rec>>("pool.get_all_records", []);
  const pool = Object.values(pools)[0] ?? {};
  const master = str(pool.master);
  const hosts = await call<Record<string, Rec>>("host.get_all_records", []);
  const metrics = await call<Record<string, Rec>>("host_metrics.get_all_records", []).catch(() => ({}) as Record<string, Rec>);
  const name = (ref: string) => str(hosts[ref]?.name_label) || ref;
  if (fromRef !== undefined && fromRef !== master) return { ok: false, status: 400, error: `${name(fromRef)} is not the pool coordinator` };
  if (!hosts[toRef]) return { ok: false, status: 400, error: "No such host in this pool" };
  if (toRef === master) return { ok: false, status: 400, error: `${name(toRef)} is already the pool coordinator` };
  const blocked = coordinatorChangeBlocked(pool, Object.values(hosts));
  if (blocked) return { ok: false, status: 409, error: blocked };
  const to = coordinatorCandidates(hosts, metrics, master).find((c) => c.ref === toRef);
  if (!to) return { ok: false, status: 400, error: `${name(toRef)} is not enabled and running, so it cannot become the coordinator` };
  return { ok: true, to, from: { ref: master, name: name(master) } };
}

/** For the dialogs: whether the host is the coordinator, who could take over, and what stops it. */
export async function coordinatorOptions(call: XapiCall, hostRef: string) {
  const pools = await call<Record<string, Rec>>("pool.get_all_records", []);
  const pool = Object.values(pools)[0] ?? {};
  const master = str(pool.master);
  const hosts = await call<Record<string, Rec>>("host.get_all_records", []);
  const metrics = await call<Record<string, Rec>>("host_metrics.get_all_records", []).catch(() => ({}) as Record<string, Rec>);
  return {
    coordinator: { ref: master, name: str(hosts[master]?.name_label) || master },
    isCoordinator: hostRef === master,
    blocked: coordinatorChangeBlocked(pool, Object.values(hosts)),
    candidates: coordinatorCandidates(hosts, metrics, master),
  };
}

/**
 * Pool.async_designate_new_master, followed to its end. The old coordinator
 * may stop answering for the pool before its task reports back; then the pool
 * is asked again, over a new session, until it names the new coordinator.
 */
async function designate(poolId: string, call: XapiCall, to: CoordinatorCandidate) {
  const task = await call<string>("Async.pool.designate_new_master", [to.ref]);
  const until = Date.now() + DESIGNATE_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    let t: Rec;
    try {
      t = await call<Rec>("task.get_record", [task]);
    } catch {
      return confirmCoordinator(poolId, to);
    }
    const status = str(t.status);
    if (status === "pending") {
      if (Date.now() > until) throw new Error("The change of coordinator did not finish in time");
      continue;
    }
    await call("task.destroy", [task]).catch(() => {});
    if (status === "success") return;
    const info = Array.isArray(t.error_info) ? (t.error_info as unknown[]).map(String) : [status];
    throw new XapiTaskError(info[0] || status, info.slice(1));
  }
}

async function confirmCoordinator(poolId: string, to: CoordinatorCandidate) {
  const until = Date.now() + CONFIRM_MS;
  for (;;) {
    try {
      const s = await openPoolSession(poolId);
      try {
        const [p] = await poolCall<string[]>(s, "pool.get_all");
        if ((await poolCall<string>(s, "pool.get_master", p)) === to.ref) return;
      } finally {
        await closePoolSession(s);
      }
    } catch {
      // the pool is still settling
    }
    if (Date.now() > until) throw new Error(`The pool did not name ${to.name} as its coordinator in time`);
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
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

export function sessionCall(ctx: MaintenanceContext): XapiCall {
  return <T>(method: string, params: unknown[]) =>
    xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [ctx.sessionRef, ...params]);
}

const newJobId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Maintenance mode; for the coordinator, with a new one to take over when given (checked by checkCoordinatorChange). */
export async function startMaintenance(ctx: MaintenanceContext, hostRef: string, newCoordinator?: CoordinatorCandidate): Promise<MaintenanceJob> {
  const call = sessionCall(ctx);
  const hostName = await call<string>("host.get_name_label", [hostRef]);
  const job: MaintenanceJob = {
    id: newJobId(),
    kind: "maintenance",
    poolId: ctx.poolId,
    hostRef,
    hostName,
    state: "running",
    step: "Checking which VMs can be moved",
    progress: 0,
    startedAt: Date.now(),
    ...(newCoordinator ? { newCoordinator } : {}),
  };
  jobs.set(job.id, job);
  void run(job, ctx, call);
  return job;
}

/** Only a new coordinator, the VMs left where they are (checked by checkCoordinatorChange). */
export function startDesignate(ctx: MaintenanceContext, to: CoordinatorCandidate, from: CoordinatorCandidate): MaintenanceJob {
  const call = sessionCall(ctx);
  const job: MaintenanceJob = {
    id: newJobId(),
    kind: "designate",
    poolId: ctx.poolId,
    hostRef: to.ref,
    hostName: to.name,
    state: "running",
    step: `Nominating server ${to.name} as new coordinator`,
    progress: 0.1,
    startedAt: Date.now(),
    newCoordinator: to,
  };
  jobs.set(job.id, job);
  void (async () => {
    try {
      await designate(ctx.poolId, call, to);
      job.coordinatorChanged = true;
      finish(job, ctx, "done", `Nominated server ${to.name} as new coordinator (was ${from.name})`);
    } catch (err) {
      finish(job, ctx, "failed", `${to.name} did not become the pool coordinator: ${await explain(call, err)}`);
    }
  })();
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
    ...(job.kind === "designate"
      ? { category: "pool" as const, action: "pool_designate_coordinator", target: `host "${job.hostName}"` }
      : { category: "host" as const, action: "host_maintenance_enter_finished", target: `host "${job.hostName}"` }),
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
      // NoRecommendationError: an entry that is not a move is the reason why
      // not. XenCenter stops on any; XenMan stops on all but
      // HOST_NOT_ENOUGH_FREE_MEMORY, which xapi puts on each VM WLB left out
      // of its plan -- seen in the field for vGPU VMs that migrate live
      // without trouble. Those are moved one by one after WLB's moves.
      const wrong = vmRecs.find(([, v]) => {
        const code = str(v[0]).trim();
        return code.toLowerCase() !== "wlb" && code !== "HOST_NOT_ENOUGH_FREE_MEMORY";
      });
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

    // 4. EvacuateHostAction: the new coordinator, once the host is empty.
    const to = job.newCoordinator;
    if (to) {
      job.step = `Nominating server ${to.name} as new coordinator`;
      job.progress = Math.max(job.progress, 0.9);
      await designate(ctx.poolId, call, to);
      job.coordinatorChanged = true;
      how += `; ${to.name} is the new pool coordinator`;
    }
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
  // VMs WLB has no host for (HOST_NOT_ENOUGH_FREE_MEMORY), moved afterwards.
  const unplaced = Object.values(recs).filter((v) => str(v[0]).trim() === "HOST_NOT_ENOUGH_FREE_MEMORY").length;
  const total = moves.length + unplaced;
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
    job.progress = 0.2 + (0.8 * done) / Math.max(total, 1);
  }
  const byWlb = `${done} VM${done === 1 ? "" : "s"} migrated as WLB recommended`;
  const rest = await moveOneByOne(job, call, "WLB had no host for it", done, total);
  return rest ? `${byWlb}, ${rest} one by one (WLB had no host for ${rest === 1 ? "it" : "them"})` : byWlb;
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
  const done = await moveOneByOne(job, call, "XenServer found no plan for all VMs at once");
  return `${done} VM${done === 1 ? "" : "s"} migrated one by one (XenServer found no plan for all at once)`;
}

/**
 * The VMs still running on the host, as the update jobs' moveOneByOne: the
 * biggest first, live, to the host XenServer accepts the VM on with the most
 * memory free. Returns how many were moved.
 */
async function moveOneByOne(job: MaintenanceJob, call: XapiCall, reason: string, doneBefore = 0, totalBefore = 0): Promise<number> {
  const h = job.hostRef;
  const vms: { vm: string; name: string; mem: number }[] = [];
  for (const vm of await call<string[]>("host.get_resident_VMs", [h])) {
    const r = await call<Rec>("VM.get_record", [vm]).catch(() => null);
    if (!r || r.is_control_domain === true || str(r.power_state) !== "Running") continue;
    vms.push({ vm, name: str(r.name_label), mem: Number(r.memory_dynamic_max ?? r.memory_static_max ?? 0) });
  }
  vms.sort((a, b) => b.mem - a.mem);
  if (!vms.length) return 0;
  const total = Math.max(totalBefore, doneBefore + vms.length);
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
    job.step = `Migrating ${name} to ${target} (one by one: ${reason})`;
    await asyncCall(call, "VM.pool_migrate", [vm, best, { live: "true" }], MIGRATE_MS);
    done++;
    job.progress = 0.2 + (0.8 * (doneBefore + done)) / total;
  }
  return done;
}
