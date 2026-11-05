// Changing VMs' memory settings, as XenCenter's "Edit..." on the Memory tab
// does (ChangeMemorySettingsAction, one per VM, all at once): a new static
// maximum needs the VM halted, so a VM that is not is shut down (cleanly if it
// may be, else hard), the settings are set together (VM.set_memory_limits, or
// VM.set_memory_dynamic_range when only the range changes), and the VM is
// started again where it lived -- even when setting failed. A job of its own,
// as shutting down and starting VMs outlasts a request.

import { audit } from "./audit";
import type { UserRole } from "./auth";
import { xenApiCall } from "./xen-client";
import { asyncCall, XapiTaskError, type XapiCall } from "./xen-network-actions";
import { vmHome } from "./xen-memory";

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

export type VmMemoryStepState = "pending" | "running" | "done" | "failed";

export interface VmMemoryJobVm {
  ref: string;
  name: string;
  state: VmMemoryStepState;
  /** What it is doing now, or did last. */
  step: string;
  error?: string;
}

export interface VmMemoryJob {
  id: string;
  poolId: string;
  state: "running" | "done" | "failed";
  vms: VmMemoryJobVm[];
  startedAt: string;
  finishedAt?: string;
}

export interface VmMemoryValues {
  dynamicMin: number;
  dynamicMax: number;
  staticMax: number;
}

export interface VmMemoryContext {
  poolId: string;
  address: string;
  port: number;
  useSsl: boolean;
  sessionRef: string;
  actor: string;
  role: UserRole | "-";
  ip: string;
}

const g = globalThis as typeof globalThis & { _xenmanVmMemoryJobs?: Map<string, VmMemoryJob> };
const jobs = (g._xenmanVmMemoryJobs ??= new Map<string, VmMemoryJob>());

export function getVmMemoryJob(id: string): VmMemoryJob | undefined {
  return jobs.get(id);
}

/** A VM another running job is changing. */
export function busyVm(poolId: string, refs: string[]): string | undefined {
  for (const j of jobs.values()) {
    if (j.poolId !== poolId || j.state !== "running") continue;
    const hit = j.vms.find((v) => v.state !== "done" && v.state !== "failed" && refs.includes(v.ref));
    if (hit) return hit.name;
  }
  return undefined;
}

// How long a VM may take to shut down and start (env for the tests).
const TASK_MS = Number(process.env.XENMAN_VM_MEMORY_TASK_MS || 600_000);
const POLL_MS = Number(process.env.XENMAN_VM_MEMORY_POLL_MS || 1_000);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v) || 0;

/** What ChangeMemorySettingsAction decides for one VM. */
export function needsReboot(vm: Rec, values: VmMemoryValues): boolean {
  const staticChanged = num(vm.memory_static_max) !== values.staticMax; // static_min is kept as it is
  const power = str(vm.power_state);
  return staticChanged ? power !== "Halted" : power !== "Halted" && power !== "Running";
}

/** The order XAPI insists on, for each VM with its own static minimum. */
export function valuesProblem(vm: Rec, values: VmMemoryValues): string | null {
  const { dynamicMin, dynamicMax, staticMax } = values;
  if (![dynamicMin, dynamicMax, staticMax].every((n) => Number.isSafeInteger(n) && n > 0)) return "The memory amounts are not valid";
  if (!(num(vm.memory_static_min) <= dynamicMin && dynamicMin <= dynamicMax && dynamicMax <= staticMax)) {
    return `For ${str(vm.name_label)} the memory must keep static minimum ≤ minimum ≤ maximum ≤ static maximum`;
  }
  return null;
}

function xapiText(err: unknown): string {
  if (err instanceof XapiTaskError) return `${err.message}${err.data.length ? ` (${err.data.join(", ")})` : ""}`;
  const e = err as { message?: string; data?: unknown[] };
  const data = Array.isArray(e?.data) && e.data.length ? ` (${e.data.map(String).join(", ")})` : "";
  return `${e?.message ?? String(err)}${data}`;
}

export function startVmMemoryChange(ctx: VmMemoryContext, vms: { ref: string; record: Rec }[], values: VmMemoryValues): VmMemoryJob {
  const job: VmMemoryJob = {
    id: crypto.randomUUID(),
    poolId: ctx.poolId,
    state: "running",
    vms: vms.map((v) => ({ ref: v.ref, name: str(v.record.name_label), state: "pending", step: "Waiting" })),
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  void run(ctx, job, vms, values);
  return job;
}

async function run(ctx: VmMemoryContext, job: VmMemoryJob, vms: { ref: string; record: Rec }[], values: VmMemoryValues) {
  const call: XapiCall = <T>(method: string, params: unknown[]) =>
    xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [ctx.sessionRef, ...params]);

  // VM.Home, taken before anything changes (ChangeMemorySettingsAction keeps it from its start).
  let homeRecords: Parameters<typeof vmHome>[0] | null = null;
  const homeOf = async (vm: Rec): Promise<string | null> => {
    if (vm.power_state === "Running") return str(vm.resident_on) || null;
    if (!homeRecords) {
      const all = (cls: string) => call<Recs>(`${cls}.get_all_records`, []).catch(() => ({}) as Recs);
      const [hosts, hostMetrics, vbds, vdis, srs, pbds] = await Promise.all([
        all("host"), all("host_metrics"), all("VBD"), all("VDI"), all("SR"), all("PBD"),
      ]);
      homeRecords = { hosts, hostMetrics, vbds, vdis, srs, pbds };
    }
    return vmHome(homeRecords, vm);
  };

  await Promise.all(
    vms.map(async ({ ref }, i) => {
      const entry = job.vms[i];
      entry.state = "running";
      try {
        const vm = await call<Rec>("VM.get_record", [ref]);
        const reboot = needsReboot(vm, values);
        const staticChanged = num(vm.memory_static_max) !== values.staticMax;
        const home = reboot ? await homeOf(vm) : null;
        if (reboot) {
          const ops = Array.isArray(vm.allowed_operations) ? vm.allowed_operations.map(String) : [];
          const clean = ops.includes("clean_shutdown");
          entry.step = clean ? "Shutting down" : "Forcing shutdown";
          try {
            await asyncCall(call, clean ? "VM.clean_shutdown" : "VM.hard_shutdown", [ref], TASK_MS);
          } catch (err) {
            // Fine if it is off already, or another shutdown is under way.
            const now = await call<Rec>("VM.get_record", [ref]).catch(() => ({}) as Rec);
            const current = now.current_operations && typeof now.current_operations === "object" ? Object.values(now.current_operations as Rec).map(String) : [];
            const shuttingDown = current.some((op) => op === "clean_shutdown" || op === "hard_shutdown" || op === "shutdown");
            if (now.power_state !== "Halted" && !shuttingDown) throw err;
          }
          entry.step = "Waiting until it is halted";
          const until = Date.now() + TASK_MS;
          while ((await call<string>("VM.get_power_state", [ref])) !== "Halted") {
            if (Date.now() > until) throw new Error("The VM did not shut down in time");
            await sleep(POLL_MS);
          }
        }
        entry.step = "Changing memory settings";
        try {
          if (staticChanged) {
            await call("VM.set_memory_limits", [
              ref, String(num(vm.memory_static_min)), String(values.staticMax), String(values.dynamicMin), String(values.dynamicMax),
            ]);
          } else {
            await call("VM.set_memory_dynamic_range", [ref, String(values.dynamicMin), String(values.dynamicMax)]);
          }
        } finally {
          // Booted again even when setting failed, as XenCenter does.
          if (reboot) {
            entry.step = "Starting";
            if (home) await asyncCall(call, "VM.start_on", [ref, home, false, false], TASK_MS);
            else await asyncCall(call, "VM.start", [ref, false, false], TASK_MS);
          }
        }
        entry.state = "done";
        entry.step = `Changed memory settings for ${entry.name}`;
      } catch (err) {
        entry.state = "failed";
        entry.error = xapiText(err);
      }
    }),
  );

  job.state = job.vms.every((v) => v.state === "done") ? "done" : "failed";
  job.finishedAt = new Date().toISOString();
  const failed = job.vms.filter((v) => v.state === "failed");
  audit({
    actor: ctx.actor,
    role: ctx.role,
    ip: ctx.ip,
    category: "vm",
    action: "vm_memory_change_finished",
    target: job.vms.length === 1 ? `VM "${job.vms[0].name}"` : `${job.vms.length} VMs`,
    outcome: job.state === "done" ? "success" : "failure",
    detail: [
      `min=${values.dynamicMin}`,
      `max=${values.dynamicMax}`,
      `static max=${values.staticMax}`,
      ...failed.slice(0, 10).map((v) => `${v.name}: ${v.error}`),
    ].join(", "),
  });
}
