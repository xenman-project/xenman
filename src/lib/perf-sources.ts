// XenServer's data sources -- the columns of its RRDs -- as XenCenter names
// them, for the graphs one puts together oneself. Used on both sides: the
// server picks columns and converts units, the browser lists and labels them.
//
// A source is named by XenServer ("vbd_xvda_read_latency"); a graph stores a
// pattern instead when it should apply to every disk, network interface or CPU
// ("vbd_*_read_latency"), so one graph fits all VMs whatever their devices.

export type SourceType = "CPU" | "Memory" | "Disk" | "Network" | "Storage" | "GPU" | "Other";

export type Unit = "percent" | "bytes" | "bytesPerSecond" | "seconds" | "perSecond" | "number";

/** A data source as XenServer describes it (VM.get_data_sources / host.get_data_sources). */
export interface DataSource {
  name: string;
  description: string;
  units: string;
  enabled: boolean;
  standard: boolean;
}

/** A source pattern of the form XenServer's names take, with "*" for a device. */
export const SOURCE_RE = /^[\w.:/*-]{1,128}$/;

const DEVICE = String.raw`[^_]+`;
// The parts of a name that are a device -- a CPU, disk, interface, SR or GPU --
// and give way to "*" in a pattern.
const DEVICE_RULES: [RegExp, string][] = [
  [/^cpu(?:\d+|\*)(?=$|-)/, "cpu*"],
  [new RegExp(`^vbd_${DEVICE}_`), "vbd_*_"],
  [/^vif_(?:\d+|\*)_/, "vif_*_"],
  [new RegExp(`^pif_(?!aggr_)${DEVICE}_`), "pif_*_"],
  [new RegExp(`^sr_${DEVICE}_`), "sr_*_"],
  // An SR's per-host figures end in the first part of its uuid.
  [/_(?:[0-9a-f]{8}|\*)$/, "_*"],
  // A GPU's figures end in its PCI address.
  [/_(?:[0-9a-f]{4}[/:][0-9a-f]{2}[/:][0-9a-f]{2}\.[0-9a-f]|\*)$/i, "_*"],
];

/** The pattern that covers this source on every device of its kind; the name itself if it has none. */
export function patternOf(name: string): string {
  for (const [re, to] of DEVICE_RULES) if (re.test(name)) return name.replace(re, to);
  return name;
}

/** Whether a source name falls under a pattern ("*" stands for a device). */
export function matchesPattern(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  // A device name has neither "_" nor "-": "cpu*" is not "cpu0-C1".
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^_-]+")}$`);
  return re.test(name);
}

const words = (s: string) =>
  s
    .split("_")
    .filter(Boolean)
    .map((w) => (w === "io" ? "IO" : w === "iops" ? "IOPS" : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

// What a disk's or an SR's measure is called, by the end of its name.
const DISK_MEASURES: Record<string, string> = {
  read: "Read",
  write: "Write",
  read_latency: "Read Latency",
  write_latency: "Write Latency",
  iops_read: "Read IOPS",
  iops_write: "Write IOPS",
  iops_total: "Total IOPS",
  io_throughput_read: "Read Throughput",
  io_throughput_write: "Write Throughput",
  io_throughput_total: "Total Throughput",
  avgqu_sz: "Queue Size",
  inflight: "Requests in Flight",
  iowait: "IO Wait",
};

const NAMED: Record<string, string> = {
  cpu_avg: "Average CPU",
  memory: "Total Memory",
  memory_target: "Memory Target",
  memory_internal_free: "Free Memory (guest)",
  memory_total_kib: "Total Memory",
  memory_free_kib: "Free Memory",
  memory_reclaimed: "Reclaimed Memory",
  memory_reclaimed_max: "Reclaimable Memory",
  loadavg: "Control Domain Load",
  pif_aggr_rx: "All Network Receive",
  pif_aggr_tx: "All Network Send",
  xapi_memory_usage_kib: "Agent Memory Used",
  xapi_free_memory_kib: "Agent Memory Free",
  xapi_live_memory_kib: "Agent Memory Live",
  xapi_allocation_kib: "Agent Memory Allocation",
  xapi_open_fds: "Agent Open Files",
  pool_task_count: "Pool Tasks",
  pool_session_count: "Pool Sessions",
};

/** A readable name, as XenCenter shows it: "vbd_xvda_read_latency" → "Disk xvda Read Latency". */
export function sourceLabel(name: string): string {
  if (NAMED[name]) return NAMED[name];
  let m: RegExpExecArray | null;
  if ((m = /^cpu(\d+|\*)$/.exec(name))) return `CPU ${m[1]}`;
  if ((m = /^cpu(\d+|\*)-([CP])(\d+)$/.exec(name))) return `CPU ${m[1]} ${m[2]}-State ${m[3]}`;
  if ((m = /^vbd_([^_]+)_(.+)$/.exec(name))) return `Disk ${m[1]} ${DISK_MEASURES[m[2]] ?? words(m[2])}`;
  if ((m = /^(vif|pif)_([^_]+)_(rx|tx)(?:_(errors))?$/.exec(name))) {
    return `Network ${m[2]} ${m[3] === "rx" ? "Receive" : "Send"}${m[4] ? " Errors" : ""}`;
  }
  if ((m = /^sr_([^_]+)_(.+)$/.exec(name))) return `Storage ${m[1]} ${words(m[2])}`;
  if ((m = /^gpu_(.+)_((?:[0-9a-f]{4}[/:][0-9a-f]{2}[/:][0-9a-f]{2}\.[0-9a-f])|\*)$/i.exec(name))) return `GPU ${m[2]} ${words(m[1])}`;
  if ((m = /^(.+)_([0-9a-f]{8}|\*)$/.exec(name)) && DISK_MEASURES[m[1]]) return `Storage ${m[2]} ${DISK_MEASURES[m[1]]}`;
  if ((m = /^runstate_(.+)$/.exec(name))) return `Runstate ${words(m[1])}`;
  return name;
}

/** The group XenCenter puts a source in. */
export function sourceType(name: string): SourceType {
  if (/^(cpu|runstate_)/.test(name)) return "CPU";
  if (/^vbd_/.test(name)) return "Disk";
  if (/^(vif|pif)_/.test(name)) return "Network";
  if (/^v?gpu_/.test(name)) return "GPU";
  if (/^sr_/.test(name) || /^(.+)_([0-9a-f]{8}|\*)$/.test(name)) return "Storage";
  if (/memory|_kib$/.test(name)) return "Memory";
  return "Other";
}

export interface UnitScale {
  unit: Unit;
  /** What XenServer's value is multiplied with. */
  factor: number;
  /** For a plain number: what it counts, shown after it. */
  suffix?: string;
}

/**
 * XenServer's unit of a source, in the units the graphs draw: fractions as
 * percent, KiB and MiB as bytes, microseconds as seconds. What is not known
 * stays a number with XenServer's unit after it.
 */
export function unitScale(units: string, name = ""): UnitScale {
  const u = units.trim();
  // Declared a fraction, but a load average is not one.
  if (name === "loadavg") return { unit: "number", factor: 1 };
  switch (u) {
    case "(fraction)":
    case "fraction":
      return { unit: "percent", factor: 100 };
    case "%":
    case "percent":
      return { unit: "percent", factor: 1 };
    case "B":
    case "Bytes":
    case "bytes":
      return { unit: "bytes", factor: 1 };
    case "KiB":
      return { unit: "bytes", factor: 1024 };
    case "MiB":
      return { unit: "bytes", factor: 1024 ** 2 };
    case "B/s":
    case "Bytes/s":
    case "BytesPerSecond":
      return { unit: "bytesPerSecond", factor: 1 };
    case "KiB/s":
      return { unit: "bytesPerSecond", factor: 1024 };
    case "MiB/s":
      return { unit: "bytesPerSecond", factor: 1024 ** 2 };
    case "s":
    case "seconds":
      return { unit: "seconds", factor: 1 };
    case "ms":
      return { unit: "seconds", factor: 1e-3 };
    case "μs":
    case "µs":
    case "microseconds":
      return { unit: "seconds", factor: 1e-6 };
    case "":
    case "dimensionless":
    case "count":
      return { unit: "number", factor: 1 };
  }
  if (/^[\w ]+\/s$/.test(u)) return { unit: "perSecond", factor: 1, suffix: u.slice(0, -2) };
  return { unit: "number", factor: 1, suffix: u };
}

/** How many of a pattern's sources add up (traffic, bytes) or average (shares, latencies). */
export function combineBy(unit: Unit): "sum" | "avg" {
  return unit === "bytesPerSecond" || unit === "perSecond" || unit === "bytes" ? "sum" : "avg";
}

/** The kinds of object a graph is drawn for. */
export type GraphKind = "vm" | "host" | "pool";

/** The graphs XenMan has drawn from the start, per kind, in their order. */
export const BUILTIN_GRAPHS: Record<GraphKind, { id: string; title: string }[]> = {
  vm: [
    { id: "cpu", title: "CPU" },
    { id: "memory", title: "Memory" },
    { id: "network", title: "Network" },
    { id: "disk", title: "Disk" },
  ],
  host: [
    { id: "cpu", title: "CPU" },
    { id: "memory", title: "Memory" },
    { id: "network", title: "Network" },
    { id: "load", title: "Load average" },
  ],
  pool: [
    { id: "cpu", title: "CPU" },
    { id: "memory", title: "Memory used" },
    { id: "network", title: "Network (in + out)" },
    { id: "load", title: "Load average" },
  ],
};

/** One line of a graph: a source or pattern, with XenServer's unit for it. */
export interface GraphLine {
  source: string;
  units: string;
  color: string;
}

/** A built-in graph (builtin set), or one put together (name and lines). */
export interface PerfGraph {
  id: string;
  builtin?: string;
  name?: string;
  lines?: GraphLine[];
  hidden?: boolean;
  /** Load graphs only: the scale reaches at least this high (default LOAD_MIN_TOP). */
  minTop?: number;
}

/**
 * Where a load graph's scale starts before it grows with the data: low enough
 * to show a host at work, high enough that an idle one (0.06, spikes of 0.3)
 * does not fill the graph.
 */
export const LOAD_MIN_TOP = 0.5;

/** A graph of load averages only: the built-in one, or one put together from loadavg. */
export function isLoadGraph(g: Pick<PerfGraph, "builtin" | "lines">): boolean {
  if (g.builtin) return g.builtin === "load";
  return Boolean(g.lines?.length) && g.lines!.every((l) => l.source === "loadavg");
}

/** Ten colours for lines, enough for a pool of hosts; beyond, they repeat. */
export const LINE_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)",
  "#a855f7", "#14b8a6", "#f43f5e", "#84cc16", "#0ea5e9",
];

export const MAX_GRAPHS = 30;
export const MAX_LINES = 12;
