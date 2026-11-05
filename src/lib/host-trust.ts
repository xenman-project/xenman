// Which XenServer hosts XenMan trusts: per configured pool the SHA-256
// fingerprints of its hosts' TLS certificates, and the SSH host keys seen.
//
// XenServer hosts present self-signed certificates, so there is no CA to ask.
// Instead, as SSH does: an admin confirms the coordinator's fingerprint once
// when adding the pool, XenMan learns the other members' certificates from
// the pool itself over that checked connection, and from then on every
// connection -- XAPI, performance data, updates, console -- has to present one
// of them (lib/xen-tls.ts). A certificate that is not one of them stops the
// connection before anything is sent, is audited, and is mailed to the admins.
//
// Checked against the pool's set, not per address: when the coordinator moves
// to another member (HA, a new coordinator designated), that member is already
// known and nothing has to be confirmed.
//
// Pools configured before this existed are taken over on first contact, once,
// and flagged for an admin to compare the fingerprint ("migrated").

import fs from "fs";
import path from "path";
import crypto from "crypto";
import tls, { type PeerCertificate } from "tls";
import { writeFileAtomic } from "./atomic-write";
import { audit } from "./audit";
import { loadHostsFromDisk } from "./host-storage";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const FILE = path.join(DATA_DIR, "host-trust.json");
const MAIL_EVERY_MS = 24 * 60 * 60 * 1000;

export type TrustSource = "admin" | "pool" | "migrated";

export interface TrustedCert {
  /** SHA-256, upper-case hex pairs joined by ":", as OpenSSL prints it. */
  fingerprint: string;
  source: TrustSource;
  since: string;
  /** What the pool says about it, once learned. */
  host?: string;
  uuid?: string;
  address?: string;
  notAfter?: string;
}

/** A certificate that was presented and refused. */
export interface CertMismatch {
  address: string;
  fingerprint: string;
  subject?: string;
  issuer?: string;
  notAfter?: string;
  at: string;
  /** What would have been accepted, for the comparison. */
  expected: { fingerprint: string; host?: string; address?: string }[];
}

export interface SshKey {
  /** SHA-256 of the host key, base64 as OpenSSH prints it ("SHA256:..."). */
  fingerprint: string;
  since: string;
}

export interface SshMismatch {
  address: string;
  fingerprint: string;
  expected: string;
  at: string;
}

export interface PoolTrust {
  certs: TrustedCert[];
  /** Configured before checking existed: the first certificate seen is taken over. */
  migrate?: boolean;
  /** Taken over without an admin having compared it. */
  pendingReview?: boolean;
  /** The first login after the take-over succeeded: nothing more is taken over. */
  firstContactDone?: boolean;
  mismatch?: CertMismatch;
  sshKeys?: Record<string, SshKey>;
  sshMismatch?: SshMismatch;
  /** When the admins were last mailed about a refused certificate / SSH key: at most daily each. */
  lastMail?: string;
  lastSshMail?: string;
  learnedAt?: string;
}

interface TrustFile {
  version: 1;
  pools: Record<string, PoolTrust>;
}

/** Thrown when a host presents a certificate the pool does not have. */
export class CertMismatchError extends Error {
  readonly code = "CERT_CHANGED";
  constructor(
    readonly poolId: string,
    readonly mismatch: CertMismatch,
  ) {
    super(
      `The certificate of ${mismatch.address} has changed (now ${shortFp(mismatch.fingerprint)}). ` +
        "XenMan did not connect. An admin can review it in Settings → Pools.",
    );
    this.name = "CertMismatchError";
  }
}

/** Thrown when an SSH host key differs from the one seen before. */
export class SshKeyMismatchError extends Error {
  readonly code = "SSH_KEY_CHANGED";
  constructor(readonly poolId: string, readonly mismatch: SshMismatch) {
    super(`The SSH host key of ${mismatch.address} has changed. XenMan did not connect. An admin can review it in Settings → Pools.`);
    this.name = "SshKeyMismatchError";
  }
}

export const shortFp = (fp: string) => `${fp.slice(0, 11)}…${fp.slice(-5)}`;

/** "ab:cd..." or "abcd..." in any case → "AB:CD:...". */
export function normalizeFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.match(/.{2}/g)?.join(":") ?? "";
}

export function pemFingerprint(pem: string): { fingerprint: string; notAfter?: string; subject?: string } | null {
  try {
    const c = new crypto.X509Certificate(pem);
    return { fingerprint: c.fingerprint256, notAfter: new Date(c.validTo).toISOString(), subject: c.subject.replace(/\n/g, ", ") };
  } catch {
    return null;
  }
}

// ── The file ─────────────────────────────────────────────────────────────────

let cache: { mtimeMs: number; data: TrustFile } | null = null;

function read(): TrustFile {
  try {
    const st = fs.statSync(FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as TrustFile;
    if (!data || typeof data.pools !== "object") throw new Error("broken");
    cache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return firstRun();
    // A damaged file trusts nothing rather than everything.
    console.error("[host-trust] host-trust.json unreadable, trusting no host until it is fixed");
    return { version: 1, pools: {} };
  }
}

/**
 * The first start with this feature: every pool configured so far is taken
 * over on its first connection. Pools added later never are -- they are
 * confirmed when added.
 */
function firstRun(): TrustFile {
  const data: TrustFile = { version: 1, pools: {} };
  for (const h of loadHostsFromDisk()) data.pools[h.id] = { certs: [], migrate: true };
  write(data);
  return data;
}

function write(data: TrustFile) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(FILE, JSON.stringify(data, null, 2));
  cache = null;
}

function update(poolId: string, f: (p: PoolTrust) => void) {
  const data = read();
  const p = (data.pools[poolId] ??= { certs: [] });
  f(p);
  write(data);
}

/** A copy: what is read stays as it was when the file changes after. */
export function poolTrust(poolId: string): PoolTrust {
  return structuredClone(read().pools[poolId] ?? { certs: [] });
}

export function allTrust(): Record<string, PoolTrust> {
  return structuredClone(read().pools);
}

/** The pool an address belongs to: configured addresses first, then learned members. */
export function poolForAddress(address: string): string | null {
  const a = address.toLowerCase();
  for (const h of loadHostsFromDisk()) {
    if (h.address.toLowerCase() === a || h.backupAddress?.trim().toLowerCase() === a) return h.id;
  }
  for (const [id, p] of Object.entries(read().pools)) {
    if (p.certs.some((c) => c.address?.toLowerCase() === a)) return id;
  }
  return null;
}

/** Every address of a pool XenMan knows: configured and learned. */
export function knownAddresses(poolId: string): string[] {
  const h = loadHostsFromDisk().find((x) => x.id === poolId);
  const out = new Set<string>();
  if (h) {
    out.add(h.address);
    if (h.backupAddress?.trim()) out.add(h.backupAddress.trim());
  }
  for (const c of poolTrust(poolId).certs) if (c.address) out.add(c.address);
  return [...out];
}

const system = { actor: "system", role: "-" as const, ip: "-" };

function poolName(poolId: string): string {
  const h = loadHostsFromDisk().find((x) => x.id === poolId);
  return h ? `pool "${h.name || h.address}"` : `pool ${poolId}`;
}

// ── TLS certificates ─────────────────────────────────────────────────────────

// The certificate each address last presented and was accepted with, to
// check what the pool reports against what is actually on the wire.
const gp = globalThis as unknown as { _xenmanPresentedCerts?: Map<string, string> };
const presented = (gp._xenmanPresentedCerts ??= new Map());

/**
 * Whether a certificate presented by `address` belongs to the pool. Takes it
 * over when the pool is one from before checking existed; records, audits and
 * mails a mismatch.
 */
export function checkCertificate(poolId: string, address: string, cert: PeerCertificate): { ok: true } | { ok: false; error: CertMismatchError } {
  const fingerprint = normalizeFingerprint(cert.fingerprint256 ?? "");
  const p = poolTrust(poolId);
  if (fingerprint && p.certs.some((c) => c.fingerprint === fingerprint)) {
    presented.set(`${poolId}|${address.toLowerCase()}`, fingerprint);
    return { ok: true };
  }
  const notAfter = cert.valid_to ? new Date(cert.valid_to).toISOString() : undefined;

  // Taken over: a pool from before checking existed, on its first contact --
  // the address configured, and the coordinator it redirects to -- until the
  // first login succeeds; from then on the pool says what its hosts present.
  const firstContact =
    (p.migrate && p.certs.length === 0) ||
    (p.pendingReview && !p.firstContactDone && p.certs.length > 0 && p.certs.every((c) => c.source === "migrated"));
  if (firstContact && fingerprint) {
    presented.set(`${poolId}|${address.toLowerCase()}`, fingerprint);
    update(poolId, (q) => {
      q.certs = [...q.certs.filter((c) => c.fingerprint !== fingerprint), { fingerprint, source: "migrated", since: new Date().toISOString(), address, notAfter }];
      q.migrate = false;
      q.pendingReview = true;
    });
    audit({
      ...system,
      category: "host",
      action: "host_cert_taken_over",
      target: poolName(poolId),
      outcome: "success",
      detail: `${address}: SHA-256 ${fingerprint} -- configured before certificates were checked; to be compared by an admin`,
    });
    return { ok: true };
  }

  const mismatch: CertMismatch = {
    address,
    fingerprint,
    subject: cert.subject ? Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`).join(", ") : undefined,
    issuer: cert.issuer ? Object.entries(cert.issuer).map(([k, v]) => `${k}=${v}`).join(", ") : undefined,
    notAfter,
    at: new Date().toISOString(),
    expected: p.certs.map((c) => ({ fingerprint: c.fingerprint, host: c.host, address: c.address })),
  };
  reportMismatch(poolId, mismatch);
  return { ok: false, error: new CertMismatchError(poolId, mismatch) };
}

function reportMismatch(poolId: string, m: CertMismatch) {
  const before = poolTrust(poolId);
  const same = before.mismatch?.fingerprint === m.fingerprint && before.mismatch.address === m.address;
  const mailDue = !before.lastMail || Date.now() - Date.parse(before.lastMail) > MAIL_EVERY_MS;
  update(poolId, (q) => {
    q.mismatch = same ? { ...m, at: before.mismatch!.at } : m;
    if (mailDue) q.lastMail = new Date().toISOString();
  });
  // Every attempt would flood the log: once per certificate seen.
  if (!same) {
    audit({
      ...system,
      category: "host",
      action: "host_cert_mismatch",
      target: poolName(poolId),
      outcome: "denied",
      detail: `${m.address} presented SHA-256 ${m.fingerprint}, not one of the ${m.expected.length} trusted -- connection refused`,
    });
  }
  if (mailDue) void mailAdmins(poolId, `Certificate of ${m.address} changed`, [
    `${m.address} in ${poolName(poolId)} presented a TLS certificate XenMan does not trust.`,
    `XenMan refused to connect, so no password or session was sent to it.`,
    ``,
    `Presented: SHA-256 ${m.fingerprint}`,
    ...(m.subject ? [`Subject:   ${m.subject}`] : []),
    ...m.expected.slice(0, 5).map((e) => `Trusted:   SHA-256 ${e.fingerprint}${e.host ? ` (${e.host})` : ""}`),
    ``,
    `If the certificate was renewed on purpose, an admin can accept it in XenMan under Settings → Pools.`,
    `If not, someone may be intercepting the connection to this host.`,
  ]);
}

async function mailAdmins(poolId: string, subject: string, lines: string[]) {
  try {
    const { adminRecipients } = await import("./os-alerts");
    const { sendMail } = await import("./mailer");
    const to = adminRecipients();
    if (!to.length) return;
    const text = lines.join("\n");
    const html = `<pre style="font-family:monospace">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`;
    await sendMail({ to, subject: `XenMan: ${subject}`, text, html });
  } catch (err) {
    console.error(`[host-trust] warning mail for ${poolId} not sent:`, err instanceof Error ? err.message : err);
  }
}

/** An admin confirmed a fingerprint: when adding a pool, or accepting a changed one. */
export function trustCertificate(poolId: string, cert: { fingerprint: string; address: string; notAfter?: string }) {
  const fingerprint = normalizeFingerprint(cert.fingerprint);
  update(poolId, (p) => {
    // The certificate it replaces is not trusted any more.
    p.certs = p.certs.filter((c) => c.address?.toLowerCase() !== cert.address.toLowerCase() && c.fingerprint !== fingerprint);
    p.certs.push({ fingerprint, source: "admin", since: new Date().toISOString(), address: cert.address, notAfter: cert.notAfter });
    if (p.mismatch?.fingerprint === fingerprint) delete p.mismatch;
    p.migrate = false;
    // The members are read from the pool again on the next connection.
    delete p.learnedAt;
  });
}

/** A login succeeded: the first contact of a taken-over pool is over. */
export function endFirstContact(poolId: string) {
  const p = poolTrust(poolId);
  if (p.pendingReview && !p.firstContactDone) update(poolId, (q) => void (q.firstContactDone = true));
}

/** An admin compared the taken-over fingerprints. */
export function markReviewed(poolId: string) {
  update(poolId, (p) => {
    delete p.pendingReview;
    for (const c of p.certs) if (c.source === "migrated") c.source = "admin";
  });
}

export function dismissMismatch(poolId: string) {
  update(poolId, (p) => {
    delete p.mismatch;
    delete p.sshMismatch;
  });
}

export function removeCertificate(poolId: string, fingerprint: string) {
  update(poolId, (p) => {
    p.certs = p.certs.filter((c) => c.fingerprint !== normalizeFingerprint(fingerprint));
  });
}

export function forgetPool(poolId: string) {
  const data = read();
  delete data.pools[poolId];
  write(data);
}

/** A host as the pool describes it, with the certificate it serves. */
export interface LearnedHost {
  uuid: string;
  name: string;
  address: string;
  fingerprint: string;
  notAfter?: string;
}

/**
 * What the pool says about its hosts' certificates, read over a connection
 * that was itself checked: the pool's set becomes exactly these. New and
 * renewed certificates are audited.
 */
export function learnPoolCertificates(poolId: string, hosts: LearnedHost[], via?: string) {
  if (!hosts.length) return;
  const before = poolTrust(poolId);
  // The host asked must report the certificate it was reached with; if it
  // does not, its report is not what is on the wire, and nothing is dropped.
  const onWire = via ? presented.get(`${poolId}|${via.toLowerCase()}`) : undefined;
  const reportedVia = via ? hosts.find((h) => h.address.toLowerCase() === via.toLowerCase()) : undefined;
  const consistent = !onWire || !reportedVia || normalizeFingerprint(reportedVia.fingerprint) === onWire;
  if (!consistent) {
    console.warn(`[host-trust] pool ${poolId}: ${via} reports another certificate than it presents; trusted set only extended`);
  }
  const now = new Date().toISOString();
  const certs: TrustedCert[] = hosts.map((h) => {
    const fingerprint = normalizeFingerprint(h.fingerprint);
    const known = before.certs.find((c) => c.fingerprint === fingerprint);
    return {
      fingerprint,
      source: known?.source ?? "pool",
      since: known?.since ?? now,
      host: h.name,
      uuid: h.uuid,
      address: h.address,
      notAfter: h.notAfter ?? known?.notAfter,
    };
  });
  for (const c of certs) {
    if (before.certs.some((b) => b.fingerprint === c.fingerprint)) continue;
    const renewed = before.certs.find((b) => (b.uuid && b.uuid === c.uuid) || (b.address && b.address === c.address));
    audit({
      ...system,
      category: "host",
      action: renewed ? "host_cert_renewed" : "host_cert_learned",
      target: `${poolName(poolId)}, host ${c.host}`,
      outcome: "success",
      detail: `${c.address}: SHA-256 ${c.fingerprint}${renewed ? ` (was ${renewed.fingerprint})` : ""} -- as the pool reports it`,
    });
  }
  update(poolId, (p) => {
    p.certs = consistent ? certs : [...p.certs.filter((c) => !certs.some((x) => x.fingerprint === c.fingerprint)), ...certs];
    p.learnedAt = now;
    p.migrate = false;
    // What was refused may have been a renewal the pool now confirms.
    if (p.mismatch && certs.some((c) => c.fingerprint === p.mismatch!.fingerprint)) delete p.mismatch;
  });
}

export interface ProbedCertificate {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}

/**
 * The certificate a host presents, to be shown for confirmation. Only the
 * TLS handshake: nothing is sent, so nothing can be learned by a host that
 * is not the one expected.
 */
export function probeCertificate(address: string, port: number): Promise<ProbedCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, port, rejectUnauthorized: false, session: undefined, servername: /^[\d.:]+$/.test(address) ? undefined : address });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${address}:${port} did not answer`));
    }, 10_000);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const raw = socket.getPeerCertificate(true).raw;
      socket.end();
      try {
        const c = new crypto.X509Certificate(raw);
        resolve({
          fingerprint: c.fingerprint256,
          subject: c.subject.replace(/\n/g, ", "),
          issuer: c.issuer.replace(/\n/g, ", "),
          validFrom: new Date(c.validFrom).toISOString(),
          validTo: new Date(c.validTo).toISOString(),
          selfSigned: c.subject === c.issuer,
        });
      } catch {
        reject(new Error(`${address}:${port} presented no readable certificate`));
      }
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${address}:${port}: ${err.message}`));
    });
  });
}

// ── SSH host keys ────────────────────────────────────────────────────────────

/** "SHA256:<base64>" of a raw SSH host key, as ssh-keygen -l prints it. */
export function sshKeyFingerprint(key: Buffer): string {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** First key seen for an address is remembered; a different one later is refused. */
export function checkSshKey(poolId: string, address: string, fingerprint: string): boolean {
  const p = poolTrust(poolId);
  const known = p.sshKeys?.[address];
  if (!known) {
    update(poolId, (q) => {
      q.sshKeys = { ...q.sshKeys, [address]: { fingerprint, since: new Date().toISOString() } };
    });
    audit({ ...system, category: "host", action: "ssh_hostkey_learned", target: poolName(poolId), outcome: "success", detail: `${address}: ${fingerprint}` });
    return true;
  }
  if (known.fingerprint === fingerprint) return true;
  const m: SshMismatch = { address, fingerprint, expected: known.fingerprint, at: new Date().toISOString() };
  const mailDue = !p.lastSshMail || Date.now() - Date.parse(p.lastSshMail) > MAIL_EVERY_MS;
  const same = p.sshMismatch?.fingerprint === fingerprint && p.sshMismatch.address === address;
  update(poolId, (q) => {
    q.sshMismatch = m;
    if (mailDue) q.lastSshMail = m.at;
  });
  if (!same) {
    audit({
      ...system,
      category: "host",
      action: "ssh_hostkey_mismatch",
      target: poolName(poolId),
      outcome: "denied",
      detail: `${address} presented ${fingerprint}, known ${known.fingerprint} -- connection refused`,
    });
  }
  if (mailDue) void mailAdmins(poolId, `SSH host key of ${address} changed`, [
    `${address} in ${poolName(poolId)} presented a different SSH host key.`,
    `XenMan refused the SSH connection, so no password was sent to it.`,
    ``,
    `Presented: ${fingerprint}`,
    `Known:     ${known.fingerprint}`,
    ``,
    `If the host was reinstalled, an admin can accept the new key in XenMan under Settings → Pools.`,
  ]);
  return false;
}

export function acceptSshKey(poolId: string, address: string) {
  update(poolId, (p) => {
    if (p.sshMismatch?.address === address) {
      p.sshKeys = { ...p.sshKeys, [address]: { fingerprint: p.sshMismatch.fingerprint, since: new Date().toISOString() } };
      delete p.sshMismatch;
    }
  });
}

export function removeSshKey(poolId: string, address: string) {
  update(poolId, (p) => {
    if (p.sshKeys) delete p.sshKeys[address];
  });
}

// For the console proxy (vnc-proxy.js), which lives outside Next's module graph
// and reads the session registry the same way.
(globalThis as unknown as { _xenmanTrust?: { checkCertificate: typeof checkCertificate } })._xenmanTrust = { checkCertificate };
