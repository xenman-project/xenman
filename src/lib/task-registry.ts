// Recent Tasks: what XenMan started on a pool, who started it and how it
// went -- XenServer does not record which user a task belongs to (every
// XenMan user works through the pool's one stored account), so XenMan keeps
// that itself. Also the XenServer tasks XenMan's own jobs create, so the list
// does not show them a second time as tasks of another client.
//
// Held in memory: after a restart of XenMan the list starts again (update jobs,
// kept on disk, are read from there).

export type TaskState = "running" | "done" | "failed" | "cancelled" | "ended";
export type ObjectClass = "VM" | "host" | "SR" | "pool";
export type JobKind = "maintenance" | "vm-memory" | "pool-member" | "dom0" | "network" | "export";

export interface TaskObject {
  class: ObjectClass;
  ref?: string;
  name?: string;
}

/** A XenMan action on a pool, as the API wrapper recorded it. */
export interface TrackedAction {
  id: string;
  poolId: string;
  startedAt: number;
  finishedAt?: number;
  actor: string;
  action: string;
  operation: string;
  object: TaskObject;
  /** Hosts it concerns beyond the object itself (a migration's target). */
  hostRefs: string[];
  state: TaskState;
  error?: string;
  /** Followed further: a XenServer task, or one of XenMan's jobs. */
  link?: { kind: "task"; ref: string } | { kind: "job"; job: JobKind; id: string };
}

/** What the list says of a task of another client, last seen. */
export interface SeenTask {
  ref: string;
  poolId: string;
  startedAt: number;
  finishedAt?: number;
  lastSeen: number;
  state: TaskState;
  progress?: number;
  operation: string;
  object: TaskObject;
  hostRefs: string[];
  by?: string;
  error?: string;
  cancellable: boolean;
  adminOnly: boolean;
}

/** How long finished entries stay, and how many entries a pool keeps. */
export const KEEP_MS = Number(process.env.XENMAN_TASKS_KEEP_MS) || 24 * 60 * 60 * 1000;
// All of the last 24 hours; the cap only guards against a pool gone wild (XENMAN_TASKS_MAX for tests).
export const MAX_ENTRIES = Number(process.env.XENMAN_TASKS_MAX) || 500;

const g = globalThis as typeof globalThis & {
  _xenmanTracked?: Map<string, TrackedAction[]>;
  _xenmanSeenTasks?: Map<string, Map<string, SeenTask>>;
  _xenmanInternalTasks?: Map<string, number>;
  _xenmanBackground?: Map<string, Promise<string | null>>;
};
const tracked: Map<string, TrackedAction[]> = (g._xenmanTracked ??= new Map());
const seen: Map<string, Map<string, SeenTask>> = (g._xenmanSeenTasks ??= new Map());
const internal: Map<string, number> = (g._xenmanInternalTasks ??= new Map());
const background: Map<string, Promise<string | null>> = (g._xenmanBackground ??= new Map());

const fresh = (startedAt: number, finishedAt: number | undefined, state: TaskState, now: number) =>
  state === "running" || now - (finishedAt ?? startedAt) < KEEP_MS;

export function trackAction(entry: Omit<TrackedAction, "id" | "startedAt" | "state">): TrackedAction {
  const t: TrackedAction = { ...entry, id: crypto.randomUUID(), startedAt: Date.now(), state: "running" };
  const list = tracked.get(entry.poolId) ?? [];
  list.push(t);
  tracked.set(entry.poolId, list);
  return t;
}

export function settleAction(t: TrackedAction, state: TaskState, error?: string): void {
  t.state = state;
  t.finishedAt = Date.now();
  if (error) t.error = error;
}

/**
 * Work that outlasts its request: a synchronous XenServer call with no Async
 * form (VMSS.snapshot_now). Its outcome -- null when it succeeded, else what
 * went wrong -- is kept a minute for the API wrapper to follow (route.ts,
 * trackEnd); the work runs on either way, and never ends in an unhandled
 * rejection.
 */
export function startBackground(work: Promise<unknown>, describe: (err: unknown) => string): string {
  const id = crypto.randomUUID();
  const outcome = work.then(
    () => null,
    (err: unknown) => describe(err),
  );
  background.set(id, outcome);
  void outcome.then(() => setTimeout(() => background.delete(id), 60_000).unref?.());
  return id;
}

export function backgroundOutcome(id: string): Promise<string | null> | undefined {
  return background.get(id);
}

/** Not a task after all (refused, or a question back): gone from the list. */
export function dropAction(t: TrackedAction): void {
  const list = tracked.get(t.poolId);
  if (list) tracked.set(t.poolId, list.filter((x) => x.id !== t.id));
}

export function trackedActions(poolId: string): TrackedAction[] {
  const now = Date.now();
  const list = (tracked.get(poolId) ?? []).filter((t) => fresh(t.startedAt, t.finishedAt, t.state, now));
  tracked.set(poolId, list.slice(-MAX_ENTRIES));
  return list;
}

/** XenServer tasks XenMan follows for a user's action: not tasks of another client. */
export function linkedTaskRefs(poolId: string): Set<string> {
  return new Set(
    (tracked.get(poolId) ?? []).flatMap((t) => (t.link?.kind === "task" ? [t.link.ref] : [])),
  );
}

// Started by XenMan: a job's (negative) or one followed for a user's action
// (positive) -- remembered beyond the entry itself, as XenServer may list the
// task for longer than Recent Tasks keeps the entry.
const remember = (ref: string, value: number) => {
  internal.set(ref, value);
  // Tasks live minutes, rarely hours: forget them after a day.
  if (internal.size > 500) {
    const cut = Date.now() - 24 * 60 * 60 * 1000;
    for (const [r, at] of internal) if (Math.abs(at) < cut) internal.delete(r);
  }
};

/** A XenServer task created by one of XenMan's own jobs: stopped with its job, not by itself. */
export function markInternalTask(ref: string): void {
  remember(ref, -Date.now());
}

/** A XenServer task XenMan follows for a user's action. */
export function markLinkedTask(ref: string): void {
  if (!internal.has(ref)) remember(ref, Date.now());
}

export function isInternalTask(ref: string): boolean {
  return (internal.get(ref) ?? 0) < 0;
}

/** Started by XenMan in either way: never shown as another client's. */
export function isXenmanTask(ref: string): boolean {
  return internal.has(ref);
}

/** The tasks of other clients as last seen on a pool; one no longer listed has ended. */
export function updateSeenTasks(poolId: string, running: SeenTask[]): SeenTask[] {
  const now = Date.now();
  const map = seen.get(poolId) ?? new Map<string, SeenTask>();
  // A start XenServer did not give in a known form: when it was first seen.
  // Its object too: once the task has ended, the VM no longer shows it among its operations.
  for (const t of running) {
    const before = map.get(t.ref);
    const keepObject = !t.object.ref && before?.object.ref;
    map.set(t.ref, {
      ...t,
      startedAt: before?.startedAt ?? t.startedAt,
      object: keepObject ? before!.object : t.object,
      hostRefs: keepObject ? before!.hostRefs : t.hostRefs,
      lastSeen: now,
    });
  }
  for (const [ref, t] of map) {
    if (t.state === "running" && t.lastSeen !== now) {
      // Gone without being seen to end: XenServer destroyed it after its client read the result.
      map.set(ref, { ...t, state: "ended", finishedAt: t.lastSeen, cancellable: false });
    }
    const x = map.get(ref)!;
    if (!fresh(x.startedAt, x.finishedAt, x.state, now)) map.delete(ref);
  }
  seen.set(poolId, map);
  return [...map.values()];
}
