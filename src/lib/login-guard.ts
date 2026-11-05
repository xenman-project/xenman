// Slows down password guessing. Failed logins are counted per client address
// and username, and per address alone; past a limit that key is refused for a
// while, even with the right password. An account is never locked for every
// address at once: anyone could then lock the administrators out.
//
// Kept in memory: a restart clears it, which an attacker cannot cause from
// outside. The address is the connection's own (server.js), not a header the
// client may set.

const MIN = 60_000;
const num = (name: string, fallback: number) => Number(process.env[name]) || fallback;

/** Counted within this window. */
const WINDOW_MS = num("XENMAN_LOGIN_WINDOW_MS", 15 * MIN);
const PAIR_LIMIT = num("XENMAN_LOGIN_PAIR_LIMIT", 5);
const PAIR_BLOCK_MS = num("XENMAN_LOGIN_PAIR_BLOCK_MS", 5 * MIN);
const IP_LIMIT = num("XENMAN_LOGIN_IP_LIMIT", 20);
const IP_BLOCK_MS = num("XENMAN_LOGIN_IP_BLOCK_MS", 15 * MIN);
/** "Forgot password" sends mail: few per address. */
const RESET_LIMIT = num("XENMAN_RESET_IP_LIMIT", 5);

interface Entry {
  failures: number[];
  blockedUntil: number;
}

const g = globalThis as unknown as { _xenmanLoginGuard?: Map<string, Entry> };
const entries: Map<string, Entry> = (g._xenmanLoginGuard ??= new Map<string, Entry>());

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) entries.set(key, (e = { failures: [], blockedUntil: 0 }));
  return e;
}

function prune(now: number) {
  // Bounded: old keys go once nothing about them is current any more.
  if (entries.size < 1000) return;
  for (const [k, e] of entries) {
    if (e.blockedUntil < now && e.failures.every((t) => t < now - WINDOW_MS)) entries.delete(k);
  }
}

const pairKey = (ip: string, user: string) => `pair:${ip}:${user.trim().toLowerCase()}`;
const ipKey = (ip: string) => `ip:${ip}`;

/** Milliseconds this login has to wait, or 0. */
export function loginBlocked(ip: string, user: string): number {
  const now = Date.now();
  const wait = Math.max(entry(pairKey(ip, user)).blockedUntil, entry(ipKey(ip)).blockedUntil) - now;
  return wait > 0 ? wait : 0;
}

/**
 * A failed login. Returns which block it started -- "pair" or "ip" -- so the
 * caller can log that once, or null.
 */
export function loginFailed(ip: string, user: string): "pair" | "ip" | null {
  const now = Date.now();
  prune(now);
  let started: "pair" | "ip" | null = null;
  for (const [key, limit, blockMs, kind] of [
    [pairKey(ip, user), PAIR_LIMIT, PAIR_BLOCK_MS, "pair"],
    [ipKey(ip), IP_LIMIT, IP_BLOCK_MS, "ip"],
  ] as const) {
    const e = entry(key);
    e.failures = [...e.failures.filter((t) => t > now - WINDOW_MS), now];
    if (e.failures.length >= limit && e.blockedUntil <= now) {
      e.blockedUntil = now + blockMs;
      e.failures = [];
      started ??= kind;
    }
  }
  return started;
}

/** A successful login forgets that pair's failures; the address's count stays. */
export function loginSucceeded(ip: string, user: string): void {
  entries.delete(pairKey(ip, user));
}

/** "Forgot password" from this address: false once it has asked too often. */
export function resetAllowed(ip: string): boolean {
  const now = Date.now();
  const e = entry(`reset:${ip}`);
  e.failures = e.failures.filter((t) => t > now - WINDOW_MS);
  if (e.failures.length >= RESET_LIMIT) return false;
  e.failures.push(now);
  return true;
}

/** "5 minutes", "1 minute", "30 seconds". */
export function waitText(ms: number): string {
  if (ms < MIN) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  const m = Math.ceil(ms / MIN);
  return `${m} minute${m === 1 ? "" : "s"}`;
}
