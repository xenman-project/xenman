import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME } from "@/lib/auth";
import { auditRequest } from "@/lib/audit";

export async function POST(request: NextRequest) {
  // Read the actor before the cookie is cleared.
  auditRequest(request, {
    category: "auth",
    action: "logout",
    outcome: "success",
  });

  const isHttps =
    request.headers.get("x-forwarded-proto") === "https" ||
    request.nextUrl.protocol === "https:";

  const response = NextResponse.json({ success: true });
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
