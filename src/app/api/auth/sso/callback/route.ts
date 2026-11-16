import { NextRequest, NextResponse } from "next/server";
import { signToken, upsertSsoUser } from "@/lib/auth";
import { SESSION_SECONDS, setAuthCookie } from "@/lib/auth-cookie";
import { auditRequest, clientIp } from "@/lib/audit";
import { exchangeCode, FLOW_COOKIE, readFlow, roleFromClaims, SsoError, verifyIdToken } from "@/lib/entra-oidc";
import { loginBlocked, loginFailed, loginSucceeded } from "@/lib/login-guard";
import { startLoginSession } from "@/lib/login-sessions";
import { readSsoConfig, ssoActive } from "@/lib/sso-config";
import type { SsoErrorCode } from "@/lib/sso-texts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For the login guard: Entra sign-ins of no known name count under this one. */
const ANONYMOUS = "(Microsoft Entra ID)";

/**
 * Where Entra ID sends the browser back. The state checked against the
 * cookie, the code traded, the ID token verified, the role taken from the app
 * roles; then a session as with a password. Anything wrong: back to the
 * sign-in page, which says what.
 */
export async function GET(request: NextRequest) {
  const config = readSsoConfig();
  if (!ssoActive(config)) return NextResponse.json({ error: "Signing in with Microsoft is not set up" }, { status: 404 });
  const ip = clientIp(request);
  const back = (path: string) => NextResponse.redirect(`${config.address}${path}`, 302);

  const fail = (code: SsoErrorCode, detail: string, actor = ANONYMOUS, count = true) => {
    auditRequest(request, { actor, role: "-", category: "auth", action: "login", outcome: "failure", detail: `via Microsoft Entra ID: ${detail}` });
    if (count) loginFailed(ip, actor);
    const response = back(`/login?sso=${code}`);
    setAuthCookie(request, response, "", 0, FLOW_COOKIE);
    return response;
  };

  if (loginBlocked(ip, ANONYMOUS) > 0) return fail("blocked", "too many failed sign-ins from this address", ANONYMOUS, false);

  const q = request.nextUrl.searchParams;
  const flow = readFlow(request.cookies.get(FLOW_COOKIE)?.value);
  if (!flow || !q.get("state") || q.get("state") !== flow.state) {
    return fail("state", flow ? "the state does not match this browser's sign-in" : "no sign-in started in this browser, or it expired");
  }
  // The user cancelled, or Entra refused (not assigned to the app, Conditional Access ...).
  const entraError = q.get("error");
  if (entraError) {
    const why = String(q.get("error_description") ?? "").split(/\r?\n/)[0];
    return fail("denied", `${entraError}${why ? `: ${why}` : ""}`, ANONYMOUS, false);
  }
  const code = q.get("code");
  if (!code) return fail("state", "no code in the answer");

  let claims;
  try {
    const idToken = await exchangeCode(config, code, flow.verifier);
    claims = await verifyIdToken(config, idToken, flow.nonce);
  } catch (err) {
    if (err instanceof SsoError) return fail(err.code, err.message, ANONYMOUS, err.code !== "unreachable");
    return fail("invalid", err instanceof Error ? err.message : String(err));
  }

  const role = roleFromClaims(claims.roles);
  if (!role) {
    return fail("norole", `no XenMan app role assigned (roles: ${claims.roles.join(", ") || "none"})`, claims.username, false);
  }
  const up = upsertSsoUser(claims, role);
  if ("taken" in up) {
    return fail("taken", `a XenMan account named ${claims.username} exists that does not sign in with Entra ID`, claims.username, false);
  }
  const user = up.user;
  if (up.created) {
    auditRequest(request, {
      actor: user.username,
      role,
      category: "user",
      action: "sso_user_created",
      target: `user "${user.username}"`,
      outcome: "success",
      detail: `first sign-in with Microsoft Entra ID, role ${role}`,
    });
  }

  loginSucceeded(ip, ANONYMOUS);
  const token = signToken(user.username, role, startLoginSession(user.username, SESSION_SECONDS));
  const response = back("/");
  setAuthCookie(request, response, token);
  setAuthCookie(request, response, "", 0, FLOW_COOKIE);
  auditRequest(request, {
    actor: user.username,
    role,
    category: "auth",
    action: "login",
    outcome: "success",
    detail: `via Microsoft Entra ID${up.roleChanged ? `, role now ${role} (from Entra ID)` : ""}`,
  });
  return response;
}
