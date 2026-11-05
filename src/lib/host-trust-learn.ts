// Learning a pool's certificates from the pool itself, over a session whose
// connection was checked: every host's server certificate as XAPI hands it
// out. Members then need no confirmation of their own, and a member whose
// certificate is renewed is taken over without anyone being asked.

import { xenApiCall } from "./xen-client";
import { endFirstContact, learnPoolCertificates, normalizeFingerprint, pemFingerprint, poolTrust, type LearnedHost } from "./host-trust";
import { withPool } from "./xen-tls";

/** Not more often than this per pool, unless the pool has unknown hosts. */
const EVERY_MS = Number(process.env.XENMAN_TRUST_LEARN_MS) || 10 * 60 * 1000;

const g = globalThis as unknown as { _xenmanTrustLearning?: Map<string, Promise<void>> };
const running = (g._xenmanTrustLearning ??= new Map());

/**
 * Reads the pool's hosts and their certificates and makes them the pool's
 * trusted set. Never throws: a pool that cannot say keeps what it had.
 */
export function learnPool(poolId: string, address: string, port: number, useSsl: boolean, session: string, force = false): Promise<void> {
  if (!useSsl) return Promise.resolve();
  // Called after every login that succeeded: what is taken over on first contact ends here.
  endFirstContact(poolId);
  const t = poolTrust(poolId);
  const fresh = t.learnedAt && Date.now() - Date.parse(t.learnedAt) < EVERY_MS;
  if (fresh && !force && t.certs.every((c) => c.uuid)) return Promise.resolve();
  const busy = running.get(poolId);
  if (busy) return busy;
  const p = withPool(poolId, () => learn(poolId, address, port, useSsl, session))
    .catch((err) => console.warn(`[host-trust] could not read the certificates of pool ${poolId}:`, err instanceof Error ? err.message : err))
    .finally(() => running.delete(poolId));
  running.set(poolId, p);
  return p;
}

async function learn(poolId: string, address: string, port: number, useSsl: boolean, session: string) {
  const call = <T,>(method: string, ...params: unknown[]) => xenApiCall<T>(address, port, useSsl, method, [session, ...params]);
  const records = await call<Record<string, { uuid: string; name_label: string; address: string }>>("host.get_all_records");
  const hosts: LearnedHost[] = [];
  let missing = 0;
  await Promise.all(
    Object.entries(records).map(async ([ref, h]) => {
      try {
        const pem = await call<string>("host.get_server_certificate", ref);
        const fp = pemFingerprint(pem);
        if (fp) {
          hosts.push({ uuid: h.uuid, name: h.name_label, address: h.address, fingerprint: fp.fingerprint, notAfter: fp.notAfter });
          return;
        }
      } catch {
        // older or newer XAPI: the certificate records below
      }
      missing++;
    }),
  );
  if (missing) {
    // XenServer 8.2+ also lists certificates as objects of their own.
    try {
      const certs = await call<Record<string, { type?: string; host?: string; fingerprint?: string; fingerprint_sha256?: string; not_after?: string }>>(
        "Certificate.get_all_records",
      );
      for (const c of Object.values(certs)) {
        if (c.type && c.type !== "host") continue;
        const h = c.host ? records[c.host] : undefined;
        const fp = c.fingerprint_sha256 || c.fingerprint;
        if (!h || !fp || hosts.some((x) => x.uuid === h.uuid)) continue;
        hosts.push({ uuid: h.uuid, name: h.name_label, address: h.address, fingerprint: normalizeFingerprint(fp) });
      }
    } catch {
      // nothing more to learn from
    }
  }
  // Only a complete answer replaces the set: a host left out would otherwise be refused.
  if (hosts.length === Object.keys(records).length) learnPoolCertificates(poolId, hosts, address);
  else console.warn(`[host-trust] pool ${poolId}: certificates of ${Object.keys(records).length - hosts.length} host(s) unknown, set kept`);
}
