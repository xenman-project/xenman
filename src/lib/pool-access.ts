// The single place that decides which pools a user may reach.
//
// One configured host entry corresponds to one pool: `connect` follows XAPI's
// HOST_IS_SLAVE redirect to the pool master, and a XAPI session sees exactly
// one pool. So a grant is a list of host ids.
//
// Grants are deny-by-default: a user with no `pools` on record reaches nothing.
// Admins bypass the list entirely — they configure the hosts in the first place.

import { getUserPools, type UserRole } from "./auth";
import { loadHostsFromDisk } from "./host-storage";
import type { XenHost, XenHostPublic } from "./types";

export interface Actor {
  sub: string;
  role: UserRole;
}

export function mayAccessHost(actor: Actor, hostId: string): boolean {
  if (!hostId) return false;
  if (actor.role === "admin") return true;
  return getUserPools(actor.sub).includes(hostId);
}

/** Configured hosts this actor may see, credentials still attached. */
export function accessibleHosts(actor: Actor): XenHost[] {
  const hosts = loadHostsFromDisk();
  if (actor.role === "admin") return hosts;
  const granted = new Set(getUserPools(actor.sub));
  return hosts.filter((h) => granted.has(h.id));
}

/**
 * Project a host record onto the fields the browser may see. The browser drives
 * connections by host id and never needs the password — `connect` reads it
 * server-side.
 *
 * Deliberately an allowlist rather than `delete host.password`: if XenHost ever
 * gains another secret, this stops compiling instead of quietly shipping it.
 */
export function toPublicHost(host: XenHost): XenHostPublic {
  return {
    id: host.id,
    name: host.name,
    address: host.address,
    port: host.port,
    username: host.username,
    useSsl: host.useSsl,
    autoConnect: host.autoConnect,
    backupAddress: host.backupAddress,
    sshPort: host.sshPort,
    // Whether, not what: the password has to be entered again.
    ...(host.passwordUnreadable ? { passwordUnreadable: true } : {}),
  };
}
