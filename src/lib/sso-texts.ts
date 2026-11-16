// What the sign-in page says when signing in with Microsoft Entra ID did not
// work: /api/auth/sso/callback sends the browser back with ?sso=<code>.
// Kept apart from lib/entra-oidc.ts, which only runs on the server.

export type SsoErrorCode = "off" | "state" | "denied" | "unreachable" | "token" | "invalid" | "norole" | "taken" | "blocked";

export const SSO_ERROR_TEXTS: Record<SsoErrorCode, string> = {
  off: "Signing in with Microsoft is not set up.",
  state: "The sign-in with Microsoft took too long or was started elsewhere. Try again.",
  denied: "Microsoft did not sign you in.",
  unreachable: "XenMan could not reach Microsoft's sign-in service.",
  token: "Microsoft did not confirm the sign-in. An administrator can check the client secret and redirect URI in the settings.",
  invalid: "The answer from Microsoft could not be verified.",
  norole: "Your account has no XenMan role in Entra ID. Ask an administrator to assign one.",
  taken: "A XenMan account with your name already exists that does not sign in with Entra ID. Ask an administrator.",
  blocked: "Too many failed sign-ins from this address. Try again later.",
};

export function ssoErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  return (SSO_ERROR_TEXTS as Record<string, string>)[code] ?? SSO_ERROR_TEXTS.denied;
}
