import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { isAppliance } from "@/lib/appliance-update";
import { healthReport } from "@/lib/appliance-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Uptime, load, memory, disk and the certificate's expiry, with what needs attention. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  return NextResponse.json({ appliance: isAppliance(), ...(await healthReport()) });
}
