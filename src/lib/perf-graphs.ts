// The performance graphs everyone sees, per kind of object: the built-in ones
// in the order and with the visibility chosen, and the ones put together from
// XenServer's data sources. Kept in DATA_DIR/perf-graphs.json; without it,
// the built-in graphs as they always were.

import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import {
  BUILTIN_GRAPHS,
  LINE_COLORS,
  MAX_GRAPHS,
  MAX_LINES,
  SOURCE_RE,
  isLoadGraph,
  type GraphKind,
  type GraphLine,
  type PerfGraph,
} from "./perf-sources";

/** A load graph's scale floor as sent: a number above 0, up to 1000; undefined when not given. */
function parseMinTop(v: unknown): number | undefined | null {
  if (v === undefined || v === null) return undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000 ? v : null;
}

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const FILE = path.join(DATA_DIR, "perf-graphs.json");

export const GRAPH_KINDS: GraphKind[] = ["vm", "host", "pool"];

export function isGraphKind(k: unknown): k is GraphKind {
  return typeof k === "string" && (GRAPH_KINDS as string[]).includes(k);
}

export function defaultGraphs(kind: GraphKind): PerfGraph[] {
  return BUILTIN_GRAPHS[kind].map((b) => ({ id: b.id, builtin: b.id }));
}

function readAll(): Partial<Record<GraphKind, PerfGraph[]>> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return {};
  }
}

/** The graphs of every kind; a kind never changed has the defaults. */
export function readGraphs(): Record<GraphKind, PerfGraph[]> {
  const saved = readAll();
  const out = {} as Record<GraphKind, PerfGraph[]>;
  for (const k of GRAPH_KINDS) {
    const list = saved[k];
    // Checked again on reading: a hand-edited file is not trusted further.
    const parsed = Array.isArray(list) ? parseGraphs(k, list) : null;
    out[k] = parsed && "graphs" in parsed ? parsed.graphs : defaultGraphs(k);
  }
  return out;
}

/** Saves one kind's graphs; null puts it back to the defaults. */
export function saveGraphs(kind: GraphKind, graphs: PerfGraph[] | null) {
  const all = readAll();
  if (graphs) all[kind] = graphs;
  else delete all[kind];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(FILE, JSON.stringify(all, null, 2));
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[\w-]{1,40}$/;
const UNITS_RE = /^[^\x00-\x1f<>]{0,32}$/;

/** A kind's graphs as sent by the browser, checked and reduced to what is known; or why not. */
export function parseGraphs(kind: GraphKind, input: unknown): { graphs: PerfGraph[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "graphs must be a list" };
  if (input.length > MAX_GRAPHS) return { error: `At most ${MAX_GRAPHS} graphs` };
  const builtins = new Set(BUILTIN_GRAPHS[kind].map((b) => b.id));
  const ids = new Set<string>();
  const graphs: PerfGraph[] = [];
  for (const raw of input) {
    const g = (raw ?? {}) as Record<string, unknown>;
    const id = typeof g.id === "string" ? g.id : "";
    if (!ID_RE.test(id) || ids.has(id)) return { error: "Each graph needs its own id" };
    ids.add(id);
    const hidden = g.hidden === true;
    const minTop = parseMinTop(g.minTop);
    if (minTop === null) return { error: "The scale of a load graph starts at a number above 0, up to 1000" };
    if (g.builtin !== undefined) {
      if (typeof g.builtin !== "string" || !builtins.has(g.builtin)) return { error: `Unknown built-in graph "${String(g.builtin)}"` };
      if (graphs.some((x) => x.builtin === g.builtin)) return { error: `The graph "${g.builtin}" is there twice` };
      if (minTop !== undefined && !isLoadGraph({ builtin: g.builtin })) return { error: `Only a load graph has a scale floor` };
      graphs.push({ id, builtin: g.builtin, ...(hidden ? { hidden } : {}), ...(minTop !== undefined ? { minTop } : {}) });
      continue;
    }
    const name = typeof g.name === "string" ? g.name.trim() : "";
    if (!name || name.length > 60) return { error: "A graph needs a name of up to 60 characters" };
    if (!Array.isArray(g.lines) || g.lines.length === 0) return { error: `"${name}": pick at least one data source` };
    if (g.lines.length > MAX_LINES) return { error: `"${name}": at most ${MAX_LINES} data sources` };
    // A pool's graph draws its one measure for every host.
    if (kind === "pool" && g.lines.length > 1) return { error: `"${name}": a pool graph shows one data source` };
    const lines: GraphLine[] = [];
    for (const rawLine of g.lines) {
      const l = (rawLine ?? {}) as Record<string, unknown>;
      const source = typeof l.source === "string" ? l.source : "";
      const units = typeof l.units === "string" ? l.units : "";
      const color = typeof l.color === "string" ? l.color : "";
      if (!SOURCE_RE.test(source)) return { error: `"${name}": not a data source name: "${source}"` };
      if (lines.some((x) => x.source === source)) return { error: `"${name}": "${source}" is there twice` };
      if (!UNITS_RE.test(units)) return { error: `"${name}": invalid unit for "${source}"` };
      if (!LINE_COLORS.includes(color) && !COLOR_RE.test(color)) return { error: `"${name}": invalid colour for "${source}"` };
      lines.push({ source, units, color });
    }
    if (minTop !== undefined && !isLoadGraph({ lines })) return { error: `"${name}": only a load graph has a scale floor` };
    graphs.push({ id, name, lines, ...(hidden ? { hidden } : {}), ...(minTop !== undefined ? { minTop } : {}) });
  }
  return { graphs };
}
