"use client";

import { useDates } from "@/context/date-format-context";
import { formatDate, formatTime, type DateFormat } from "@/lib/date-format";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth-context";
import {
  BUILTIN_GRAPHS,
  LINE_COLORS,
  LOAD_MIN_TOP,
  combineBy,
  isLoadGraph,
  sourceLabel,
  type GraphKind,
  type PerfGraph,
  type Unit,
} from "@/lib/perf-sources";
import { GraphListEditor, type SourceTarget } from "@/components/perf-graph-dialog";

// Performance graphs of a host or a VM from XenServer's RRDs (lib/xen-rrd.ts),
// drawn as plain SVG: a chart library would be one more package to fetch and
// ship for a handful of line charts. Which graphs, in which order, and the
// ones put together from XenServer's data sources are the same for everyone
// (lib/perf-graphs.ts).

type Period = "10m" | "2h" | "1w" | "1y";

const PERIODS: { id: Period; label: string; refreshMs: number | null }[] = [
  { id: "10m", label: "10 minutes", refreshMs: 10_000 },
  { id: "2h", label: "2 hours", refreshMs: 60_000 },
  { id: "1w", label: "1 week", refreshMs: null },
  { id: "1y", label: "1 year", refreshMs: null },
];

interface PerfLine {
  label: string;
  values: (number | null)[];
  /** When it differs from the chart's: a graph may mix measures. */
  unit?: Unit;
  suffix?: string;
  color?: string;
}

interface PerfChart {
  id: string;
  title: string;
  unit: Unit;
  suffix?: string;
  lines: PerfLine[];
  max?: number;
  /** The scale grows with the data, but starts no lower than this (load average: 1). */
  minTop?: number;
  /** A graph put together whose sources this object does not record: their names. */
  notRecorded?: string[];
  /** A graph put together whose sources were not asked for yet. */
  pending?: boolean;
}

interface SourceSeries {
  unit: Unit;
  suffix?: string;
  lines: { name: string; values: (number | null)[]; count?: number }[];
}

interface PerfData {
  step: number;
  times: number[];
  charts: PerfChart[];
  notRunning?: boolean;
  /** What the host sent when nothing could be drawn from it. */
  received?: { columns: number; rows: number; sample: string[]; head?: string };
  /** Pool view: hosts that did not answer. */
  missing?: string[];
  /** Per data source a graph put together asked for. */
  sources?: Record<string, SourceSeries>;
}

const color = (i: number) => LINE_COLORS[i % LINE_COLORS.length];

function bytes(v: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function plain(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)} M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)} k`;
  return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

function format(v: number | null, unit: Unit, suffix?: string): string {
  if (v === null || !Number.isFinite(v)) return "–";
  switch (unit) {
    case "percent":
      return `${v.toFixed(v < 10 ? 1 : 0)} %`;
    case "bytes":
      return bytes(v);
    case "bytesPerSecond":
      return `${bytes(v)}/s`;
    case "seconds":
      if (Math.abs(v) < 1e-3) return `${(v * 1e6).toFixed(0)} µs`;
      if (Math.abs(v) < 1) return `${(v * 1e3).toFixed(v < 1e-2 ? 2 : 1)} ms`;
      return `${v.toFixed(2)} s`;
    case "perSecond":
      return `${plain(v)} ${suffix ?? ""}/s`.replace(/ {2}/, " ");
    default:
      return suffix ? `${plain(v)} ${suffix}` : plain(v);
  }
}

function timeLabel(t: number, period: Period, fmt: DateFormat): string {
  const d = new Date(t * 1000);
  if (period === "10m" || period === "2h") return formatTime(d, fmt, { seconds: false });
  if (period === "1w") return `${d.toLocaleDateString(fmt === "iso" ? "en-US" : fmt, { weekday: "short" })} ${formatTime(d, fmt, { seconds: false })}`;
  return formatDate(d, fmt);
}

/** The newest value a line has. */
function latest(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i];
  return null;
}

/** Where the newest value is, or -1. */
function lastIndex(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}

const W = 600;
const H = 140;

/** A pool's spread per moment: the lowest and highest host, and which host that is. */
interface Band {
  min: (number | null)[];
  max: (number | null)[];
  maxBy: (string | null)[];
}

function LineChart({
  chart,
  times,
  period,
  band,
  lineColors,
}: {
  chart: PerfChart;
  times: number[];
  period: Period;
  band?: Band;
  /** Per line; otherwise the palette in order. */
  lineColors?: string[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { format: dateFmt } = useDates();
  const n = times.length;
  const colorOf = (i: number) => lineColors?.[i] ?? chart.lines[i]?.color ?? color(i);
  const peak = Math.max(
    0,
    ...chart.lines.flatMap((l) => l.values.filter((v): v is number => v !== null)),
    ...(band ? band.max.filter((v): v is number => v !== null) : []),
  );
  const top = chart.max ?? Math.max(chart.minTop ?? 0, peak > 0 ? peak * 1.15 : 1);
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
  const y = (v: number) => H - (Math.min(v, top) / top) * H;

  /** One path per line; a gap in the data starts a new stroke. */
  const path = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  function move(e: React.MouseEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - box.left) / box.width;
    setHover(n > 0 ? Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))) : null);
  }

  /** The band as one closed shape: along the top, back along the bottom; gaps split it. */
  const bandPath = (b: Band) => {
    let d = "";
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1) {
        d += run.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(b.max[i]!).toFixed(1)}`).join("");
        d += [...run].reverse().map((i) => `L${x(i).toFixed(1)},${y(b.min[i]!).toFixed(1)}`).join("") + "Z";
      }
      run = [];
    };
    b.max.forEach((v, i) => (v === null || b.min[i] === null ? flush() : run.push(i)));
    flush();
    return d;
  };

  const at = hover ?? n - 1;
  // The band's figures at the moment shown: the newest, or the one pointed at.
  const bandAt = band ? (hover === null ? lastIndex(band.max) : at) : -1;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-2 text-sm font-medium">
          <span>{chart.title}</span>
          <span className="flex flex-wrap gap-3 text-xs font-normal text-muted-foreground">
            {chart.lines.map((l, i) => (
              <span key={l.label} className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorOf(i) }} />
                {l.label}{" "}
                <span className="font-mono text-foreground">
                  {format(hover === null ? latest(l.values) : l.values[at], l.unit ?? chart.unit, l.unit ? l.suffix : chart.suffix)}
                </span>
              </span>
            ))}
            {band && bandAt >= 0 && (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-3 rounded-sm bg-[var(--chart-1)] opacity-30" />
                range{" "}
                <span className="font-mono text-foreground">
                  {format(band.min[bandAt], chart.unit, chart.suffix)} – {format(band.max[bandAt], chart.unit, chart.suffix)}
                </span>
                {band.maxBy[bandAt] && <span>(highest: {band.maxBy[bandAt]})</span>}
              </span>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-36 w-full overflow-visible"
            onMouseMove={move}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label={`${chart.title} over the last ${PERIODS.find((p) => p.id === period)?.label}`}
          >
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="currentColor" className="text-border" vectorEffect="non-scaling-stroke" />
            ))}
            <line x1={0} x2={W} y1={H} y2={H} stroke="currentColor" className="text-border" vectorEffect="non-scaling-stroke" />
            {band && <path d={bandPath(band)} fill="var(--chart-1)" fillOpacity={0.18} stroke="none" />}
            {chart.lines.map((l, i) => (
              <path key={l.label} d={path(l.values)} fill="none" stroke={colorOf(i)} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
            ))}
            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="currentColor" className="text-muted-foreground" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          <span className="pointer-events-none absolute left-1 top-0 text-[10px] text-muted-foreground">{format(top, chart.unit, chart.suffix)}</span>
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>{n ? timeLabel(times[0], period, dateFmt) : ""}</span>
          {hover !== null && <span className="font-medium text-foreground">{timeLabel(times[hover], period === "1y" ? "1w" : period, dateFmt)}</span>}
          <span>{n ? timeLabel(times[n - 1], period, dateFmt) : ""}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Up to this many hosts a pool's charts draw a line each; beyond, a band and a table. */
const POOL_LINES_MAX = 5;
/** Hosts picked in the table to show as lines on top of the band. */
const PICK_MAX = 5;

/** Average, lowest and highest of the hosts at each moment. */
function spread(c: PerfChart): { avg: (number | null)[]; band: Band } {
  const n = Math.max(0, ...c.lines.map((l) => l.values.length));
  const avg: (number | null)[] = [];
  const band: Band = { min: [], max: [], maxBy: [] };
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    let lo: number | null = null;
    let hi: number | null = null;
    let hiBy: string | null = null;
    for (const l of c.lines) {
      const v = l.values[i];
      if (v === null || v === undefined) continue;
      sum += v;
      count++;
      if (lo === null || v < lo) lo = v;
      if (hi === null || v > hi) {
        hi = v;
        hiBy = l.label;
      }
    }
    avg.push(count ? sum / count : null);
    band.min.push(lo);
    band.max.push(hi);
    band.maxBy.push(hiBy);
  }
  return { avg, band };
}

/** A small line of one host's values, on the scale all hosts share. */
function Sparkline({ values, top }: { values: (number | null)[]; top: number }) {
  const n = values.length;
  const pts = values
    .map((v, i) => (v === null ? null : `${n > 1 ? ((i / (n - 1)) * 60).toFixed(1) : 0},${(16 - (Math.min(v, top) / (top || 1)) * 16).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg viewBox="0 0 60 16" className="h-4 w-14 shrink-0 text-muted-foreground" aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A pool of many hosts: per chart the average as a line and the range from
 * lowest to highest host as a band; below, every host with its own small line
 * and current value, sortable, and pickable to draw on top of the band.
 */
function PoolOverview({ data, period }: { data: PerfData; period: Period }) {
  const [sortBy, setSortBy] = useState<string>(data.charts[0]?.id ?? "cpu");
  const [picked, setPicked] = useState<string[]>([]);
  const hosts = [...new Set(data.charts.flatMap((c) => c.lines.map((l) => l.label)))];
  const pickColor = (name: string) => color(picked.indexOf(name) + 1);
  const toggle = (name: string) =>
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : p.length >= PICK_MAX ? [...p.slice(1), name] : [...p, name]));

  const current = (c: PerfChart, host: string) => latest(c.lines.find((l) => l.label === host)?.values ?? []);
  const sortChart = data.charts.find((c) => c.id === sortBy) ?? data.charts[0];
  const rows = [...hosts].sort((a, b) => (current(sortChart, b) ?? -Infinity) - (current(sortChart, a) ?? -Infinity));
  // One scale per column -- the highest value any host had -- so the small
  // lines compare across hosts and still show movement at 5 % CPU.
  const tops = new Map(
    data.charts.map((c) => [c.id, Math.max(1e-9, c.minTop ?? 0, ...c.lines.flatMap((l) => l.values.filter((v): v is number => v !== null)))]),
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {data.charts.map((c) => {
          const { avg, band } = spread(c);
          const shown = c.lines.filter((l) => picked.includes(l.label));
          return (
            <LineChart
              key={c.id}
              chart={{ ...c, lines: [{ label: `Pool average (${hosts.length} hosts)`, values: avg }, ...shown] }}
              band={band}
              lineColors={["var(--foreground)", ...shown.map((l) => pickColor(l.label))]}
              times={data.times}
              period={period}
            />
          );
        })}
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Hosts</CardTitle>
          <p className="text-xs text-muted-foreground">
            Sorted by the column you pick. Select up to {PICK_MAX} hosts to draw them on top of the pool&apos;s range.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Host</th>
                {data.charts.map((c) => (
                  <th key={c.id} className="py-2 pr-3 font-medium">
                    <button
                      type="button"
                      onClick={() => setSortBy(c.id)}
                      className={`whitespace-nowrap hover:text-foreground ${sortBy === c.id ? "text-foreground" : ""}`}
                    >
                      {c.title}
                      {sortBy === c.id ? " ▼" : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => {
                const on = picked.includes(h);
                return (
                  <tr
                    key={h}
                    onClick={() => toggle(h)}
                    className={`cursor-pointer border-b last:border-0 hover:bg-muted/50 ${on ? "bg-muted/40" : ""}`}
                  >
                    <td className="whitespace-nowrap py-1.5 pr-3">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full border"
                          style={on ? { background: pickColor(h), borderColor: pickColor(h) } : undefined}
                        />
                        {h}
                      </span>
                    </td>
                    {data.charts.map((c) => (
                      <td key={c.id} className="py-1.5 pr-3">
                        <span className="flex items-center gap-2">
                          <Sparkline values={c.lines.find((l) => l.label === h)?.values ?? []} top={tops.get(c.id) ?? 1} />
                          <span className="whitespace-nowrap font-mono text-xs">{format(current(c, h), c.unit, c.suffix)}</span>
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The charts a kind's graphs make of what the server sent: the built-in ones
 * as they came, the ones put together from their data sources.
 */
function compose(graphs: PerfGraph[], data: PerfData, pool: boolean): PerfChart[] {
  const out: PerfChart[] = [];
  for (const g of graphs) {
    if (g.hidden) continue;
    if (g.builtin) {
      const c = data.charts.find((x) => x.id === g.builtin);
      // The floor set in "Edit graphs" over the default the server sends.
      if (c) out.push(g.minTop !== undefined ? { ...c, minTop: g.minTop } : c);
      continue;
    }
    const lines: PerfLine[] = [];
    const notRecorded: string[] = [];
    let extra = 0;
    let pending = false;
    for (const gl of g.lines ?? []) {
      const s = data.sources?.[gl.source];
      if (!s) {
        // An answer from before the graph was added or shown.
        pending = true;
        continue;
      }
      if (s.lines.length === 0) {
        notRecorded.push(sourceLabel(gl.source));
        continue;
      }
      s.lines.forEach((l, j) => {
        const label = pool
          ? l.name
          : l.count
            ? `${sourceLabel(gl.source)} (${l.count}, ${combineBy(s.unit) === "sum" ? "total" : "average"})`
            : sourceLabel(l.name);
        // A pattern's first match in the colour chosen for it, the others after.
        const c = pool ? undefined : j === 0 ? gl.color : color(Math.max(0, LINE_COLORS.indexOf(gl.color)) + j + extra);
        lines.push({ label, values: l.values, unit: s.unit, suffix: s.suffix, color: c });
      });
      extra += s.lines.length - 1;
    }
    const first = lines[0];
    const allPercent = lines.length > 0 && lines.every((l) => l.unit === "percent");
    const peak = Math.max(0, ...lines.flatMap((l) => l.values.filter((v): v is number => v !== null)));
    out.push({
      id: g.id,
      title: g.name ?? g.id,
      unit: first?.unit ?? "number",
      suffix: first?.suffix,
      lines,
      ...(allPercent && peak <= 100 ? { max: 100 } : {}),
      // Only load averages: a floor like the built-in graph's.
      ...(lines.length && isLoadGraph(g) ? { minTop: g.minTop ?? LOAD_MIN_TOP } : {}),
      ...(notRecorded.length ? { notRecorded } : {}),
      ...(pending ? { pending } : {}),
    });
  }
  return out;
}

/** A graph put together that has nothing to draw here. */
function NotRecorded({ chart, canEdit }: { chart: PerfChart; canEdit: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{chart.title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {chart.pending ? (
          "Loading…"
        ) : (
          <>
            Not recorded here: {chart.notRecorded?.join(", ")}.
            {canEdit && " An admin can switch recording on in the graph's settings."}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The Performance tab of a VM (vmRef), a host (hostRef) or the whole pool (pool). */
export function PerfCharts({ conn, vmRef, hostRef, pool }: { conn: HostConnection; vmRef?: string; hostRef?: string; pool?: boolean }) {
  const { role } = useAuth();
  const kind: GraphKind = pool ? "pool" : vmRef ? "vm" : "host";
  const [period, setPeriod] = useState<Period>("10m");
  const [data, setData] = useState<PerfData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [graphs, setGraphs] = useState<Record<GraphKind, PerfGraph[]> | null>(null);
  // Data is asked for once it is known which graphs want which sources.
  const [graphsKnown, setGraphsKnown] = useState(false);
  const [editing, setEditing] = useState(false);
  // Answers can overtake each other: only the newest request's is shown.
  const latestRequest = useRef(0);
  const canEdit = role === "admin" || role === "operator";

  // Primitives, not conn itself: conn changes with every event from the pool.
  const address = conn.connectedVia || conn.host.address;
  const { port, useSsl } = conn.host;
  const sessionRef = conn.session?.sessionRef;

  useEffect(() => {
    let gone = false;
    fetch("/api/perf-graphs", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!gone && j?.graphs) setGraphs(j.graphs);
      })
      .catch(() => {})
      .finally(() => {
        if (!gone) setGraphsKnown(true);
      });
    return () => {
      gone = true;
    };
  }, []);

  const mine = useMemo<PerfGraph[]>(() => graphs?.[kind] ?? BUILTIN_GRAPHS[kind].map((b) => ({ id: b.id, builtin: b.id })), [graphs, kind]);
  // The data sources the shown graphs need, as one string: a dependency that
  // only changes when they do.
  const wanted = useMemo(() => {
    const seen = new Map<string, string>();
    for (const g of mine) if (!g.hidden) for (const l of g.lines ?? []) if (!seen.has(l.source)) seen.set(l.source, l.units);
    return JSON.stringify([...seen].map(([source, units]) => ({ source, units })));
  }, [mine]);

  const load = useCallback(async () => {
    if (!sessionRef || !graphsKnown) return;
    const id = ++latestRequest.current;
    setLoading(true);
    try {
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rrd",
          host: address,
          port,
          useSsl,
          sessionRef,
          vmRef,
          hostRef,
          pool: pool === true,
          period,
          sources: JSON.parse(wanted),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (id !== latestRequest.current) return;
      if (!res.ok) {
        setError(json.error ?? "No performance data");
        return;
      }
      setError(null);
      setData(json);
    } catch {
      if (id === latestRequest.current) setError("XenMan did not answer");
    } finally {
      if (id === latestRequest.current) setLoading(false);
    }
  }, [address, port, useSsl, sessionRef, vmRef, hostRef, pool, period, wanted, graphsKnown]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    // A pool means one export per host: refreshed less often.
    const base = PERIODS.find((p) => p.id === period)?.refreshMs;
    const every = base && pool ? Math.max(base, 30_000) : base;
    const timer = every ? setInterval(load, every) : null;
    return () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }, [load, period, pool]);

  const charts = data ? compose(mine, data, pool === true) : [];
  const drawn = charts.filter((c) => c.lines.length > 0);
  const empty = charts.filter((c) => c.lines.length === 0);
  const target: SourceTarget = { address, port, useSsl, sessionRef, vmRef, hostRef, pool: pool === true };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {PERIODS.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={p.id === period ? "default" : "outline"}
            onClick={() => {
              setData(null);
              setPeriod(p.id);
            }}
          >
            {p.label}
          </Button>
        ))}
        {loading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
        {canEdit && graphs && (
          <Button size="sm" variant={editing ? "default" : "outline"} className="ml-auto" onClick={() => setEditing((e) => !e)}>
            <Settings2 className="h-4 w-4" />
            Edit graphs
          </Button>
        )}
      </div>
      {editing && graphs && (
        <GraphListEditor
          kind={kind}
          graphs={mine}
          target={target}
          canRecord={role === "admin"}
          onSaved={setGraphs}
          onDone={() => setEditing(false)}
        />
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {data?.missing && data.missing.length > 0 && (
        <p className="text-sm text-amber-600">
          No data from {data.missing.join(", ")} — {data.missing.length === 1 ? "it is" : "they are"} left out.
        </p>
      )}
      {data?.notRunning && (
        <p className="text-sm text-muted-foreground">The VM is not running. XenServer records performance data while it runs.</p>
      )}
      {data && !data.notRunning && charts.length === 0 && data.charts.length > 0 && (
        <p className="text-sm text-muted-foreground">All graphs are hidden.{canEdit && " Edit graphs shows them again."}</p>
      )}
      {data && !data.notRunning && drawn.length === 0 && data.charts.length === 0 && (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>No performance data for this period yet.</p>
          {data.received && (
            // Shown so a shape XenMan does not know can be reported as it is.
            <details className="text-xs">
              <summary className="cursor-pointer">What the host sent</summary>
              <p className="mt-1">
                {data.received.columns} columns, {data.received.rows} rows
                {data.received.sample.length > 0 && ", e.g.:"}
              </p>
              {data.received.sample.length > 0 && (
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono">{data.received.sample.join("\n")}</pre>
              )}
              {data.received.head && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">{data.received.head}</pre>}
            </details>
          )}
        </div>
      )}
      {data && !data.notRunning && drawn.length > 0 && pool && Math.max(...drawn.map((c) => c.lines.length)) > POOL_LINES_MAX ? (
        // Many hosts: a line each would only be a tangle.
        <div className="space-y-4">
          {empty.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              {empty.map((c) => (
                <NotRecorded key={c.id} chart={c} canEdit={canEdit} />
              ))}
            </div>
          )}
          <PoolOverview data={{ ...data, charts: drawn }} period={period} />
        </div>
      ) : (
        data &&
        !data.notRunning &&
        charts.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-2">
            {charts.map((c) =>
              c.lines.length ? (
                <LineChart key={c.id} chart={c} times={data.times} period={period} />
              ) : (
                <NotRecorded key={c.id} chart={c} canEdit={canEdit} />
              ),
            )}
          </div>
        )
      )}
    </div>
  );
}
