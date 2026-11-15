import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import {
  checkUserTotp,
  confirmTotpSetup,
  passwordMatches,
  regenerateRecoveryCodes,
  removeTotp,
  startTotpSetup,
  totpState,
} from "@/lib/auth";
import { auditRequest, clientIp } from "@/lib/audit";
import { loginBlocked, loginFailed, waitText } from "@/lib/login-guard";
import { groupedSecret, otpauthUri } from "@/lib/totp";
import { qrSvg } from "@/lib/totp-qr";

/**
 * A user's own two-factor sign-in (Settings > Account, and /setup-2fa when the
 * policy requires it): its state, setting it up with a QR code and a code from
 * the app, new recovery codes, switching it off. Reachable with a session that
 * has to set it up first; not with one that has to change its password first.
 */
export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (auth.pwc) return NextResponse.json({ error: "Password change required" }, { status: 403 });
  const state = totpState(auth.sub);
  if (!state) return NextResponse.json({ error: "User not found" }, { status: 404 });
  return NextResponse.json(state);
}

export async function POST(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (auth.pwc) return NextResponse.json({ error: "Password change required" }, { status: 403 });
  const user = auth.sub;
  const body = await request.json().catch(() => ({}));
  const action = body.action;
  const ip = clientIp(request);

  // Wrong codes and passwords here count like wrong sign-ins: a stolen session
  // must not be a way to guess them.
  const wait = loginBlocked(ip, user);
  if (wait > 0 && action !== "start") {
    return NextResponse.json({ error: `Too many failed attempts. Try again in ${waitText(wait)}.` }, { status: 429 });
  }
  const wrong = (detail: string, error: string) => {
    auditRequest(request, { category: "auth", action: action === "confirm" ? "totp_enabled" : action === "disable" ? "totp_disabled" : "recovery_codes_regenerated", outcome: "failure", detail });
    loginFailed(ip, user);
    return NextResponse.json({ error }, { status: 400 });
  };

  if (action === "start") {
    const r = startTotpSetup(user);
    if (!r.success || !r.secret) return NextResponse.json({ error: r.error }, { status: 409 });
    const uri = otpauthUri(user, r.secret);
    return NextResponse.json({ secret: groupedSecret(r.secret), uri, qrSvg: qrSvg(uri) });
  }

  if (action === "confirm") {
    const r = confirmTotpSetup(user, String(body.code ?? ""));
    if (!r.success) return wrong("Wrong code while setting up", r.error ?? "The code is not right.");
    auditRequest(request, { category: "auth", action: "totp_enabled", outcome: "success" });
    return NextResponse.json({ recoveryCodes: r.recoveryCodes });
  }

  if (action === "regenerate") {
    if (!checkUserTotp(user, String(body.code ?? ""))) return wrong("Wrong code", "The code is not right.");
    const r = regenerateRecoveryCodes(user);
    if (!r.success) return NextResponse.json({ error: r.error }, { status: 409 });
    auditRequest(request, { category: "auth", action: "recovery_codes_regenerated", outcome: "success" });
    return NextResponse.json({ recoveryCodes: r.recoveryCodes });
  }

  if (action === "disable") {
    const state = totpState(user);
    if (!state?.enabled) return NextResponse.json({ error: "Two-factor sign-in is not on" }, { status: 409 });
    if (state.required) {
      return NextResponse.json({ error: "Two-factor sign-in is required for your account (Settings > Security)." }, { status: 403 });
    }
    if (!passwordMatches(user, String(body.password ?? ""))) return wrong("Wrong password", "The password is not right.");
    if (!checkUserTotp(user, String(body.code ?? ""))) return wrong("Wrong code", "The code is not right.");
    removeTotp(user);
    auditRequest(request, { category: "auth", action: "totp_disabled", outcome: "success" });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
