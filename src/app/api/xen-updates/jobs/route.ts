import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { audit, auditRequest } from "@/lib/audit";
import { mayAccessHost } from "@/lib/pool-access";
import { loadHostsFromDisk } from "@/lib/host-storage";
import { friendlyXapiError } from "@/lib/xen-updates";
import { mailStatus } from "@/lib/os-alerts";
import { mailBaseUrl } from "@/lib/public-url";
import { getJob, listJobs, planJob, requestStop, startJob, type JobOptions } from "@/lib/xen-update-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ?id=<job> for one job, ?hostId=<pool> for the latest of a pool. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin", "operator", "viewer");
  if (auth.error) return auth.error;
  const params = request.nextUrl.searchParams;
  const id = params.get("id");
  if (id) {
    const job = getJob(id);
    if (!job || !mayAccessHost(auth.payload, job.hostId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ job });
  }
  const hostId = params.get("hostId") || "";
  if (!mayAccessHost(auth.payload, hostId)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  return NextResponse.json({ jobs: listJobs(hostId).slice(0, 5) });
}

/**
 * { hostId, target: "pool" | <host ref>, automatic, moveVmsBack, dryRun? }
 * With dryRun: the plan and what stands in its way, nothing changed.
 * Without: checks again and starts.
 * { action: "stop", id }: asks a running job to stop at the next safe point.
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
  if (body.action === "stop") {
    const job = typeof body.id === "string" ? getJob(body.id) : null;
    if (!job || !mayAccessHost(auth.payload, job.hostId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const stopping = requestStop(job.id, auth.payload.sub);
    if (!stopping) return NextResponse.json({ error: "This update is not running" }, { status: 409 });
    auditRequest(request, { category: "pool", action: "xen_update_stop_requested", target: `pool ${job.poolName}`, outcome: "success" });
    return NextResponse.json({ job: stopping });
  }
  const hostId = typeof body.hostId === "string" ? body.hostId : "";
  const target = body.target === "pool" ? "pool" : typeof body.target === "string" && /^OpaqueRef:[\w-]+$/.test(body.target) ? body.target : null;
  if (!target) return NextResponse.json({ error: "Invalid target" }, { status: 400 });
  if (!mayAccessHost(auth.payload, hostId)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  const pool = loadHostsFromDisk().find((h) => h.id === hostId);
  if (!pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
  const options: JobOptions = {
    automatic: body.automatic !== false,
    moveVmsBack: body.moveVmsBack !== false,
    // Off unless asked for, as in XenCenter: VMs move only when a host restarts.
    evacuateAlways: body.evacuateAlways === true,
    // Off unless chosen: VMs with a vGPU are live-migrated as XenCenter does
    // (one that fails is restarted instead, never tried live again).
    vgpuShutdown: body.vgpuShutdown === true,
    // Off unless asked for: each such VM goes down briefly.
    noToolsRestart: body.noToolsRestart === true,
    // On unless switched off: one failing host does not end the whole pool's update.
    skipFailingHosts: body.skipFailingHosts !== false,
    mail: body.mail !== false,
  };

  try {
    if (body.dryRun === true) {
      const p = await planJob(hostId, target, options);
      return NextResponse.json({
        plan: {
          hosts: p.hosts,
          finalSteps: p.finalSteps,
          blockers: p.blockers,
          warnings: p.warnings,
          hash: p.hash,
          poolName: p.poolName,
          vgpuVms: p.vgpuVms,
          noToolsVms: p.noToolsVms,
          // Whether a mail at the end can reach anyone.
          mail: mailStatus(),
        },
      });
    }
    const by = auth.payload.sub;
    const result = await startJob(
      hostId,
      target,
      options,
      by,
      (action, outcome, what, detail) =>
        audit({ actor: by, role: auth.payload.role, ip: "-", category: "pool", action, target: what, outcome, ...(detail ? { detail } : {}) }),
      // For the link in the mail at the end: the set address, or where this admin is.
      `${mailBaseUrl(request)}/`,
    );
    if (result.blockers) {
      auditRequest(request, { category: "pool", action: "xen_update_requested", target: `pool ${pool.name}`, outcome: "failure", detail: result.blockers.join(" ") });
      return NextResponse.json({ error: "The update cannot start", blockers: result.blockers }, { status: 409 });
    }
    auditRequest(request, {
      category: "pool",
      action: "xen_update_requested",
      target: target === "pool" ? `pool ${pool.name}` : `host ${result.job!.steps[0]?.hostName ?? target}`,
      outcome: "success",
      detail: `restarts ${options.automatic ? "automatic" : "by hand"}, VMs away first: ${options.evacuateAlways ? "always" : "when needed"}, VMs back: ${options.moveVmsBack ? "yes" : "no"}, vGPU VMs: ${options.vgpuShutdown ? "shut down" : "migrated"}, mail at the end: ${options.mail ? "yes" : "no"}`,
    });
    return NextResponse.json({ job: result.job });
  } catch (err) {
    return NextResponse.json({ error: friendlyXapiError(err) }, { status: 502 });
  }
}
