"use client";

// PVS-Accelerator, as XenCenter's PVS tab has it (lib/xen-pvs.ts): the VMs
// and whether read caching is on, its site and status; operators switch it on
// and off per VM, administrators configure the sites' cache storage.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HardDriveDownload, Loader2, Power, PowerOff, Settings2, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { PvsOverview } from "@/lib/xen-pvs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PvsCacheDialog } from "./pvs-cache-dialog";

const RELOAD_MS = 30_000;

export async function pvsXen(conn: HostConnection, body: Record<string, unknown>) {
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

export function PvsTab({ conn, poolName, isAdmin, canAct }: { conn: HostConnection; poolName: string; isAdmin: boolean; canAct: boolean }) {
  const [data, setData] = useState<PvsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The row a Shift+click range starts from: the last one clicked without Shift.
  const anchor = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [enableOpen, setEnableOpen] = useState(false);
  const [site, setSite] = useState("");
  const [configOpen, setConfigOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = (await pvsXen(conn, { action: "pvs_overview" })) as PvsOverview;
      setData(d);
      setLoadError(null);
      // What is gone from the pool is no longer selected.
      setSelected((s) => new Set([...s].filter((ref) => d.vms.some((v) => v.ref === ref))));
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

  const chosen = useMemo(() => (data?.vms ?? []).filter((v) => selected.has(v.ref)), [data, selected]);
  const available = !!data && data.licensed && data.capable;
  const canEnable = canAct && available && (data?.sites.length ?? 0) > 0 && chosen.some((v) => !v.enabled);
  const canDisable = canAct && available && chosen.some((v) => v.enabled);

  async function run(body: Record<string, unknown>, done: (json: Record<string, unknown>) => string | null) {
    setBusy(true);
    setMessage(null);
    try {
      const json = await pvsXen(conn, body);
      const text = done(json);
      if (text) setMessage({ tone: "info", text });
      setSelected(new Set());
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      await load();
    }
  }

  const enable = () =>
    run({ action: "pvs_enable", vms: chosen.map((v) => v.ref), site }, (json) => {
      const skipped = (json.skipped as string[] | undefined) ?? [];
      return skipped.length ? `Left out: ${skipped.join(", ")}.` : null;
    });
  const disable = () => run({ action: "pvs_disable", vms: chosen.filter((v) => v.enabled).map((v) => v.ref) }, () => null);

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          {loadError ? <XCircle className="h-4 w-4 text-destructive" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {loadError ?? "Asking the pool about PVS-Accelerator…"}
        </CardContent>
      </Card>
    );
  }

  const allSelected = data.vms.length > 0 && data.vms.every((v) => selected.has(v.ref));
  /** The VMs from the anchor to this one, in the order shown. */
  const rangeTo = (ref: string): string[] => {
    const refs = data.vms.map((v) => v.ref);
    const to = refs.indexOf(ref);
    const from = anchor.current ? refs.indexOf(anchor.current) : -1;
    if (from < 0) return [ref];
    return refs.slice(Math.min(from, to), Math.max(from, to) + 1);
  };
  /**
   * As in XenCenter's lists: a click selects that VM only, Ctrl (Cmd) adds or
   * removes it, Shift selects every VM from the last one clicked to it, and
   * Ctrl+Shift adds that range. A checkbox works as Ctrl, with Shift as
   * Ctrl+Shift.
   */
  const pick = (ref: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, fromCheckbox = false) => {
    const add = fromCheckbox || e.ctrlKey || e.metaKey;
    if (e.shiftKey) {
      const range = rangeTo(ref);
      setSelected((s) => new Set([...(add ? s : []), ...range]));
      return;
    }
    anchor.current = ref;
    if (!add) {
      setSelected(new Set([ref]));
      return;
    }
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(ref)) n.delete(ref);
      else n.add(ref);
      return n;
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <HardDriveDownload className="h-4 w-4" /> PVS-Accelerator
              </CardTitle>
              <CardDescription>
                {!data.licensed
                  ? "PVS-Accelerator is not available with the license of this pool."
                  : !data.capable
                    ? "PVS-Accelerator needs XenServer 8, or the PVS-Accelerator supplemental pack on the pool coordinator."
                    : data.sites.length === 0
                      ? "No PVS site is configured. Configure PVS-Accelerator to add one."
                      : `Read caching of VMs streamed by Citrix Provisioning, on the servers of ${poolName || "this pool"}.`}
              </CardDescription>
            </div>
            {available && (
              <div className="flex flex-wrap gap-2">
                {canAct && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canEnable || busy}
                      onClick={() => {
                        setSite(data.sites[0]?.ref ?? "");
                        setEnableOpen(true);
                      }}
                    >
                      <Power className="mr-2 h-4 w-4" /> Enable PVS-Accelerator
                    </Button>
                    <Button size="sm" variant="outline" disabled={!canDisable || busy} onClick={disable}>
                      <PowerOff className="mr-2 h-4 w-4" /> Disable PVS-Accelerator
                    </Button>
                  </>
                )}
                {isAdmin && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfigOpen(true)}>
                    <Settings2 className="mr-2 h-4 w-4" /> Configure PVS-Accelerator
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {message && (
            <p className={message.tone === "error" ? "text-destructive" : "text-muted-foreground"}>{message.text}</p>
          )}
          {busy && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Working…
            </p>
          )}
          {/* The list scrolls in itself, as in XenCenter, so the buttons above stay in view; the column
              heads stay too (the table's own wrapper must not scroll, or they would stick to it). */}
          <div className="max-h-[max(16rem,calc(100dvh-26rem))] overflow-auto rounded-md border [&_[data-slot=table-container]]:overflow-visible">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)]">
                <TableRow>
                  {canAct && available && (
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all VMs"
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(data.vms.map((v) => v.ref)))}
                      />
                    </TableHead>
                  )}
                  <TableHead>Virtual machine</TableHead>
                  <TableHead>PVS-Accelerator enabled</TableHead>
                  <TableHead>PVS Site</TableHead>
                  <TableHead>PVS-Accelerator status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.vms.map((v) => (
                  <TableRow
                    key={v.ref}
                    className={`${canAct && available ? "cursor-pointer select-none" : ""} ${selected.has(v.ref) ? "bg-muted/50" : ""}`}
                    onClick={canAct && available ? (e) => pick(v.ref, e) : undefined}
                  >
                    {canAct && available && (
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select ${v.name}`}
                          checked={selected.has(v.ref)}
                          readOnly
                          onClick={(e) => {
                            e.stopPropagation();
                            pick(v.ref, e, true);
                          }}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-medium">{v.name}</TableCell>
                    <TableCell>{v.enabled ? "Yes" : "No"}</TableCell>
                    <TableCell>{v.siteLabel}</TableCell>
                    <TableCell>{v.status}</TableCell>
                  </TableRow>
                ))}
                {data.vms.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      No VMs in this pool.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={enableOpen} onOpenChange={setEnableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable PVS-Accelerator</DialogTitle>
            <DialogDescription>
              {chosen.filter((v) => !v.enabled).length === 1
                ? "Choose the PVS site from which the selected VM is streamed."
                : "Choose the PVS site from which the selected VMs are streamed."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>PVS Site</Label>
            <Select value={site} onValueChange={setSite}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {data.sites.map((s) => (
                  <SelectItem key={s.ref} value={s.ref}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnableOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!site}
              onClick={() => {
                setEnableOpen(false);
                enable();
              }}
            >
              Enable PVS-Accelerator
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isAdmin && configOpen && (
        <PvsCacheDialog conn={conn} poolName={poolName} data={data} open={configOpen} onOpenChange={setConfigOpen} onChanged={load} />
      )}
    </div>
  );
}
