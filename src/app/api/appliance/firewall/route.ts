import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { clientIp } from "@/lib/audit";
import { isAppliance } from "@/lib/appliance-update";
import {
  allowedBy,
  confirmFirewall,
  describeFirewall,
  parseFirewallInput,
  readFirewall,
  rememberFirewallToken,
} from "@/lib/appliance-firewall";
import { postOsRequest } from "@/lib/os-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The access rules, how a change is going, and where this browser comes from -- allowed or not. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  if (!isAppliance()) return NextResponse.json({ appliance: false });
  const { config, state } = readFirewall();
  const from = clientIp(request);
  return NextResponse.json({ appliance: true, config, state, client: { address: from, allowed: allowedBy(from, config.allow) } });
}

/**
 * { enabled, allow, sshAllow } applies new rules as root, on probation: unless
 * the token returned here comes back with { action: "confirm", token } --
 * through an address the new rules allow -- the previous rules return.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!isAppliance()) return NextResponse.json({ error: "Only available on the appliance" }, { status: 404 });

  if (body.action === "confirm") {
    const result = confirmFirewall(body.token);
    if (result === "invalid") return NextResponse.json({ error: "Invalid confirmation" }, { status: 400 });
    if (result === "nothing-pending") return NextResponse.json({ error: "No change is waiting for confirmation" }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  const parsed = parseFirewallInput(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const confirmToken = crypto.randomBytes(24).toString("hex");
  rememberFirewallToken(confirmToken);
  return postOsRequest(
    request,
    "set-firewall",
    { action: "os_firewall_requested", target: describeFirewall(parsed.firewall) },
    { firewall: parsed.firewall, confirmToken },
    { confirmToken },
  );
}
