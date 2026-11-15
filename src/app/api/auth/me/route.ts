import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import { totpState } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const payload = authenticateRequest(request);
  if (!payload) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const totp = totpState(payload.sub);
  return NextResponse.json({
    username: payload.sub,
    role: payload.role,
    totpEnabled: Boolean(totp?.enabled),
    ...(payload.tfe ? { mustSetUpTotp: true } : {}),
  });
}
