"use client";

import React from "react";
import { useXen } from "@/context/xen-context";
import { useAuth } from "@/context/auth-context";
import { useTask } from "@/context/task-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { HostNetworking } from "@/components/networking/host-networking";
import {
  Server,
  Monitor,
  Power,
  Pause,
  Square,
  CircleDot,
  Cpu,
  MemoryStick,
  ArrowLeft,
  CheckCircle,
  XCircle,
  Terminal,
  Network,
  Wrench,
  Plus,
  ChevronDown,
  RotateCcw,
  ShieldCheck,
  PowerOff,
  PackageCheck,
  Activity,
  CircuitBoard,
} from "lucide-react";
import { GpuTab } from "@/components/gpu/gpu-tab";
import { MemoryTab } from "@/components/memory/memory-tab";
import { StorageTab } from "@/components/host-detail";
import { HardDrive, Unlink } from "lucide-react";
import { RemoveServerDialog, removeBlockedReason } from "@/components/pool/remove-server-dialog";
import { XenUpdatesTab } from "@/components/xen-updates-tab";
import { PerfCharts } from "@/components/perf-charts";
import { VmPowerState, XenVM } from "@/lib/types";
import { CreateVmDialog } from "@/components/create-vm-dialog";

function formatUptime(unixTimestamp: number): string {
  const now = Date.now() / 1000;
  let seconds = Math.floor(now - unixTimestamp);
  if (seconds < 0) seconds = 0;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (parts.length === 0 || (days === 0 && minutes > 0)) parts.push(`${minutes}m`);
  return parts.join(" ");
}

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

// Distinct colors for VM segments in the memory bar
const VM_COLORS = [
  "bg-blue-500",
  "bg-violet-500",
  "bg-cyan-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-pink-500",
  "bg-lime-500",
  "bg-orange-500",
  "bg-emerald-500",
  "bg-fuchsia-500",
];

const VM_COLORS_LIGHT = [
  "bg-blue-400",
  "bg-violet-400",
  "bg-cyan-400",
  "bg-rose-400",
  "bg-amber-400",
  "bg-teal-400",
  "bg-indigo-400",
  "bg-pink-400",
  "bg-lime-400",
  "bg-orange-400",
  "bg-emerald-400",
  "bg-fuchsia-400",
];

interface VmMemorySegment {
  vm: XenVM;
  bytes: number;
  percent: number;
  color: string;
  colorLight: string;
}

interface HostPowerAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  destructive?: boolean;
  separator?: boolean;
  description: string;
}

export function XenHostDetail() {
  const { state, selectXenHost, selectVm, refreshHost, hostMaintenanceEnter, hostMaintenanceExit, adoptHost } = useXen();
  // Remove From Pool (XenCenter): its own dialog, the name typed.
  // Kept with the name it had: the server leaves the pool (and this view) while the job runs.
  const [removing, setRemoving] = React.useState<{ ref: string; name: string; poolName: string } | null>(null);
  const { role } = useAuth();
  const { addTask } = useTask();
  const canAct = role === "admin" || role === "operator";
  const isAdmin = role === "admin";
  const [consoleLoading, setConsoleLoading] = React.useState(false);
  const [createVmOpen, setCreateVmOpen] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<HostPowerAction | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  const hostId = state.selectedHostId;
  const xenHostRef = state.selectedXenHostRef;

  if (!hostId || !xenHostRef) return null;

  const conn = state.connections[hostId];
  if (!conn || conn.status !== "connected") return null;

  const removeDialog = removing && (
    <RemoveServerDialog
      conn={conn}
      hostRef={removing.ref}
      hostName={removing.name}
      poolName={removing.poolName}
      onClose={() => setRemoving(null)}
      onDone={(newHostId) => {
        if (newHostId) void adoptHost(newHostId);
        void refreshHost(hostId);
      }}
    />
  );

  const xenHost = conn.hostRecords[xenHostRef];
  if (!xenHost) return removeDialog || null;

  const pools = Object.values(conn.pools);
  const pool = pools[0];
  const isMaster = pool && pool.master === xenHostRef;

  const allVms = Object.values(conn.vms);
  const residentVms = allVms.filter((vm) => vm.residentOn === xenHostRef);
  const runningVms = residentVms.filter((vm) => vm.powerState === "Running");
  const nonRunningVms = residentVms.filter((vm) => vm.powerState !== "Running");

  const totalMemory = xenHost.memoryTotal;
  const freeMemory = xenHost.memoryFree;
  const usedMemory = totalMemory - freeMemory;
  const memoryPercent =
    totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : 0;

  // Build VM memory segments for running VMs
  const vmSegments: VmMemorySegment[] = runningVms
    .sort((a, b) => b.memoryStaticMax - a.memoryStaticMax)
    .map((vm, i) => ({
      vm,
      bytes: vm.memoryStaticMax,
      percent: totalMemory > 0 ? (vm.memoryStaticMax / totalMemory) * 100 : 0,
      color: VM_COLORS[i % VM_COLORS.length],
      colorLight: VM_COLORS_LIGHT[i % VM_COLORS_LIGHT.length],
    }));

  const vmAllocatedBytes = vmSegments.reduce((sum, s) => sum + s.bytes, 0);
  const overheadBytes = Math.max(0, usedMemory - vmAllocatedBytes);
  const overheadPercent =
    totalMemory > 0 ? (overheadBytes / totalMemory) * 100 : 0;
  const freePercent = totalMemory > 0 ? (freeMemory / totalMemory) * 100 : 0;

  const totalVCpus = runningVms.reduce((sum, vm) => sum + vm.vcpusMax, 0);
  const { socketCount, cpuCount: threadCount } = xenHost.cpuInfo;
  const hostCpuPercent = threadCount > 0 ? Math.round((totalVCpus / threadCount) * 100) : 0;

  async function handleConsole() {
    setConsoleLoading(true);
    try {
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "host_console",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          hostRef: xenHostRef,
        }),
      });
      const data = await res.json();
      if (data.available && data.url) {
        const params = new URLSearchParams({
          consoleUrl: data.url,
          sessionId: conn.session!.sessionRef,
          useSsl: String(conn.host.useSsl),
          label: `Host Console: ${xenHost.nameLabel}`,
        });
        window.open(
          `/console?${params}`,
          "_blank",
          "width=1024,height=768,noopener,noreferrer",
        );
      }
    } catch (err) {
      console.error("Host console fetch failed:", err);
    } finally {
      setConsoleLoading(false);
    }
  }

  const hostCount = Object.keys(conn.hostRecords).length;
  const inMaintenance = xenHost.otherConfig?.MAINTENANCE_MODE === "true";
  const canEnterMaintenance = xenHost.enabled && hostCount > 1;

  function getAvailableHostActions(): HostPowerAction[] {
    const actions: HostPowerAction[] = [];

    if (xenHost.enabled) {
      if (canEnterMaintenance) {
        actions.push({
          key: "maintenance_enter",
          label: "Enter Maintenance Mode",
          icon: <Wrench className="h-4 w-4" />,
          description: `This will disable ${xenHost.nameLabel} and migrate all running VMs to other available hosts.`,
        });
      }
      actions.push({
        key: "restart_toolstack",
        label: "Restart Toolstack",
        icon: <RotateCcw className="h-4 w-4" />,
        description: `The connection to ${xenHost.nameLabel} will be temporarily lost while the toolstack restarts.`,
      });
    } else if (inMaintenance) {
      actions.push({
        key: "maintenance_exit",
        label: "Exit Maintenance Mode",
        icon: <ShieldCheck className="h-4 w-4" />,
        description: `This will re-enable ${xenHost.nameLabel} and allow VMs to run on it again.`,
      });
    }

    actions.push({
      key: "shutdown",
      label: "Shutdown",
      icon: <PowerOff className="h-4 w-4" />,
      destructive: true,
      separator: true,
      description: `This will shut down ${xenHost.nameLabel}. The server will become unreachable until manually powered on.`,
    });
    actions.push({
      key: "reboot",
      label: "Reboot",
      icon: <RotateCcw className="h-4 w-4" />,
      destructive: true,
      description: `This will reboot ${xenHost.nameLabel}. The server will be temporarily unreachable.`,
    });

    return actions;
  }

  const availableHostActions = getAvailableHostActions();

  async function handleHostAction(actionKey: string) {
    setActionLoading(actionKey);
    try {
      switch (actionKey) {
        case "maintenance_enter": {
          const taskRef = await hostMaintenanceEnter(hostId!, xenHostRef!);
          if (taskRef) {
            addTask({
              taskRef,
              hostId: hostId!,
              type: "host_evacuate",
              label: `Evacuating ${xenHost.nameLabel}`,
              description: "Migrating all VMs to other hosts",
            });
          }
          break;
        }
        case "maintenance_exit":
          await hostMaintenanceExit(hostId!, xenHostRef!);
          break;
        case "restart_toolstack":
        case "shutdown":
        case "reboot": {
          const actionMap: Record<string, string> = {
            restart_toolstack: "host_restart_toolstack",
            shutdown: "host_shutdown",
            reboot: "host_reboot",
          };
          await fetch("/api/xen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: actionMap[actionKey],
              host: conn.connectedVia || conn.host.address,
              port: conn.host.port,
              useSsl: conn.host.useSsl,
              sessionRef: conn.session!.sessionRef,
              hostRef: xenHostRef,
            }),
          });
          break;
        }
      }
    } catch (err) {
      console.error("Host action failed:", err);
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-7xl px-3 pb-20 pt-3 sm:px-6 sm:pt-6 md:pb-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              onClick={() => selectXenHost(null)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h2 className="min-w-0 break-words text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {xenHost.nameLabel}
            </h2>
            {isMaster && (
              <Badge variant="outline" className="text-[10px]">
                coordinator
              </Badge>
            )}
            {xenHost.enabled ? (
              <Badge
                variant="outline"
                className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
              >
                Enabled
              </Badge>
            ) : xenHost.otherConfig?.MAINTENANCE_MODE === "true" ? (
              <Badge
                variant="outline"
                className="bg-amber-500/10 text-amber-600 border-amber-500/20"
              >
                Maintenance Mode
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="bg-zinc-500/10 text-zinc-500 border-zinc-500/20"
              >
                Disabled
              </Badge>
            )}
            {canAct && (
              <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
                {canAct && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCreateVmOpen(true)}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    New VM
                  </Button>
                )}
                {isAdmin && xenHost.enabled && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleConsole}
                    disabled={consoleLoading}
                  >
                    <Terminal className="mr-1.5 h-3.5 w-3.5" />
                    {consoleLoading ? "Opening..." : "Console"}
                  </Button>
                )}
                {isAdmin && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actionLoading !== null}
                      >
                        <Power className="mr-1.5 h-3.5 w-3.5" />
                        Power
                        <ChevronDown className="ml-1 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {availableHostActions.map((action) => (
                        <React.Fragment key={action.key}>
                          {action.separator && <DropdownMenuSeparator />}
                          <DropdownMenuItem
                            onClick={() => setPendingAction(action)}
                            className={action.destructive ? "text-red-600" : ""}
                          >
                            {action.icon}
                            <span className="ml-2">{action.label}</span>
                          </DropdownMenuItem>
                        </React.Fragment>
                      ))}
                      {hostCount > 1 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={Boolean(removeBlockedReason(conn, xenHostRef))}
                            title={removeBlockedReason(conn, xenHostRef) ?? undefined}
                            onClick={() =>
                              setRemoving({ ref: xenHostRef, name: xenHost.nameLabel, poolName: pool?.nameLabel || conn.host.name })
                            }
                            className="text-red-600"
                          >
                            <Unlink className="h-4 w-4" />
                            <span className="ml-2">Remove From Pool</span>
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            )}
          </div>
          <p className="mt-1 break-words text-sm text-zinc-500 sm:ml-11">
            {xenHost.address} ({xenHost.hostname})
          </p>
          <p className="break-all font-mono text-xs text-zinc-400 sm:ml-11">
            {xenHost.uuid}
          </p>
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="mb-6">
            <TabsTrigger value="overview" className="gap-2">
              <Server className="h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="memory" className="gap-2">
              <MemoryStick className="h-4 w-4" />
              Memory
            </TabsTrigger>
            <TabsTrigger value="storage" className="gap-2">
              <HardDrive className="h-4 w-4" />
              Storage
            </TabsTrigger>
            <TabsTrigger value="network" className="gap-2">
              <Network className="h-4 w-4" />
              Network
            </TabsTrigger>
            <TabsTrigger value="vms" className="gap-2">
              <Monitor className="h-4 w-4" />
              VMs
            </TabsTrigger>
            <TabsTrigger value="gpu" className="gap-2">
              <CircuitBoard className="h-4 w-4" />
              GPU
            </TabsTrigger>
            <TabsTrigger value="performance" className="gap-2">
              <Activity className="h-4 w-4" />
              Performance
            </TabsTrigger>
            <TabsTrigger value="updates" className="gap-2">
              <PackageCheck className="h-4 w-4" />
              Updates
            </TabsTrigger>
          </TabsList>

          {/* ── Overview Tab ── */}
          <TabsContent value="overview" className="space-y-6">

            {/* Summary Cards */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <Monitor className="h-4 w-4" />
                    VMs
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {residentVms.length}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {runningVms.length} running
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <Cpu className="h-4 w-4" />
                    CPUs
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {totalVCpus} vCPUs
                  </p>
                  <p className="text-xs text-zinc-400">
                    {threadCount > 0
                      ? `of ${threadCount} threads / ${socketCount} ${socketCount === 1 ? "socket" : "sockets"} (${hostCpuPercent}%)`
                      : "Allocated to running VMs"}
                  </p>
                  {threadCount > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-zinc-600 dark:bg-zinc-400 transition-all"
                        style={{ width: `${Math.min(hostCpuPercent, 100)}%` }}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <MemoryStick className="h-4 w-4" />
                    Memory Used
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatBytes(usedMemory)}
                  </p>
                  <p className="text-xs text-zinc-400">
                    of {formatBytes(totalMemory)} ({memoryPercent}%)
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <Server className="h-4 w-4" />
                    Software
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                    {xenHost.softwareVersion?.product_version || "N/A"}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {xenHost.softwareVersion?.product_brand ||
                      xenHost.softwareVersion?.xen ||
                      ""}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Memory Breakdown Bar */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <MemoryStick className="h-4 w-4" />
                  Memory Allocation
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {/* Bar */}
                  <div className="h-8 w-full overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 flex">
                    {vmSegments.map((seg) => (
                      <Tooltip key={seg.vm.ref}>
                        <TooltipTrigger asChild>
                          <div
                            className={`${seg.color} h-full transition-all cursor-pointer hover:opacity-80 border-r border-white/20 dark:border-zinc-900/20`}
                            style={{ width: `${Math.max(seg.percent, 0.5)}%` }}
                            onClick={() => selectVm(seg.vm.ref)}
                          />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="font-medium">{seg.vm.nameLabel}</p>
                          <p className="text-xs text-zinc-400">
                            {formatBytes(seg.bytes)} ({seg.percent.toFixed(1)}%)
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                    {overheadPercent > 0.5 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            className="bg-zinc-400 dark:bg-zinc-500 h-full transition-all border-r border-white/20 dark:border-zinc-900/20"
                            style={{ width: `${overheadPercent}%` }}
                          />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="font-medium">System / Overhead</p>
                          <p className="text-xs text-zinc-400">
                            {formatBytes(overheadBytes)} ({overheadPercent.toFixed(1)}%)
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {/* Free space is the remaining transparent area */}
                  </div>

                  {/* Legend */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {vmSegments.map((seg) => (
                      <button
                        key={seg.vm.ref}
                        onClick={() => selectVm(seg.vm.ref)}
                        className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
                      >
                        <div className={`h-2.5 w-2.5 rounded-sm ${seg.color}`} />
                        <span>{seg.vm.nameLabel}</span>
                        <span className="text-zinc-400">({formatBytes(seg.bytes)})</span>
                      </button>
                    ))}
                    {overheadPercent > 0.5 && (
                      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                        <div className="h-2.5 w-2.5 rounded-sm bg-zinc-400 dark:bg-zinc-500" />
                        <span>System / Overhead</span>
                        <span className="text-zinc-400">({formatBytes(overheadBytes)})</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                      <div className="h-2.5 w-2.5 rounded-sm bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700" />
                      <span>Free</span>
                      <span className="text-zinc-400">({formatBytes(freeMemory)})</span>
                    </div>
                  </div>

                  {/* Totals */}
                  <div className="flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800">
                    <span className="text-xs text-zinc-500">
                      VM Allocated: {formatBytes(vmAllocatedBytes)}
                    </span>
                    <span className="text-xs text-zinc-500">
                      Total: {formatBytes(totalMemory)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Host Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Details</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500 sm:w-44">
                        UUID
                      </TableCell>
                      <TableCell className="whitespace-normal break-all font-mono text-xs">
                        {xenHost.uuid}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Hostname
                      </TableCell>
                      <TableCell>{xenHost.hostname}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Address
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {xenHost.address}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Status
                      </TableCell>
                      <TableCell>
                        {xenHost.enabled ? (
                          <div className="flex items-center gap-1.5 text-emerald-600">
                            <CheckCircle className="h-3.5 w-3.5" />
                            Enabled
                          </div>
                        ) : xenHost.otherConfig?.MAINTENANCE_MODE === "true" ? (
                          <div className="flex items-center gap-1.5 text-amber-600">
                            <Wrench className="h-3.5 w-3.5" />
                            Maintenance Mode
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-zinc-400">
                            <XCircle className="h-3.5 w-3.5" />
                            Disabled
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    {isMaster && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Role
                        </TableCell>
                        <TableCell>Pool Coordinator</TableCell>
                      </TableRow>
                    )}
                    {xenHost.otherConfig?.boot_time && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Uptime
                        </TableCell>
                        <TableCell>
                          {formatUptime(parseFloat(xenHost.otherConfig.boot_time))}
                        </TableCell>
                      </TableRow>
                    )}
                    {xenHost.otherConfig?.agent_start_time && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Toolstack Uptime
                        </TableCell>
                        <TableCell>
                          {formatUptime(parseFloat(xenHost.otherConfig.agent_start_time))}
                        </TableCell>
                      </TableRow>
                    )}
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Memory
                      </TableCell>
                      <TableCell>
                        {formatBytes(usedMemory)} used / {formatBytes(totalMemory)}{" "}
                        total ({memoryPercent}%)
                      </TableCell>
                    </TableRow>
                    {xenHost.cpuInfo.modelname && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          CPU Model
                        </TableCell>
                        <TableCell>{xenHost.cpuInfo.modelname}</TableCell>
                      </TableRow>
                    )}
                    {(xenHost.cpuInfo.socketCount > 0 || xenHost.cpuInfo.cpuCount > 0) && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          CPU Topology
                        </TableCell>
                        <TableCell>
                          {xenHost.cpuInfo.socketCount} {xenHost.cpuInfo.socketCount === 1 ? "socket" : "sockets"} · {xenHost.cpuInfo.cpuCount} threads
                          {xenHost.cpuInfo.speed > 0 && ` · ${(xenHost.cpuInfo.speed / 1000).toFixed(2)} GHz`}
                        </TableCell>
                      </TableRow>
                    )}
                    {xenHost.cpuInfo.vendor && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          CPU Vendor
                        </TableCell>
                        <TableCell>{xenHost.cpuInfo.vendor}</TableCell>
                      </TableRow>
                    )}
                    {xenHost.softwareVersion?.product_brand && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Product
                        </TableCell>
                        <TableCell>
                          {xenHost.softwareVersion.product_brand}{" "}
                          {xenHost.softwareVersion.product_version}
                        </TableCell>
                      </TableRow>
                    )}
                    {xenHost.softwareVersion?.xen && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Xen Version
                        </TableCell>
                        <TableCell>{xenHost.softwareVersion.xen}</TableCell>
                      </TableRow>
                    )}
                    {xenHost.softwareVersion?.linux && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Linux Kernel
                        </TableCell>
                        <TableCell>{xenHost.softwareVersion.linux}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

          </TabsContent>

          {/* ── Network Tab ── */}
          <TabsContent value="network">
            {/* key: another host starts afresh, without the last one's figures. */}
            <HostNetworking key={`${hostId}:${xenHostRef}`} conn={conn} hostRef={xenHostRef} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="memory">
            <MemoryTab key={`${hostId}:${xenHostRef}`} conn={conn} hostRef={xenHostRef} canEdit={canAct} isAdmin={isAdmin} />
          </TabsContent>

          {/* The pool's Storage tab, with the SRs this server sees. */}
          <TabsContent value="storage">
            <StorageTab key={`${hostId}:${xenHostRef}`} conn={conn} hostId={hostId} hostRef={xenHostRef} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="gpu">
            <GpuTab key={`${hostId}:${xenHostRef}`} conn={conn} hostRef={xenHostRef} isAdmin={isAdmin} />
          </TabsContent>

          {/* ── VMs Tab ── */}
          <TabsContent value="vms">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Monitor className="h-4 w-4" />
                  Resident Virtual Machines
                </CardTitle>
              </CardHeader>
              <CardContent>
                {residentVms.length === 0 ? (
                  <p className="py-4 text-center text-sm text-zinc-400">
                    No VMs on this host
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>vCPUs</TableHead>
                        <TableHead>Memory</TableHead>
                        <TableHead>Type</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...runningVms, ...nonRunningVms]
                        .sort((a, b) => {
                          const order = {
                            Running: 0,
                            Paused: 1,
                            Suspended: 2,
                            Halted: 3,
                          };
                          return (
                            order[a.powerState] - order[b.powerState] ||
                            a.nameLabel.localeCompare(b.nameLabel)
                          );
                        })
                        .map((vm) => {
                          const seg = vmSegments.find((s) => s.vm.ref === vm.ref);
                          return (
                            <TableRow
                              key={vm.ref}
                              className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                              onClick={() => selectVm(vm.ref)}
                            >
                              <TableCell>
                                <div className="flex items-center gap-2 font-medium">
                                  {seg && (
                                    <div
                                      className={`h-2.5 w-2.5 rounded-sm shrink-0 ${seg.color}`}
                                    />
                                  )}
                                  {vm.nameLabel}
                                </div>
                              </TableCell>
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
                              <TableCell>
                                {formatBytes(vm.memoryStaticMax)}
                              </TableCell>
                              <TableCell className="text-xs uppercase">
                                {vm.domainType || "N/A"}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="performance">
            <PerfCharts key={`${hostId}:${xenHostRef}`} conn={conn} hostRef={xenHostRef} />
          </TabsContent>

          <TabsContent value="updates">
            <XenUpdatesTab key={`${hostId}:${xenHostRef}`} hostId={hostId} hostRef={xenHostRef} isAdmin={isAdmin} />
          </TabsContent>
        </Tabs>
      </div>

      {removeDialog}

      {/* Host Power Action Confirmation */}
      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.label} &quot;{xenHost.nameLabel}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                pendingAction?.destructive
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : ""
              }
              onClick={() => {
                if (pendingAction) {
                  handleHostAction(pendingAction.key);
                  setPendingAction(null);
                }
              }}
            >
              {pendingAction?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateVmDialog
        open={createVmOpen}
        onOpenChange={setCreateVmOpen}
        hostId={hostId}
        conn={conn}
        hostRecords={Object.values(conn.hostRecords)}
        targetHostRef={xenHostRef}
        onCreated={() => refreshHost(hostId)}
      />
    </div>
  );
}
