#!/usr/bin/env node
//
// Carries out what the web interface asks about the operating system: change
// the update policy or the proxy, look for new security updates, install them
// now, restart. Runs as
// root, as xenman-os-request, started by xenman-os-request.path when the
// request file appears.
//
// XenMan runs unprivileged and never touches apt or systemctl itself. It
// writes a request into its own data directory, and this decides. Everything
// in that file is treated as hostile: the actions are a fixed list, values go
// on as arguments rather than through a shell, and the file is opened without
// following symlinks -- otherwise XenMan could point it at /etc/shadow and
// read the answer back from an error message.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { writeFile } = require("./data-write");

const REQUEST_FILE =
  process.env.OS_REQUEST_FILE || "/var/lib/xenman/updates/os-request.json";
const RESULT_FILE =
  process.env.OS_RESULT_FILE || "/var/lib/xenman/updates/os-request-result.json";
const OS_POLICY = process.env.OS_POLICY || "/usr/local/sbin/xenman-os-policy";
const OS_UPDATE = process.env.OS_UPDATE || "/usr/local/sbin/xenman-os-update";
// Set by xenman-updater while it changes the appliance.
const APP_UPDATE_MARKER =
  process.env.APP_UPDATE_MARKER || "/var/backups/xenman-system/pending";
const AUDIT_FILE = process.env.AUDIT_FILE || "/var/lib/xenman/audit.jsonl";
const AUDIT_APPEND = process.env.AUDIT_APPEND || "/usr/local/lib/xenman/audit-append.js";
const APT_GET = process.env.APT_GET || "apt-get";
// apt's own record of the last successful refresh; XenMan shows it as "last checked".
const UPDATE_STAMP =
  process.env.UPDATE_STAMP || "/var/lib/apt/periodic/update-success-stamp";

// The proxy apt uses. Not shipped by any update package, so none resets it.
const PROXY_CONF = process.env.PROXY_CONF || "/etc/apt/apt.conf.d/90xenman-proxy";
const PROXY_INFO = process.env.PROXY_INFO || "/etc/xenman/proxy.json";

// The NTP servers set in the web interface; without the file, Debian's apply.
const NTP_CONF = process.env.NTP_CONF || "/etc/systemd/timesyncd.conf.d/50-xenman.conf";
const ZONEINFO = process.env.ZONEINFO || "/usr/share/zoneinfo";
const TIMEDATECTL = process.env.TIMEDATECTL || "timedatectl";
const MAX_NTP_SERVERS = 5;

const MAX_BYTES = 16 * 1024;
const NETWORK = process.env.XENMAN_NETWORK || "/usr/local/sbin/xenman-network";
const FIREWALL = process.env.XENMAN_FIREWALL || "/usr/local/sbin/xenman-firewall";
const ACTIONS = ["set-policy", "set-proxy", "set-time", "set-network", "set-firewall", "check", "install-now", "reboot"];
const INSTALL_TIMEOUT_MS = 45 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

function log(message) {
  console.log(`xenman-os-request: ${message}`);
}

/**
 * The result the web interface polls; written whole, never half, and never
 * through a link XenMan could have put in its place (data-write.js).
 */
function writeResult(result) {
  writeFile(RESULT_FILE, JSON.stringify(result, null, 2) + "\n", { mode: 0o644 });
}

function audit(action, target, detail) {
  if (!fs.existsSync(path.dirname(AUDIT_FILE))) return;
  spawnSync(process.execPath, [AUDIT_APPEND, "--file", AUDIT_FILE, "--action", action,
    "--outcome", "success", "--target", target, "--detail", detail], { stdio: "ignore" });
}

/**
 * Opens without following a symlink and reads at most MAX_BYTES of a regular
 * file. The file is removed straight away, valid or not, so that the path unit
 * re-arms instead of starting this again and again on the same bad request.
 *
 * O_NONBLOCK because a named pipe put in its place would otherwise block the
 * open until something wrote to it, leaving this root service hanging; with
 * it the open returns, and the regular-file check below refuses the pipe.
 */
function takeRequest() {
  let fd;
  try {
    fd = fs.openSync(
      REQUEST_FILE,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (err) {
    try { fs.unlinkSync(REQUEST_FILE); } catch { /* already gone */ }
    return { error: err.code === "ENOENT" ? null : "the request file is not a regular file" };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { error: "the request file is not a regular file" };
    if (stat.size > MAX_BYTES) return { error: "the request is too large" };
    const buffer = Buffer.alloc(stat.size);
    fs.readSync(fd, buffer, 0, stat.size, 0);
    return { text: buffer.toString("utf-8") };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(REQUEST_FILE); } catch { /* already gone */ }
  }
}

/** Anything that reaches the audit log or a message gets squeezed into shape. */
function label(value) {
  return typeof value === "string"
    ? value.replace(/[^\w.@ -]/g, "").slice(0, 64) || "unknown"
    : "unknown";
}

function policyFlags(policy) {
  if (!policy || typeof policy !== "object") return { error: "no policy in the request" };
  const flags = [];
  if (policy.mode !== undefined) flags.push("--mode", String(policy.mode));
  if (policy.days !== undefined) {
    if (!Array.isArray(policy.days) || !policy.days.every((d) => /^[A-Za-z]{3}$/.test(d))) {
      return { error: "days must be three-letter weekday names" };
    }
    flags.push("--days", policy.days.join(","));
  }
  if (policy.time !== undefined) flags.push("--time", String(policy.time));
  if (policy.timezone !== undefined) flags.push("--timezone", String(policy.timezone));
  if (policy.rebootInWindow !== undefined) {
    if (typeof policy.rebootInWindow !== "boolean") return { error: "rebootInWindow must be true or false" };
    flags.push("--reboot", policy.rebootInWindow ? "yes" : "no");
  }
  if (flags.length === 0) return { error: "the policy request changes nothing" };
  return { flags };
}

/**
 * apt-get update. Returns null on success, otherwise why not, in apt's words.
 * --error-on=any: without it apt reports success even when no source could be
 * reached, and "nothing pending" would be a lie.
 */
function refreshLists() {
  const run = spawnSync(APT_GET, ["update", "-q", "--error-on=any"], {
    encoding: "utf-8",
    timeout: CHECK_TIMEOUT_MS,
  });
  if (run.status === 0) {
    fs.mkdirSync(path.dirname(UPDATE_STAMP), { recursive: true });
    fs.writeFileSync(UPDATE_STAMP, "");
    return null;
  }
  const lines = (run.stderr || "").split("\n").map((l) => l.trim());
  // "E: Failed to fetch <url>  407  Proxy Authentication Required [IP: ...]":
  // the reason after the URL says more than apt's closing summary.
  const fetch = lines.find((l) => /^[EW]: Failed to fetch \S+\s{2,}\S/.test(l));
  const reason = fetch
    ? fetch.replace(/^[EW]: Failed to fetch \S+\s+/, "")
    : (lines.filter((l) => /^[EW]:/.test(l)).pop() || "").replace(/^[EW]:\s*/, "");
  if (run.error && run.error.code === "ETIMEDOUT") return "no answer within ten minutes";
  return reason.replace(/\s{2,}/g, " ").slice(0, 300) || "apt-get update failed";
}

// ─── proxy ──────────────────────────────────────────────────────────────────

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:.]{2,45}\]$/;

/**
 * Checks the proxy the request asks for; null means "connect directly". A
 * missing password with an unchanged login keeps the one already stored, so
 * the web interface never has to know it.
 */
function proxyFromRequest(p) {
  if (p === null) return { proxy: null };
  if (!p || typeof p !== "object") return { error: "no proxy in the request" };
  const host = typeof p.host === "string" ? p.host.trim() : "";
  if (!host || host.length > 253 || !HOST_RE.test(host)) return { error: "the proxy host is not a valid name or address" };
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "the proxy port must be between 1 and 65535" };
  const printable = (v, max) => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  const username = p.username === undefined || p.username === "" ? "" : p.username;
  if (username && !printable(username, 128)) return { error: "the proxy login is not valid" };
  let password = "";
  if (p.password !== undefined && p.password !== "") {
    if (!printable(p.password, 256)) return { error: "the proxy password is not valid" };
    password = p.password;
  } else if (username) {
    const current = readProxy();
    if (current && current.username === username) password = current.password;
  }
  return { proxy: { host, port, username, password: username ? password : "" } };
}

/** The proxy as stored, password included -- root only. */
function readProxy() {
  try {
    const text = fs.readFileSync(PROXY_CONF, "utf-8");
    const m = /^Acquire::http::Proxy "([^"]+)";$/m.exec(text);
    if (!m) return null;
    const url = new URL(m[1]);
    return {
      host: url.hostname,
      port: Number(url.port) || 80,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
}

function writeAtomic(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.xenman-new`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/**
 * The apt configuration, readable by root only because it carries the
 * password, and next to it what the web interface may show: no password.
 * Everything in the URL is percent-encoded, so nothing can end the quoted
 * value and add configuration of its own.
 */
function writeProxy(proxy) {
  if (!proxy) {
    for (const f of [PROXY_CONF, PROXY_INFO]) {
      try { fs.unlinkSync(f); } catch { /* not there */ }
    }
    return;
  }
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ""}@`
    : "";
  const url = `http://${auth}${proxy.host}:${proxy.port}/`;
  writeAtomic(PROXY_CONF,
    "// Managed by XenMan (Settings > Security Updates > Proxy); changes here are overwritten.\n" +
    `Acquire::http::Proxy "${url}";\nAcquire::https::Proxy "${url}";\n`, 0o600);
  writeAtomic(PROXY_INFO, JSON.stringify({
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || null,
    hasPassword: Boolean(proxy.password),
    changedAt: new Date().toISOString(),
  }, null, 2) + "\n", 0o644);
}

// ─── time ───────────────────────────────────────────────────────────────────

const ZONE_RE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const IPV6_RE = /^[0-9A-Fa-f:.]{2,45}$/;

/** Checks the time settings the request asks for. */
function timeFromRequest(t) {
  if (!t || typeof t !== "object") return { error: "no time settings in the request" };
  const time = {};
  if (t.timezone !== undefined) {
    // A real file under zoneinfo, reached without ".." or a symlink out of it.
    const file = path.join(ZONEINFO, String(t.timezone));
    let ok = typeof t.timezone === "string" && ZONE_RE.test(t.timezone);
    try {
      ok = ok && fs.statSync(file).isFile() && fs.realpathSync(file).startsWith(fs.realpathSync(ZONEINFO) + path.sep);
    } catch {
      ok = false;
    }
    if (!ok) return { error: "unknown time zone" };
    time.timezone = t.timezone;
  }
  if (t.ntpServers !== undefined) {
    if (!Array.isArray(t.ntpServers) || t.ntpServers.length > MAX_NTP_SERVERS) {
      return { error: `at most ${MAX_NTP_SERVERS} NTP servers` };
    }
    for (const s of t.ntpServers) {
      const ok = typeof s === "string" && s.length <= 253 &&
        (HOST_RE.test(s) && !s.startsWith("[") || (s.includes(":") && IPV6_RE.test(s)));
      if (!ok) return { error: "an NTP server is not a valid name or address" };
    }
    time.ntpServers = [...new Set(t.ntpServers)];
  }
  if (time.timezone === undefined && time.ntpServers === undefined) return { error: "the time request changes nothing" };
  return { time };
}

function writeNtp(servers) {
  if (servers.length === 0) {
    try { fs.unlinkSync(NTP_CONF); } catch { /* not there */ }
    return;
  }
  writeAtomic(NTP_CONF,
    "# Managed by XenMan (Settings > Date & Time); changes here are overwritten.\n" +
    `[Time]\nNTP=${servers.join(" ")}\n`, 0o644);
}

function main() {
  const taken = takeRequest();
  if (!taken.text && !taken.error) return; // nothing to do
  const base = { id: null, action: null, requestedBy: null, startedAt: new Date().toISOString() };

  const done = (state, message) => {
    writeResult({ ...base, state, message, finishedAt: new Date().toISOString() });
    log(`${base.action || "request"}: ${state}: ${message}`);
  };

  if (taken.error) return done("failed", taken.error);

  let request;
  try {
    request = JSON.parse(taken.text);
  } catch {
    // Not echoed back: whatever it was, it is not ours to repeat.
    return done("failed", "the request is not valid JSON");
  }

  base.id = typeof request.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(request.id) ? request.id : null;
  base.action = ACTIONS.includes(request.action) ? request.action : null;
  base.requestedBy = label(request.requestedBy);
  if (!base.id) return done("failed", "the request has no valid id");
  if (!base.action) return done("failed", "unknown action");

  // An application update restarts and replaces things; nothing here should
  // run across it, least of all a restart of the whole appliance.
  if (fs.existsSync(APP_UPDATE_MARKER)) {
    return done("failed", "an application update is in progress -- try again when it has finished");
  }

  if (base.action === "set-policy") {
    const { flags, error } = policyFlags(request.policy);
    if (error) return done("failed", error);
    const run = spawnSync(OS_POLICY, ["set", ...flags, "--by", base.requestedBy], { encoding: "utf-8" });
    if (run.status !== 0) {
      return done("failed", (run.stderr || "").trim().replace(/^xenman-os-policy:\s*/, "") || "policy refused");
    }
    return done("done", (run.stdout || "").split("\n")[0].replace(/^policy:\s*/, "").trim());
  }

  if (base.action === "check") {
    writeResult({ ...base, state: "running", message: "checking for security updates" });
    const failure = refreshLists();
    if (failure) return done("failed", `could not refresh the package lists: ${failure}`);
    return done("done", "package lists refreshed");
  }

  if (base.action === "set-time") {
    const { time, error } = timeFromRequest(request.time);
    if (error) return done("failed", error);
    const changes = [];
    if (time.timezone !== undefined) {
      const run = spawnSync(TIMEDATECTL, ["set-timezone", time.timezone], { encoding: "utf-8" });
      if (run.status !== 0) return done("failed", `could not set the time zone: ${(run.stderr || "").trim().slice(0, 200)}`);
      changes.push(`time zone ${time.timezone}`);
    }
    if (time.ntpServers !== undefined) {
      writeNtp(time.ntpServers);
      // timesyncd reads its configuration only at start.
      spawnSync(TIMEDATECTL, ["set-ntp", "true"], { encoding: "utf-8" });
      const run = spawnSync("systemctl", ["restart", "systemd-timesyncd"], { encoding: "utf-8" });
      if (run.status !== 0) return done("failed", "NTP servers saved, but the time service did not restart");
      changes.push(time.ntpServers.length ? `NTP ${time.ntpServers.join(", ")}` : "NTP: Debian defaults");
    }
    audit("os_time_changed", changes.join("; "), `requested by ${base.requestedBy} in the web interface`);
    return done("done", `saved: ${changes.join("; ")}`);
  }

  if (base.action === "set-network") {
    const n = request.network;
    if (!n || typeof n !== "object") return done("failed", "no network settings in the request");
    if (typeof request.confirmToken !== "string") return done("failed", "no confirmation token in the request");
    // Values go on as separate arguments, never through a shell; xenman-network
    // checks each of them.
    const str = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : "");
    const args = ["set", "--mode", str(n.mode), "--dns", str(n.dns), "--domains", str(n.domains),
      "--hostname", str(n.hostname), "--by", base.requestedBy, "--confirm", request.confirmToken, "--id", base.id];
    if (n.mode === "static") args.push("--address", str(n.address), "--gateway", str(n.gateway));
    writeResult({ ...base, state: "running", message: "applying the network settings" });
    const run = spawnSync(NETWORK, args, { encoding: "utf-8", timeout: 60000 });
    if (run.status !== 0) {
      return done("failed", (run.stderr || "").trim().replace(/^xenman-network:\s*/, "").slice(0, 300) || "the network settings were refused");
    }
    return done("done", (run.stdout || "").trim().slice(0, 300));
  }

  if (base.action === "set-firewall") {
    const f = request.firewall;
    if (!f || typeof f !== "object") return done("failed", "no access rules in the request");
    if (typeof request.confirmToken !== "string") return done("failed", "no confirmation token in the request");
    // As separate arguments, never through a shell; xenman-firewall checks each.
    const str = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : "");
    const args = ["set", "--enabled", f.enabled === true ? "yes" : "no", "--allow", str(f.allow), "--ssh-allow", str(f.sshAllow),
      "--by", base.requestedBy, "--confirm", request.confirmToken, "--id", base.id];
    writeResult({ ...base, state: "running", message: "applying the access rules" });
    // Long enough for nftables to be installed the first time.
    const run = spawnSync(FIREWALL, args, { encoding: "utf-8", timeout: 12 * 60 * 1000 });
    if (run.status !== 0) {
      return done("failed", (run.stderr || "").trim().replace(/^xenman-firewall:\s*/, "").slice(0, 300) || "the access rules were refused");
    }
    return done("done", (run.stdout || "").trim().slice(0, 300));
  }

  if (base.action === "set-proxy") {
    const { proxy, error } = proxyFromRequest(request.proxy);
    if (error) return done("failed", error);
    writeProxy(proxy);
    const where = proxy ? `${proxy.host}:${proxy.port}` : "direct connection";
    audit("os_proxy_changed", where,
      `${proxy && proxy.username ? `with login ${label(proxy.username)}, ` : ""}requested by ${base.requestedBy} in the web interface`);
    // Saved either way; the refresh only says whether it works.
    writeResult({ ...base, state: "running", message: "proxy saved, testing the connection" });
    const failure = refreshLists();
    const saved = proxy ? `proxy ${where} saved` : "proxy removed";
    if (failure) return done("failed", `${saved}, but the package lists could not be refreshed: ${failure}`);
    return done("done", `${saved}, package lists refreshed`);
  }

  if (base.action === "install-now") {
    writeResult({ ...base, state: "running", message: "installing security updates" });
    const run = spawnSync(OS_UPDATE, [], {
      encoding: "utf-8",
      timeout: INSTALL_TIMEOUT_MS,
      // Named in the head of the live log; already squeezed by label().
      env: { ...process.env, XENMAN_REQUESTED_BY: base.requestedBy },
    });
    const last = (run.stdout || "").trim().split("\n").pop() || "";
    if (run.status !== 0) {
      return done("failed", last.replace(/^xenman-os-update:\s*/, "") || "the installation failed");
    }
    return done("done", last.replace(/^xenman-os-update:\s*/, "") || "finished");
  }

  // reboot: recorded before it happens -- afterwards there is no one to write it.
  audit("os_restart", "web interface", `requested by ${base.requestedBy}`);
  done("done", "restarting");
  try {
    execFileSync("systemctl", ["reboot"], { stdio: "ignore" });
  } catch {
    done("failed", "systemctl reboot failed");
  }
}

try {
  main();
} catch (err) {
  // The request is already gone; say so rather than leave the UI waiting.
  try {
    writeResult({ state: "failed", message: `internal error: ${err.message}`, finishedAt: new Date().toISOString() });
  } catch { /* nowhere left to report */ }
  process.exitCode = 1;
}
