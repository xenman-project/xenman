import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { accessibleHosts } from "@/lib/pool-access";
import { cachedPoolUpdates } from "@/lib/xen-updates";
import { listJobs } from "@/lib/xen-update-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per pool the user may see: how many hosts lack updates, how many of those
 * are high severity, and whether a host waits for a restart. For the sidebar
 * and the dashboard; answered from a cache of up to 15 minutes, so polling it
 * is cheap.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin", "operator", "viewer");
  if (auth.error) return auth.error;
  const pools = await Promise.all(
    accessibleHosts(auth.payload).map(async (h) => {
      try {
        const u = await cachedPoolUpdates(h.id);
        return {
          hostId: h.id,
          // For the dashboard card: which pool, how big, on what, checked when.
          name: u.pool.name || h.name,
          hosts: u.hosts.length,
          versions: [...new Set(u.hosts.map((x) => x.version).filter(Boolean))],
          lastSync: u.pool.lastSync,
          hostsBehind: u.hosts.filter((x) => x.updates.length > 0).length,
          updates: u.updates.length,
          high: u.updates.filter((x) => x.severity === "High").length,
          restartPending: u.hosts.some((x) => x.pending.length > 0),
          jobRunning: listJobs(h.id).some((j) => j.state === "running"),
        };
      } catch {
        return {
          hostId: h.id,
          name: h.name,
          hosts: 0,
          versions: [],
          lastSync: null,
          hostsBehind: 0,
          updates: 0,
          high: 0,
          restartPending: false,
          jobRunning: listJobs(h.id).some((j) => j.state === "running"),
          unknown: true,
        };
      }
    }),
  );
  return NextResponse.json({ pools });
}
