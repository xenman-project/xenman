"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import { useXen } from "@/context/xen-context";
import { useAuth } from "@/context/auth-context";
import { useDates } from "@/context/date-format-context";
import { formatAge } from "@/lib/alert-format";
import type { RecentTask } from "@/lib/recent-tasks";
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

const OPEN_KEY = "xenman-recent-tasks-open";
/** Log lines shown under a task; the earlier ones on hover. */
const SHOWN_LINES = 4;

const STATE_STYLE: Record<RecentTask["state"], { label: string; className: string }> = {
  running: { label: "Running", className: "bg-sky-500/10 text-sky-700 border-sky-500/20 dark:text-sky-400" },
  done: { label: "Done", className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400" },
  failed: { label: "Failed", className: "bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400" },
  cancelled: { label: "Cancelled", className: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400" },
  ended: { label: "Ended", className: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400" },
};

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * Recent Tasks of a pool -- or, with `hostRef`, of one host: what runs and what
 * ended in the last 24 hours, XenMan's own and other clients' (lib/recent-tasks.ts).
 */
export function RecentTasks({ hostId, hostRef }: { hostId: string; hostRef?: string }) {
  const { state, selectVm, selectXenHost } = useXen();
  const { role } = useAuth();
  const dates = useDates();
  const conn = state.connections[hostId];
  const session = conn?.session?.sessionRef;
  const [open, setOpen] = useState(true);
  const [tasks, setTasks] = useState<RecentTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RecentTask | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // After mounting: what this browser chose last time.
  useEffect(() => {
    const t = setTimeout(() => setOpen(readOpen()), 0);
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

  const post = useCallback(
    async (body: Record<string, unknown>) => {
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
    },
    [conn?.session, conn?.connectedVia, conn?.host.address, conn?.host.port, conn?.host.useSsl],
  );

  const load = useCallback(async () => {
    try {
      const res = await post({ action: "tasks_list" });
      if (!res) return null;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Recent tasks could not be read.");
        return null;
      }
      setError(null);
      setTasks(json.tasks ?? []);
      return (json.tasks ?? []) as RecentTask[];
    } catch {
      setError("No response from XenMan.");
      return null;
    }
  }, [post]);

  // Only while it is open: every 3 s while something runs, else every 15 s.
  useEffect(() => {
    if (!open || !session) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      const list = await load();
      if (stopped) return;
      timer = setTimeout(tick, list?.some((t) => t.state === "running") ? 3000 : 15000);
    };
    timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, session, load]);

  async function cancel(t: RecentTask) {
    setCancelling(true);
    try {
      let res: Response | null;
      if (t.cancel?.kind === "update-job") {
        res = await fetch("/api/xen-updates/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostId, action: "stop", id: t.cancel.id }),
        });
      } else {
        res = await post({ action: "task_cancel", taskRef: t.cancel?.ref });
      }
      if (res && !res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "The task could not be cancelled.");
      }
      await load();
    } finally {
      setCancelling(false);
      setConfirm(null);
    }
  }

  if (!conn) return null;

  const shown = (tasks ?? []).filter((t) => {
    if (!hostRef) return true;
    if (t.hostRefs.includes(hostRef)) return true;
    if (t.object.class === "host" && t.object.ref === hostRef) return true;
    return t.object.class === "VM" && !!t.object.ref && conn.vms[t.object.ref]?.residentOn === hostRef;
  });
  const running = shown.filter((t) => t.state === "running").length;

  const objectName = (t: RecentTask): string => {
    const ref = t.object.ref;
    const known =
      (ref && t.object.class === "VM" && conn.vms[ref]?.nameLabel) ||
      (ref && t.object.class === "host" && conn.hostRecords[ref]?.nameLabel) ||
      (ref && t.object.class === "SR" && conn.srs[ref]?.nameLabel) ||
      (t.object.class === "pool" && !t.object.name && (Object.values(conn.pools)[0]?.nameLabel || conn.host.name));
    return known || t.object.name || (t.object.class === "pool" ? "Pool" : t.object.class === "host" ? "Server" : t.object.class);
  };

  const canCancel = (t: RecentTask) =>
    t.state === "running" &&
    !!t.cancel &&
    (role === "admin" || (role === "operator" && t.cancel.kind === "task" && !t.cancel.adminOnly));

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="hidden w-28 sm:table-cell">When</TableHead>
                  <TableHead>Object</TableHead>
                  <TableHead className="hidden md:table-cell">Operation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">By</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((t) => {
                  const style = STATE_STYLE[t.state];
                  const lines = t.lines.map((l) => `${l.at ? `${dates.time(l.at, { seconds: true })} ` : ""}${l.text}`);
                  const earlier = lines.slice(0, Math.max(0, lines.length - SHOWN_LINES));
                  const ref = t.object.ref;
                  const linkable =
                    !!ref && ((t.object.class === "VM" && !!conn.vms[ref]) || (t.object.class === "host" && !!conn.hostRecords[ref]));
                  return (
                    <TableRow key={t.id} className="align-top">
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell" title={dates.dateTime(t.startedAt)}>
                        {formatAge(t.startedAt)}
                      </TableCell>
                      <TableCell className="max-w-48">
                        {linkable ? (
                          <button
                            type="button"
                            className="truncate text-left font-medium underline-offset-2 hover:underline"
                            onClick={() => (t.object.class === "VM" ? selectVm(ref!) : selectXenHost(ref!))}
                          >
                            {objectName(t)}
                          </button>
                        ) : (
                          <span className="truncate font-medium">{objectName(t)}</span>
                        )}
                        {/* On a phone: what, when and by whom under the object. */}
                        <span className="block text-xs text-muted-foreground md:hidden">{t.operation}</span>
                        <span className="block text-xs text-muted-foreground sm:hidden">
                          {formatAge(t.startedAt)} · {t.by ?? "Other client"}
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
          )}
        </CardContent>
      )}

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
              onClick={(e) => {
                e.preventDefault();
                if (confirm) cancel(confirm);
              }}
            >
              {confirm?.cancel?.kind === "update-job" ? "Stop Update" : "Cancel Task"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
