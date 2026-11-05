// Presentation helpers shared by the alert bell and the events page.
//
// Kept out of lib/xen-events.ts on purpose: that module touches `fs` and can
// only run on the server, while both consumers here are client components.

export type AlertSeverity = "critical" | "warning" | "info";

/**
 * How many alerts travel to the browser and live in the connection state.
 *
 * Enforced twice on purpose: the API caps what it sends, and the reducer caps
 * again because `event_poll` delivers messages one at a time and would other-
 * wise grow the map past it over a long session. Pools in the field hold tens of
 * thousands of unacknowledged messages -- 35k measured -- so this is a working
 * window, never the whole truth. `alertTotal` carries the real count alongside.
 *
 * Lives here rather than in the API route because both a server route and a
 * client context import it, and that route pulls in `fs` and `ssh2`.
 */
export const MAX_ALERTS_TO_CLIENT = 500;

/**
 * XAPI alert priorities run 1 (most urgent) to 5 (informational). Mirrors
 * severityFromPriority() in lib/xen-events.ts so a live alert and its stored
 * history row are coloured the same.
 */
export function alertSeverity(priority: number): AlertSeverity {
  if (priority >= 1 && priority <= 2) return "critical";
  if (priority === 3) return "warning";
  return "info";
}

export const severityStyle: Record<AlertSeverity, { label: string; className: string }> = {
  critical: {
    label: "Critical",
    className: "bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400",
  },
  warning: {
    label: "Warning",
    className: "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
  },
  info: {
    label: "Info",
    className: "bg-sky-500/10 text-sky-600 border-sky-500/20 dark:text-sky-400",
  },
};

export const kindLabel: Record<string, string> = {
  alert: "Alert",
  task: "Operation",
};

// Success/Failure match the audit log's outcome badges.
export const statusStyle: Record<string, { label: string; className: string }> = {
  success: {
    label: "Success",
    className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  },
  failure: {
    label: "Failure",
    className: "bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400",
  },
};

/** "2026-08-06 13:24:07" in the viewer's local timezone. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Compact relative age for the bell, where the full stamp is too wide. */
export function formatAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

// Title-casing an alert name word by word would render VM_SHUTDOWN as
// "Vm Shutdown". These stay upper case instead.
const ACRONYMS = new Set([
  "VM", "SR", "PBD", "PIF", "VIF", "VDI", "VBD", "HA", "IP", "CPU", "RAM",
  "PVS", "WLB", "XAPI", "DR", "TLS", "SSL", "LUN", "ISO", "NFS", "SMB", "CIFS",
  "ISCSI", "FC", "MTU", "VLAN", "UUID", "API", "GPU", "VTPM", "PCI", "USB",
  "CBT", "LVM", "EXT", "SMAPI", "RRD", "SNMP", "DNS", "NTP", "MAC",
]);

/**
 * XAPI alert names are shouty constants (VM_SHUTDOWN, SR_BACKEND_FAILURE_47).
 * Task names are already dotted API calls and stay untouched.
 */
export function humanizeAlertName(name: string): string {
  if (!name || name.includes(".")) return name;
  return name
    .split("_")
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      // A trailing error number (…FAILURE_47) reads better left alone.
      if (/^\d+$/.test(word)) return word;
      return upper.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(" ");
}
