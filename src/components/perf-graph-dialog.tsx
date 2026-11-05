"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Loader2, Pencil, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  BUILTIN_GRAPHS,
  LOAD_MIN_TOP,
  isLoadGraph,
  LINE_COLORS,
  MAX_LINES,
  matchesPattern,
  patternOf,
  sourceLabel,
  sourceType,
  type DataSource,
  type GraphKind,
  type GraphLine,
  type PerfGraph,
  type SourceType,
} from "@/lib/perf-sources";

// Putting the performance graphs together, as XenCenter's "New Graph" does:
// which graphs a VM, a host or a pool shows, in which order, and graphs of
// one's own from the data sources XenServer records. The data sources are
// listed from the object the Performance tab is open on; a graph saved applies
// to every object of that kind.

/** Where the Performance tab is open: what the data sources are listed from. */
export interface SourceTarget {
  address: string;
  port: number;
  useSsl: boolean;
  sessionRef?: string;
  vmRef?: string;
  hostRef?: string;
  pool: boolean;
}

const KIND_NAMES: Record<GraphKind, string> = { vm: "VMs", host: "hosts", pool: "pools" };

const titleOf = (kind: GraphKind, g: PerfGraph) =>
  g.builtin ? (BUILTIN_GRAPHS[kind].find((b) => b.id === g.builtin)?.title ?? g.builtin) : (g.name ?? g.id);

const newId = () => `g-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The graphs of a kind, to reorder, hide, edit and add to. Every change is saved at once. */
/**
 * Where a load graph's scale starts: typed in the row, saved when left or on
 * Enter, like every other change in this list.
 */
function ScaleFloor({ value, disabled, onSave }: { value: number; disabled: boolean; onSave: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [prev, setPrev] = useState(value);
  // Saved elsewhere (or put back to the defaults): show what is stored now.
  if (value !== prev) {
    setPrev(value);
    setText(String(value));
  }
  const n = Number(text.replace(",", "."));
  const valid = text.trim() !== "" && Number.isFinite(n) && n > 0 && n <= 1000;
  const commit = () => {
    if (valid && n !== value) onSave(n);
    else if (!valid) setText(String(value));
  };
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground" title="The scale reaches at least this high, and grows with the data above it.">
      scale from
      <Input
        type="text"
        inputMode="decimal"
        className={`h-7 w-16 px-2 text-xs ${valid ? "" : "border-destructive"}`}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function GraphListEditor({
  kind,
  graphs,
  target,
  canRecord,
  onSaved,
  onDone,
}: {
  kind: GraphKind;
  graphs: PerfGraph[];
  target: SourceTarget;
  canRecord: boolean;
  onSaved: (all: Record<GraphKind, PerfGraph[]>) => void;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // The graph in the dialog: an existing one, a new one (null), or none.
  const [open, setOpen] = useState<PerfGraph | null | undefined>(undefined);

  async function put(body: object): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch("/api/perf-graphs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Not saved");
        return false;
      }
      setError(null);
      onSaved(json.graphs);
      return true;
    } catch {
      setError("XenMan did not answer");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const save = (list: PerfGraph[]) => put({ graphs: list });
  const move = (i: number, by: number) => {
    const list = [...graphs];
    const [g] = list.splice(i, 1);
    list.splice(i + by, 0, g);
    void save(list);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Graphs of all {KIND_NAMES[kind]}</CardTitle>
        <p className="text-xs text-muted-foreground">
          The same for every {kind === "vm" ? "VM" : kind} and every user. Changes are saved at once.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y rounded-md border">
          {graphs.map((g, i) => (
            <li key={g.id} className="flex items-center gap-1 px-3 py-1.5 text-sm">
              <span className={`min-w-0 flex-1 truncate ${g.hidden ? "text-muted-foreground line-through" : ""}`}>
                {titleOf(kind, g)}
                {!g.builtin && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {g.lines?.length} source{g.lines?.length === 1 ? "" : "s"}
                  </span>
                )}
              </span>
              {isLoadGraph(g) && (
                <ScaleFloor
                  value={g.minTop ?? LOAD_MIN_TOP}
                  disabled={busy}
                  onSave={(v) => void save(graphs.map((x) => (x.id === g.id ? { ...x, minTop: v } : x)))}
                />
              )}
              <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busy || i === graphs.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                disabled={busy}
                onClick={() => save(graphs.map((x) => (x.id === g.id ? { ...x, hidden: !x.hidden } : x)))}
                aria-label={g.hidden ? "Show" : "Hide"}
                title={g.hidden ? "Show" : "Hide"}
              >
                {g.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              {g.builtin ? (
                // Built-in graphs are hidden, not deleted: room kept for the buttons.
                <span className="w-16" />
              ) : (
                <>
                  <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busy} onClick={() => setOpen(g)} aria-label="Edit">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive"
                    disabled={busy}
                    onClick={() => save(graphs.filter((x) => x.id !== g.id))}
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => setOpen(null)}>
            <Plus className="h-4 w-4" />
            New graph
          </Button>
          <Button
            size="sm"
            variant={confirmReset ? "destructive" : "outline"}
            disabled={busy}
            onClick={async () => {
              if (!confirmReset) return setConfirmReset(true);
              setConfirmReset(false);
              await put({ reset: true });
            }}
            onBlur={() => setConfirmReset(false)}
          >
            <RotateCcw className="h-4 w-4" />
            {confirmReset ? "Delete own graphs and reset?" : "Reset to defaults"}
          </Button>
          <Button size="sm" variant="outline" className="ml-auto" onClick={onDone}>
            Done
          </Button>
        </div>
      </CardContent>
      {open !== undefined && (
        <GraphDialog
          kind={kind}
          graph={open}
          target={target}
          canRecord={canRecord}
          onClose={() => setOpen(undefined)}
          onSave={async (g) => {
            const list = graphs.some((x) => x.id === g.id) ? graphs.map((x) => (x.id === g.id ? g : x)) : [...graphs, g];
            if (await save(list)) setOpen(undefined);
          }}
          saving={busy}
          error={error}
        />
      )}
    </Card>
  );
}

/** A row of the dialog's list: one data source, or with "every device" one pattern and its sources. */
interface Row {
  key: string;
  label: string;
  description: string;
  type: SourceType;
  units: string;
  /** The sources here it stands for. */
  names: string[];
  recorded: number;
}

const TYPE_ORDER: SourceType[] = ["CPU", "Memory", "Disk", "Network", "Storage", "GPU", "Other"];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The device a name has where its pattern has "*": "xvda" for vbd_*_read and vbd_xvda_read. */
function deviceOf(pattern: string, name: string): string | null {
  if (!pattern.includes("*")) return null;
  const m = new RegExp(`^${pattern.split("*").map(escapeRe).join("([^_-]+)")}$`).exec(name);
  return m?.[1] ?? null;
}

function rowsOf(sources: DataSource[], every: boolean): Row[] {
  const rows = new Map<string, Row>();
  for (const s of sources) {
    const key = every ? patternOf(s.name) : s.name;
    const r = rows.get(key);
    if (r) {
      r.names.push(s.name);
      r.recorded += s.enabled ? 1 : 0;
      // Several devices: the first one's description, its device made "*".
      const device = deviceOf(key, r.names[0]);
      if (r.names.length === 2 && device) r.description = r.description.replace(new RegExp(`(?<![\\w/])${escapeRe(device)}(?![\\w/])`, "g"), "*");
      continue;
    }
    rows.set(key, {
      key,
      label: sourceLabel(key),
      description: s.description,
      type: sourceType(s.name),
      units: s.units,
      names: [s.name],
      recorded: s.enabled ? 1 : 0,
    });
  }
  return [...rows.values()].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.label.localeCompare(b.label, "en", { numeric: true }),
  );
}

/** XenCenter's "New Graph": a name, and the data sources to draw with their colours. */
function GraphDialog({
  kind,
  graph,
  target,
  canRecord,
  onClose,
  onSave,
  saving,
  error,
}: {
  kind: GraphKind;
  graph: PerfGraph | null;
  target: SourceTarget;
  canRecord: boolean;
  onClose: () => void;
  onSave: (g: PerfGraph) => void;
  saving: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(graph?.name ?? "");
  const [search, setSearch] = useState("");
  const [every, setEvery] = useState(graph ? (graph.lines ?? []).every((l) => patternOf(l.source) === l.source) : true);
  const [picked, setPicked] = useState<GraphLine[]>(graph?.lines ?? []);
  const [sources, setSources] = useState<DataSource[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const single = kind === "pool";
  const where = kind === "vm" ? "this VM" : kind === "host" ? "this host" : "the pool's coordinator";

  const { address, port, useSsl, sessionRef, vmRef, hostRef, pool } = target;
  const xen = useCallback(
    (action: string, extra: object = {}) =>
      fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, host: address, port, useSsl, sessionRef, vmRef, hostRef, pool, ...extra }),
      }),
    [address, port, useSsl, sessionRef, vmRef, hostRef, pool],
  );

  const list = useCallback(async () => {
    try {
      const res = await xen("rrd_sources");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return setListError(json.error ?? "XenServer did not list its data sources");
      if (json.notRunning) return setListError("The VM is not running: XenServer lists a VM's data sources while it runs.");
      setListError(null);
      setSources(json.sources);
    } catch {
      setListError("XenMan did not answer");
    }
  }, [xen]);

  useEffect(() => {
    const t = setTimeout(list, 0);
    return () => clearTimeout(t);
  }, [list]);

  const rows = useMemo(() => {
    const all = rowsOf(sources ?? [], every);
    // What the graph has that is not listed here -- a disk this VM does not
    // have -- stays, said as such.
    for (const p of picked) {
      if (all.some((r) => r.key === p.source)) continue;
      const names = (sources ?? []).filter((s) => matchesPattern(p.source, s.name));
      all.unshift({
        key: p.source,
        label: sourceLabel(p.source),
        description: names.length ? `Covers ${names.length} data sources here` : `Not on ${where}`,
        type: sourceType(p.source),
        units: p.units,
        names: names.map((s) => s.name),
        recorded: names.filter((s) => s.enabled).length,
      });
    }
    return all;
  }, [sources, every, picked, where]);

  const q = search.trim().toLowerCase();
  const shown = q
    ? rows.filter((r) => [r.label, r.key, r.description, r.type].some((t) => t.toLowerCase().includes(q)))
    : rows;

  function toggle(r: Row) {
    if (picked.some((p) => p.source === r.key)) {
      setPicked(picked.filter((p) => p.source !== r.key));
      return;
    }
    const free = LINE_COLORS.find((c) => !picked.some((p) => p.color === c)) ?? LINE_COLORS[picked.length % LINE_COLORS.length];
    const line = { source: r.key, units: r.units, color: single ? LINE_COLORS[0] : free };
    if (!single && picked.length >= MAX_LINES) return;
    setPicked(single ? [line] : [...picked, line]);
    if (!name.trim() && (single || picked.length === 0)) setName(r.label);
  }

  function recolor(source: string) {
    setPicked(picked.map((p) => (p.source === source ? { ...p, color: LINE_COLORS[(LINE_COLORS.indexOf(p.color) + 1) % LINE_COLORS.length] } : p)));
  }

  function changeEvery(on: boolean) {
    setEvery(on);
    // Picked sources become their patterns; patterns stay as they are.
    if (on) {
      const seen = new Set<string>();
      setPicked(
        picked
          .map((p) => ({ ...p, source: patternOf(p.source) }))
          .filter((p) => (seen.has(p.source) ? false : (seen.add(p.source), true))),
      );
    }
  }

  async function record(r: Row) {
    const names = r.names.filter((n) => !sources?.find((s) => s.name === n)?.enabled);
    if (!names.length) return;
    setRecording(r.key);
    try {
      const res = await xen("rrd_record", { sources: names });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setListError(json.error ?? "Recording was not switched on");
      else setRecorded(true);
      await list();
    } finally {
      setRecording(null);
    }
  }

  const ready = name.trim().length > 0 && picked.length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{graph ? "Edit graph" : "New graph"}</DialogTitle>
          <DialogDescription>
            For all {KIND_NAMES[kind]}. The data sources are those of {where}
            {single ? "; a pool graph shows one of them, per host." : "."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="pg-name">Name</Label>
            <Input id="pg-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Disk latency" />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch id="pg-every" checked={every} onCheckedChange={changeEvery} />
            <Label htmlFor="pg-every" className="text-sm font-normal">
              Every disk, network interface and CPU
            </Label>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search data sources" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          <div className="sticky top-0 z-10 hidden grid-cols-[2rem_minmax(0,15rem)_minmax(0,1fr)_5.5rem_6.5rem_2.5rem] gap-2 border-b bg-muted px-3 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span />
            <span>Data source</span>
            <span>Description</span>
            <span>Type</span>
            <span>Recorded</span>
            <span>Colour</span>
          </div>
          {!sources && !listError && (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Asking XenServer for its data sources…
            </p>
          )}
          {sources && shown.length === 0 && <p className="p-4 text-sm text-muted-foreground">Nothing matches.</p>}
          <ul className="divide-y">
            {shown.map((r) => {
              const p = picked.find((x) => x.source === r.key);
              const all = r.names.length > 0 && r.recorded === r.names.length;
              return (
                <li
                  key={r.key}
                  className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-sm md:grid md:grid-cols-[2rem_minmax(0,15rem)_minmax(0,1fr)_5.5rem_6.5rem_2.5rem] ${
                    p ? "bg-muted/50" : ""
                  } ${all || p ? "" : "text-muted-foreground"}`}
                >
                  <input
                    type={single ? "radio" : "checkbox"}
                    name="pg-source"
                    className="h-4 w-4 accent-[var(--primary)]"
                    checked={!!p}
                    onChange={() => toggle(r)}
                    aria-label={r.label}
                  />
                  <button type="button" onClick={() => toggle(r)} className="min-w-0 flex-1 truncate text-left font-medium md:flex-none" title={r.key}>
                    {r.label}
                    {r.names.length > 1 && <span className="ml-1 text-xs font-normal text-muted-foreground">×{r.names.length}</span>}
                  </button>
                  <span className="order-last basis-full truncate pl-6 text-xs text-muted-foreground md:order-none md:basis-auto md:pl-0 md:text-sm" title={r.description}>
                    {r.description}
                  </span>
                  <span className="hidden text-xs md:inline">{r.type}</span>
                  <span className="text-xs">
                    {r.names.length === 0 ? (
                      "—"
                    ) : all ? (
                      "Yes"
                    ) : canRecord ? (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={recording !== null} onClick={() => record(r)}>
                        {recording === r.key ? <Loader2 className="h-3 w-3 animate-spin" /> : r.recorded ? `${r.recorded}/${r.names.length} · Enable` : "No · Enable"}
                      </Button>
                    ) : r.recorded ? (
                      `${r.recorded} of ${r.names.length}`
                    ) : (
                      "No"
                    )}
                  </span>
                  <span className="flex w-6 justify-center md:w-auto">
                    {p && !single && (
                      <button
                        type="button"
                        onClick={() => recolor(r.key)}
                        className="h-4 w-4 rounded-full border"
                        style={{ background: p.color }}
                        title="Another colour"
                        aria-label="Another colour"
                      />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {recorded && (
          <p className="text-xs text-muted-foreground">
            Recording starts now{kind === "pool" ? " on every host" : ""}: the graph fills from here on.
            {kind === "vm" && " Other VMs show it once they record it too."}
          </p>
        )}
        {(listError || error) && <p className="text-sm text-destructive">{listError ?? error}</p>}
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {picked.length} of {single ? 1 : MAX_LINES} picked
          </span>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!ready || saving}
              onClick={() =>
                onSave({
                  id: graph?.id ?? newId(),
                  name: name.trim(),
                  lines: picked,
                  ...(graph?.hidden ? { hidden: true } : {}),
                  // Kept while it is still a load graph.
                  ...(graph?.minTop !== undefined && isLoadGraph({ lines: picked }) ? { minTop: graph.minTop } : {}),
                })
              }
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
