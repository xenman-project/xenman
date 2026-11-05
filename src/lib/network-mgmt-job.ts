// Changing a server's management interface, as a job of its own: it runs on
// in the server when the browser loses the connection -- which it may, the
// coordinator's address being what changes. The XAPI calls are XenCenter's
// (ChangeNetworkingAction, NetworkingActionHelpers): a new address alone is
// PIF.reconfigure_ip on the management PIF; a move brings the new PIF up,
// switches with host.management_reconfigure and then clears the old PIF's
// address. Afterwards XenMan waits until the server answers with the new
// settings, and says so if it does not.

import { audit } from "./audit";
import type { UserRole } from "./auth";
import { loadHostsFromDisk, saveHostsToDisk } from "./host-storage";
import { loginToHost, logout, xenApiCall } from "./xen-client";
import { XapiTaskError, type ManagementPlan } from "./xen-network-actions";

export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface MgmtStep {
  label: string;
  state: StepState;
  detail?: string;
}

export interface MgmtJob {
  id: string;
  poolId: string;
  hostName: string;
  state: "running" | "done" | "failed";
  steps: MgmtStep[];
  error?: string;
  notes: string[];
  startedAt: string;
  finishedAt?: string;
}

const g = globalThis as typeof globalThis & { _xenmanMgmtJobs?: Map<string, MgmtJob> };
const jobs = (g._xenmanMgmtJobs ??= new Map());

export function getMgmtJob(id: string): MgmtJob | undefined {
  return jobs.get(id);
}

/** One at a time per pool: a second change would start from what the first is changing. */
export function runningMgmtJob(poolId: string): MgmtJob | undefined {
  return [...jobs.values()].find((j) => j.poolId === poolId && j.state === "running");
}

// How long a server may take to answer again (env for the tests).
const WAIT_MS = Number(process.env.XENMAN_MGMT_WAIT_MS || 300_000);
const POLL_MS = Number(process.env.XENMAN_MGMT_POLL_MS || 1_000);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** The connection the job works on: the request's session, or one of its own after the coordinator moved. */
interface Conn {
  address: string;
  session: string;
  own: boolean;
}

export interface MgmtContext {
  poolId: string;
  address: string;
  port: number;
  useSsl: boolean;
  sessionRef: string;
  actor: string;
  role: UserRole | "-";
  ip: string;
}

function xapiText(err: unknown): string {
  if (err instanceof XapiTaskError) return `${err.message}${err.data.length ? ` (${err.data.join(", ")})` : ""}`;
  const e = err as { message?: string; data?: unknown[] };
  const data = Array.isArray(e?.data) && e.data.length ? ` (${e.data.map(String).join(", ")})` : "";
  return `${e?.message ?? String(err)}${data}`;
}

export function startManagementChange(ctx: MgmtContext, plan: ManagementPlan): MgmtJob {
  const labels = plan.move
    ? [
        `Configure ${plan.newNic} (${plan.newNetwork}) on ${plan.hostName}`,
        `Move the management interface of ${plan.hostName} to ${plan.newNic}`,
        `Wait for ${plan.hostName} to answer`,
        `Remove the address from ${plan.oldNic}`,
      ]
    : [`Configure the management interface of ${plan.hostName}`, `Wait for ${plan.hostName} to answer`];
  if (plan.coordinator && plan.newIp !== plan.oldIp) labels.push("Update the pool's address in XenMan");
  const job: MgmtJob = {
    id: `mgmt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    poolId: ctx.poolId,
    hostName: plan.hostName,
    state: "running",
    steps: labels.map((label) => ({ label, state: "pending" })),
    notes: [],
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  void run(job, ctx, plan);
  return job;
}

async function run(job: MgmtJob, ctx: MgmtContext, plan: ManagementPlan) {
  const conn: Conn = { address: ctx.address, session: ctx.sessionRef, own: false };
  const call = <T,>(method: string, params: unknown[]) => xenApiCall<T>(conn.address, ctx.port, ctx.useSsl, method, [conn.session, ...params]);
  let i = 0;
  const step = async (fn: () => Promise<string | void>) => {
    const s = job.steps[i++];
    s.state = "running";
    try {
      const detail = await fn();
      s.state = "done";
      if (detail) s.detail = detail;
    } catch (err) {
      s.state = "failed";
      s.detail = xapiText(err);
      throw err;
    }
  };

  // After the coordinator's address changed, XenMan logs in where it is now.
  const configured = () => loadHostsFromDisk().find((h) => h.id === ctx.poolId);
  const reconnect = async (): Promise<boolean> => {
    const h = configured();
    if (!h) return false;
    const candidates = [...new Set([plan.newIp, h.address, h.backupAddress].filter((a): a is string => Boolean(a && a.trim())).map((a) => a.trim()))];
    for (const address of candidates) {
      if (address === conn.address) continue;
      try {
        const session = await Promise.race([
          loginToHost(address, ctx.port, ctx.useSsl, h.username, h.password),
          sleep(10_000).then(() => Promise.reject(new Error("no answer"))),
        ]);
        if (conn.own) await logout(conn.address, ctx.port, ctx.useSsl, conn.session).catch(() => {});
        Object.assign(conn, { address, session, own: true });
        return true;
      } catch {
        // the next address
      }
    }
    return false;
  };

  // An Async. call followed to its end. While the coordinator moves, polling
  // fails for a while: then XenMan looks for it under its new address.
  const follow = async (method: string, params: unknown[]): Promise<string> => {
    const task = await call<string>(`Async.${method}`, params);
    const until = Date.now() + WAIT_MS;
    let failingSince = 0;
    for (;;) {
      await sleep(POLL_MS);
      let t: Record<string, unknown>;
      try {
        t = await call<Record<string, unknown>>("task.get_record", [task]);
        failingSince = 0;
      } catch (err) {
        failingSince ||= Date.now();
        if (plan.coordinator && Date.now() - failingSince > 3 * POLL_MS && (await reconnect())) continue;
        if (Date.now() > until) throw err;
        continue;
      }
      const status = String(t.status ?? "");
      if (status === "pending") {
        if (Date.now() > until) throw new Error(`${method} did not finish in time`);
        continue;
      }
      await call("task.destroy", [task]).catch(() => {});
      if (status === "success") return String(t.result ?? "");
      const info = Array.isArray(t.error_info) ? (t.error_info as unknown[]).map(String) : [status];
      throw new XapiTaskError(info[0] || status, info.slice(1));
    }
  };

  // NetworkingActionHelpers.Depurpose / ReconfigureManagement_: management_purpose off, where there is one.
  const depurpose = async (pif: string) => {
    const oc = await call<Record<string, string>>("PIF.get_other_config", [pif]);
    if (!oc.management_purpose) return;
    const rest = { ...oc };
    delete rest.management_purpose;
    await call("PIF.set_other_config", [pif, rest]);
  };

  // The server answers again with the new settings: live, the management interface where it should be.
  const answers = async (): Promise<string> => {
    const until = Date.now() + WAIT_MS;
    let last = "no answer";
    for (;;) {
      try {
        const pif = await call<Record<string, unknown>>("PIF.get_record", [plan.newPif]);
        const metrics = await call<string>("host.get_metrics", [plan.hostRef]);
        const live = await call<boolean>("host_metrics.get_live", [metrics]);
        const ipOk = plan.newIp === null || String(pif.IP ?? "") === plan.newIp;
        if (pif.management === true && ipOk && live) return plan.newIp ? `answers at ${plan.newIp}` : `answers, address from DHCP: ${String(pif.IP ?? "")}`;
        last = !live ? "not live" : pif.management !== true ? "management interface not yet moved" : `address still ${String(pif.IP ?? "")}`;
      } catch (err) {
        last = xapiText(err);
        if (plan.coordinator) await reconnect();
      }
      if (Date.now() > until) {
        throw new Error(`${plan.hostName} does not answer with its new settings (${last}). Check its management interface on the host's console (xsconsole).`);
      }
      await sleep(POLL_MS);
    }
  };

  try {
    const fields = [plan.ip, plan.netmask, plan.gateway, plan.dns];
    if (plan.move) {
      // BringUp: the new PIF gets its address (a primary one is not plugged separately).
      await step(async () => {
        await follow("PIF.reconfigure_ip", [plan.newPif, plan.mode, ...fields]);
      });
      // ReconfigureManagement: purpose off the old and the new PIF, then the switch.
      await step(async () => {
        if (plan.oldPurpose) await depurpose(plan.oldPif);
        if (plan.newPurpose) await depurpose(plan.newPif);
        await follow("host.management_reconfigure", [plan.newPif]);
      });
      await step(answers);
      // ClearIP: the old PIF's address taken away.
      await step(async () => {
        await follow("PIF.reconfigure_ip", [plan.oldPif, "None", "", "", "", ""]);
      });
    } else {
      await step(async () => {
        await follow("PIF.reconfigure_ip", [plan.oldPif, plan.mode, ...fields]);
      });
      await step(answers);
    }
    if (plan.coordinator && plan.newIp !== plan.oldIp) {
      await step(async () => {
        const hosts = loadHostsFromDisk();
        const h = hosts.find((x) => x.id === ctx.poolId);
        if (!h) return "the pool is no longer configured";
        if (h.address === plan.oldIp && plan.newIp) {
          h.address = plan.newIp;
          saveHostsToDisk(hosts);
          return `${plan.oldIp} → ${plan.newIp}`;
        }
        job.notes.push(`XenMan reaches the pool at ${h.address}. If that name pointed to ${plan.oldIp}, point it to ${plan.newIp}.`);
        return `kept ${h.address}`;
      });
    }
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = xapiText(err);
    for (const s of job.steps) if (s.state === "pending") s.state = "skipped";
  } finally {
    job.finishedAt = new Date().toISOString();
    if (conn.own) await logout(conn.address, ctx.port, ctx.useSsl, conn.session).catch(() => {});
    audit({
      actor: ctx.actor,
      role: ctx.role,
      ip: ctx.ip,
      category: "network",
      action: "network_management_finished",
      target: `host "${plan.hostName}"`,
      outcome: job.state === "done" ? "success" : "failure",
      detail: [
        plan.move ? `to ${plan.newNic} (${plan.newNetwork})` : "same interface",
        plan.mode === "Static" ? `${plan.ip}/${plan.netmask}${plan.gateway ? ` gw ${plan.gateway}` : ""}` : "DHCP",
        job.error,
      ]
        .filter(Boolean)
        .join(", "),
    });
  }
}
