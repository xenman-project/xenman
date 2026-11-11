// Performance data from XenServer's round-robin databases, as XenCenter's
// Performance tab shows it. Every host keeps the RRDs of itself and of the VMs
// running on it, and hands out a time window of them over HTTP:
//
//   GET /rrd_updates?session_id=&start=<unix s>&cf=AVERAGE&interval=<s>&host=true
//       the host and the VMs on it
//
// For a VM, its host's whole export is fetched and the VM picked out here, as
// XenCenter and Xen Orchestra do: asked with vm_uuid, a real XenServer 8
// answered with nothing for the VM.
//
// The answer is documented as XML:
//   <xport><meta><step>5</step>...<legend><entry>AVERAGE:host:<uuid>:cpu0</entry>
//   ...</legend></meta><data><row><t>1700000000</t><v>0.12</v>...</row></data></xport>
// but XenServer 8 sends the same as JSON (seen in the field), numbers as strings:
//   {"meta":{"step":"5",...,"legend":["AVERAGE:host:<uuid>:cpu0",...]},
//    "data":[{"t":"1700000000","values":["0.12",...]},...]}
// Both are read.
//
// The archives XenServer keeps decide the steps: 5 s for ten minutes, a minute
// for two hours, an hour for a week, a day for a year.

import { combineBy, LOAD_MIN_TOP, matchesPattern, unitScale, type Unit } from "./perf-sources";
import { xenFetch } from "./xen-tls";

export type RrdPeriod = "10m" | "2h" | "1w" | "1y";

export const RRD_PERIODS: Record<RrdPeriod, { seconds: number; interval: number }> = {
  "10m": { seconds: 600, interval: 5 },
  "2h": { seconds: 2 * 3600, interval: 60 },
  "1w": { seconds: 7 * 86400, interval: 3600 },
  "1y": { seconds: 365 * 86400, interval: 86400 },
};

export function isRrdPeriod(p: unknown): p is RrdPeriod {
  return typeof p === "string" && p in RRD_PERIODS;
}

export interface RrdExport {
  step: number;
  /** "AVERAGE:host:<uuid>:cpu0" and so on, one per column. */
  legend: string[];
  /** Oldest first. */
  rows: { t: number; v: (number | null)[] }[];
  /** The start of the answer, kept for when it was not what was expected. */
  head?: string;
}

const tagValues = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1].trim());

function num(s: unknown): number | null {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null; // "NaN" where nothing was recorded
}

/** Whichever of the two shapes the host answered in. */
export function parseRrd(text: string): RrdExport {
  try {
    return text.trimStart().startsWith("{") ? parseRrdJson(text) : parseRrdXml(text);
  } catch {
    // Neither: nothing drawn, and the tab shows what came instead.
    return { step: 0, legend: [], rows: [] };
  }
}

/**
 * The JSON form. A value that was never recorded may come as a bare NaN or
 * Infinity, which JSON does not know: made null before parsing.
 */
export function parseRrdJson(text: string): RrdExport {
  const doc = JSON.parse(text.replace(/(?<=[:,[]\s*)-?(?:NaN|Infinity)(?=\s*[,\]}])/g, "null")) as {
    meta?: { step?: unknown; legend?: unknown[] };
    data?: { t?: unknown; values?: unknown[] }[];
  };
  const legend = (doc.meta?.legend ?? []).map(String);
  const rows = (doc.data ?? []).map((r) => ({ t: Number(r.t), v: (r.values ?? []).map(num) }));
  rows.sort((a, b) => a.t - b.t);
  return { step: Number(doc.meta?.step) || 0, legend, rows };
}

/** The XML of rrd_updates; its shape is fixed and flat enough for a regex. */
export function parseRrdXml(xml: string): RrdExport {
  const meta = /<meta>([\s\S]*?)<\/meta>/.exec(xml)?.[1] ?? "";
  const step = Number(tagValues(meta, "step")[0]) || 0;
  const legend = tagValues(meta, "entry");
  const data = /<data>([\s\S]*?)<\/data>/.exec(xml)?.[1] ?? "";
  const rows = [...data.matchAll(/<row>([\s\S]*?)<\/row>/g)].map((m) => ({
    t: Number(tagValues(m[1], "t")[0]),
    v: tagValues(m[1], "v").map(num),
  }));
  // XenServer lists the newest row first.
  rows.sort((a, b) => a.t - b.t);
  return { step, legend, rows };
}

export interface PerfLine {
  label: string;
  values: (number | null)[];
}

export interface PerfChart {
  id: "cpu" | "memory" | "network" | "disk" | "load";
  title: string;
  unit: "percent" | "bytes" | "bytesPerSecond" | "number";
  lines: PerfLine[];
  /** The top of the scale when it is known (100 %, the memory a VM has). */
  max?: number;
  /**
   * The scale grows with the data but starts no lower than this: a load
   * average of 0.06 drawn up to 0.35 makes an idle host look busy.
   */
  minTop?: number;
}

/** A data source asked for by a graph put together: a name or pattern, and XenServer's unit for it. */
export interface SourceRequest {
  source: string;
  units: string;
}

/** What a source or pattern found: one line per matching column (per host for a pool), converted. */
export interface SourceSeries {
  unit: Unit;
  suffix?: string;
  lines: { name: string; values: (number | null)[]; count?: number }[];
}

export interface PerfData {
  step: number;
  times: number[];
  charts: PerfChart[];
  /** The graphs put together: per source asked for, what was found. */
  sources?: Record<string, SourceSeries>;
  /**
   * When nothing could be drawn: what the host sent instead, to tell an empty
   * archive from an answer in a shape this does not know.
   */
  received?: { columns: number; rows: number; sample: string[]; head?: string };
}

/**
 * The charts for one object -- a host or a VM -- out of an export that may
 * hold others too (a host's export carries its VMs).
 */
export function perfCharts(x: RrdExport, kind: "host" | "vm", uuid: string, requests: SourceRequest[] = []): PerfData {
  const prefix = `average:${kind}:${uuid}:`.toLowerCase();
  const cols = new Map<string, number>();
  x.legend.forEach((e, i) => {
    if (e.toLowerCase().startsWith(prefix)) cols.set(e.slice(prefix.length), i);
  });
  const col = (name: string) => {
    const i = cols.get(name);
    return i === undefined ? null : x.rows.map((r) => r.v[i] ?? null);
  };
  const matching = (re: RegExp) => [...cols.keys()].filter((k) => re.test(k)).sort();
  /** Per row: f over the given columns, null where all are missing. */
  const combine = (names: string[], f: (vals: number[]) => number) =>
    x.rows.map((r) => {
      const vals = names.map((n) => r.v[cols.get(n)!]).filter((v): v is number => v !== null && v !== undefined);
      return vals.length ? f(vals) : null;
    });
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
  const avg = (v: number[]) => sum(v) / v.length;
  const scale = (vals: (number | null)[] | null, k: number) => (vals ? vals.map((v) => (v === null ? null : v * k)) : null);

  const charts: PerfChart[] = [];

  // CPU: each cpuN is a fraction of one core; shown as the average, in percent.
  const cpus = matching(/^cpu\d+$/);
  if (cpus.length) {
    charts.push({ id: "cpu", title: "CPU", unit: "percent", max: 100, lines: [{ label: `${cpus.length} CPU${cpus.length === 1 ? "" : "s"}`, values: combine(cpus, (v) => avg(v) * 100) }] });
  }

  // Memory in use.
  if (kind === "host") {
    const total = col("memory_total_kib");
    const free = col("memory_free_kib");
    if (total && free) {
      const used = total.map((t, i) => (t === null || free[i] === null ? null : (t - free[i]!) * 1024));
      const max = Math.max(...total.filter((t): t is number => t !== null)) * 1024;
      charts.push({ id: "memory", title: "Memory", unit: "bytes", max: Number.isFinite(max) ? max : undefined, lines: [{ label: "Used", values: used }] });
    }
  } else {
    const total = col("memory");
    const free = scale(col("memory_internal_free"), 1024); // KiB, and only with guest tools
    if (total) {
      const max = Math.max(...total.filter((t): t is number => t !== null));
      const lines: PerfLine[] = free
        ? [{ label: "Used", values: total.map((t, i) => (t === null || free[i] === null ? null : t - free[i]!)) }]
        : [{ label: "Assigned", values: total }];
      charts.push({ id: "memory", title: free ? "Memory" : "Memory (in use needs the guest tools)", unit: "bytes", max: Number.isFinite(max) ? max : undefined, lines });
    }
  }

  // Network: received and sent, all interfaces together -- for a host the sum
  // XenServer keeps itself (pif_aggr_*), when it does.
  const nic = kind === "host" ? "pif" : "vif";
  const aggr = kind === "host" && cols.has("pif_aggr_rx");
  const rx = aggr ? ["pif_aggr_rx"] : matching(new RegExp(`^${nic}_(?!aggr)\\w+_rx$`));
  const tx = aggr ? ["pif_aggr_tx"] : matching(new RegExp(`^${nic}_(?!aggr)\\w+_tx$`));
  if (rx.length || tx.length) {
    charts.push({
      id: "network",
      title: "Network",
      unit: "bytesPerSecond",
      lines: [
        { label: "Received", values: combine(rx, sum) },
        { label: "Sent", values: combine(tx, sum) },
      ],
    });
  }

  // Disk: a VM's virtual disks, read and written.
  if (kind === "vm") {
    const read = matching(/^vbd_\w+_read$/);
    const write = matching(/^vbd_\w+_write$/);
    if (read.length || write.length) {
      charts.push({
        id: "disk",
        title: "Disk",
        unit: "bytesPerSecond",
        lines: [
          { label: "Read", values: combine(read, sum) },
          { label: "Written", values: combine(write, sum) },
        ],
      });
    }
  }

  // A host's load average.
  const load = col("loadavg");
  if (kind === "host" && load) charts.push({ id: "load", title: "Load average", unit: "number", minTop: LOAD_MIN_TOP, lines: [{ label: "Load", values: load }] });

  const out: PerfData = { step: x.step, times: x.rows.map((r) => r.t), charts };
  if (requests.length) {
    out.sources = {};
    for (const r of requests) {
      const s = unitScale(r.units, r.source);
      const names = [...cols.keys()].filter((k) => matchesPattern(r.source, k)).sort(byDevice);
      const conv = (names: string[], f: (v: number[]) => number) => combine(names, f).map((v) => (v === null ? null : v * s.factor));
      out.sources[r.source] = {
        unit: s.unit,
        ...(s.suffix ? { suffix: s.suffix } : {}),
        // A host's sixty-four cores as one line, not sixty-four.
        lines:
          names.length > SOURCE_LINES_MAX
            ? [{ name: r.source, count: names.length, values: conv(names, combineBy(s.unit) === "sum" ? sum : avg) }]
            : names.map((n) => ({ name: n, values: conv([n], (v) => v[0]) })),
      };
    }
  }
  if (!charts.length && !Object.values(out.sources ?? {}).some((s) => s.lines.length)) {
    out.received = {
      columns: x.legend.length,
      rows: x.rows.length,
      sample: x.legend.slice(0, 8),
      ...(x.legend.length === 0 && x.head ? { head: x.head } : {}),
    };
  }
  return out;
}

/** Beyond this many matches, a pattern draws one line for all of them. */
export const SOURCE_LINES_MAX = 8;

/** cpu2 before cpu10. */
const byDevice = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** Fetches a window of a host's RRDs and those of the VMs running on it. */
export async function fetchRrd(
  address: string,
  port: number,
  useSsl: boolean,
  session: string,
  period: RrdPeriod,
): Promise<RrdExport> {
  const { seconds, interval } = RRD_PERIODS[period];
  const start = Math.floor(Date.now() / 1000) - seconds;
  const params = new URLSearchParams({
    session_id: session,
    start: String(start),
    cf: "AVERAGE",
    interval: String(interval),
    host: "true",
  });
  const res = await xenFetch(`${useSsl ? "https" : "http"}://${address}:${port}/rrd_updates?${params}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`The host answered ${res.status} for its performance data`);
  const text = await res.text();
  return { ...parseRrd(text), head: text.slice(0, 400) };
}

// A host's export carries all its VMs -- on a full GPU host over a thousand
// columns. Asked for by several pages at once (a pool view, a host, its VMs),
// it is fetched once and kept a few seconds.
const CACHE_MS = Number(process.env.XENMAN_RRD_CACHE_MS) || 10_000;
const g = globalThis as unknown as { _xenmanRrdCache?: Map<string, { at: number; rrd: Promise<RrdExport> }> };
const cache = (g._xenmanRrdCache ??= new Map());

/** fetchRrd, answered from a short cache per host address and period. */
export function fetchRrdCached(address: string, port: number, useSsl: boolean, session: string, period: RrdPeriod, poolId = ""): Promise<RrdExport> {
  // Per pool: hosts of two pools behind NAT may report the same internal address,
  // and a cache is no place to mix them up.
  const key = `${poolId}|${address}|${port}|${period}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.rrd;
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  const rrd = fetchRrd(address, port, useSsl, session, period);
  cache.set(key, { at: now, rrd });
  // A failure is not kept: the next request tries again.
  rrd.catch(() => cache.delete(key));
  return rrd;
}

export interface PoolHostExport {
  name: string;
  uuid: string;
  isCoordinator: boolean;
  rrd: RrdExport;
}

/**
 * The pool at a glance: per measure one chart, one line per host -- CPU and
 * memory in percent so hosts of different sizes compare, network as all that
 * goes in and out, and the load.
 */
export function poolCharts(hosts: PoolHostExport[], requests: SourceRequest[] = []): PerfData {
  // Per host, a pattern's sources as one value: what all its disks or
  // interfaces carry together, or what its cores use on average.
  const per = hosts.map((h) => {
    const data = perfCharts(h.rrd, "host", h.uuid, requests);
    for (const r of requests) {
      const s = data.sources![r.source];
      if (s.lines.length > 1) {
        const f = combineBy(s.unit);
        s.lines = [{
          name: r.source,
          count: s.lines.reduce((n, l) => n + (l.count ?? 1), 0),
          values: data.times.map((_, i) => {
            const vals = s.lines.map((l) => l.values[i]).filter((v): v is number => v !== null);
            if (!vals.length) return null;
            const total = vals.reduce((a, b) => a + b, 0);
            return f === "sum" ? total : total / vals.length;
          }),
        }];
      }
    }
    return { ...h, data };
  });
  // One time axis for all: the hosts' rows, merged.
  const times = [...new Set(per.flatMap((h) => h.data.times))].sort((a, b) => a - b);
  const onAxis = (h: (typeof per)[number], values: (number | null)[]) => {
    const at = new Map(h.data.times.map((t, i) => [t, values[i]]));
    return times.map((t) => at.get(t) ?? null);
  };
  const chart = (id: PerfChart["id"]) => (h: (typeof per)[number]) => h.data.charts.find((c) => c.id === id);
  const lines = (pick: (h: (typeof per)[number]) => (number | null)[] | null): PerfLine[] =>
    per.flatMap((h) => {
      const v = pick(h);
      return v ? [{ label: h.name, values: onAxis(h, v) }] : [];
    });

  const charts: PerfChart[] = [
    { id: "cpu", title: "CPU", unit: "percent", max: 100, lines: lines((h) => chart("cpu")(h)?.lines[0]?.values ?? null) },
    {
      id: "memory",
      title: "Memory used",
      unit: "percent",
      max: 100,
      lines: lines((h) => {
        const m = chart("memory")(h);
        return m && m.max ? m.lines[0].values.map((v) => (v === null ? null : (v / m.max!) * 100)) : null;
      }),
    },
    {
      id: "network",
      title: "Network (in + out)",
      unit: "bytesPerSecond",
      lines: lines((h) => {
        const n = chart("network")(h);
        if (!n) return null;
        return n.lines[0].values.map((v, i) => {
          const w = n.lines[1]?.values[i] ?? null;
          return v === null && w === null ? null : (v ?? 0) + (w ?? 0);
        });
      }),
    },
    { id: "load", title: "Load average", unit: "number", minTop: LOAD_MIN_TOP, lines: lines((h) => chart("load")(h)?.lines[0]?.values ?? null) },
  ].filter((c) => c.lines.length > 0) as PerfChart[];

  const out: PerfData = { step: Math.max(0, ...per.map((h) => h.data.step)), times, charts };
  if (requests.length) {
    out.sources = {};
    for (const r of requests) {
      const first = per.find((h) => h.data.sources?.[r.source])?.data.sources?.[r.source];
      out.sources[r.source] = {
        unit: first?.unit ?? "number",
        ...(first?.suffix ? { suffix: first.suffix } : {}),
        lines: per.flatMap((h) => {
          const l = h.data.sources?.[r.source]?.lines[0];
          return l ? [{ name: h.name, values: onAxis(h, l.values) }] : [];
        }),
      };
    }
  }
  return out;
}
