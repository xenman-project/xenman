import { NextRequest, NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit";
import { setAuthCookie } from "@/lib/auth-cookie";
import { authenticateRequest } from "@/lib/api-auth";
import { endLoginSession } from "@/lib/login-sessions";

export async function POST(request: NextRequest) {
  // Read the actor before the cookie is cleared.
  auditRequest(request, {
    category: "auth",
    action: "logout",
    outcome: "success",
  });

  // Ended here, not only forgotten by this browser: a copy of the cookie is worthless after.
  endLoginSession(authenticateRequest(request)?.sid);

  const response = NextResponse.json({ success: true });
  setAuthCookie(request, response, "", 0);
  return response;
}
