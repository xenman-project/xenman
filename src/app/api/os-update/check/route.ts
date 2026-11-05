import { NextRequest } from "next/server";
import { postOsRequest } from "@/lib/os-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refreshes the package lists now instead of waiting for apt's daily run. */
export async function POST(request: NextRequest) {
  return postOsRequest(request, "check", {
    action: "os_update_check_requested",
    target: "package lists",
  });
}
