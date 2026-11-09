"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, Server, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import { memorySize, type HostMemory, type MemoryOverview, type VmMemoryRow } from "@/lib/xen-memory";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { xenNet } from "@/components/networking/host-networking";
import { CONTROL_DOMAIN, Grid, Segment, Shine, SliderMark, UNUSED, useWidth, VM_COLORS, VM_USED, XEN } from "./shiny-bar";
import { MemoryEditDialog } from "./memory-edit";
import { Dom0MemoryDialog } from "./dom0-memory-dialog";

// XenCenter's Memory tab (BallooningPage, HostMemoryRow, HostMemoryControls,
// HostShinyBar, VMMemoryRow, VMMemoryControlsNoEdit, VMShinyBar, MemoryRowLabel).
// A pool: a row per live host, the coordinator first, with its bar and figures.
// A host: its row, then its VMs, those with the same settings in one row.

const RELOAD_MS = 30_000;
const BRAND = "XenServer";

export function MemoryTab({
  conn,
  hostRef = null,
  vmRef = null,
  canEdit = false,
  isAdmin = false,
}: {
  conn: HostConnection;
  hostRef?: string | null;
  /** A VM's own tab: only its row. */
  vmRef?: string | null;
  /** Operators and admins: "Edit..." on the VM rows. */
  canEdit?: boolean;
  /** Admins: the control domain's memory (it reboots the server). */
  isAdmin?: boolean;
}) {
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<VmMemoryRow | null>(null);
  // The row as it was when opened: the server drops out of the list while it reboots.
  const [editingDom0, setEditingDom0] = useState<HostMemory | null>(null);

  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await xenNet(conn, { action: "memory_overview", ...(hostRef ? { hostRef } : vmRef ? { vmRef } : {}) }));
      loaded.current = true;
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [conn, hostRef, vmRef]);

  // Now and then, and shortly after VMs start, stop or move (several events at once count as one).
  useEffect(() => {
    const timer = setInterval(load, RELOAD_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const soon = setTimeout(load, loaded.current ? 2000 : 0);
    return () => clearTimeout(soon);
  }, [load, conn.vms]);

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          {error ? <XCircle className="h-4 w-4 text-destructive" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {error ?? "Loading memory…"}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2.5">
      {data.hosts.map((h) => (
        <HostRow key={h.hostRef} host={h} onEditControlDomain={isAdmin && h.controlDomain ? () => setEditingDom0(h) : undefined} />
      ))}
      {(() => {
        // The row as it is now (maintenance mode may have begun meanwhile), else as it was.
        const h = editingDom0 ? (data.hosts.find((x) => x.hostRef === editingDom0.hostRef) ?? editingDom0) : undefined;
        if (!h?.controlDomain) return null;
        const rec = conn.hostRecords[h.hostRef];
        return (
          <Dom0MemoryDialog
            conn={conn}
            host={h}
            canEnterMaintenance={Boolean(rec?.enabled) && Object.keys(conn.hostRecords).length > 1}
            onClose={() => setEditingDom0(null)}
            onChanged={load}
          />
        );
      })()}
      {data.vmRows.map((row) => (
        <VmRow
          key={row.vms.map((v) => v.ref).join()}
          row={row}
          onEdit={canEdit && data.edit && row.editable ? () => setEditing(row) : undefined}
        />
      ))}
      {editing && data.edit && (
        <MemoryEditDialog conn={conn} row={editing} ctx={data.edit} onClose={() => setEditing(null)} onChanged={load} />
      )}
    </div>
  );
}

const POWER_COLOR: Record<string, string> = {
  Running: "text-emerald-600",
  Paused: "text-amber-500",
  Suspended: "text-amber-500",
};

/** VMMemoryRow: the VMs' names above (MemoryRowLabel), then their bar and settings. */
function VmRow({ row, onEdit }: { row: VmMemoryRow; onEdit?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  // MemoryRowLabel: one line, "..." and "Show All" when the names do not fit.
  // Measured on the line and on the names (their natural width), whichever changes.
  const namesRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const line = namesRef.current;
    const inner = innerRef.current;
    if (!line || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!expanded) setOverflows(inner.scrollWidth > line.clientWidth + 1);
    });
    ro.observe(line);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [expanded]);

  const figures: [string, number, "min" | "max" | null][] = row.ballooning
    ? [
        ["Minimum memory", row.dynamicMin, "min"],
        ["Maximum memory", row.dynamicMax, "max"],
        ...(row.dynamicMax !== row.staticMax ? [["Static maximum", row.staticMax, null] as [string, number, null]] : []),
      ]
    : [["Memory", row.staticMax, null]];

  return (
    <Card className="gap-0 overflow-hidden py-0 sm:gap-0 sm:py-0">
      <div className="flex items-start gap-3 border-b bg-muted/60 px-4 py-2 text-sm">
        <div
          ref={namesRef}
          className={`min-w-0 flex-1 ${expanded ? "" : "overflow-hidden"}`}
          style={!expanded && overflows ? { maskImage: "linear-gradient(to right, black calc(100% - 3rem), transparent)" } : undefined}
        >
          <div ref={innerRef} className={`flex gap-x-4 gap-y-1.5 ${expanded ? "flex-wrap" : "w-max"}`}>
            {row.vms.map((vm, i) => (
              <span key={vm.ref} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <Monitor className={`h-4 w-4 ${POWER_COLOR[vm.power] ?? "text-zinc-400"}`} />
                {vm.name}
                {i < row.vms.length - 1 ? "," : ""}
              </span>
            ))}
          </div>
        </div>
        {!expanded && overflows && <span className="shrink-0 text-muted-foreground">...</span>}
        {(overflows || expanded) && (
          <button type="button" className="shrink-0 text-primary underline-offset-2 hover:underline" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show Fewer" : "Show All"}
          </button>
        )}
      </div>
      <CardContent className="py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1 px-1">
            <VmBar row={row} />
          </div>
          <div className="w-full shrink-0 text-sm lg:w-64">
            {onEdit && (
              <div className="mb-2 flex justify-end">
                <Button variant="outline" size="sm" onClick={onEdit}>
                  Edit
                </Button>
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-0.5">
              {figures.map(([label, bytes, mark]) => (
                <div key={label} className="contents">
                  <span className="flex w-3 justify-center">{mark && <SliderMark kind={mark} />}</span>
                  <dt>{label}</dt>
                  <dd className="text-right tabular-nums">{memorySize(bytes, true)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * VMShinyBar: the grid up to the static maximum, the memory in use in green
 * with its size at the right end, and -- with ballooning -- a mark below for
 * the minimum and one for the maximum.
 */
function VmBar({ row }: { row: VmMemoryRow }) {
  const [ref, width] = useWidth();
  const max = row.staticMax;
  if (max <= 0) return <div ref={ref} />;
  const at = (bytes: number) => `${Math.min(100, (Math.max(0, bytes) / max) * 100)}%`;
  const used = memorySize(row.used, false);
  const tip = row.vms.length > 1 ? `Current memory usage: ${used} per VM` : `Current memory usage: ${used}`;
  return (
    <div ref={ref} className="pt-7 pb-4">
      <div className="relative">
        <Grid total={max} width={width} />
        <div className="relative flex h-5 overflow-hidden rounded-[5px] border border-zinc-800 dark:border-zinc-600">
          {row.used > 0 && <Segment color={VM_USED} width={at(row.used)} caption={[used]} align="right" tip={tip} />}
          {row.used < max && <Segment color={UNUSED} grow />}
          <Shine />
        </div>
        {row.ballooning && (
          <>
            <span className="absolute top-full -translate-x-full" style={{ left: at(row.dynamicMin) }}>
              <SliderMark kind="min" />
            </span>
            <span className="absolute top-full" style={{ left: at(row.dynamicMax) }}>
              <SliderMark kind="max" />
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function HostRow({ host, onEditControlDomain }: { host: HostMemory; onEditControlDomain?: () => void }) {
  const figures: [string, number][] = [
    ["Total memory", host.total],
    ["Currently used", host.used],
    ["Control domain memory", host.dom0],
    ["Available memory", host.available],
    ["Total max memory", host.totalMax],
  ];
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <p className="flex items-center gap-2 text-sm">
          <Server className="h-4 w-4 text-emerald-600" />
          {host.hostName}
        </p>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1 px-1">
            <HostBar host={host} />
          </div>
          <div className="w-full shrink-0 text-sm lg:w-64">
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
              {figures.map(([label, bytes]) => (
                <div key={label} className="contents">
                  <dt>{label}</dt>
                  <dd className="text-right tabular-nums">
                    {/* HostMemoryControls: the control domain's memory is a link to its settings. */}
                    {label === "Control domain memory" && onEditControlDomain ? (
                      <button type="button" className="text-primary underline underline-offset-2" onClick={onEditControlDomain}>
                        {memorySize(bytes, true)}
                      </button>
                    ) : (
                      memorySize(bytes, true)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-0.5 text-right">({host.overcommit}% of total memory)</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** HostShinyBar: a grid above, then Xen, the control domain, each VM and the free rest. */
function HostBar({ host }: { host: HostMemory }) {
  const [ref, width] = useWidth();

  if (host.total <= 0) return <div ref={ref} />;
  const pct = (bytes: number) => `${(Math.max(0, bytes) / host.total) * 100}%`;
  const usage = (name: string, bytes: number) => `${name}\nCurrent memory usage: ${memorySize(bytes, true)}`;
  const controlDomain = `Control domain on host ${host.hostName}`;
  const usedBytes = Math.max(0, host.xen) + host.dom0 + host.vms.reduce((n, v) => n + v.bytes, 0);

  return (
    <div ref={ref} className="pt-7">
      <div className="relative">
        <Grid total={host.total} width={width} />
        <div className="relative flex h-10 overflow-hidden rounded-[5px] border border-zinc-800 dark:border-zinc-600">
          {host.xen > 0 && <Segment color={XEN} width={pct(host.xen)} caption={[BRAND, memorySize(host.xen, false)]} tip={usage(BRAND, host.xen)} />}
          {host.dom0 > 0 && (
            <Segment color={CONTROL_DOMAIN} width={pct(host.dom0)} caption={[controlDomain, memorySize(host.dom0, false)]} tip={usage(controlDomain, host.dom0)} />
          )}
          {host.vms.map((vm, i) => {
            let tip = usage(vm.name, vm.bytes);
            if (vm.dynamicMin !== undefined && vm.dynamicMax !== undefined) {
              tip += `\nMinimum memory: ${memorySize(vm.dynamicMin, true)}\nMaximum memory: ${memorySize(vm.dynamicMax, true)}`;
              if (vm.staticMax !== undefined) tip += `\nStatic maximum: ${memorySize(vm.staticMax, true)}`;
            }
            return (
              <Segment
                key={vm.vmRef}
                color={VM_COLORS[i % VM_COLORS.length]}
                width={pct(vm.bytes)}
                caption={[vm.name, memorySize(vm.bytes, false)]}
                tip={tip}
              />
            );
          })}
          {usedBytes < host.total && <Segment color={UNUSED} grow />}
          <Shine />
        </div>
      </div>
    </div>
  );
}
