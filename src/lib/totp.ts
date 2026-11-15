// Two-factor sign-in with an authenticator app: TOTP as RFC 6238 defines it
// (HMAC-SHA1, 30-second steps, six digits) -- what Microsoft and Google
// Authenticator, 1Password and the like produce. Plus the recovery codes for a
// phone that is gone. The QR code an app scans is drawn in lib/totp-qr.ts.

import crypto from "crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either way: a phone clock a little off, a code typed as it changed. */
const DRIFT_STEPS = 1;
/** A secret of 160 bits, as RFC 4226 recommends for HMAC-SHA1. */
const SECRET_BYTES = 20;
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret, base32 as the apps take it. */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** The code for a time step (RFC 4226 HOTP with the step as counter). */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(n).padStart(TOTP_DIGITS, "0");
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The step a code belongs to, within one step of now, or null. A step at or
 * before `usedStep` does not count: a code once used cannot be used again.
 */
export function matchTotp(secret: string, code: string, usedStep = -1, now = Date.now()): number | null {
  const digits = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const at = currentStep(now);
  for (let step = at - DRIFT_STEPS; step <= at + DRIFT_STEPS; step++) {
    if (step <= usedStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

/** otpauth:// as the apps read it (Key Uri Format). */
export function otpauthUri(account: string, secret: string, issuer = "XenMan"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

/** The secret as shown for typing in: groups of four. */
export function groupedSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

// --- Recovery codes ---

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

/** Ten one-time codes, "xxxx-xxxx". */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const bytes = crypto.randomBytes(8);
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

/** A recovery code as typed: case, spaces and the dash do not matter. */
export function normalizeRecoveryCode(code: string): string {
  const c = String(code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
