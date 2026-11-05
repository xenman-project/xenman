import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { audit, auditRequest } from "@/lib/audit";
import { mayAccessHost } from "@/lib/pool-access";
import { loadHostsFromDisk } from "@/lib/host-storage";
import { cachedPoolUpdates, friendlyXapiError, startSync, syncState } from "@/lib/xen-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The update state of one pool: ?hostId=<configured pool>[&fresh=1]. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin", "operator", "viewer");
  if (auth.error) return auth.error;
  const hostId = request.nextUrl.searchParams.get("hostId") || "";
  if (!mayAccessHost(auth.payload, hostId)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  if (!loadHostsFromDisk().some((h) => h.id === hostId)) {
    return NextResponse.json({ error: "Pool not found" }, { status: 404 });
  }
  const sync = syncState(hostId);
  try {
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    return NextResponse.json({ updates: await cachedPoolUpdates(hostId, fresh), sync });
  } catch (err) {
    return NextResponse.json({ error: friendlyXapiError(err), sync }, { status: 502 });
  }
}

/** { hostId, action: "sync" }: fetch the update channel's current metadata. */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: { hostId?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const hostId = typeof body.hostId === "string" ? body.hostId : "";
  if (body.action !== "sync") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  if (!mayAccessHost(auth.payload, hostId)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  const pool = loadHostsFromDisk().find((h) => h.id === hostId);
  if (!pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });

  const by = auth.payload.sub;
  const { state, started } = startSync(hostId, by, (error) => {
    audit({
      actor: by,
      role: auth.payload.role,
      ip: "-",
      category: "pool",
      action: "xen_updates_synced",
      target: `pool ${pool.name}`,
      outcome: error ? "failure" : "success",
      ...(error ? { detail: error } : {}),
    });
  });
  // Joining a check that is already running is not another request.
  if (started) {
    auditRequest(request, { category: "pool", action: "xen_updates_sync_requested", target: `pool ${pool.name}`, outcome: "success" });
  }
  return NextResponse.json({ sync: state });
}
