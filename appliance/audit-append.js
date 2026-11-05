#!/usr/bin/env node
//
// Appends one entry to XenMan's audit log on behalf of a root service.
//
// The services that change the appliance -- xenman-updater, xenman-os-update --
// run while XenMan itself may be stopped or restarting, so they cannot ask it
// to log. They write the line themselves, in the format src/lib/audit.ts uses,
// so these entries show up in the audit view like any other.
//
// Usage:
//   node audit-append.js --file <audit.jsonl> --action <name> --outcome <o>
//                        [--target <t>] [--detail <d>]

"use strict";

const path = require("path");
const { appendLine } = require("./data-write");

const OUTCOMES = ["success", "failure", "denied"];

function fail(message) {
  console.error(`audit-append: ${message}`);
  process.exit(1);
}

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const name = argv[i].replace(/^--/, "");
  if (!["file", "action", "outcome", "target", "detail"].includes(name)) {
    fail(`unknown option: ${argv[i]}`);
  }
  if (argv[i + 1] === undefined) fail(`missing value for ${argv[i]}`);
  opts[name] = argv[i + 1];
}
for (const need of ["file", "action", "outcome"]) {
  if (!opts[need]) fail(`--${need} is required`);
}
if (!OUTCOMES.includes(opts.outcome)) {
  fail(`--outcome must be one of ${OUTCOMES.join(", ")}`);
}

const entry = {
  ts: new Date().toISOString(),
  actor: "system",
  role: "-",
  ip: "-",
  category: "system",
  action: opts.action,
  ...(opts.target ? { target: opts.target } : {}),
  outcome: opts.outcome,
  ...(opts.detail ? { detail: opts.detail } : {}),
};

// One write of one line: appends on Linux are positioned atomically, so this
// cannot interleave with a line XenMan writes at the same moment. Never
// through a symlink: the log lives in a directory XenMan owns (data-write.js).
// A log created here goes to whoever owns that directory, or root would lock
// XenMan out of its own log.
try {
  appendLine(opts.file, JSON.stringify(entry), { ownerOf: path.dirname(opts.file) });
} catch (err) {
  fail(err.message);
}
