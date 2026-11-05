#!/usr/bin/env node
//
// The policy for when Debian security updates install on the appliance, and
// the systemd timer generated from it. Installed as xenman-os-policy.
//
//   xenman-os-policy show
//   xenman-os-policy set --mode window|manual [--days daily|Mon,Sun]
//                        [--time HH:MM] [--timezone Europe/Berlin]
//                        [--reboot yes|no] [--by <who, for the audit log>]
//   xenman-os-policy apply [--no-reload] [--quiet]
//   xenman-os-policy in-window        exit 0 if installing is allowed now
//   xenman-os-policy get <field>
//
// Two modes. "window" installs automatically on the chosen days at the chosen
// time -- all seven days is the "as soon as possible" setting, since updates
// then land within a day. "manual" installs only when someone asks.
//
// The timer only decides when a run starts; this policy decides whether the
// run installs anything. A timer can fire outside the window -- catching up
// after a boot, on an appliance that still carries the old schedule after an
// update, on a clock that was wrong -- and xenman-os-update checks in-window
// before installing, so none of those can install outside it.
//
// The policy and the timer drop-in are the operator's settings. No update
// package ships them, so no update can reset the window someone chose.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const POLICY_FILE = process.env.OS_POLICY_FILE || "/etc/xenman/os-update-policy.json";
const TIMER_DROPIN =
  process.env.OS_POLICY_DROPIN ||
  "/etc/systemd/system/apt-daily-upgrade.timer.d/50-xenman-window.conf";
const AUDIT_FILE = process.env.AUDIT_FILE || "/var/lib/xenman/audit.jsonl";
const AUDIT_APPEND = process.env.AUDIT_APPEND || "/usr/local/lib/xenman/audit-append.js";
const ZONEINFO = process.env.ZONEINFO || "/usr/share/zoneinfo";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A run that starts up to this long after the window opens still counts. */
const TOLERANCE_MINUTES = 120;

const DEFAULTS = {
  mode: "window",
  days: ["Sun"],
  time: "02:00",
  // Explicit rather than the system zone, which is UTC on the appliance: a
  // window "at 02:00" should stay at 02:00 across daylight saving time.
  timezone: "Europe/Berlin",
  // Off by default: a restart nobody expected produces tickets, even though a
  // management appliance restarting leaves running VMs untouched.
  rebootInWindow: false,
};

function fail(message) {
  console.error(`xenman-os-policy: ${message}`);
  process.exit(1);
}

// ─── validation ──────────────────────────────────────────────────────────────

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return false;
  }
  // systemd resolves the zone from the tz database, not from Node's ICU copy,
  // so the zone must exist on disk too.
  if (fs.existsSync(ZONEINFO) && !fs.existsSync(path.join(ZONEINFO, tz))) return false;
  return true;
}

function validate(p) {
  const errors = [];
  if (!["window", "manual"].includes(p.mode)) {
    errors.push(`mode must be "window" or "manual", not "${p.mode}"`);
  }
  if (!Array.isArray(p.days) || p.days.length === 0 || p.days.some((d) => !DAYS.includes(d))) {
    errors.push(`days must be "daily" or a list of ${DAYS.join(", ")}`);
  }
  if (typeof p.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) {
    errors.push(`time must be HH:MM on a 24-hour clock, not "${p.time}"`);
  }
  if (typeof p.timezone !== "string" || !validTimezone(p.timezone)) {
    errors.push(`unknown time zone "${p.timezone}"`);
  }
  if (typeof p.rebootInWindow !== "boolean") {
    errors.push("rebootInWindow must be true or false");
  }
  return errors;
}

function parseDays(value) {
  if (value.toLowerCase() === "daily") return [...DAYS];
  const wanted = value
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3).toLowerCase());
  // Kept in calendar order and without repeats, whatever order they came in.
  return DAYS.filter((d) => wanted.includes(d)).concat(
    wanted.filter((d) => !DAYS.includes(d)),
  );
}

// ─── policy file ─────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(POLICY_FILE)) return { policy: { ...DEFAULTS }, source: "defaults" };
  try {
    const stored = JSON.parse(fs.readFileSync(POLICY_FILE, "utf-8"));
    const policy = {
      mode: stored.mode,
      days: stored.days,
      time: stored.time,
      timezone: stored.timezone,
      rebootInWindow: stored.rebootInWindow,
    };
    if (validate(policy).length === 0) return { policy, source: POLICY_FILE };
  } catch {
    // fall through
  }
  // A damaged policy must not stop security updates; the defaults are a safe
  // place to land, and `show` says it happened.
  return { policy: { ...DEFAULTS }, source: "defaults (the policy file is unreadable)" };
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.xenman-new`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function savePolicy(policy) {
  writeAtomic(
    POLICY_FILE,
    JSON.stringify({ ...policy, changedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}

// ─── schedule ────────────────────────────────────────────────────────────────

function onCalendar(p) {
  // Manual mode keeps a daily run too: it installs nothing, but it keeps track
  // of what is pending and for how long.
  const days = p.mode === "manual" || p.days.length === 7 ? "" : `${p.days.join(",")} `;
  return `${days}*-*-* ${p.time}:00 ${p.timezone}`;
}

function dropinContent(p) {
  return [
    "# Written by xenman-os-policy from /etc/xenman/os-update-policy.json. Change",
    "# the maintenance window with that command or in the web interface, not",
    "# here: this file is regenerated.",
    "",
    "[Timer]",
    "OnCalendar=",
    `OnCalendar=${onCalendar(p)}`,
    // apt's own timer spreads runs over an hour; a maintenance window means a
    // known time.
    "RandomizedDelaySec=0",
    // A run missed while the appliance was off would otherwise start at the
    // next boot -- outside the window. It is skipped, and the next window
    // installs what is pending.
    "Persistent=false",
    "",
  ].join("\n");
}

/** Writes the timer drop-in if it differs. Returns whether it changed. */
function applySchedule(p) {
  const want = dropinContent(p);
  const have = fs.existsSync(TIMER_DROPIN) ? fs.readFileSync(TIMER_DROPIN, "utf-8") : null;
  if (have === want) return false;
  writeAtomic(TIMER_DROPIN, want);
  return true;
}

function reloadSystemd() {
  try {
    execFileSync("systemctl", ["daemon-reload"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function nextElapse(p) {
  try {
    const out = execFileSync("systemd-analyze", ["calendar", onCalendar(p)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/Next elapse:\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// ─── the window ──────────────────────────────────────────────────────────────

function now() {
  // For tests only; the services that call this never set it.
  return process.env.XENMAN_NOW ? new Date(process.env.XENMAN_NOW) : new Date();
}

function weekMinutes(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return (
    DAYS.indexOf(parts.weekday) * 1440 + Number(parts.hour) * 60 + Number(parts.minute)
  );
}

/**
 * Whether a scheduled run may install now: inside the window, measured in the
 * window's own time zone, and counting a window that runs past midnight into
 * the next day.
 */
function inWindow(p, date) {
  if (p.mode === "manual") {
    return { allowed: false, reason: "manual mode: security updates install only when asked" };
  }
  const [h, m] = p.time.split(":").map(Number);
  const current = weekMinutes(date, p.timezone);
  for (const day of p.days) {
    const start = DAYS.indexOf(day) * 1440 + h * 60 + m;
    const since = (current - start + 7 * 1440) % (7 * 1440);
    if (since < TOLERANCE_MINUTES) return { allowed: true, reason: "inside the maintenance window" };
  }
  return { allowed: false, reason: `outside the maintenance window (${summary(p)})` };
}

function summary(p) {
  if (p.mode === "manual") return "manual";
  const days = p.days.length === 7 ? "daily" : p.days.join(",");
  return `window ${days} ${p.time} ${p.timezone}, ${p.rebootInWindow ? "restart if needed" : "no automatic restart"}`;
}

function audit(target, detail) {
  if (!fs.existsSync(path.dirname(AUDIT_FILE))) return;
  try {
    execFileSync(
      process.execPath,
      [AUDIT_APPEND, "--file", AUDIT_FILE, "--action", "os_update_policy_changed",
        "--outcome", "success", "--target", target, "--detail", detail],
      { stdio: "ignore" },
    );
  } catch {
    // an audit failure must not undo a policy change that has already happened
  }
}

// ─── commands ────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (["no-reload", "quiet"].includes(name)) {
      flags[name] = true;
      continue;
    }
    if (!["mode", "days", "time", "timezone", "reboot", "by"].includes(name)) {
      fail(`unknown option: ${arg}`);
    }
    if (argv[i + 1] === undefined) fail(`missing value for ${arg}`);
    flags[name] = argv[++i];
  }
  return flags;
}

function cmdShow() {
  const { policy, source } = load();
  console.log(`policy:    ${summary(policy)}`);
  console.log(`from:      ${source}`);
  if (policy.mode === "window") console.log(`next run:  ${nextElapse(policy) || "unknown"}`);
  console.log(JSON.stringify(policy, null, 2));
}

function cmdSet(flags) {
  const { policy: before } = load();
  const next = { ...before };
  if (flags.mode !== undefined) next.mode = flags.mode;
  if (flags.days !== undefined) next.days = parseDays(flags.days);
  if (flags.time !== undefined) next.time = flags.time;
  if (flags.timezone !== undefined) next.timezone = flags.timezone;
  if (flags.reboot !== undefined) {
    if (!["yes", "no"].includes(flags.reboot)) fail("--reboot takes yes or no");
    next.rebootInWindow = flags.reboot === "yes";
  }
  const errors = validate(next);
  if (errors.length) fail(errors.join("; "));

  savePolicy(next);
  if (applySchedule(next) && !flags["no-reload"]) reloadSystemd();
  // --by names whoever asked through the web interface; xenman-os-request
  // passes it on. Without it, the change came from a root shell.
  const origin = flags.by ? `requested by ${flags.by} in the web interface` : "set at a root shell";
  audit(summary(next), `changed from: ${summary(before)} -- ${origin}`);

  console.log(`policy:    ${summary(next)}`);
  if (next.mode === "window") console.log(`next run:  ${nextElapse(next) || "unknown"}`);
}

function cmdApply(flags) {
  const { policy, source } = load();
  // Write the effective policy down, so there is a file to read even on an
  // appliance that only ever had the defaults.
  if (source !== POLICY_FILE) savePolicy(policy);
  const changed = applySchedule(policy);
  if (changed && !flags["no-reload"]) reloadSystemd();
  if (!flags.quiet) {
    console.log(`${changed ? "schedule updated" : "schedule unchanged"}: ${summary(policy)}`);
  }
}

function cmdInWindow() {
  const { policy } = load();
  const { allowed, reason } = inWindow(policy, now());
  console.log(reason);
  process.exit(allowed ? 0 : 1);
}

function cmdGet(field) {
  const { policy } = load();
  if (!(field in policy)) fail(`no such field: ${field}`);
  const value = policy[field];
  console.log(Array.isArray(value) ? value.join(",") : String(value));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "show":
    cmdShow();
    break;
  case "set":
    cmdSet(parseFlags(rest));
    break;
  case "apply":
    cmdApply(parseFlags(rest));
    break;
  case "in-window":
    cmdInWindow();
    break;
  case "get":
    cmdGet(rest[0]);
    break;
  default:
    console.error(
      "usage: xenman-os-policy show\n" +
        "       xenman-os-policy set --mode window|manual [--days daily|Mon,Sun] [--time HH:MM]\n" +
        "                            [--timezone Europe/Berlin] [--reboot yes|no]\n" +
        "       xenman-os-policy apply [--no-reload] [--quiet]\n" +
        "       xenman-os-policy in-window\n" +
        "       xenman-os-policy get <field>",
    );
    process.exit(2);
}
