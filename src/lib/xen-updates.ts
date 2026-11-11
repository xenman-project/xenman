// XenServer 8 updates of a pool: what is available, for which host, and what
// installing it entails. XenServer gets its updates from the update channel
// the pool is configured with (in XenCenter: Configure Updates); XenMan asks
// the pool coordinator, as XenCenter does:
//
//   Async.pool.sync_updates     fetch the channel's current metadata
//   GET /updates?session_id=    what each host lacks, as JSON
//   host.apply_updates          (stage 2) install it on one host
//
// Sessions here are XenMan's own, opened with the stored credentials of the
// configured pool -- not the browser's -- so a sync keeps running when the page
// is closed.

import { loadHostsFromDisk } from "./host-storage";
import { loginToHost, logout, xenApiCall, XenApiError } from "./xen-client";
import { xenFetch, withPool } from "./xen-tls";
import { CertMismatchError } from "./host-trust";
import { learnPool } from "./host-trust-learn";
import { describeRef } from "./ref-names";
import { reachable } from "./nat";

export interface PoolSession {
  hostId: string;
  address: string;
  port: number;
  useSsl: boolean;
  session: string;
}

/** Logs in to the pool as `connect` does: primary, backup, then the coordinator a member names. */
export function openPoolSession(hostId: string): Promise<PoolSession> {
  return withPool(hostId, async () => {
    const s = await loginPool(hostId);
    // What the pool says about its hosts' certificates (at most every few minutes).
    await learnPool(hostId, s.address, s.port, s.useSsl, s.session);
    return s;
  });
}

async function loginPool(hostId: string): Promise<PoolSession> {
  const configured = loadHostsFromDisk().find((h) => h.id === hostId);
  if (!configured) throw new Error("Pool not found");
  if (configured.passwordUnreadable) throw new Error("The stored password of this pool could not be read -- enter it again under Settings → Pools → Edit.");
  const { port, useSsl, username, password } = configured;
  const candidates = [configured.address, configured.backupAddress?.trim()].filter(Boolean) as string[];
  let lastError: unknown = null;
  let refused: CertMismatchError | null = null;
  for (const candidate of candidates) {
    try {
      const session = await loginToHost(candidate, port, useSsl, username, password);
      return { hostId, address: candidate, port, useSsl, session };
    } catch (err) {
      // A refused certificate: the backup is tried (it is checked too), and
      // if nothing answers, the certificate is what is reported.
      if (err instanceof CertMismatchError) {
        refused = err;
        continue;
      }
      if (err instanceof XenApiError && err.message === "HOST_IS_SLAVE" && err.data?.length) {
        // Behind NAT the member names the coordinator's own address (lib/nat.ts).
        const coordinator = reachable(hostId, String(err.data[0]));
        try {
          const session = await loginToHost(coordinator, port, useSsl, username, password);
          return { hostId, address: coordinator, port, useSsl, session };
        } catch (e) {
          if (e instanceof CertMismatchError) refused = e;
          lastError = e;
          continue;
        }
      }
      lastError = err;
    }
  }
  if (refused) throw refused;
  throw lastError instanceof Error ? lastError : new Error("Connection failed");
}

export async function closePoolSession(s: PoolSession): Promise<void> {
  try {
    await logout(s.address, s.port, s.useSsl, s.session);
  } catch {
    // gone already
  }
}

export function call<T = unknown>(s: PoolSession, method: string, ...params: unknown[]): Promise<T> {
  return withPool(s.hostId, () => xenApiCall<T>(s.address, s.port, s.useSsl, method, [s.session, ...params]));
}

/**
 * Waits for an XAPI task; returns its result or throws its error. Once
 * `cancelWhen` says so, the task is cancelled -- XenServer rolls back what it
 * was in the middle of -- and StopRequested is thrown when it has ended.
 */
/**
 * For a task whose work can be seen elsewhere -- a host evacuation, the host
 * empty: when `check` says done for `afterMs` on end while the task is still
 * pending, the task is cancelled and awaitTask returns SETTLED.
 */
export interface Settled {
  check: () => Promise<boolean>;
  afterMs: number;
}
export const SETTLED = "\u0000settled";
const SETTLED_CHECK_MS = Number(process.env.XENMAN_XU_SETTLED_CHECK_MS) || 10_000;

export async function awaitTask(
  s: PoolSession,
  taskRef: string,
  timeoutMs: number,
  onProgress?: (p: number) => void,
  cancelWhen?: () => boolean,
  settled?: Settled,
): Promise<string> {
  const end = Date.now() + timeoutMs;
  let cancelled = false;
  // Since when the work looks done while the task still runs; asked every SETTLED_CHECK_MS.
  let doneSince = 0;
  let checkedAt = 0;
  while (Date.now() < end) {
    if (!cancelled && cancelWhen?.()) {
      cancelled = true;
      await call(s, "task.cancel", taskRef).catch(() => {});
    }
    const t = await call<Record<string, unknown>>(s, "task.get_record", taskRef);
    onProgress?.(Number(t.progress) || 0);
    if (settled && !cancelled && t.status === "pending" && Date.now() - checkedAt >= SETTLED_CHECK_MS) {
      checkedAt = Date.now();
      if (await settled.check().catch(() => false)) {
        doneSince ||= Date.now();
        if (Date.now() - doneSince >= settled.afterMs) {
          // Its work is done; the task itself hangs. Cancelled -- whether
          // XenServer lets go of it is for the caller to check.
          await call(s, "task.cancel", taskRef).catch(() => {});
          return SETTLED;
        }
      } else doneSince = 0;
    }
    if (t.status === "success") {
      await call(s, "task.destroy", taskRef).catch(() => {});
      return String(t.result ?? "");
    }
    if (t.status === "failure" || t.status === "cancelled") {
      await call(s, "task.destroy", taskRef).catch(() => {});
      if (cancelled) throw new StopRequested();
      const info = (t.error_info as string[]) || [];
      throw new XenApiError(info[0] || String(t.status).toUpperCase(), 0, info.slice(1));
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Still running on the host: cancelled, so a retry does not collide with it.
  await call(s, "task.cancel", taskRef).catch(() => {});
  throw new TaskTimeout();
}

export class TaskTimeout extends Error {
  constructor() {
    super("The operation did not finish in time");
    this.name = "TaskTimeout";
  }
}

/** Someone asked a running update to stop. */
export class StopRequested extends Error {
  constructor() {
    super("Stopped on request");
    this.name = "StopRequested";
  }
}

// ─── the model ───────────────────────────────────────────────────────────────

export type Guidance = "RebootHost" | "RestartToolstack" | "EvacuateHost" | "RestartDeviceModel";

export interface XenUpdate {
  id: string;
  summary: string;
  description: string;
  severity: "High" | "None";
  type: string;
  issued: string | null;
  url: string | null;
  guidance: Guidance | null;
  livepatchGuidance: string | null;
  /** Hosts this update is still missing on. */
  hosts: string[];
}

export interface HostUpdateState {
  ref: string;
  name: string;
  address: string;
  version: string;
  isCoordinator: boolean;
  live: boolean;
  enabled: boolean;
  /** Ids of the updates this host lacks. */
  updates: string[];
  highSeverity: number;
  /** What installing them needs, from the metadata. */
  guidance: Guidance[];
  livepatches: number;
  /** Left over from an earlier installation and still to be done. */
  pending: string[];
  latestApplied: "yes" | "no" | "unknown";
  lastUpdated: string | null;
}

export interface PoolUpdates {
  hostId: string;
  pool: {
    name: string;
    haEnabled: boolean;
    /** A Workload Balancing server is connected and acting (not paused). */
    wlbActive: boolean;
    coordinator: string;
    lastSync: string | null;
    autoSync: { enabled: boolean; frequency: string | null };
    channel: { name: string; url: string } | null;
  };
  hosts: HostUpdateState[];
  updates: XenUpdate[];
  hash: string | null;
  /** Why no list could be had, if it could not. */
  problem: string | null;
  checkedAt: string;
}

const RANK: Guidance[] = ["RebootHost", "EvacuateHost", "RestartToolstack", "RestartDeviceModel"];

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

/**
 * What installing needs, as the metadata says. XenServer 8.4 writes
 * `guidance: {mandatory: [...], recommended: [...], full: [...], livepatch: [...]}`;
 * earlier releases wrote `recommended-guidance` / `absolute-guidance`. Both are
 * read. Mandatory counts too: XenServer will not let the host out of
 * maintenance mode before what is mandatory has been done.
 */
function guidanceOf(x: Record<string, unknown> | undefined): Guidance[] {
  if (!x) return [];
  const found = new Set<string>();
  const g = x.guidance;
  if (g && typeof g === "object" && !Array.isArray(g)) {
    for (const kind of ["mandatory", "recommended"]) for (const v of list((g as Record<string, unknown>)[kind])) found.add(v);
  }
  for (const v of [...list(x["recommended-guidance"]), ...list(x["absolute-guidance"])]) found.add(v);
  return RANK.filter((r) => found.has(r));
}

/** XAPI datetimes come as "20260930T10:00:00Z"; the epoch means "never". */
export function xapiDate(v: unknown): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(v ?? ""));
  if (!m || m[1] === "1970") return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString();
}

/**
 * A date from the update metadata. XenServer writes these as XAPI datetimes
 * ("20260930T00:00:00Z"), but ISO dates are taken too.
 */
export function anyDate(v: unknown): string | null {
  if (!v) return null;
  const compact = xapiDate(v);
  if (compact) return compact;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** What the coordinator says each host lacks; null with a reason when it says nothing. */
async function fetchUpdates(s: PoolSession, coordinatorAddress: string): Promise<{ json: Record<string, unknown> | null; problem: string | null }> {
  const url = `${s.useSsl ? "https" : "http"}://${coordinatorAddress}:${s.port}/updates?session_id=${encodeURIComponent(s.session)}`;
  try {
    const res = await xenFetch(url, { signal: AbortSignal.timeout(120_000), poolId: s.hostId });
    if (res.status === 404 || res.status >= 500) {
      return { json: null, problem: "The pool has no update list yet — check for updates first." };
    }
    if (!res.ok) return { json: null, problem: `The coordinator answered HTTP ${res.status}` };
    return { json: (await res.json()) as Record<string, unknown>, problem: null };
  } catch (err) {
    if (err instanceof CertMismatchError) return { json: null, problem: err.message };
    return { json: null, problem: `The update list could not be read: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}

export function friendlyXapiError(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";
  const code = err.message;
  const known: Record<string, string> = {
    LICENSE_RESTRICTION: "The pool's XenServer license does not include updates.",
    NO_REPOSITORY_ENABLED: "No update channel is configured for this pool — set one up in XenCenter under Configure Updates.",
    MULTIPLE_UPDATE_REPOSITORIES_ENABLED: "More than one update channel is enabled for this pool.",
    REPOSITORY_IS_IN_USE: "The update channel is busy — try again in a moment.",
    OTHER_OPERATION_IN_PROGRESS: "Another operation is running on the pool — try again in a moment.",
    SESSION_AUTHENTICATION_FAILED: "The stored credentials for this pool were rejected.",
    RBAC_PERMISSION_DENIED: "The stored account lacks the permission for this (pool-admin is needed).",
  };
  // XenServer says which object is busy and with what: [class, ref, operation, task].
  if (code === "OTHER_OPERATION_IN_PROGRESS" && err instanceof XenApiError && err.data && err.data.length >= 3) {
    const [cls, ref, op] = err.data.map(String);
    const what = describeRef(cls, ref) ?? cls;
    return `${what} is busy (${op}) — try again in a moment.`;
  }
  if (known[code]) return known[code];
  const data = err instanceof XenApiError && err.data?.length ? ` (${err.data.map(String).join(", ")})` : "";
  return `${code}${data}`;
}

/** Reads the update state of a pool without changing anything. */
export async function readPoolUpdates(hostId: string): Promise<PoolUpdates> {
  const s = await openPoolSession(hostId);
  try {
    const [pools, hostRecs, repos] = await Promise.all([
      call<Record<string, Record<string, unknown>>>(s, "pool.get_all_records"),
      call<Record<string, Record<string, unknown>>>(s, "host.get_all_records"),
      call<Record<string, Record<string, unknown>>>(s, "Repository.get_all_records").catch(() => ({})),
    ]);
    const pool = Object.values(pools)[0] || {};
    const coordinator = String(pool.master || "");
    const poolRepos = ((pool.repositories as string[]) || []).map((r) => (repos as Record<string, Record<string, unknown>>)[r]).filter(Boolean);
    const channel = poolRepos.find((r) => r.update) || poolRepos[0];

    const live: Record<string, boolean> = {};
    await Promise.all(
      Object.entries(hostRecs).map(async ([ref, h]) => {
        try {
          live[ref] = Boolean(await call(s, "host_metrics.get_live", h.metrics));
        } catch {
          live[ref] = false;
        }
      }),
    );

    // The address this session reached is the coordinator's -- a member would
    // have answered HOST_IS_SLAVE -- and unlike the address XenServer records
    // for it, it is known to be reachable from here.
    const { json, problem } = poolRepos.length
      ? await fetchUpdates(s, s.address)
      : { json: null, problem: "No update channel is configured for this pool — set one up in XenCenter under Configure Updates." };

    const perHost = new Map<string, Record<string, unknown>>();
    for (const h of ((json?.hosts as Record<string, unknown>[]) || [])) perHost.set(String(h.ref), h);
    const updates: XenUpdate[] = ((json?.updates as Record<string, unknown>[]) || []).map((u) => ({
      id: String(u.id),
      summary: String(u.summary || u.title || ""),
      description: String(u.description ?? ""),
      severity: u.severity === "High" ? "High" : "None",
      type: String(u.type ?? ""),
      issued: anyDate(u.issued),
      url: [u.URL, u.url].find((v): v is string => typeof v === "string" && /^https?:\/\//.test(v)) ?? null,
      guidance: guidanceOf(u)[0] ?? null,
      livepatchGuidance: u["livepatch-guidance"] ? String(u["livepatch-guidance"]) : null,
      hosts: [],
    }));
    const byId = new Map(updates.map((u) => [u.id, u]));

    const hosts: HostUpdateState[] = Object.entries(hostRecs)
      .map(([ref, h]) => {
        const info = perHost.get(ref);
        const ids = ((info?.updates as string[]) || []).map(String);
        for (const id of ids) byId.get(id)?.hosts.push(ref);
        const sv = (h.software_version as Record<string, string>) || {};
        return {
          ref,
          name: String(h.name_label ?? ref),
          address: String(h.address ?? ""),
          version: [sv.product_brand, sv.product_version].filter(Boolean).join(" "),
          isCoordinator: ref === coordinator,
          live: live[ref] ?? false,
          enabled: Boolean(h.enabled),
          updates: ids,
          highSeverity: ids.filter((id) => byId.get(id)?.severity === "High").length,
          guidance: guidanceOf(info),
          livepatches: ((info?.livepatches as unknown[]) || []).length,
          pending: ((h.pending_guidances as string[]) || []).map(String),
          latestApplied: (["yes", "no"].includes(String(h.latest_synced_updates_applied)) ? h.latest_synced_updates_applied : "unknown") as "yes" | "no" | "unknown",
          lastUpdated: xapiDate(h.last_software_update),
        };
      })
      // Coordinator first, as updates are installed.
      .sort((a, b) => (a.isCoordinator === b.isCoordinator ? a.name.localeCompare(b.name) : a.isCoordinator ? -1 : 1));

    return {
      hostId,
      pool: {
        name: String(pool.name_label || hostRecs[coordinator]?.name_label || ""),
        haEnabled: Boolean(pool.ha_enabled),
        wlbActive: Boolean(pool.wlb_url) && Boolean(pool.wlb_enabled),
        coordinator,
        lastSync: xapiDate(pool.last_update_sync),
        autoSync: { enabled: Boolean(pool.update_sync_enabled), frequency: pool.update_sync_frequency ? String(pool.update_sync_frequency) : null },
        channel: channel ? { name: String(channel.name_label ?? ""), url: String(channel.binary_url ?? "") } : null,
      },
      hosts,
      // Only what some host still lacks, newest first.
      updates: updates.filter((u) => u.hosts.length > 0).sort((a, b) => (b.issued ?? "").localeCompare(a.issued ?? "")),
      hash: json?.hash ? String(json.hash) : null,
      problem,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await closePoolSession(s);
  }
}

// ─── checking for updates ────────────────────────────────────────────────────

interface SyncState {
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  by: string;
}

const g = globalThis as unknown as { _xenUpdateSyncs?: Map<string, SyncState>; _xenUpdateCache?: Map<string, PoolUpdates> };
const syncs = (g._xenUpdateSyncs ??= new Map());
const cache = (g._xenUpdateCache ??= new Map());
const CACHE_MS = 15 * 60 * 1000;

export function syncState(hostId: string): SyncState | null {
  return syncs.get(hostId) ?? null;
}

/**
 * Starts fetching the channel's metadata for a pool. Runs on after the request
 * returns -- a sync can take minutes -- and is asked about with syncState().
 */
export function startSync(
  hostId: string,
  by: string,
  onDone: (error: string | null) => void,
): { state: SyncState; started: boolean } {
  const running = syncs.get(hostId);
  if (running?.state === "running") return { state: running, started: false };
  const state: SyncState = { state: "running", startedAt: new Date().toISOString(), by };
  syncs.set(hostId, state);
  (async () => {
    let s: PoolSession | null = null;
    try {
      s = await openPoolSession(hostId);
      const pools = await call<string[]>(s, "pool.get_all");
      const task = await call<string>(s, "Async.pool.sync_updates", pools[0], false, "", "", "", "");
      await awaitTask(s, task, 30 * 60 * 1000);
      cache.delete(hostId);
      syncs.set(hostId, { ...state, state: "done", finishedAt: new Date().toISOString() });
      onDone(null);
    } catch (err) {
      const error = friendlyXapiError(err);
      syncs.set(hostId, { ...state, state: "failed", finishedAt: new Date().toISOString(), error });
      onDone(error);
    } finally {
      if (s) await closePoolSession(s);
    }
  })();
  return { state, started: true };
}

const failures = ((g as { _xenUpdateFailures?: Map<string, { at: number; error: unknown }> })._xenUpdateFailures ??= new Map());
const FAILURE_MS = 5 * 60 * 1000;

/**
 * The update state, from a cache young enough to answer a sidebar badge. A
 * pool that could not be asked is not asked again for a few minutes either,
 * unless `fresh` -- someone looking at it -- says so.
 */
export async function cachedPoolUpdates(hostId: string, fresh = false): Promise<PoolUpdates> {
  const hit = cache.get(hostId);
  if (!fresh && hit && Date.now() - Date.parse(hit.checkedAt) < CACHE_MS) return hit;
  const failed = failures.get(hostId);
  if (!fresh && failed && Date.now() - failed.at < FAILURE_MS) throw failed.error;
  try {
    const next = await readPoolUpdates(hostId);
    cache.set(hostId, next);
    failures.delete(hostId);
    return next;
  } catch (err) {
    failures.set(hostId, { at: Date.now(), error: err });
    throw err;
  }
}
