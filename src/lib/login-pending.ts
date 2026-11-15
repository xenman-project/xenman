// The step between password and code. The password was right and the account
// signs in with a second factor: no session yet, only this -- a signed token in
// a cookie of its own, good for five minutes and five codes, for nothing but
// /api/auth/login/totp. verifyToken() never accepts it (it has no sign-in id),
// so it opens no page, no API and no console.

import crypto from "crypto";
import jwt from "jsonwebtoken";
import { ensureJwtSecret } from "./auth";

export const PENDING_COOKIE = "xenman-2fa";
export const PENDING_SECONDS = 5 * 60;
/** Wrong codes allowed on one password; then it starts again from the password. */
export const PENDING_TRIES = 5;

export interface PendingLogin {
  sub: string;
  /** The password has to be changed after the code (the default password). */
  pwc: boolean;
  jti: string;
}

const g = globalThis as typeof globalThis & { _xenmanPendingTries?: Map<string, { tries: number; until: number }> };
const tries = (g._xenmanPendingTries ??= new Map());

export function signPending(username: string, passwordChangeRequired: boolean): string {
  const secret = process.env.JWT_SECRET || ensureJwtSecret();
  return jwt.sign({ sub: username, purpose: "2fa", pwc: passwordChangeRequired }, secret, {
    algorithm: "HS256",
    expiresIn: PENDING_SECONDS,
    jwtid: crypto.randomBytes(12).toString("base64url"),
  });
}

/** The pending sign-in behind the cookie, unless it expired or used up its tries. */
export function readPending(token: string | undefined): PendingLogin | null {
  if (!token) return null;
  try {
    const secret = process.env.JWT_SECRET || ensureJwtSecret();
    const p = jwt.verify(token, secret, { algorithms: ["HS256"] }) as { sub?: unknown; purpose?: unknown; pwc?: unknown; jti?: unknown };
    if (p.purpose !== "2fa" || typeof p.sub !== "string" || typeof p.jti !== "string") return null;
    if ((tries.get(p.jti)?.tries ?? 0) >= PENDING_TRIES) return null;
    return { sub: p.sub, pwc: p.pwc === true, jti: p.jti };
  } catch {
    return null;
  }
}

/** A wrong code on this pending sign-in; true when that was the last try. */
export function pendingFailed(jti: string): boolean {
  const now = Date.now();
  for (const [k, v] of tries) if (v.until < now) tries.delete(k);
  const entry = tries.get(jti) ?? { tries: 0, until: now + PENDING_SECONDS * 1000 };
  entry.tries++;
  tries.set(jti, entry);
  return entry.tries >= PENDING_TRIES;
}

/** Used up: a code that worked, so the same cookie cannot sign in twice. */
export function pendingDone(jti: string) {
  tries.set(jti, { tries: PENDING_TRIES, until: Date.now() + PENDING_SECONDS * 1000 });
}
