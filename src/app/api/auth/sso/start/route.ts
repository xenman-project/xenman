import { NextRequest, NextResponse } from "next/server";
import { setAuthCookie } from "@/lib/auth-cookie";
import { authorizeUrl, FLOW_COOKIE, FLOW_SECONDS, newFlow, signFlow } from "@/lib/entra-oidc";
import { readSsoConfig, ssoActive } from "@/lib/sso-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Sign in with Microsoft": off to Entra ID, with this sign-in's state, nonce and PKCE verifier in a cookie. */
export async function GET(request: NextRequest) {
  const config = readSsoConfig();
  if (!ssoActive(config)) return NextResponse.json({ error: "Signing in with Microsoft is not set up" }, { status: 404 });
  const flow = newFlow();
  const response = NextResponse.redirect(authorizeUrl(config, flow), 302);
  setAuthCookie(request, response, signFlow(flow), FLOW_SECONDS, FLOW_COOKIE);
  return response;
}
