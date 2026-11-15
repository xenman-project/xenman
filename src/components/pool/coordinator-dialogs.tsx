"use client";

// Entering maintenance mode, and "Make Pool Coordinator".
//
// For the coordinator, the maintenance dialog offers a new one, as XenCenter's
// EvacuateHostDialog: the other hosts that are enabled and live, the first
// chosen -- and, XenMan's own, "Keep as coordinator". What stops a change now
// (a pool secret rotation, HA being switched, a cluster being made) is said in
// XenCenter's words. "Make Pool Coordinator" is XenMan's own: the same change
// without maintenance mode, the VMs left running.

import { useEffect, useState } from "react";
import { Crown, Loader2, Wrench } from "lucide-react";
import { useXen } from "@/context/xen-context";
import { useTask } from "@/context/task-context";
import type { CoordinatorOptions } from "@/lib/pool-coordinator";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const KEEP = "keep";

/** The pool's answer for the dialog; null while asking. */
function useCoordinatorOptions(hostId: string, hostRef: string) {
  const { coordinatorOptions } = useXen();
  const [options, setOptions] = useState<CoordinatorOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    coordinatorOptions(hostId, hostRef)
      .then((o) => live && setOptions(o))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // Asked once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, hostRef]);
  return { options, error, loading: !options && !error };
}

export function EnterMaintenanceDialog({
  hostId,
  hostRef,
  hostName,
  onClose,
}: {
  hostId: string;
  hostRef: string;
  hostName: string;
  onClose: () => void;
}) {
  const { hostMaintenanceEnter } = useXen();
  const { addTask } = useTask();
  const { options, error: optionsError, loading } = useCoordinatorOptions(hostId, hostRef);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCoordinator = options?.isCoordinator === true;
  const canChange = isCoordinator && !options?.blocked && (options?.candidates.length ?? 0) > 0;
  // EvacuateHostDialog: the first host chosen, unless none can take over.
  const chosen = choice ?? (canChange ? options!.candidates[0].ref : KEEP);

  async function enter() {
    setBusy(true);
    setError(null);
    try {
      const newCoordinator = isCoordinator && chosen !== KEEP ? options!.candidates.find((c) => c.ref === chosen) : undefined;
      const taskRef = await hostMaintenanceEnter(hostId, hostRef, newCoordinator?.ref);
      if (taskRef) {
        addTask({
          taskRef,
          hostId,
          type: "host_evacuate",
          label: `Evacuating ${hostName}`,
          description: newCoordinator ? `Migrating all VMs to other hosts, then ${newCoordinator.name} as coordinator` : "Migrating all VMs to other hosts",
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Enter Maintenance Mode</DialogTitle>
          <DialogDescription>
            This will disable <strong>{hostName}</strong> and migrate all running VMs to other available hosts.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking the pool
          </p>
        )}
        {optionsError && <p className="text-sm text-red-500">{optionsError}</p>}

        {isCoordinator && (
          <div className="grid gap-3 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm dark:border-amber-700/50 dark:bg-amber-950/30">
            <p className="flex gap-2">
              <Crown className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span>
                {chosen === KEEP
                  ? "This server is the pool coordinator. It stays the coordinator while in maintenance mode."
                  : "This server is the pool coordinator. Entering maintenance mode will nominate a new coordinator for the pool. XenMan will temporarily lose its connection to the pool."}
              </span>
            </p>
            <div className="grid gap-1.5">
              <Label>New coordinator</Label>
              <Select value={chosen} disabled={busy || !canChange} onValueChange={setChoice}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {canChange &&
                    options!.candidates.map((c) => (
                      <SelectItem key={c.ref} value={c.ref}>
                        {c.name}
                      </SelectItem>
                    ))}
                  <SelectItem value={KEEP}>Keep as coordinator</SelectItem>
                </SelectContent>
              </Select>
              {options?.blocked && <p className="text-xs text-amber-700 dark:text-amber-400">{options.blocked}</p>}
              {!options?.blocked && options?.candidates.length === 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">No other server is enabled and running to take over.</p>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || loading} onClick={() => void enter()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
            Enter Maintenance Mode
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DesignateCoordinatorDialog({
  hostId,
  hostRef,
  hostName,
  onClose,
}: {
  hostId: string;
  hostRef: string;
  hostName: string;
  onClose: () => void;
}) {
  const { designateCoordinator } = useXen();
  const { addTask } = useTask();
  const { options, error: optionsError, loading } = useCoordinatorOptions(hostId, hostRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reason = !options
    ? null
    : options.isCoordinator
      ? `${hostName} is already the pool coordinator.`
      : options.blocked ??
        (options.candidates.some((c) => c.ref === hostRef) ? null : `${hostName} is not enabled and running, so it cannot become the coordinator.`);

  async function designate() {
    setBusy(true);
    setError(null);
    try {
      const taskRef = await designateCoordinator(hostId, hostRef);
      if (taskRef) {
        addTask({
          taskRef,
          hostId,
          type: "pool_coordinator",
          label: `${hostName} as pool coordinator`,
          description: `Nominating server ${hostName} as new coordinator`,
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Make Pool Coordinator</DialogTitle>
          <DialogDescription>
            <strong>{hostName}</strong> becomes the pool coordinator
            {options ? <> in place of <strong>{options.coordinator.name}</strong></> : null}. XenMan will temporarily lose its connection to
            the pool. VMs keep running.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking the pool
          </p>
        )}
        {optionsError && <p className="text-sm text-red-500">{optionsError}</p>}
        {reason && <p className="text-sm text-amber-700 dark:text-amber-400">{reason}</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !options || !!reason} onClick={() => void designate()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Crown className="mr-2 h-4 w-4" />}
            Make Pool Coordinator
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
