// Signing in with Microsoft Entra ID: the app registration XenMan uses, kept in
// sso.json in the data directory, set by an administrator under Settings >
// Security. The client secret is sealed (lib/secret-box.ts) and never leaves
// the server again. server.js reads the file too, for the console WebSockets.

import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { seal, unseal } from "./secret-box";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
export const SSO_CONFIG_FILE = path.join(DATA_DIR, "sso.json");

/** Microsoft's sign-in service; another one only for the tests (tests/fake-entra.js). */
export function entraAuthority(): string {
  return (process.env.XENMAN_ENTRA_AUTHORITY || "https://login.microsoftonline.com").replace(/\/+$/, "");
}

export interface SsoConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  /** Sealed; "" when none is set. */
  clientSecret: string;
  /** Where XenMan is reached, https://...; the redirect URI is made from it. */
  address: string;
  /** Signing in with a password only for administrators -- the way in when Entra is down. */
  localAdminsOnly: boolean;
}

/** What the settings page is shown: the secret only as set or not. */
export type SsoConfigView = Omit<SsoConfig, "clientSecret"> & { secretSet: boolean; redirectUri: string };

const EMPTY: SsoConfig = { enabled: false, tenantId: "", clientId: "", clientSecret: "", address: "", localAdminsOnly: false };

let cache: { stamp: string; config: SsoConfig } | null = null;

/** The configuration, read again only when the file changed. */
export function readSsoConfig(): SsoConfig {
  let stamp = "none";
  try {
    const s = fs.statSync(SSO_CONFIG_FILE);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch {
    // not set up
  }
  if (cache && cache.stamp === stamp) return cache.config;
  let config = { ...EMPTY };
  try {
    const raw = JSON.parse(fs.readFileSync(SSO_CONFIG_FILE, "utf-8")) as Partial<SsoConfig>;
    config = {
      enabled: raw.enabled === true,
      tenantId: String(raw.tenantId ?? ""),
      clientId: String(raw.clientId ?? ""),
      clientSecret: String(raw.clientSecret ?? ""),
      address: String(raw.address ?? ""),
      localAdminsOnly: raw.localAdminsOnly === true,
    };
  } catch {
    // unreadable: as if not set up
  }
  cache = { stamp, config };
  return config;
}

/** Signing in with Entra is on and complete. */
export function ssoActive(config = readSsoConfig()): boolean {
  return config.enabled && Boolean(config.tenantId && config.clientId && config.clientSecret && config.address);
}

/** Password sign-in is closed to this role. */
export function localSignInClosedFor(role: string, config = readSsoConfig()): boolean {
  return ssoActive(config) && config.localAdminsOnly && role !== "admin";
}

export function ssoRedirectUri(address: string): string {
  return address ? `${address.replace(/\/+$/, "")}/api/auth/sso/callback` : "";
}

export function ssoConfigView(config = readSsoConfig()): SsoConfigView {
  const { clientSecret, ...rest } = config;
  return { ...rest, secretSet: Boolean(clientSecret), redirectUri: ssoRedirectUri(config.address) };
}

export function clientSecretOf(config: SsoConfig): string {
  return config.clientSecret ? unseal(config.clientSecret) : "";
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks what the settings page sends. A secret left empty keeps the one set.
 * Switched on, everything has to be there.
 */
export function parseSsoConfig(body: unknown, current = readSsoConfig()): { config: SsoConfig } | { error: string } {
  const r = (body ?? {}) as Record<string, unknown>;
  const enabled = r.enabled === true;
  const tenantId = String(r.tenantId ?? "").trim().toLowerCase();
  const clientId = String(r.clientId ?? "").trim().toLowerCase();
  if (tenantId && !GUID.test(tenantId)) return { error: "The tenant ID is a GUID, as Entra shows it under Overview (Directory (tenant) ID)" };
  if (clientId && !GUID.test(clientId)) return { error: "The client ID is a GUID, as Entra shows it under Overview (Application (client) ID)" };
  let address = String(r.address ?? "").trim().replace(/\/+$/, "");
  if (address) {
    try {
      const u = new URL(address);
      // Entra takes http redirect URIs only for localhost; the tests run there.
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.search || u.hash || u.username) throw new Error();
      address = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
    } catch {
      return { error: "The XenMan address must look like https://xenman.example.org" };
    }
  }
  const typedSecret = typeof r.clientSecret === "string" ? r.clientSecret.trim() : "";
  if (typedSecret.length > 1024) return { error: "That client secret is too long" };
  const clientSecret = typedSecret ? seal(typedSecret) : current.clientSecret;
  if (enabled && (!tenantId || !clientId || !clientSecret || !address)) {
    return { error: "To switch it on, fill in the tenant ID, client ID, client secret and XenMan address" };
  }
  const localAdminsOnly = enabled && r.localAdminsOnly === true;
  return { config: { enabled, tenantId, clientId, clientSecret, address, localAdminsOnly } };
}

export function saveSsoConfig(config: SsoConfig) {
  writeFileAtomic(SSO_CONFIG_FILE, JSON.stringify(config, null, 2), 0o600);
  cache = null;
}
