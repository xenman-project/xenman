import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The build the server runs. Pages compare it with the build they were loaded
 * from, so after an update they can say a reload brings the new version.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin", "operator", "viewer");
  if (auth.error) return auth.error;
  return NextResponse.json({ version: process.env.NEXT_PUBLIC_GIT_COMMIT ?? "" });
}
