// Signing out after inactivity: one setting for every
// user, kept in session.json in the data directory.
//
// Only the browser knows whether someone is at the keyboard -- the pages poll
// the server on their own all the time -- so the browser enforces it (see
// components/inactivity-guard.tsx). The server's part is the setting itself,
// and the session cookie's own 24 hours, which no inactivity setting extends.

import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const CONFIG_FILE = path.join(DATA_DIR, "session.json");

export interface SessionPolicy {
  /** Minutes without input before signing out; 0 is off. */
  inactivityMinutes: number;
}

/** Shorter would sign people out while they read a page. */
export const MIN_INACTIVITY_MINUTES = 5;
/** A session ends after 24 hours regardless (the cookie and token lifetime). */
export const MAX_INACTIVITY_MINUTES = 24 * 60;

const DEFAULT_POLICY: SessionPolicy = { inactivityMinutes: 0 };

export function readSessionPolicy(): SessionPolicy {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const parsed = parseSessionPolicy(raw);
    return "policy" in parsed ? parsed.policy : { ...DEFAULT_POLICY };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function parseSessionPolicy(body: unknown): { policy: SessionPolicy } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const minutes = Number(b.inactivityMinutes);
  if (!Number.isInteger(minutes) || minutes < 0) return { error: "Enter a whole number of minutes" };
  if (minutes !== 0 && minutes < MIN_INACTIVITY_MINUTES) {
    return { error: `The timeout must be at least ${MIN_INACTIVITY_MINUTES} minutes` };
  }
  if (minutes > MAX_INACTIVITY_MINUTES) return { error: "The timeout can be at most 24 hours" };
  return { policy: { inactivityMinutes: minutes } };
}

export function saveSessionPolicy(policy: SessionPolicy) {
  writeFileAtomic(CONFIG_FILE, JSON.stringify(policy, null, 2));
}
