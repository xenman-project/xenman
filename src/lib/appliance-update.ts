import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { pendingSecurityPackages } from "./os-update";

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const UPDATE_DIR = path.join(DATA_DIR, "updates");
const STATUS_FILE = path.join(UPDATE_DIR, "status.json");
const TRIGGER_FILE = path.join(UPDATE_DIR, "trigger");

// Fixed name: the client never gets to choose a path component, which is what
// keeps the trigger file from pointing anywhere but here.
const PACKAGE_NAME = "pending.xenup";
const PACKAGE_FILE = path.join(UPDATE_DIR, PACKAGE_NAME);

const UPDATER = "/usr/local/sbin/xenman-updater";
const XENUP = "/usr/local/lib/xenman/xenup.js";
const RELEASE_KEY = "/etc/xenman/release-key.pub";
const VERSION_FILE = "/opt/xenman/.version";
const RELEASE_RECORD = "/etc/xenman/installed-release";
const REBOOT_REQUIRED = "/var/run/reboot-required";

/** 256 MB. A package is about 25 MB; this only stops a runaway upload. */
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

export interface UpdateManifest {
  format: number;
  product: string;
  version: string;
  commit: string;
  builtAt: string;
  minNode: string;
  payloadSha256: string;
  payloadBytes: number;
}

export interface UpdateStatus {
  state: "verifying" | "installing" | "restarting" | "success" | "failed" | "rolled-back";
  message: string;
  fromVersion: string;
  toVersion: string;
  updatedAt: string;
}

/** Written by the updater, as root, after each update that passed its health check. */
export interface InstalledRelease {
  version: string;
  commit: string;
  builtAt: string;
  installedAt: string;
}

export interface SystemInfo {
  version: string;
  os: string;
  kernel: string;
  /** The Node.js XenMan runs on -- updated by the update packages, not by apt. */
  node: string;
  rebootRequired: boolean;
  /** null when apt could not be queried — the number is a nicety, not a promise. */
  pendingSecurityUpdates: number | null;
  lastSecurityRun: string | null;
}

/**
 * Updates only exist on the appliance. The Windows service and the Docker image
 * have their own update paths, and showing this there would offer something
 * that cannot work.
 */
export function isAppliance(): boolean {
  return fs.existsSync(UPDATER);
}

/** An appliance built without a release key cannot check a package, so it refuses all. */
export function updatesEnabled(): boolean {
  return isAppliance() && fs.existsSync(RELEASE_KEY);
}

export function installedRelease(): InstalledRelease | null {
  try {
    return JSON.parse(fs.readFileSync(RELEASE_RECORD, "utf-8")) as InstalledRelease;
  } catch {
    return null;
  }
}

/**
 * Mirrors the updater's downgrade rule so the interface can say so before
 * anyone clicks. It is not the protection: xenman-updater, running as root,
 * applies the rule itself and refuses regardless of what this returns.
 * The same commit counts as a reinstall, not a downgrade.
 */
export function isDowngrade(pkg: UpdateManifest, installed: InstalledRelease | null): boolean {
  if (!installed?.builtAt) return false;
  if (pkg.commit && pkg.commit === installed.commit) return false;
  return Date.parse(pkg.builtAt) < Date.parse(installed.builtAt);
}

export function currentVersion(): string {
  try {
    return fs.readFileSync(VERSION_FILE, "utf-8").trim() || "unknown";
  } catch {
    return process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown";
  }
}

export function readStatus(): UpdateStatus | null {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8")) as UpdateStatus;
  } catch {
    return null;
  }
}

/** True while the updater is working, so the UI can keep polling instead of idling. */
export function isInstalling(): boolean {
  if (fs.existsSync(TRIGGER_FILE)) return true;
  const status = readStatus();
  return (
    status !== null &&
    ["verifying", "installing", "restarting"].includes(status.state)
  );
}

async function readOsRelease(): Promise<string> {
  try {
    const text = await fs.promises.readFile("/etc/os-release", "utf-8");
    const match = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    return match ? match[1] : "unknown";
  } catch {
    return "unknown";
  }
}

/** null when apt could not be asked; see pendingSecurityPackages. */
async function pendingSecurityUpdates(): Promise<number | null> {
  const packages = await pendingSecurityPackages();
  return packages === null ? null : packages.length;
}

async function lastSecurityRun(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["show", "apt-daily-upgrade.service", "--property=ExecMainExitTimestamp"],
      { timeout: 10_000 },
    );
    const value = stdout.split("=")[1]?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export async function systemInfo(): Promise<SystemInfo> {
  const [os, pending, lastRun] = await Promise.all([
    readOsRelease(),
    pendingSecurityUpdates(),
    lastSecurityRun(),
  ]);
  let kernel = "unknown";
  try {
    kernel = (await fs.promises.readFile("/proc/sys/kernel/osrelease", "utf-8")).trim();
  } catch {
    // not Linux, or /proc unavailable
  }
  return {
    version: currentVersion(),
    os,
    kernel,
    node: process.version,
    rebootRequired: fs.existsSync(REBOOT_REQUIRED),
    pendingSecurityUpdates: pending,
    lastSecurityRun: lastRun,
  };
}

/**
 * Reads the staged package's manifest, or says why it cannot. The reason
 * matters: "not a valid package" alone once hid a truncated upload, and would
 * equally hide an appliance too old for a newer package format.
 */
async function inspectStaged(): Promise<{ manifest: UpdateManifest } | { reason: string }> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [XENUP, "info", "--file", PACKAGE_FILE],
      { timeout: 30_000 },
    );
    return { manifest: JSON.parse(stdout) as UpdateManifest };
  } catch (err) {
    const detail = String((err as { stderr?: unknown }).stderr ?? "")
      .trim()
      .replace(/^xenup:\s*/, "");
    const format = detail.match(/unsupported package format (\d+)/);
    if (format) {
      return {
        reason: `This appliance cannot read format ${format[1]} packages, which are newer than it is. Import a current .xva once; later packages then install from here.`,
      };
    }
    return {
      reason: detail
        ? `not a valid XenMan update package (${detail})`
        : "not a valid XenMan update package",
    };
  }
}

/** Reads the manifest of the package waiting to be installed, if there is one. */
export async function stagedManifest(): Promise<UpdateManifest | null> {
  if (!fs.existsSync(PACKAGE_FILE)) return null;
  const result = await inspectStaged();
  return "manifest" in result ? result.manifest : null;
}

export class UploadError extends Error {}

/**
 * Streams an uploaded package to disk. Streaming rather than buffering because
 * a package is tens of megabytes, the limit allows ten times that, and the
 * appliance runs on 2 GB of RAM.
 *
 * The manifest is read afterwards to reject obvious rubbish early and to show
 * the version before anyone commits to installing. It is *not* a security
 * check — the signature is verified by the updater, as root, before anything
 * is unpacked.
 */
export async function stagePackage(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number | null,
): Promise<UpdateManifest> {
  await fs.promises.mkdir(UPDATE_DIR, { recursive: true });
  await fs.promises.rm(PACKAGE_FILE, { force: true });

  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");

  let written = 0;
  const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    written += chunk.length;
    if (written > MAX_PACKAGE_BYTES) source.destroy(new UploadError("package too large"));
  });

  try {
    await pipeline(source, fs.createWriteStream(PACKAGE_FILE));
  } catch (err) {
    await fs.promises.rm(PACKAGE_FILE, { force: true });
    throw err instanceof UploadError ? err : new UploadError("upload failed");
  }

  // Anything between the browser and here can cut a body short without an
  // error -- Next.js's own middleware did, at 10 MB, and a reverse proxy in
  // front of the appliance can too. The announced length says so plainly.
  if (expectedBytes !== null && written !== expectedBytes) {
    await fs.promises.rm(PACKAGE_FILE, { force: true });
    throw new UploadError(
      `the upload arrived incomplete: ${written} of ${expectedBytes} bytes. Something between the browser and XenMan limits request size.`,
    );
  }

  const result = await inspectStaged();
  if ("reason" in result) {
    await fs.promises.rm(PACKAGE_FILE, { force: true });
    throw new UploadError(result.reason);
  }
  return result.manifest;
}

export async function discardPackage(): Promise<void> {
  await fs.promises.rm(PACKAGE_FILE, { force: true });
}

/**
 * Asks the updater to install the staged package by writing the trigger file a
 * systemd path unit watches. Nothing here runs as root, and nothing here can
 * choose what gets installed beyond the one staged file.
 */
export async function requestInstall(): Promise<void> {
  if (!fs.existsSync(PACKAGE_FILE)) throw new UploadError("no package staged");
  if (!updatesEnabled()) throw new UploadError("updates are disabled on this appliance");
  await fs.promises.writeFile(TRIGGER_FILE, PACKAGE_NAME, "utf-8");
}
