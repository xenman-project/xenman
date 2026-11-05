#!/usr/bin/env node
//
// Build, sign and verify XenMan appliance update packages (.xenup).
//
// A .xenup is a tar.gz holding these members:
//
//     manifest.json    version, commit, node requirement, payload digests
//     manifest.sig     Ed25519 signature over manifest.json, raw bytes
//     payload.tar.gz   the /opt/xenman tree
//     system.tar.gz    format 2 only: files outside /opt/xenman, relative to /
//
// The signature covers the manifest, and the manifest carries the digest of
// every payload, so signing the manifest closes the chain over all of them.
//
// Format 2 exists because the update mechanism itself lives outside
// /opt/xenman -- the updater, its units, the apt policy. A format 1 package
// can replace the application but never the thing that installs it. A format
// 1 updater refuses format 2 outright rather than installing half of it.
//
// Why sign at all: updates are triggered from the web interface, and the
// installer runs as root. Without a signature, anyone reaching an admin session
// -- a stolen cookie, a flaw in an upload route -- could run code as root on
// the machine holding the credentials to the virtualisation it manages. With
// one, the worst they can install is a genuine release.
//
// Usage:
//   node xenup.js keygen --out <dir>
//   node xenup.js pack   --payload <dir> [--system <dir>] --version <v>
//                        --key <privkey> --out <file>
//   node xenup.js verify --file <f> --key <pubkey>
//                        [--extract <dir>] [--extract-system <dir>]
//   node xenup.js info   --file <f>

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const FORMATS = [1, 2];
const PRODUCT = "xenman-appliance";

// ─── helpers ─────────────────────────────────────────────────────────────────

function tar(args, cwd) {
  execFileSync("tar", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fail(message) {
  console.error(`xenup: ${message}`);
  process.exit(1);
}

// ─── keygen ──────────────────────────────────────────────────────────────────

function keygen(opts) {
  if (!opts.out) fail("keygen needs --out <dir>");
  fs.mkdirSync(opts.out, { recursive: true });

  const priv = path.join(opts.out, "release-key");
  const pub = path.join(opts.out, "release-key.pub");
  if (fs.existsSync(priv)) {
    fail(`${priv} already exists -- refusing to overwrite a signing key`);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  fs.writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));

  console.log(`private key: ${priv}  (keep this off the appliance)`);
  console.log(`public key:  ${pub}   (ships as /etc/xenman/release-key.pub)`);
}

/**
 * Recreates the public key from the private one. Only the private half needs
 * backing up: a rebuild after a disk failure can derive the public half again
 * from the key in your safe.
 */
function pubkey(opts) {
  if (!opts.key) fail("pubkey needs --key <privkey>");
  const privateKey = crypto.createPrivateKey(fs.readFileSync(opts.key));
  const pem = crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  if (opts.out) {
    fs.writeFileSync(opts.out, pem);
    console.log(opts.out);
  } else {
    process.stdout.write(pem);
  }
}

// ─── pack ────────────────────────────────────────────────────────────────────

function pack(opts) {
  for (const need of ["payload", "version", "key", "out"]) {
    if (!opts[need]) fail(`pack needs --${need}`);
  }
  if (!fs.existsSync(path.join(opts.payload, "server.js"))) {
    fail(`${opts.payload} does not look like a XenMan tree (no server.js)`);
  }

  const work = tempDir("xenup-pack-");
  try {
    const payloadTar = path.join(work, "payload.tar.gz");
    tar(["-czf", payloadTar, "."], opts.payload);
    const members = ["manifest.json", "manifest.sig", "payload.tar.gz"];

    const manifest = {
      format: opts.system ? 2 : 1,
      product: PRODUCT,
      version: opts.version,
      commit: opts.commit || "",
      builtAt: new Date().toISOString(),
      minNode: opts.minNode || "24.0.0",
      payloadSha256: sha256(payloadTar),
      payloadBytes: fs.statSync(payloadTar).size,
    };

    if (opts.system) {
      const systemTar = path.join(work, "system.tar.gz");
      // Owned by root in the archive, whoever built it: these land in /usr and
      // /etc, and the updater sets ownership explicitly anyway -- this only
      // keeps a build user's uid from showing up in the listing.
      tar(
        ["-czf", systemTar, "--owner=0", "--group=0", "--numeric-owner", "."],
        opts.system,
      );
      manifest.systemSha256 = sha256(systemTar);
      manifest.systemBytes = fs.statSync(systemTar).size;
      members.push("system.tar.gz");
    }

    // Serialised once and signed as exactly these bytes. Re-serialising before
    // verification would invite a mismatch over key order or whitespace.
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(work, "manifest.json"), manifestBytes);

    const privateKey = crypto.createPrivateKey(fs.readFileSync(opts.key));
    fs.writeFileSync(
      path.join(work, "manifest.sig"),
      crypto.sign(null, manifestBytes, privateKey),
    );

    const out = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    tar(["-czf", out, ...members], work);

    const size = fs.statSync(out).size;
    console.log(out);
    console.log(
      `  version ${manifest.version}  format ${manifest.format}  ${(size / 1048576).toFixed(1)} MiB`,
    );
    console.log(`  payload sha256 ${manifest.payloadSha256}`);
    if (manifest.systemSha256) {
      console.log(`  system  sha256 ${manifest.systemSha256}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ─── verify ──────────────────────────────────────────────────────────────────

function readManifest(work, file, keyPath) {
  const members = keyPath
    ? ["manifest.json", "manifest.sig"]
    : ["manifest.json"];
  try {
    tar(["-xzf", path.resolve(file), "-C", work, ...members]);
  } catch {
    fail("not a .xenup package (manifest missing)");
  }

  const manifestBytes = fs.readFileSync(path.join(work, "manifest.json"));

  if (keyPath) {
    const publicKey = crypto.createPublicKey(fs.readFileSync(keyPath));
    const signature = fs.readFileSync(path.join(work, "manifest.sig"));
    if (!crypto.verify(null, manifestBytes, publicKey, signature)) {
      fail("signature does not match the release key -- refusing the package");
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("manifest is not valid JSON");
  }
  if (!FORMATS.includes(manifest.format)) {
    fail(`unsupported package format ${manifest.format}`);
  }
  if (manifest.format === 2 && !manifest.systemSha256) {
    fail("format 2 package without a system payload digest");
  }
  if (manifest.product !== PRODUCT) {
    fail(`package is for ${manifest.product}, not ${PRODUCT}`);
  }
  return manifest;
}

/**
 * Pulls one member out of the package into `work` and checks its digest
 * against the (already verified) manifest. Whatever gets unpacked afterwards
 * is this checked copy, never the package again -- so the package file cannot
 * be swapped between the check and the use.
 */
function takeMember(work, file, member, expected) {
  tar(["-xzf", path.resolve(file), "-C", work, member]);
  const copy = path.join(work, member);
  const actual = sha256(copy);
  if (actual !== expected) {
    fail(`${member} digest mismatch (expected ${expected}, got ${actual})`);
  }
  return copy;
}

function unpackInto(archive, dir, extraArgs) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) fail(`${dir} is not empty`);
  tar(["-xzf", archive, "-C", dir, ...extraArgs]);
}

function verify(opts) {
  if (!opts.file || !opts.key) fail("verify needs --file and --key");

  const work = tempDir("xenup-verify-");
  try {
    const manifest = readManifest(work, opts.file, opts.key);

    // Payloads are only touched once the signature checked out, and each
    // digest is compared before anything is unpacked from it.
    const payloadTar = takeMember(
      work,
      opts.file,
      "payload.tar.gz",
      manifest.payloadSha256,
    );
    const systemTar =
      manifest.format === 2
        ? takeMember(work, opts.file, "system.tar.gz", manifest.systemSha256)
        : null;

    if (opts.extract) unpackInto(payloadTar, opts.extract, ["--no-same-owner"]);

    if (opts.extractSystem) {
      if (!systemTar) fail("this package carries no system files");
      // Checked before anything is written: a symlink or a device node in
      // here could let the unpack itself reach outside the target directory.
      const listing = execFileSync("tar", ["-tvzf", systemTar], { encoding: "utf8" });
      for (const line of listing.split("\n").filter(Boolean)) {
        if (line[0] !== "-" && line[0] !== "d") {
          fail(
            `system payload holds something other than files and directories: ${line.trim()}`,
          );
        }
      }
      // Modes are kept -- the updater reads them -- but ownership is not: it
      // installs everything as root regardless of what the archive claims.
      unpackInto(systemTar, opts.extractSystem, ["--no-same-owner"]);
    }

    console.log(JSON.stringify(manifest));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function info(opts) {
  if (!opts.file) fail("info needs --file");
  const work = tempDir("xenup-info-");
  try {
    console.log(JSON.stringify(readManifest(work, opts.file, null), null, 2));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const KNOWN = [
  "out",
  "payload",
  "version",
  "key",
  "file",
  "commit",
  "minNode",
  "extract",
  "system",
  "extractSystem",
];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
      .replace(/^--/, "")
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!KNOWN.includes(name)) fail(`unknown option: ${argv[i]}`);
    if (argv[i + 1] === undefined) fail(`missing value for ${argv[i]}`);
    opts[name] = argv[i + 1];
  }
  return opts;
}

const [command, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);

switch (command) {
  case "keygen":
    keygen(opts);
    break;
  case "pubkey":
    pubkey(opts);
    break;
  case "pack":
    pack(opts);
    break;
  case "verify":
    verify(opts);
    break;
  case "info":
    info(opts);
    break;
  default:
    console.error(
      "usage: xenup.js keygen --out <dir>\n" +
        "       xenup.js pubkey --key <privkey> [--out <file>]\n" +
        "       xenup.js pack --payload <dir> [--system <dir>] --version <v> --key <privkey> --out <file>\n" +
        "       xenup.js verify --file <f> --key <pubkey> [--extract <dir>] [--extract-system <dir>]\n" +
        "       xenup.js info --file <f>",
    );
    process.exit(2);
}
