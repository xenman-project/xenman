import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { testTenant } from "@/lib/entra-oidc";
import { configuredUrl } from "@/lib/public-url";
import { parseSsoConfig, readSsoConfig, saveSsoConfig, ssoConfigView } from "@/lib/sso-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signing in with Entra ID, for the settings page: the secret only as set or not. Admins only. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  return NextResponse.json({ ...ssoConfigView(), suggestedAddress: configuredUrl() ?? "" });
}

/** Saves it; a client secret left empty keeps the one set. */
export async function PUT(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const before = readSsoConfig();
  const parsed = parseSsoConfig(body, before);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const c = parsed.config;
  saveSsoConfig(c);
  const changes: string[] = [];
  if (before.enabled !== c.enabled) changes.push(c.enabled ? "switched on" : "switched off");
  if (before.tenantId !== c.tenantId) changes.push(`tenant ${c.tenantId || "(none)"}`);
  if (before.clientId !== c.clientId) changes.push(`client ${c.clientId || "(none)"}`);
  if (before.clientSecret !== c.clientSecret) changes.push("new client secret");
  if (before.address !== c.address) changes.push(`address ${c.address || "(none)"}`);
  if (before.localAdminsOnly !== c.localAdminsOnly) changes.push(c.localAdminsOnly ? "password sign-in for administrators only" : "password sign-in for everyone");
  auditRequest(request, {
    category: "config",
    action: "sso_config_saved",
    target: "Microsoft Entra ID",
    outcome: "success",
    detail: changes.join(", ") || "unchanged",
  });
  return NextResponse.json(ssoConfigView(c));
}

/** { action: "test", tenantId }: whether Entra ID knows the tenant and XenMan reaches it. */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (body.action !== "test") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  const tenantId = String(body.tenantId ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenantId)) {
    return NextResponse.json({ error: "The tenant ID is a GUID, as Entra shows it under Overview (Directory (tenant) ID)" }, { status: 400 });
  }
  return NextResponse.json(await testTenant(tenantId));
}
