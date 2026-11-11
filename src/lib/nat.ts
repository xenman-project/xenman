// Pools whose hosts XenMan reaches only through NAT -- a firewall's virtual IP
// in front of a pool at another site, say.
//
// XAPI calls go to the address the pool was added with and work. But for a
// console, the performance data, an import or an SSH export XenMan connects to
// the address XenServer itself reports (host.address, console.location): the
// host's management address, which is not reachable from here. XenCenter does
// the same and fails the same way.
//
// Switched on per pool (Settings -> Pools), with the address to reach each
// host at; off, nothing changes. Only where XenMan connects to: the
// certificate a host presents is checked against the pool's as ever
// (lib/host-trust.ts checks the fingerprint, not the address).

import { loadHostsFromDisk } from "./host-storage";
import type { XenHost } from "./types";

const ADDRESS_RE = /^[\w.:-]{1,253}$/;

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
    if (!ADDRESS_RE.test(reported) || !ADDRESS_RE.test(to)) return { error: `Not a host name or IP address: ${to || reported}` };
    hosts[reported.toLowerCase()] = to;
  }
  return { nat: { enabled: raw.enabled === true, hosts } };
}

/** The address to connect to for a host XenServer reports at `reported`. */
export function reachable(poolId: string | undefined, reported: string): string {
  if (!poolId) return reported;
  const nat = loadHostsFromDisk().find((h) => h.id === poolId)?.nat;
  if (!nat?.enabled) return reported;
  return nat.hosts[reported.toLowerCase()] || reported;
}

/** A URL XenServer handed out (a console's location), at the host's reachable address. */
export function reachableUrl(poolId: string | undefined, url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const to = reachable(poolId, host);
    if (to === host) return url;
    u.hostname = to.includes(":") ? `[${to}]` : to;
    return u.toString();
  } catch {
    return url;
  }
}

/** The addresses a pool's hosts are reached at through NAT (none when it is off). */
export function natAddresses(poolId: string): string[] {
  const nat = loadHostsFromDisk().find((h) => h.id === poolId)?.nat;
  return nat?.enabled ? Object.values(nat.hosts) : [];
}
