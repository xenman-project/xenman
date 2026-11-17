import { NextRequest, NextResponse } from "next/server";
import { verifyToken, COOKIE_NAME, type TokenPayload, type UserRole } from "@/lib/auth";
import { CROSS_SITE_ERROR, crossSiteRequest } from "@/lib/request-origin";

export function authenticateRequest(request: NextRequest): TokenPayload | null {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyToken(token);
}

export function requireRole(
  request: NextRequest,
  ...allowedRoles: UserRole[]
):
  | { payload: TokenPayload; error?: undefined }
  | { error: NextResponse; payload?: undefined } {
  // proxy.ts refuses these too; repeated for the routes it leaves out (/api/update, /api/xen/import).
  if (crossSiteRequest(request)) {
    return { error: NextResponse.json({ error: CROSS_SITE_ERROR }, { status: 403 }) };
  }
  const payload = authenticateRequest(request);
  if (!payload) {
    return {
      error: NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 },
      ),
    };
  }
  // proxy.ts checks this too; repeated for the routes it leaves out (/api/update).
  if (payload.pwc) {
    return {
      error: NextResponse.json(
        { error: "Password change required" },
        { status: 403 },
      ),
    };
  }
  if (payload.tfe) {
    return {
      error: NextResponse.json(
        { error: "Two-factor sign-in has to be set up first" },
        { status: 403 },
      ),
    };
  }
  if (!allowedRoles.includes(payload.role)) {
    return {
      error: NextResponse.json(
        { error: "Insufficient permissions" },
        { status: 403 },
      ),
    };
  }
  return { payload };
}
