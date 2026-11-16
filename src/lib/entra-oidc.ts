// Signing in with Microsoft Entra ID: OpenID Connect's authorization code flow
// with PKCE, as Microsoft describes it for web apps.
//
// /api/auth/sso/start sends the browser to Entra with a fresh state, nonce and
// PKCE challenge, kept in a signed cookie of its own for ten minutes. Entra
// sends it back to /api/auth/sso/callback with a code; XenMan trades the code
// for tokens with its client secret and checks the ID token itself: signed by
// one of the tenant's keys (RS256), issued by the tenant for this app, not
// expired, and carrying the nonce. The role comes from the app roles Entra
// assigned (XenMan.Admin, XenMan.Operator, XenMan.Viewer); none, no way in.

import crypto from "crypto";
import jwt from "jsonwebtoken";
import { ensureJwtSecret, type UserRole } from "./auth";
import { clientSecretOf, entraAuthority, ssoRedirectUri, type SsoConfig } from "./sso-config";
import type { SsoErrorCode } from "./sso-texts";

export const FLOW_COOKIE = "xenman-sso";
export const FLOW_SECONDS = 10 * 60;
const HTTP_TIMEOUT_MS = 15_000;
/** Clocks a little apart: XenMan's and Microsoft's. */
const CLOCK_TOLERANCE_S = 120;

/** What went wrong, as a code for the sign-in page, and what for the audit log. */
export class SsoError extends Error {
  constructor(
    readonly code: SsoErrorCode,
    detail: string,
  ) {
    super(detail);
  }
}


// --- The flow cookie ---

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function newFlow(): Flow {
  return { state: b64url(crypto.randomBytes(24)), nonce: b64url(crypto.randomBytes(24)), verifier: b64url(crypto.randomBytes(48)) };
}

export function signFlow(flow: Flow): string {
  const secret = process.env.JWT_SECRET || ensureJwtSecret();
  return jwt.sign({ purpose: "sso", ...flow }, secret, { algorithm: "HS256", expiresIn: FLOW_SECONDS });
}

export function readFlow(token: string | undefined): Flow | null {
  if (!token) return null;
  try {
    const secret = process.env.JWT_SECRET || ensureJwtSecret();
    const p = jwt.verify(token, secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    if (p.purpose !== "sso" || typeof p.state !== "string" || typeof p.nonce !== "string" || typeof p.verifier !== "string") return null;
    return { state: p.state, nonce: p.nonce, verifier: p.verifier };
  } catch {
    return null;
  }
}

// --- To Entra and back ---

export function authorizeUrl(config: SsoConfig, flow: Flow): string {
  const q = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: ssoRedirectUri(config.address),
    response_mode: "query",
    scope: "openid profile email",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: b64url(crypto.createHash("sha256").update(flow.verifier).digest()),
    code_challenge_method: "S256",
  });
  return `${entraAuthority()}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize?${q}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });
  } catch (err) {
    throw new SsoError("unreachable", `${new URL(url).host} not reachable: ${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : err}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** The code traded for the ID token. */
export async function exchangeCode(config: SsoConfig, code: string, verifier: string): Promise<string> {
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: clientSecretOf(config),
    grant_type: "authorization_code",
    code,
    redirect_uri: ssoRedirectUri(config.address),
    code_verifier: verifier,
    scope: "openid profile email",
  });
  const { status, body } = await fetchJson(`${entraAuthority()}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (status !== 200 || typeof body.id_token !== "string") {
    // Entra's error and its first line (AADSTS...), never the secret.
    const why = [body.error, String(body.error_description ?? "").split(/\r?\n/)[0]].filter(Boolean).join(": ");
    throw new SsoError("token", `token endpoint answered ${status}${why ? ` (${why})` : ""}`);
  }
  return body.id_token;
}

// --- The tenant's signing keys ---

type Jwk = crypto.JsonWebKey & { kid?: string; kty?: string; use?: string };
const g = globalThis as typeof globalThis & { _xenmanEntraKeys?: Map<string, { keys: Jwk[]; at: number }> };
const keyCache = (g._xenmanEntraKeys ??= new Map());
const KEYS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A key not known yet is looked for again, but not more often than this. */
const KEYS_REFETCH_MS = 60 * 1000;

async function tenantKeys(tenantId: string, refresh: boolean): Promise<Jwk[]> {
  const cached = keyCache.get(tenantId);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < KEYS_MAX_AGE_MS && !(refresh && age > KEYS_REFETCH_MS)) return cached.keys;
  const { status, body } = await fetchJson(`${entraAuthority()}/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`);
  if (status !== 200 || !Array.isArray(body.keys)) {
    if (cached) return cached.keys;
    throw new SsoError("unreachable", `the tenant's signing keys could not be read (HTTP ${status})`);
  }
  const keys = (body.keys as Jwk[]).filter((k) => k && k.kty === "RSA" && typeof k.kid === "string");
  keyCache.set(tenantId, { keys, at: Date.now() });
  return keys;
}

export interface EntraClaims {
  oid: string;
  tid: string;
  /** The UPN, as Entra shows the user: the XenMan user name. */
  username: string;
  email: string;
  name: string;
  roles: string[];
}

/** The ID token checked: signature, issuer, audience, tenant, times and nonce. */
export async function verifyIdToken(config: SsoConfig, idToken: string, nonce: string): Promise<EntraClaims> {
  const decoded = jwt.decode(idToken, { complete: true });
  const kid = decoded && typeof decoded === "object" ? decoded.header.kid : undefined;
  if (!decoded || decoded.header.alg !== "RS256" || !kid) throw new SsoError("invalid", "the ID token is not signed with RS256");
  let jwk = (await tenantKeys(config.tenantId, false)).find((k) => k.kid === kid);
  // Microsoft rolls its keys over: one not seen yet is looked for once more.
  if (!jwk) jwk = (await tenantKeys(config.tenantId, true)).find((k) => k.kid === kid);
  if (!jwk) throw new SsoError("invalid", `the ID token is signed with a key the tenant does not publish (${kid})`);
  let p: Record<string, unknown>;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    p = jwt.verify(idToken, key, {
      algorithms: ["RS256"],
      audience: config.clientId,
      issuer: `${entraAuthority()}/${config.tenantId}/v2.0`,
      clockTolerance: CLOCK_TOLERANCE_S,
    }) as Record<string, unknown>;
  } catch (err) {
    throw new SsoError("invalid", `the ID token did not verify: ${err instanceof Error ? err.message : err}`);
  }
  if (String(p.tid ?? "").toLowerCase() !== config.tenantId) throw new SsoError("invalid", `the ID token is from another tenant (${p.tid})`);
  if (typeof p.nonce !== "string" || p.nonce !== nonce) throw new SsoError("invalid", "the ID token's nonce is not the one sent");
  const oid = String(p.oid ?? "");
  const username = String(p.preferred_username ?? p.upn ?? p.email ?? "").trim();
  if (!oid || !username) throw new SsoError("invalid", "the ID token names no user (oid, preferred_username)");
  return {
    oid,
    tid: config.tenantId,
    username,
    email: String(p.email ?? (username.includes("@") ? username : "")).trim(),
    name: String(p.name ?? "").trim(),
    roles: Array.isArray(p.roles) ? p.roles.map(String) : [],
  };
}

/** The app roles, as named in the app registration. */
export const ENTRA_APP_ROLES: Record<string, UserRole> = {
  "XenMan.Admin": "admin",
  "XenMan.Operator": "operator",
  "XenMan.Viewer": "viewer",
};

/** The highest XenMan role among the app roles assigned, or null. */
export function roleFromClaims(roles: string[]): UserRole | null {
  const have = new Set(roles.map((r) => ENTRA_APP_ROLES[r]).filter(Boolean));
  for (const r of ["admin", "operator", "viewer"] as const) if (have.has(r)) return r;
  return null;
}

/** For the settings page's Test: does Entra know this tenant, and can XenMan reach it? */
export async function testTenant(tenantId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { status, body } = await fetchJson(`${entraAuthority()}/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`);
    if (status !== 200) {
      const why = String(body.error_description ?? body.error ?? "").split(/\r?\n/)[0];
      return { ok: false, detail: `Entra ID does not know this tenant (HTTP ${status}${why ? `: ${why}` : ""})` };
    }
    return { ok: true, detail: `Entra ID reached; tenant ${tenantId} found` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
