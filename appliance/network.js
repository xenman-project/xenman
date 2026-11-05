#!/usr/bin/env node
//
// The appliance's network settings: DHCP or a static IPv4 address, gateway,
// DNS servers, search domains and host name. Runs as root, as xenman-network:
//
//   xenman-network show [--json]           what is configured and what is live
//   xenman-network set [options]           write and apply new settings
//       --mode dhcp|static  --address 10.0.0.5/24  --gateway 10.0.0.1
//       --dns "10.0.0.2 10.0.0.3"  --domains "example.org"  --hostname xenman
//       --by <name>                        for the audit log
//       --confirm <token>                  keep only if confirmed (see below)
//   xenman-network test                    can the appliance reach what it needs
//   xenman-network await-confirm           internal: the rollback guard
//
// A change made from the web interface can cut that interface off -- a typo
// in the address is enough. So it is applied on probation: with --confirm the
// previous settings are kept aside, and unless the token comes back through
// the web interface (now at the new address) within CONFIRM_SECONDS, they are
// restored. The console menu applies directly: whoever sits there sees the
// result.
//
// Only one file under /etc/systemd/network is XenMan's, 05-xenman.network. It
// sorts before the image's 10-dhcp.network and so takes precedence; without
// it, that file's plain DHCP applies again.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const dns = require("dns");
const { spawnSync } = require("child_process");
const dw = require("./data-write");

const env = process.env;
const CONF = env.NETWORK_CONF || "/etc/xenman/network.json";
const NETWORKD_FILE = env.NETWORKD_FILE || "/etc/systemd/network/05-xenman.network";
const HOSTS_FILE = env.HOSTS_FILE || "/etc/hosts";
const HOSTNAME_FILE = env.HOSTNAME_FILE || "/etc/hostname";
const RUN_DIR = env.NETWORK_RUN_DIR || "/run/xenman/network";
const DATA_DIR = env.DATA_DIR || "/var/lib/xenman";
const STATE_FILE = env.NETWORK_STATE_FILE || path.join(DATA_DIR, "updates", "network-state.json");
const CONFIRM_FILE = env.NETWORK_CONFIRM_FILE || path.join(DATA_DIR, "updates", "network-confirm.json");
const SYS_CLASS_NET = env.SYS_CLASS_NET || "/sys/class/net";
const RESOLV = env.RESOLV_FILE || "/run/systemd/resolve/resolv.conf";
const PROXY_CONF = env.PROXY_CONF || "/etc/apt/apt.conf.d/90xenman-proxy";
const AUDIT_FILE = env.AUDIT_FILE || path.join(DATA_DIR, "audit.jsonl");
const AUDIT_APPEND = env.AUDIT_APPEND || path.join(__dirname, "audit-append.js");
const CMD = {
  ip: env.IP_BIN || "ip",
  networkctl: env.NETWORKCTL || "networkctl",
  hostnamectl: env.HOSTNAMECTL || "hostnamectl",
  systemdRun: env.SYSTEMD_RUN || "systemd-run",
  systemctl: env.SYSTEMCTL || "systemctl",
  self: env.XENMAN_NETWORK || "/usr/local/sbin/xenman-network",
};
const CONFIRM_SECONDS = Number(env.XENMAN_NETWORK_CONFIRM_SECONDS) || 90;
const GUARD_UNIT = "xenman-network-confirm";
const MANAGED = /^(eth0|en[a-z0-9]+)$/; // what the image's 10-dhcp.network matches

class Invalid extends Error {}

// ─── addresses ───────────────────────────────────────────────────────────────

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const v4 = (s) => s.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const isV6 = (s) => s.includes(":") && IPV6.test(s) && net.isIPv6(s);

function parseCidr(s) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(s || "");
  if (!m || !IPV4.test(m[1])) return null;
  const prefix = Number(m[2]);
  if (prefix < 1 || prefix > 32) return null;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  const ip = v4(m[1]);
  return { ip, prefix, mask, network: (ip & mask) >>> 0, broadcast: (ip | ~mask) >>> 0, text: s };
}

function list(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "").split(/[\s,]+/).filter(Boolean);
}

/** Checks a complete configuration; throws Invalid with a message a person can act on. */
function validate(c) {
  const out = { mode: c.mode, dns: [], domains: [], hostname: c.hostname };
  if (c.mode !== "dhcp" && c.mode !== "static") throw new Invalid("mode must be dhcp or static");
  if (c.mode === "static") {
    const cidr = parseCidr(c.address);
    if (!cidr) throw new Invalid("address must look like 10.0.0.5/24");
    if (cidr.prefix < 31 && (cidr.ip === cidr.network || cidr.ip === cidr.broadcast)) {
      throw new Invalid("address is the network or broadcast address of its subnet");
    }
    out.address = c.address;
    if (c.gateway) {
      if (!IPV4.test(c.gateway)) throw new Invalid("gateway must be an IPv4 address");
      const gw = v4(c.gateway);
      if (((gw & cidr.mask) >>> 0) !== cidr.network) throw new Invalid(`gateway ${c.gateway} is not in ${c.address}`);
      if (gw === cidr.ip) throw new Invalid("gateway is the appliance's own address");
      out.gateway = c.gateway;
    }
  }
  const servers = [...new Set(list(c.dns))];
  if (servers.length > 3) throw new Invalid("at most 3 DNS servers");
  for (const s of servers) if (!IPV4.test(s) && !isV6(s)) throw new Invalid(`DNS server ${s.slice(0, 40)} is not an IP address`);
  if (c.mode === "static" && servers.length === 0) throw new Invalid("a static address needs at least one DNS server");
  out.dns = servers;
  const domains = [...new Set(list(c.domains))];
  if (domains.length > 6) throw new Invalid("at most 6 search domains");
  for (const d of domains) if (!DOMAIN.test(d)) throw new Invalid(`search domain ${d.slice(0, 40)} is not a domain name`);
  out.domains = domains;
  if (!c.hostname || !HOSTNAME.test(c.hostname)) {
    throw new Invalid("host name: letters, digits and hyphens, up to 63, not starting or ending with a hyphen");
  }
  return out;
}

// ─── files ───────────────────────────────────────────────────────────────────

function readText(file) {
  try { return fs.readFileSync(file, "utf-8"); } catch { return null; }
}

function currentHostname() {
  return (readText(HOSTNAME_FILE) || "").trim() || require("os").hostname();
}

/** What is configured: the saved settings, or the image's plain DHCP. */
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONF, "utf-8"));
    return { ...c, hostname: currentHostname() };
  } catch {
    return { mode: "dhcp", dns: [], domains: [], hostname: currentHostname() };
  }
}

function render(c) {
  const lines = [
    "# Managed by XenMan (Settings > Network, or xenman-setup on the console).",
    "# Changes here are overwritten; without this file, 10-dhcp.network applies.",
    "",
    "[Match]",
    "Name=eth0 en*",
    "",
    "[Network]",
  ];
  if (c.mode === "dhcp") lines.push("DHCP=yes");
  else {
    lines.push(`Address=${c.address}`);
    if (c.gateway) lines.push(`Gateway=${c.gateway}`);
  }
  for (const s of c.dns) lines.push(`DNS=${s}`);
  if (c.domains.length) lines.push(`Domains=${c.domains.join(" ")}`);
  if (c.mode === "dhcp" && c.dns.length) {
    // Servers set here replace, not add to, what the DHCP server hands out.
    lines.push("", "[DHCPv4]", "UseDNS=no");
    if (c.domains.length) lines.push("UseDomains=no");
  }
  return lines.join("\n") + "\n";
}

function writeRoot(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.xenman-new`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, content, { mode, flag: "wx" });
  fs.renameSync(tmp, file);
}

function setHostname(name) {
  if (name === currentHostname()) return;
  const run = spawnSync(CMD.hostnamectl, ["set-hostname", name], { encoding: "utf-8" });
  if (run.status !== 0) {
    // No hostnamed (a chroot, say): the file and the kernel directly.
    writeRoot(HOSTNAME_FILE, `${name}\n`);
    spawnSync("hostname", [name]);
  }
  const hosts = readText(HOSTS_FILE);
  if (hosts !== null) {
    const line = `127.0.1.1\t${name}`;
    const next = /^127\.0\.1\.1\s.*$/m.test(hosts) ? hosts.replace(/^127\.0\.1\.1\s.*$/m, line) : `${hosts.trimEnd()}\n${line}\n`;
    writeRoot(HOSTS_FILE, next);
  }
}

function managedInterfaces() {
  try {
    return fs.readdirSync(SYS_CLASS_NET).filter((n) => MANAGED.test(n));
  } catch {
    return [];
  }
}

function apply(c) {
  writeRoot(NETWORKD_FILE, render(c));
  const { hostname, ...saved } = c;
  writeRoot(CONF, JSON.stringify({ ...saved, changedAt: new Date().toISOString() }, null, 2) + "\n");
  setHostname(hostname);
  spawnSync(CMD.networkctl, ["reload"], { encoding: "utf-8" });
  for (const ifname of managedInterfaces()) {
    spawnSync(CMD.networkctl, ["reconfigure", ifname], { encoding: "utf-8" });
  }
}

function snapshot() {
  return { conf: readText(CONF), networkd: readText(NETWORKD_FILE), hostname: currentHostname() };
}

function restore(s) {
  for (const [file, content] of [[CONF, s.conf], [NETWORKD_FILE, s.networkd]]) {
    if (content === null) fs.rmSync(file, { force: true });
    else writeRoot(file, content);
  }
  setHostname(s.hostname);
  spawnSync(CMD.networkctl, ["reload"], { encoding: "utf-8" });
  for (const ifname of managedInterfaces()) spawnSync(CMD.networkctl, ["reconfigure", ifname], { encoding: "utf-8" });
}

function audit(action, outcome, target, detail) {
  if (!fs.existsSync(DATA_DIR)) return;
  spawnSync(process.execPath, [AUDIT_APPEND, "--file", AUDIT_FILE, "--action", action, "--outcome", outcome,
    "--target", target, ...(detail ? ["--detail", detail] : [])], { stdio: "ignore" });
}

function describe(c) {
  const parts = [c.mode === "dhcp" ? "DHCP" : `${c.address}${c.gateway ? ` via ${c.gateway}` : ""}`];
  if (c.dns.length) parts.push(`DNS ${c.dns.join(", ")}`);
  if (c.domains.length) parts.push(`search ${c.domains.join(" ")}`);
  parts.push(`host name ${c.hostname}`);
  return parts.join("; ");
}

/** What the web interface may read about a change on probation. */
function writeState(state) {
  try {
    dw.ensureDir(path.dirname(STATE_FILE), DATA_DIR);
    dw.writeFile(STATE_FILE, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o644 });
  } catch {
    // The guard does its job either way; the web interface just knows less.
  }
}

// ─── live state ──────────────────────────────────────────────────────────────

function ipJson(args) {
  const run = spawnSync(CMD.ip, ["-j", ...args], { encoding: "utf-8" });
  try { return JSON.parse(run.stdout); } catch { return []; }
}

function live() {
  const links = ipJson(["addr", "show"]).filter((l) => MANAGED.test(l.ifname));
  const routes = ipJson(["route", "show", "default"]);
  const nameservers = (readText(RESOLV) || "").split("\n")
    .map((l) => /^nameserver\s+(\S+)/.exec(l)?.[1]).filter(Boolean);
  return {
    interfaces: links.map((l) => ({
      name: l.ifname,
      mac: l.address || null,
      up: (l.flags || []).includes("UP") && l.operstate !== "DOWN",
      addresses: (l.addr_info || []).filter((a) => a.scope === "global").map((a) => `${a.local}/${a.prefixlen}`),
    })),
    gateway: routes[0]?.gateway || null,
    dns: nameservers,
    hostname: currentHostname(),
  };
}

// ─── probation ───────────────────────────────────────────────────────────────

function pendingFile() { return path.join(RUN_DIR, "pending.json"); }

function readPending() {
  try { return JSON.parse(fs.readFileSync(pendingFile(), "utf-8")); } catch { return null; }
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

function awaitConfirm() {
  const p = readPending();
  if (!p) return 0;
  const tick = () => {
    if (confirmed(p.token)) {
      fs.rmSync(RUN_DIR, { recursive: true, force: true });
      try { fs.rmSync(CONFIRM_FILE, { force: true }); } catch { /* fine */ }
      writeState({ state: "confirmed", id: p.id, message: "network settings kept" });
      audit("os_network_confirmed", "success", p.summary, `confirmed from the new address`);
      return true;
    }
    if (Date.now() >= p.deadline) {
      restore(p.previous);
      fs.rmSync(RUN_DIR, { recursive: true, force: true });
      writeState({ state: "rolled-back", id: p.id, message: "not confirmed in time — the previous network settings are back" });
      audit("os_network_rolled_back", "failure", p.summary, `not confirmed within ${CONFIRM_SECONDS} seconds; previous settings restored`);
      return true;
    }
    return false;
  };
  const loop = () => { if (!tick()) setTimeout(loop, 1000); };
  loop();
  return 0;
}

// ─── commands ────────────────────────────────────────────────────────────────

function set(opts) {
  const current = readConfig();
  const wanted = {
    mode: opts.mode ?? current.mode,
    address: opts.address ?? current.address,
    gateway: opts.gateway ?? current.gateway,
    dns: opts.dns ?? current.dns,
    domains: opts.domains ?? current.domains,
    hostname: opts.hostname ?? current.hostname,
  };
  if (opts.mode === "dhcp") { delete wanted.address; delete wanted.gateway; }
  if (opts.gateway === "") delete wanted.gateway;
  const c = validate(wanted);
  const by = (opts.by || "console").replace(/[^\w.@ -]/g, "").slice(0, 64) || "console";

  if (opts.confirm) {
    if (!/^[A-Za-z0-9]{32,128}$/.test(opts.confirm)) throw new Invalid("invalid confirmation token");
    if (readPending()) throw new Invalid("a network change is still waiting for confirmation");
    const previous = snapshot();
    fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
    try { fs.rmSync(CONFIRM_FILE, { force: true }); } catch { /* fine */ }
    const deadline = Date.now() + CONFIRM_SECONDS * 1000;
    writeRoot(pendingFile(), JSON.stringify({ token: opts.confirm, deadline, id: opts.id || null, previous, summary: describe(c) }), 0o600);
    writeState({ state: "pending", id: opts.id || null, deadline: new Date(deadline).toISOString(), message: "waiting for confirmation" });
    apply(c);
    audit("os_network_changed", "success", describe(c), `requested by ${by} in the web interface; on probation for ${CONFIRM_SECONDS} seconds`);
    // A transient unit, so the guard outlives the request service that started it.
    spawnSync(CMD.systemctl, ["stop", GUARD_UNIT], { stdio: "ignore" });
    const run = spawnSync(CMD.systemdRun, ["--unit", GUARD_UNIT, "--collect", "--quiet", CMD.self, "await-confirm"], { encoding: "utf-8" });
    if (run.status !== 0) {
      // Without a guard nothing would ever restore the old settings: undo now.
      restore(previous);
      fs.rmSync(RUN_DIR, { recursive: true, force: true });
      writeState({ state: "rolled-back", id: opts.id || null, message: "could not start the rollback guard; nothing changed" });
      throw new Invalid("could not start the rollback guard; the previous settings were kept");
    }
    return `applied: ${describe(c)} — confirm within ${CONFIRM_SECONDS} seconds or it is undone`;
  }

  apply(c);
  writeState({ state: "applied", message: describe(c) });
  audit("os_network_changed", "success", describe(c), `set by ${by}`);
  return `applied: ${describe(c)}`;
}

function tcp(host, port, ms = 4000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: ms });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });
}

async function test() {
  const l = live();
  const out = [];
  const say = (ok, text) => out.push(`  ${ok ? "OK  " : "FAIL"}  ${text}`);
  const addrs = l.interfaces.flatMap((i) => i.addresses);
  say(addrs.length > 0, `address: ${addrs.join(", ") || "none"}`);
  say(Boolean(l.gateway), `default gateway: ${l.gateway || "none"}`);
  say(l.dns.length > 0, `DNS servers: ${l.dns.join(", ") || "none"}`);
  let resolved = null;
  try { resolved = (await dns.promises.lookup("deb.debian.org")).address; } catch { /* below */ }
  say(Boolean(resolved), `name resolution: deb.debian.org ${resolved ? `-> ${resolved}` : "failed"}`);
  const proxy = /Acquire::http::Proxy "http:\/\/(?:[^@"]*@)?([^:/"]+):(\d+)\//.exec(readText(PROXY_CONF) || "");
  if (proxy) say(await tcp(proxy[1], Number(proxy[2])), `proxy ${proxy[1]}:${proxy[2]} reachable`);
  else if (resolved) say(await tcp("deb.debian.org", 80), "deb.debian.org:80 reachable (security updates)");
  return out.join("\n");
}

function show(json) {
  const c = readConfig();
  const l = live();
  if (json) return JSON.stringify({ config: c, live: l, pending: Boolean(readPending()) }, null, 2);
  const lines = [
    `  Configured   ${c.mode === "dhcp" ? "DHCP" : `static ${c.address}`}`,
    ...(c.mode === "static" ? [`  Gateway      ${c.gateway || "-"}`] : []),
    `  DNS          ${c.dns.length ? c.dns.join(", ") : c.mode === "dhcp" ? "from DHCP" : "-"}`,
    `  Search       ${c.domains.length ? c.domains.join(" ") : "-"}`,
    `  Host name    ${c.hostname}`,
    "",
    ...l.interfaces.map((i) => `  ${i.name.padEnd(12)} ${i.up ? "up  " : "down"}  ${i.addresses.join(", ") || "no address"}  ${i.mac || ""}`),
    `  Gateway now  ${l.gateway || "none"}`,
    `  DNS now      ${l.dns.join(", ") || "none"}`,
  ];
  return lines.join("\n");
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
    if (key === "dns" || key === "domains") opts[key] = list(value);
    else if (["mode", "address", "gateway", "hostname", "by", "confirm", "id"].includes(key)) opts[key] = value;
    else throw new Invalid(`unknown option: ${a}`);
  }
  return opts;
}

module.exports = { validate, render, parseCidr };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  (async () => {
    try {
      if (cmd === "show") console.log(show(parseArgs(rest).json));
      else if (cmd === "set") console.log(set(parseArgs(rest)));
      else if (cmd === "test") console.log(await test());
      else if (cmd === "await-confirm") process.exitCode = awaitConfirm();
      else throw new Invalid("usage: xenman-network show [--json] | set [options] | test");
    } catch (err) {
      console.error(`xenman-network: ${err instanceof Invalid ? err.message : `failed: ${err.message}`}`);
      process.exitCode = err instanceof Invalid ? 2 : 1;
    }
  })();
}
