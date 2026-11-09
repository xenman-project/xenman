import { NextRequest, NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit";
import { setAuthCookie } from "@/lib/auth-cookie";

export async function POST(request: NextRequest) {
  // Read the actor before the cookie is cleared.
  auditRequest(request, {
    category: "auth",
    action: "logout",
    outcome: "success",
  });

  const response = NextResponse.json({ success: true });
  setAuthCookie(request, response, "", 0);
  return response;
}
