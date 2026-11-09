import { NextRequest, NextResponse } from "next/server";
import { changePassword, signToken, validatePassword, verifyToken, COOKIE_NAME } from "@/lib/auth";
import { auditRequest } from "@/lib/audit";
import { setAuthCookie } from "@/lib/auth-cookie";
import { endUserSessions } from "@/lib/login-sessions";

export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(COOKIE_NAME)?.value;
    if (!token) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid session" }, { status: 401 });
    }

    const body = await request.json();
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: "Current and new password are required" },
        { status: 400 },
      );
    }

    const pwError = validatePassword(newPassword);
    if (pwError) {
      return NextResponse.json({ error: pwError }, { status: 400 });
    }

    const result = changePassword(payload.sub, currentPassword, newPassword);
    if (!result.success) {
      auditRequest(request, {
        category: "auth",
        action: "change_password",
        outcome: "failure",
        detail: result.error,
      });
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // A new password ends every other sign-in of this account: someone who
    // knew the old one, or holds a copied session, is out.
    const ended = endUserSessions(payload.sub, payload.sid);
    auditRequest(request, {
      category: "auth",
      action: "change_password",
      outcome: "success",
      detail: (payload.pwc ? "Default password replaced" : "Own password changed") + (ended ? `, ${ended} other sign-in(s) ended` : ""),
    });

    const response = NextResponse.json({ success: true });
    if (payload.pwc) {
      // A session without the restriction: the rest of XenMan opens up.
      setAuthCookie(request, response, signToken(payload.sub, payload.role, payload.sid));
    }
    return response;
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
