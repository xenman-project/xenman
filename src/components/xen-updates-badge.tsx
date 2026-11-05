"use client";

import { useEffect, useState } from "react";
import { Loader2, PackageCheck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface PoolSummary {
  hostId: string;
  hostsBehind: number;
  updates: number;
  high: number;
  restartPending: boolean;
  jobRunning?: boolean;
}

// The summary is answered from the server's cache, so asking often is cheap:
// every minute, and while an update runs every 15 seconds -- so the spinner
// comes and goes with the update, not up to a quarter of an hour later.
const POLL_MS = 60 * 1000;
const POLL_RUNNING_MS = 15 * 1000;

// One poll for every badge on the page: the sidebar shows one per pool.
let summary: Record<string, PoolSummary> = {};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = listeners.size ? setTimeout(refresh, ms) : null;
}

async function refresh() {
  try {
    const res = await fetch("/api/xen-updates/summary", { cache: "no-store" });
    if (res.ok) {
      const json: { pools: PoolSummary[] } = await res.json();
      summary = Object.fromEntries(json.pools.map((p) => [p.hostId, p]));
      listeners.forEach((l) => l());
    }
  } catch {
    // keep the last answer
  }
  schedule(Object.values(summary).some((p) => p.jobRunning) ? POLL_RUNNING_MS : POLL_MS);
}

/** An update was started or stopped: the badges ask at once. */
export function refreshUpdateBadges() {
  if (listeners.size) schedule(0);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) schedule(0);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** A small mark beside a pool in the sidebar when XenServer updates wait. */
export function XenUpdatesBadge({ hostId }: { hostId: string }) {
  const [s, setS] = useState<PoolSummary | undefined>(undefined);
  useEffect(() => subscribe(() => setS(summary[hostId])), [hostId]);

  if (s?.jobRunning) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 text-sky-500" aria-label="XenServer update in progress">
            <Loader2 className="h-3 w-3 animate-spin" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">XenServer update in progress</TooltipContent>
      </Tooltip>
    );
  }
  if (!s || (s.updates === 0 && !s.restartPending)) return null;
  const high = s.high > 0;
  const text = s.updates > 0
    ? `${s.updates} XenServer update${s.updates === 1 ? "" : "s"} for ${s.hostsBehind} host${s.hostsBehind === 1 ? "" : "s"}${high ? `, ${s.high} high severity` : ""}`
    : "A host waits for a restart to finish its updates";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`shrink-0 ${high ? "text-red-500" : "text-amber-500"}`} aria-label={text}>
          <PackageCheck className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{text}</TooltipContent>
    </Tooltip>
  );
}
