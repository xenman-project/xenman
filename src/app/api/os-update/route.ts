import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { isAppliance } from "@/lib/appliance-update";
import {
  bootInfo,
  installLogExists,
  listsUpdatedAt,
  nextRun,
  pendingSecurityPackages,
  readOsStatus,
  readPolicy,
  readRequestResult,
  readProxyInfo,
  rebootInfo,
  requestPending,
} from "@/lib/os-update";

// apt-get and systemctl rule out the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  if (!isAppliance()) return NextResponse.json({ appliance: false });

  const [pending, next] = await Promise.all([pendingSecurityPackages(), nextRun()]);
  return NextResponse.json({
    appliance: true,
    policy: readPolicy(),
    proxy: readProxyInfo(),
    status: readOsStatus(),
    pending,
    listsUpdatedAt: listsUpdatedAt(),
    installLog: installLogExists(),
    reboot: rebootInfo(),
    boot: bootInfo(),
    nextRun: next,
    request: readRequestResult(),
    requestPending: requestPending(),
  });
}
