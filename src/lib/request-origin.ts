// Requests another site makes the browser send (CSRF). The session cookie is
// SameSite=Lax, which keeps it off cross-site POSTs -- but not off requests
// from a sibling subdomain or another port of the same host, and not off the
// sign-in form, which needs no cookie. The routes read their body as JSON
// whatever its Content-Type, so a plain HTML form could post one.
//
// So anything that changes something has to come from XenMan's own pages. The
// browser says where a request comes from: Sec-Fetch-Site (all current
// browsers), else Origin compared with the Host it was sent to. A request with
// neither is not from a browser page (curl, scripts) and is not a CSRF.

import type { NextRequest } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function crossSiteRequest(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const site = request.headers.get("sec-fetch-site");
  // "none": typed by the user, a bookmark -- not another site.
  if (site) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  // "null": a sandboxed frame, a data: URL -- never one of XenMan's pages.
  if (origin === "null") return true;
  try {
    return new URL(origin).host.toLowerCase() !== (request.headers.get("host") ?? "").toLowerCase();
  } catch {
    return true;
  }
}

export const CROSS_SITE_ERROR = "Refused: this request did not come from XenMan's own pages";
