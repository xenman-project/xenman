"use client";
import { useDates } from "@/context/date-format-context";

import { useCallback, useEffect, useState } from "react";
import { refreshUpdateBadges } from "@/components/xen-updates-badge";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Crown,
  Download,
  ExternalLink,
  Loader2,
  MinusCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Square,
  XCircle,
} from "lucide-react";
import { XenUpdateDialog } from "@/components/xen-update-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Guidance = "RebootHost" | "RestartToolstack" | "EvacuateHost" | "RestartDeviceModel";

interface XenUpdate {
  id: string;
  summary: string;
  description: string;
  severity: "High" | "None";
  type: string;
  issued: string | null;
  url: string | null;
  guidance: Guidance | null;
  hosts: string[];
}

interface HostState {
  ref: string;
  name: string;
  version: string;
  isCoordinator: boolean;
  live: boolean;
  enabled: boolean;
  updates: string[];
  highSeverity: number;
  guidance: Guidance[];
  livepatches: number;
  pending: string[];
  lastUpdated: string | null;
}

interface PoolUpdates {
  pool: {
    name: string;
    haEnabled: boolean;
    lastSync: string | null;
    autoSync: { enabled: boolean; frequency: string | null };
    channel: { name: string; url: string } | null;
  };
  hosts: HostState[];
  updates: XenUpdate[];
  problem: string | null;
  checkedAt: string;
}

interface JobStep {
  id: string;
  host: string | null;
  hostName: string | null;
  label: string;
  state: "todo" | "running" | "done" | "failed" | "skipped";
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface Job {
  id: string;
  by: string;
  scope: "pool" | "host";
  createdAt: string;
  finishedAt?: string;
  state: "running" | "done" | "failed" | "interrupted" | "stopped";
  stopRequested?: { by: string; at: string };
  steps: JobStep[];
  error?: string;
  notes: string[];
  /** Waiting for an administrator to have the coordinator's toolstack restarted. */
  attention?: { reason: string; hostNames: string[]; coordinatorName: string; since: string; confirmedBy?: string };
}

/** A finished job is shown this long, then the tab is quiet again. */
const SHOW_FINISHED_MS = 24 * 60 * 60 * 1000;

interface Sync {
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

const GUIDANCE_TEXT: Record<Guidance, string> = {
  RebootHost: "Restart host",
  RestartToolstack: "Restart toolstack",
  EvacuateHost: "Evacuate host",
  RestartDeviceModel: "Restart VMs",
};

/** host.pending_guidances: what an earlier installation left to do. */
function pendingText(p: string): string {
  if (p.startsWith("reboot_host")) return "Restart host";
  if (p === "restart_toolstack") return "Restart toolstack";
  if (p === "restart_device_model" || p === "restart_vm") return "Restart VMs";
  return p.replace(/_/g, " ");
}

const TYPE_TEXT: Record<string, string> = {
  SecurityFix: "Security fix",
  Bugfix: "Bug fix",
  Improvement: "Improvement",
  NewFeature: "New feature",
  PreviewFeature: "Preview",
  Foundational: "Foundational",
};

function when(iso: string | null, dateTime: (d: string) => string): string {
  return iso ? dateTime(iso) : "never";
}

/**
 * Updates available for a pool from its XenServer update channel -- or, with
 * `hostRef`, for one host of it.
 */
export function XenUpdatesTab({ hostId, hostRef, isAdmin }: { hostId: string; hostRef?: string; isAdmin: boolean }) {
  const dates = useDates();
  const [data, setData] = useState<PoolUpdates | null>(null);
  const [sync, setSync] = useState<Sync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [job, setJob] = useState<Job | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [jobSeenAt, setJobSeenAt] = useState(0);

  const loadJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/xen-updates/jobs?hostId=${encodeURIComponent(hostId)}`, { cache: "no-store" });
      if (!res.ok) return null;
      const latest: Job | null = (await res.json()).jobs?.[0] ?? null;
      setJob(latest);
      setJobSeenAt(Date.now());
      return latest;
    } catch {
      return null;
    }
  }, [hostId]);

  const load = useCallback(
    async (fresh: boolean) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/xen-updates?hostId=${encodeURIComponent(hostId)}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        setSync(json.sync ?? null);
        if (!res.ok) {
          setError(json.error ?? "The update state could not be read");
          return;
        }
        setError(null);
        setData(json.updates);
      } catch {
        setError("XenMan did not answer");
      } finally {
        setLoading(false);
      }
    },
    [hostId],
  );

  useEffect(() => {
    const first = setTimeout(() => {
      load(false);
      loadJob();
    }, 0);
    return () => clearTimeout(first);
  }, [load, loadJob]);

  // Following a running update; once it ends, the list is read again.
  useEffect(() => {
    if (job?.state !== "running") return;
    const timer = setInterval(async () => {
      const next = await loadJob();
      if (next && next.state !== "running") load(true);
    }, 2000);
    return () => clearInterval(timer);
  }, [job?.state, loadJob, load]);

  // While a check runs, ask how far it is; reload once it is done.
  useEffect(() => {
    if (sync?.state !== "running") return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/xen-updates?hostId=${encodeURIComponent(hostId)}`, { cache: "no-store" }).catch(() => null);
      const json = await res?.json().catch(() => null);
      const next: Sync | null = json?.sync ?? null;
      if (next?.state !== "running") {
        setSync(next);
        load(true);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [sync?.state, hostId, load]);

  async function checkNow() {
    setError(null);
    const res = await fetch("/api/xen-updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId, action: "sync" }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) setError(json.error ?? "The check could not be started");
    else setSync(json.sync);
  }

  const hosts = data ? (hostRef ? data.hosts.filter((h) => h.ref === hostRef) : data.hosts) : [];
  const updates = data ? (hostRef ? data.updates.filter((u) => u.hosts.includes(hostRef)) : data.updates) : [];
  const nameOf = (ref: string) => data?.hosts.find((h) => h.ref === ref)?.name ?? ref;
  const running = sync?.state === "running";
  const jobRunning = job?.state === "running";
  const showJob = job && (jobRunning || (job.finishedAt && jobSeenAt - Date.parse(job.finishedAt) < SHOW_FINISHED_MS));
  const due = hosts.some((h) => h.updates.length > 0 || h.pending.some((p) => p !== "restart_vm"));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div>
              <CardTitle className="text-base">XenServer Updates</CardTitle>
              <CardDescription>
                {data?.pool.channel
                  ? `From the update channel ${data.pool.channel.name || data.pool.channel.url}`
                  : "From the pool's update channel"}
              </CardDescription>
            </div>
            {isAdmin && (
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button size="sm" variant="outline" onClick={checkNow} disabled={running || jobRunning}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${running ? "animate-spin" : ""}`} />
                  {running ? "Checking…" : "Check now"}
                </Button>
                {data && due && (
                  <Button size="sm" onClick={() => setDialogOpen(true)} disabled={running || jobRunning}>
                    <Download className="mr-2 h-4 w-4" />
                    {hostRef ? "Update this host" : "Update pool"}
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {data && (
            <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Last synchronised</span>
                <span>{when(data.pool.lastSync, dates.dateTime)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Automatic sync</span>
                <span>{data.pool.autoSync.enabled ? data.pool.autoSync.frequency ?? "on" : "off"}</span>
              </div>
            </div>
          )}
          {running && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Fetching the update list from the channel — this can take a few minutes.
            </p>
          )}
          {sync?.state === "failed" && sync.error && <Notice tone="error" text={`The last check failed: ${sync.error}`} />}
          {data?.problem && <Notice tone="warn" text={data.problem} />}
          {data?.pool.haEnabled && (
            <Notice tone="warn" text="High availability is on. Installing updates needs it switched off for the duration." />
          )}
          {error && <Notice tone="error" text={error} />}
          {!data && !error && loading && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Asking the pool…
            </p>
          )}
        </CardContent>
      </Card>

      {showJob && job && <JobProgress job={job} isAdmin={isAdmin} onChanged={setJob} />}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{hostRef ? "This host" : "Hosts"}</CardTitle>
            <CardDescription>
              {hostRef ? "What this host lacks and what installing it needs" : "Updated in this order, the coordinator first"}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-0">
            <div className="divide-y text-sm">
              {hosts.map((h) => (
                <div key={h.ref} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {h.isCoordinator && <Crown className="h-3.5 w-3.5 text-amber-500" aria-label="Coordinator" />}
                      {h.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {h.version || "unknown version"} · last updated {when(h.lastUpdated, dates.dateTime)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {!h.live ? (
                      <Badge variant="outline" className="border-red-600/40 text-red-700 dark:text-red-400">offline</Badge>
                    ) : h.updates.length === 0 && h.pending.length === 0 ? (
                      <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                        <CheckCircle2 className="h-4 w-4" /> up to date
                      </span>
                    ) : (
                      <>
                        {h.updates.length > 0 && (
                          <Badge
                            variant="outline"
                            className={
                              h.highSeverity > 0
                                ? "border-red-600/40 text-red-700 dark:text-red-400"
                                : "border-amber-500/40 text-amber-700 dark:text-amber-400"
                            }
                          >
                            {h.updates.length} update{h.updates.length === 1 ? "" : "s"}
                            {h.highSeverity > 0 && ` · ${h.highSeverity} high`}
                          </Badge>
                        )}
                        {h.updates.length > 0 &&
                          h.guidance.map((g) => (
                            <Badge key={g} variant="secondary" className="font-normal">
                              {GUIDANCE_TEXT[g]}
                            </Badge>
                          ))}
                        {h.pending.length > 0 && (
                          <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-400">
                            <RotateCcw className="h-3 w-3" />
                            pending: {[...new Set(h.pending.map(pendingText))].join(", ")}
                          </Badge>
                        )}
                      </>
                    )}
                    {!h.enabled && h.live && <Badge variant="outline">maintenance</Badge>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Available updates {updates.length > 0 && <span className="text-muted-foreground">({updates.length})</span>}
            </CardTitle>
            <CardDescription>Newest first. Select one for details.</CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-0">
            {updates.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground sm:px-6 sm:pb-6">
                {data.problem ? "No list available." : "Nothing to install."}
              </p>
            ) : (
              <div className="divide-y text-sm">
                {updates.map((u) => {
                  const expanded = Boolean(open[u.id]);
                  return (
                    <div key={u.id}>
                      <button
                        type="button"
                        onClick={() => setOpen((o) => ({ ...o, [u.id]: !expanded }))}
                        className="flex w-full flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-muted/50 sm:flex-nowrap sm:px-6"
                      >
                        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium break-words">{u.summary || u.id}</p>
                          <p className="text-xs text-muted-foreground">
                            {u.id}
                            {u.issued && ` · ${dates.date(u.issued)}`}
                          </p>
                        </div>
                        {/* On a phone under the summary, so it keeps the width. */}
                        <div className="flex basis-full flex-wrap gap-1 pl-7 sm:basis-auto sm:shrink-0 sm:justify-end sm:pl-0">
                          {u.severity === "High" && (
                            <Badge variant="outline" className="gap-1 border-red-600/40 text-red-700 dark:text-red-400">
                              <ShieldAlert className="h-3 w-3" /> high
                            </Badge>
                          )}
                          {u.type && <Badge variant="secondary" className="font-normal">{TYPE_TEXT[u.type] ?? u.type}</Badge>}
                          {u.guidance && <Badge variant="outline" className="font-normal">{GUIDANCE_TEXT[u.guidance]}</Badge>}
                        </div>
                      </button>
                      {expanded && (
                        <div className="space-y-2 break-words px-4 pb-4 pl-11 sm:px-6 sm:pl-13">
                          {u.description && <p className="whitespace-pre-wrap text-muted-foreground">{u.description}</p>}
                          {!hostRef && (
                            <p className="text-xs">
                              <span className="text-muted-foreground">Missing on: </span>
                              {u.hosts.map(nameOf).join(", ")}
                            </p>
                          )}
                          {u.url && (
                            <a href={u.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-2">
                              Advisory <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isAdmin && (
        <XenUpdateDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          hostId={hostId}
          target={hostRef ?? "pool"}
          onStarted={() => {
            loadJob();
            refreshUpdateBadges();
          }}
        />
      )}
    </div>
  );
}

function JobProgress({ job, isAdmin, onChanged }: { job: Job; isAdmin: boolean; onChanged: (job: Job) => void }) {
  const dates = useDates();
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const stopping = job.state === "running" && Boolean(job.stopRequested);
  // Waiting for an administrator, and nobody has answered yet.
  const waiting = job.state === "running" && !stopping && job.attention && !job.attention.confirmedBy ? job.attention : null;
  const title =
    job.state === "running"
      ? stopping
        ? "Stopping the update…"
        : waiting
          ? "Update paused — attention needed"
          : "Update in progress"
      : job.state === "done"
        ? "Update finished"
        : job.state === "failed"
          ? "Update failed"
          : job.state === "stopped"
            ? "Update stopped"
            : "Update interrupted";

  async function stop() {
    setStopError(null);
    const res = await fetch("/api/xen-updates/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop", id: job.id }),
    }).catch(() => null);
    const json = await res?.json().catch(() => ({}));
    if (!res?.ok) setStopError(json?.error ?? "The update could not be stopped");
    else if (json.job) {
      onChanged(json.job);
      refreshUpdateBadges();
    }
  }

  async function restartCoordinator() {
    setRestartError(null);
    const res = await fetch("/api/xen-updates/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restart-coordinator", id: job.id }),
    }).catch(() => null);
    const json = await res?.json().catch(() => ({}));
    if (!res?.ok) setRestartError(json?.error ?? "The update could not go on");
    else if (json.job) onChanged(json.job);
  }
  // Steps grouped by host, in the order they run.
  const groups: { name: string; steps: JobStep[] }[] = [];
  for (const s of job.steps) {
    const name = s.hostName ?? "Pool";
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.steps.push(s);
    else groups.push({ name, steps: [s] });
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              {waiting ? (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              ) : job.state === "running" ? (
                <Loader2 className={`h-4 w-4 animate-spin ${stopping ? "text-amber-500" : "text-sky-500"}`} />
              ) : job.state === "done" ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : job.state === "stopped" ? (
                <MinusCircle className="h-4 w-4 text-amber-500" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              {title}
            </CardTitle>
            <CardDescription>
              Started by {job.by} on {dates.dateTime(job.createdAt)}
              {job.stopRequested && ` · stop requested by ${job.stopRequested.by} at ${dates.time(job.stopRequested.at)}`}
              {job.finishedAt && ` · finished ${dates.time(job.finishedAt)}`}
              {job.state === "running" && !stopping && " · continues if you close this page"}
            </CardDescription>
          </div>
          {isAdmin && job.state === "running" && (
            <Button size="sm" variant="outline" className="shrink-0 self-start" onClick={() => setConfirmStop(true)} disabled={stopping}>
              {stopping ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {waiting && (
          <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{waiting.reason}</span>
            </p>
            {isAdmin ? (
              <Button size="sm" onClick={() => setConfirmRestart(true)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Restart the coordinator&apos;s toolstack and continue
              </Button>
            ) : (
              <p className="text-xs">An administrator can let the update go on, or stop it.</p>
            )}
            {restartError && <Notice tone="error" text={restartError} />}
          </div>
        )}
        {groups.map((g, i) => (
          <div key={i} className="space-y-1.5">
            <p className="font-medium">{g.name}</p>
            <ul className="space-y-1">
              {g.steps.map((s) => (
                <li key={s.id} className="flex items-start gap-2">
                  {s.state === "done" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  ) : s.state === "running" ? (
                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-500" />
                  ) : s.state === "failed" ? (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  ) : s.state === "skipped" ? (
                    <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className={`min-w-0 break-words ${s.state === "todo" || s.state === "skipped" ? "text-muted-foreground" : ""}`}>
                    {s.label}
                    {s.detail && <span className="text-muted-foreground"> — {s.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {stopping && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Stopping after the current step — an install, a restart or a vGPU VM on the move is
            finished first.
          </p>
        )}
        {stopError && <Notice tone="error" text={stopError} />}
        {job.error && <Notice tone="error" text={job.error} />}
        {job.notes.map((n) => (
          <Notice key={n} tone="warn" text={n} />
        ))}
      </CardContent>
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the update?</AlertDialogTitle>
            <AlertDialogDescription>
              XenMan stops at the next safe point. An install or a host restart already under way is finished first, and so is
              moving a VM with a vGPU; other VM moves are cancelled and XenServer rolls them back. The host being worked on leaves
              maintenance mode unless it still needs a restart. Hosts not reached yet stay as they are, and VMs already moved
              stay where they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep going</AlertDialogCancel>
            <AlertDialogAction onClick={stop}>Stop the update</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the toolstack of {job.attention?.coordinatorName}?</AlertDialogTitle>
            <AlertDialogDescription>
              XenServer then lets go of the evacuation that did not end, and the update goes on. VMs keep running. XenCenter,
              Workload Balancing, Citrix and every other tool connected to the pool lose their connection for about a minute;
              XenMan reconnects by itself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={restartCoordinator}>Restart and continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Notice({ tone, text }: { tone: "warn" | "error"; text: string }) {
  const warn = tone === "warn";
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-3 ${
        warn ? "border-amber-500/40 bg-amber-500/10" : "border-destructive/40 bg-destructive/10"
      }`}
    >
      {warn ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      {/* XAPI errors carry long refs and paths without spaces. */}
      <p className="min-w-0 break-words">{text}</p>
    </div>
  );
}
