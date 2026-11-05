// Writing a whole file without the chance of leaving half of one behind.
//
// Every configuration file XenMan owns is rewritten in full on each change:
// users.json, hosts.json, smtp.json, events-mark.json. A plain writeFileSync
// truncates the target first and then fills it, so an interrupted write leaves
// a valid, shorter, wrong file. For users.json that failure is silent and
// total: loadUsers() catches the parse error and returns [], ensureAdminUser()
// sees no users and recreates admin/admin, and every account and pool grant is
// gone without an error message anywhere.
//
// The fix is the usual one: write a temporary file beside the target, flush it,
// then rename over the target. Rename within a directory is atomic on both
// POSIX and Windows (Node uses MoveFileEx with MOVEFILE_REPLACE_EXISTING), so a
// reader sees either the old file or the new one, never a torn one.

import fs from "fs";
import path from "path";

let counter = 0;

/** A temporary file older than this was left behind by a crash, not a peer. */
const STALE_TMP_MS = 60 * 60 * 1000;

/**
 * Remove temporary files a killed process left next to `file`.
 *
 * Nothing can clean these up at the time: a SIGKILL runs no handler. They are
 * harmless but would otherwise accumulate one per crash, forever, in the data
 * directory. The age bound keeps this from touching a write that another
 * process has in flight right now — no write takes an hour.
 */
function sweepStaleTemps(dir: string, base: string): void {
  const prefix = `.${base}.`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TMP_MS;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
    const candidate = path.join(dir, entry);
    try {
      if (fs.statSync(candidate).mtimeMs < cutoff) fs.rmSync(candidate, { force: true });
    } catch {
      // Vanished or locked; either way not ours to worry about.
    }
  }
}

/**
 * Replace a file's contents atomically.
 *
 * The temporary file is created in the same directory on purpose — a rename
 * across filesystems is not atomic and Node would fall back to copying.
 *
 * `mode` applies to the temporary file, and therefore to the result. Pass 0o600
 * for anything secret; the default leaves it to the process umask, as before.
 */
export function writeFileAtomic(file: string, data: string, mode?: number): void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  // Unique per process and call: a fixed name would be cheaper to clean up, but
  // two processes writing the same target would then rename each other's
  // half-written file into place — the very corruption this exists to prevent.
  const tmp = path.join(dir, `.${base}.${process.pid}.${counter++}.tmp`);

  try {
    const fd = fs.openSync(tmp, "w", mode ?? 0o666);
    try {
      fs.writeFileSync(fd, data, "utf-8");
      // Without this the rename can land before the contents do: after a power
      // cut the directory entry points at a file that is empty or partial.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    // A leftover temporary file would accumulate on every failure.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing useful to do; the original error is the one that matters.
    }
    throw err;
  }

  // Persist the directory entry itself. Only meaningful on POSIX — Windows
  // cannot open a directory as a file, and there the rename is already durable.
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Expected on Windows (EPERM/EISDIR). Not an error.
  }

  sweepStaleTemps(dir, base);
}
