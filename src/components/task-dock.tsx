"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import { useXen } from "@/context/xen-context";
import {
  RecentTasksTable,
  filterTasks,
  scopePools,
  useRecentTasks,
  useWideScreen,
  type TaskScope,
} from "@/components/recent-tasks";

const OPEN_KEY = "xenman-task-dock-open";
const HEIGHT_KEY = "xenman-task-dock-height";
const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 120;
/** The header row, always shown. */
const HEADER_HEIGHT = 32;
const maxHeight = () => Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.6));

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not kept; fine
  }
}

/**
 * Recent Tasks docked at the bottom of every view, as vSphere has it: the
 * tasks of what is selected -- a VM, a host, a pool, or every pool on the
 * dashboard -- resizable at its top edge and collapsible to its header row.
 * From Tailwind's `md` up; on a phone the overview shows a card instead.
 */
export function TaskDock() {
  const { state } = useXen();
  const wide = useWideScreen();
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const drag = useRef<{ y: number; h: number } | null>(null);

  // After mounting: what this browser chose last time.
  useEffect(() => {
    const t = setTimeout(() => {
      setOpen(read(OPEN_KEY) !== "0");
      const h = Number(read(HEIGHT_KEY));
      if (h >= MIN_HEIGHT) setHeight(Math.min(h, maxHeight()));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const { selectedHostId, selectedXenHostRef, selectedVmRef, connections } = state;
  const scope: TaskScope = useMemo(() => {
    if (!selectedHostId) return { kind: "all" };
    if (selectedVmRef) return { kind: "vm", hostId: selectedHostId, vmRef: selectedVmRef };
    if (selectedXenHostRef) return { kind: "host", hostId: selectedHostId, hostRef: selectedXenHostRef };
    return { kind: "pool", hostId: selectedHostId };
  }, [selectedHostId, selectedXenHostRef, selectedVmRef]);
  const poolKey = scopePools(scope, connections).join(",");
  const pools = useMemo(() => (poolKey ? poolKey.split(",") : []), [poolKey]);
  const { tasks, error, cancel } = useRecentTasks(pools, { active: wide === true, fast: open });

  // The bell and anything else at the bottom right sit above the panel.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--task-dock-h", `${wide ? (open ? height + HEADER_HEIGHT + 6 : HEADER_HEIGHT) : 0}px`);
    return () => {
      root.style.removeProperty("--task-dock-h");
    };
  }, [wide, open, height]);

  if (wide !== true) return null;

  const shown = filterTasks(tasks ?? [], scope, connections);
  const running = shown.filter((t) => t.state === "running").length;

  const conn = scope.kind === "all" ? undefined : connections[scope.hostId];
  const where =
    scope.kind === "all"
      ? "All pools"
      : scope.kind === "vm"
        ? conn?.vms[scope.vmRef]?.nameLabel
        : scope.kind === "host"
          ? conn?.hostRecords[scope.hostRef]?.nameLabel
          : conn && (Object.values(conn.pools)[0]?.nameLabel || conn.host.name);

  const toggle = () => {
    setOpen((o) => {
      write(OPEN_KEY, o ? "0" : "1");
      return !o;
    });
  };

  const setKept = (h: number) => {
    const next = Math.min(Math.max(h, MIN_HEIGHT), maxHeight());
    setHeight(next);
    return next;
  };

  // Light: white like a card on the grey shell, so it stands apart. Dark: the shell's own colour, as it was.
  return (
    <section
      aria-label="Recent Tasks"
      className="hidden shrink-0 flex-col border-t border-zinc-300 bg-card text-card-foreground shadow-[0_-2px_6px_rgb(0_0_0/0.06)] md:flex dark:border-zinc-800 dark:bg-[var(--shell-canvas)] dark:shadow-none"
    >
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize Recent Tasks"
          aria-valuenow={height}
          aria-valuemin={MIN_HEIGHT}
          tabIndex={0}
          title="Drag to resize. Double-click to reset."
          className="group flex h-2.5 shrink-0 cursor-row-resize touch-none items-center justify-center border-b border-zinc-200 bg-zinc-100 transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none dark:border-zinc-800 dark:bg-zinc-900"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { y: e.clientY, h: height };
          }}
          onPointerMove={(e) => {
            if (drag.current) setKept(drag.current.h + (drag.current.y - e.clientY));
          }}
          onPointerUp={(e) => {
            if (!drag.current) return;
            write(HEIGHT_KEY, String(setKept(drag.current.h + (drag.current.y - e.clientY))));
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onDoubleClick={() => write(HEIGHT_KEY, String(setKept(DEFAULT_HEIGHT)))}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            write(HEIGHT_KEY, String(setKept(height + (e.key === "ArrowUp" ? 20 : -20))));
          }}
        >
          {/* The grip: where to take hold of it. */}
          <span className="h-1 w-10 rounded-full bg-zinc-300 group-hover:bg-primary/60 dark:bg-zinc-700" />
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex h-8 shrink-0 items-center gap-2 px-4 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
        <ListChecks className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">Recent Tasks</span>
        {where && <span className="truncate text-muted-foreground">· {where}</span>}
        {running > 0 && (
          <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
            {running}
          </span>
        )}
      </button>
      {open && (
        <div style={{ height }} className="overflow-auto border-t border-zinc-200 text-sm dark:border-zinc-800">
          {error && <p className="px-4 py-2 text-destructive">{error}</p>}
          {tasks === null && !error ? (
            <p className="px-4 py-2 text-muted-foreground">Loading</p>
          ) : shown.length === 0 ? (
            <p className="px-4 py-2 text-muted-foreground">
              {pools.length === 0 ? "No pool is connected." : "No tasks in the last 24 hours."}
            </p>
          ) : (
            <RecentTasksTable tasks={shown} cancel={cancel} showPool={scope.kind === "all"} stickyHeader />
          )}
        </div>
      )}
    </section>
  );
}
