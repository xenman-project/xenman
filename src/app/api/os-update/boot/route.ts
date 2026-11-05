import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { isAppliance } from "@/lib/appliance-update";
import { bootInfo, readRequestResult } from "@/lib/os-update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the restart page polls every two seconds: cheap on purpose -- no apt,
 * no systemctl -- so it answers as soon as XenMan is up again.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  if (!isAppliance()) return NextResponse.json({ appliance: false });

  return NextResponse.json({ appliance: true, ...bootInfo(), request: readRequestResult() });
}
