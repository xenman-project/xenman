"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useXen } from "@/context/xen-context";
import { useAuth } from "@/context/auth-context";
import { useTheme } from "@/context/theme-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bell, Check, ExternalLink, X } from "lucide-react";
import type { XenAlert } from "@/lib/types";
import {
  alertSeverity,
  formatAge,
  humanizeAlertName,
  severityStyle,
  type AlertSeverity,
} from "@/lib/alert-format";

/** Without the event loop the pool is only re-read on connect and refresh. */
const FALLBACK_POLL_MS = 60_000;

/** Rows the panel renders. The rest is the events page's job. */
const PANEL_ROWS = 30;

interface BellAlert extends XenAlert {
  hostId: string;
  poolName: string;
  severity: AlertSeverity;
}

const severityRank: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function AlertBell() {
  const { state, fetchAlerts, dismissAlert } = useXen();
  const { role } = useAuth();
  const { eventPolling } = useTheme();
  const [open, setOpen] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [error, setError] = useState("");

  const connectedHostIds = useMemo(
    () =>
      Object.entries(state.connections)
        .filter(([, c]) => c.status === "connected" && c.session)
        .map(([id]) => id)
        .sort()
        .join(","),
    [state.connections],
  );

  // With the event loop running, `message` events already keep the list current.
  // Poll only when it is off — which is the default for a fresh account.
  useEffect(() => {
    if (eventPolling || !connectedHostIds) return;
    const hostIds = connectedHostIds.split(",");

    for (const hostId of hostIds) fetchAlerts(hostId);
    const interval = setInterval(() => {
      for (const hostId of hostIds) fetchAlerts(hostId);
    }, FALLBACK_POLL_MS);

    return () => clearInterval(interval);
  }, [connectedHostIds, eventPolling, fetchAlerts]);

  const { alerts, infoCount } = useMemo(() => {
    const collected: BellAlert[] = [];
    let info = 0;
    for (const [hostId, conn] of Object.entries(state.connections)) {
      if (conn.status !== "connected") continue;
      const poolName =
        Object.values(conn.pools)[0]?.nameLabel || conn.host.name || conn.host.address;
      for (const alert of Object.values(conn.alerts)) {
        const severity = alertSeverity(alert.priority);
        // The bell answers "is something wrong". XenServer files an
        // informational message on every VM shutdown, so a pool that nobody
        // acknowledges accumulates thousands of them -- counting those makes the
        // badge meaningless and buries the one alert that matters. Info lives on
        // the events page; only its count is surfaced here as a footnote.
        if (severity === "info") {
          info++;
          continue;
        }
        collected.push({ ...alert, hostId, poolName, severity });
      }
    }
    // Most urgent first, newest first within a severity.
    collected.sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] ||
        b.timestamp.localeCompare(a.timestamp),
    );
    return { alerts: collected, infoCount: info };
  }, [state.connections]);

  const canDismiss = role !== "viewer";
  const hasCritical = alerts.some((a) => a.severity === "critical");

  async function onDismiss(alert: BellAlert) {
    setBusyRef(alert.ref);
    setError("");
    try {
      await dismissAlert(alert.hostId, alert.ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss alert");
    } finally {
      setBusyRef(null);
    }
  }

  if (alerts.length === 0) return null;

  return (
    <div className="relative">
      {/* Panel — absolute so opening it never shifts the trigger row.
          Height is bounded against the viewport, not the item count: a pool with
          a thousand unacknowledged alerts must not push the list off screen.
          The list is a plain scroll container rather than <ScrollArea>, whose
          root sets no overflow, so a max-height on it does not clip. */}
      {open && (
        <div className="absolute bottom-full right-0 mb-2 flex max-h-[70vh] w-96 flex-col rounded-lg border border-zinc-200 bg-white shadow-lg max-md:fixed max-md:inset-x-3 max-md:bottom-16 max-md:mb-0 max-md:w-auto dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              Events
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-zinc-400"
              onClick={() => setOpen(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>

          {error && (
            <p className="shrink-0 border-b border-zinc-200 px-3 py-2 text-[10px] text-red-500 dark:border-zinc-800">
              {error}
            </p>
          )}

          {/* min-h-0 lets this flex child actually shrink below its content. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {alerts.slice(0, PANEL_ROWS).map((alert) => {
                const badge = severityStyle[alert.severity];
                return (
                  <div key={`${alert.hostId}-${alert.ref}`} className="flex gap-2 p-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant="outline"
                          className={`shrink-0 px-1.5 py-0 text-[9px] ${badge.className}`}
                        >
                          {badge.label}
                        </Badge>
                        <span className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                          {humanizeAlertName(alert.name)}
                        </span>
                      </div>
                      {alert.body && (
                        <p className="line-clamp-2 text-[10px] text-zinc-500">{alert.body}</p>
                      )}
                      <p className="text-[10px] text-zinc-400">
                        {alert.poolName}
                        {alert.cls ? ` · ${alert.cls}` : ""} · {formatAge(alert.timestamp)}
                      </p>
                    </div>
                    {canDismiss && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Dismiss"
                        className="h-6 w-6 shrink-0 p-0 text-zinc-400 hover:text-emerald-600"
                        disabled={busyRef === alert.ref}
                        onClick={() => onDismiss(alert)}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
            {alerts.length > PANEL_ROWS && (
              <p className="px-3 py-2 text-center text-[10px] text-zinc-400">
                {alerts.length - PANEL_ROWS} more on the events page
              </p>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-200 p-2 dark:border-zinc-800">
            <Link href="/events" onClick={() => setOpen(false)}>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-[11px] text-zinc-500"
              >
                <ExternalLink className="mr-1.5 h-3 w-3" />
                View all events
                {infoCount > 0
                  ? ` (+ ${infoCount} informational)`
                  : ""}
              </Button>
            </Link>
          </div>
        </div>
      )}

      {/* Trigger Button */}
      <Button
        size="sm"
        variant="outline"
        className="h-9 gap-2 rounded-full border-zinc-300 bg-white shadow-md dark:border-zinc-700 dark:bg-zinc-900"
        onClick={() => setOpen((o) => !o)}
      >
        <Bell className="h-4 w-4" />
        {/* Only critical and warning reach this point, so the badge always means
            "needs attention". Red when at least one is critical. */}
        <span
          className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-medium text-white ${
            hasCritical ? "bg-red-500" : "bg-amber-500"
          }`}
        >
          {alerts.length}
        </span>
      </Button>
    </div>
  );
}
