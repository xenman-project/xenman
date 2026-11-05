import { NextRequest } from "next/server";
import { postOsRequest } from "@/lib/os-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Restarts the appliance. Only this management VM goes down for a minute; the
 * pools it manages and their VMs are not affected.
 */
export async function POST(request: NextRequest) {
  return postOsRequest(request, "reboot", {
    action: "os_restart_requested",
    target: "appliance",
  });
}
