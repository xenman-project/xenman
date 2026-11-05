"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CircuitBoard, Loader2, X, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { GpuBar, GpuOverview, GpuRowData } from "@/lib/xen-gpu";
import { memorySize } from "@/lib/xen-memory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { xenNet } from "@/components/networking/host-networking";

// XenCenter's GPU tab (GpuPage, GpuRow, GpuShinyBar): the placement policy, then
// one block per kind of GPU with a bar per physical GPU -- its vGPU slots and
// the VMs in them -- and the vGPU types it allows. For a host, or the pool.
// XenMan adds what is still free per vGPU type and, for the pool, whether each
// host's vGPU VMs would fit on the others.
// Admins edit as XenCenter does: the placement policy (PoolGpuEditPage,
// SetGpuPlacementPolicyAction) and the allowed vGPU types of the GPUs ticked
// (GpuRow's Edit Selected GPUs..., GpuConfiguration, VgpuConfigurationAction).

const RELOAD_MS = 30_000;
// GpuShinyBar's VM colours, alternating.
const SEGMENT_COLORS = ["#7e57c2", "#a58ad8"];

export function GpuTab({ conn, hostRef, isAdmin = false }: { conn: HostConnection; hostRef: string | null; isAdmin?: boolean }) {
  const [data, setData] = useState<GpuOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editPlacement, setEditPlacement] = useState(false);
  const [editTypes, setEditTypes] = useState<{ row: GpuRowData; pgpuRefs: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await xenNet(conn, { action: "gpu_overview", ...(hostRef ? { hostRef } : {}) }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [conn, hostRef]);

  // Again when VMs start or stop (events), and now and then.
  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, RELOAD_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, conn.vms]);

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          {error ? <XCircle className="h-4 w-4 text-destructive" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {error ?? "Loading GPUs…"}
        </CardContent>
      </Card>
    );
  }

  if (!data.rows.length) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          {hostRef
            ? "GPU configuration and monitoring are disabled, because there are no GPUs available on this host."
            : "GPU configuration and monitoring are disabled, because there are no GPUs available in this pool."}
        </CardContent>
      </Card>
    );
  }

  const vmName = (ref: string) => conn.vms[ref]?.nameLabel ?? ref;
  // PoolGpuEditPage: the placement policy where a GPU can be split into vGPUs.
  const placementEditable = isAdmin && data.rows.some((r) => r.vgpuCapable);

  return (
    <div className="space-y-6">
      {data.placement && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <span>{data.placement}</span>
            {placementEditable && (
              <Button variant="outline" size="sm" onClick={() => setEditPlacement(true)}>
                Edit...
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {data.capacity.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">vGPU capacity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Virtual GPU type</TableHead>
                    <TableHead className="text-right">Running</TableHead>
                    <TableHead className="text-right">Can still start</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.capacity.map((c) => (
                    <TableRow key={c.typeRef}>
                      <TableCell>{c.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.used}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.free}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data.away.length > 0 && (
              <div className="space-y-1.5 text-sm">
                <p className="font-medium">If a host is away (an update, a fault)</p>
                {data.away.map((a) => {
                  const short = a.types.reduce((n, t) => n + t.short, 0);
                  const vms = a.types.reduce((n, t) => n + t.vms, 0);
                  return (
                    <p key={a.hostRef} className="flex items-start gap-2">
                      {short ? (
                        <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      ) : (
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      )}
                      <span>
                        <span className="font-medium">{a.hostName}</span>:{" "}
                        {short
                          ? `${short} of its ${vms} vGPU VMs find no free slot on the other hosts`
                          : `its ${vms} vGPU VM${vms === 1 ? "" : "s"} fit on the other hosts`}
                        <span className="block text-xs text-muted-foreground">
                          {a.types.map((t) => `${t.vms} × ${t.name}${t.short ? ` (${t.short} short)` : ""}`).join(", ")}
                        </span>
                      </span>
                    </p>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {data.rows.map((row, i) => (
        <GpuRowCard
          key={`${row.name}-${i}`}
          row={row}
          hostLabels={data.hostLabels}
          vmName={vmName}
          editable={isAdmin && row.vgpuCapable}
          onEdit={(pgpuRefs) => setEditTypes({ row, pgpuRefs })}
        />
      ))}

      {editPlacement && (
        <PlacementDialog
          conn={conn}
          algorithm={data.algorithm}
          onClose={() => setEditPlacement(false)}
          onSaved={() => {
            setEditPlacement(false);
            void load();
          }}
        />
      )}
      {editTypes && (
        <GpuConfigurationDialog
          conn={conn}
          row={editTypes.row}
          pgpuRefs={editTypes.pgpuRefs}
          onClose={() => setEditTypes(null)}
          onSaved={() => {
            setEditTypes(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** GpuRow: the bars (with a tick each when there are several), the allowed types, Edit. */
function GpuRowCard({
  row,
  hostLabels,
  vmName,
  editable,
  onEdit,
}: {
  row: GpuRowData;
  hostLabels: boolean;
  vmName: (ref: string) => string;
  editable: boolean;
  onEdit: (pgpuRefs: string[]) => void;
}) {
  const all = row.hosts.flatMap((h) => h.bars.map((b) => b.pgpuRef));
  const multiple = editable && all.length > 1;
  // GpuRow.AddShinyBar: every GPU ticked to begin with.
  const [checked, setChecked] = useState<string[]>(all);
  const chosen = multiple ? checked.filter((r) => all.includes(r)) : all;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircuitBoard className="h-4 w-4 text-emerald-600" />
          {row.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-3">
          {row.hosts.map((h) => (
            <div key={h.hostRef} className="space-y-3">
              {hostLabels && <p className="text-sm">On {h.hostName}:</p>}
              {h.bars.map((bar) => (
                <div key={bar.pgpuRef} className="flex items-start gap-2">
                  {multiple && (
                    <input
                      type="checkbox"
                      aria-label="Select this GPU"
                      className="mt-5 h-4 w-4 shrink-0 accent-primary"
                      checked={checked.includes(bar.pgpuRef)}
                      onChange={(e) =>
                        setChecked((c) => (e.target.checked ? [...c, bar.pgpuRef] : c.filter((x) => x !== bar.pgpuRef)))
                      }
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <Bar bar={bar} vmName={vmName} />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <p className="mb-2">Virtual GPU types:</p>
            <ul className="space-y-1">
              {row.types.map((t) => (
                <li key={t.ref} className="flex items-start gap-2">
                  {t.enabled ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  )}
                  <span>{t.name}</span>
                </li>
              ))}
            </ul>
          </div>
          {editable && (
            <div className="flex flex-wrap gap-2">
              {multiple && (
                <>
                  <Button variant="outline" size="sm" disabled={chosen.length === all.length} onClick={() => setChecked(all)}>
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" disabled={!chosen.length} onClick={() => setChecked([])}>
                    Clear All
                  </Button>
                </>
              )}
              <Button variant="outline" size="sm" disabled={!chosen.length} onClick={() => onEdit(chosen)}>
                {all.length > 1 ? "Edit Selected GPUs..." : "Edit..."}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** PoolGpuEditPage, its placement policy part: the radio buttons, Mixed only while it is mixed. */
function PlacementDialog({
  conn,
  algorithm,
  onClose,
  onSaved,
}: {
  conn: HostConnection;
  algorithm: GpuOverview["algorithm"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState<string>(algorithm ?? "mixed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = choice !== (algorithm ?? "mixed") && choice !== "mixed";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await xenNet(conn, { action: "gpu_set_placement", algorithm: choice });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const option = (value: string, label: string) => (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="radio" name="gpu-placement" className="mt-1 accent-primary" checked={choice === value} onChange={() => setChoice(value)} />
      {label}
    </label>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>GPU</DialogTitle>
        </DialogHeader>
        <fieldset className="space-y-3 rounded-md border p-4 text-sm">
          <legend className="px-1 text-xs text-muted-foreground">Placement policy</legend>
          <p>Set a placement policy for assigning VMs to GPUs to achieve either maximum density or maximum performance.</p>
          {option("depth_first", "Maximum density: put as many VMs as possible on the same GPU")}
          {option("breadth_first", "Maximum performance: put VMs on as many GPUs as possible")}
          {algorithm === "mixed" && option("mixed", "Mixed: different settings for different GPU groups")}
        </fieldset>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button disabled={!changed || busy} onClick={() => void save()}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            OK
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * GpuConfiguration: the types the first GPU supports, ticked where enabled;
 * a type a VM uses on the chosen GPUs cannot be unticked while it is allowed.
 */
function GpuConfigurationDialog({
  conn,
  row,
  pgpuRefs,
  onClose,
  onSaved,
}: {
  conn: HostConnection;
  row: GpuRowData;
  pgpuRefs: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ticked, setTicked] = useState<string[]>(row.types.filter((t) => t.enabled).map((t) => t.ref));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inUse = new Set(
    row.hosts.flatMap((h) => h.bars.filter((b) => pgpuRefs.includes(b.pgpuRef)).flatMap((b) => b.vgpus.map((v) => v.typeRef))),
  );
  const enable = row.types.filter((t) => !t.enabled && ticked.includes(t.ref)).map((t) => t.ref);
  const disable = row.types.filter((t) => t.enabled && !ticked.includes(t.ref)).map((t) => t.ref);
  const one = pgpuRefs.length === 1;

  async function save() {
    // GpuConfiguration.okButton_Click: nothing to save, nothing done.
    if (!enable.length && !disable.length) return onClose();
    setBusy(true);
    setError(null);
    try {
      await xenNet(conn, { action: "gpu_set_enabled_types", pgpuRefs, enable, disable });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{one ? `${row.name} (1 GPU)` : `${row.name} (${pgpuRefs.length} GPUs)`}</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          {one ? "Select which virtual GPU types are allowed on this GPU." : "Select which virtual GPU types are allowed on these GPUs."}
        </p>
        <div className="max-h-[50vh] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Virtual GPUs per GPU</TableHead>
                <TableHead className="text-right">Video RAM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {row.types.map((t) => {
                const locked = t.enabled && inUse.has(t.ref);
                return (
                  <TableRow key={t.ref} className={locked ? "opacity-60" : ""} title={locked ? "In use on the selected GPUs" : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        disabled={locked || busy}
                        checked={ticked.includes(t.ref)}
                        onChange={(e) => setTicked((c) => (e.target.checked ? [...c, t.ref] : c.filter((x) => x !== t.ref)))}
                      />
                    </TableCell>
                    <TableCell>{t.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.perGpu ?? ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.videoRam ? memorySize(t.videoRam, true) : ""}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            OK
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** GpuShinyBar: a tick per slot, a segment per vGPU with its VM and model, the rest free. */
function Bar({ bar, vmName }: { bar: GpuBar; vmName: (ref: string) => string }) {
  const slots = Math.max(1, bar.slots);
  const width = 100 / slots;
  return (
    <div className="pt-3">
      <div className="relative">
        {slots > 1 && (
          <div className="pointer-events-none absolute inset-x-0 -top-3 h-5">
            {Array.from({ length: slots + 1 }, (_, i) => (
              <span key={i} className="absolute top-0 h-5 w-px bg-zinc-300 dark:bg-zinc-600" style={{ left: `${Math.min(i * width, 99.9)}%` }} />
            ))}
          </div>
        )}
        <div className="relative flex h-11 overflow-hidden rounded-md border border-zinc-700 bg-gradient-to-b from-zinc-500 to-zinc-700 dark:border-zinc-600">
          {bar.vgpus.map((v, i) => {
            const name = vmName(v.vmRef);
            return (
              <div
                key={v.vgpuRef}
                title={`${name}\n${v.model}`}
                className="flex shrink-0 flex-col justify-center overflow-hidden border-r border-white/30 px-1.5 text-[11px] leading-tight text-white"
                style={{ width: `${width}%`, backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }}
              >
                <span className="truncate">{name}</span>
                <span className="truncate opacity-80">{v.model}</span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {bar.vgpus.length} of {slots} {slots === 1 ? "slot" : "slots"} in use
      </p>
    </div>
  );
}
