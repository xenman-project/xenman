import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { isAppliance } from "@/lib/appliance-update";
import { readInstallLog } from "@/lib/os-update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The output of the current or last installation of security updates, read
 * on from `from` for as long as the browser follows it. `run` is the first
 * line of the log it has been reading; a different one means a new run.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  if (!isAppliance()) return NextResponse.json({ appliance: false });

  const params = request.nextUrl.searchParams;
  const raw = params.get("from");
  const from = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  return NextResponse.json(readInstallLog(from, params.get("run")));
}
