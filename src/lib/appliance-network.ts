import fs from "fs";
import crypto from "crypto";
import os from "os";
import net from "net";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileAtomic } from "./atomic-write";

const execFileAsync = promisify(execFile);

// The appliance's network settings. Changed as root by xenman-network (via
// xenman-os-request, "set-network"), which keeps the saved settings in
// network.json and reports a change on probation in network-state.json. A
// change is kept only if the browser confirms it from the new address,
// through network-confirm.json.
const CONF = "/etc/xenman/network.json";
const RESOLV = "/run/systemd/resolve/resolv.conf";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const STATE_FILE = path.join(DATA_DIR, "updates", "network-state.json");
const CONFIRM_FILE = path.join(DATA_DIR, "updates", "network-confirm.json");
// A hash of the token handed out with the last change, so a wrong one can be
// told apart here; the root side still compares the token itself.
const TOKEN_FILE = path.join(DATA_DIR, "updates", "network-token.json");
const MANAGED = /^(eth0|en[a-z0-9]+)$/;

export interface NetworkConfig {
  mode: "dhcp" | "static";
  address?: string;
  gateway?: string;
  dns: string[];
  domains: string[];
  hostname: string;
}

export interface NetworkState {
  state: "pending" | "confirmed" | "rolled-back" | "applied";
  id?: string | null;
  deadline?: string;
  message?: string;
  at?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function readNetworkState(): NetworkState | null {
  return readJson<NetworkState>(STATE_FILE);
}

async function ipJson(args: string[]): Promise<Record<string, unknown>[]> {
  try {
    const { stdout } = await execFileAsync("ip", ["-j", ...args], { timeout: 5000 });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export async function networkInfo() {
  const saved = readJson<Omit<NetworkConfig, "hostname">>(CONF);
  const config: NetworkConfig = {
    mode: saved?.mode === "static" ? "static" : "dhcp",
    ...(saved?.address ? { address: saved.address } : {}),
    ...(saved?.gateway ? { gateway: saved.gateway } : {}),
    dns: saved?.dns ?? [],
    domains: saved?.domains ?? [],
    hostname: os.hostname(),
  };
  const [links, routes] = await Promise.all([ipJson(["addr", "show"]), ipJson(["route", "show", "default"])]);
  type AddrInfo = { local: string; prefixlen: number; scope: string; family: string };
  const interfaces = links
    .filter((l) => MANAGED.test(String(l.ifname)))
    .map((l) => ({
      name: String(l.ifname),
      mac: (l.address as string) || null,
      up: String(l.operstate) !== "DOWN",
      addresses: ((l.addr_info as AddrInfo[]) || [])
        .filter((a) => a.scope === "global")
        .map((a) => `${a.local}/${a.prefixlen}`),
    }));
  let dns: string[] = [];
  try {
    dns = fs
      .readFileSync(RESOLV, "utf-8")
      .split("\n")
      .map((l) => /^nameserver\s+(\S+)/.exec(l)?.[1])
      .filter((s): s is string => Boolean(s));
  } catch {
    // resolved not running
  }
  return {
    config,
    live: { interfaces, gateway: (routes[0]?.gateway as string) || null, dns },
    state: readNetworkState(),
  };
}

// ─── checking input ──────────────────────────────────────────────────────────
// The same rules as network.js, for an answer before anything is sent; the
// root side checks again and decides.

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const v4 = (s: string) => s.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

function words(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? v.map((x) => x.trim()).filter(Boolean) : null;
  if (typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  return null;
}

export function parseNetworkInput(body: unknown): { network: NetworkConfig } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request" };
  const b = body as Record<string, unknown>;
  if (b.mode !== "dhcp" && b.mode !== "static") return { error: "Choose DHCP or a static address" };
  const network: NetworkConfig = { mode: b.mode, dns: [], domains: [], hostname: "" };

  if (b.mode === "static") {
    const m = typeof b.address === "string" ? /^([\d.]+)\/(\d{1,2})$/.exec(b.address.trim()) : null;
    const prefix = m ? Number(m[2]) : 0;
    if (!m || !IPV4.test(m[1]) || prefix < 1 || prefix > 32) return { error: "Address must look like 10.0.0.5/24" };
    const mask = prefix === 32 ? 0xffffffff : ~((1 << (32 - prefix)) - 1) >>> 0;
    const ip = v4(m[1]);
    const netw = (ip & mask) >>> 0;
    if (prefix < 31 && (ip === netw || ip === (ip | ~mask) >>> 0)) {
      return { error: "That is the network or broadcast address of the subnet" };
    }
    network.address = `${m[1]}/${prefix}`;
    const gw = typeof b.gateway === "string" ? b.gateway.trim() : "";
    if (gw) {
      if (!IPV4.test(gw)) return { error: "The gateway must be an IPv4 address" };
      if (((v4(gw) & mask) >>> 0) !== netw) return { error: `The gateway ${gw} is not in ${network.address}` };
      if (v4(gw) === ip) return { error: "The gateway cannot be the appliance's own address" };
      network.gateway = gw;
    }
  }

  const dns = words(b.dns);
  if (!dns) return { error: "Invalid DNS servers" };
  if (dns.length > 3) return { error: "At most 3 DNS servers" };
  const bad = dns.find((s) => !IPV4.test(s) && !(s.includes(":") && net.isIPv6(s)));
  if (bad) return { error: `DNS server ${bad.slice(0, 40)} is not an IP address` };
  if (b.mode === "static" && dns.length === 0) return { error: "A static address needs at least one DNS server" };
  network.dns = [...new Set(dns)];

  const domains = words(b.domains);
  if (!domains) return { error: "Invalid search domains" };
  if (domains.length > 6) return { error: "At most 6 search domains" };
  const badDomain = domains.find((d) => !DOMAIN.test(d));
  if (badDomain) return { error: `${badDomain.slice(0, 40)} is not a domain name` };
  network.domains = [...new Set(domains)];

  const hostname = typeof b.hostname === "string" ? b.hostname.trim() : "";
  if (!HOSTNAME.test(hostname)) {
    return { error: "Host name: letters, digits and hyphens, up to 63, not starting or ending with a hyphen" };
  }
  network.hostname = hostname;
  return { network };
}

export function describeNetwork(n: NetworkConfig): string {
  return [
    n.mode === "dhcp" ? "DHCP" : `${n.address}${n.gateway ? ` via ${n.gateway}` : ""}`,
    n.dns.length ? `DNS ${n.dns.join(", ")}` : "",
    `host name ${n.hostname}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * The browser, now at the new address, says it can reach the appliance there.
 * Only while a change is on probation, and only the token that came with it
 * keeps it -- the root side compares.
 */
const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

export function rememberConfirmToken(token: string): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  writeFileAtomic(TOKEN_FILE, JSON.stringify({ sha256: sha(token).toString("hex") }), 0o600);
}

export function writeConfirm(token: unknown): "ok" | "nothing-pending" | "invalid" {
  if (typeof token !== "string" || !/^[A-Za-z0-9]{32,128}$/.test(token)) return "invalid";
  const state = readNetworkState();
  if (state?.state !== "pending" || !state.deadline || Date.parse(state.deadline) < Date.now()) {
    return "nothing-pending";
  }
  const expected = Buffer.from(readJson<{ sha256?: string }>(TOKEN_FILE)?.sha256 ?? "", "hex");
  if (expected.length !== 32 || !crypto.timingSafeEqual(expected, sha(token))) return "invalid";
  writeFileAtomic(CONFIRM_FILE, JSON.stringify({ token }), 0o644);
  return "ok";
}
