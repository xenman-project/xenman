import { NextRequest, NextResponse } from "next/server";
import { isAppliance } from "@/lib/appliance-update";
import { writeConfirm } from "@/lib/appliance-network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Keeps a network change on probation. Public: it is called from the new
 * address, where the browser has no session yet. What it needs is the token
 * of that one change, which only the admin who made it was given.
 */
export async function POST(request: NextRequest) {
  if (!isAppliance()) return NextResponse.json({ error: "Not available" }, { status: 404 });
  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const result = writeConfirm(body?.token);
  if (result === "invalid") return NextResponse.json({ error: "Invalid confirmation link" }, { status: 400 });
  if (result === "nothing-pending") {
    return NextResponse.json({ error: "No network change is waiting for confirmation" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
