import type { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME } from "./auth";

/** How long a session lasts, in seconds; the token's own expiry is the same. */
export const SESSION_SECONDS = 60 * 60 * 24;

/**
 * How the request reached XenMan, as server.js says it (x-xenman-transport,
 * which it removes from what clients send): "https", "http-local" (plain HTTP
 * from this machine) or "http" (plain HTTP with HTTPS switched off). Without
 * server.js (npm run dev) the header is missing.
 */
function transport(request: NextRequest): string {
  return request.headers.get("x-xenman-transport") ?? "";
}

/** Whether the request came over HTTPS, as far as XenMan can tell. */
export function viaHttps(request: NextRequest): boolean {
  const t = transport(request);
  return t === "https" || (t === "" && request.nextUrl.protocol === "https:");
}

/**
 * The session cookie: HttpOnly, SameSite=Lax, and Secure unless the request
 * came over plain HTTP that server.js let through -- from this machine, or
 * with HTTPS switched off -- where a Secure cookie would never come back.
 * Without server.js, Secure: browsers accept it on http://localhost too.
 */
export function setAuthCookie(request: NextRequest, response: NextResponse, value: string, maxAge = SESSION_SECONDS) {
  const t = transport(request);
  response.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: t !== "http-local" && t !== "http",
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}
