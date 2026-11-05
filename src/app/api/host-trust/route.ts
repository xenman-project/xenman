import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { accessibleHosts } from "@/lib/pool-access";
import { loadHostsFromDisk } from "@/lib/host-storage";
import {
  acceptSshKey,
  dismissMismatch,
  markReviewed,
  normalizeFingerprint,
  poolTrust,
  removeCertificate,
  removeSshKey,
  trustCertificate,
} from "@/lib/host-trust";
import { resetPoolConnections } from "@/lib/xen-tls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The trusted certificates and SSH keys of the pools this user may see, and what was refused. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin", "operator", "viewer");
  if (auth.error) return auth.error;
  const pools = accessibleHosts(auth.payload).map((h) => {
    const t = { ...poolTrust(h.id) };
    // Not the mail bookkeeping.
    delete t.lastMail;
    delete t.lastSshMail;
    return { poolId: h.id, name: h.name || h.address, useSsl: h.useSsl, ...t };
  });
  return NextResponse.json({ pools });
}

/**
 * Admins only:
 *   { action: "accept", poolId, fingerprint }  trust the certificate that was refused
 *   { action: "reviewed", poolId }             the taken-over fingerprints were compared
 *   { action: "dismiss", poolId }              forget what was refused, trust nothing new
 *   { action: "remove", poolId, fingerprint }  stop trusting one certificate
 *   { action: "accept_ssh", poolId, address }  trust the SSH host key that was refused
 *   { action: "remove_ssh", poolId, address }  forget an SSH host key (learned again next time)
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const poolId = typeof body.poolId === "string" ? body.poolId : "";
  const pool = loadHostsFromDisk().find((h) => h.id === poolId);
  if (!pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
  const target = `pool "${pool.name || pool.address}"`;
  const t = poolTrust(poolId);
  const done = (action: string, detail: string) => {
    auditRequest(request, { category: "host", action, target, outcome: "success", detail });
    resetPoolConnections(poolId);
    return NextResponse.json({ ok: true, ...poolTrust(poolId) });
  };

  switch (body.action) {
    case "accept": {
      // Only what was actually presented and refused, compared by the admin.
      const fp = normalizeFingerprint(String(body.fingerprint ?? ""));
      if (!t.mismatch || t.mismatch.fingerprint !== fp) {
        return NextResponse.json({ error: "That is not the certificate that was refused" }, { status: 400 });
      }
      trustCertificate(poolId, { fingerprint: fp, address: t.mismatch.address, notAfter: t.mismatch.notAfter });
      return done("host_cert_accepted", `${t.mismatch.address}: SHA-256 ${fp} trusted by an admin`);
    }
    case "reviewed":
      if (!t.pendingReview) return NextResponse.json({ error: "Nothing to review" }, { status: 400 });
      markReviewed(poolId);
      return done("host_cert_reviewed", `compared: ${t.certs.map((c) => `${c.address ?? c.host}: ${c.fingerprint}`).join("; ")}`);
    case "dismiss":
      dismissMismatch(poolId);
      return done("host_cert_dismissed", t.mismatch ? `refused ${t.mismatch.address}: SHA-256 ${t.mismatch.fingerprint}, not trusted` : "nothing refused");
    case "remove": {
      const fp = normalizeFingerprint(String(body.fingerprint ?? ""));
      if (!t.certs.some((c) => c.fingerprint === fp)) return NextResponse.json({ error: "Not a trusted certificate" }, { status: 400 });
      removeCertificate(poolId, fp);
      return done("host_cert_removed", `SHA-256 ${fp} no longer trusted`);
    }
    case "accept_ssh": {
      const address = String(body.address ?? "");
      if (t.sshMismatch?.address !== address) return NextResponse.json({ error: "No refused SSH key for that address" }, { status: 400 });
      acceptSshKey(poolId, address);
      return done("ssh_hostkey_accepted", `${address}: ${t.sshMismatch.fingerprint} trusted by an admin`);
    }
    case "remove_ssh": {
      const address = String(body.address ?? "");
      if (!t.sshKeys?.[address]) return NextResponse.json({ error: "No SSH key for that address" }, { status: 400 });
      removeSshKey(poolId, address);
      return done("ssh_hostkey_removed", `${address}: ${t.sshKeys[address].fingerprint} forgotten`);
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
