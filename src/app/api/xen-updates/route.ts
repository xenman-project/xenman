import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { audit, auditRequest } from "@/lib/audit";
import { mayAccessHost } from "@/lib/pool-access";
import { loadHostsFromDisk } from "@/lib/host-storage";
import {
  CHANNELS,
  cachedPoolUpdates,
  configureUpdates,
  friendlyXapiError,
  startSync,
  syncState,
  type ChannelKey,
  type UpdateConfigChanges,
} from "@/lib/xen-updates";
import { listJobs } from "@/lib/xen-update-jobs";

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

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

/**
 * What Configure Updates may change, checked strictly; a part left out stays
 * as it is. Returns the reason when the request is not acceptable.
 */
function parseConfig(v: unknown): UpdateConfigChanges | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "Invalid settings.";
  const c = v as Record<string, unknown>;
  const out: UpdateConfigChanges = {};
  if (c.channel !== undefined) {
    if (typeof c.channel !== "string" || !Object.hasOwn(CHANNELS, c.channel)) return "Invalid update channel.";
    out.channel = c.channel as ChannelKey;
  }
  if (c.sync !== undefined) {
    const s = c.sync as Record<string, unknown> | null;
    if (
      !s ||
      typeof s !== "object" ||
      typeof s.enabled !== "boolean" ||
      (s.frequency !== "daily" && s.frequency !== "weekly") ||
      !Number.isInteger(s.day) ||
      (s.day as number) < 0 ||
      (s.day as number) > 6
    ) {
      return "Invalid synchronization schedule.";
    }
    out.sync = { enabled: s.enabled, frequency: s.frequency, day: s.day as number };
  }
  if (c.proxy !== undefined) {
    const p = c.proxy as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return "Invalid proxy settings.";
    const url = str(p.url, 2048);
    const username = str(p.username ?? "", 256);
    const password = p.password === undefined ? undefined : str(p.password, 256);
    if (url === null || username === null || password === null) return "Invalid proxy settings.";
    if (url.trim() && !/^https?:\/\/[^\s/?#]+/i.test(url.trim())) return "The proxy URL must start with http:// or https://.";
    out.proxy = { url, username, ...(password !== undefined ? { password } : {}) };
  }
  return out;
}

/**
 * { hostId, action: "sync" }: fetch the update channel's current metadata.
 * { hostId, action: "configure", config }: Configure Updates (channel,
 * automatic synchronization, proxy), as XenCenter does.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: { hostId?: unknown; action?: unknown; config?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const hostId = typeof body.hostId === "string" ? body.hostId : "";
  if (body.action !== "sync" && body.action !== "configure") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  if (!mayAccessHost(auth.payload, hostId)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  const pool = loadHostsFromDisk().find((h) => h.id === hostId);
  if (!pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });

  if (body.action === "configure") {
    const changes = parseConfig(body.config);
    if (typeof changes === "string") return NextResponse.json({ error: changes }, { status: 400 });
    if (listJobs(hostId).some((j) => j.state === "running")) {
      return NextResponse.json({ error: "An update is in progress on this pool." }, { status: 409 });
    }
    if (syncState(hostId)?.state === "running") {
      return NextResponse.json({ error: "Synchronization with the update channel is in progress. Try again later." }, { status: 409 });
    }
    try {
      const done = await configureUpdates(hostId, changes);
      if (done.length) {
        auditRequest(request, { category: "pool", action: "xen_updates_configured", target: `pool ${pool.name}`, outcome: "success", detail: done.join(", ") });
      }
      return NextResponse.json({ changed: done, channelChanged: done.some((d) => d.startsWith("channel:")) });
    } catch (err) {
      const error = friendlyXapiError(err);
      auditRequest(request, { category: "pool", action: "xen_updates_configured", target: `pool ${pool.name}`, outcome: "failure", detail: error });
      return NextResponse.json({ error }, { status: 502 });
    }
  }

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
