"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Pause, Play, Plug, Scale, Settings2, Unplug, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

// Workload Balancing, as XenCenter's WLB tab has it: the pool talks to the
// WLB server, XenMan asks the pool (api/xen pool_wlb_*). Everyone with the
// pool sees the state; only admins change it.

interface Recommendation {
  vmRef: string;
  vmName: string;
  kind: "move" | "host";
  fromHostRef: string;
  fromHost: string;
  toHostRef: string;
  toHost: string;
  reason: string;
}

interface WlbStatus {
  poolRef: string;
  url: string;
  username: string;
  enabled: boolean;
  verifyCert: boolean;
  configured: boolean;
  config?: Record<string, string> | null;
  recommendations?: Recommendation[];
  hosts?: WlbHost[];
  error?: string | null;
}

type Applied = { state: "moving" | "done" | "failed"; message?: string };

const RELOAD_MS = 60_000;

async function xen(conn: HostConnection, body: Record<string, unknown>) {
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
  return json;
}

const yes = (v?: string) => (v ?? "").toLowerCase() === "true";
const MODES: Record<string, string> = { "0": "Maximize Performance", "1": "Maximize Density" };

export function WlbTab({ conn, poolName, isAdmin }: { conn: HostConnection; poolName: string; isAdmin: boolean }) {
  const [status, setStatus] = useState<WlbStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [applied, setApplied] = useState<Record<string, Applied>>({});

  const load = useCallback(async () => {
    try {
      setStatus(await xen(conn, { action: "pool_wlb_status" }));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [conn]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, RELOAD_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    setActionError(null);
    try {
      await xen(conn, body);
      await load();
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** One after the other, each only while WLB still recommends it. */
  const applyAll = async () => {
    const moves = (status?.recommendations ?? []).filter((r) => r.kind === "move");
    setBusy("apply");
    setActionError(null);
    for (const r of moves) {
      setApplied((a) => ({ ...a, [r.vmRef]: { state: "moving" } }));
      try {
        const { taskRef } = await xen(conn, { action: "pool_wlb_apply", vmRef: r.vmRef, targetHostRef: r.toHostRef });
        let t: { status?: string; errorInfo?: string[] } = {};
        for (;;) {
          t = await xen(conn, { action: "task_status", taskRef });
          if (t.status !== "pending") break;
          await new Promise((ok) => setTimeout(ok, 1500));
        }
        setApplied((a) => ({
          ...a,
          [r.vmRef]: t.status === "success" ? { state: "done" } : { state: "failed", message: (t.errorInfo ?? []).join(" ") || t.status },
        }));
      } catch (e) {
        setApplied((a) => ({ ...a, [r.vmRef]: { state: "failed", message: e instanceof Error ? e.message : String(e) } }));
      }
    }
    setBusy(null);
    await load();
  };

  if (!status) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          {loadError ? <XCircle className="h-4 w-4 text-destructive" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {loadError ?? "Asking the pool about Workload Balancing…"}
        </CardContent>
      </Card>
    );
  }

  const cfg = status.config ?? {};
  const recs = status.recommendations ?? [];
  const moves = recs.filter((r) => r.kind === "move");
  const credentialsBad = status.configured && status.config && cfg.CredentialsValid !== undefined && !yes(cfg.CredentialsValid);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4" />
            Workload Balancing
          </CardTitle>
          <CardDescription>
            {!status.configured
              ? "No Workload Balancing server is connected to this pool."
              : status.error
                ? null
                : status.enabled
                  ? `Workload Balancing is analyzing pool ${poolName} for possible optimizations.`
                  : "Workload Balancing is paused: it neither recommends nor moves anything."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {status.error && (
            <p className="flex items-start gap-2 text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {status.error}
            </p>
          )}
          {credentialsBad && (
            <p className="flex items-start gap-2 text-amber-600">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Workload Balancing reports that its XenServer account no longer works. Connect the server again with valid
              credentials.
            </p>
          )}
          {actionError && <p className="text-destructive">{actionError}</p>}
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              {!status.configured ? (
                <Button size="sm" onClick={() => setConnectOpen(true)}>
                  <Plug className="mr-1.5 h-3.5 w-3.5" /> Connect
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="outline" disabled={!status.config || Boolean(busy)} onClick={() => setSettingsOpen(true)}>
                    <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Settings
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => act("pause", { action: "pool_wlb_set_enabled", enabled: !status.enabled })}
                  >
                    {busy === "pause" ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : status.enabled ? (
                      <Pause className="mr-1.5 h-3.5 w-3.5" />
                    ) : (
                      <Play className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {status.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(true)}>
                    <Unplug className="mr-1.5 h-3.5 w-3.5" /> Disconnect
                  </Button>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {status.configured && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              ["Workload Balancing server", status.url],
              ["Pool optimization mode", cfg.OptimizationMode !== undefined ? (MODES[cfg.OptimizationMode] ?? cfg.OptimizationMode) : "—"],
              ["Automated optimizations", cfg.AutoBalanceEnabled !== undefined ? (yes(cfg.AutoBalanceEnabled) ? "Yes" : "No") : "—"],
              ["Power management", cfg.PowerManagementEnabled !== undefined ? (yes(cfg.PowerManagementEnabled) ? "Yes" : "No") : "—"],
              ["Certificate of the WLB server checked", status.verifyCert ? "Yes" : "No"],
              ["WLB account", status.username || "—"],
              ["WLB version", cfg.WlbVersion ?? "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <span className="text-muted-foreground">{k}</span>
                <span className="text-right">{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {status.configured && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Optimization recommendations</CardTitle>
            {!status.enabled && <CardDescription>None while Workload Balancing is paused.</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>VM / host</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                      No recommendations at this time.
                    </TableCell>
                  </TableRow>
                )}
                {recs.map((r) => {
                  const a = applied[r.vmRef];
                  return (
                    <TableRow key={r.vmRef}>
                      <TableCell className="font-medium">{r.kind === "host" ? r.fromHost : r.vmName}</TableCell>
                      <TableCell className="text-sm">
                        {r.kind === "host" ? "Power management (applied in XenCenter)" : `Move from ${r.fromHost} to ${r.toHost}`}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.reason || "—"}</TableCell>
                      <TableCell className="text-xs">
                        {a?.state === "moving" && <Loader2 className="h-4 w-4 animate-spin" />}
                        {a?.state === "done" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                        {a?.state === "failed" && <span className="text-destructive">{a.message}</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {isAdmin && (
              <Button size="sm" disabled={moves.length === 0 || Boolean(busy)} onClick={applyAll}>
                {busy === "apply" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Apply recommendations
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <ConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnect={async (body) => {
          const ok = await act("connect", { action: "pool_wlb_connect", ...body });
          if (ok) setConnectOpen(false);
          return ok;
        }}
        busy={busy === "connect"}
        error={busy === null && connectOpen ? actionError : null}
      />
      {status.config && (
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          config={status.config}
          hosts={status.hosts ?? []}
          busy={busy === "settings"}
          error={busy === null && settingsOpen ? actionError : null}
          onSave={async (changed) => {
            if (!Object.keys(changed).length) return setSettingsOpen(false);
            if (await act("settings", { action: "pool_wlb_configure", config: changed })) setSettingsOpen(false);
          }}
        />
      )}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Workload Balancing?</AlertDialogTitle>
            <AlertDialogDescription>
              The pool stops using {status.url}. Its settings and history stay on the WLB server; connecting again picks
              them up.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => act("disconnect", { action: "pool_wlb_disconnect" })}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── connect ──────────────────────────────────────────────────────────────────

function ConnectDialog({
  open,
  onOpenChange,
  onConnect,
  busy,
  error,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConnect: (body: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  error: string | null;
}) {
  const [f, setF] = useState({ wlbUrl: "", wlbUsername: "", wlbPassword: "", xsUsername: "", xsPassword: "", verifyCert: false });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ready = f.wlbUrl.trim() && f.wlbUsername && f.wlbPassword && f.xsUsername && f.xsPassword;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No description: the fields say what is needed. */}
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Connect to Workload Balancing</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="wlb-url">Server and port</Label>
            <Input id="wlb-url" placeholder="wlb.example.org:8012" value={f.wlbUrl} onChange={set("wlbUrl")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="wlb-user">WLB user</Label>
              <Input id="wlb-user" autoComplete="off" value={f.wlbUsername} onChange={set("wlbUsername")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wlb-pw">WLB password</Label>
              <Input id="wlb-pw" type="password" autoComplete="new-password" value={f.wlbPassword} onChange={set("wlbPassword")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wlb-xs-user">XenServer user</Label>
              <Input id="wlb-xs-user" autoComplete="off" placeholder="DOMAIN\user or root" value={f.xsUsername} onChange={set("xsUsername")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wlb-xs-pw">XenServer password</Label>
              <Input id="wlb-xs-pw" type="password" autoComplete="new-password" value={f.xsPassword} onChange={set("xsPassword")} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="wlb-verify" checked={f.verifyCert} onCheckedChange={(v) => setF({ ...f, verifyCert: v })} />
            <Label htmlFor="wlb-verify">Check the WLB server&apos;s certificate (it must be trusted by the pool)</Label>
          </div>
          {error && <p className="text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!ready || busy}
            onClick={async () => {
              if (await onConnect(f)) setF({ ...f, wlbPassword: "", xsPassword: "" });
            }}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── settings ─────────────────────────────────────────────────────────────────

// The dialog follows XenCenter's "Workload Balancing Configuration": the same
// six pages, the same few settings on each. WLB knows well over a hundred
// keys; the rest are its own tuning and stay as they are.

interface WlbHost {
  ref: string;
  uuid: string;
  name: string;
  powerOnMode: string;
  isCoordinator: boolean;
}

type Page = "mode" | "automation" | "thresholds" | "weighting" | "excluded" | "advanced";
// Worded as in XenCenter, so the two read the same.
const PAGES: { id: Page; label: string; hint: string }[] = [
  { id: "mode", label: "Optimization Mode", hint: "Adjust the WLB optimization mode" },
  { id: "automation", label: "Automation", hint: "Configure WLB Automation" },
  { id: "thresholds", label: "Critical Thresholds", hint: "Adjust Critical thresholds for WLB metrics" },
  { id: "weighting", label: "Metric Weighting", hint: "Adjust the weighting of WLB metrics" },
  { id: "excluded", label: "Excluded Hosts", hint: "Excluded Hosts" },
  { id: "advanced", label: "Advanced", hint: "" },
];

// A critical threshold and how XenCenter derives the other three from it:
// value x the pool's own factor, e.g. HostCpuThresholdHigh = critical x
// CpuHighThresholdFactor (0.9 x .85 -> 0.76).
const THRESHOLDS = [
  { key: "HostCpuThreshold", factor: "Cpu", label: "CPU utilization", unit: "Percent", min: 1, max: 100, decimals: 2 },
  { key: "HostMemoryThreshold", factor: "Memory", label: "Free memory", unit: "MB", min: 0, max: 100000, decimals: 0 },
  { key: "HostPifReadThreshold", factor: "NetworkRead", label: "Network read", unit: "MB/s", min: 1, max: 10000, decimals: 0 },
  { key: "HostPifWriteThreshold", factor: "NetworkWrite", label: "Network write", unit: "MB/s", min: 1, max: 10000, decimals: 0 },
  { key: "HostPbdReadThreshold", factor: "DiskRead", label: "Disk read", unit: "MB/s", min: 1, max: 10000, decimals: 0 },
  { key: "HostPbdWriteThreshold", factor: "DiskWrite", label: "Disk write", unit: "MB/s", min: 1, max: 10000, decimals: 0 },
] as const;
const LEVELS = ["High", "Medium", "Low"] as const;
const MB = 1024 * 1024;

// How much each resource counts; medium and low follow from high with the
// pool's weight factors, e.g. VmCpuUtilizationWeightMedium = high x CpuMediumWeightFactor.
const WEIGHTS = [
  { key: "VmCpuUtilizationWeight", factor: "Cpu", label: "CPU utilization" },
  { key: "VmMemoryWeight", factor: "Memory", label: "Free memory" },
  { key: "VmNetworkReadWeight", factor: "NetworkRead", label: "Network read" },
  { key: "VmNetworkWriteWeight", factor: "NetworkWrite", label: "Network write" },
  { key: "VmDiskReadWeight", factor: "DiskRead", label: "Disk read" },
  { key: "VmDiskWriteWeight", factor: "DiskWrite", label: "Disk write" },
] as const;

const participates = (h: WlbHost) => `host_${h.uuid}_ParticipatesInPowerManagement`;
// Excluding a host, as XenCenter does it: all four together, True or False.
// Exactly these names -- WLB keeps a misspelt one too and then cannot hand
// out the pool's settings any more.
const EXCLUDE = [
  "ExcludeFromPlacementRecommendations",
  "ExcludeFromEvacuationRecommendations",
  "ExcludeFromPoolOptimizations",
  "ExcludeFromPoolOptimizationAcceptVMs",
] as const;
const excludeKeys = (h: WlbHost) => EXCLUDE.map((n) => `host_${h.uuid}_${n}`);

/** Down to the given decimals, as WLB's own values are (0.765 -> 0.76). */
const floorTo = (v: number, decimals: number) => Math.floor(v * 10 ** decimals + 1e-9) / 10 ** decimals;
const isTrue = (v?: string) => (v ?? "").toLowerCase() === "true";

/** What a page shows for a critical threshold: percent, or MB / MB/s. */
function thresholdShown(t: (typeof THRESHOLDS)[number], raw?: string): string {
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n)) return "";
  return String(t.unit === "Percent" ? Math.round(n * 100) : Math.round(n / MB));
}

function SettingsDialog({
  open,
  onOpenChange,
  config,
  hosts,
  busy,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  config: Record<string, string>;
  hosts: WlbHost[];
  busy: boolean;
  error: string | null;
  onSave: (changed: Record<string, string>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(config);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [page, setPage] = useState<Page>("mode");
  const [prevOpen, setPrevOpen] = useState(false);
  // A fresh copy each time the dialog opens, not on every reload behind it.
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setDraft(config);
      setShown(Object.fromEntries(THRESHOLDS.map((t) => [t.key, thresholdShown(t, config[`${t.key}Critical`])])));
      setPage("mode");
    }
  }
  const setKey = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const bool = (k: string) => isTrue(draft[k]);
  const isExcluded = (h: WlbHost) => excludeKeys(h).some((k) => isTrue(draft[k]));
  // All four together, lower case, as XenCenter writes them.
  const setExcluded = (h: WlbHost, on: boolean) =>
    setDraft((d) => ({ ...d, ...Object.fromEntries(excludeKeys(h).map((k) => [k, String(on)])) }));

  /** The critical value as WLB stores it, and the three it derives from it. */
  const setThreshold = (t: (typeof THRESHOLDS)[number], text: string) => {
    setShown((s) => ({ ...s, [t.key]: text }));
    const n = Number(text);
    if (!text.trim() || !Number.isFinite(n) || n < t.min || n > t.max) return;
    const critical = t.unit === "Percent" ? n / 100 : Math.round(n * MB);
    setDraft((d) => {
      const next = { ...d, [`${t.key}Critical`]: String(critical) };
      for (const l of LEVELS) {
        const factor = Number(config[`${t.factor}${l}ThresholdFactor`]);
        if (Number.isFinite(factor) && factor > 0) next[`${t.key}${l}`] = String(floorTo(critical * factor, t.decimals));
      }
      return next;
    });
  };

  /** 1..10 on the slider is 0.1..1 as WLB stores it; medium and low follow. */
  const setWeight = (w: (typeof WEIGHTS)[number], step: number) => {
    const high = step / 10;
    setDraft((d) => {
      const next = { ...d, [`${w.key}High`]: String(high) };
      for (const l of ["Medium", "Low"] as const) {
        const factor = Number(config[`${w.factor}${l}WeightFactor`]);
        if (Number.isFinite(factor) && factor > 0) next[`${w.key}${l}`] = String(Math.round(high * factor * 100) / 100);
      }
      return next;
    });
  };

  // Sent: what differs from what WLB has. A switch turned on and off again,
  // for a key WLB never had, is no change.
  const changed = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => {
      const was = config[k];
      if (was === undefined) return !(v.toLowerCase() === "false" || v === "");
      return was.toLowerCase() !== v.toLowerCase();
    }),
  );

  const invalid = THRESHOLDS.some((t) => {
    const s = shown[t.key];
    if (s === undefined || s === "") return false;
    const n = Number(s);
    return !Number.isFinite(n) || n < t.min || n > t.max;
  });

  const field = "space-y-1.5";
  const select = (k: string, options: string[], fallback: string) => (
    <Select value={draft[k] ?? fallback} onValueChange={(v) => setKey(k, v)}>
      <SelectTrigger className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Workload Balancing settings</DialogTitle>
          <DialogDescription>Only what you change is sent; Workload Balancing keeps everything else.</DialogDescription>
        </DialogHeader>
        {/* One height for every page: the dialog sits centred, and a page
            longer or shorter than the last would move it on the screen. */}
        <div className="flex h-[min(70vh,560px)] flex-col sm:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-60 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPage(p.id)}
                className={`rounded-md px-3 py-2 text-left text-sm whitespace-nowrap sm:whitespace-normal ${
                  page === p.id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                {p.label}
                {p.hint && <span className="hidden text-xs font-normal text-muted-foreground sm:block">{p.hint}</span>}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6 text-sm">
            {page === "mode" && (
              <>
                <p className="text-muted-foreground">How Workload Balancing spreads the VMs over the hosts.</p>
                {[
                  { v: "0", label: "Maximize Performance", hint: "Guarantee performance metrics for placed VMs. (Default)" },
                  { v: "1", label: "Maximize Density", hint: "Place the largest possible number of VMs on each host." },
                ].map((m) => (
                  <label key={m.v} className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                    <input
                      type="radio"
                      name="wlb-mode"
                      className="mt-1"
                      checked={(draft.OptimizationMode ?? "0") === m.v}
                      onChange={() => setKey("OptimizationMode", m.v)}
                    />
                    <span>
                      <span className="font-medium">{m.label}</span>
                      <span className="block text-muted-foreground">{m.hint}</span>
                    </span>
                  </label>
                ))}
                {isTrue(config.EnableOptimizationModeSchedules) && (
                  <p className="text-amber-600">
                    This pool changes its mode on a schedule. Schedules are kept as they are; set them up in XenCenter.
                  </p>
                )}
              </>
            )}

            {page === "automation" && (
              <>
                <div className="flex items-center gap-2">
                  <Switch id="wlb-auto" checked={bool("AutoBalanceEnabled")} onCheckedChange={(v) => setKey("AutoBalanceEnabled", String(v))} />
                  <Label htmlFor="wlb-auto">Automatically apply optimization recommendations</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="wlb-power" checked={bool("PowerManagementEnabled")} onCheckedChange={(v) => setKey("PowerManagementEnabled", String(v))} />
                  <Label htmlFor="wlb-power">Automatically apply power management recommendations</Label>
                </div>
                <div className="space-y-2 pt-2">
                  <p className="font-medium">Hosts considered for power management</p>
                  <p className="text-xs text-muted-foreground">
                    Only hosts with a power-on mode (set in XenCenter, host properties) can be switched on again by WLB.
                  </p>
                  <div className="divide-y rounded-md border">
                    {hosts.map((h) => (
                      <label key={h.ref} className={`flex items-center gap-3 px-3 py-2 ${h.powerOnMode ? "" : "opacity-50"}`}>
                        <input
                          type="checkbox"
                          disabled={!h.powerOnMode}
                          checked={bool(participates(h))}
                          onChange={(e) => setKey(participates(h), String(e.target.checked))}
                        />
                        <span className="flex-1">
                          {h.name}
                          {h.isCoordinator && <span className="text-muted-foreground"> (pool coordinator)</span>}
                        </span>
                        <span className="text-xs text-muted-foreground">power-on: {h.powerOnMode || "disabled"}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            {page === "thresholds" && (
              <>
                <p className="text-muted-foreground">
                  When a host reaches one of these, Workload Balancing recommends moving VMs off it and places no more there.
                </p>
                <div className="space-y-2">
                  {THRESHOLDS.filter((t) => config[`${t.key}Critical`] !== undefined).map((t) => {
                    const s = shown[t.key] ?? "";
                    const n = Number(s);
                    const bad = s !== "" && (!Number.isFinite(n) || n < t.min || n > t.max);
                    return (
                      <div key={t.key} className="flex items-center gap-3">
                        <Label htmlFor={`wlb-${t.key}`} className="w-36">
                          {t.label}
                        </Label>
                        <Input
                          id={`wlb-${t.key}`}
                          type="number"
                          min={t.min}
                          max={t.max}
                          className={`w-28 ${bad ? "border-destructive" : ""}`}
                          value={s}
                          onChange={(e) => setThreshold(t, e.target.value)}
                        />
                        <span className="text-muted-foreground">
                          {t.unit} ({t.min} – {t.max})
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {page === "weighting" && (
              <>
                <p className="text-muted-foreground">
                  How much weight Workload Balancing gives each resource when it decides whether a host can take more VMs.
                </p>
                <div className="space-y-3">
                  <div className="flex justify-between pl-36 text-xs text-muted-foreground">
                    <span>Less important</span>
                    <span>More important</span>
                  </div>
                  {WEIGHTS.filter((w) => config[`${w.key}High`] !== undefined).map((w) => {
                    const step = Math.min(10, Math.max(1, Math.round(Number(draft[`${w.key}High`]) * 10) || 10));
                    return (
                      <div key={w.key} className="flex items-center gap-3">
                        <Label htmlFor={`wlb-${w.key}`} className="w-36 shrink-0">
                          {w.label}
                        </Label>
                        <input
                          id={`wlb-${w.key}`}
                          type="range"
                          min={1}
                          max={10}
                          step={1}
                          className="flex-1 accent-primary"
                          value={step}
                          onChange={(e) => setWeight(w, Number(e.target.value))}
                        />
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {page === "excluded" && (
              <>
                <p className="text-muted-foreground">
                  Excluded hosts are left out of Workload Balancing&apos;s placement and optimization recommendations.
                </p>
                <div className="divide-y rounded-md border">
                  {hosts.map((h) => (
                    <label key={h.ref} className="flex items-center gap-3 px-3 py-2">
                      <input type="checkbox" checked={isExcluded(h)} onChange={(e) => setExcluded(h, e.target.checked)} />
                      <span>
                        {h.name}
                        {h.isCoordinator && <span className="text-muted-foreground"> (pool coordinator)</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {page === "advanced" && (
              <div className="space-y-5">
                <div className={field}>
                  <Label htmlFor="wlb-recent">VM migration interval</Label>
                  <p className="text-xs text-muted-foreground">
                    Minutes to wait after a VM has moved before it is included in recommendations again. (Default 30)
                  </p>
                  <Input
                    id="wlb-recent"
                    type="number"
                    min={1}
                    className="w-28"
                    value={draft.RecentMoveMinutes ?? ""}
                    onChange={(e) => setKey("RecentMoveMinutes", e.target.value)}
                  />
                </div>
                <div className={field}>
                  <Label htmlFor="wlb-count">Recommendation count</Label>
                  <p className="text-xs text-muted-foreground">
                    How many times a recommendation must be made before it is applied automatically. (Default 3)
                  </p>
                  <Input
                    id="wlb-count"
                    type="number"
                    min={1}
                    className="w-28"
                    value={draft.AutoBalancePollIntervals ?? ""}
                    onChange={(e) => setKey("AutoBalancePollIntervals", e.target.value)}
                  />
                </div>
                <div className={field}>
                  <Label>Recommendation severity</Label>
                  <p className="text-xs text-muted-foreground">
                    The lowest severity a recommendation needs to be applied automatically. (Default High)
                  </p>
                  {select("AutoBalanceSeverity", ["Critical", "High", "Medium", "Low"], "High")}
                </div>
                <div className={field}>
                  <Label>Optimization aggressiveness</Label>
                  <p className="text-xs text-muted-foreground">How aggressively automated recommendations are applied. (Default Low)</p>
                  {select("AutoBalanceAggressiveness", ["Low", "Medium", "High"], "Low")}
                </div>
                <div className={field}>
                  <Label>Pool audit trail granularity</Label>
                  <p className="text-xs text-muted-foreground">
                    How much the pool audit trail report records; more uses more disk and memory on the WLB server. (Default
                    Minimum)
                  </p>
                  {select("PoolAuditLogGranularity", ["Minimum", "Medium", "Maximum"], "Minimum")}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2 border-t px-6 py-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {invalid && <p className="text-sm text-destructive">A critical threshold is outside its range.</p>}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {Object.keys(changed).length ? `${Object.keys(changed).length} setting(s) changed` : "Nothing changed"}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={busy || invalid} onClick={() => onSave(changed)}>
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                OK
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
