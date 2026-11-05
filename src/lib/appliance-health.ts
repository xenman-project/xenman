import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { CERT_WARN_DAYS, currentCert, type CertInfo } from "./tls-cert";

// How the machine XenMan runs on is doing. Read unprivileged from /proc and
// statfs, so it is cheap enough to ask every few minutes.

export const DISK_WARN_PERCENT = 85;
export const DISK_CRITICAL_PERCENT = 95;

export interface Health {
  uptimeSeconds: number;
  load: number[];
  cpus: number;
  memory: { totalBytes: number; availableBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  /** Whether SSH listens; only the VM console menu switches it. Null off the appliance. */
  ssh: "on" | "off" | null;
}

export interface HealthWarning {
  id: string;
  level: "warn" | "critical";
  message: string;
}

/** MemAvailable, not MemFree: the page cache is memory the kernel gives back. */
function memory(): Health["memory"] {
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf-8");
    const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? NaN) * 1024;
    const total = kb("MemTotal");
    const available = kb("MemAvailable");
    if (Number.isFinite(total) && Number.isFinite(available)) {
      return { totalBytes: total, availableBytes: available };
    }
  } catch {
    // not Linux
  }
  return { totalBytes: os.totalmem(), availableBytes: os.freemem() };
}

async function disk(): Promise<Health["disk"]> {
  // The data directory's file system: that is what fills up -- logs, audit,
  // update packages -- and on the appliance it is the root file system.
  const target = process.env.DATA_DIR || "/";
  for (const p of [target, "/"]) {
    try {
      const s = await fs.promises.statfs(p);
      return { path: p, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      // try the next
    }
  }
  return null;
}

/** systemctl answers unprivileged; anything but a clear answer is "unknown". */
function ssh(): Promise<Health["ssh"]> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", "ssh.service"], { timeout: 5000 }, (_err, stdout) => {
      const state = String(stdout ?? "").trim();
      resolve(state === "active" ? "on" : state === "inactive" || state === "failed" ? "off" : null);
    });
  });
}

export async function health(): Promise<Health> {
  return {
    uptimeSeconds: Math.floor(os.uptime()),
    load: os.loadavg().map((l) => Math.round(l * 100) / 100),
    cpus: os.cpus().length,
    memory: memory(),
    disk: await disk(),
    ssh: await ssh(),
  };
}

export function warnings(h: Health, cert: CertInfo | null): HealthWarning[] {
  const out: HealthWarning[] = [];
  if (h.disk && h.disk.totalBytes > 0) {
    const used = Math.round((1 - h.disk.freeBytes / h.disk.totalBytes) * 100);
    if (used >= DISK_WARN_PERCENT) {
      out.push({
        id: "disk",
        level: used >= DISK_CRITICAL_PERCENT ? "critical" : "warn",
        message: `The disk is ${used}% full — updates and logs need free space`,
      });
    }
  }
  if (cert && !cert.selfSigned && cert.daysLeft <= CERT_WARN_DAYS) {
    out.push({
      id: "cert",
      level: cert.daysLeft <= 7 ? "critical" : "warn",
      message:
        cert.daysLeft < 0
          ? "The HTTPS certificate has expired"
          : `The HTTPS certificate expires in ${cert.daysLeft} day${cert.daysLeft === 1 ? "" : "s"}`,
    });
  }
  return out;
}

export async function healthReport() {
  const h = await health();
  const cert = currentCert();
  return { health: h, cert, warnings: warnings(h, cert) };
}
