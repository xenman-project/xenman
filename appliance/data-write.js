#!/usr/bin/env node
//
// Writing as root into a directory the web user owns -- /var/lib/xenman and
// its updates/ -- without ever writing through a link that user put there.
//
// The danger is concrete: XenMan runs as "xenman" and owns those directories,
// so it can replace any file in them with a symlink to /etc/shadow. A root
// service that then writes, chmods or chowns "its" status file by name does
// so to /etc/shadow instead -- the web user's way to root. Everything root
// writes there goes through here:
//
//   - a whole file is written to a fresh temporary file (O_EXCL|O_NOFOLLOW, so
//     nothing pre-planted is opened), given its mode and owner through the
//     descriptor, and renamed over the target; a symlink at the target is
//     replaced, never followed;
//   - a line is appended only to a regular file opened with O_NOFOLLOW, and
//     O_NONBLOCK so a named pipe in its place cannot hang the caller;
//   - the directory itself must be a directory, not a link to one.
//
// Used as a module by os-request.js and audit-append.js, and from shell:
//
//   node data-write.js write --file <path> [--mode 0644] [--owner-of <path>]
//       writes stdin to <path>; --owner-of gives it that path's owner

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

class UnsafePath extends Error {}

/** The directory must exist as itself: a symlink to a directory is refused. */
function checkDir(dir) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new UnsafePath(`${dir} is not a plain directory`);
  }
}

/** Creates the directory if missing, owned like `ownerOf`; refuses a link. */
function ensureDir(dir, ownerOf) {
  try {
    fs.mkdirSync(dir, { mode: 0o755 });
    if (ownerOf) {
      const o = fs.statSync(ownerOf);
      fs.lchownSync(dir, o.uid, o.gid);
    }
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  checkDir(dir);
}

function owner(ownerOf) {
  if (!ownerOf) return null;
  const o = fs.statSync(ownerOf);
  return { uid: o.uid, gid: o.gid };
}

function writeFile(file, data, { mode = 0o644, ownerOf } = {}) {
  const dir = path.dirname(file);
  checkDir(dir);
  const who = owner(ownerOf);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf-8");
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fchmodSync(fd, mode);
    if (who) fs.fchownSync(fd, who.uid, who.gid);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw err;
  }
  fs.closeSync(fd);
  // rename() replaces whatever is at `file` -- a symlink included -- itself.
  fs.renameSync(tmp, file);
}

function appendLine(file, line, { ownerOf } = {}) {
  checkDir(path.dirname(file));
  const who = owner(ownerOf);
  let fd;
  try {
    fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o644);
  } catch (err) {
    if (err.code === "ELOOP") throw new UnsafePath(`${file} is a symlink`);
    if (err.code === "ENXIO") throw new UnsafePath(`${file} is not a regular file`);
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new UnsafePath(`${file} is not a regular file`);
    // Created just now by root, it would lock the owner of the directory out
    // of its own file.
    if (who && st.size === 0 && st.uid === 0 && who.uid !== 0) fs.fchownSync(fd, who.uid, who.gid);
    fs.writeSync(fd, line.endsWith("\n") ? line : `${line}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads a small file root may have written itself, but only if it is still a
 * regular file: through a link it could be any file root can read, handed to
 * the web user in whatever root writes next.
 */
function readSmall(file, max = 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { writeFile, appendLine, ensureDir, checkDir, readSmall, UnsafePath };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  const cmd = argv.shift();
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, "")] = argv[i + 1];
  try {
    if (cmd !== "write" || !opts.file) throw new Error("usage: data-write.js write --file <path> [--mode 0644] [--owner-of <path>]");
    const data = fs.readFileSync(0);
    writeFile(opts.file, data, {
      mode: opts.mode ? parseInt(opts.mode, 8) : 0o644,
      ownerOf: opts["owner-of"],
    });
  } catch (err) {
    console.error(`data-write: ${err.message}`);
    process.exit(1);
  }
}
