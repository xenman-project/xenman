"use client";

import { useMemo, useState } from "react";
import { CircleDot, Loader2, Pause, Play, Power, RotateCcw, Square } from "lucide-react";
import type { HostConnection, VmPowerState, XenVM } from "@/lib/types";
import { useXen } from "@/context/xen-context";
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

const powerStateIcon: Record<VmPowerState, React.ReactNode> = {
  Running: <Power className="h-3 w-3 text-emerald-500" />,
  Halted: <Square className="h-3 w-3 text-zinc-400" />,
  Paused: <Pause className="h-3 w-3 text-amber-500" />,
  Suspended: <CircleDot className="h-3 w-3 text-amber-500" />,
};
const powerStateBadge: Record<VmPowerState, string> = {
  Running: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  Halted: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
  Paused: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  Suspended: "bg-amber-500/10 text-amber-600 border-amber-500/20",
};
const ORDER: Record<VmPowerState, number> = { Running: 0, Paused: 1, Suspended: 2, Halted: 3 };

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

type Bulk = "start" | "shutdown" | "reboot";
/** How many at once: a pool is not to be flooded. */
const PARALLEL = 4;
const BULK: Record<Bulk, { label: string; doing: string; fits: (vm: XenVM) => boolean }> = {
  start: { label: "Start", doing: "Starting", fits: (vm) => vm.powerState === "Halted" || vm.powerState === "Suspended" },
  shutdown: { label: "Shut Down", doing: "Shutting down", fits: (vm) => vm.powerState === "Running" },
  reboot: { label: "Reboot", doing: "Rebooting", fits: (vm) => vm.powerState === "Running" },
};

/**
 * A pool's or a host's VMs, with XenCenter's multiple selection: tick VMs (or
 * all) and start, shut down or reboot them together -- each a vm_power of its
 * own, so each is checked, audited and listed in Recent Tasks as one.
 */
export function VmTable({
  hostId,
  conn,
  vms,
  canAct,
  showHost = false,
}: {
  hostId: string;
  conn: HostConnection;
  vms: XenVM[];
  canAct: boolean;
  showHost?: boolean;
}) {
  const { selectVm, refreshHost } = useXen();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Bulk | null>(null);
  const [force, setForce] = useState(false);
  const [progress, setProgress] = useState<{ action: Bulk; done: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...vms].sort((a, b) => ORDER[a.powerState] - ORDER[b.powerState] || a.nameLabel.localeCompare(b.nameLabel)),
    [vms],
  );
  // Only what is still in the list counts as selected.
  const chosen = sorted.filter((vm) => selected.has(vm.ref));
  const fitting = (a: Bulk) => chosen.filter(BULK[a].fits);
  const allSelected = sorted.length > 0 && chosen.length === sorted.length;

  const toggle = (ref: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(ref);
      else n.delete(ref);
      return n;
    });

  async function run(action: Bulk) {
    const targets = fitting(action);
    setConfirm(null);
    setResult(null);
    setProgress({ action, done: 0, total: targets.length });
    const failed: string[] = [];
    let next = 0;
    const one = async () => {
      while (next < targets.length) {
        const vm = targets[next++];
        const powerAction =
          action === "start" ? (vm.powerState === "Suspended" ? "resume" : "start") : action === "reboot" ? "clean_reboot" : force ? "hard_shutdown" : "clean_shutdown";
        try {
          const res = await fetch("/api/xen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "vm_power",
              host: conn.connectedVia || conn.host.address,
              port: conn.host.port,
              useSsl: conn.host.useSsl,
              sessionRef: conn.session?.sessionRef,
              vmRef: vm.ref,
              powerAction,
            }),
          });
          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            failed.push(`${vm.nameLabel} (${json.error ?? `HTTP ${res.status}`})`);
          }
        } catch {
          failed.push(`${vm.nameLabel} (no response)`);
        }
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, targets.length) }, one));
    setProgress(null);
    setForce(false);
    const ok = targets.length - failed.length;
    setResult(
      `${BULK[action].label}: ${ok} of ${targets.length} done.${failed.length ? ` Failed: ${failed.join(", ")}.` : ""}`,
    );
    if (!failed.length) setSelected(new Set());
    await refreshHost(hostId);
  }

  if (sorted.length === 0) return null;

  return (
    <div className="space-y-3">
      {canAct && (chosen.length > 0 || progress || result) && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-900">
          {progress ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {BULK[progress.action].doing} {progress.done} of {progress.total}
            </span>
          ) : chosen.length > 0 ? (
            <>
              <span className="mr-1">{chosen.length} selected</span>
              <Button size="sm" variant="outline" disabled={!fitting("start").length} onClick={() => setConfirm("start")}>
                <Play className="mr-1.5 h-3.5 w-3.5" /> Start ({fitting("start").length})
              </Button>
              <Button size="sm" variant="outline" disabled={!fitting("shutdown").length} onClick={() => setConfirm("shutdown")}>
                <Square className="mr-1.5 h-3.5 w-3.5" /> Shut Down ({fitting("shutdown").length})
              </Button>
              <Button size="sm" variant="outline" disabled={!fitting("reboot").length} onClick={() => setConfirm("reboot")}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reboot ({fitting("reboot").length})
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </>
          ) : null}
          {result && !progress && <span className="basis-full text-xs text-muted-foreground">{result}</span>}
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            {canAct && (
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  aria-label="Select all VMs"
                  checked={allSelected}
                  disabled={!!progress}
                  onChange={(e) => setSelected(e.target.checked ? new Set(sorted.map((v) => v.ref)) : new Set())}
                />
              </TableHead>
            )}
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>vCPUs</TableHead>
            <TableHead>Memory</TableHead>
            <TableHead>Type</TableHead>
            {showHost && <TableHead>Host</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((vm) => (
            <TableRow
              key={vm.ref}
              className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
              onClick={() => selectVm(vm.ref)}
            >
              {canAct && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${vm.nameLabel}`}
                    checked={selected.has(vm.ref)}
                    disabled={!!progress}
                    onChange={(e) => toggle(vm.ref, e.target.checked)}
                  />
                </TableCell>
              )}
              <TableCell className="font-medium">{vm.nameLabel}</TableCell>
              <TableCell>
                <Badge variant="outline" className={`${powerStateBadge[vm.powerState]} gap-1`}>
                  {powerStateIcon[vm.powerState]}
                  {vm.powerState}
                </Badge>
              </TableCell>
              <TableCell>{vm.vcpusMax}</TableCell>
              <TableCell>{formatBytes(vm.memoryStaticMax)}</TableCell>
              <TableCell className="text-xs uppercase">{vm.domainType || "N/A"}</TableCell>
              {showHost && (
                <TableCell className="text-zinc-500">
                  {conn.hostRecords[vm.residentOn]?.nameLabel || (vm.powerState === "Halted" ? "-" : "Unknown")}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && (setConfirm(null), setForce(false))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm && `${BULK[confirm].label} ${fitting(confirm).length} VM${fitting(confirm).length === 1 ? "" : "s"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm &&
                `${fitting(confirm).slice(0, 10).map((v) => v.nameLabel).join(", ")}${fitting(confirm).length > 10 ? ", …" : ""} will be ${
                  confirm === "start" ? "started" : confirm === "reboot" ? "rebooted" : "shut down"
                }.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm === "shutdown" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Force shut down
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && run(confirm)}>{confirm ? BULK[confirm].label : ""}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
