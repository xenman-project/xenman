import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// The appliance's clock: which zone it runs in and where it gets its time.
// Read unprivileged through timedatectl; changed as root by xenman-os-request
// ("set-time"), which writes the NTP servers to this drop-in.
const NTP_CONF = "/etc/systemd/timesyncd.conf.d/50-xenman.conf";
export const MAX_NTP_SERVERS = 5;

export interface TimeInfo {
  /** The server's clock when this was read, to compare with the browser's. */
  now: string;
  timezone: string | null;
  ntpEnabled: boolean | null;
  synchronized: boolean | null;
  /** The server timesyncd talks to right now. */
  server: string | null;
  /** Set here; empty means Debian's defaults apply. */
  configured: string[];
  defaults: string[];
}

export interface TimeInput {
  timezone?: string;
  ntpServers?: string[];
}

function props(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

async function timedatectl(args: string[]): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync("timedatectl", args, { timeout: 5000 });
    return props(stdout);
  } catch {
    return {};
  }
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter(Boolean);
}

export function configuredServers(): string[] {
  try {
    const m = /^NTP=(.*)$/m.exec(fs.readFileSync(NTP_CONF, "utf-8"));
    return list(m?.[1]);
  } catch {
    return [];
  }
}

export async function timeInfo(): Promise<TimeInfo> {
  const [main, sync] = await Promise.all([
    timedatectl(["show"]),
    timedatectl(["show-timesync"]),
  ]);
  const yes = (v: string | undefined) => (v === undefined ? null : v === "yes");
  return {
    now: new Date().toISOString(),
    timezone: main.Timezone || null,
    ntpEnabled: yes(main.NTP),
    synchronized: yes(main.NTPSynchronized),
    server: sync.ServerName ? `${sync.ServerName}${sync.ServerAddress ? ` (${sync.ServerAddress})` : ""}` : null,
    configured: configuredServers(),
    defaults: list(sync.FallbackNTPServers),
  };
}

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const ZONE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * Checks the shape of what the browser sent, for a useful message. The root
 * side checks again -- the zone against /usr/share/zoneinfo -- and decides.
 */
export function parseTimeInput(body: unknown): { time: TimeInput } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request" };
  const b = body as Record<string, unknown>;
  const time: TimeInput = {};
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== "string" || !ZONE.test(b.timezone)) return { error: "Unknown time zone" };
    time.timezone = b.timezone;
  }
  if (b.ntpServers !== undefined) {
    if (!Array.isArray(b.ntpServers)) return { error: "Invalid NTP server list" };
    const servers = b.ntpServers.map((s) => (typeof s === "string" ? s.trim().replace(/^\[|\]$/g, "") : ""));
    const filled = servers.filter(Boolean);
    if (filled.length > MAX_NTP_SERVERS) return { error: `At most ${MAX_NTP_SERVERS} NTP servers` };
    const bad = filled.find((s) => !HOST.test(s) && !(s.includes(":") && IPV6.test(s)));
    if (bad !== undefined) return { error: `"${bad.slice(0, 64)}" is not a host name or address` };
    time.ntpServers = [...new Set(filled)];
  }
  if (time.timezone === undefined && time.ntpServers === undefined) return { error: "Nothing to change" };
  return { time };
}
