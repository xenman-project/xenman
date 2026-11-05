#!/usr/bin/env node
//
// For the console menu: when nobody knows an administrator's password any
// more. Instead of setting one here -- which would mean a password shown on a
// console and typed into a browser -- the account is put back into the state
// of a fresh invitation: its password is cleared and a short link, valid for
// 30 minutes, lets its owner choose a new one in the browser.
//
//   node reset-admin.js list            administrators, one per line
//   node reset-admin.js reset <name>    prints the token for /invite?token=
//
// Runs as root; users.json belongs to XenMan and is written through
// data-write.js, keeping its owner.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dw = require("./data-write");

const DATA_DIR = process.env.DATA_DIR || "/var/lib/xenman";
const USERS = path.join(DATA_DIR, "users.json");
const VALID_MS = 30 * 60 * 1000;
// No 0/o, 1/l/i: read off a console screen and typed by hand.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function load() {
  const text = dw.readSmall(USERS, 5 * 1024 * 1024);
  if (text === null) throw new Error(`cannot read ${USERS}`);
  return JSON.parse(text);
}

/** 20 characters from 31 (about 99 bits), in groups of five. */
function token() {
  let chars = "";
  while (chars.length < 20) chars += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return chars.match(/.{5}/g).join("-");
}

const [cmd, name] = process.argv.slice(2);
try {
  const users = load();
  if (cmd === "list") {
    for (const u of users) if (u.role === "admin") console.log(u.username);
  } else if (cmd === "reset" && name) {
    const user = users.find((u) => u.username === name && u.role === "admin");
    if (!user) throw new Error(`no administrator named ${name}`);
    const t = token();
    user.passwordHash = "";
    user.inviteToken = t;
    user.inviteTokenExpiry = new Date(Date.now() + VALID_MS).toISOString();
    dw.writeFile(USERS, JSON.stringify(users, null, 2), { mode: 0o600, ownerOf: DATA_DIR });
    const append = path.join(__dirname, "audit-append.js");
    require("child_process").spawnSync(process.execPath, [append, "--file", path.join(DATA_DIR, "audit.jsonl"),
      "--action", "admin_password_reset", "--outcome", "success", "--target", `user ${name}`,
      "--detail", "reset on the appliance console; a link to set a new password is valid for 30 minutes"], { stdio: "ignore" });
    console.log(t);
  } else {
    throw new Error("usage: reset-admin.js list | reset <name>");
  }
} catch (err) {
  console.error(`reset-admin: ${err.message}`);
  process.exit(1);
}
