"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Crown, RefreshCw, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface PlanHost {
  ref: string;
  name: string;
  isCoordinator: boolean;
  updates: number;
  steps: { kind: string; label: string }[];
}

interface Plan {
  hosts: PlanHost[];
  finalSteps?: string[];
  blockers: string[];
  warnings: string[];
  poolName: string;
  /** Running VMs with a vGPU on the hosts this update empties. */
  vgpuVms?: number;
  /** Running VMs without the VM Tools there: they cannot be live-migrated. */
  noToolsVms?: number;
  /** Whether a mail at the end can reach anyone. */
  mail?: { smtpConfigured: boolean; adminsWithEmail: number };
}

/**
 * Before an update starts: what will happen on which host, in which order,
 * what stands in the way, and the two choices XenCenter offers as well.
 */
export function XenUpdateDialog({
  open,
  onOpenChange,
  hostId,
  target,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string;
  /** "pool" or a host ref. */
  target: string;
  onStarted: () => void;
}) {
  const [automatic, setAutomatic] = useState(true);
  const [moveVmsBack, setMoveVmsBack] = useState(true);
  const [evacuateAlways, setEvacuateAlways] = useState(false);
  const [vgpuShutdown, setVgpuShutdown] = useState(false);
  // Off unless chosen: each VM without the tools goes down briefly.
  const [noToolsRestart, setNoToolsRestart] = useState(false);
  const [skipFailingHosts, setSkipFailingHosts] = useState(true);
  const [mail, setMail] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(
    // `extra`: what only matters when starting -- changing it needs no new plan.
    (dryRun: boolean, extra: Record<string, unknown> = {}) =>
      fetch("/api/xen-updates/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, target, automatic, moveVmsBack, evacuateAlways, vgpuShutdown, noToolsRestart, dryRun, ...extra }),
      }),
    [hostId, target, automatic, moveVmsBack, evacuateAlways, vgpuShutdown, noToolsRestart],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setChecking(true);
      setError(null);
      try {
        const res = await post(true);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(json.error ?? "The plan could not be made");
        else setPlan(json.plan);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, post]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await post(false, { mail, skipFailingHosts });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.blockers?.join(" ") ?? json.error ?? "The update could not start");
        return;
      }
      onOpenChange(false);
      onStarted();
    } finally {
      setStarting(false);
    }
  }

  const blocked = !plan || plan.blockers.length > 0;
  const restarts = plan?.hosts.some((h) => h.steps.some((s) => s.kind === "reboot")) ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{target === "pool" ? "Update the pool" : "Update this host"}</DialogTitle>
          <DialogDescription>
            Host by host, the coordinator first. VMs keep running throughout — on another host
            while theirs is updated. If XenServer asks for more after installing, XenMan does it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Switch id="xu-auto" checked={automatic} onCheckedChange={setAutomatic} />
              <Label htmlFor="xu-auto">Restart hosts and toolstacks automatically when an update needs it</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="xu-away" checked={evacuateAlways} onCheckedChange={setEvacuateAlways} />
              <Label htmlFor="xu-away">Move VMs away before updating a host, even when no restart is needed</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="xu-back" checked={moveVmsBack} onCheckedChange={setMoveVmsBack} />
              <Label htmlFor="xu-back">Move VMs back to their host afterwards</Label>
            </div>
            {/* Only where it matters: hosts this update empties run VMs with a vGPU. */}
            {(plan?.vgpuVms ?? 0) > 0 && (
              <div className="flex items-start gap-2">
                <Switch id="xu-vgpu" checked={vgpuShutdown} onCheckedChange={setVgpuShutdown} />
                <Label htmlFor="xu-vgpu" className="block leading-snug">
                  Shut down VMs with a vGPU instead of migrating them, and start them again afterwards
                  <span className="block text-xs font-normal text-muted-foreground">
                    Off: they are live-migrated as XenCenter does; one whose migration fails is shut down and started
                    again instead of being tried live once more.
                  </span>
                </Label>
              </div>
            )}
            {/* A pool update: one failing host need not end it. */}
            {target === "pool" && (
              <div className="flex items-start gap-2">
                <Switch id="xu-skip" checked={skipFailingHosts} onCheckedChange={setSkipFailingHosts} />
                <Label htmlFor="xu-skip" className="block leading-snug">
                  If a host fails, try again, then skip it and go on with the others
                  <span className="block text-xs font-normal text-muted-foreground">
                    Its step is tried again after 2 and 5 minutes; then the host is put back in service, the others are updated,
                    and it is tried once more at the end. Not for the coordinator.
                  </span>
                </Label>
              </div>
            )}
            {/* Only where it matters: hosts this update empties run VMs without the VM Tools. */}
            {(plan?.noToolsVms ?? 0) > 0 && (
              <div className="flex items-start gap-2">
                <Switch id="xu-notools" checked={noToolsRestart} onCheckedChange={setNoToolsRestart} />
                <Label htmlFor="xu-notools" className="block leading-snug">
                  Shut down the {plan!.noToolsVms} VM{plan!.noToolsVms === 1 ? "" : "s"} without the VM Tools and start{" "}
                  {plan!.noToolsVms === 1 ? "it" : "them"} again on another host
                  <span className="block text-xs font-normal text-muted-foreground">
                    XenServer cannot live-migrate them. A short outage each{moveVmsBack ? ", and once more when moved back" : ""}; a VM
                    that does not shut down within 10 minutes is switched off.
                  </span>
                </Label>
              </div>
            )}
            <div className="flex items-start gap-2">
              <Switch id="xu-mail" checked={mail} onCheckedChange={setMail} />
              <Label htmlFor="xu-mail" className="block leading-snug">
                Email the administrators when the update ends
                {/* Said here rather than discovered later: the mail would not arrive. */}
                {mail && plan?.mail && !plan.mail.smtpConfigured && (
                  <span className="block text-xs font-normal text-amber-600">
                    No mail server is set up (Settings → Mail &amp; Logging → Mail Server).
                  </span>
                )}
                {mail && plan?.mail?.smtpConfigured && plan.mail.adminsWithEmail === 0 && (
                  <span className="block text-xs font-normal text-amber-600">
                    No administrator has an email address in their account.
                  </span>
                )}
              </Label>
            </div>
          </div>

          {checking && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Checking the pool – with many hosts this takes a moment…
            </p>
          )}

          {plan && !checking && (
            <>
              {plan.hosts.map((h, i) => (
                <div key={h.ref} className="space-y-1">
                  <p className="flex items-center gap-2 font-medium">
                    <span className="text-muted-foreground">{i + 1}.</span>
                    {h.isCoordinator && <Crown className="h-3.5 w-3.5 text-amber-500" />}
                    {h.name}
                  </p>
                  <ol className="ml-6 list-decimal space-y-0.5 text-muted-foreground">
                    {h.steps.map((s, j) => (
                      <li key={j}>{s.label}</li>
                    ))}
                  </ol>
                </div>
              ))}
              {(plan.finalSteps ?? []).length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium">
                    <span className="text-muted-foreground">{plan.hosts.length + 1}.</span> Afterwards, for the pool
                  </p>
                  <ol className="ml-6 list-decimal space-y-0.5 text-muted-foreground">
                    {plan.finalSteps!.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </div>
              )}
              {plan.blockers.map((b) => (
                <div key={b} className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <p>{b}</p>
                </div>
              ))}
              {plan.warnings.map((w) => (
                <div key={w} className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <p>{w}</p>
                </div>
              ))}
              {restarts && plan.blockers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  A host restart takes several minutes. XenMan carries on by itself, also if you close
                  this page.
                </p>
              )}
            </>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p>{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={start} disabled={blocked || checking || starting}>
            {starting ? "Starting…" : "Start update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
