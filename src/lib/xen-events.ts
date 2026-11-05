// Long-term store for what happened *on the pools* — XAPI alerts (`message`
// objects) and finished operations (`task` objects).
//
// This is deliberately separate from lib/audit.ts: the audit log answers "which
// XenMan user did what", this one answers "what did the hypervisor report".
// An operation started from XenCenter or `xe` shows up here and nowhere else.
//
// The storage mechanics are copied from lib/audit.ts on purpose — append-only
// JSONL, size-based rotation, newest-first reads that stop as soon as enough
// rows matched. Same reasoning applies: appending costs one write instead of
// read-parse-rewrite, and a torn write loses one line rather than the file.

import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_ARCHIVES = 3;

export type PoolEventKind = "alert" | "task";
export type PoolEventSeverity = "critical" | "warning" | "info";
export type PoolEventStatus = "success" | "failure" | "cancelled";

export interface PoolEvent {
  /** XAPI uuid of the message/task object — the dedupe key. */
  id: string;
  /** ISO-8601 UTC. */
  ts: string;
  /** Configured host entry (= pool) the event came from. */
  hostId: string;
  kind: PoolEventKind;
  severity: PoolEventSeverity;
  /** `message.name` (e.g. ALARM, VM_SHUTDOWN) or `task.name_label` (e.g. VM.start). */
  name: string;
  /** `message.cls` for alerts, the guessed class for tasks. */
  objectClass?: string;
  objectUuid?: string;
  /** Resolved object name where known, so the row reads without a UUID lookup. */
  target?: string;
  /** `message.body` or `task.name_description`. */
  body?: string;
  /** Tasks only. */
  status?: PoolEventStatus;
  error?: string;
  durationMs?: number;
}

/* ── Severity mapping ────────────────────────────────────────────────────── */

/**
 * XAPI alert priorities run 1 (most urgent) to 5 (informational); XenCenter
 * shows 1–2 as critical/major. Anything unparseable is treated as info rather
 * than raising a false alarm on the bell badge.
 */
export function severityFromPriority(priority: number): PoolEventSeverity {
  if (priority >= 1 && priority <= 2) return "critical";
  if (priority === 3) return "warning";
  return "info";
}

export function severityFromTaskStatus(status?: string): PoolEventSeverity {
  if (status === "failure") return "critical";
  if (status === "cancelled") return "warning";
  return "info";
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

// Every connect and every alert poll re-reads all messages and tasks the pool
// still holds, so the same object arrives many times over a session. Two things
// keep those catch-up scans from duplicating rows:
//
//   * a high-water mark on `ts`, per pool and per kind, persisted beside the
//     log — an event no newer than the newest one already stored has been
//     recorded before, whatever its id;
//   * a set of written ids per pool, for the boundary the mark cannot decide:
//     the events sharing that newest timestamp.
//
// The mark is what makes this hold for a large pool and across a restart. It
// replaces a single 5000-id set shared by every pool, which failed at both: a
// deployment with 35k messages across five pools evicted its own entries within
// one poll round, re-appended every message every 60 seconds, and rotated the
// entire history out of existence in about 40 seconds. A cap that has to exceed
// the pool's message count to work at all is not a cap, it is a guess.
//
// On globalThis so it survives HMR module reloads in dev, matching how
// lib/xen-sessions.ts and lib/ref-names.ts hold their state.

/** Ids kept per pool. Trimmed in one pass at HIGH, down to LOW — see markSeen. */
const SEEN_HIGH = 20_000;
const SEEN_LOW = 15_000;

const MARK_FILE = path.join(DATA_DIR, "events-mark.json");

interface HostState {
  /**
   * Newest `ts` written, per kind. Alerts and tasks are independent streams: a
   * task finishing at 10:00:05 must not suppress an alert stamped 10:00:03 that
   * we have never seen, so one mark for both kinds would lose rows.
   */
  newestTs: Partial<Record<PoolEventKind, string>>;
  ids: Set<string>;
}

const g = globalThis as typeof globalThis & {
  _xenEventState?: Map<string, HostState>;
  _xenEventMarksLoaded?: boolean;
};
if (!g._xenEventState) g._xenEventState = new Map<string, HostState>();
const hostStates = g._xenEventState;

function stateFor(hostId: string): HostState {
  let state = hostStates.get(hostId);
  if (!state) {
    state = { newestTs: {}, ids: new Set() };
    hostStates.set(hostId, state);
  }
  return state;
}

/** Read the persisted marks once per process. */
function loadMarks(): void {
  if (g._xenEventMarksLoaded) return;
  g._xenEventMarksLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(MARK_FILE, "utf-8")) as Record<
      string,
      Partial<Record<PoolEventKind, string>>
    >;
    for (const [hostId, marks] of Object.entries(parsed)) {
      if (marks && typeof marks === "object") {
        stateFor(hostId).newestTs = { ...marks };
      }
    }
  } catch {
    // No marks yet, or an unreadable file. The id set still dedupes inside this
    // process, and readPoolEvents drops a re-appended row on the way out — the
    // cost is one extra scan written after a restart, not a wrong history.
  }
}

function saveMarks(): void {
  const marks: Record<string, Partial<Record<PoolEventKind, string>>> = {};
  for (const [hostId, state] of hostStates) {
    if (Object.keys(state.newestTs).length > 0) marks[hostId] = state.newestTs;
  }
  try {
    writeFileAtomic(MARK_FILE, JSON.stringify(marks));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[xen-events] failed to persist high-water marks: ${msg}`);
  }
}

/**
 * Remember a written id, trimming in one bulk pass instead of on every insert.
 * The previous version copied the whole set per event, which is O(n) per event
 * and was the dominant CPU cost of recording a full scan.
 */
function markSeen(state: HostState, id: string) {
  state.ids.add(id);
  if (state.ids.size > SEEN_HIGH) {
    // Sets iterate in insertion order, so the tail is the most recently seen.
    state.ids = new Set([...state.ids].slice(state.ids.size - SEEN_LOW));
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function archivePath(n: number): string {
  return path.join(DATA_DIR, `events.${n}.jsonl`);
}

/** Shift events.jsonl → events.1.jsonl → … once the active file grows too large. */
function rotateIfNeeded() {
  let size = 0;
  try {
    size = fs.statSync(EVENTS_FILE).size;
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
    fs.renameSync(EVENTS_FILE, archivePath(1));
  } catch {
    // Rotation failure must not stop recording; the file simply keeps growing.
  }
}

/**
 * Append events that have not been written before. Never throws — a broken
 * store must not turn a working XAPI request into a 500. Returns how many rows
 * were actually appended.
 */
export function recordPoolEvents(
  hostId: string,
  events: Omit<PoolEvent, "hostId">[],
): number {
  if (!hostId || events.length === 0) return 0;

  loadMarks();
  const state = stateFor(hostId);

  // Strictly older than the mark, not "not newer": an event sharing the newest
  // timestamp may still be one we have never written, so the id set decides
  // that case. The cost is that a restart can re-append the handful of rows
  // sitting exactly on the mark, which readPoolEvents dedupes away on read.
  const fresh = events.filter((e) => {
    if (!e.id || state.ids.has(e.id)) return false;
    const mark = state.newestTs[e.kind];
    return !(mark && e.ts < mark);
  });
  if (fresh.length === 0) return 0;

  try {
    ensureDataDir();
    rotateIfNeeded();
    const lines = fresh
      .map((e) => JSON.stringify({ ...e, hostId } satisfies PoolEvent))
      .join("\n");
    fs.appendFileSync(EVENTS_FILE, `${lines}\n`, "utf-8");

    let advanced = false;
    for (const e of fresh) {
      markSeen(state, e.id);
      const mark = state.newestTs[e.kind];
      if (e.ts && (!mark || e.ts > mark)) {
        state.newestTs[e.kind] = e.ts;
        advanced = true;
      }
    }
    if (advanced) saveMarks();
    return fresh.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[xen-events] failed to record ${fresh.length} event(s): ${msg}`);
    return 0;
  }
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

export interface PoolEventQuery {
  limit?: number;
  offset?: number;
  /** Any of these kinds; omitted or empty means no kind restriction. */
  kinds?: string[];
  /** Any of these severities; omitted or empty means no severity restriction. */
  severities?: string[];
  /**
   * Pools to show, the "Filter by Location" selection. Narrows within
   * allowedHostIds and can never widen past it.
   */
  hostIds?: string[];
  /**
   * Pools the caller may see. Enforced here rather than in the route so no
   * caller can forget it: an empty array yields no rows at all.
   */
  allowedHostIds?: string[];
  /** Inclusive lower bound on `ts`, ISO-8601. */
  since?: string;
  /** Exclusive upper bound on `ts`, ISO-8601. */
  until?: string;
  /** Free-text match across name, target, body, error and object uuid. */
  q?: string;
}

export interface PoolEventPage {
  entries: PoolEvent[];
  hasMore: boolean;
}

function matches(entry: PoolEvent, query: PoolEventQuery): boolean {
  // The grant is checked first and separately from the Location selection: one
  // is a permission, the other a preference, and they must not be conflated.
  if (query.allowedHostIds && !query.allowedHostIds.includes(entry.hostId)) {
    return false;
  }
  if (query.hostIds?.length && !query.hostIds.includes(entry.hostId)) return false;
  if (query.kinds?.length && !query.kinds.includes(entry.kind)) return false;
  if (query.severities?.length && !query.severities.includes(entry.severity)) {
    return false;
  }
  if (query.since && entry.ts < query.since) return false;
  if (query.until && entry.ts >= query.until) return false;
  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystack = `${entry.name} ${entry.target ?? ""} ${entry.body ?? ""} ${entry.error ?? ""} ${entry.objectUuid ?? ""} ${entry.objectClass ?? ""}`;
    if (!haystack.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/**
 * Active log first, then archives — i.e. newest to oldest.
 *
 * With a `since` bound, archives whose last write predates it are skipped: a
 * file nothing has been appended to since before the window cannot hold an
 * entry inside it. That turns "last 24 hours" into one file instead of four.
 *
 * The active file is never skipped — its mtime is the last append, but a query
 * may still ask for older rows it contains.
 */
function logFiles(since?: string): string[] {
  const files = [EVENTS_FILE];
  const sinceMs = since ? Date.parse(since) : NaN;

  for (let n = 1; n <= KEEP_ARCHIVES; n++) {
    const file = archivePath(n);
    if (!Number.isNaN(sinceMs)) {
      try {
        if (fs.statSync(file).mtimeMs < sinceMs) continue;
      } catch {
        continue; // Missing archive; existsSync below would drop it anyway.
      }
    }
    files.push(file);
  }

  return files.filter((f) => fs.existsSync(f));
}

/**
 * Read entries newest-first by `ts`. Duplicate ids are dropped while reading:
 * the in-memory dedupe set is lost on restart, so a catch-up scan right after
 * one can re-append an event that is already on disk.
 *
 * The whole candidate set is collected and then sorted, rather than relying on
 * file order and stopping early. File order is *append* order, which is not
 * timestamp order: a catch-up scan at connect writes a batch of older messages
 * behind newer ones, and within a batch the order is XAPI's, not time's. Reading
 * backwards and stopping at `limit` therefore put stale rows at the top of the
 * table and could hide newer ones entirely.
 *
 * The scan is bounded by rotation (5 MB per file, 3 archives) and, when the
 * query carries `since`, by the archive skip in logFiles() — which is what keeps
 * the default "last 24 hours" down to a single file.
 */
export function readPoolEvents(query: PoolEventQuery = {}): PoolEventPage {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
  const offset = Math.max(query.offset ?? 0, 0);

  const collected: PoolEvent[] = [];
  const seen = new Set<string>();

  for (const file of logFiles(query.since)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: PoolEvent;
      try {
        entry = JSON.parse(trimmed) as PoolEvent;
      } catch {
        continue; // Skip a torn or hand-edited line.
      }
      if (entry.id) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
      }
      if (!matches(entry, query)) continue;
      collected.push(entry);
    }
  }

  // Newest first, with the id as the tie-break so paging stays stable across
  // requests when several events share a timestamp to the millisecond.
  collected.sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));

  return {
    entries: collected.slice(offset, offset + limit),
    hasMore: collected.length > offset + limit,
  };
}

const CSV_COLUMNS: (keyof PoolEvent)[] = [
  "ts",
  "hostId",
  "kind",
  "severity",
  "name",
  "objectClass",
  "objectUuid",
  "target",
  "status",
  "durationMs",
  "body",
  "error",
];

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function poolEventsToCsv(entries: PoolEvent[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = entries.map((e) =>
    CSV_COLUMNS.map((col) => csvCell(e[col])).join(","),
  );
  return [header, ...rows].join("\r\n");
}
