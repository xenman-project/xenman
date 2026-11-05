import fs from "fs";
import os from "os";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { audit } from "./audit";
import { listUsers } from "./auth";
import { sendMail, smtpConfigured } from "./mailer";
import { mailBaseUrl } from "./public-url";
import { isAppliance } from "./appliance-update";
import { pendingSecurityPackages, readOsStatus, readPolicy } from "./os-update";

// Security updates left waiting get louder the longer they wait. A weekly
// maintenance window installs within seven days, so in window mode these only
// trip when a window was missed or failed -- which is exactly when they should.
// In manual mode they are the reminder that nobody has clicked "Install now".
export const WARN_DAYS = 7;
export const CRITICAL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
/** While critical, the admins are reminded this often. */
const REMIND_MS = 7 * DAY_MS;
/** A failed send is not retried sooner than this: a broken mail server must not turn into hourly noise. */
const RETRY_MS = 6 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const STATE_FILE = path.join(DATA_DIR, "updates", "os-alert-state.json");
const SETTINGS_FILE = path.join(DATA_DIR, "updates", "os-alert-settings.json");

export type AlertLevel = "none" | "warn" | "critical";
const RANK: Record<AlertLevel, number> = { none: 0, warn: 1, critical: 2 };

export interface OsAlert {
  level: AlertLevel;
  /** null when apt could not be asked. */
  count: number | null;
  /** When the current run of pending updates was first seen. */
  pendingSince: string | null;
  days: number;
  message: string | null;
}

export interface AlertSettings {
  /** Notice on every page for admins. Mails need this too. */
  enabled: boolean;
  emailAdmins: boolean;
}

interface AlertState {
  pendingSince: string | null;
  notified: { level: AlertLevel; at: string; episode: string } | null;
  lastAttempt?: string;
}

function now(): Date {
  // For tests only; nothing in production sets it.
  return process.env.XENMAN_NOW ? new Date(process.env.XENMAN_NOW) : new Date();
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch {
    return fallback;
  }
}

function readState(): AlertState {
  return readJson<AlertState>(STATE_FILE, { pendingSince: null, notified: null });
}

function writeState(state: AlertState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

export function readAlertSettings(): AlertSettings {
  // Off by default: a reminder nobody asked for is noise, however well meant.
  const settings = readJson<Partial<AlertSettings>>(SETTINGS_FILE, {});
  const emailAdmins = settings.emailAdmins === true;
  // Settings saved before there was a main switch only knew emailAdmins;
  // whoever turned mails on then wanted reminders.
  const enabled = typeof settings.enabled === "boolean" ? settings.enabled : emailAdmins;
  return { enabled, emailAdmins };
}

export function saveAlertSettings(settings: AlertSettings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function adminRecipients(): string[] {
  return listUsers()
    .filter((u) => u.role === "admin" && u.email)
    .map((u) => u.email as string);
}

export function mailStatus() {
  return { smtpConfigured: smtpConfigured(), adminsWithEmail: adminRecipients().length };
}

/**
 * How serious things are right now. Also keeps track of when the current run
 * of pending updates started: the first time something is seen pending, that
 * moment is recorded, and it is cleared once nothing is.
 */
export async function assess(): Promise<OsAlert> {
  const pending = await pendingSecurityPackages();
  if (pending === null) {
    return { level: "none", count: null, pendingSince: null, days: 0, message: null };
  }

  const state = readState();
  if (pending.length === 0) {
    if (state.pendingSince || state.notified) writeState({ pendingSince: null, notified: null });
    return { level: "none", count: 0, pendingSince: null, days: 0, message: null };
  }

  let since = state.pendingSince;
  if (!since) {
    since = now().toISOString();
    writeState({ ...state, pendingSince: since });
  }
  const days = Math.floor((now().getTime() - Date.parse(since)) / DAY_MS);
  const count = pending.length;
  const waiting = `${count} security update${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} been waiting for ${days} day${days === 1 ? "" : "s"}`;

  let level: AlertLevel = days >= CRITICAL_DAYS ? "critical" : days >= WARN_DAYS ? "warn" : "none";
  let message = level === "none" ? null : waiting;

  // A failed installation is worth knowing about at once, not a week later.
  if (readOsStatus()?.outcome === "failed" && level === "none") {
    level = "warn";
    message = "The last installation of security updates failed";
  }
  if (level !== "none" && readPolicy()?.mode === "window") {
    message += " — the maintenance window did not install them";
  }
  return { level, count, pendingSince: since, days, message };
}

function addressHint(): string {
  // The address from the mail settings, else this appliance's own.
  return `${mailBaseUrl()}/settings`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Mails the admins when the situation gets worse: once on reaching warn, once
 * on reaching critical, and then weekly while it stays critical. A new run of
 * pending updates starts over.
 */
export async function checkAndNotify(): Promise<void> {
  const alert = await assess();
  const state = readState();

  if (alert.level === "none") {
    if (state.notified) writeState({ ...state, notified: null });
    return;
  }
  const settings = readAlertSettings();
  if (!settings.enabled || !settings.emailAdmins) return;

  const last = state.notified;
  const current = alert.pendingSince ?? "failure";
  const due =
    !last ||
    last.episode !== current ||
    RANK[alert.level] > RANK[last.level] ||
    (alert.level === "critical" && now().getTime() - Date.parse(last.at) >= REMIND_MS);
  if (!due) return;
  if (state.lastAttempt && now().getTime() - Date.parse(state.lastAttempt) < RETRY_MS) return;

  const recipients = adminRecipients();
  if (recipients.length === 0) return;

  const host = os.hostname();
  const where = addressHint();
  const packages = (await pendingSecurityPackages()) ?? [];
  const subject =
    alert.level === "critical"
      ? `XenMan ${host}: security updates overdue`
      : `XenMan ${host}: security updates waiting`;
  const list = packages.map((p) => `  ${p.name} ${p.from ?? "(new)"} -> ${p.to}`).join("\n");
  const text =
    `${alert.message}.\n\n${list}\n\n` +
    `Install them in XenMan under ${where}, or at the console with xenman-os-update.\n`;
  const html =
    `<p>${escapeHtml(alert.message ?? "")}.</p>` +
    `<ul>${packages.map((p) => `<li><code>${escapeHtml(p.name)}</code> ${escapeHtml(p.from ?? "(new)")} → ${escapeHtml(p.to)}</li>`).join("")}</ul>` +
    `<p>Install them in XenMan under ${escapeHtml(where)}, or at the console with <code>xenman-os-update</code>.</p>`;

  const at = now().toISOString();
  try {
    const result = await sendMail({ to: recipients, subject, text, html });
    // Not marked as notified: once a mail server is set up, the mail goes out.
    if (result === "no-smtp") return;
    writeState({ ...state, notified: { level: alert.level, at, episode: current }, lastAttempt: at });
    audit({
      actor: "system",
      role: "-",
      ip: "-",
      category: "system",
      action: "os_update_overdue_notified",
      target: `${recipients.length} admin${recipients.length === 1 ? "" : "s"}`,
      outcome: "success",
      detail: `${alert.level}: ${alert.message}`,
    });
  } catch (err) {
    writeState({ ...state, lastAttempt: at });
    audit({
      actor: "system",
      role: "-",
      ip: "-",
      category: "system",
      action: "os_update_overdue_notified",
      target: `${recipients.length} admin${recipients.length === 1 ? "" : "s"}`,
      outcome: "failure",
      detail: err instanceof Error ? err.message : "sending failed",
    });
  }
}

let started = false;

/**
 * Checks hourly in the background, so reminders go out even when nobody opens
 * the interface -- the case they exist for. Appliance only; started once from
 * instrumentation.
 */
export function startOsAlertChecker(): void {
  if (started || !isAppliance()) return;
  started = true;
  const interval = Number(process.env.XENMAN_ALERT_INTERVAL_MS) || CHECK_MS;
  const run = () => {
    checkAndNotify().catch((err) => {
      console.error(`[os-alerts] check failed: ${err instanceof Error ? err.message : err}`);
    });
  };
  setTimeout(run, Math.min(interval, 60_000)).unref();
  setInterval(run, interval).unref();
}
