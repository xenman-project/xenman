// Adding a server to a pool and removing one from it, as XenCenter does, each
// as a job of its own: joining restarts the new server's toolstack, ejecting
// resets the server and reboots it.
//
// Adding (AddHostToPoolAction): pool.join on the new server's session with the
// coordinator's address and the pool's credentials; then, once the server is a
// member, PoolAction.ClearNonSharedSrs -- a pool whose default SR is not shared
// gets none -- and XenMan learns the pool's certificates again, so it trusts
// the new member straight away.
//
// Removing (RemoveHostFromPoolCommand, EjectHostFromPoolAction): pool.eject;
// then, as XenCenter does, the server is kept as a connection of its own with
// the pool's credentials, and connected once it answers again (WaitForReboot:
// 30 s, then every 15 s, for up to 5 minutes).

import net from "net";
import { audit } from "./audit";
import type { UserRole } from "./auth";
import { loadHostsFromDisk, saveHostsToDisk } from "./host-storage";
import { pemFingerprint, trustCertificate } from "./host-trust";
import { learnPool } from "./host-trust-learn";
import { withPinned, withPool } from "./xen-tls";
import { loginToHost, xenApiCall } from "./xen-client";
import { asyncCall, XapiTaskError, type XapiCall } from "./xen-network-actions";
import { canJoinPool, type JoinVerdict } from "./pool-join-rules";

export type MemberStepState = "pending" | "running" | "done" | "failed";

export interface PoolMemberJob {
  id: string;
  poolId: string;
  kind: "add" | "remove";
  hostName: string;
  state: "running" | "done" | "failed";
  steps: { label: string; state: MemberStepState; detail?: string }[];
  error?: string;
  /** Removing: the connection kept for the server. */
  newHostId?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface MemberContext {
  poolId: string;
  poolName: string;
  /** The pool's own session, address and credentials (hosts.json). */
  address: string;
  port: number;
  useSsl: boolean;
  sessionRef: string;
  actor: string;
  role: UserRole | "-";
  ip: string;
}

const g = globalThis as typeof globalThis & { _xenmanMemberJobs?: Map<string, PoolMemberJob> };
const jobs = (g._xenmanMemberJobs ??= new Map<string, PoolMemberJob>());

export function getMemberJob(id: string): PoolMemberJob | undefined {
  return jobs.get(id);
}

export function runningMemberJob(poolId: string): PoolMemberJob | undefined {
  return [...jobs.values()].find((j) => j.poolId === poolId && j.state === "running");
}

// Waits (env for the tests).
const JOIN_WAIT_MS = Number(process.env.XENMAN_JOIN_WAIT_MS || 600_000);
const POLL_MS = Number(process.env.XENMAN_MEMBER_POLL_MS || 3_000);
const REBOOT_FIRST_MS = Number(process.env.XENMAN_EJECT_FIRST_WAIT_MS ?? 30_000);
const REBOOT_EVERY_MS = Number(process.env.XENMAN_EJECT_POLL_MS ?? 15_000);
const REBOOT_TRIES = Number(process.env.XENMAN_EJECT_TRIES ?? 27);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const str = (v: unknown) => (typeof v === "string" ? v : "");

function xapiText(err: unknown): string {
  if (err instanceof XapiTaskError) return `${err.message}${err.data.length ? ` (${err.data.join(", ")})` : ""}`;
  const e = err as { message?: string; data?: unknown[] };
  const data = Array.isArray(e?.data) && e.data.length ? ` (${e.data.map(String).join(", ")})` : "";
  return `${e?.message ?? String(err)}${data}`;
}

function newJob(ctx: MemberContext, kind: PoolMemberJob["kind"], hostName: string, labels: string[]): PoolMemberJob {
  const job: PoolMemberJob = {
    id: crypto.randomUUID(),
    poolId: ctx.poolId,
    kind,
    hostName,
    state: "running",
    steps: labels.map((label) => ({ label, state: "pending" })),
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  return job;
}

async function step<T>(job: PoolMemberJob, i: number, fn: () => Promise<T>): Promise<T> {
  job.steps[i].state = "running";
  try {
    const r = await fn();
    job.steps[i].state = "done";
    return r;
  } catch (err) {
    job.steps[i].state = "failed";
    job.steps[i].detail = xapiText(err);
    throw err;
  }
}

function poolCall(ctx: MemberContext): XapiCall {
  return <T>(method: string, params: unknown[]) =>
    withPool(ctx.poolId, () => xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [ctx.sessionRef, ...params]));
}

// ── Adding ──────────────────────────────────────────────────────────────────

export interface Joiner {
  address: string;
  port: number;
  useSsl: boolean;
  /** The certificate the admin confirmed (https). */
  fingerprint: string | null;
  username: string;
  password: string;
  name: string;
  uuid: string;
}

export function startAddServer(ctx: MemberContext, joiner: Joiner, coordinatorAddress: string, poolCredentials: { username: string; password: string }): PoolMemberJob {
  const job = newJob(ctx, "add", joiner.name, [
    `Adding server '${joiner.name}' to pool '${ctx.poolName}'`,
    `Waiting for ${joiner.name} to join`,
    "Clearing the pool's local default storage",
    "Learning the pool's certificates",
  ]);
  void runAdd(ctx, job, joiner, coordinatorAddress, poolCredentials);
  return job;
}

/** Calls on the new server: pinned to the certificate the admin confirmed. */
export function joinerCall(joiner: Pick<Joiner, "address" | "port" | "useSsl" | "fingerprint">, session: string): XapiCall {
  return <T>(method: string, params: unknown[]) => {
    const call = () => xenApiCall<T>(joiner.address, joiner.port, joiner.useSsl, method, [session, ...params]);
    return joiner.useSsl && joiner.fingerprint ? withPinned([joiner.fingerprint], call) : call();
  };
}

export function joinerLogin(joiner: Pick<Joiner, "address" | "port" | "useSsl" | "fingerprint" | "username" | "password">): Promise<string> {
  const login = () => loginToHost(joiner.address, joiner.port, joiner.useSsl, joiner.username, joiner.password);
  return joiner.useSsl && joiner.fingerprint ? withPinned([joiner.fingerprint], login) : login();
}

async function runAdd(
  ctx: MemberContext,
  job: PoolMemberJob,
  joiner: Joiner,
  coordinatorAddress: string,
  creds: { username: string; password: string },
) {
  const pool = poolCall(ctx);
  try {
    // AddHostToPoolAction: Pool.async_join with the coordinator's address and the pool's credentials.
    await step(job, 0, async () => {
      const session = await joinerLogin(joiner);
      const call = joinerCall(joiner, session);
      try {
        await asyncCall(call, "pool.join", [coordinatorAddress, creds.username, creds.password], JOIN_WAIT_MS);
      } catch (err) {
        // A refusal is the end; losing the server while its toolstack restarts as a member is not.
        if (err instanceof XapiTaskError) throw err;
        const code = (err as { code?: string })?.code ?? (err as { message?: string })?.message;
        if (code && /^[A-Z_]+$/.test(code) && code !== "SESSION_INVALID" && code !== "HOST_IS_SLAVE") throw err;
      }
    });
    // Until the pool lists it, live.
    await step(job, 1, async () => {
      const until = Date.now() + JOIN_WAIT_MS;
      for (;;) {
        const hosts = await pool<Record<string, Record<string, unknown>>>("host.get_all_records", []).catch(() => ({}) as Record<string, Record<string, unknown>>);
        const found = Object.entries(hosts).find(([, h]) => str(h.uuid) === joiner.uuid);
        if (found) {
          const live = await pool<boolean>("host_metrics.get_live", [str(found[1].metrics)]).catch(() => false);
          if (live === true) return;
        }
        if (Date.now() > until) throw new Error(`${joiner.name} did not show up in the pool`);
        await sleep(POLL_MS);
      }
    });
    // PoolAction.ClearNonSharedSrs.
    await step(job, 2, async () => {
      const pools = await pool<Record<string, Record<string, unknown>>>("pool.get_all_records", []);
      const [poolRef, rec] = Object.entries(pools)[0] ?? [];
      const def = str(rec?.default_SR);
      if (!poolRef || !def || def === "OpaqueRef:NULL") {
        job.steps[2].detail = "No default storage set";
        return;
      }
      const shared = await pool<boolean>("SR.get_shared", [def]).catch(() => true);
      if (shared) {
        job.steps[2].detail = "The default storage is shared: kept";
        return;
      }
      await pool("pool.set_default_SR", [poolRef, "OpaqueRef:NULL"]);
      await pool("pool.set_crash_dump_SR", [poolRef, "OpaqueRef:NULL"]);
      await pool("pool.set_suspend_image_SR", [poolRef, "OpaqueRef:NULL"]);
      job.steps[2].detail = "The default storage was local: cleared, as XenCenter does";
    });
    // XenMan: trust the new member's certificate now, not at the next connect.
    await step(job, 3, () => withPool(ctx.poolId, () => learnPool(ctx.poolId, ctx.address, ctx.port, ctx.useSsl, ctx.sessionRef, true)));
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = xapiText(err);
  }
  finish(ctx, job, "pool_add_server_finished", `server "${joiner.name}" (${joiner.address})`);
}

export interface JoinCheck {
  verdict: JoinVerdict;
  joiner: Joiner;
  /** Coordinator.address, else the address XenMan reaches the pool at (AddHostToPoolAction). */
  coordinatorAddress: string;
}

/**
 * Logs in to the new server (with the certificate the admin confirmed), reads
 * it and the pool, and applies PoolJoinRules. A server that is a pool member
 * says so at the login (HOST_IS_SLAVE).
 */
export async function checkJoin(
  ctx: MemberContext,
  input: { address: string; port: number; useSsl: boolean; fingerprint: string | null; username: string; password: string },
): Promise<JoinCheck> {
  const pool = poolCall(ctx);
  const allOf = (call: XapiCall, cls: string) => call<Record<string, Record<string, unknown>>>(`${cls}.get_all_records`, []);
  const optional = (call: XapiCall, cls: string) => allOf(call, cls).catch(() => ({}) as Record<string, Record<string, unknown>>);
  const blank: Joiner = { ...input, name: input.address, uuid: "" };

  let session: string;
  try {
    session = await joinerLogin(input);
  } catch (err) {
    const e = err as { code?: string; message?: string; data?: unknown[] };
    if (e?.code === "HOST_IS_SLAVE" || e?.message === "HOST_IS_SLAVE") {
      const coordinator = Array.isArray(e.data) ? String(e.data[0] ?? "") : "";
      return {
        verdict: {
          name: input.address,
          uuid: "",
          cpuQuestion: null,
          reason: `Cannot add server ${input.address} to pool ${ctx.poolName}: server is already in pool ${coordinator || "another pool"}.`,
        },
        joiner: blank,
        coordinatorAddress: ctx.address,
      };
    }
    throw err;
  }
  const call = joinerCall(input, session);
  try {
    const [jPools, jHosts, jSrs, jVms, jPifs, jClusters, jUpdates] = await Promise.all([
      allOf(call, "pool"),
      allOf(call, "host"),
      allOf(call, "SR"),
      allOf(call, "VM"),
      allOf(call, "PIF"),
      optional(call, "Cluster"),
      optional(call, "pool_update"),
    ]);
    const [tPools, tHosts, tClusterHosts, tPifs, tBonds, tVlans, tUpdates] = await Promise.all([
      allOf(pool, "pool"),
      allOf(pool, "host"),
      optional(pool, "Cluster_host"),
      allOf(pool, "PIF"),
      optional(pool, "Bond"),
      optional(pool, "VLAN"),
      optional(pool, "pool_update"),
    ]);
    const verdict = canJoinPool(
      { pools: jPools, hosts: jHosts, srs: jSrs, vms: jVms, pifs: jPifs, clusters: jClusters, updates: jUpdates },
      { pools: tPools, hosts: tHosts, clusterHosts: tClusterHosts, pifs: tPifs, bonds: tBonds, vlans: tVlans, updates: tUpdates },
      ctx.poolName,
    );
    const master = str(Object.values(tPools)[0]?.master);
    return {
      verdict,
      joiner: { ...input, name: verdict.name || input.address, uuid: verdict.uuid },
      coordinatorAddress: str(tHosts[master]?.address) || ctx.address,
    };
  } finally {
    await call("session.logout", []).catch(() => {});
  }
}

// ── Removing ────────────────────────────────────────────────────────────────

export interface Ejectee {
  hostRef: string;
  name: string;
  address: string;
}

export function startRemoveServer(ctx: MemberContext, host: Ejectee): PoolMemberJob {
  const job = newJob(ctx, "remove", host.name, [
    `Removing server '${host.name}' from pool '${ctx.poolName}'`,
    `Keeping ${host.name} as a server of its own`,
    `Waiting for ${host.name} to restart`,
  ]);
  void runRemove(ctx, job, host);
  return job;
}

function reachable(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: address, port, timeout: 5000 });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

async function runRemove(ctx: MemberContext, job: PoolMemberJob, host: Ejectee) {
  const pool = poolCall(ctx);
  try {
    // Its certificate, while it is still a member -- the new connection starts with it.
    const pem = await pool<string>("host.get_server_certificate", [host.hostRef]).catch(() => "");
    const fp = pem ? pemFingerprint(pem) : null;
    // EjectHostFromPoolAction.
    await step(job, 0, () => pool("pool.eject", [host.hostRef]));
    // RemoveHostFromPoolCommand: a connection of its own, with the pool's credentials.
    await step(job, 1, async () => {
      const hosts = loadHostsFromDisk();
      const poolEntry = hosts.find((h) => h.id === ctx.poolId);
      if (!poolEntry) throw new Error("The pool's connection is gone");
      const id = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      hosts.push({
        id,
        name: host.name,
        address: host.address,
        port: poolEntry.port,
        useSsl: poolEntry.useSsl,
        username: poolEntry.username,
        password: poolEntry.password,
        autoConnect: poolEntry.autoConnect,
      });
      saveHostsToDisk(hosts);
      if (fp && poolEntry.useSsl) trustCertificate(id, { fingerprint: fp.fingerprint, address: host.address, notAfter: fp.notAfter });
      job.newHostId = id;
    });
    // WaitForReboot.
    await step(job, 2, async () => {
      const port = loadHostsFromDisk().find((h) => h.id === job.newHostId)?.port ?? ctx.port;
      await sleep(REBOOT_FIRST_MS);
      for (let i = 0; i <= REBOOT_TRIES; i++) {
        if (await reachable(host.address, port)) return;
        if (i < REBOOT_TRIES) await sleep(REBOOT_EVERY_MS);
      }
      throw new Error(`Unable to reconnect to ${host.address}. Server is unavailable.`);
    });
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = xapiText(err);
  }
  finish(ctx, job, "pool_remove_server_finished", `host "${host.name}"`);
}

function finish(ctx: MemberContext, job: PoolMemberJob, action: string, target: string) {
  job.finishedAt = new Date().toISOString();
  audit({
    actor: ctx.actor,
    role: ctx.role,
    ip: ctx.ip,
    category: "pool",
    action,
    target,
    outcome: job.state === "done" ? "success" : "failure",
    detail: [`pool "${ctx.poolName}"`, job.error].filter(Boolean).join(", "),
  });
}
