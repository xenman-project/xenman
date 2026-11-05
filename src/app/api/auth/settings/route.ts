import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import { getUserSettings, updateUserSettings } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const payload = authenticateRequest(request);
  if (!payload) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const settings = getUserSettings(payload.sub);
  return NextResponse.json(settings);
}

export async function PATCH(request: NextRequest) {
  const payload = authenticateRequest(request);
  if (!payload) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  if (typeof body.autoRefresh === "boolean") patch.autoRefresh = body.autoRefresh;

  const result = updateUserSettings(payload.sub, patch);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
