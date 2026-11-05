#!/usr/bin/env node
//
// Who may reach the appliance's web interface: when switched on, ports 80 and
// 443 answer only the addresses allowed -- the NetScaler's (its SNIPs, both
// nodes of an HA pair), and an admin network if wanted; everything else is
// dropped, IPv4 and IPv6. SSH can be limited the same way. The VM console is
// not network traffic and stays open. Runs as root, as xenman-firewall:
//
//   xenman-firewall show [--json]          what is configured and in force
//   xenman-firewall set [options]          write and apply
//       --enabled yes|no  --allow "10.0.0.5 10.0.1.0/24"  --ssh-allow "..."
//       --by <name>                        for the audit log
//       --confirm <token> --id <id>        keep only if confirmed (see below)
//   xenman-firewall off [--by <name>]      the console menu's way back in
//   xenman-firewall apply                  at boot: what is configured
//   xenman-firewall await-confirm          internal: the rollback guard
//
// Switched on from the web interface it can lock that interface out -- a
// browser that came directly, not through the NetScaler, for one. So, as with
// the network settings, it is applied on probation: unless the browser
// confirms within CONFIRM_SECONDS -- which it can only through an allowed
// address -- the previous rules come back. The console menu applies directly.
//
// The rules live in a table of their own, "inet xenman", replaced as a whole
// with nft -f; nothing else of the firewall is touched. nftables is not in
// older images: installed with apt the first time it is switched on.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawnSync } = require("child_process");
const dw = require("./data-write");

const env = process.env;
const CONF = env.FIREWALL_CONF || "/etc/xenman/firewall.json";
// On disk, not in /run: a change still on probation when the machine goes
// down is undone at the next boot rather than kept.
const PENDING_FILE = env.FIREWALL_PENDING || "/etc/xenman/firewall-pending.json";
const DATA_DIR = env.DATA_DIR || "/var/lib/xenman";
const STATE_FILE = env.FIREWALL_STATE_FILE || path.join(DATA_DIR, "updates", "firewall-state.json");
const CONFIRM_FILE = env.FIREWALL_CONFIRM_FILE || path.join(DATA_DIR, "updates", "firewall-confirm.json");
const AUDIT_FILE = env.AUDIT_FILE || path.join(DATA_DIR, "audit.jsonl");
const AUDIT_APPEND = env.AUDIT_APPEND || path.join(__dirname, "audit-append.js");
const CMD = {
  nft: env.NFT_BIN || "nft",
  aptGet: env.APT_GET || "apt-get",
  systemdRun: env.SYSTEMD_RUN || "systemd-run",
  systemctl: env.SYSTEMCTL || "systemctl",
  self: env.XENMAN_FIREWALL || "/usr/local/sbin/xenman-firewall",
};
const CONFIRM_SECONDS = Number(env.XENMAN_FIREWALL_CONFIRM_SECONDS) || 120;
const GUARD_UNIT = "xenman-firewall-confirm";
const MAX_ENTRIES = 32;
const WEB_PORTS = "{ 80, 443 }";

class Invalid extends Error {}

// ─── addresses ───────────────────────────────────────────────────────────────

/** "10.0.0.5", "10.0.1.0/24", "2001:db8::1", "2001:db8::/48" -> { family, text }; null if not one. */
function parseEntry(s) {
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(String(s).trim());
  if (!m) return null;
  const family = net.isIPv4(m[1]) ? 4 : net.isIPv6(m[1]) ? 6 : 0;
  if (!family) return null;
  if (m[2] !== undefined) {
    const prefix = Number(m[2]);
    if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
    // nft wants the network address of a prefix: 10.0.1.7/24 is refused.
    if (family === 4 && prefix < 32) {
      const ip = m[1].split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
      const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
      const netw = (ip & mask) >>> 0;
      const text = `${[24, 16, 8, 0].map((b) => (netw >>> b) & 255).join(".")}/${prefix}`;
      return { family, text };
    }
    return { family, text: `${m[1].toLowerCase()}/${prefix}` };
  }
  return { family, text: m[1].toLowerCase() };
}

function list(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "").split(/[\s,]+/).filter(Boolean);
}

/** Checks a whole configuration; throws Invalid with a message a person can act on. */
function validate(c) {
  const entries = (what, values) => {
    const out = [];
    for (const v of values) {
      const e = parseEntry(v);
      if (!e) throw new Invalid(`${what}: ${String(v).slice(0, 60)} is not an IP address or network`);
      if (!out.includes(e.text)) out.push(e.text);
    }
    if (out.length > MAX_ENTRIES) throw new Invalid(`${what}: at most ${MAX_ENTRIES} entries`);
    return out;
  };
  const allow = entries("web access", list(c.allow));
  const sshAllow = entries("SSH", list(c.sshAllow));
  const enabled = c.enabled === true;
  if (enabled && allow.length === 0) throw new Invalid("name at least one address that may reach the web interface (the NetScaler's)");
  return { enabled, allow, sshAllow };
}

// ─── rules ───────────────────────────────────────────────────────────────────

/** The nft script: our table replaced as a whole -- created first, so the delete always finds it. */
function render(c) {
  const lines = ["table inet xenman", "delete table inet xenman"];
  if (!c.enabled && c.sshAllow.length === 0) return lines.join("\n") + "\n";
  const set = (family, entries) => entries.filter((e) => parseEntry(e).family === family).join(", ");
  const rules = ['    iif "lo" accept'];
  const limit = (ports, entries) => {
    const v4 = set(4, entries);
    const v6 = set(6, entries);
    if (v4) rules.push(`    tcp dport ${ports} ip saddr { ${v4} } accept`);
    if (v6) rules.push(`    tcp dport ${ports} ip6 saddr { ${v6} } accept`);
    // No exception for established connections: one opened before, directly,
    // is cut off too -- so a confirmation cannot come through it.
    rules.push(`    tcp dport ${ports} drop`);
  };
  if (c.enabled) limit(WEB_PORTS, c.allow);
  if (c.sshAllow.length) limit("22", c.sshAllow);
  lines.push(
    "table inet xenman {",
    "  chain input {",
    "    type filter hook input priority filter; policy accept;",
    ...rules,
    "  }",
    "}",
  );
  return lines.join("\n") + "\n";
}

function haveNft() {
  return spawnSync(CMD.nft, ["--version"], { stdio: "ignore" }).status === 0;
}

/** nftables, installed the first time it is needed -- with the proxy set for apt. */
function ensureNft() {
  if (haveNft()) return;
  const run = spawnSync(CMD.aptGet, ["install", "-y", "-q", "--no-install-recommends", "nftables"], {
    encoding: "utf-8",
    timeout: 10 * 60 * 1000,
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
  });
  if (run.status !== 0 || !haveNft()) {
    const why = (run.stderr || "").split("\n").filter((l) => /^E:/.test(l)).pop() || "apt-get install nftables failed";
    throw new Invalid(`nftables could not be installed: ${why.replace(/^E:\s*/, "").slice(0, 200)}`);
  }
}

function load(c) {
  const run = spawnSync(CMD.nft, ["-f", "-"], { input: render(c), encoding: "utf-8" });
  if (run.status !== 0) throw new Error(`nft refused the rules: ${(run.stderr || "").trim().slice(0, 300)}`);
}

// ─── state ───────────────────────────────────────────────────────────────────

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONF, "utf-8"));
    return { enabled: c.enabled === true, allow: list(c.allow), sshAllow: list(c.sshAllow) };
  } catch {
    return { enabled: false, allow: [], sshAllow: [] };
  }
}

function writeRoot(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.xenman-new`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, content, { mode, flag: "wx" });
  fs.renameSync(tmp, file);
}

function save(c) {
  writeRoot(CONF, JSON.stringify(c, null, 2) + "\n");
}

function audit(action, outcome, target, detail) {
  if (!fs.existsSync(DATA_DIR)) return;
  spawnSync(process.execPath, [AUDIT_APPEND, "--file", AUDIT_FILE, "--action", action, "--outcome", outcome,
    "--target", target, ...(detail ? ["--detail", detail] : [])], { stdio: "ignore" });
}

function describe(c) {
  const web = c.enabled ? `web interface only from ${c.allow.join(", ")}` : "web interface open to all";
  return c.sshAllow.length ? `${web}; SSH only from ${c.sshAllow.join(", ")}` : web;
}

/** For the web interface, which may not read /etc/xenman as root does: through its data directory. */
function writeState(state) {
  try {
    dw.ensureDir(path.dirname(STATE_FILE), DATA_DIR);
    dw.writeFile(STATE_FILE, JSON.stringify({ ...state, config: readConfig(), at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o644 });
  } catch {
    // The guard does its job either way; the web interface just knows less.
  }
}

// ─── probation ───────────────────────────────────────────────────────────────

function readPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8")); } catch { return null; }
}

function dropPending() {
  fs.rmSync(PENDING_FILE, { force: true });
}

function confirmed(token) {
  const text = dw.readSmall(CONFIRM_FILE, 4096);
  if (!text) return false;
  let got;
  try { got = String(JSON.parse(text).token || ""); } catch { return false; }
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function restore(previous) {
  save(previous);
  try { load(previous); } catch { /* the saved file wins at the next boot */ }
}

function awaitConfirm() {
  const p = readPending();
  if (!p) return 0;
  const tick = () => {
    if (confirmed(p.token)) {
      dropPending();
      try { fs.rmSync(CONFIRM_FILE, { force: true }); } catch { /* fine */ }
      writeState({ state: "confirmed", id: p.id, message: "access rules kept" });
      audit("os_firewall_confirmed", "success", p.summary, "confirmed through an allowed address");
      return true;
    }
    if (Date.now() >= p.deadline) {
      restore(p.previous);
      dropPending();
      writeState({ state: "rolled-back", id: p.id, message: "not confirmed in time — the previous access rules are back" });
      audit("os_firewall_rolled_back", "failure", p.summary, `not confirmed within ${CONFIRM_SECONDS} seconds; previous rules restored`);
      return true;
    }
    return false;
  };
  const loop = () => { if (!tick()) setTimeout(loop, 1000); };
  loop();
  return 0;
}

// ─── commands ────────────────────────────────────────────────────────────────

function by(opts) {
  return (opts.by || "console").replace(/[^\w.@ -]/g, "").slice(0, 64) || "console";
}

function set(opts) {
  const current = readConfig();
  const c = validate({
    enabled: opts.enabled === undefined ? current.enabled : opts.enabled === "yes",
    allow: opts.allow ?? current.allow,
    sshAllow: opts.sshAllow ?? current.sshAllow,
  });
  if (c.enabled || c.sshAllow.length) ensureNft();

  if (opts.confirm) {
    if (!/^[A-Za-z0-9]{32,128}$/.test(opts.confirm)) throw new Invalid("invalid confirmation token");
    if (readPending()) throw new Invalid("a change of the access rules is still waiting for confirmation");
    try { fs.rmSync(CONFIRM_FILE, { force: true }); } catch { /* fine */ }
    const deadline = Date.now() + CONFIRM_SECONDS * 1000;
    writeRoot(PENDING_FILE, JSON.stringify({ token: opts.confirm, deadline, id: opts.id || null, previous: current, summary: describe(c) }), 0o600);
    save(c);
    load(c);
    writeState({ state: "pending", id: opts.id || null, deadline: new Date(deadline).toISOString(), message: "waiting for confirmation" });
    audit("os_firewall_changed", "success", describe(c), `requested by ${by(opts)} in the web interface; on probation for ${CONFIRM_SECONDS} seconds`);
    // A transient unit, so the guard outlives the request service that started it.
    spawnSync(CMD.systemctl, ["stop", GUARD_UNIT], { stdio: "ignore" });
    const run = spawnSync(CMD.systemdRun, ["--unit", GUARD_UNIT, "--collect", "--quiet", CMD.self, "await-confirm"], { encoding: "utf-8" });
    if (run.status !== 0) {
      // Without a guard nothing would ever bring the old rules back: undo now.
      restore(current);
      dropPending();
      writeState({ state: "rolled-back", id: opts.id || null, message: "could not start the rollback guard; nothing changed" });
      throw new Invalid("could not start the rollback guard; the previous rules were kept");
    }
    return `applied: ${describe(c)} — confirm within ${CONFIRM_SECONDS} seconds or it is undone`;
  }

  save(c);
  load(c);
  writeState({ state: "applied", message: describe(c) });
  audit("os_firewall_changed", "success", describe(c), `set by ${by(opts)}`);
  return `applied: ${describe(c)}`;
}

/** The console menu's way back in: the web interface open again, a pending change dropped. */
function off(opts) {
  const c = { ...readConfig(), enabled: false };
  spawnSync(CMD.systemctl, ["stop", GUARD_UNIT], { stdio: "ignore" });
  dropPending();
  save(c);
  if (haveNft()) load(c);
  writeState({ state: "applied", message: describe(c) });
  audit("os_firewall_changed", "success", describe(c), `switched off by ${by(opts)} at the console`);
  return `web interface open again: ${describe(c)}`;
}

/** At boot. What was on probation when the machine went down is not kept. */
function applyAtBoot() {
  const p = readPending();
  if (p) {
    save(p.previous);
    dropPending();
  }
  const c = readConfig();
  if (!c.enabled && c.sshAllow.length === 0 && !haveNft()) return "nothing to apply";
  load(c);
  return `applied: ${describe(c)}`;
}

function show(json) {
  const c = readConfig();
  const pending = readPending();
  if (json) return JSON.stringify({ config: c, pending: Boolean(pending), nft: haveNft() }, null, 2);
  return [
    `  Web interface  ${c.enabled ? `only from ${c.allow.join(", ")}` : "open to all"}`,
    `  SSH            ${c.sshAllow.length ? `only from ${c.sshAllow.join(", ")}` : "not limited by address"}`,
    ...(pending ? ["  A change is waiting for confirmation from the web interface."] : []),
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Invalid(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === "json") { opts.json = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Invalid(`missing value for ${a}`);
    if (key === "allow") opts.allow = list(value);
    else if (key === "ssh-allow") opts.sshAllow = list(value);
    else if (key === "enabled") {
      if (value !== "yes" && value !== "no") throw new Invalid("--enabled must be yes or no");
      opts.enabled = value;
    } else if (["by", "confirm", "id"].includes(key)) opts[key] = value;
    else throw new Invalid(`unknown option: ${a}`);
  }
  return opts;
}

module.exports = { validate, render, parseEntry };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "show") console.log(show(parseArgs(rest).json));
    else if (cmd === "set") console.log(set(parseArgs(rest)));
    else if (cmd === "off") console.log(off(parseArgs(rest)));
    else if (cmd === "apply") console.log(applyAtBoot());
    else if (cmd === "await-confirm") process.exitCode = awaitConfirm();
    else throw new Invalid("usage: xenman-firewall show [--json] | set [options] | off | apply");
  } catch (err) {
    console.error(`xenman-firewall: ${err instanceof Invalid ? err.message : `failed: ${err.message}`}`);
    process.exitCode = err instanceof Invalid ? 2 : 1;
  }
}
