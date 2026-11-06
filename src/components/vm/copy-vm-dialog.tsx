"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { CopyPlan } from "@/lib/vm-copy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { xenNet } from "@/components/networking/host-networking";
import { useTask } from "@/context/task-context";

// XenCenter's Copy VM dialog, Convert to Template and Create Template From
// Snapshot (lib/vm-copy.ts). The texts are XenCenter's.

/** XenCenter's CopyVMDialog: name, description, fast clone or full copy onto an SR. */
export function CopyVmDialog({
  conn,
  hostId,
  vmRef,
  vmName,
  onClose,
}: {
  conn: HostConnection;
  hostId: string;
  vmRef: string;
  vmName: string;
  onClose: () => void;
}) {
  const { addTask } = useTask();
  const [plan, setPlan] = useState<CopyPlan | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"clone" | "copy">("clone");
  const [srRef, setSrRef] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (first: boolean) => {
      const res = await xenNet(conn, { action: "vm_copy_check", vmRef });
      const p = res.plan as CopyPlan;
      setPlan(p);
      setBlocked(res.blocked ?? null);
      if (first) {
        setName(p.name);
        setDescription(p.description);
        setMode(p.mode);
        setSrRef(p.defaultSr);
      } else {
        // After a rescan: keep the choice while the SR can still take the copy.
        setSrRef((cur) => (cur && p.srs.some((s) => s.ref === cur && s.enabled) ? cur : p.defaultSr));
      }
    },
    [conn, vmRef],
  );

  useEffect(() => {
    load(true).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  async function rescan() {
    if (!plan) return;
    setScanning(true);
    setError(null);
    try {
      await Promise.all(plan.srs.map((s) => xenNet(conn, { action: "sr_scan", srRef: s.ref }).catch(() => {})));
      await load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  async function copy() {
    setBusy(true);
    setError(null);
    const newName = name.trim();
    try {
      const res = await xenNet(conn, {
        action: "vm_copy",
        vmRef,
        mode,
        nameLabel: newName,
        description,
        ...(mode === "copy" ? { srRef } : {}),
      });
      const sr = plan?.srs.find((s) => s.ref === srRef);
      addTask({
        taskRef: res.taskRef,
        hostId,
        type: "vm_copy",
        // VMCloneAction / VMCopyAction titles.
        label:
          mode === "clone"
            ? `Creating '${newName}' by cloning '${vmName}'`
            : `Copying VM '${vmName}' to '${newName}' on SR '${sr?.name ?? "?"}'`,
        description: mode === "clone" ? "Fast clone" : "Full copy",
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canCopy = !!plan && !blocked && name.trim().length > 0 && (mode === "clone" ? plan.cloneEnabled : !!srRef);

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy Virtual Machine</DialogTitle>
        </DialogHeader>

        {!plan && !error && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {plan && (
          <div className="space-y-4 text-sm">
            {blocked && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400">{blocked}</p>}

            <div className="space-y-1.5">
              <Label htmlFor="copy-name">Name:</Label>
              <Input id="copy-name" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="copy-description">Description:</Label>
              <textarea
                id="copy-description"
                value={description}
                maxLength={1024}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>

            <fieldset className="space-y-3 rounded-md border px-3 pb-3 pt-1">
              <legend className="px-1 text-xs font-medium text-muted-foreground">Copy mode</legend>

              <label
                className={`flex items-start gap-2 ${plan.cloneEnabled ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
                title={plan.cloneEnabled ? undefined : plan.cloneUnavailable}
              >
                <input
                  type="radio"
                  name="copy-mode"
                  className="mt-0.5"
                  checked={mode === "clone"}
                  disabled={!plan.cloneEnabled}
                  onChange={() => setMode("clone")}
                />
                <span>
                  <span className="font-medium">Fast clone</span>
                  <span className="block text-xs text-muted-foreground">
                    {plan.cloneEnabled ? "Clone the existing VM, using a storage-level fast disk clone operation" : plan.cloneUnavailable}
                  </span>
                </span>
              </label>

              <label className={`flex items-start gap-2 ${plan.copyEnabled ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
                <input
                  type="radio"
                  name="copy-mode"
                  className="mt-0.5"
                  checked={mode === "copy"}
                  disabled={!plan.copyEnabled}
                  onChange={() => setMode("copy")}
                />
                <span>
                  <span className="font-medium">Full copy</span>
                  <span className="block text-xs text-muted-foreground">
                    Create a full copy of the existing VM on this storage repository:
                  </span>
                </span>
              </label>

              <div className={`space-y-2 pl-6 ${mode === "copy" && plan.copyEnabled ? "" : "pointer-events-none opacity-50"}`}>
                <div className="max-h-48 overflow-y-auto rounded-md border">
                  {plan.srs.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No storage repository can take a copy.</p>}
                  {plan.srs.map((s) => (
                    <button
                      key={s.ref}
                      type="button"
                      disabled={!s.enabled}
                      onClick={() => setSrRef(s.ref)}
                      className={`flex w-full items-center justify-between gap-3 border-b px-3 py-1.5 text-left last:border-b-0 ${
                        srRef === s.ref ? "bg-primary/10" : "hover:bg-muted/60"
                      } ${s.enabled ? "" : "cursor-not-allowed opacity-50"}`}
                    >
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{s.description}</span>
                    </button>
                  ))}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={rescan} disabled={scanning || plan.srs.length === 0}>
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
                  Rescan
                </Button>
              </div>
            </fieldset>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={copy} disabled={!canCopy || busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** XenCenter's Convert to Template: its warning, then the VM becomes a template. */
export function ConvertToTemplateDialog({
  conn,
  vmRef,
  vmName,
  onClose,
  onDone,
}: {
  conn: HostConnection;
  vmRef: string;
  vmName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = vmName.length <= 25 ? vmName : `${vmName.slice(0, 22)}...`;

  async function convert() {
    setBusy(true);
    setError(null);
    try {
      await xenNet(conn, { action: "vm_convert_to_template", vmRef, confirm: true });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Convert VM to Template</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to convert VM &apos;{shown}&apos; to a template? This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              convert();
            }}
            disabled={busy}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Convert
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** XenCenter's Create Template From Snapshot: a name, then a clone of the snapshot. */
export function SnapshotTemplateDialog({
  conn,
  hostId,
  snapshotRef,
  snapshotName,
  onClose,
}: {
  conn: HostConnection;
  hostId: string;
  snapshotRef: string;
  snapshotName: string;
  onClose: () => void;
}) {
  const { addTask } = useTask();
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    xenNet(conn, { action: "vm_snapshot_to_template_check", snapshotRef })
      .then((res) => setName(res.name))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [conn, snapshotRef]);

  async function save() {
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await xenNet(conn, { action: "vm_snapshot_to_template", snapshotRef, nameLabel: name.trim() });
      addTask({
        taskRef: res.taskRef,
        hostId,
        type: "vm_copy",
        label: `Creating '${name.trim()}' by cloning '${snapshotName}'`,
        description: "Template from snapshot",
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as a Template</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 text-sm">
          <Label htmlFor="template-name">Enter a name for the new template:</Label>
          <Input
            id="template-name"
            value={name ?? ""}
            disabled={name === null}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name?.trim() && !busy && save()}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!name?.trim() || busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
