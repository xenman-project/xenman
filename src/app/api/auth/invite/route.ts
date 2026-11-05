import { NextRequest, NextResponse } from "next/server";
import { getInviteUser, acceptInvite, validatePassword } from "@/lib/auth";
import { auditRequest } from "@/lib/audit";

// GET — validate token and return user info
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }

  const user = getInviteUser(token);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid or expired invitation link" },
      { status: 400 },
    );
  }

  return NextResponse.json({ username: user.username });
}

// POST — accept invitation and set password
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
    const target = getInviteUser(token);

    const result = acceptInvite(token, password);
    if (!result.success) {
      auditRequest(request, {
        actor: target?.username ?? "-",
        role: "-",
        category: "user",
        action: "invite_accepted",
        outcome: "failure",
        detail: result.error,
      });
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    auditRequest(request, {
      actor: target?.username ?? "-",
      role: "-",
      category: "user",
      action: "invite_accepted",
      outcome: "success",
      detail: "Account activated, password set",
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
