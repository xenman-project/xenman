import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const payload = authenticateRequest(request);
  if (!payload) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json({
    username: payload.sub,
    role: payload.role,
  });
}
