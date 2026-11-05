// Maps XAPI session refs to the pool and app user they belong to.
//
// Why this exists: the browser calls /api/xen from ~42 places, each sending
// `host`, `port` and `sessionRef` in the body. Trusting those means any user
// could aim a request at any pool. Instead `connect` records the binding here,
// and every later action derives host/port from this registry and verifies the
// caller — so the client-supplied values become irrelevant to authorization
// without touching all those call sites.
//
// Deliberately in-memory: a restart drops all entries, clients get a 401 and
// reconnect. Nothing here is worth persisting, and an expired XAPI session ref
// would be useless anyway.
//
// Kept on globalThis so it survives HMR module reloads in dev, matching how
// route.ts holds its SSH export jobs.

/** Drop entries untouched for this long; XAPI sessions do not live forever. */
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;

export interface XenSessionEntry {
  /** Configured host entry (= pool) this session was opened against. */
  hostId: string;
  /** App username that opened it. */
  actor: string;
  /** Address actually used, after any HOST_IS_SLAVE redirect to the master. */
  address: string;
  port: number;
  useSsl: boolean;
  createdAt: number;
  lastUsed: number;
}

const g = globalThis as typeof globalThis & {
  _xenSessions?: Map<string, XenSessionEntry>;
};
if (!g._xenSessions) g._xenSessions = new Map();
const sessions = g._xenSessions;

function reapExpired(now: number) {
  for (const [ref, entry] of sessions) {
    if (now - entry.lastUsed > IDLE_TTL_MS) sessions.delete(ref);
  }
}

export function registerSession(
  sessionRef: string,
  entry: Omit<XenSessionEntry, "createdAt" | "lastUsed">,
): void {
  const now = Date.now();
  reapExpired(now);
  sessions.set(sessionRef, { ...entry, createdAt: now, lastUsed: now });
}

/** Returns the binding and refreshes its idle timer, or null if unknown. */
export function lookupSession(sessionRef: string): XenSessionEntry | null {
  if (!sessionRef) return null;
  const entry = sessions.get(sessionRef);
  if (!entry) return null;
  if (Date.now() - entry.lastUsed > IDLE_TTL_MS) {
    sessions.delete(sessionRef);
    return null;
  }
  entry.lastUsed = Date.now();
  return entry;
}

export function removeSession(sessionRef: string): void {
  sessions.delete(sessionRef);
}

/** Forget every session of one user — used when their grants change. */
export function removeSessionsForActor(actor: string): number {
  let removed = 0;
  for (const [ref, entry] of sessions) {
    if (entry.actor.toLowerCase() === actor.toLowerCase()) {
      sessions.delete(ref);
      removed++;
    }
  }
  return removed;
}
