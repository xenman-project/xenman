// Who has to sign in with a second factor: nobody (each user decides), the
// administrators, or everyone. Kept in twofactor.json in the data directory,
// set by an administrator under Settings > Security.
//
// Someone the policy covers who has not set up two-factor sign-in yet gets a
// session that can do nothing but set it up (lib/auth.ts verifyToken, the
// same way as a password that has to be changed first). server.js reads the
// file too, for the console WebSockets.

import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import type { UserRole } from "./auth";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
export const TWOFACTOR_POLICY_FILE = path.join(DATA_DIR, "twofactor.json");

export type TwoFactorRequirement = "none" | "admins" | "all";

export interface TwoFactorPolicy {
  require: TwoFactorRequirement;
}

const DEFAULT_POLICY: TwoFactorPolicy = { require: "none" };

let cache: { stamp: string; policy: TwoFactorPolicy } | null = null;

/** The policy, read again only when the file changed. */
export function readTwoFactorPolicy(): TwoFactorPolicy {
  let stamp = "none";
  try {
    const s = fs.statSync(TWOFACTOR_POLICY_FILE);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch {
    // not set: nobody has to
  }
  if (cache && cache.stamp === stamp) return cache.policy;
  let policy = { ...DEFAULT_POLICY };
  try {
    const parsed = parseTwoFactorPolicy(JSON.parse(fs.readFileSync(TWOFACTOR_POLICY_FILE, "utf-8")));
    if ("policy" in parsed) policy = parsed.policy;
  } catch {
    // unreadable: as if not set
  }
  cache = { stamp, policy };
  return policy;
}

export function parseTwoFactorPolicy(body: unknown): { policy: TwoFactorPolicy } | { error: string } {
  const r = (body ?? {}) as Record<string, unknown>;
  if (r.require !== "none" && r.require !== "admins" && r.require !== "all") return { error: "Choose none, admins or all" };
  return { policy: { require: r.require } };
}

export function saveTwoFactorPolicy(policy: TwoFactorPolicy) {
  writeFileAtomic(TWOFACTOR_POLICY_FILE, JSON.stringify(policy, null, 2));
  cache = null;
}

/** Whether the policy requires a second factor of someone in this role. */
export function twoFactorRequiredFor(role: UserRole, policy = readTwoFactorPolicy()): boolean {
  return policy.require === "all" || (policy.require === "admins" && role === "admin");
}
