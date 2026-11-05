import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { isGraphKind, parseGraphs, readGraphs, saveGraphs } from "@/lib/perf-graphs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The performance graphs of VMs, hosts and pools, the same for everyone. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin", "operator", "viewer");
  if (auth.error) return auth.error;
  return NextResponse.json({ graphs: readGraphs() });
}

/** { kind, graphs } replaces one kind's graphs; { kind, reset: true } puts them back to the defaults. */
export async function PUT(request: NextRequest) {
  const auth = requireRole(request, "admin", "operator");
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const kind = body.kind;
  if (!isGraphKind(kind)) return NextResponse.json({ error: "kind must be vm, host or pool" }, { status: 400 });
  const what = kind === "vm" ? "VMs" : kind === "host" ? "hosts" : "pools";

  if (body.reset === true) {
    saveGraphs(kind, null);
    auditRequest(request, { category: "config", action: "perf_graphs_saved", target: `graphs of ${what}`, outcome: "success", detail: "back to the defaults" });
    return NextResponse.json({ graphs: readGraphs() });
  }

  const parsed = parseGraphs(kind, body.graphs);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  saveGraphs(kind, parsed.graphs);
  const shown = parsed.graphs.filter((g) => !g.hidden);
  auditRequest(request, {
    category: "config",
    action: "perf_graphs_saved",
    target: `graphs of ${what}`,
    outcome: "success",
    detail: `shown: ${shown.map((g) => g.name ?? g.builtin).join(", ") || "none"}`,
  });
  return NextResponse.json({ graphs: readGraphs() });
}
