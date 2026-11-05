import { NextRequest, NextResponse } from "next/server";
import { getResetUser, acceptResetToken, validatePassword } from "@/lib/auth";
import { auditRequest } from "@/lib/audit";

// GET — validate token and return user info
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }

  const user = getResetUser(token);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid or expired reset link" },
      { status: 400 },
    );
  }

  return NextResponse.json({ username: user.username });
}

// POST — accept reset token and set new password
export async function POST(request: NextRequest) {
  try {
    const { token, password } = await request.json();
    if (!token || !password) {
      return NextResponse.json(
        { error: "Token and password are required" },
        { status: 400 },
      );
    }

    const pwError = validatePassword(password);
    if (pwError) {
      return NextResponse.json({ error: pwError }, { status: 400 });
    }

    // Resolve the account before the token is consumed, so the entry can name it.
    const target = getResetUser(token);

    const result = acceptResetToken(token, password);
    if (!result.success) {
      auditRequest(request, {
        actor: target?.username ?? "-",
        role: "-",
        category: "auth",
        action: "password_reset_completed",
        outcome: "failure",
        detail: result.error,
      });
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    auditRequest(request, {
      actor: target?.username ?? "-",
      role: "-",
      category: "auth",
      action: "password_reset_completed",
      outcome: "success",
      detail: "New password set via reset link",
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
