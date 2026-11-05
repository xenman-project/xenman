// Holds one long-running event.from loop per XAPI session and buffers what it
// delivers, so HTTP requests from the browser can drain the buffer instead of
// each starting a pool call of their own.
//
// The two rates have to be independent. A browser may hold only one connection
// for all pools -- six per origin is the HTTP/1.1 limit, and five pools once ate
// five of them -- so the bundled poll returns as soon as any pool has news. If
// that also drove the XAPI calls, every pool would be asked again on every
// round: measured at 120 event.from calls per minute against a silent pool
// instead of 2, with four out of five aborted mid-wait. One browser connection
// is worth having; sixty times the load on every pool master is not.
//
// A pump therefore outlives the request that started it. It keeps exactly one
// event.from in flight, re-issues it only when it returns, and parks what it
// receives. Nothing is aborted, so no pool call is ever wasted.
//
// On globalThis so it survives HMR module reloads in dev, matching how
// lib/xen-sessions.ts and lib/ref-names.ts hold their state.

import { eventFrom, XenApiError, type XenRawEvent } from "./xen-client";
import { withPool } from "./xen-tls";
import { lookupSession } from "./xen-sessions";

/** Seconds event.from waits on a quiet pool before returning empty-handed. */
const POLL_TIMEOUT = 30;

/** Pause after a failing call, so an unreachable pool is not hammered. */
const ERROR_BACKOFF_MS = 5_000;

/** Shorter pause after EVENTS_LOST, which one further call usually clears. */
const LOST_BACKOFF_MS = 1_000;

/**
 * Raw events parked for one pool before the buffer counts as unusable.
 *
 * Overflow is treated exactly like XAPI's own EVENTS_LOST: the buffer is
 * dropped and the consumer told to resynchronise. Handing over a truncated
 * stream would be worse -- the client would apply it and quietly hold a wrong
 * picture of the pool.
 */
const MAX_BUFFERED = 5_000;

/** A pump with no drain for this long has lost its browser; stop calling XAPI. */
const IDLE_STOP_MS = 120_000;

interface Pump {
  sessionRef: string;
  hostId: string;
  host: string;
  port: number;
  useSsl: boolean;
  /** Position in the pool's event stream. Empty means "not yet registered". */
  token: string;
  buffer: XenRawEvent[];
  /** Set when the consumer must refresh from scratch rather than apply events. */
  lost: boolean;
  /** Last transient failure, reported once and then cleared. */
  error?: string;
  lastDrainedAt: number;
  stopped: boolean;
  waiters: Set<() => void>;
}

const g = globalThis as typeof globalThis & {
  _xenEventPumps?: Map<string, Pump>;
};
if (!g._xenEventPumps) g._xenEventPumps = new Map<string, Pump>();
const pumps = g._xenEventPumps;

export interface PumpSpec {
  sessionRef: string;
  hostId: string;
  host: string;
  port: number;
  useSsl: boolean;
}

export interface DrainResult {
  hostId: string;
  events: XenRawEvent[];
  /** The consumer's picture is stale; refresh instead of applying events. */
  lost: boolean;
  error?: string;
}

function wake(pump: Pump) {
  for (const waiter of pump.waiters) waiter();
  pump.waiters.clear();
}

function stop(pump: Pump) {
  pump.stopped = true;
  pumps.delete(pump.sessionRef);
  wake(pump);
}

async function run(pump: Pump): Promise<void> {
  while (!pump.stopped) {
    // The session outranks the pump: a disconnect, an expiry or a revoked grant
    // removes it, and the loop must not keep calling the pool afterwards.
    if (!lookupSession(pump.sessionRef)) return stop(pump);
    if (Date.now() - pump.lastDrainedAt > IDLE_STOP_MS) return stop(pump);

    try {
      const res = await eventFrom(
        pump.host,
        pump.port,
        pump.useSsl,
        pump.sessionRef,
        ["*"],
        pump.token,
        POLL_TIMEOUT,
      );
      pump.token = res.token;
      pump.error = undefined;

      const events = Array.isArray(res.events) ? res.events : [];
      if (events.length > 0) {
        pump.buffer.push(...events);
        if (pump.buffer.length > MAX_BUFFERED) {
          pump.buffer = [];
          pump.lost = true;
        }
        wake(pump);
      }
    } catch (err) {
      if (err instanceof XenApiError && err.message === "EVENTS_LOST") {
        // The pool discarded the position we held. An empty token re-registers
        // on the next call; the consumer refreshes rather than applying events.
        pump.token = "";
        pump.buffer = [];
        pump.lost = true;
        wake(pump);
        // Normally this resolves on the next call. A pool that keeps saying it
        // is usually one under strain, and re-registering in a tight loop is
        // the last thing it needs.
        await new Promise((r) => setTimeout(r, LOST_BACKOFF_MS));
        continue;
      }
      pump.error = err instanceof Error ? err.message : "event.from failed";
      wake(pump);
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    }
  }
}

function ensurePump(spec: PumpSpec): Pump {
  const existing = pumps.get(spec.sessionRef);
  if (existing && !existing.stopped) {
    existing.lastDrainedAt = Date.now();
    return existing;
  }

  const pump: Pump = {
    ...spec,
    token: "",
    buffer: [],
    lost: false,
    lastDrainedAt: Date.now(),
    stopped: false,
    waiters: new Set(),
  };
  pumps.set(spec.sessionRef, pump);
  // Deliberately not awaited: the loop runs for as long as the browser keeps
  // draining, far beyond the request that happened to start it.
  // On behalf of its pool: the certificates its calls must show are that
  // pool's, whatever address the session reached the coordinator at.
  void withPool(spec.hostId, () => run(pump));
  return pump;
}

function take(pump: Pump): DrainResult | null {
  const hasNews = pump.buffer.length > 0 || pump.lost || pump.error;
  if (!hasNews) return null;
  const result: DrainResult = {
    hostId: pump.hostId,
    events: pump.buffer,
    lost: pump.lost,
    ...(pump.error ? { error: pump.error } : {}),
  };
  pump.buffer = [];
  pump.lost = false;
  pump.error = undefined;
  return result;
}

/**
 * Start or refresh a pump per pool and hand back whatever has accumulated.
 *
 * Returns at once if any pool already has something, otherwise waits until one
 * of them does or `timeoutMs` elapses. An empty map means every pool stayed
 * quiet for the whole window, which is the normal case on an idle estate.
 */
export async function drainPumps(
  specs: PumpSpec[],
  timeoutMs: number,
): Promise<Map<string, DrainResult>> {
  const active = specs.map(ensurePump);

  const collect = () => {
    const out = new Map<string, DrainResult>();
    for (const pump of active) {
      const result = take(pump);
      if (result) out.set(pump.sessionRef, result);
    }
    return out;
  };

  const immediate = collect();
  if (immediate.size > 0) return immediate;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const pump of active) pump.waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    for (const pump of active) pump.waiters.add(finish);
  });

  return collect();
}

/** Stop the pump for a session — called when its connection goes away. */
export function stopPump(sessionRef: string): void {
  const pump = pumps.get(sessionRef);
  if (pump) stop(pump);
}
