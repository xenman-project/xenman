"use client";

// XenCenter's PVS-Accelerator configuration (PvsCacheConfigurationDialog):
// per site its name and, per server, where the cache goes -- not configured,
// memory or an SR -- and how big it is. A site at a time here; storage in use
// cannot be changed, a site VMs are streamed from cannot be removed.

import { useMemo, useState } from "react";
import { Loader2, Plus, Server, Trash2 } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { PvsHostRow, PvsOverview } from "@/lib/xen-pvs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { pvsXen } from "./pvs-tab";

const NEW = "__new__";

type Choice = Record<string, { storage: string; sizeGb: string }>;

const choiceOf = (rows: PvsHostRow[]): Choice =>
  Object.fromEntries(rows.map((r) => [r.host, { storage: r.storage, sizeGb: String(r.sizeGb) }]));

/** Helpers.MakeUniqueName("PVS Site", taken). */
function uniqueName(taken: string[]): string {
  const base = "PVS Site";
  if (!taken.includes(base)) return base;
  for (let i = 1; ; i++) if (!taken.includes(`${base} (${i})`)) return `${base} (${i})`;
}

export function PvsCacheDialog({
  conn,
  poolName,
  data,
  open,
  onOpenChange,
  onChanged,
}: {
  conn: HostConnection;
  poolName: string;
  data: PvsOverview;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [current, setCurrent] = useState<string>(data.sites[0]?.ref ?? NEW);
  const site = data.sites.find((s) => s.ref === current) ?? null;
  const rows = useMemo(() => (site ? site.hosts : data.newSiteHosts), [site, data.newSiteHosts]);
  const [name, setName] = useState(site?.name ?? uniqueName(data.sites.map((s) => s.name)));
  const [choice, setChoice] = useState<Choice>(choiceOf(rows));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showServers, setShowServers] = useState(false);

  const select = (ref: string) => {
    const s = data.sites.find((x) => x.ref === ref) ?? null;
    setCurrent(ref);
    setName(s?.name ?? uniqueName(data.sites.map((x) => x.name)));
    setChoice(choiceOf(s ? s.hosts : data.newSiteHosts));
    setError(null);
    setShowServers(false);
  };

  const rowValid = (r: PvsHostRow) => {
    const c = choice[r.host];
    // Storage in use is kept as it is; the server leaves an unchanged row alone.
    if (r.inUse || !c || c.storage === "none") return true;
    const opt = r.options.find((o) => o.value === c.storage);
    const n = Number(c.sizeGb);
    return !!opt && !opt.disabled && Number.isInteger(n) && n >= 1 && n <= (opt.maxGb ?? 2048);
  };
  const valid = name.trim() !== "" && rows.every(rowValid);
  const anyInUse = rows.some((r) => r.inUse);
  const anyEditable = rows.some((r) => !r.inUse);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const hosts = Object.fromEntries(rows.map((r) => [r.host, { storage: choice[r.host].storage, sizeGb: Number(choice[r.host].sizeGb) }]));
      const json = await pvsXen(conn, { action: "pvs_site_save", ...(site ? { site: site.ref } : {}), name: name.trim(), hosts });
      await onChanged();
      if (!site && typeof json.site === "string") setCurrent(json.site);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!site) return;
    setBusy(true);
    setError(null);
    try {
      await pvsXen(conn, { action: "pvs_site_remove", site: site.ref });
      await onChanged();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>PVS-Accelerator configuration{poolName ? ` – ${poolName}` : ""}</DialogTitle>
          <DialogDescription>
            Specify the cache configuration to be used for PVS-Accelerator by choosing either memory or a storage repository and the
            amount of space to be allocated for each site and each server.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label>Site</Label>
              <Select value={current} onValueChange={select}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.sites.map((s) => (
                    <SelectItem key={s.ref} value={s.ref}>
                      {s.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW}>New cache configuration</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {current !== NEW && (
              <Button variant="outline" size="sm" onClick={() => select(NEW)}>
                <Plus className="mr-2 h-4 w-4" /> Add cache configuration
              </Button>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pvs-site-name">Site name</Label>
            <Input id="pvs-site-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {site && !site.pvsUuid && (
            <p className="text-amber-700 dark:text-amber-400">
              The PVS-Accelerator configuration for this site must be completed using the PVS console or MCLI.
            </p>
          )}

          <div className="space-y-2">
            <p className="font-medium">Cache configuration</p>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_7rem] items-center gap-x-3 gap-y-2">
              <span className="text-xs text-muted-foreground">Server</span>
              <span className="text-xs text-muted-foreground">Cache storage</span>
              <span className="text-xs text-muted-foreground">Cache size</span>
              {rows.map((r) => {
                const c = choice[r.host] ?? { storage: "none", sizeGb: "10" };
                const opt = r.options.find((o) => o.value === c.storage);
                return (
                  <div key={r.host} className="contents">
                    <span className="flex min-w-0 items-center gap-1.5 truncate" title={r.hostName}>
                      <Server className="h-4 w-4 shrink-0 text-emerald-600" />
                      {r.hostName}
                    </span>
                    <Select
                      value={c.storage}
                      disabled={r.inUse || busy}
                      onValueChange={(v) => setChoice((x) => ({ ...x, [r.host]: { ...c, storage: v } }))}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {r.options.map((o) => (
                          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={1}
                        max={opt?.maxGb ?? 2048}
                        className="h-8"
                        aria-label={`Cache size on ${r.hostName}`}
                        disabled={r.inUse || busy || c.storage === "none"}
                        value={c.storage === "none" ? "" : c.sizeGb}
                        onChange={(e) => setChoice((x) => ({ ...x, [r.host]: { ...c, sizeGb: e.target.value } }))}
                      />
                      <span className="text-xs text-muted-foreground">GB</span>
                    </span>
                  </div>
                );
              })}
            </div>
            {anyInUse && <p className="text-xs text-muted-foreground">The cache storage cannot be changed on servers where it is in use.</p>}
            {anyEditable && (
              <p className="text-xs text-muted-foreground">
                The cache size recommendation is at least 5GB per vDisk version. If Memory only is chosen, the allowed cache size depends on the
                server&apos;s Control Domain memory.
              </p>
            )}
            {!rows.every(rowValid) && <p className="text-xs text-destructive">A cache size is outside what that storage allows.</p>}
          </div>

          {site && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={site.servers.length === 0} onClick={() => setShowServers((v) => !v)}>
                View PVS Servers
              </Button>
              <Button variant="outline" size="sm" className="text-red-600" disabled={busy} onClick={() => setConfirmRemove(true)}>
                <Trash2 className="mr-2 h-4 w-4" /> Remove Cache Configuration
              </Button>
            </div>
          )}
          {site && showServers && (
            <div className="rounded-md border p-3">
              <div className="grid grid-cols-[minmax(0,2fr)_6rem_6rem] gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">PVS Server IP Addresses</span>
                <span className="text-muted-foreground">First port</span>
                <span className="text-muted-foreground">Last port</span>
                {site.servers.map((sv, i) => (
                  <div key={i} className="contents">
                    <span className="font-mono">{sv.addresses.join(", ")}</span>
                    <span>{sv.firstPort}</span>
                    <span>{sv.lastPort}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || busy} onClick={save}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {site ? "Save" : "Add cache configuration"}
          </Button>
        </DialogFooter>

        <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove cache configuration</AlertDialogTitle>
              <AlertDialogDescription>
                {site && site.streaming > 0
                  ? "This cache configuration cannot be removed because there are VMs that are streamed from this site."
                  : site?.pvsUuid
                    ? `Are you sure you want to delete '${site.name}'? This configuration is in use by PVS-Accelerator.`
                    : `Are you sure you want to delete '${site?.name}'?`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{site && site.streaming > 0 ? "Close" : "Cancel"}</AlertDialogCancel>
              {site && site.streaming === 0 && <AlertDialogAction onClick={remove}>Remove</AlertDialogAction>}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
