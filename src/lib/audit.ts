import fs from "fs";
import path from "path";
import type { NextRequest } from "next/server";
import { verifyToken, COOKIE_NAME, type UserRole } from "./auth";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");

// The log is append-only JSONL (one entry per line) rather than a JSON array:
// appending costs one write instead of read-parse-rewrite of an ever-growing
// file, and a torn write loses a single line instead of the whole document.
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_ARCHIVES = 3;

export type AuditCategory =
  | "auth"
  | "user"
  | "host"
  | "vm"
  | "storage"
  | "network"
  | "pool"
  | "config"
  | "system";

export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditEntry {
  /** ISO-8601 UTC timestamp. */
  ts: string;
  /** App user who caused the entry, or "-" for unauthenticated requests. */
  actor: string;
  role: UserRole | "-";
  /** Client IP as seen through x-forwarded-for / x-real-ip, else "-". */
  ip: string;
  category: AuditCategory;
  /** Machine-readable verb, e.g. "login" or "vm_power". */
  action: string;
  /** What was acted on, e.g. `VM "db-01"` or `user bob`. */
  target?: string;
  outcome: AuditOutcome;
  /** Extra context: parameters, error message, before → after. */
  detail?: string;
}

export type AuditInput = Omit<AuditEntry, "ts">;

/**
 * Mask anything that looks like a credential. Call sites build their detail
 * strings by hand and never dump request bodies, so this is defense in depth
 * for the one uncontrolled source: upstream error messages.
 */
const SECRET_PATTERN =
  /("?(?:password|passwd|pwd|secret|passphrase|token|sessionRef|inviteToken|resetToken)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, (_match, key: string) => `${key}"***"`);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function archivePath(n: number): string {
  return path.join(DATA_DIR, `audit.${n}.jsonl`);
}

/** Shift audit.jsonl → audit.1.jsonl → … once the active file grows too large. */
function rotateIfNeeded() {
  let size = 0;
  try {
    size = fs.statSync(AUDIT_FILE).size;
  } catch {
    return; // No log yet — nothing to rotate.
  }
  if (size < MAX_BYTES) return;

  try {
    fs.rmSync(archivePath(KEEP_ARCHIVES), { force: true });
    for (let n = KEEP_ARCHIVES - 1; n >= 1; n--) {
      if (fs.existsSync(archivePath(n))) {
        fs.renameSync(archivePath(n), archivePath(n + 1));
      }
    }
    fs.renameSync(AUDIT_FILE, archivePath(1));
  } catch {
    // Rotation failure must not stop logging; the file simply keeps growing.
  }
}

/**
 * Append one entry. Never throws — a broken audit sink must not turn a working
 * request into a 500. Failures are reported on the server console instead.
 */
export function audit(entry: AuditInput): void {
  try {
    ensureDataDir();
    rotateIfNeeded();
    const record: AuditEntry = {
      ts: new Date().toISOString(),
      ...entry,
      ...(entry.detail ? { detail: redactSecrets(entry.detail) } : {}),
      ...(entry.target ? { target: redactSecrets(entry.target) } : {}),
    };
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[audit] failed to write entry (${entry.action}): ${msg}`);
  }
}

export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "-";
}

/** Resolve the acting user from the auth cookie without requiring a valid one. */
export function actorOf(request: NextRequest): {
  actor: string;
  role: UserRole | "-";
} {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return { actor: "-", role: "-" };
  return { actor: payload.sub, role: payload.role };
}

/**
 * Append an entry, filling actor/role from the session cookie and IP from the
 * request headers. Pass `actor` explicitly for actions where there is no valid
 * session yet (a failed login, an accepted invitation).
 */
export function auditRequest(
  request: NextRequest,
  entry: Omit<AuditInput, "actor" | "role" | "ip"> & {
    actor?: string;
    role?: UserRole | "-";
  },
): void {
  const who = actorOf(request);
  const { actor, role, ...rest } = entry;
  audit({
    ...rest,
    actor: actor ?? who.actor,
    role: role ?? who.role,
    ip: clientIp(request),
  });
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

export interface AuditQuery {
  limit?: number;
  offset?: number;
  category?: string;
  outcome?: string;
  actor?: string;
  /** Free-text match across action, target, detail and actor. */
  q?: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  hasMore: boolean;
}

function matches(entry: AuditEntry, query: AuditQuery): boolean {
  if (query.category && entry.category !== query.category) return false;
  if (query.outcome && entry.outcome !== query.outcome) return false;
  if (
    query.actor &&
    entry.actor.toLowerCase() !== query.actor.toLowerCase()
  ) {
    return false;
  }
  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystack = `${entry.action} ${entry.target ?? ""} ${entry.detail ?? ""} ${entry.actor} ${entry.ip}`;
    if (!haystack.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** Active log first, then archives — i.e. newest to oldest. */
function logFiles(): string[] {
  const files = [AUDIT_FILE];
  for (let n = 1; n <= KEEP_ARCHIVES; n++) files.push(archivePath(n));
  return files.filter((f) => fs.existsSync(f));
}

/**
 * Read entries newest-first. Files are walked in order and parsing stops as
 * soon as enough matching entries exist, so a deep archive is only touched
 * when the caller actually pages back that far.
 */
export function readAudit(query: AuditQuery = {}): AuditPage {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
  const offset = Math.max(query.offset ?? 0, 0);
  const needed = offset + limit + 1; // +1 tells us whether more exist

  const collected: AuditEntry[] = [];

  for (const file of logFiles()) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        continue; // Skip a torn or hand-edited line.
      }
      if (!matches(entry, query)) continue;
      collected.push(entry);
      if (collected.length >= needed) break;
    }
    if (collected.length >= needed) break;
  }

  return {
    entries: collected.slice(offset, offset + limit),
    hasMore: collected.length > offset + limit,
  };
}

/** Distinct actors seen in the active log — used to populate the filter. */
export function knownActors(): string[] {
  const actors = new Set<string>();
  try {
    const raw = fs.readFileSync(AUDIT_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.actor && entry.actor !== "-") actors.add(entry.actor);
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return [...actors].sort((a, b) => a.localeCompare(b));
}

const CSV_COLUMNS: (keyof AuditEntry)[] = [
  "ts",
  "actor",
  "role",
  "ip",
  "category",
  "action",
  "target",
  "outcome",
  "detail",
];

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function auditToCsv(entries: AuditEntry[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = entries.map((e) =>
    CSV_COLUMNS.map((col) => csvCell(e[col])).join(","),
  );
  return [header, ...rows].join("\r\n");
}
