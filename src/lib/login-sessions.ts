// The sign-ins XenMan has handed out and not taken back.
//
// A session token alone says who signed in, and stays valid until it expires:
// signing out, a new password, a deleted account would not end it. So each
// sign-in is also recorded here, its id (sid) is in the token, and a token
// whose sid is no longer here is not accepted -- by verifyToken() in auth.ts
// and by server.js for the console WebSocket, which reads this file itself.
//
// DATA_DIR/sessions.json, written atomically, readable by XenMan alone.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

export interface LoginSession {
  sid: string;
  user: string;
  createdAt: string;
  /** When the token expires; the entry is dropped after it. */
  expiresAt: string;
}

let cache: { stamp: string; list: LoginSession[] } | null = null;

function stampOf(): string {
  try {
    const s = fs.statSync(SESSIONS_FILE);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "none";
  }
}

/** The recorded sessions, read again only when the file changed. */
function load(): LoginSession[] {
  const stamp = stampOf();
  if (cache && cache.stamp === stamp) return cache.list;
  let list: LoginSession[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    if (Array.isArray(raw)) list = raw.filter((s) => s && typeof s.sid === "string" && typeof s.user === "string");
  } catch {
    // Missing or unreadable: nobody is signed in.
  }
  cache = { stamp, list };
  return list;
}

function save(list: LoginSession[]) {
  const now = Date.now();
  const kept = list.filter((s) => Date.parse(s.expiresAt) > now);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(SESSIONS_FILE, JSON.stringify(kept, null, 2), 0o600);
  cache = null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Records a new sign-in of this user for this many seconds; returns its id. */
export function startLoginSession(user: string, seconds: number): string {
  const sid = crypto.randomBytes(18).toString("base64url");
  const now = Date.now();
  save([
    ...load(),
    { sid, user, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + seconds * 1000).toISOString() },
  ]);
  return sid;
}

/** Whether this sign-in of this user is still recorded and not expired. */
export function loginSessionValid(sid: string | undefined, user: string): boolean {
  if (!sid) return false;
  const s = load().find((x) => x.sid === sid);
  return Boolean(s && same(s.user, user) && Date.parse(s.expiresAt) > Date.now());
}

/** Ends one sign-in (signing out). */
export function endLoginSession(sid: string | undefined): void {
  if (!sid) return;
  const list = load();
  if (list.some((s) => s.sid === sid)) save(list.filter((s) => s.sid !== sid));
}

/** Ends every sign-in of a user, but the one kept; returns how many ended. */
export function endUserSessions(user: string, keepSid?: string): number {
  const list = load();
  const ending = list.filter((s) => same(s.user, user) && s.sid !== keepSid);
  if (ending.length) save(list.filter((s) => !ending.includes(s)));
  return ending.length;
}
