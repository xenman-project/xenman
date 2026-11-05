import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { parsePolicyInput } from "@/lib/os-update";
import { postOsRequest } from "@/lib/os-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const parsed = parsePolicyInput(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const p = parsed.policy;
  const target =
    p.mode === "manual"
      ? "manual"
      : [p.mode, p.days?.join(","), p.time, p.timezone].filter(Boolean).join(" ");
  return postOsRequest(
    request,
    "set-policy",
    { action: "os_update_policy_requested", target: target || "policy" },
    { policy: p },
  );
}
