import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import type { TimeInput } from "./appliance-time";
import type { NetworkConfig } from "./appliance-network";
import type { FirewallConfig } from "./appliance-firewall";

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const UPDATE_DIR = path.join(DATA_DIR, "updates");
const STATUS_FILE = path.join(UPDATE_DIR, "os-status.json");
const REQUEST_FILE = path.join(UPDATE_DIR, "os-request.json");
const RESULT_FILE = path.join(UPDATE_DIR, "os-request-result.json");

// Written by root; readable here, never writable.
const POLICY_FILE = "/etc/xenman/os-update-policy.json";
// What the proxy is, without its password -- that stays in a root-only file.
const PROXY_FILE = "/etc/xenman/proxy.json";
// Written by xenman-os-update while it installs, and kept until the next run.
const INSTALL_LOG = "/var/log/xenman/os-install.log";
const LOG_CHUNK = 64 * 1024;
const REBOOT_REQUIRED = "/var/run/reboot-required";
const REBOOT_PACKAGES = "/var/run/reboot-required.pkgs";
// Touched by apt whenever the package lists were refreshed successfully.
const UPDATE_STAMP = "/var/lib/apt/periodic/update-success-stamp";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface OsPolicy {
  mode: "window" | "manual";
  days: string[];
  time: string;
  timezone: string;
  rebootInWindow: boolean;
  changedAt?: string;
}

export interface OsStatus {
  lastRun?: string;
  lastCheck?: string;
  outcome?: "installed" | "nothing" | "failed";
  packages?: string[];
  rebootRequired?: boolean;
  deferred?: string;
  log?: string[];
}

export interface PendingPackage {
  name: string;
  /** null for a package that is new -- a kernel update always is one. */
  from: string | null;
  to: string;
}

export type OsAction = "set-policy" | "set-proxy" | "set-time" | "set-network" | "set-firewall" | "check" | "install-now" | "reboot";

export interface ProxyInfo {
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
  changedAt?: string;
}

/** What goes to the root side; a missing password keeps the stored one. */
export interface ProxyInput {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface OsRequestResult {
  id: string | null;
  action: OsAction | null;
  state: "running" | "done" | "failed";
  message: string;
  requestedBy: string | null;
  startedAt?: string;
  finishedAt?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function readPolicy(): OsPolicy | null {
  return readJson<OsPolicy>(POLICY_FILE);
}

export interface InstallLogChunk {
  exists: boolean;
  /** The log's first line, which names the run; a different one means a new run. */
  run: string | null;
  text: string;
  /** Where to continue next time. */
  next: number;
  /** True when this starts over: a new run replaced the log since the last read. */
  reset: boolean;
}

export function installLogExists(): boolean {
  return fs.existsSync(INSTALL_LOG);
}

/**
 * The installation log from byte `from` on, at most LOG_CHUNK at a time and
 * only up to the last complete line, so neither a line nor a UTF-8 character
 * is ever cut in two. Without `from`, the end of the log: a long one is not
 * sent whole to a browser that only wants to see how it finished.
 */
export function readInstallLog(from: number | null, run: string | null): InstallLogChunk {
  let fd: number;
  try {
    fd = fs.openSync(INSTALL_LOG, "r");
  } catch {
    return { exists: false, run: null, text: "", next: 0, reset: from !== null };
  }
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 512));
    fs.readSync(fd, head, 0, head.length, 0);
    const current = head.toString("utf-8").split("\n")[0] || null;

    let start = from ?? Math.max(0, size - LOG_CHUNK);
    let reset = false;
    if (from !== null && (start > size || run !== current)) {
      start = 0;
      reset = true;
    }
    const buf = Buffer.alloc(Math.min(LOG_CHUNK, size - start));
    const read = buf.length ? fs.readSync(fd, buf, 0, buf.length, start) : 0;
    let bytes = buf.subarray(0, read);
    // Starting in the middle of the log: begin with the next whole line.
    if (from === null && start > 0) {
      const nl = bytes.indexOf(0x0a);
      start += nl + 1;
      bytes = bytes.subarray(nl + 1);
    }
    const last = bytes.lastIndexOf(0x0a);
    const whole =
      last >= 0
        ? bytes.subarray(0, last + 1)
        : bytes.length === LOG_CHUNK
          ? bytes
          : bytes.subarray(0, 0);
    return {
      exists: true,
      run: current,
      text: whole.toString("utf-8"),
      next: start + whole.length,
      reset,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function readProxyInfo(): ProxyInfo | null {
  return readJson<ProxyInfo>(PROXY_FILE);
}

export function readOsStatus(): OsStatus | null {
  return readJson<OsStatus>(STATUS_FILE);
}

export function readRequestResult(): OsRequestResult | null {
  return readJson<OsRequestResult>(RESULT_FILE);
}

export function rebootInfo(): { required: boolean; packages: string[] } {
  let packages: string[] = [];
  try {
    packages = [
      ...new Set(fs.readFileSync(REBOOT_PACKAGES, "utf-8").split("\n").filter(Boolean)),
    ];
  } catch {
    // no list, or no restart pending
  }
  return { required: fs.existsSync(REBOOT_REQUIRED), packages };
}

/**
 * Which boot this is and which kernel it runs. The boot id changes with every
 * start of the machine, which is how the restart page knows the restart has
 * really happened rather than the web server merely answering again.
 */
export function bootInfo(): { bootId: string | null; kernel: string | null } {
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, "utf-8").trim() || null;
    } catch {
      return null;
    }
  };
  return {
    bootId: read("/proc/sys/kernel/random/boot_id"),
    kernel: read("/proc/sys/kernel/osrelease"),
  };
}

// ─── pending security updates ────────────────────────────────────────────────

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** When apt last refreshed its package lists, the daily run or "Check now". */
export function listsUpdatedAt(): string | null {
  const at = mtime(UPDATE_STAMP);
  return at ? new Date(at).toISOString() : null;
}

let pendingCache: { at: number; packages: PendingPackage[] | null } = {
  at: 0,
  packages: null,
};
const PENDING_CACHE_MS = 5 * 60 * 1000;

/**
 * What unattended-upgrades would install, by simulating a dist-upgrade and
 * keeping what comes from the security archive. dist-upgrade and not upgrade:
 * Debian gives every kernel update a new package name, and upgrade holds back
 * anything that needs a new package -- so kernel updates, the ones that matter
 * most, never showed up as pending.
 *
 * Runs unprivileged and may fail under the service sandbox; null then means
 * "not known", not "none".
 */
export async function pendingSecurityPackages(): Promise<PendingPackage[] | null> {
  // A run that installed something rewrites the status file, and a refresh of
  // the package lists touches the stamp; the list from before either is stale
  // however young it is.
  const changed = Math.max(mtime(STATUS_FILE), mtime(UPDATE_STAMP));
  if (Date.now() - pendingCache.at < PENDING_CACHE_MS && changed < pendingCache.at) {
    return pendingCache.packages;
  }

  let packages: PendingPackage[] | null = null;
  try {
    const { stdout } = await execFileAsync(
      "apt-get",
      ["-s", "-o", "Debug::NoLocking=1", "dist-upgrade"],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    packages = parseSimulation(stdout);
  } catch {
    packages = null;
  }
  pendingCache = { at: Date.now(), packages };
  return packages;
}

/**
 * Reads "Inst" lines of an apt simulation:
 *   Inst openssl [3.5.1-1] (3.5.1-1+deb13u1 Debian-Security:13/stable-security [amd64])
 *   Inst linux-image-6.12.108+deb13-amd64 (6.12.108-1 Debian-Security:13/stable-security [amd64])
 */
export function parseSimulation(output: string): PendingPackage[] {
  const packages: PendingPackage[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^Inst (\S+)(?: \[([^\]]*)\])? \((\S+) ([^)]*)\)/);
    if (!m) continue;
    const [, name, from, to, origins] = m;
    // Only what the policy installs; point-release updates wait for a new .xva.
    if (!/security/i.test(origins)) continue;
    packages.push({ name, from: from || null, to });
  }
  return packages;
}

// ─── when the next run is ────────────────────────────────────────────────────

/**
 * Asked of systemd itself, so it is the schedule really in effect -- as an ISO
 * timestamp rather than systemd's text, which comes in the system zone. The
 * appliance runs on UTC, and "Sun 00:00 UTC" under a window of "02:00 Europe/
 * Berlin" reads like a mistake even when it is the same moment; the interface
 * shows it in the window's own zone instead.
 */
export async function nextRun(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["list-timers", "apt-daily-upgrade.timer", "--all", "--output=json"],
      { timeout: 10_000 },
    );
    const micros = (JSON.parse(stdout) as Array<{ next?: number }>)[0]?.next;
    return micros ? new Date(micros / 1000).toISOString() : null;
  } catch {
    return null;
  }
}

// ─── requests to the root side ───────────────────────────────────────────────

export class OsRequestError extends Error {}

/** A request is in flight until the root side has picked it up and finished it. */
export function requestPending(): boolean {
  if (fs.existsSync(REQUEST_FILE)) return true;
  return readRequestResult()?.state === "running";
}

/**
 * Parses what the browser sent into a policy request. Only the shape is
 * checked here, for a useful error message: the root side validates again and
 * is the one that decides, so nothing here can widen what it accepts.
 */
export function parsePolicyInput(body: unknown): { policy: Partial<OsPolicy> } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request" };
  const b = body as Record<string, unknown>;
  const policy: Partial<OsPolicy> = {};
  if (b.mode !== undefined) {
    if (b.mode !== "window" && b.mode !== "manual") return { error: "Unknown mode" };
    policy.mode = b.mode;
  }
  if (b.days !== undefined) {
    if (
      !Array.isArray(b.days) ||
      b.days.length === 0 ||
      !b.days.every((d) => typeof d === "string" && (WEEKDAYS as readonly string[]).includes(d))
    ) {
      return { error: "Choose at least one weekday" };
    }
    policy.days = b.days as string[];
  }
  if (b.time !== undefined) {
    if (typeof b.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) {
      return { error: "Time must be HH:MM" };
    }
    policy.time = b.time;
  }
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== "string" || b.timezone.length > 64) {
      return { error: "Unknown time zone" };
    }
    policy.timezone = b.timezone;
  }
  if (b.rebootInWindow !== undefined) {
    if (typeof b.rebootInWindow !== "boolean") return { error: "Invalid restart setting" };
    policy.rebootInWindow = b.rebootInWindow;
  }
  if (Object.keys(policy).length === 0) return { error: "Nothing to change" };
  return { policy };
}

/**
 * Parses the proxy the browser sent; { proxy: null } removes it. As with the
 * policy, only for a useful message: the root side checks again and decides.
 */
export function parseProxyInput(body: unknown): { proxy: ProxyInput | null } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request" };
  const b = (body as { proxy?: unknown }).proxy;
  if (b === null) return { proxy: null };
  if (!b || typeof b !== "object") return { error: "Invalid request" };
  const p = b as Record<string, unknown>;
  const host = typeof p.host === "string" ? p.host.trim() : "";
  if (!host) return { error: "Enter the proxy host" };
  if (!/^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]{2,45}\]$/.test(host)) {
    return { error: "The proxy host is not a valid name or address" };
  }
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "The port must be between 1 and 65535" };
  }
  const proxy: ProxyInput = { host, port };
  for (const key of ["username", "password"] as const) {
    const v = p[key];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || v.length > (key === "username" ? 128 : 256) || /[\u0000-\u001f\u007f]/.test(v)) {
      return { error: key === "username" ? "The login is not valid" : "The password is not valid" };
    }
    proxy[key] = v;
  }
  if (proxy.password && !proxy.username) return { error: "A password needs a login" };
  return { proxy };
}

/**
 * Hands a request to xenman-os-request by dropping the file its path unit
 * watches. Written beside the target and renamed, so the root side never reads
 * half a request. One at a time: a second would race the first.
 */
export function submitRequest(
  action: OsAction,
  requestedBy: string,
  payload?:
    | { policy: Partial<OsPolicy> }
    | { proxy: ProxyInput | null }
    | { time: TimeInput }
    | { network: NetworkConfig; confirmToken: string }
    | { firewall: FirewallConfig; confirmToken: string },
): string {
  if (requestPending()) throw new OsRequestError("Another request is still being carried out");
  const id = crypto.randomUUID();
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const tmp = `${REQUEST_FILE}.${process.pid}.tmp`;
  // 0600: a proxy request carries a password until the root side takes it.
  fs.writeFileSync(tmp, JSON.stringify({ id, action, requestedBy, ...payload }), {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tmp, REQUEST_FILE);
  return id;
}
