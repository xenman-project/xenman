"use client";

import { useDates } from "@/context/date-format-context";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, PackageCheck, RotateCcw, ShieldAlert } from "lucide-react";
import { useXen } from "@/context/xen-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface PoolSummary {
  hostId: string;
  name: string;
  hosts: number;
  versions: string[];
  lastSync: string | null;
  hostsBehind: number;
  updates: number;
  high: number;
  restartPending: boolean;
  jobRunning: boolean;
  unknown?: boolean;
}

// The pool view's tab to open next, handed over from here: the pool view
// starts on Overview otherwise.
let pendingPoolTab: string | null = null;

function openPoolTabNext(tab: string) {
  pendingPoolTab = tab;
}

/** For HostDetail: the tab it was asked to open with, once. */
export function takePendingPoolTab(): string | null {
  const t = pendingPoolTab;
  pendingPoolTab = null;
  return t;
}

/** On the dashboard: every pool's update state at a glance. */
export function XenUpdatesOverview() {
  const dates = useDates();
  const { selectHost } = useXen();
  const [pools, setPools] = useState<PoolSummary[] | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/xen-updates/summary", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setPools((await res.json()).pools ?? []);
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    // Answered from a 15-minute cache: asking every minute costs nothing.
    const timer = setInterval(load, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  if (!pools || pools.length === 0) return null;

  function open(hostId: string) {
    openPoolTabNext("updates");
    selectHost(hostId);
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <PackageCheck className="h-4 w-4" />
          XenServer Updates
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 sm:p-0">
        <ul className="divide-y">
          {pools.map((p) => (
            <li key={p.hostId}>
              <button
                type="button"
                onClick={() => open(p.hostId)}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left text-sm hover:bg-muted/50 sm:px-6"
              >
                <span className="min-w-0 font-medium">{p.name}</span>
                {p.versions.length > 0 && (
                  <span className="font-mono text-xs text-muted-foreground">{p.versions.join(" / ")}</span>
                )}
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  {p.jobRunning && (
                    <Badge variant="outline" className="gap-1 border-sky-500/40 text-sky-600 dark:text-sky-400">
                      <Loader2 className="h-3 w-3 animate-spin" /> update running
                    </Badge>
                  )}
                  {p.unknown ? (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      unknown
                    </Badge>
                  ) : p.hostsBehind > 0 ? (
                    <Badge
                      variant="outline"
                      className={`gap-1 ${p.high > 0 ? "border-red-600/40 text-red-700 dark:text-red-400" : "border-amber-500/40 text-amber-700 dark:text-amber-400"}`}
                    >
                      {p.high > 0 && <ShieldAlert className="h-3 w-3" />}
                      {p.hostsBehind} of {p.hosts} host{p.hosts === 1 ? "" : "s"} · {p.updates} update{p.updates === 1 ? "" : "s"}
                      {p.high > 0 && ` (${p.high} high)`}
                    </Badge>
                  ) : (
                    !p.restartPending && (
                      <Badge variant="outline" className="gap-1 border-green-600/40 text-green-700 dark:text-green-500">
                        <CheckCircle2 className="h-3 w-3" /> up to date
                      </Badge>
                    )
                  )}
                  {p.restartPending && (
                    <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-400">
                      <RotateCcw className="h-3 w-3" /> restart pending
                    </Badge>
                  )}
                </span>
                <span className="basis-full text-xs text-muted-foreground">
                  {p.unknown
                    ? "The pool did not answer, or was never checked."
                    : `Checked ${p.lastSync ? dates.dateTime(p.lastSync) : "never"}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
