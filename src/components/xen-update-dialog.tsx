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
        if (!res.ok) setError(json.error ?? "Pre-checks could not be completed.");
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
        setError(json.blockers?.join(" ") ?? json.error ?? "The update could not be started.");
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
          <DialogTitle>{target === "pool" ? "Install Updates" : "Install Updates on This Host"}</DialogTitle>
          <DialogDescription>
            {target === "pool"
              ? "Updates are installed on one host at a time, starting with the pool coordinator. Running VMs are migrated to other hosts as required."
              : "Running VMs are migrated to other hosts as required."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Switch id="xu-auto" checked={automatic} onCheckedChange={setAutomatic} />
              <Label htmlFor="xu-auto">Restart hosts and toolstacks automatically when required</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="xu-away" checked={evacuateAlways} onCheckedChange={setEvacuateAlways} />
              <Label htmlFor="xu-away">Evacuate each host before installing updates</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="xu-back" checked={moveVmsBack} onCheckedChange={setMoveVmsBack} />
              <Label htmlFor="xu-back">Migrate VMs back to their original host</Label>
            </div>
            {/* Only where it matters: hosts this update empties run VMs with a vGPU. */}
            {(plan?.vgpuVms ?? 0) > 0 && (
              <div className="flex items-start gap-2">
                <Switch id="xu-vgpu" checked={vgpuShutdown} onCheckedChange={setVgpuShutdown} />
                <Label htmlFor="xu-vgpu" className="block leading-snug">
                  Shut down VMs with vGPUs instead of migrating them
                  <span className="block text-xs font-normal text-muted-foreground">
                    If disabled, VMs with vGPUs are live-migrated. A VM whose migration fails is restarted on another host.
                  </span>
                </Label>
              </div>
            )}
            {/* A pool update: one failing host need not end it. */}
            {target === "pool" && (
              <div className="flex items-start gap-2">
                <Switch id="xu-skip" checked={skipFailingHosts} onCheckedChange={setSkipFailingHosts} />
                <Label htmlFor="xu-skip" className="block leading-snug">
                  Retry failed hosts, then continue with the remaining hosts
                  <span className="block text-xs font-normal text-muted-foreground">
                    Failed steps are retried after 2 and 5 minutes, and once more at the end. Does not apply to the pool
                    coordinator.
                  </span>
                </Label>
              </div>
            )}
            {/* Only where it matters: hosts this update empties run VMs without the VM Tools. */}
            {(plan?.noToolsVms ?? 0) > 0 && (
              <div className="flex items-start gap-2">
                <Switch id="xu-notools" checked={noToolsRestart} onCheckedChange={setNoToolsRestart} />
                <Label htmlFor="xu-notools" className="block leading-snug">
                  Restart {plan!.noToolsVms} VM{plan!.noToolsVms === 1 ? "" : "s"} without XenServer VM Tools on another host
                  <span className="block text-xs font-normal text-muted-foreground">
                    These VMs cannot be live-migrated. VMs that do not shut down within 10 minutes are forced off.
                  </span>
                </Label>
              </div>
            )}
            <div className="flex items-start gap-2">
              <Switch id="xu-mail" checked={mail} onCheckedChange={setMail} />
              <Label htmlFor="xu-mail" className="block leading-snug">
                Email administrators when the update completes
                {/* Said here rather than discovered later: the mail would not arrive. */}
                {mail && plan?.mail && !plan.mail.smtpConfigured && (
                  <span className="block text-xs font-normal text-amber-600">
                    No mail server is configured (Settings → Mail &amp; Logging → Mail Server).
                  </span>
                )}
                {mail && plan?.mail?.smtpConfigured && plan.mail.adminsWithEmail === 0 && (
                  <span className="block text-xs font-normal text-amber-600">
                    No administrator account has an email address.
                  </span>
                )}
              </Label>
            </div>
          </div>

          {checking && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Running pre-checks
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
                    <span className="text-muted-foreground">{plan.hosts.length + 1}.</span> Pool
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
                  Host restarts can take several minutes. The update continues if this page is closed.
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
            {starting ? "Starting" : "Install Updates"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
