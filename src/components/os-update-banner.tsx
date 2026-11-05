"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ShieldAlert, X } from "lucide-react";

interface Alert {
  level: "none" | "warn" | "critical";
  message: string | null;
  pendingSince: string | null;
}

const POLL_MS = 10 * 60 * 1000;

function dismissKey(alert: Alert) {
  return `xenman-os-alert-dismissed:${alert.level}:${alert.pendingSince ?? "failure"}`;
}

/**
 * A strip across every page when security updates have waited too long, if
 * reminders are switched on. Admins only -- the API refuses everyone else, and
 * they could not act on it anyway. A warning can be put away for the session; a
 * critical one cannot, since being easy to ignore is how it got critical.
 */
export function OsUpdateBanner() {
  const [alert, setAlert] = useState<Alert | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/os-update/alert", { cache: "no-store" });
      if (!res.ok) return setAlert(null);
      const data = await res.json();
      // Switched off under Settings > Appliance > Security Updates: no strip at all.
      const next: Alert | null = data.appliance && data.settings?.enabled ? data.alert : null;
      setAlert(next);
      if (next && next.level !== "none") {
        try {
          setDismissed(sessionStorage.getItem(dismissKey(next)) === "1");
        } catch {
          setDismissed(false);
        }
      }
    } catch {
      // A missing strip is better than a broken page.
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, POLL_MS);
    // The settings card announces a change of the reminder switch.
    window.addEventListener("xenman-os-alert-changed", load);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("xenman-os-alert-changed", load);
    };
  }, [load]);

  if (!alert || alert.level === "none" || !alert.message) return null;
  const critical = alert.level === "critical";
  if (!critical && dismissed) return null;

  function dismiss() {
    if (!alert) return;
    try {
      sessionStorage.setItem(dismissKey(alert), "1");
    } catch {
      // private mode: dismissed until the next reload only
    }
    setDismissed(true);
  }

  return (
    <div
      role="alert"
      className={`flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm ${
        critical
          ? "border-red-600/40 bg-red-600/15 text-red-900 dark:text-red-200"
          : "border-amber-500/40 bg-amber-500/15 text-amber-900 dark:text-amber-200"
      }`}
    >
      {critical ? (
        <ShieldAlert className="h-4 w-4 shrink-0" />
      ) : (
        <AlertTriangle className="h-4 w-4 shrink-0" />
      )}
      <span className="flex-1">
        {alert.message}.{" "}
        <Link href="/settings?tab=appliance" className="font-medium underline underline-offset-2">
          Review under Settings → Appliance → Security Updates
        </Link>
      </span>
      {!critical && (
        <button
          type="button"
          onClick={dismiss}
          className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
          aria-label="Dismiss for this session"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
