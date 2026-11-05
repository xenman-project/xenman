import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { isAppliance } from "@/lib/appliance-update";
import { MAX_NTP_SERVERS, parseTimeInput, timeInfo } from "@/lib/appliance-time";
import { postOsRequest } from "@/lib/os-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  if (!isAppliance()) return NextResponse.json({ appliance: false });
  return NextResponse.json({ appliance: true, maxServers: MAX_NTP_SERVERS, ...(await timeInfo()) });
}

/** Time zone and NTP servers; carried out as root by xenman-os-request. */
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
  const parsed = parseTimeInput(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const t = parsed.time;
  const target = [
    t.timezone,
    t.ntpServers && (t.ntpServers.length ? `NTP ${t.ntpServers.join(", ")}` : "NTP defaults"),
  ]
    .filter(Boolean)
    .join("; ");
  return postOsRequest(request, "set-time", { action: "os_time_requested", target }, { time: t });
}
