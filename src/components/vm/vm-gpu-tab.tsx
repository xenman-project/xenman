"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, Loader2, Plus, Trash2 } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import { addableTypes, GPU_TEXTS, mayAddMore, type VmGpuPage } from "@/lib/vm-gpu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { xenNet } from "@/components/networking/host-networking";

// XenCenter's VM Properties → GPU page (lib/vm-gpu.ts): the VM's virtual GPUs,
// "Add" and "Delete", its notes, and saving -- as a tab of the VM.

/** A row of the list: an existing vGPU, or one added and not saved yet. */
interface Row {
  key: string;
  ref: string | null;
  group: string;
  type: string;
  slot: string;
}

/** Util.MemorySizeStringSuitableUnits. */
function videoRam(bytes: number): string {
  if (!bytes) return "";
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${Number(gib.toFixed(1))} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function VmGpuTab({ conn, vmRef, canEdit, onSaved }: { conn: HostConnection; vmRef: string; canEdit: boolean; onSaved: () => void }) {
  const [page, setPage] = useState<VmGpuPage | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = (await xenNet(conn, { action: "vm_gpu", vmRef })) as VmGpuPage;
    setPage(p);
    setRows(p.current.map((c) => ({ key: c.ref!, ref: c.ref, group: c.group, type: c.type, slot: c.slot })));
    setSelected(null);
  }, [conn, vmRef]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const have = rows.map((r) => r.type);
  const changed = useMemo(() => {
    if (!page) return false;
    const before = page.current.map((c) => c.ref).join(",");
    return before !== rows.map((r) => r.ref ?? "new").join(",");
  }, [page, rows]);

  if (error && !page) return <p className="text-sm text-red-600">{error}</p>;
  if (!page) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!page.licensed) return <p className="text-sm text-muted-foreground">GPUs are not available with this pool&apos;s license.</p>;
  if (!page.available) return <p className="text-sm text-muted-foreground">There are no GPUs available in this pool.</p>;

  const typeOf = (r: Row) => page.types[r.type];
  const groupOf = (r: Row) => page.groups.find((g) => g.ref === r.group);
  // VGpuDetailRow: pass-through is named after its group unless that group also has vGPUs.
  const rowName = (r: Row) => {
    const t = typeOf(r);
    if (!t) return r.type;
    if (!t.passthrough) return t.rowName;
    const g = groupOf(r);
    return g && !g.hasVgpu ? g.name : GPU_TEXTS.passthrough;
  };
  const editable = canEdit && !page.locked;
  const canAdd = editable && mayAddMore(page, have);

  // GpuEditPage.ShowHideWarnings.
  const notes: { warn: boolean; text: string }[] = [];
  if (page.locked) notes.push({ warn: true, text: page.locked });
  else {
    if (rows.some((r) => typeOf(r)?.experimental)) notes.push({ warn: true, text: GPU_TEXTS.experimental });
    if (rows.length > 0) notes.push({ warn: false, text: have.every((t) => (page.types[t]?.compatible.length ?? 0) > 0) ? GPU_TEXTS.multiple : GPU_TEXTS.single });
    if (changed && page.current.length === 0 && rows.some((r) => typeOf(r)?.passthrough)) notes.push({ warn: true, text: GPU_TEXTS.rdp });
    if (rows.length > 0) {
      notes.push({ warn: false, text: GPU_TEXTS.needGpu });
      notes.push({ warn: false, text: GPU_TEXTS.needDriver });
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await xenNet(conn, {
        action: "vm_gpu_set",
        vmRef,
        keep: rows.filter((r) => r.ref).map((r) => r.ref),
        add: rows.filter((r) => !r.ref).map((r) => ({ group: r.group, type: r.type })),
      });
      await load();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6 text-sm">
        <p>{GPU_TEXTS.rubric}</p>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                {page.current.length > 0 && <th className="px-3 py-2 font-medium">PCI slot number</th>}
                <th className="px-3 py-2 font-medium">Virtual GPU type</th>
                <th className="px-3 py-2 font-medium">Virtual GPUs per GPU</th>
                <th className="px-3 py-2 font-medium">Video RAM</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-muted-foreground">
                    None
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.key}
                  onClick={() => editable && setSelected(r.key)}
                  className={`border-t ${editable ? "cursor-pointer" : ""} ${selected === r.key ? "bg-primary/10" : "hover:bg-muted/40"}`}
                >
                  {page.current.length > 0 && <td className="px-3 py-2">{r.slot}</td>}
                  <td className="px-3 py-2">{rowName(r)}</td>
                  <td className="px-3 py-2">{typeOf(r)?.perGpu ?? ""}</td>
                  <td className="px-3 py-2">{videoRam(typeOf(r)?.videoRam ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!canAdd} onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!editable || !selected}
              onClick={() => {
                setRows((rs) => rs.filter((r) => r.key !== selected));
                setSelected(null);
              }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
            {changed && (
              <>
                <Button size="sm" onClick={save} disabled={busy}>
                  {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Save
                </Button>
                <Button size="sm" variant="outline" onClick={() => load()} disabled={busy}>
                  Revert
                </Button>
              </>
            )}
          </div>
        )}

        {notes.length > 0 && (
          <ul className="space-y-1.5">
            {notes.map((n) => (
              <li key={n.text} className="flex items-start gap-2">
                {n.warn ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
                )}
                <span className="text-muted-foreground">{n.text}</span>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-red-600">{error}</p>}
      </CardContent>

      {adding && (
        <AddVgpuDialog
          page={page}
          have={have}
          onClose={() => setAdding(false)}
          onAdd={(group, type) => {
            setRows((rs) => [...rs, { key: `new-${Date.now()}`, ref: null, group, type, slot: "-" }]);
            setAdding(false);
          }}
        />
      )}
    </Card>
  );
}

/** XenCenter's AddVGPUDialog: the types per GPU group; the ones the pool has not allowed greyed. */
function AddVgpuDialog({
  page,
  have,
  onClose,
  onAdd,
}: {
  page: VmGpuPage;
  have: string[];
  onClose: () => void;
  onAdd: (group: string, type: string) => void;
}) {
  const options = addableTypes(page, have);
  const selectable = options.flatMap((o) => o.types.filter((t) => t.enabled).map((t) => ({ group: o.group.ref, type: t.ref })));
  // As the dialog does: one type that can be chosen is chosen already.
  const [choice, setChoice] = useState<{ group: string; type: string } | null>(selectable.length === 1 ? selectable[0] : null);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Virtual GPU</DialogTitle>
        </DialogHeader>
        <p className="text-sm">Select virtual GPU type:</p>
        <div className="max-h-72 overflow-y-auto rounded-md border text-sm">
          {options.length === 0 && <p className="px-3 py-2 text-muted-foreground">No virtual GPU type can be added to this VM.</p>}
          {options.map((o) => (
            <div key={o.group.ref}>
              {o.group.hasVgpu && <div className="bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">{o.group.name}</div>}
              {o.types.map((t) => {
                const chosen = choice?.group === o.group.ref && choice.type === t.ref;
                return (
                  <button
                    key={t.ref}
                    type="button"
                    disabled={!t.enabled}
                    onClick={() => setChoice({ group: o.group.ref, type: t.ref })}
                    className={`block w-full border-t px-3 py-1.5 text-left ${o.group.hasVgpu ? "pl-6" : ""} ${
                      chosen ? "bg-primary/10" : "hover:bg-muted/60"
                    } ${t.enabled ? "" : "cursor-not-allowed opacity-50"}`}
                  >
                    {o.group.hasVgpu ? page.types[t.ref].label : o.group.name}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!choice} onClick={() => choice && onAdd(choice.group, choice.type)}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
