// Pools whose hosts XenMan reaches only through NAT -- a firewall's virtual IP
// in front of a pool at another site, say.
//
// XAPI calls go to the address the pool was added with and work. But for a
// console, the performance data, an import or an SSH export XenMan connects to
// the address XenServer itself reports (host.address, console.location): the
// host's management address, which is not reachable from here. XenCenter does
// the same and fails the same way -- and XenServer does not pass a console on
// through the coordinator (tried in the field): every host has to be reached.
//
// Switched on per pool (Settings -> Pools), with where to reach each host: an
// address of its own, or one address with a port per host (one virtual IP,
// forwarded by port). Off, nothing changes. Only where XenMan connects to: the
// certificate a host presents is checked against the pool's as ever
// (lib/host-trust.ts checks the fingerprint, not the address).

import { loadHostsFromDisk } from "./host-storage";
import type { XenHost } from "./types";

const ADDRESS_RE = /^[\w.:-]{1,253}$/;

/** Where a host is reached: an address, and a port when it is not the pool's. */
export interface ReachedAt {
  host: string;
  port?: number;
}

/**
 * "1.2.3.4", "vip.example.org", "1.2.3.4:4431", "[fd00::1]:4431" or a bare
 * IPv6 address; null when it is none of them.
 */
export function parseReach(value: string): ReachedAt | null {
  const v = value.trim();
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(v);
  if (bracketed) return withPort(bracketed[1], bracketed[2]);
  const hostPort = /^([\w.-]+):(\d{1,5})$/.exec(v);
  if (hostPort) return withPort(hostPort[1], hostPort[2]);
  return ADDRESS_RE.test(v) ? { host: v } : null;
}

function withPort(host: string, port?: string): ReachedAt | null {
  if (port === undefined) return { host };
  const n = Number(port);
  return n >= 1 && n <= 65535 ? { host, port: n } : null;
}

/** The setting as it may be stored, or the reason it may not. Empty entries are dropped. */
export function cleanNat(input: unknown): { nat?: XenHost["nat"]; error?: string } {
  if (input === undefined || input === null) return {};
  const raw = input as { enabled?: unknown; hosts?: unknown };
  if (typeof raw !== "object" || (raw.hosts !== undefined && (typeof raw.hosts !== "object" || raw.hosts === null || Array.isArray(raw.hosts)))) {
    return { error: "Invalid NAT setting" };
  }
  const hosts: Record<string, string> = {};
  for (const [reported, reach] of Object.entries((raw.hosts as Record<string, unknown>) ?? {})) {
    const to = typeof reach === "string" ? reach.trim() : "";
    if (!to) continue;
    if (!ADDRESS_RE.test(reported) || !parseReach(to)) return { error: `Not an address, or an address with a port: ${to || reported}` };
    hosts[reported.toLowerCase()] = to;
  }
  return { nat: { enabled: raw.enabled === true, hosts } };
}

/** Where to connect for a host XenServer reports at `reported` (no port: the pool's). */
export function reachableAt(poolId: string | undefined, reported: string): ReachedAt {
  if (!poolId) return { host: reported };
  const nat = loadHostsFromDisk().find((h) => h.id === poolId)?.nat;
  const to = nat?.enabled ? nat.hosts[reported.toLowerCase()] : undefined;
  return (to && parseReach(to)) || { host: reported };
}

/** The address alone, for what has a port of its own (SSH). */
export function reachable(poolId: string | undefined, reported: string): string {
  return reachableAt(poolId, reported).host;
}

/** A URL XenServer handed out (a console's location), at the host's reachable address and port. */
export function reachableUrl(poolId: string | undefined, url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const to = reachableAt(poolId, host);
    if (to.host === host && to.port === undefined) return url;
    u.hostname = to.host.includes(":") ? `[${to.host}]` : to.host;
    if (to.port !== undefined) u.port = String(to.port);
    return u.toString();
  } catch {
    return url;
  }
}

/** The addresses a pool's hosts are reached at through NAT (none when it is off). */
export function natAddresses(poolId: string): string[] {
  const nat = loadHostsFromDisk().find((h) => h.id === poolId)?.nat;
  return nat?.enabled ? Object.values(nat.hosts).map((v) => parseReach(v)?.host ?? v) : [];
}
