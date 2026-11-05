// Changing a server's control domain memory, as XenCenter's Control Domain
// Memory Settings do (ControlDomainMemoryDialog: ChangeControlDomainMemoryAction,
// then RebootHostAction): VM.set_memory on the control domain, then the server
// restarts to take it. Only in maintenance mode, as XenCenter allows it. A job,
// as the restart outlasts the request -- and for the coordinator, the connection.

import { audit } from "./audit";
import type { UserRole } from "./auth";
import { xenApiCall } from "./xen-client";
import { asyncCall, XapiTaskError, type XapiCall } from "./xen-network-actions";
import { memorySize } from "./xen-memory";

export interface Dom0MemoryJob {
  id: string;
  poolId: string;
  hostRef: string;
  hostName: string;
  state: "running" | "done" | "failed";
  step: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Dom0MemoryContext {
  poolId: string;
  address: string;
  port: number;
  useSsl: boolean;
  sessionRef: string;
  actor: string;
  role: UserRole | "-";
  ip: string;
}

const g = globalThis as typeof globalThis & { _xenmanDom0Jobs?: Map<string, Dom0MemoryJob> };
const jobs = (g._xenmanDom0Jobs ??= new Map<string, Dom0MemoryJob>());

export function getDom0MemoryJob(id: string): Dom0MemoryJob | undefined {
  return jobs.get(id);
}

export function runningDom0Job(poolId: string, hostRef: string): Dom0MemoryJob | undefined {
  return [...jobs.values()].find((j) => j.poolId === poolId && j.hostRef === hostRef && j.state === "running");
}

const TASK_MS = Number(process.env.XENMAN_DOM0_TASK_MS || 600_000);

function xapiText(err: unknown): string {
  if (err instanceof XapiTaskError) return `${err.message}${err.data.length ? ` (${err.data.join(", ")})` : ""}`;
  const e = err as { message?: string; data?: unknown[] };
  const data = Array.isArray(e?.data) && e.data.length ? ` (${e.data.map(String).join(", ")})` : "";
  return `${e?.message ?? String(err)}${data}`;
}

export function startDom0MemoryChange(
  ctx: Dom0MemoryContext,
  target: { hostRef: string; hostName: string; dom0Ref: string; staticMin: number; coordinator: boolean },
  memory: number,
): Dom0MemoryJob {
  const job: Dom0MemoryJob = {
    id: crypto.randomUUID(),
    poolId: ctx.poolId,
    hostRef: target.hostRef,
    hostName: target.hostName,
    state: "running",
    step: `Changing control domain memory settings on '${target.hostName}'`,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  void run(ctx, job, target, memory);
  return job;
}

async function run(
  ctx: Dom0MemoryContext,
  job: Dom0MemoryJob,
  target: { hostRef: string; hostName: string; dom0Ref: string; staticMin: number; coordinator: boolean },
  memory: number,
) {
  const call: XapiCall = <T>(method: string, params: unknown[]) =>
    xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [ctx.sessionRef, ...params]);
  try {
    // ChangeControlDomainMemoryAction.
    try {
      await call("VM.set_memory", [target.dom0Ref, String(memory)]);
    } catch (err) {
      const code = (err as { message?: string })?.message;
      if (code === "MEMORY_CONSTRAINT_VIOLATION" && memory < target.staticMin) {
        throw new Error(
          `The memory specified (${memorySize(memory, true)}) was too low. It has to be at least the value of the static minimum (${memorySize(target.staticMin, true)})`,
        );
      }
      throw err;
    }
    // RebootHostAction: the server restarts. The coordinator takes XenMan's
    // connection with it -- its task cannot be followed to the end then.
    job.step = `Rebooting ${target.hostName}`;
    try {
      await asyncCall(call, "host.reboot", [target.hostRef], TASK_MS);
    } catch (err) {
      if (!target.coordinator || err instanceof XapiTaskError) throw err;
    }
    job.step = `${target.hostName} is restarting with ${memorySize(memory, true)} for its control domain.`;
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = xapiText(err);
  }
  job.finishedAt = new Date().toISOString();
  audit({
    actor: ctx.actor,
    role: ctx.role,
    ip: ctx.ip,
    category: "host",
    action: "host_control_domain_memory_finished",
    target: `host "${target.hostName}"`,
    outcome: job.state === "done" ? "success" : "failure",
    detail: [`memory=${memory}`, job.error].filter(Boolean).join(", "),
  });
}
