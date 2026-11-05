import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { isAppliance } from "@/lib/appliance-update";
import {
  describeNetwork,
  networkInfo,
  parseNetworkInput,
  rememberConfirmToken,
} from "@/lib/appliance-network";
import { postOsRequest } from "@/lib/os-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  if (!isAppliance()) return NextResponse.json({ appliance: false });
  return NextResponse.json({ appliance: true, ...(await networkInfo()) });
}

/**
 * New network settings, applied as root on probation: unless the token
 * returned here comes back through /api/appliance/network/confirm -- from the
 * new address, if it changed -- the previous settings return.
 */
export async function POST(request: NextRequest) {
  // Checked before the body is read, so an anonymous request costs nothing.
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = parseNetworkInput(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const confirmToken = crypto.randomBytes(24).toString("hex");
  rememberConfirmToken(confirmToken);
  return postOsRequest(
    request,
    "set-network",
    { action: "os_network_requested", target: describeNetwork(parsed.network) },
    { network: parsed.network, confirmToken },
    { confirmToken },
  );
}
