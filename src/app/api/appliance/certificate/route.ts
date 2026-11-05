import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import {
  CertError,
  currentCert,
  installCert,
  opensslAvailable,
  prepareCert,
  regenerateSelfSigned,
  type CertUpload,
} from "@/lib/tls-cert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A PFX or a PEM bundle is a few kilobytes; anything near this is not one. */
const MAX_FIELD = 256 * 1024;

export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  return NextResponse.json({ cert: currentCert(), openssl: opensslAvailable() });
}

/**
 * { action: "upload", cert, key, chain?, keyPassphrase? } or
 * { action: "upload", pfx (base64), pfxPassword } installs a certificate;
 * { action: "self-signed" } goes back to a generated one. The HTTPS server
 * switches over on its own; open connections keep the old one until closed.
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

  try {
    if (body?.action === "self-signed") {
      const made = regenerateSelfSigned();
      auditRequest(request, {
        category: "config",
        action: "tls_certificate_regenerated",
        target: made.subject,
        outcome: "success",
        detail: `self-signed, valid until ${made.validTo.slice(0, 10)}`,
      });
      return NextResponse.json({ cert: made });
    }
    if (body?.action !== "upload") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    const upload: CertUpload = {};
    for (const k of ["cert", "key", "chain", "keyPassphrase", "pfx", "pfxPassword"] as const) {
      const v = body[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string" || v.length > MAX_FIELD) {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      upload[k] = v;
    }
    const { chainPem, keyPem, info } = prepareCert(upload);
    installCert(chainPem, keyPem);
    auditRequest(request, {
      category: "config",
      action: "tls_certificate_installed",
      target: info.subject,
      outcome: "success",
      detail: `issued by ${info.issuer}, valid until ${info.validTo.slice(0, 10)}, SHA-256 ${info.fingerprint}`,
    });
    return NextResponse.json({ cert: info });
  } catch (err) {
    const message = err instanceof CertError ? err.message : "The certificate could not be installed";
    auditRequest(request, {
      category: "config",
      action: body?.action === "self-signed" ? "tls_certificate_regenerated" : "tls_certificate_installed",
      target: "https",
      outcome: "failure",
      detail: message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
