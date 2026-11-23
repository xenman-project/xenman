"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { CalendarClock, ChevronDown, ChevronRight, Info, Loader2, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { VmssMessage, VmssOverview, VmssSchedule } from "@/lib/xen-vmss";
import { humanizeAlertName } from "@/lib/alert-format";
import { useDates } from "@/context/date-format-context";
import { useXen } from "@/context/xen-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { SnapshotScheduleDialog } from "@/components/pool/snapshot-schedule-dialog";
import { openPoolTabNext } from "@/components/xen-updates-overview";

/** One /api/xen action on the pool's session. */
export async function vmssCall<T = Record<string, unknown>>(conn: HostConnection, body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/xen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      host: conn.connectedVia || conn.host.address,
      port: conn.host.port,
      useSsl: conn.host.useSsl,
      sessionRef: conn.session?.sessionRef,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_SHORT: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun",
};

/** XenCenter's schedule texts: "Daily; at 02:00", "Weekly; at 02:00 every Mon, Fri", "Hourly; at 15 minutes past each hour". */
export function scheduleText(s: Pick<VmssSchedule, "frequency" | "min" | "hour" | "days">): string {
  if (s.frequency === "hourly") return `Hourly; at ${s.min} minutes past each hour`;
  const at = `${pad(s.hour)}:${pad(s.min)}`;
  if (s.frequency === "daily") return `Daily; at ${at}`;
  return `Weekly; at ${at} every ${s.days.map((d) => DAY_SHORT[d] ?? d).join(", ")}`;
}

const TYPE_TEXT: Record<string, string> = {
  snapshot: "Disk only",
  checkpoint: "Disk and memory",
  snapshot_with_quiesce: "Quiesced",
};

/** What an alert of a schedule says about its run. */
function resultOf(m: VmssMessage): { label: string; tone: "ok" | "bad" | "info" } {
  const n = m.name.toUpperCase();
  if (n.includes("SUCCEEDED")) return { label: "Succeeded", tone: "ok" };
  if (n.includes("FAIL") || n.includes("ERROR") || n.includes("MISSED")) return { label: humanizeAlertName(m.name), tone: "bad" };
  return { label: humanizeAlertName(m.name), tone: "info" };
}
const TONE: Record<string, string> = {
  ok: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  bad: "bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400",
  info: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400",
};

/**
 * A pool's VM snapshot schedules, as XenCenter's VM Snapshot Schedules
 * dialog: each with its VMs, next run (pool time and this browser's) and the
 * result of its last runs; new, edit, enable or disable, run now, delete.
 */
export function SnapshotSchedulesTab({ conn, poolName, canAct }: { conn: HostConnection; poolName: string; canAct: boolean }) {
  const dates = useDates();
  const [data, setData] = useState<VmssOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<VmssSchedule | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<VmssSchedule | null>(null);
  const [history, setHistory] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      setData(await vmssCall<VmssOverview>(conn, { action: "vmss_overview" }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The snapshot schedules could not be read.");
    }
  }, [conn]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function act(s: VmssSchedule, body: Record<string, unknown>, done?: string) {
    setBusy(s.ref);
    setNote(null);
    try {
      await vmssCall(conn, { ...body, vmssRef: s.ref, vmssName: s.name });
      if (done) setNote(done);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The schedule could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  const inSchedule = data ? data.vms.filter((v) => v.schedule).length : 0;
  const mayChange = canAct && !!data?.licensed;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="h-4 w-4 text-muted-foreground" /> Snapshot Schedules
              </CardTitle>
              <CardDescription>
                {data
                  ? `Snapshot schedules defined in pool '${poolName}' (${inSchedule} of ${data.vms.length} VMs in a schedule).`
                  : "Snapshots of VMs taken on a schedule."}
              </CardDescription>
            </div>
            {mayChange && (
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" /> New Schedule
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-0 text-sm sm:p-0">
          {error && <p className="px-4 text-destructive sm:px-6">{error}</p>}
          {note && <p className="px-4 text-muted-foreground sm:px-6">{note}</p>}
          {data && !data.licensed && (
            <p className="px-4 text-amber-700 sm:px-6 dark:text-amber-400">
              The pool&apos;s XenServer license does not include snapshot schedules.
            </p>
          )}
          {!data && !error && (
            <p className="flex items-center gap-2 px-4 pb-4 text-muted-foreground sm:px-6">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading
            </p>
          )}
          {data && data.schedules.length === 0 && (
            <p className="px-4 pb-4 text-muted-foreground sm:px-6">No snapshot schedules are defined in this pool.</p>
          )}
          {data && data.schedules.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Schedule</TableHead>
                  <TableHead className="hidden md:table-cell">Status</TableHead>
                  <TableHead className="hidden sm:table-cell">VMs</TableHead>
                  <TableHead className="hidden lg:table-cell">Next run</TableHead>
                  <TableHead>Last result</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.schedules.map((s) => {
                  const last = s.messages[0];
                  const r = last ? resultOf(last) : null;
                  const open = !!history[s.ref];
                  return (
                    <Fragment key={s.ref}>
                      <TableRow className="align-top">
                        <TableCell>
                          <button
                            type="button"
                            aria-label={open ? "Hide run history" : "Show run history"}
                            onClick={() => setHistory((h) => ({ ...h, [s.ref]: !open }))}
                            className="text-muted-foreground"
                          >
                            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        </TableCell>
                        <TableCell className="max-w-64">
                          <p className="truncate font-medium">{s.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {scheduleText(s)} · keeps {s.retained} · {TYPE_TEXT[s.type] ?? s.type}
                          </p>
                          {s.description && <p className="truncate text-xs text-muted-foreground">{s.description}</p>}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge variant="outline" className={`font-normal ${s.enabled ? TONE.ok : TONE.info}`}>
                            {s.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">{s.vms.length}</TableCell>
                        <TableCell className="hidden whitespace-nowrap lg:table-cell">
                          {!s.enabled ? (
                            <span className="text-muted-foreground">Disabled</span>
                          ) : s.nextRun ? (
                            <>
                              <p>{s.nextRun} (pool time)</p>
                              {s.nextRunInMin !== null && (
                                <p className="text-xs text-muted-foreground">
                                  {dates.dateTime(Date.now() + s.nextRunInMin * 60_000, { seconds: false })} (your time)
                                </p>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">Unknown</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {r ? (
                            <>
                              <Badge variant="outline" className={`font-normal ${TONE[r.tone]}`}>{r.label}</Badge>
                              {last.ts && <p className="text-xs text-muted-foreground">{dates.dateTime(last.ts, { seconds: false })}</p>}
                            </>
                          ) : (
                            <span className="text-muted-foreground">Not yet run</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {mayChange && (
                            <div className="flex flex-wrap justify-end gap-1">
                              {busy === s.ref && <Loader2 className="mt-2 h-4 w-4 animate-spin text-muted-foreground" />}
                              <Button size="sm" variant="ghost" className="h-8 px-2" title="Edit" disabled={!!busy} onClick={() => { setEditing(s); setDialogOpen(true); }}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2"
                                title={s.enabled ? "Disable" : "Enable"}
                                disabled={!!busy}
                                onClick={() => act(s, { action: "vmss_set_enabled", enabled: !s.enabled })}
                              >
                                {s.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2"
                                title="Run Now"
                                disabled={!!busy || s.vms.length === 0}
                                onClick={() => act(s, { action: "vmss_run_now" }, `Snapshots of "${s.name}" are being taken. See Recent Tasks.`)}
                              >
                                <Zap className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-8 px-2 text-destructive" title="Delete" disabled={!!busy} onClick={() => setDeleting(s)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow key={`${s.ref}:history`}>
                          <TableCell />
                          <TableCell colSpan={6} className="whitespace-normal">
                            {s.messages.length === 0 ? (
                              <p className="text-xs text-muted-foreground">No runs recorded.</p>
                            ) : (
                              <ul className="space-y-1 text-xs">
                                {s.messages.map((m, i) => {
                                  const mr = resultOf(m);
                                  return (
                                    <li key={i} className="flex flex-wrap gap-x-2">
                                      <span className="text-muted-foreground">{m.ts ? dates.dateTime(m.ts, { seconds: false }) : ""}</span>
                                      <span className={mr.tone === "bad" ? "text-red-600 dark:text-red-400" : ""}>{mr.label}</span>
                                      {m.body && <span className="break-words text-muted-foreground">{m.body}</span>}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {data?.serverLocalTime && (
            <p className="px-4 pb-4 text-xs text-muted-foreground sm:px-6">
              Times are the pool coordinator&apos;s local time (now {data.serverLocalTime}).
            </p>
          )}
        </CardContent>
      </Card>

      {data && (
        <SnapshotScheduleDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          conn={conn}
          overview={data}
          schedule={editing}
          onSaved={load}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Snapshot Schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `"${deleting.name}" is deleted${deleting.vms.length ? ` and its ${deleting.vms.length} VM${deleting.vms.length === 1 ? " is" : "s are"} taken out of it` : ""}. No further snapshots are taken on this schedule.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const s = deleting;
                setDeleting(null);
                if (s) act(s, { action: "vmss_delete" });
              }}
            >
              Delete Schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * In a VM's Snapshots tab, as XenCenter shows it at the bottom right: the
 * schedule the VM is in, a choice to change it, and a way to all schedules.
 */
export function VmSnapshotSchedule({ conn, vmRef, canAct }: { conn: HostConnection; vmRef: string; canAct: boolean }) {
  const { selectVm } = useXen();
  const [data, setData] = useState<VmssOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await vmssCall<VmssOverview>(conn, { action: "vmss_overview" }));
    } catch {
      setData(null);
    }
  }, [conn]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  if (!data) return null;
  const mine = data.vms.find((v) => v.ref === vmRef)?.schedule ?? null;
  const s = data.schedules.find((x) => x.ref === mine) ?? null;

  async function choose(value: string) {
    setSaving(true);
    setError(null);
    try {
      await vmssCall(conn, { action: "vm_set_snapshot_schedule", vmRef, vmssRef: value === "none" ? null : value });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The schedule could not be changed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
        <div>
          <p>
            {s
              ? `This VM is part of the snapshot schedule "${s.name}" (${scheduleText(s)}, keeps ${s.retained}).`
              : "This VM is not currently part of a snapshot schedule."}
          </p>
          <button
            type="button"
            className="text-xs text-sky-700 underline underline-offset-2 dark:text-sky-400"
            onClick={() => {
              // The pool view opens on its Snapshot Schedules tab.
              openPoolTabNext("schedules");
              selectVm(null);
            }}
          >
            View snapshot schedules
          </button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
      {canAct && data.licensed && (
        <Select value={mine ?? "none"} onValueChange={choose} disabled={saving}>
          <SelectTrigger className="w-full sm:w-56" aria-label="Snapshot schedule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No schedule</SelectItem>
            {data.schedules.map((x) => (
              <SelectItem key={x.ref} value={x.ref}>{x.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
