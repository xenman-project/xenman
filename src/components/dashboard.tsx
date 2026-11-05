"use client";

import React, { useState } from "react";
import { useXen } from "@/context/xen-context";
import { useAuth } from "@/context/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Server,
  Monitor,
  Power,
  Pause,
  Square,
  CircleDot,
  Cpu,
  MemoryStick,
  Activity,
  HardDrive,
  ChevronDown,
  ChevronRight,
  Boxes,
  Gauge,
  List as ListIcon,
} from "lucide-react";
import { VmPowerState } from "@/lib/types";
import { XenUpdatesOverview } from "@/components/xen-updates-overview";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

const powerStateIcon: Record<VmPowerState, React.ReactNode> = {
  Running: <Power className="h-3 w-3 text-emerald-500" />,
  Halted: <Square className="h-3 w-3 text-zinc-400" />,
  Paused: <Pause className="h-3 w-3 text-amber-500" />,
  Suspended: <CircleDot className="h-3 w-3 text-amber-500" />,
};

const powerStateBadge: Record<VmPowerState, string> = {
  Running: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  Halted: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
  Paused: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  Suspended: "bg-amber-500/10 text-amber-600 border-amber-500/20",
};

// The donut's colours.
const STATE_COLORS = {
  running: "#23a3b4",
  halted: "#a98ae0",
  paused: "#b9a227",
  // Disconnected, unregistered.
  bad: "#c0459b",
  grey: "#a1a1aa",
};

/** What the Resources tile's donut shows: the row clicked. */
type ResourceKind = "pools" | "hosts" | "vms" | "srs";

/** A tile on the start page: icon and title on top. */
function DashboardTile({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0 sm:gap-0 sm:py-0">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Icon className="h-[18px] w-[18px] text-zinc-800 dark:text-zinc-200" />
        <h3 className="text-[15px] text-zinc-900 dark:text-zinc-100">{title}</h3>
      </div>
      <div className="flex-1 px-4 pb-4">{children}</div>
    </Card>
  );
}

function Donut({ total, label, parts }: { total: number; label: string; parts: { value: number; color: string }[] }) {
  const r = 30;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox="0 0 80 80" className="h-28 w-28">
      <g transform="rotate(-90 40 40)">
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="8" className="stroke-zinc-100 dark:stroke-zinc-800" />
        {total > 0 &&
          parts
            .filter((p) => p.value > 0)
            .map((p, i) => {
              const len = (p.value / total) * circumference;
              const el = (
                <circle
                  key={i}
                  cx="40"
                  cy="40"
                  r={r}
                  fill="none"
                  stroke={p.color}
                  strokeWidth="8"
                  strokeDasharray={`${len} ${circumference - len}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += len;
              return el;
            })}
      </g>
      <text x="40" y="40" textAnchor="middle" className="fill-zinc-900 text-[15px] dark:fill-zinc-100">
        {total}
      </text>
      <text x="40" y="51" textAnchor="middle" className="fill-zinc-500 text-[8px]">
        {label}
      </text>
    </svg>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function ResourceRow({
  icon: Icon,
  label,
  count,
  selected,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full items-center gap-2.5 rounded-md border px-2 py-2 text-left text-[13px] transition-colors ${
        selected
          ? "border-[var(--shell-link)] bg-sky-50 font-medium text-zinc-900 dark:bg-sky-500/10 dark:text-zinc-100"
          : "border-transparent text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
      }`}
    >
      <Icon className="h-4 w-4 text-[var(--shell-link)]" />
      <span className="flex-1 truncate">{label}</span>
      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
        {count}
      </span>
    </button>
  );
}

function CapacityRow({
  icon: Icon,
  label,
  value,
  detail,
  percent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
  percent: number | null;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
        <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <Icon className="h-3.5 w-3.5 text-zinc-500" />
          {label}
        </span>
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          {value}
          {percent !== null && <span className="ml-1.5 font-normal text-zinc-500">{percent}%</span>}
        </span>
      </div>
      {percent !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className={`h-full rounded-full transition-all ${
              percent > 90 ? "bg-red-500" : percent > 75 ? "bg-amber-500" : "bg-[#1f5ef0]"
            }`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      )}
      <p className="mt-1 text-[11px] text-zinc-500">{detail}</p>
    </div>
  );
}

export function Dashboard() {
  const { state, selectHost, selectVm } = useXen();
  const { role } = useAuth();
  const [storageOpen, setStorageOpen] = useState(false);
  const [vmsOpen, setVmsOpen] = useState(false);
  const [resource, setResource] = useState<ResourceKind>("vms");

  const connectedHosts = Object.values(state.connections).filter(
    (c) => c.status === "connected"
  );

  const allVms = connectedHosts.flatMap((c) => Object.values(c.vms));
  const allXenHosts = connectedHosts.flatMap((c) => Object.values(c.hostRecords));

  const runningVms = allVms.filter((vm) => vm.powerState === "Running").length;
  const haltedVms = allVms.filter((vm) => vm.powerState === "Halted").length;

  const allSrs = connectedHosts.flatMap((c) =>
    Object.values(c.srs).map((sr) => ({ ...sr, poolName: c.host.name }))
  ).filter((sr) => sr.physicalSize > 0 && sr.type !== "udev" && sr.type !== "tmpfs");

  const totalMemory = allXenHosts.reduce((sum, h) => sum + h.memoryTotal, 0);
  const freeMemory = allXenHosts.reduce((sum, h) => sum + h.memoryFree, 0);
  const totalCpus = allVms.reduce((sum, vm) => sum + (vm.powerState === "Running" ? vm.vcpusMax : 0), 0);
  const totalSockets = allXenHosts.reduce((sum, h) => sum + h.cpuInfo.socketCount, 0);
  const totalThreads = allXenHosts.reduce((sum, h) => sum + h.cpuInfo.cpuCount, 0);
  const cpuPercent = totalThreads > 0 ? Math.round((totalCpus / totalThreads) * 100) : 0;
  const totalStorage = allSrs.reduce((sum, sr) => sum + sr.physicalSize, 0);
  const usedStorage = allSrs.reduce((sum, sr) => sum + sr.physicalUtilisation, 0);
  const storagePercent = totalStorage > 0 ? Math.round((usedStorage / totalStorage) * 100) : 0;

  if (connectedHosts.length === 0) {
    // Nothing assigned is a different situation from nothing connected: the
    // user cannot act on it and should be told why rather than pointed at
    // Settings, which they may not even be allowed to change.
    const noPoolsAssigned = state.hosts.length === 0 && role !== "admin";
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-sm text-center">
          <Activity className="mx-auto mb-3 h-12 w-12 text-zinc-200 dark:text-zinc-700" />
          <h2 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">
            {noPoolsAssigned ? "No Pools Assigned" : "No Connected Hosts"}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            {noPoolsAssigned
              ? "Your account has no pool access yet. Ask an administrator to assign you a pool."
              : "Connect to a host from the sidebar or add one in Settings"}
          </p>
        </div>
      </div>
    );
  }

  const pausedVms = allVms.filter((vm) => vm.powerState === "Paused" || vm.powerState === "Suspended").length;

  // The donut for each row of the Resources tile.
  const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  const poolStates = state.hosts.map((h) => state.connections[h.id]?.status ?? "disconnected");
  const srPercent = (sr: (typeof allSrs)[number]) => (sr.physicalSize > 0 ? (sr.physicalUtilisation / sr.physicalSize) * 100 : 0);
  const breakdown: Record<ResourceKind, { total: number; label: [string, string]; parts: { label: string; value: number; color: string; always?: boolean }[] }> = {
    pools: {
      total: poolStates.length,
      label: ["Pool", "Pools"],
      parts: [
        { label: "Connected", value: count(poolStates, (x) => x === "connected"), color: STATE_COLORS.running, always: true },
        { label: "Connecting", value: count(poolStates, (x) => x === "connecting"), color: STATE_COLORS.paused },
        { label: "Error", value: count(poolStates, (x) => x === "error"), color: STATE_COLORS.bad },
        { label: "Disconnected", value: count(poolStates, (x) => x === "disconnected"), color: STATE_COLORS.grey },
      ],
    },
    hosts: {
      total: allXenHosts.length,
      label: ["Host", "Hosts"],
      parts: [
        { label: "Enabled", value: count(allXenHosts, (h) => h.enabled), color: STATE_COLORS.running, always: true },
        { label: "Maintenance mode", value: count(allXenHosts, (h) => !h.enabled && h.otherConfig?.MAINTENANCE_MODE === "true"), color: STATE_COLORS.paused },
        { label: "Disabled", value: count(allXenHosts, (h) => !h.enabled && h.otherConfig?.MAINTENANCE_MODE !== "true"), color: STATE_COLORS.grey },
      ],
    },
    vms: {
      total: allVms.length,
      label: ["VM", "VMs"],
      parts: [
        { label: "Running", value: runningVms, color: STATE_COLORS.running, always: true },
        { label: "Halted", value: haltedVms, color: STATE_COLORS.halted, always: true },
        { label: "Paused", value: pausedVms, color: STATE_COLORS.paused },
      ],
    },
    // By how full they are, at the Capacity tile's thresholds.
    srs: {
      total: allSrs.length,
      label: ["SR", "SRs"],
      parts: [
        { label: "Up to 75% used", value: count(allSrs, (sr) => srPercent(sr) <= 75), color: STATE_COLORS.running, always: true },
        { label: "75–90% used", value: count(allSrs, (sr) => srPercent(sr) > 75 && srPercent(sr) <= 90), color: STATE_COLORS.paused },
        { label: "Over 90% used", value: count(allSrs, (sr) => srPercent(sr) > 90), color: STATE_COLORS.bad },
      ],
    },
  };
  const shown = breakdown[resource];
  const memoryPercent = totalMemory > 0 ? Math.round(((totalMemory - freeMemory) / totalMemory) * 100) : 0;

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-7xl px-3 pb-20 pt-3 sm:px-6 sm:pt-6 md:pb-6">
        <div className="mb-4 grid gap-4 lg:grid-cols-3">
          {/* Resources: what there is. */}
          <DashboardTile icon={ListIcon} title="Resources">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="flex shrink-0 flex-col items-center gap-3">
                <Donut total={shown.total} label={shown.label[shown.total === 1 ? 0 : 1]} parts={shown.parts} />
                <div className="flex flex-col gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                  {shown.parts
                    .filter((part) => part.always || part.value > 0)
                    .map((part) => (
                      <Legend key={part.label} color={part.color} label={`${part.label} (${part.value})`} />
                    ))}
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <ResourceRow icon={Boxes} label="Pools" count={breakdown.pools.total} selected={resource === "pools"} onSelect={() => setResource("pools")} />
                <ResourceRow icon={Server} label="Hosts" count={allXenHosts.length} selected={resource === "hosts"} onSelect={() => setResource("hosts")} />
                <ResourceRow icon={Monitor} label="Virtual machines" count={allVms.length} selected={resource === "vms"} onSelect={() => setResource("vms")} />
                <ResourceRow icon={HardDrive} label="Storage repos" count={allSrs.length} selected={resource === "srs"} onSelect={() => setResource("srs")} />
              </div>
            </div>
          </DashboardTile>

          {/* Capacity: how full it is. */}
          <DashboardTile icon={Gauge} title="Capacity">
            <div className="space-y-4">
              <CapacityRow
                icon={Cpu}
                label="vCPUs"
                value={`${totalCpus} vCPUs`}
                detail={
                  totalThreads > 0
                    ? `of ${totalThreads} threads / ${totalSockets} ${totalSockets === 1 ? "socket" : "sockets"}`
                    : "Allocated to running VMs"
                }
                percent={totalThreads > 0 ? cpuPercent : null}
              />
              <CapacityRow
                icon={MemoryStick}
                label="Memory"
                value={formatBytes(totalMemory - freeMemory)}
                detail={`of ${formatBytes(totalMemory)} total`}
                percent={totalMemory > 0 ? memoryPercent : null}
              />
              <CapacityRow
                icon={HardDrive}
                label="Storage"
                value={formatBytes(usedStorage)}
                detail={`of ${formatBytes(totalStorage)} total`}
                percent={totalStorage > 0 ? storagePercent : null}
              />
            </div>
          </DashboardTile>

          {/* Pools: each connection and its state. */}
          <DashboardTile icon={Boxes} title="Pools">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-7 px-1 text-[11px]">Name</TableHead>
                  <TableHead className="h-7 px-1 text-[11px]">Hosts</TableHead>
                  <TableHead className="h-7 px-1 text-[11px]">VMs</TableHead>
                  <TableHead className="h-7 px-1 text-[11px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...state.hosts]
                  .map((h) => {
                    const c = state.connections[h.id];
                    const name = (c?.status === "connected" ? Object.values(c.pools)[0]?.nameLabel : null) || h.name;
                    return { h, c, name };
                  })
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(({ h, c, name }) => {
                    const connected = c?.status === "connected";
                    return (
                      <TableRow
                        key={h.id}
                        className="cursor-pointer text-xs"
                        onClick={() => selectHost(h.id)}
                      >
                        <TableCell className="max-w-[10rem] truncate px-1 py-1.5 text-[var(--shell-link)]">{name}</TableCell>
                        <TableCell className="px-1 py-1.5">{connected ? Object.keys(c.hostRecords).length : "–"}</TableCell>
                        <TableCell className="px-1 py-1.5">{connected ? Object.keys(c.vms).length : "–"}</TableCell>
                        <TableCell className="px-1 py-1.5">
                          <span className="flex items-center gap-1.5">
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                connected
                                  ? "bg-emerald-500"
                                  : c?.status === "connecting"
                                    ? "animate-pulse bg-amber-500"
                                    : c?.status === "error"
                                      ? "bg-red-500"
                                      : "bg-zinc-300 dark:bg-zinc-600"
                              }`}
                            />
                            {connected
                              ? "Active"
                              : c?.status === "connecting"
                                ? "Connecting"
                                : c?.status === "error"
                                  ? "Error"
                                  : "Offline"}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </DashboardTile>
        </div>

        {/* Every pool's update state; renders nothing without pools. */}
        <XenUpdatesOverview />

        {/* Storage Card */}
        {allSrs.length > 0 && (
          <Card className="mb-6">
            <CardHeader
              className="cursor-pointer"
              onClick={() => setStorageOpen((o) => !o)}
            >
              <CardTitle className="flex items-center justify-between text-sm font-medium">
                <span className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4" />
                  Storage Repositories
                </span>
                {storageOpen ? (
                  <ChevronDown className="h-4 w-4 text-zinc-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-zinc-400" />
                )}
              </CardTitle>
            </CardHeader>
            {storageOpen && <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Pool</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Usage</TableHead>
                    <TableHead>Size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allSrs
                    .sort((a, b) => a.nameLabel.localeCompare(b.nameLabel))
                    .map((sr) => {
                      const usedPct =
                        sr.physicalSize > 0
                          ? Math.round((sr.physicalUtilisation / sr.physicalSize) * 100)
                          : 0;
                      return (
                        <TableRow key={sr.ref}>
                          <TableCell className="font-medium">
                            {sr.nameLabel}
                            {sr.nameDescription && (
                              <p className="text-[11px] text-zinc-400 truncate max-w-xs">
                                {sr.nameDescription}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-zinc-500">
                            {sr.poolName}
                          </TableCell>
                          <TableCell className="text-xs uppercase text-zinc-500">
                            {sr.type}
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <span className="text-xs">
                                {formatBytes(sr.physicalUtilisation)} / {formatBytes(sr.physicalSize)}
                              </span>
                              <div className="h-1 w-20 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                                <div
                                  className={`h-full rounded-full transition-all ${
                                    usedPct > 90
                                      ? "bg-red-500"
                                      : usedPct > 75
                                        ? "bg-amber-500"
                                        : "bg-zinc-500"
                                  }`}
                                  style={{ width: `${usedPct}%` }}
                                />
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-zinc-500">
                            {formatBytes(sr.physicalSize)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </CardContent>}
          </Card>
        )}

        {/* VM Table */}
        <Card>
          <CardHeader
            className="cursor-pointer"
            onClick={() => setVmsOpen((o) => !o)}
          >
            <CardTitle className="flex items-center justify-between text-sm font-medium">
              <span>All Virtual Machines</span>
              {vmsOpen ? (
                <ChevronDown className="h-4 w-4 text-zinc-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-zinc-400" />
              )}
            </CardTitle>
          </CardHeader>
          {vmsOpen && <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>vCPUs</TableHead>
                  <TableHead>Memory</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Host</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allVms
                  .sort((a, b) => {
                    const order = { Running: 0, Paused: 1, Suspended: 2, Halted: 3 };
                    return order[a.powerState] - order[b.powerState] || a.nameLabel.localeCompare(b.nameLabel);
                  })
                  .map((vm) => {
                    const parentConn = connectedHosts.find((c) => c.vms[vm.ref]);
                    const hostRecord = parentConn?.hostRecords[vm.residentOn];
                    return (
                      <TableRow
                        key={vm.ref}
                        className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                        onClick={() => {
                          if (parentConn) {
                            selectHost(parentConn.host.id);
                            selectVm(vm.ref);
                          }
                        }}
                      >
                        <TableCell className="font-medium">{vm.nameLabel}</TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={`${powerStateBadge[vm.powerState]} gap-1`}
                          >
                            {powerStateIcon[vm.powerState]}
                            {vm.powerState}
                          </Badge>
                        </TableCell>
                        <TableCell>{vm.vcpusMax}</TableCell>
                        <TableCell>{formatBytes(vm.memoryStaticMax)}</TableCell>
                        <TableCell className="uppercase text-xs">{vm.domainType || "N/A"}</TableCell>
                        <TableCell className="text-zinc-500">
                          {hostRecord?.nameLabel || (vm.powerState === "Halted" ? "-" : "Unknown")}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </CardContent>}
        </Card>
      </div>
    </div>
  );
}
