import { NextRequest, NextResponse } from "next/server";
import {
  ensureAdminUser,
  verifyCredentials,
  signToken,
  mustChangePassword,
} from "@/lib/auth";
import { SESSION_SECONDS, setAuthCookie, viaHttps } from "@/lib/auth-cookie";
import { startLoginSession } from "@/lib/login-sessions";
import { auditRequest, clientIp } from "@/lib/audit";
import { loginBlocked, loginFailed, loginSucceeded, waitText } from "@/lib/login-guard";
import { PENDING_COOKIE, PENDING_SECONDS, signPending } from "@/lib/login-pending";
import { localSignInClosedFor } from "@/lib/sso-config";

function tooMany(waitMs: number) {
  return NextResponse.json(
    { error: `Too many failed attempts. Try again in ${waitText(waitMs)}.` },
    { status: 429, headers: { "Retry-After": String(Math.ceil(waitMs / 1000)) } },
  );
}

export async function POST(request: NextRequest) {
  try {
    ensureAdminUser();

    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password required" },
        { status: 400 },
      );
    }

    // Blocked is blocked, the right password included: otherwise guessing
    // would just go on until it hits.
    const ip = clientIp(request);
    const wait = loginBlocked(ip, String(username));
    if (wait > 0) return tooMany(wait);

    const user = verifyCredentials(username, password);
    if (!user) {
      // Record the attempted identifier, never the password.
      auditRequest(request, {
        actor: String(username),
        role: "-",
        category: "auth",
        action: "login",
        outcome: "failure",
        detail: "Invalid credentials",
      });
      const blocked = loginFailed(ip, String(username));
      if (blocked) {
        // Once, when the block begins -- not for every refused attempt after.
        auditRequest(request, {
          actor: String(username),
          role: "-",
          category: "auth",
          action: "login_blocked",
          outcome: "denied",
          detail:
            blocked === "pair"
              ? `Too many failed logins for this user from ${ip}; blocked for ${waitText(loginBlocked(ip, String(username)))}`
              : `Too many failed logins from ${ip}; this address is blocked for ${waitText(loginBlocked(ip, String(username)))}`,
        });
        return tooMany(loginBlocked(ip, String(username)));
      }
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }
    // Entra ID on, passwords for administrators only: the way in when Entra is down.
    if (localSignInClosedFor(user.role)) {
      auditRequest(request, {
        actor: user.username,
        role: user.role,
        category: "auth",
        action: "login",
        outcome: "denied",
        detail: "password sign-in is for administrators only; sign in with Microsoft",
      });
      return NextResponse.json(
        { error: "Sign in with Microsoft. Signing in with a password is for administrators only.", ssoOnly: true },
        { status: 403 },
      );
    }

    // The default password: everything else stays closed until it is changed.
    const changeFirst = mustChangePassword(user, password);

    // Two-factor sign-in: no session yet, only the step for the code
    // (api/auth/login/totp). The failures counted so far stay: a known password
    // must not reset the count while codes are guessed.
    if (user.totp) {
      const response = NextResponse.json({ totpRequired: true });
      setAuthCookie(request, response, signPending(user.username, changeFirst), PENDING_SECONDS, PENDING_COOKIE);
      return response;
    }

    loginSucceeded(ip, String(username));
    const token = signToken(user.username, user.role, startLoginSession(user.username, SESSION_SECONDS), changeFirst);

    const isHttps = viaHttps(request);

    const response = NextResponse.json({
      success: true,
      username: user.username,
      role: user.role,
      mustChangePassword: changeFirst,
    });
    setAuthCookie(request, response, token);

    auditRequest(request, {
      actor: user.username,
      role: user.role,
      category: "auth",
      action: "login",
      outcome: "success",
      detail: `${isHttps ? "via HTTPS" : "via HTTP"}${changeFirst ? ", default password: change required" : ""}`,
    });

    return response;
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
