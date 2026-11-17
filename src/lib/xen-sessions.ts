// Maps XAPI session refs to the pool and app user they belong to.
//
// Why this exists: the browser calls /api/xen from ~42 places, each sending
// `host`, `port` and `sessionRef` in the body. Trusting those means any user
// could aim a request at any pool. Instead `connect` records the binding here,
// and every later action derives host/port from this registry and verifies the
// caller — so the client-supplied values become irrelevant to authorization
// without touching all those call sites.
//
// The XAPI session itself never leaves the server. It is opened with the
// pool's stored account (as a rule root), so whoever holds it can do anything
// on the pool directly, past XenMan's roles. The browser gets a handle
// instead -- random, worthless at the pool -- and /api/xen, the VM import,
// server.js and vnc-proxy.js turn it back into the session (xapiRefOf). Within
// the server everything keeps working with the session itself.
//
// A binding that ends -- disconnect, sign-out, the account's removal, a
// revoked grant, a day unused -- ends its XAPI session at the pool as well.
//
// Deliberately in-memory: a restart drops all entries, clients get a 401 and
// reconnect. Nothing here is worth persisting, and an expired XAPI session ref
// would be useless anyway.
//
// Kept on globalThis so it survives HMR module reloads in dev, and so server.js
// and vnc-proxy.js, outside Next's module graph, see the same maps.

import crypto from "crypto";
import { logout } from "./xen-client";
import { withPool } from "./xen-tls";

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
  /** What the browser was given for this session, in its place. */
  handle: string;
  /** The sign-in (lib/login-sessions.ts) that opened it: signing out ends it. */
  sid?: string;
  /**
   * The console locations vm_console/host_console handed out on this session:
   * the only ones the console proxy (vnc-proxy.js) connects to, so a client
   * cannot point it at any other address.
   */
  consoles?: Set<string>;
  /**
   * Those of them that are a host's own console (the control domain, a root
   * shell): server.js lets only administrators open these, also later.
   */
  hostConsoles?: Set<string>;
}

const g = globalThis as typeof globalThis & {
  _xenSessions?: Map<string, XenSessionEntry>;
  /** Handle -> XAPI session ref. */
  _xenSessionHandles?: Map<string, string>;
};
if (!g._xenSessions) g._xenSessions = new Map();
if (!g._xenSessionHandles) g._xenSessionHandles = new Map();
const sessions = g._xenSessions;
const handles = g._xenSessionHandles;

/** Forgets the binding and ends the XAPI session at the pool, in the background. */
function drop(ref: string, logoutAtPool = true) {
  const entry = sessions.get(ref);
  if (!entry) return;
  sessions.delete(ref);
  handles.delete(entry.handle);
  if (!logoutAtPool) return;
  void withPool(entry.hostId, () => logout(entry.address, entry.port, entry.useSsl, ref)).catch(() => {
    // gone already, or the pool is not reachable: XAPI ends idle sessions itself
  });
}

function reapExpired(now: number) {
  for (const [ref, entry] of sessions) {
    if (now - entry.lastUsed > IDLE_TTL_MS) drop(ref);
  }
}

/** Records the binding; returns the handle the browser gets in the session's place. */
export function registerSession(
  sessionRef: string,
  entry: Omit<XenSessionEntry, "createdAt" | "lastUsed" | "handle">,
): string {
  const now = Date.now();
  reapExpired(now);
  const handle = `xs_${crypto.randomBytes(24).toString("base64url")}`;
  sessions.set(sessionRef, { ...entry, handle, createdAt: now, lastUsed: now });
  handles.set(handle, sessionRef);
  return handle;
}

/** The XAPI session behind a handle from the browser, while its binding lasts; else null. */
export function xapiRefOf(handle: unknown): string | null {
  if (typeof handle !== "string" || !handle.startsWith("xs_")) return null;
  const ref = handles.get(handle);
  if (!ref) return null;
  const entry = sessions.get(ref);
  if (!entry || Date.now() - entry.lastUsed > IDLE_TTL_MS) {
    if (entry) drop(ref);
    else handles.delete(handle);
    return null;
  }
  return ref;
}

/** Returns the binding and refreshes its idle timer, or null if unknown. */
export function lookupSession(sessionRef: string): XenSessionEntry | null {
  if (!sessionRef) return null;
  const entry = sessions.get(sessionRef);
  if (!entry) return null;
  if (Date.now() - entry.lastUsed > IDLE_TTL_MS) {
    drop(sessionRef);
    return null;
  }
  entry.lastUsed = Date.now();
  return entry;
}

/** Lets the console proxy connect to this console location on this session. */
export function grantConsole(sessionRef: string, location: string, kind: "vm" | "host" = "vm"): void {
  const entry = sessions.get(sessionRef);
  if (!entry) return;
  (entry.consoles ??= new Set()).add(location);
  if (kind === "host") (entry.hostConsoles ??= new Set()).add(location);
}

/** Forgets a session the caller has just logged out at the pool itself (disconnect). */
export function removeSession(sessionRef: string, logoutAtPool = true): void {
  drop(sessionRef, logoutAtPool);
}

/** Forget every session of one user — when their grants change, they sign out everywhere or are removed. */
export function removeSessionsForActor(actor: string): number {
  let removed = 0;
  for (const [ref, entry] of sessions) {
    if (entry.actor.toLowerCase() === actor.toLowerCase()) {
      drop(ref);
      removed++;
    }
  }
  return removed;
}

/** Forget a user's sessions on pools no longer granted to them — the others keep running. */
export function removeSessionsOutside(actor: string, granted: string[]): number {
  let removed = 0;
  for (const [ref, entry] of sessions) {
    if (entry.actor.toLowerCase() === actor.toLowerCase() && !granted.includes(entry.hostId)) {
      drop(ref);
      removed++;
    }
  }
  return removed;
}

/** Forget the sessions one sign-in opened — when it signs out. */
export function removeSessionsForLogin(sid: string | undefined): number {
  if (!sid) return 0;
  let removed = 0;
  for (const [ref, entry] of sessions) {
    if (entry.sid === sid) {
      drop(ref);
      removed++;
    }
  }
  return removed;
}
