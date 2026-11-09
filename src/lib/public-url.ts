import os from "os";
import type { NextRequest } from "next/server";
import { loadSmtpConfig } from "./smtp-storage";
import { viaHttps } from "./auth-cookie";

// Where links in mails point. Set in the mail settings, that address is used
// for every link. Otherwise a mail an administrator causes while signed in
// (an invitation, an update) points where that administrator is; a mail anyone
// can cause -- "forgot password" -- never takes its address from the request:
// a forged Host header would send the reset link, token and all, to a server
// of the sender's choosing.

/** The address set in the mail settings, without a trailing slash, or null. */
export function configuredUrl(): string | null {
  const url = loadSmtpConfig()?.publicUrl?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** Checks and tidies an address typed into the settings; "" clears it. */
export function parsePublicUrl(input: unknown): { url: string } | { error: string } {
  if (input === undefined || input === null || String(input).trim() === "") return { url: "" };
  try {
    const u = new URL(String(input).trim());
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.search || u.hash || u.username) throw new Error();
    return { url: `${u.origin}${u.pathname}`.replace(/\/+$/, "") };
  } catch {
    return { error: "The XenMan address must look like https://xenman.example.org" };
  }
}

/** This machine's own address: its first IPv4 address, over HTTPS. */
export function ownUrl(): string {
  const port = Number(process.env.HTTPS_PORT || 3001);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return `https://${a.address}${port && port !== 443 ? `:${port}` : ""}`;
    }
  }
  return `https://localhost${port && port !== 443 ? `:${port}` : ""}`;
}

/**
 * The base for links in a mail, without a trailing slash. Pass the request
 * only when an administrator who is signed in caused the mail.
 */
export function mailBaseUrl(signedInRequest?: NextRequest): string {
  const set = configuredUrl();
  if (set) return set;
  const host = signedInRequest?.headers.get("host");
  if (signedInRequest && host) {
    const https = viaHttps(signedInRequest);
    return `${https ? "https" : "http"}://${host}`;
  }
  return ownUrl();
}
