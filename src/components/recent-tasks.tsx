"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import { useXen } from "@/context/xen-context";
import { useAuth } from "@/context/auth-context";
import { useDates } from "@/context/date-format-context";
import { formatAge } from "@/lib/alert-format";
import type { RecentTask } from "@/lib/recent-tasks";
import type { HostConnection } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

/** A task, with the pool it belongs to. */
export type PoolTask = RecentTask & { hostId: string };

/** What a list shows: every pool, one pool, one host of a pool, or one VM. */
export type TaskScope =
  | { kind: "all" }
  | { kind: "pool"; hostId: string }
  | { kind: "host"; hostId: string; hostRef: string }
  | { kind: "vm"; hostId: string; vmRef: string };

/** Log lines shown under a task; the earlier ones on hover. */
const SHOWN_LINES = 4;
/** On the dashboard, every pool together: a cap only against a flood. */
const MAX_ALL = 1000;

const STATE_STYLE: Record<RecentTask["state"], { label: string; className: string }> = {
  running: { label: "Running", className: "bg-sky-500/10 text-sky-700 border-sky-500/20 dark:text-sky-400" },
  done: { label: "Done", className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400" },
  failed: { label: "Failed", className: "bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400" },
  cancelled: { label: "Cancelled", className: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400" },
  ended: { label: "Ended", className: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400" },
};

const sortTasks = (a: PoolTask, b: PoolTask) =>
  (a.state === "running") !== (b.state === "running") ? (a.state === "running" ? -1 : 1) : b.startedAt.localeCompare(a.startedAt);

/** The pools a scope reads. */
export function scopePools(scope: TaskScope, connections: Record<string, HostConnection>): string[] {
  if (scope.kind !== "all") return [scope.hostId];
  return Object.keys(connections).filter((id) => connections[id]?.session);
}

/** A host's list: its own actions, its VMs', tasks running on it, update steps on it. A VM's: its own. */
export function filterTasks(tasks: PoolTask[], scope: TaskScope, connections: Record<string, HostConnection>): PoolTask[] {
  if (scope.kind === "all" || scope.kind === "pool") return tasks;
  if (scope.kind === "vm") return tasks.filter((t) => t.object.class === "VM" && t.object.ref === scope.vmRef);
  const conn = connections[scope.hostId];
  return tasks.filter((t) => {
    if (t.hostRefs.includes(scope.hostRef)) return true;
    if (t.object.class === "host" && t.object.ref === scope.hostRef) return true;
    return t.object.class === "VM" && !!t.object.ref && conn?.vms[t.object.ref]?.residentOn === scope.hostRef;
  });
}

/**
 * Recent Tasks of one or more pools (lib/recent-tasks.ts, action tasks_list),
 * read while `active`: every 3 s while something runs and `fast`, else every 15 s.
 */
export function useRecentTasks(hostIds: string[], { active, fast }: { active: boolean; fast: boolean }) {
  const { state } = useXen();
  const [tasks, setTasks] = useState<PoolTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The connections as they are now, without restarting the timer at every change.
  const conns = useRef(state.connections);
  useEffect(() => {
    conns.current = state.connections;
  }, [state.connections]);
  const key = hostIds.filter((id) => state.connections[id]?.session).join(",");

  const post = useCallback(async (hostId: string, body: Record<string, unknown>) => {
    const conn = conns.current[hostId];
    if (!conn?.session) return null;
    return fetch("/api/xen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: conn.connectedVia || conn.host.address,
        port: conn.host.port,
        useSsl: conn.host.useSsl,
        sessionRef: conn.session.sessionRef,
        ...body,
      }),
    });
  }, []);

  const load = useCallback(async (): Promise<PoolTask[] | null> => {
    const ids = key ? key.split(",") : [];
    if (!ids.length) {
      setTasks([]);
      return [];
    }
    const results = await Promise.all(
      ids.map(async (hostId) => {
        try {
          const res = await post(hostId, { action: "tasks_list" });
          if (!res) return null;
          const json = await res.json().catch(() => ({}));
          if (!res.ok) return { error: String(json.error ?? "Recent tasks could not be read.") };
          return { tasks: ((json.tasks ?? []) as RecentTask[]).map((t) => ({ ...t, hostId })) };
        } catch {
          return { error: "No response from XenMan." };
        }
      }),
    );
    const ok = results.filter((r): r is { tasks: PoolTask[] } => !!r && "tasks" in r);
    const failed = results.find((r): r is { error: string } => !!r && "error" in r);
    setError(ok.length === 0 && failed ? failed.error : null);
    const merged = ok.flatMap((r) => r.tasks).sort(sortTasks).slice(0, ids.length > 1 ? MAX_ALL : undefined);
    setTasks(merged);
    return merged;
  }, [key, post]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      const list = await load();
      if (stopped) return;
      timer = setTimeout(tick, fast && list?.some((t) => t.state === "running") ? 3000 : 15000);
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, fast, load]);

  /** Cancel: a XenServer task, or the update job's stop as in the Updates tab. */
  const cancel = useCallback(
    async (t: PoolTask) => {
      let res: Response | null;
      if (t.cancel?.kind === "update-job") {
        res = await fetch("/api/xen-updates/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostId: t.hostId, action: "stop", id: t.cancel.id }),
        });
      } else {
        res = await post(t.hostId, { action: "task_cancel", taskRef: t.cancel?.ref });
      }
      if (res && !res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "The task could not be cancelled.");
      }
      await load();
    },
    [post, load],
  );

  return { tasks, error, cancel };
}

/** The table: When, (Pool), Object, Operation, Status with its latest steps, By, Cancel. */
export function RecentTasksTable({
  tasks,
  showPool = false,
  cancel,
  stickyHeader = false,
}: {
  tasks: PoolTask[];
  showPool?: boolean;
  cancel: (t: PoolTask) => Promise<void>;
  stickyHeader?: boolean;
}) {
  const { state, selectHost, selectVm, selectXenHost } = useXen();
  const { role } = useAuth();
  const dates = useDates();
  const [confirm, setConfirm] = useState<PoolTask | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const poolName = (hostId: string) => {
    const conn = state.connections[hostId];
    return (conn && (Object.values(conn.pools)[0]?.nameLabel || conn.host.name)) || hostId;
  };

  const objectName = (t: PoolTask): string => {
    const conn = state.connections[t.hostId];
    const ref = t.object.ref;
    const known =
      conn &&
      ((ref && t.object.class === "VM" && conn.vms[ref]?.nameLabel) ||
        (ref && t.object.class === "host" && conn.hostRecords[ref]?.nameLabel) ||
        (ref && t.object.class === "SR" && conn.srs[ref]?.nameLabel) ||
        (t.object.class === "pool" && !t.object.name && poolName(t.hostId)));
    return known || t.object.name || (t.object.class === "pool" ? "Pool" : t.object.class === "host" ? "Server" : t.object.class);
  };

  // Opens the VM or host -- in its own pool, which may not be the one shown.
  const open = (t: PoolTask) => {
    const ref = t.object.ref!;
    if (state.selectedHostId !== t.hostId) selectHost(t.hostId);
    if (t.object.class === "VM") selectVm(ref);
    else selectXenHost(ref);
  };

  const canCancel = (t: PoolTask) =>
    t.state === "running" &&
    !!t.cancel &&
    (role === "admin" || (role === "operator" && t.cancel.kind === "task" && !t.cancel.adminOnly));

  const head = stickyHeader ? "sticky top-0 z-10 bg-card dark:bg-[var(--shell-canvas)]" : "";

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={`hidden w-40 sm:table-cell ${head}`}>Date</TableHead>
            {showPool && <TableHead className={`hidden lg:table-cell ${head}`}>Pool</TableHead>}
            <TableHead className={head}>Object</TableHead>
            <TableHead className={`hidden md:table-cell ${head}`}>Operation</TableHead>
            <TableHead className={head}>Status</TableHead>
            <TableHead className={`hidden sm:table-cell ${head}`}>By</TableHead>
            <TableHead className={`w-20 text-right ${head}`}>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((t) => {
            const style = STATE_STYLE[t.state];
            const lines = t.lines.map((l) => `${l.at ? `${dates.time(l.at, { seconds: true })} ` : ""}${l.text}`);
            const earlier = lines.slice(0, Math.max(0, lines.length - SHOWN_LINES));
            const conn = state.connections[t.hostId];
            const ref = t.object.ref;
            const linkable =
              !!ref && !!conn && ((t.object.class === "VM" && !!conn.vms[ref]) || (t.object.class === "host" && !!conn.hostRecords[ref]));
            return (
              <TableRow key={`${t.hostId}:${t.id}`} className="align-top">
                <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell" title={formatAge(t.startedAt)}>
                  {dates.dateTime(t.startedAt, { seconds: false })}
                </TableCell>
                {showPool && <TableCell className="hidden lg:table-cell">{poolName(t.hostId)}</TableCell>}
                <TableCell className="max-w-48">
                  {linkable ? (
                    <button type="button" className="truncate text-left font-medium underline-offset-2 hover:underline" onClick={() => open(t)}>
                      {objectName(t)}
                    </button>
                  ) : (
                    <span className="truncate font-medium">{objectName(t)}</span>
                  )}
                  {/* Where columns are hidden: what, when and by whom under the object. */}
                  <span className="block text-xs text-muted-foreground md:hidden">{t.operation}</span>
                  {showPool && <span className="block text-xs text-muted-foreground lg:hidden">{poolName(t.hostId)}</span>}
                  <span className="block text-xs text-muted-foreground sm:hidden">
                    {dates.dateTime(t.startedAt, { seconds: false })} · {t.by ?? "Other client"}
                  </span>
                </TableCell>
                <TableCell className="hidden md:table-cell">{t.operation}</TableCell>
                <TableCell className="min-w-40 whitespace-normal">
                  <Badge variant="outline" className={`font-normal ${style.className}`}>
                    {style.label}
                    {t.state === "running" && t.progress !== undefined && ` ${t.progress}%`}
                  </Badge>
                  {lines.length > 0 && (
                    <div className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                      {lines.slice(-SHOWN_LINES).map((l, i) => (
                        <p key={i} className="break-words">
                          {l}
                        </p>
                      ))}
                      {earlier.length > 0 && (
                        <p className="cursor-help" title={earlier.join("\n")}>
                          ({earlier.length} earlier line{earlier.length === 1 ? "" : "s"})
                        </p>
                      )}
                    </div>
                  )}
                  {t.error && t.state !== "running" && <p className="mt-1 break-words text-xs text-red-600 dark:text-red-400">{t.error}</p>}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {t.by ?? <span className="text-muted-foreground">Other client</span>}
                </TableCell>
                <TableCell className="text-right">
                  {canCancel(t) && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirm(t)}>
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !cancelling && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.cancel?.kind === "update-job" ? "Stop Update?" : "Cancel Task?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.cancel?.kind === "update-job"
                ? "The update stops after the current step. Installations and host restarts in progress are completed; pending VM migrations are cancelled."
                : `${confirm?.operation ?? "The task"} on ${confirm ? objectName(confirm) : ""} is cancelled. XenServer stops it at the next safe point; what is already done is not undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>{confirm?.cancel?.kind === "update-job" ? "Continue" : "Keep Running"}</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelling}
              onClick={async (e) => {
                e.preventDefault();
                if (!confirm) return;
                setCancelling(true);
                try {
                  await cancel(confirm);
                } finally {
                  setCancelling(false);
                  setConfirm(null);
                }
              }}
            >
              {confirm?.cancel?.kind === "update-job" ? "Stop Update" : "Cancel Task"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Whether the window is at least Tailwind's `md` wide: then the docked panel
 * shows the tasks, below it the overview card -- only one of them reads them.
 */
export function useWideScreen(): boolean | null {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setWide(mq.matches);
    const t = setTimeout(update, 0);
    mq.addEventListener("change", update);
    return () => {
      clearTimeout(t);
      mq.removeEventListener("change", update);
    };
  }, []);
  return wide;
}

const OPEN_KEY = "xenman-recent-tasks-open";

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v !== "0";
  } catch {
    return fallback;
  }
}

/**
 * Recent Tasks as a card in a pool's or host's overview -- on a phone, where
 * there is no room for the docked panel (task-dock.tsx).
 */
export function RecentTasks({ hostId, hostRef }: { hostId: string; hostRef?: string }) {
  const { state } = useXen();
  const [open, setOpen] = useState(true);
  const scope: TaskScope = useMemo(() => (hostRef ? { kind: "host", hostId, hostRef } : { kind: "pool", hostId }), [hostId, hostRef]);
  const pools = useMemo(() => [hostId], [hostId]);
  const wide = useWideScreen();
  const { tasks, error, cancel } = useRecentTasks(pools, { active: open && wide === false, fast: true });

  // After mounting: what this browser chose last time.
  useEffect(() => {
    const t = setTimeout(() => setOpen(readOpen(OPEN_KEY, true)), 0);
    return () => clearTimeout(t);
  }, []);

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? "0" : "1");
      } catch {
        // not kept; fine
      }
      return !o;
    });
  };

  // On a wider screen the docked panel shows them.
  if (!state.connections[hostId] || wide !== false) return null;
  const shown = filterTasks(tasks ?? [], scope, state.connections);
  const running = shown.filter((t) => t.state === "running").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <button type="button" onClick={toggle} className="flex w-full items-center gap-2 text-left" aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Recent Tasks</CardTitle>
          {running > 0 && (
            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
              {running}
            </span>
          )}
        </button>
      </CardHeader>
      {open && (
        <CardContent className="p-0 sm:p-0">
          {error && <p className="px-4 pb-3 text-sm text-destructive sm:px-6">{error}</p>}
          {tasks === null && !error ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground sm:px-6">Loading</p>
          ) : shown.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground sm:px-6">No tasks in the last 24 hours.</p>
          ) : (
            <RecentTasksTable tasks={shown} cancel={cancel} />
          )}
        </CardContent>
      )}
    </Card>
  );
}
