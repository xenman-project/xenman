// Forwards the audit log as syslog (RFC 5424) to a collector -- an Elastic
// Agent or Logstash input, the way a NetScaler sends its logs: UDP or TCP to an
// address and port, no login, no certificate.
//
// The log is read from audit.jsonl itself rather than hooked into audit(): the
// root services (updater, security updates, network, console menu) append to
// that file directly (appliance/audit-append.js), and they belong in it too.
// Where reading has got to -- the file's inode and a byte offset -- is kept on
// disk, so a restart neither repeats nor skips entries, and the position only
// moves on once an entry has been sent.

import fs from "fs";
import os from "os";
import path from "path";
import net from "net";
import dgram from "dgram";
import { spawn } from "child_process";
import { writeFileAtomic } from "./atomic-write";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");
const ROTATED_FILE = path.join(DATA_DIR, "audit.1.jsonl");
const CONFIG_FILE = path.join(DATA_DIR, "syslog.json");
const STATE_FILE = path.join(DATA_DIR, "updates", "syslog-state.json");
const TICK_MS = Number(process.env.XENMAN_SYSLOG_TICK_MS) || 2000;
/** At most this much per tick: a backlog drains over a few ticks, not in one burst. */
const MAX_BYTES_PER_TICK = 512 * 1024;
const TCP_RETRY_MS = Number(process.env.XENMAN_SYSLOG_TCP_RETRY_MS) || 15_000;
/** Kept well under what one UDP datagram carries. */
const MAX_MESSAGE = 8 * 1024;

export interface SyslogConfig {
  enabled: boolean;
  host: string;
  port: number;
  protocol: "udp" | "tcp";
  /** The appliance's own system log (journald) too, not only the audit log. */
  journal: boolean;
}

export interface SyslogStatus {
  lastSentAt: string | null;
  sent: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

const DEFAULT_CONFIG: SyslogConfig = { enabled: false, host: "", port: 5093, protocol: "udp", journal: false };

export function readSyslogConfig(): SyslogConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$|^[0-9a-fA-F:]+$/;

export function parseSyslogConfig(body: unknown): { config: SyslogConfig } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const enabled = b.enabled === true;
  const host = typeof b.host === "string" ? b.host.trim() : "";
  const port = Number(b.port);
  const protocol = b.protocol === "tcp" ? "tcp" : "udp";
  if (enabled && !host) return { error: "Enter the address of the syslog server" };
  if (host && !HOST.test(host)) return { error: "The server must be an IP address or a host name" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "The port must be between 1 and 65535" };
  return { config: { enabled, host, port, protocol, journal: b.journal === true } };
}

export async function saveSyslogConfig(config: SyslogConfig) {
  const before = readSyslogConfig();
  writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
  // Switched on now: from the end of the log, not megabytes of history.
  if (config.enabled && !before.enabled) startAtEnd();
  if (config.enabled && config.journal && !(before.enabled && before.journal)) await journalStartAtEnd();
  resetTransport();
}

// ─── the message ─────────────────────────────────────────────────────────────

interface AuditRecord {
  ts?: string;
  actor?: string;
  role?: string;
  ip?: string;
  category?: string;
  action?: string;
  target?: string;
  outcome?: string;
  detail?: string;
}

/** "log audit" (13), as RFC 5424 has it for exactly this. */
const FACILITY = 13;
const SEVERITY: Record<string, number> = { success: 6, failure: 4, denied: 5 };

/** A PARAM-VALUE: `"`, `\` and `]` escaped (RFC 5424 6.3.3). */
const sdValue = (s: string) => s.replace(/[\\"\]]/g, (c) => `\\${c}`);
/** HOSTNAME, APP-NAME, MSGID: printable US-ASCII without spaces, bounded. */
const token = (s: string, max: number) => (s.replace(/[^\x21-\x7e]/g, "_").slice(0, max) || "-");

/**
 * One audit entry as an RFC 5424 message:
 *   <PRI>1 TIMESTAMP HOSTNAME xenman - MSGID [xenman@32473 actor="…" …] text
 */
export function formatSyslog(r: AuditRecord, hostname = os.hostname()): string {
  const pri = FACILITY * 8 + (SEVERITY[r.outcome ?? ""] ?? 6);
  const ts = r.ts && !Number.isNaN(Date.parse(r.ts)) ? new Date(r.ts).toISOString() : new Date().toISOString();
  const params: [string, string | undefined][] = [
    ["actor", r.actor],
    ["role", r.role],
    ["ip", r.ip],
    ["category", r.category],
    ["action", r.action],
    ["outcome", r.outcome],
    ["target", r.target],
  ];
  const sd = `[xenman@32473 ${params
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}="${sdValue(String(v))}"`)
    .join(" ")}]`;
  const text = [
    `${r.actor ?? "-"} ${r.action ?? "-"} ${r.outcome ?? "-"}`,
    r.target ? ` on ${r.target}` : "",
    r.ip && r.ip !== "-" ? ` from ${r.ip}` : "",
    r.detail ? ` — ${r.detail}` : "",
  ].join("");
  const line = `<${pri}>1 ${ts} ${token(hostname, 255)} xenman - ${token(r.action ?? "-", 32)} ${sd} ${text}`;
  return Buffer.byteLength(line) > MAX_MESSAGE ? `${Buffer.from(line).subarray(0, MAX_MESSAGE - 3).toString()}...` : line;
}

// ─── sending ─────────────────────────────────────────────────────────────────

const g = globalThis as unknown as {
  _xenmanSyslog?: { status: SyslogStatus; udp: dgram.Socket | null; tcp: net.Socket | null; tcpDownUntil: number; timer: NodeJS.Timeout | null; busy: boolean };
};
const st = (g._xenmanSyslog ??= {
  status: { lastSentAt: null, sent: 0, lastError: null, lastErrorAt: null },
  udp: null,
  tcp: null,
  tcpDownUntil: 0,
  timer: null,
  busy: false,
});

export function syslogStatus(): SyslogStatus {
  return { ...st.status };
}

function failed(err: unknown) {
  st.status.lastError = err instanceof Error ? err.message : String(err);
  st.status.lastErrorAt = new Date().toISOString();
}

function resetTransport() {
  st.udp?.close();
  st.udp = null;
  st.tcp?.destroy();
  st.tcp = null;
  st.tcpDownUntil = 0;
}

function sendUdp(c: SyslogConfig, lines: string[]): Promise<void> {
  st.udp ??= dgram.createSocket(net.isIPv6(c.host) ? "udp6" : "udp4").on("error", failed);
  const sock = st.udp;
  return lines.reduce(
    (p, line) => p.then(() => new Promise<void>((ok, bad) => sock.send(Buffer.from(line), c.port, c.host, (e) => (e ? bad(e) : ok())))),
    Promise.resolve(),
  );
}

function tcpConnect(c: SyslogConfig): Promise<net.Socket> {
  if (st.tcp && !st.tcp.destroyed && !st.tcp.connecting) return Promise.resolve(st.tcp);
  return new Promise((ok, bad) => {
    const sock = net.connect({ host: c.host, port: c.port });
    const timer = setTimeout(() => sock.destroy(new Error("connection timed out")), 5000);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.setKeepAlive(true, 60_000);
      st.tcp = sock;
      ok(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      bad(e);
    });
    sock.on("close", () => {
      if (st.tcp === sock) st.tcp = null;
    });
  });
}

/** Line-delimited, as Elastic's TCP and syslog inputs read it by default. */
async function sendTcp(c: SyslogConfig, lines: string[]): Promise<void> {
  const sock = await tcpConnect(c);
  await new Promise<void>((ok, bad) => sock.write(lines.map((l) => `${l}\n`).join(""), (e) => (e ? bad(e) : ok())));
}

function send(c: SyslogConfig, lines: string[]): Promise<void> {
  return c.protocol === "tcp" ? sendTcp(c, lines) : sendUdp(c, lines);
}

/** A test message from the settings: sent at once, its outcome reported. */
export async function sendTest(c: SyslogConfig, by: string): Promise<string | null> {
  const line = formatSyslog({ ts: new Date().toISOString(), actor: by, role: "admin", ip: "-", category: "config", action: "syslog_test", outcome: "success", detail: "test message from XenMan" });
  try {
    if (c.protocol === "tcp") {
      // Its own connection, so a test cannot disturb the forwarding.
      await new Promise<void>((ok, bad) => {
        const sock = net.connect({ host: c.host, port: c.port });
        const timer = setTimeout(() => sock.destroy(new Error("connection timed out")), 5000);
        sock.once("connect", () => sock.end(`${line}\n`, () => { clearTimeout(timer); ok(); }));
        sock.once("error", (e) => { clearTimeout(timer); bad(e); });
      });
    } else {
      const sock = dgram.createSocket(net.isIPv6(c.host) ? "udp6" : "udp4");
      await new Promise<void>((ok, bad) => sock.send(Buffer.from(line), c.port, c.host, (e) => { sock.close(); return e ? bad(e) : ok(); }));
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ─── reading the log ─────────────────────────────────────────────────────────

interface ReadState {
  ino: number;
  pos: number;
}

function readState(): ReadState | null {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return typeof s.ino === "number" && typeof s.pos === "number" ? s : null;
  } catch {
    return null;
  }
}

function saveState(s: ReadState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileAtomic(STATE_FILE, JSON.stringify(s));
}

function startAtEnd() {
  try {
    const s = fs.statSync(AUDIT_FILE);
    saveState({ ino: s.ino, pos: s.size });
  } catch {
    saveState({ ino: 0, pos: 0 });
  }
}

/** Complete lines of `file` from `pos` on, at most MAX_BYTES_PER_TICK, and where they end. */
function readLines(file: string, pos: number): { lines: { text: string; end: number }[] } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size - pos, MAX_BYTES_PER_TICK);
    if (len <= 0) return { lines: [] };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    const lines: { text: string; end: number }[] = [];
    let start = 0;
    for (let i = 0; i < len; i++) {
      if (buf[i] !== 0x0a) continue;
      lines.push({ text: buf.subarray(start, i).toString("utf-8"), end: pos + i + 1 });
      start = i + 1;
    }
    if (!lines.length && len === MAX_BYTES_PER_TICK) {
      // One line longer than a whole chunk: passed over to its end rather
      // than waited on for ever -- no audit entry is anywhere near that long.
      const chunk = Buffer.alloc(64 * 1024);
      for (let at = pos + len; at < size; at += chunk.length) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, at);
        const nl = chunk.subarray(0, n).indexOf(0x0a);
        if (nl >= 0) return { lines: [{ text: "", end: at + nl + 1 }] };
      }
    }
    return { lines };
  } finally {
    fs.closeSync(fd);
  }
}

/** Sends what `file` has past `pos`; returns where it got to. */
async function forwardFrom(c: SyslogConfig, file: string, pos: number): Promise<number> {
  const { lines } = readLines(file, pos);
  if (!lines.length) return pos;
  const messages: string[] = [];
  for (const l of lines) {
    try {
      messages.push(formatSyslog(JSON.parse(l.text)));
    } catch {
      // not an entry (a torn line): skipped, not sent as garbage
      messages.push("");
    }
  }
  await send(c, messages.filter(Boolean));
  st.status.sent += messages.filter(Boolean).length;
  st.status.lastSentAt = new Date().toISOString();
  st.status.lastError = null;
  return lines[lines.length - 1].end;
}

async function auditTick(c: SyslogConfig) {
  let s = readState();
  let cur: fs.Stats;
  try {
    cur = fs.statSync(AUDIT_FILE);
  } catch {
    return; // no log yet
  }
  if (!s) {
    startAtEnd();
    return;
  }
  if (s.ino !== cur.ino) {
    // Rotated: the rest of the old file, now audit.1.jsonl, first.
    try {
      const old = fs.statSync(ROTATED_FILE);
      if (old.ino === s.ino) {
        const at = await forwardFrom(c, ROTATED_FILE, s.pos);
        if (at < old.size) {
          saveState({ ino: s.ino, pos: at });
          return; // more of it next time
        }
      }
    } catch {
      // gone already: nothing to finish
    }
    s = { ino: cur.ino, pos: 0 };
    saveState(s);
  }
  if (cur.size < s.pos) s = { ino: cur.ino, pos: 0 }; // cut short: from the start
  const at = await forwardFrom(c, AUDIT_FILE, s.pos);
  if (at !== s.pos) saveState({ ino: cur.ino, pos: at });
}

async function tick() {
  const c = readSyslogConfig();
  if (!c.enabled || !c.host || st.busy) return;
  if (c.protocol === "tcp" && Date.now() < st.tcpDownUntil) return;
  st.busy = true;
  try {
    await auditTick(c);
    if (c.journal) await journalTick(c);
  } catch (err) {
    failed(err);
    if (c.protocol === "tcp") {
      st.tcp?.destroy();
      st.tcp = null;
      st.tcpDownUntil = Date.now() + TCP_RETRY_MS;
    }
  } finally {
    st.busy = false;
  }
}

// ─── the system journal ──────────────────────────────────────────────────────
// Read with journalctl as JSON, after the cursor of the last entry sent; the
// service may read the journal through its systemd-journal group
// (xenman.service). Debug messages stay behind.

const JOURNALCTL = process.env.XENMAN_JOURNALCTL || "journalctl";
const JOURNAL_STATE = path.join(DATA_DIR, "updates", "syslog-journal.json");
/** Entries per tick: a backlog drains over a few ticks. */
const JOURNAL_BATCH = 1000;

interface JournalState {
  cursor: string | null;
  /** Before any entry was seen: from this moment on. */
  since?: string;
}

function readJournalState(): JournalState | null {
  try {
    return JSON.parse(fs.readFileSync(JOURNAL_STATE, "utf-8"));
  } catch {
    return null;
  }
}

function saveJournalState(s: JournalState) {
  fs.mkdirSync(path.dirname(JOURNAL_STATE), { recursive: true });
  writeFileAtomic(JOURNAL_STATE, JSON.stringify(s));
}

/** Up to `max` entries, as journalctl's JSON lines; the rest waits. */
function journalLines(args: string[], max: number): Promise<{ lines: string[]; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(JOURNALCTL, ["-o", "json", "--no-pager", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ lines: [], code: -1, stderr: String(err) });
      return;
    }
    const lines: string[] = [];
    let buf = "";
    let stderr = "";
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ lines, code, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 15_000);
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0 && lines.length < max) {
        if (i > 0) lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (lines.length >= max) {
        child.kill();
        finish(0);
      }
    });
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    child.on("error", (err) => {
      stderr += String(err);
      finish(-1);
    });
    child.on("close", (code) => {
      if (buf.trim() && lines.length < max) lines.push(buf);
      finish(code);
    });
  });
}

/** Whether the journal can be read here: none, not allowed, or yes. */
export async function journalAvailable(): Promise<"ok" | "missing" | "no-permission"> {
  const r = await journalLines(["-n", "1"], 1);
  if (r.code === -1) return "missing";
  if (/insufficient permissions|not seeing messages from other users/i.test(r.stderr)) return "no-permission";
  return r.code === 0 || r.lines.length ? "ok" : "missing";
}

/** From now on: the newest entry's cursor, or the time when there is none. */
async function journalStartAtEnd() {
  const r = await journalLines(["-n", "1"], 1);
  let cursor: string | null = null;
  try {
    cursor = r.lines.length ? String(JSON.parse(r.lines[0]).__CURSOR) : null;
  } catch {
    cursor = null;
  }
  saveJournalState(cursor ? { cursor } : { cursor: null, since: new Date().toISOString() });
}

/** A journal field: text, or the byte array journald gives for anything else. */
function jtext(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return Buffer.from(v as number[]).toString("utf-8");
  return v === undefined || v === null ? "" : String(v);
}

/** PRIORITY as a number; info when missing -- and 0 (emergency) stays 0. */
function priority(e: Record<string, unknown>): number {
  const p = Number(jtext(e.PRIORITY));
  return jtext(e.PRIORITY) === "" || !Number.isFinite(p) ? 6 : Math.min(7, Math.max(0, p));
}

/** One journal entry as RFC 5424, with its own facility, severity and program. */
export function formatJournal(e: Record<string, unknown>, hostname = os.hostname()): string {
  const severity = priority(e);
  const fac = jtext(e.SYSLOG_FACILITY);
  const facility = fac !== "" ? Math.min(23, Math.max(0, Number(fac) || 0)) : jtext(e._TRANSPORT) === "kernel" ? 0 : 3;
  const usec = Number(jtext(e.__REALTIME_TIMESTAMP));
  const ts = Number.isFinite(usec) && usec > 0 ? new Date(Math.floor(usec / 1000)).toISOString() : new Date().toISOString();
  const host = token(jtext(e._HOSTNAME) || hostname, 255);
  const app = token(jtext(e.SYSLOG_IDENTIFIER) || jtext(e._COMM) || "-", 48);
  const pid = token(jtext(e._PID) || jtext(e.SYSLOG_PID) || "-", 128);
  const unit = jtext(e._SYSTEMD_UNIT);
  const sd = unit ? `[journal@32473 unit="${sdValue(unit)}"]` : "-";
  // One line per message: a multi-line one would break TCP framing.
  const msg = jtext(e.MESSAGE).replace(/\r?\n/g, " ");
  const line = `<${facility * 8 + severity}>1 ${ts} ${host} ${app} ${pid} - ${sd} ${msg}`;
  return Buffer.byteLength(line) > MAX_MESSAGE ? `${Buffer.from(line).subarray(0, MAX_MESSAGE - 3).toString()}...` : line;
}

async function journalTick(c: SyslogConfig) {
  const s = readJournalState();
  if (!s) {
    await journalStartAtEnd();
    return;
  }
  const since = Math.floor(Date.parse(s.since ?? "") / 1000);
  const args = s.cursor ? ["--after-cursor", s.cursor] : ["--since", Number.isFinite(since) ? `@${since}` : "now"];
  const r = await journalLines(args, JOURNAL_BATCH);
  if (!r.lines.length) return;
  const entries: Record<string, unknown>[] = [];
  for (const l of r.lines) {
    try {
      entries.push(JSON.parse(l));
    } catch {
      // a line cut off by the batch limit: read again next time
      break;
    }
  }
  if (!entries.length) return;
  const messages = entries.filter((e) => priority(e) < 7).map((e) => formatJournal(e));
  if (messages.length) {
    await send(c, messages);
    st.status.sent += messages.length;
    st.status.lastSentAt = new Date().toISOString();
    st.status.lastError = null;
  }
  saveJournalState({ cursor: jtext(entries[entries.length - 1].__CURSOR) || s.cursor });
}

/** Started once per process, from instrumentation.ts. */
export function startSyslogForwarder(): void {
  if (st.timer) return;
  st.timer = setInterval(() => void tick(), TICK_MS);
  st.timer.unref();
}
