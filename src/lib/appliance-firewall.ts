import fs from "fs";
import path from "path";
import crypto from "crypto";
import { writeFileAtomic } from "./atomic-write";
import { ipAllowedBy, parseIpEntry } from "./ip-match";

// Who may reach the appliance's web interface, set as root by xenman-firewall
// (via xenman-os-request, "set-firewall"): the saved rules in
// /etc/xenman/firewall.json, a change on probation reported in
// firewall-state.json. A change is kept only if the browser confirms it --
// which it can only through an address the new rules allow.
const CONF = "/etc/xenman/firewall.json";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const STATE_FILE = path.join(DATA_DIR, "updates", "firewall-state.json");
const CONFIRM_FILE = path.join(DATA_DIR, "updates", "firewall-confirm.json");
const TOKEN_FILE = path.join(DATA_DIR, "updates", "firewall-token.json");
const MAX_ENTRIES = 32;

export interface FirewallConfig {
  enabled: boolean;
  /** Addresses or networks that may reach ports 80 and 443: the NetScaler's, an admin network. */
  allow: string[];
  /** When not empty: the only addresses SSH answers. */
  sshAllow: string[];
}

export interface FirewallState {
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

export function readFirewall(): { config: FirewallConfig; state: FirewallState | null } {
  const c = readJson<Partial<FirewallConfig>>(CONF);
  return {
    config: { enabled: c?.enabled === true, allow: c?.allow ?? [], sshAllow: c?.sshAllow ?? [] },
    state: readJson<FirewallState>(STATE_FILE),
  };
}

// ─── checking input ──────────────────────────────────────────────────────────
// The same rules as firewall.js, for an answer before anything is sent; the
// root side checks again and decides.

function words(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? v.map((x) => x.trim()).filter(Boolean) : null;
  if (typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  return null;
}

export function parseFirewallInput(body: unknown): { firewall: FirewallConfig } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request" };
  const b = body as Record<string, unknown>;
  const lists: Record<"allow" | "sshAllow", string[]> = { allow: [], sshAllow: [] };
  for (const key of ["allow", "sshAllow"] as const) {
    const w = words(b[key]);
    if (!w) return { error: "Invalid address list" };
    const bad = w.find((x) => !parseIpEntry(x));
    if (bad) return { error: `${bad.slice(0, 60)} is not an IP address or network (like 10.0.0.5 or 10.0.1.0/24)` };
    if (w.length > MAX_ENTRIES) return { error: `At most ${MAX_ENTRIES} entries` };
    lists[key] = [...new Set(w)];
  }
  const enabled = b.enabled === true;
  if (enabled && lists.allow.length === 0) {
    return { error: "Name at least one address that may reach the web interface — the NetScaler's" };
  }
  return { firewall: { enabled, ...lists } };
}

/** Whether an address falls under one of the entries. */
export const allowedBy = ipAllowedBy;

export function describeFirewall(f: FirewallConfig): string {
  const web = f.enabled ? `web interface only from ${f.allow.join(", ")}` : "web interface open to all";
  return f.sshAllow.length ? `${web}; SSH only from ${f.sshAllow.join(", ")}` : web;
}

// ─── confirmation ────────────────────────────────────────────────────────────

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

export function rememberFirewallToken(token: string): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  writeFileAtomic(TOKEN_FILE, JSON.stringify({ sha256: sha(token).toString("hex") }), 0o600);
}

/** The browser reached XenMan under the new rules: keep them. The root side compares the token again. */
export function confirmFirewall(token: unknown): "ok" | "nothing-pending" | "invalid" {
  if (typeof token !== "string" || !/^[A-Za-z0-9]{32,128}$/.test(token)) return "invalid";
  const state = readFirewall().state;
  if (state?.state !== "pending" || !state.deadline || Date.parse(state.deadline) < Date.now()) return "nothing-pending";
  const expected = Buffer.from(readJson<{ sha256?: string }>(TOKEN_FILE)?.sha256 ?? "", "hex");
  if (expected.length !== 32 || !crypto.timingSafeEqual(expected, sha(token))) return "invalid";
  writeFileAtomic(CONFIRM_FILE, JSON.stringify({ token }), 0o644);
  return "ok";
}
