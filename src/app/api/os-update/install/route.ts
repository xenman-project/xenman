import { NextRequest } from "next/server";
import { postOsRequest } from "@/lib/os-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Installs pending security updates now, whatever the policy's window says. */
export async function POST(request: NextRequest) {
  return postOsRequest(request, "install-now", {
    action: "os_install_requested",
    target: "security updates",
  });
}
