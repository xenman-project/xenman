import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import tls from "tls";
import { spawnSync } from "child_process";
import { writeFileAtomic } from "./atomic-write";

// The certificate the HTTPS server presents. server.js reads these two files
// at start and watches them, so a new pair takes effect without a restart.
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const CERT_FILE = path.join(DATA_DIR, "cert.pem");
const KEY_FILE = path.join(DATA_DIR, "key.pem");
const PFX_FILE = path.join(DATA_DIR, "cert.pfx");

/** From this many days before expiry on, the certificate is reported as expiring. */
export const CERT_WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CertInfo {
  subject: string;
  issuer: string;
  /** DNS names and IP addresses the certificate is valid for. */
  names: string[];
  validFrom: string;
  validTo: string;
  daysLeft: number;
  selfSigned: boolean;
  fingerprint: string;
  /** Certificates after the first: the chain up to the CA. */
  chainLength: number;
}

export class CertError extends Error {}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

function pemBlocks(text: string): { type: string; pem: string }[] {
  return [...text.matchAll(PEM_BLOCK)].map((m) => ({ type: m[1], pem: m[0] + "\n" }));
}

function describeName(x: string): string {
  // "CN=xenman.example.org\nO=Example" -> "CN=xenman.example.org, O=Example"
  return x.split("\n").filter(Boolean).join(", ");
}

function info(certs: crypto.X509Certificate[]): CertInfo {
  const leaf = certs[0];
  const names = (leaf.subjectAltName ?? "")
    .split(", ")
    .map((s) => s.replace(/^(DNS|IP Address):/, ""))
    .filter(Boolean);
  const validTo = new Date(leaf.validTo);
  return {
    subject: describeName(leaf.subject),
    issuer: describeName(leaf.issuer),
    names,
    validFrom: new Date(leaf.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo.getTime() - Date.now()) / DAY_MS),
    selfSigned: leaf.subject === leaf.issuer && leaf.checkIssued(leaf),
    fingerprint: leaf.fingerprint256,
    chainLength: certs.length - 1,
  };
}

/** The certificate in use now, or null when HTTPS runs from a PFX or not at all. */
export function currentCert(): CertInfo | null {
  try {
    const certs = pemBlocks(fs.readFileSync(CERT_FILE, "utf-8"))
      .filter((b) => b.type === "CERTIFICATE")
      .map((b) => new crypto.X509Certificate(b.pem));
    return certs.length ? info(certs) : null;
  } catch {
    return null;
  }
}

/** Whether the PFX format and "back to self-signed" are available: both need openssl. */
export function opensslAvailable(): boolean {
  const run = spawnSync("openssl", ["version"], { encoding: "utf-8", timeout: 5000 });
  return run.status === 0;
}

export interface CertUpload {
  /** The certificate, optionally followed by its chain. */
  cert?: string;
  key?: string;
  chain?: string;
  /** For a private key that is itself encrypted. */
  keyPassphrase?: string;
  /** A PKCS#12 file, base64; replaces cert, key and chain. */
  pfx?: string;
  pfxPassword?: string;
}

/**
 * Turns an upload into a certificate chain and an unencrypted private key, or
 * says what is wrong with it. Nothing is written here.
 */
export function prepareCert(upload: CertUpload): { chainPem: string; keyPem: string; info: CertInfo } {
  let certText = `${upload.cert ?? ""}\n${upload.chain ?? ""}`;
  let keyText = upload.key ?? "";
  let passphrase = upload.keyPassphrase || undefined;

  if (upload.pfx) {
    const pem = pfxToPem(Buffer.from(upload.pfx, "base64"), upload.pfxPassword ?? "");
    certText = pem;
    keyText = pem;
    passphrase = undefined;
  }

  const certBlocks = pemBlocks(certText).filter((b) => b.type === "CERTIFICATE");
  const keyBlocks = pemBlocks(keyText).filter((b) => /PRIVATE KEY$/.test(b.type));
  if (certBlocks.length === 0) throw new CertError("No certificate found — expected a PEM file (-----BEGIN CERTIFICATE-----)");
  if (keyBlocks.length === 0) throw new CertError("No private key found — expected a PEM file (-----BEGIN PRIVATE KEY-----)");
  if (keyBlocks.length > 1) throw new CertError("More than one private key — upload only the one that belongs to the certificate");

  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: keyBlocks[0].pem, passphrase });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/passphrase|decrypt|bad decrypt/i.test(msg) || /ENCRYPTED/.test(keyBlocks[0].type)) {
      throw new CertError(passphrase ? "The key passphrase is wrong" : "The private key is encrypted — enter its passphrase");
    }
    throw new CertError("The private key could not be read");
  }

  let certs: crypto.X509Certificate[];
  try {
    certs = certBlocks.map((b) => new crypto.X509Certificate(b.pem));
  } catch {
    throw new CertError("A certificate could not be read");
  }

  // The leaf is the one the key belongs to; it goes first, whatever order
  // the file had (a PFX export usually lists the CA first).
  const leafIndex = certs.findIndex((c) => c.checkPrivateKey(key));
  if (leafIndex < 0) throw new CertError("The private key does not belong to the certificate");
  const [leaf] = certs.splice(leafIndex, 1);
  const chain = orderChain(leaf, certs);
  const ordered = [leaf, ...chain];

  const now = Date.now();
  if (new Date(leaf.validTo).getTime() <= now) throw new CertError(`The certificate expired on ${new Date(leaf.validTo).toISOString().slice(0, 10)}`);
  if (new Date(leaf.validFrom).getTime() > now + DAY_MS) {
    throw new CertError(`The certificate is not valid before ${new Date(leaf.validFrom).toISOString().slice(0, 10)}`);
  }

  const chainPem = ordered.map((c) => c.toString()).join("");
  const keyPem = key.export({ type: "pkcs8", format: "pem" }).toString();

  // What the HTTPS server will be asked to do with it -- if Node cannot, the
  // server would keep the old certificate and nobody would know why.
  try {
    tls.createSecureContext({ cert: chainPem, key: keyPem });
  } catch (err) {
    throw new CertError(`The certificate cannot be used for HTTPS: ${err instanceof Error ? err.message : "unknown reason"}`);
  }
  return { chainPem, keyPem, info: info(ordered) };
}

/** Intermediates in issuing order after the leaf; anything unrelated is dropped. */
function orderChain(leaf: crypto.X509Certificate, rest: crypto.X509Certificate[]): crypto.X509Certificate[] {
  const out: crypto.X509Certificate[] = [];
  let current = leaf;
  const pool = [...rest];
  for (;;) {
    const i = pool.findIndex((c) => current.checkIssued(c) && current.verify(c.publicKey));
    if (i < 0) break;
    const [issuer] = pool.splice(i, 1);
    // A root is not sent: the browser has it or will not trust it anyway.
    if (issuer.subject === issuer.issuer) break;
    out.push(issuer);
    current = issuer;
  }
  return out;
}

function pfxToPem(pfx: Buffer, password: string): string {
  if (pfx.length === 0) throw new CertError("The PFX file is empty");
  if (!opensslAvailable()) throw new CertError("PFX files need openssl, which this installation lacks — upload the certificate and key as PEM instead");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xenman-pfx-"));
  try {
    const file = path.join(tmp, "upload.pfx");
    fs.writeFileSync(file, pfx, { mode: 0o600 });
    // Older Windows exports use RC2/3DES, which OpenSSL 3 only reads with -legacy.
    for (const extra of [[], ["-legacy"]]) {
      const run = spawnSync(
        "openssl",
        ["pkcs12", "-in", file, "-nodes", "-passin", "env:XENMAN_PFX_PASSWORD", ...extra],
        { encoding: "utf-8", timeout: 15000, env: { ...process.env, XENMAN_PFX_PASSWORD: password } },
      );
      if (run.status === 0) return run.stdout;
      if (/mac verify failure|invalid password/i.test(run.stderr)) {
        throw new CertError("The PFX password is wrong");
      }
    }
    throw new CertError("The PFX file could not be read");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Puts a checked pair in place; server.js notices and switches over. */
export function installCert(chainPem: string, keyPem: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Key first: a watcher that wakes between the two writes finds a pair that
  // does not match and keeps the old one until the certificate follows.
  writeFileAtomic(KEY_FILE, keyPem, 0o600);
  writeFileAtomic(CERT_FILE, chainPem, 0o644);
  // A PFX from the Windows self-signed fallback would only confuse the next reader.
  fs.rmSync(PFX_FILE, { force: true });
}

/**
 * A fresh self-signed certificate, named for this machine's hostname and
 * addresses so that at least the name in the browser's warning is right.
 */
export function regenerateSelfSigned(): CertInfo {
  if (!opensslAvailable()) throw new CertError("Creating a certificate needs openssl, which this installation lacks");
  const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "xenman";
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a) && !a!.internal)
    .map((a) => a.address.split("%")[0]);
  const san = [`DNS:${host}`, ...ips.map((ip) => `IP:${ip}`)].join(",");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xenman-cert-"));
  try {
    const run = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
        "-subj", `/CN=${host}`, "-addext", `subjectAltName=${san}`,
        "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem"),
      ],
      { encoding: "utf-8", timeout: 30000 },
    );
    if (run.status !== 0) throw new CertError("openssl could not create a certificate");
    const { chainPem, keyPem, info: made } = prepareCert({
      cert: fs.readFileSync(path.join(tmp, "cert.pem"), "utf-8"),
      key: fs.readFileSync(path.join(tmp, "key.pem"), "utf-8"),
    });
    installCert(chainPem, keyPem);
    return made;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
