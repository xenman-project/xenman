"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { HostMemory } from "@/lib/xen-memory";
import type { Dom0MemoryJob } from "@/lib/dom0-memory-job";
import { unitsFor } from "@/lib/vm-memory-edit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { xenNet } from "@/components/networking/host-networking";
import { useXen } from "@/context/xen-context";
import { useTask } from "@/context/task-context";
import { Spinner } from "./memory-edit";

// XenCenter's Control Domain Memory Settings (ControlDomainMemoryDialog), texts
// as XenCenter's: editable in maintenance mode only, and saving reboots the
// server (lib/dom0-memory-job.ts).

export function Dom0MemoryDialog({
  conn,
  host,
  canEnterMaintenance,
  onClose,
  onChanged,
}: {
  conn: HostConnection;
  host: HostMemory;
  /** Another host to evacuate to, and the server enabled. */
  canEnterMaintenance: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const cd = host.controlDomain!;
  const units = unitsFor(cd.max);
  const [value, setValue] = useState(cd.dynamicMin);
  const [confirm, setConfirm] = useState(false);
  const [confirmMaintenance, setConfirmMaintenance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Dom0MemoryJob | null>(null);
  const { hostMaintenanceEnter } = useXen();
  const { addTask } = useTask();

  const changed = value !== cd.dynamicMin;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await xenNet(conn, { action: "host_control_domain_memory", hostRef: host.hostRef, memory: Math.trunc(value), confirmReboot: true });
      setJob(res.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  const enterMaintenance = async () => {
    setConfirmMaintenance(false);
    setError(null);
    try {
      const taskRef = await hostMaintenanceEnter(conn.host.id, host.hostRef);
      if (taskRef) {
        addTask({ taskRef, hostId: conn.host.id, type: "host_evacuate", label: `Evacuating ${host.hostName}`, description: "Migrating all VMs to other hosts" });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The job, until it is over.
  const jobId = job?.id;
  const running = job?.state === "running";
  const changedRef = useRef(onChanged);
  useEffect(() => {
    changedRef.current = onChanged;
  });
  useEffect(() => {
    if (!jobId || !running) return;
    const timer = setInterval(async () => {
      try {
        const res = await xenNet(conn, { action: "host_dom0_job_status", jobId });
        setJob(res.job);
        if (res.job.state !== "running") changedRef.current();
      } catch {
        // The coordinator may be restarting; the next poll may get through.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [conn, jobId, running]);

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Control Domain Memory Settings - {host.hostName}</DialogTitle>
        </DialogHeader>

        {job ? (
          <div className="space-y-2 text-sm">
            <p className="flex items-start gap-2">
              {job.state === "running" ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              ) : job.state === "done" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              )}
              <span>{job.state === "failed" ? job.error : job.step}</span>
            </p>
            {job.state === "running" && <p className="text-xs text-muted-foreground">This goes on in XenMan even if you close the window.</p>}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <p>Specify the amount of memory to be allocated to the Control Domain on this server.</p>
            <div className="flex items-center gap-3">
              <span>Control Domain memory:</span>
              <fieldset disabled={!host.maintenance} className={host.maintenance ? "" : "opacity-60"}>
                <Spinner
                  value={value}
                  range={{ min: cd.staticMin, max: cd.max }}
                  units={units}
                  staticMax={cd.max}
                  onChange={setValue}
                />
              </fieldset>
              <span>{units === "GB" ? "GiB" : "MiB"}</span>
            </div>
            {host.maintenance ? (
              <p className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                Changes to this setting will trigger a server reboot.
              </p>
            ) : (
              <p className="flex flex-wrap items-start gap-x-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>The server must be in maintenance mode to edit this setting. </span>
                {canEnterMaintenance && (
                  <button type="button" className="text-primary underline underline-offset-2" onClick={() => setConfirmMaintenance(true)}>
                    Enter maintenance mode
                  </button>
                )}
              </p>
            )}
            {error && (
              <p className="flex items-start gap-2 whitespace-pre-line text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {job ? (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button disabled={!host.maintenance || !changed || busy} onClick={() => setConfirm(true)}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                OK
              </Button>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            </>
          )}
        </DialogFooter>

        {/* WarningDialog with Yes / No. */}
        <AlertDialog open={confirm} onOpenChange={(o) => !o && !busy && setConfirm(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Control Domain Memory Settings
              </AlertDialogTitle>
              <AlertDialogDescription className="whitespace-pre-line">
                {"Changing the Control Domain memory will cause the server to be rebooted.\n\nDo you want to continue?"}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button disabled={busy} onClick={() => void save()}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Yes
              </Button>
              <AlertDialogCancel disabled={busy}>No</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* The host menu's question before evacuating. */}
        <AlertDialog open={confirmMaintenance} onOpenChange={(o) => !o && setConfirmMaintenance(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Enter Maintenance Mode</AlertDialogTitle>
              <AlertDialogDescription>
                This will disable {host.hostName} and migrate all running VMs to other available hosts.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button onClick={() => void enterMaintenance()}>Enter Maintenance Mode</Button>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
