import { NextRequest, NextResponse } from "next/server";
import { checkUserTotp, getUserRole, signToken, totpState, consumeRecoveryCode } from "@/lib/auth";
import { SESSION_SECONDS, setAuthCookie, viaHttps } from "@/lib/auth-cookie";
import { startLoginSession } from "@/lib/login-sessions";
import { auditRequest, clientIp } from "@/lib/audit";
import { loginBlocked, loginFailed, loginSucceeded, waitText } from "@/lib/login-guard";
import { PENDING_COOKIE, pendingDone, pendingFailed, readPending } from "@/lib/login-pending";

/**
 * The second step of signing in: the code from the authenticator app, or a
 * recovery code, after the password was right (api/auth/login). Only then a
 * session. Wrong codes count like wrong passwords (lib/login-guard.ts), and
 * five of them on one password send the user back to the password.
 */
export async function POST(request: NextRequest) {
  const restart = (error: string) => {
    const response = NextResponse.json({ error, restart: true }, { status: 401 });
    setAuthCookie(request, response, "", 0, PENDING_COOKIE);
    return response;
  };
  try {
    const pending = readPending(request.cookies.get(PENDING_COOKIE)?.value);
    if (!pending) return restart("Sign in again: the time for the code ran out.");
    const state = totpState(pending.sub);
    const role = getUserRole(pending.sub);
    if (!state?.enabled || !role) return restart("Sign in again.");

    const ip = clientIp(request);
    const wait = loginBlocked(ip, pending.sub);
    if (wait > 0) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${waitText(wait)}.` },
        { status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } },
      );
    }

    const body = await request.json().catch(() => ({}));
    const recovery = typeof body.recoveryCode === "string" && body.recoveryCode.trim() !== "";
    let recoveryLeft: number | null = null;
    const ok = recovery
      ? (recoveryLeft = consumeRecoveryCode(pending.sub, body.recoveryCode)) !== null
      : typeof body.code === "string" && checkUserTotp(pending.sub, body.code);

    if (!ok) {
      auditRequest(request, {
        actor: pending.sub,
        role,
        category: "auth",
        action: "login_totp",
        outcome: "failure",
        detail: recovery ? "Wrong recovery code" : "Wrong code",
      });
      const last = pendingFailed(pending.jti);
      const blocked = loginFailed(ip, pending.sub);
      if (blocked) {
        auditRequest(request, {
          actor: pending.sub,
          role,
          category: "auth",
          action: "login_blocked",
          outcome: "denied",
          detail: `Too many failed sign-ins for this user from ${ip}; blocked for ${waitText(loginBlocked(ip, pending.sub))}`,
        });
        const response = NextResponse.json(
          { error: `Too many failed attempts. Try again in ${waitText(loginBlocked(ip, pending.sub))}.`, restart: true },
          { status: 429 },
        );
        setAuthCookie(request, response, "", 0, PENDING_COOKIE);
        return response;
      }
      if (last) return restart("Too many wrong codes. Sign in again.");
      return NextResponse.json({ error: recovery ? "That recovery code is not right, or was used already." : "The code is not right." }, { status: 401 });
    }

    pendingDone(pending.jti);
    loginSucceeded(ip, pending.sub);
    const token = signToken(pending.sub, role, startLoginSession(pending.sub, SESSION_SECONDS), pending.pwc);
    const response = NextResponse.json({
      success: true,
      username: pending.sub,
      role,
      mustChangePassword: pending.pwc,
      ...(recoveryLeft !== null ? { recoveryLeft } : {}),
    });
    setAuthCookie(request, response, token);
    setAuthCookie(request, response, "", 0, PENDING_COOKIE);
    auditRequest(request, {
      actor: pending.sub,
      role,
      category: "auth",
      action: "login",
      outcome: "success",
      detail:
        `${viaHttps(request) ? "via HTTPS" : "via HTTP"}, ` +
        (recoveryLeft !== null ? `with a recovery code (${recoveryLeft} left)` : "with two-factor code") +
        (pending.pwc ? ", default password: change required" : ""),
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
