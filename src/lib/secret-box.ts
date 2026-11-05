// Encryption of the secrets XenMan stores: the XenServer passwords (hosts.json)
// and the mail server's (smtp.json). AES-256-GCM.
//
// Which key, in this order:
//   1. The appliance's credential (XENMAN_HOST_KEY_FILE): 32 random bytes that
//      live encrypted by systemd-creds outside the data directory, bound to this
//      machine (its TPM if it has one, else systemd's host key), and are handed
//      to the service at start only (appliance/rootfs/usr/local/sbin/
//      xenman-credential). A copy of the data directory -- a backup, a file
//      mailed around -- cannot be decrypted without the appliance itself.
//   2. Elsewhere (Docker, Windows): a key of its own in the data directory,
//      .secret-key, apart from the login secret.
// Values written before (enc:...) used a key derived from the login secret
// (.jwt-secret); they are still read, and rewritten with the current key the
// first time their file is loaded -- so one leaked secret no longer opens the
// other.
//
// Format: enc2:<key id>:<iv>:<ciphertext>:<tag>, all hex; the key id is the
// first 8 hex digits of the key's SHA-256, so a value says which key it needs.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const LOCAL_KEY_FILE = path.join(DATA_DIR, ".secret-key");
const JWT_SECRET_FILE = path.join(DATA_DIR, ".jwt-secret");

interface Key {
  id: string;
  key: Buffer;
  source: "credential" | "local";
}

const keyId = (key: Buffer) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);

function credentialKey(): Key | null {
  const file = process.env.XENMAN_HOST_KEY_FILE;
  if (!file) return null;
  try {
    const key = fs.readFileSync(file);
    if (key.length !== 32) {
      console.error(`[secret-box] ${file} does not hold a 32-byte key; using the data directory's`);
      return null;
    }
    return { id: keyId(key), key, source: "credential" };
  } catch {
    // The appliance could not decrypt its credential (see journalctl -u xenman-credential).
    console.error(`[secret-box] ${file} unreadable; using the data directory's key`);
    return null;
  }
}

function localKey(create: boolean): Key | null {
  try {
    const key = fs.readFileSync(LOCAL_KEY_FILE);
    if (key.length === 32) return { id: keyId(key), key, source: "local" };
  } catch {
    // not there yet
  }
  if (!create) return null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(LOCAL_KEY_FILE, key, { flag: "wx", mode: 0o600 });
  } catch (err) {
    // Another process was first: its key is the one.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return localKey(false);
    throw err;
  }
  return { id: keyId(key), key, source: "local" };
}

// Read once per process: the credential does not change while XenMan runs,
// and the stored files are read on every request.
const g = globalThis as unknown as { _xenmanSecretKeys?: { credential: Key | null; local: Key | null } };

function keys() {
  if (!g._xenmanSecretKeys) g._xenmanSecretKeys = { credential: credentialKey(), local: localKey(false) };
  return g._xenmanSecretKeys;
}

/** The key new values are written with. */
function currentKey(): Key {
  const k = keys();
  if (k.credential) return k.credential;
  k.local ??= localKey(true);
  return k.local!;
}

/** Every key a stored value may name. */
function knownKeys(): Key[] {
  const k = keys();
  return [k.credential, k.local].filter((x): x is Key => x !== null);
}

/** The key values from before enc2 were written with: SHA-256 of the login secret. */
function legacyKey(): Buffer {
  const secret = process.env.JWT_SECRET || fs.readFileSync(JWT_SECRET_FILE, "utf-8").trim();
  return crypto.createHash("sha256").update(secret).digest();
}

/** Where new values' key comes from, for the log. */
export function keySource(): "credential" | "local" {
  return currentKey().source;
}

export function seal(plaintext: string): string {
  const k = currentKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k.key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return `enc2:${k.id}:${iv.toString("hex")}:${ct.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

function open(key: Buffer, ivHex: string, ctHex: string, tagHex: string): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf-8");
}

/** Thrown when a stored value's key is not here (another installation's) or it does not open. */
export class UnreadableSecretError extends Error {
  constructor(detail: string) {
    super(`stored secret unreadable: ${detail}`);
    this.name = "UnreadableSecretError";
  }
}

export function unseal(value: string): string {
  if (value.startsWith("enc2:")) {
    const [, id, iv, ct, tag] = value.split(":");
    const k = knownKeys().find((x) => x.id === id);
    if (!k) throw new UnreadableSecretError(`key ${id} is not on this installation`);
    try {
      return open(k.key, iv, ct, tag);
    } catch {
      throw new UnreadableSecretError(`does not open with key ${id}`);
    }
  }
  if (value.startsWith("enc:")) {
    const parts = value.slice(4).split(":");
    if (parts.length !== 3) throw new UnreadableSecretError("invalid format");
    try {
      return open(legacyKey(), parts[0], parts[1], parts[2]);
    } catch {
      throw new UnreadableSecretError("does not open with the login secret's key");
    }
  }
  // Never encrypted (oldest files): as it is.
  return value;
}

/** Whether a stored value should be written again with the current key. */
export function needsReseal(value: string): boolean {
  if (!value) return false;
  return !value.startsWith(`enc2:${currentKey().id}:`);
}
