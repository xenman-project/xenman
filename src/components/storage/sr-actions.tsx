"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, MoreHorizontal, Plug, Star, Trash2, Unplug, Wrench, XCircle, Eraser, Scissors } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import { SR_TEXTS, type SrCommand, type SrState } from "@/lib/sr-manage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ConfirmNameDialog } from "@/components/networking/confirm-name";
import { xenNet } from "@/components/networking/host-networking";

// XenCenter's SR menu (lib/sr-manage.ts): Repair, Detach, Forget, Destroy, Set
// as Default and Reclaim freed space, each with XenCenter's question and, when
// it cannot run, its reason as the entry's tooltip.

/** The SR states of a pool, reloaded when `version` changes. */
export function useSrStates(conn: HostConnection, version: unknown) {
  const [states, setStates] = useState<Record<string, SrState>>({});
  const reload = useCallback(async () => {
    try {
      const res = await xenNet(conn, { action: "sr_states" });
      setStates(Object.fromEntries((res.srs as SrState[]).map((s) => [s.ref, s])));
    } catch {
      setStates({});
    }
  }, [conn]);
  useEffect(() => {
    void reload();
  }, [reload, version]);
  return { states, reload };
}

const MENU: { command: SrCommand; label: string; icon: React.ReactNode; danger?: boolean }[] = [
  { command: "repair", label: "Repair", icon: <Wrench className="h-4 w-4" /> },
  { command: "setDefault", label: "Set as Default", icon: <Star className="h-4 w-4" /> },
  { command: "trim", label: "Reclaim freed space", icon: <Scissors className="h-4 w-4" /> },
  { command: "detach", label: "Detach", icon: <Unplug className="h-4 w-4" /> },
  { command: "forget", label: "Forget", icon: <Eraser className="h-4 w-4" />, danger: true },
  { command: "destroy", label: "Destroy", icon: <Trash2 className="h-4 w-4" />, danger: true },
];

export function SrActionsMenu({ conn, state, onDone }: { conn: HostConnection; state: SrState; onDone: () => void }) {
  const [open, setOpen] = useState<SrCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairResult, setRepairResult] = useState<"ok" | string | null>(null);
  const entries = MENU.filter((m) => m.command in state.commands);
  if (entries.length === 0) return null;

  function close() {
    if (busy) return;
    setOpen(null);
    setError(null);
    setRepairResult(null);
  }

  async function run(command: SrCommand, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await xenNet(conn, { action: "sr_command", srRef: state.ref, command, ...extra });
      if (command === "repair") setRepairResult("ok");
      else setOpen(null);
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (command === "repair") setRepairResult(msg);
      else setError(msg);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  // Set as Default asks nothing in XenCenter: it runs at once.
  function choose(command: SrCommand) {
    setError(null);
    if (command === "setDefault") void run("setDefault");
    else setOpen(command);
  }

  const confirmTexts: Partial<Record<SrCommand, { title: string; text: string; action: string }>> = {
    detach: { title: SR_TEXTS.detachTitle, text: SR_TEXTS.detach, action: "Detach" },
    forget: { title: SR_TEXTS.forgetTitle, text: SR_TEXTS.forget(state.name), action: "Yes, Forget" },
    trim: { title: SR_TEXTS.trimTitle, text: SR_TEXTS.trim, action: "Yes" },
  };
  const confirm = open ? confirmTexts[open] : undefined;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="ghost" title="Storage actions" disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {entries.map((m, i) => {
            const reason = state.commands[m.command];
            return (
              <div key={m.command}>
                {m.danger && entries[i - 1] && !entries[i - 1].danger && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  disabled={!!reason}
                  title={reason ?? undefined}
                  onClick={() => choose(m.command)}
                  className={m.danger && !reason ? "text-red-600" : ""}
                >
                  {m.icon}
                  <span className="ml-2">{m.label}</span>
                </DropdownMenuItem>
              </div>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Detach, Forget, Reclaim freed space: XenCenter's question. */}
      {confirm && (
        <Dialog open onOpenChange={(o) => !o && close()}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{confirm.title}</DialogTitle>
            </DialogHeader>
            <p className="whitespace-pre-line text-sm text-muted-foreground">{confirm.text}</p>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <DialogFooter>
              {/* As XenCenter: "No" is the default. */}
              <Button autoFocus variant="outline" onClick={close} disabled={busy}>
                No
              </Button>
              <Button variant={open === "forget" ? "destructive" : "default"} onClick={() => run(open!, { confirm: true })} disabled={busy}>
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {confirm.action}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Destroy: XenCenter's question, and the SR's name typed. */}
      {open === "destroy" && (
        <ConfirmNameDialog
          title={SR_TEXTS.destroyTitle}
          message={SR_TEXTS.destroy(state.name)}
          confirmName={state.name}
          what="SR's name"
          actionLabel="Yes, Destroy"
          busy={busy}
          error={error}
          onConfirm={(typed) => run("destroy", { confirm: true, confirmName: typed })}
          onCancel={close}
        />
      )}

      {/* XenCenter's Repair Storage Repository dialog. */}
      {open === "repair" && (
        <Dialog open onOpenChange={(o) => !o && close()}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Repair Storage Repository - {state.name}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{SR_TEXTS.repairIntro}</p>
            <p className="text-sm font-medium">Current status:</p>
            <div className="rounded-md border text-sm">
              {state.hosts.map((h) => (
                <div key={h.host} className="flex items-center justify-between border-b px-3 py-1.5 last:border-b-0">
                  <span className="flex items-center gap-2">
                    <Plug className="h-3.5 w-3.5 text-muted-foreground" />
                    {h.name}
                  </span>
                  <span className={h.status === "Connected" ? "text-emerald-600" : "text-amber-600"}>{h.status}</span>
                </div>
              ))}
            </div>
            {repairResult === "ok" && (
              <p className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle2 className="h-4 w-4" /> Repaired SR {state.name}
              </p>
            )}
            {repairResult && repairResult !== "ok" && (
              <p className="flex items-start gap-2 text-sm text-red-600">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {repairResult}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={busy}>
                {repairResult ? "Close" : "Cancel"}
              </Button>
              {!repairResult && (
                <Button onClick={() => run("repair")} disabled={busy}>
                  {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Repair
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Set as Default runs without a question; a refusal is said here. */}
      {!open && error && (
        <Dialog open onOpenChange={(o) => !o && setError(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{state.name}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-red-600">{error}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setError(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
