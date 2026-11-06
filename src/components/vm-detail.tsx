"use client";

import React from "react";
import { useXen } from "@/context/xen-context";
import { useAuth } from "@/context/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PerfCharts } from "@/components/perf-charts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Play,
  Square,
  RotateCcw,
  Pause,
  CircleDot,
  Power,
  ChevronDown,
  Monitor,
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  Tag,
  Info,
  ArrowLeft,
  Terminal,
  Trash2,
  Download,
  Loader2,
  Camera,
  RotateCw,
  BrainCircuit,
  Copy,
  LayoutTemplate,
  MoreHorizontal,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { VmPowerState } from "@/lib/types";
import { CheckCircle, XCircle, Settings, MonitorUp } from "lucide-react";
import { downloadRdpFile, rdpAddress } from "@/lib/rdp-file";
import { VmSettingsDialog } from "@/components/vm-settings-dialog";
import { MemoryTab } from "@/components/memory/memory-tab";
import { ConvertToTemplateDialog, CopyVmDialog, SnapshotTemplateDialog } from "@/components/vm/copy-vm-dialog";
import { useDates } from "@/context/date-format-context";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function parseXenTimestamp(ts: string): number {
  // XenServer format: "20230101T12:00:00Z" (yyyyMMddTHH:mm:ssZ) — no dashes in date
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})Z?$/);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  // Fallback for compact format without colons: "20230101T120000Z"
  const m2 = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (m2) return Date.parse(`${m2[1]}-${m2[2]}-${m2[3]}T${m2[4]}:${m2[5]}:${m2[6]}Z`);
  return Date.parse(ts);
}

function formatUptime(isoTimestamp: string): string {
  const start = parseXenTimestamp(isoTimestamp);
  if (isNaN(start)) return "—";
  let seconds = Math.floor((Date.now() - start) / 1000);
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

const powerStateColor: Record<VmPowerState, string> = {
  Running: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  Halted: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
  Paused: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  Suspended: "bg-amber-500/10 text-amber-600 border-amber-500/20",
};

interface VmDisk {
  vbd: {
    ref: string;
    device: string;
    type: string;
    mode: string;
    currentlyAttached: boolean;
  };
  vdi: {
    ref: string;
    uuid: string;
    nameLabel: string;
    virtualSize: number;
    physicalUtilisation: number;
    type: string;
  } | null;
  sr: {
    ref: string;
    nameLabel: string;
    type: string;
  } | null;
}

interface VmNic {
  vif: {
    ref: string;
    device: string;
    mac: string;
    currentlyAttached: boolean;
  };
  network: {
    ref: string;
    nameLabel: string;
    bridge: string;
  } | null;
}

/**
 * The selected VM, once its pool is connected. The checks come first and the
 * view (with all its hooks) only after them, so the hooks run in the same
 * order on every render -- also when the connection drops in between.
 */
export function VmDetail() {
  const { state } = useXen();
  const hostId = state.selectedHostId;
  const vmRef = state.selectedVmRef;

  if (!hostId || !vmRef) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Monitor className="mx-auto mb-3 h-12 w-12 text-zinc-200 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">Select a VM to view details</p>
        </div>
      </div>
    );
  }

  const conn = state.connections[hostId];
  if (!conn || conn.status !== "connected" || !conn.vms[vmRef]) return null;

  return <VmDetailView hostId={hostId} vmRef={vmRef} />;
}

function VmDetailView({ hostId, vmRef }: { hostId: string; vmRef: string }) {
  const { state, vmPowerAction, selectVm, refreshHost } = useXen();
  const { role } = useAuth();
  const dates = useDates();
  const canAct = role === "admin" || role === "operator";
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [consoleLoading, setConsoleLoading] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<PowerAction | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const [deleteLoading, setDeleteLoading] = React.useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = React.useState("");
  const [disks, setDisks] = React.useState<VmDisk[]>([]);
  const [disksLoading, setDisksLoading] = React.useState(false);
  const [disksLoaded, setDisksLoaded] = React.useState<string | null>(null);
  const [nics, setNics] = React.useState<VmNic[]>([]);
  const [nicsLoading, setNicsLoading] = React.useState(false);
  const [nicsLoaded, setNicsLoaded] = React.useState<string | null>(null);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exportDir, setExportDir] = React.useState("");
  const [exportLoading, setExportLoading] = React.useState(false);
  const [exportJobId, setExportJobId] = React.useState<string | null>(null);
  const [exportStatus, setExportStatus] = React.useState<"running" | "success" | "failure" | null>(null);
  const [exportTargetPath, setExportTargetPath] = React.useState<string | null>(null);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [vdiExportOpen, setVdiExportOpen] = React.useState(false);
  const [vdiExportDir, setVdiExportDir] = React.useState("");
  const [vdiExportDisk, setVdiExportDisk] = React.useState<{ uuid: string; name: string } | null>(null);
  const [vdiExportLoading, setVdiExportLoading] = React.useState(false);
  const [vdiExportJobId, setVdiExportJobId] = React.useState<string | null>(null);
  const [vdiExportStatus, setVdiExportStatus] = React.useState<"running" | "success" | "failure" | null>(null);
  const [vdiExportTargetPath, setVdiExportTargetPath] = React.useState<string | null>(null);
  const [vdiExportError, setVdiExportError] = React.useState<string | null>(null);

  // Snapshots
  interface SnapshotInfo {
    ref: string; uuid: string; nameLabel: string; nameDescription: string;
    snapshotTime: string; hasMemory: boolean;
  }
  const [snapshots, setSnapshots] = React.useState<SnapshotInfo[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = React.useState(false);
  const [snapshotsLoaded, setSnapshotsLoaded] = React.useState<string | null>(null);
  const [snapshotCreateOpen, setSnapshotCreateOpen] = React.useState(false);
  const [snapshotName, setSnapshotName] = React.useState("");
  const [snapshotDescription, setSnapshotDescription] = React.useState("");
  const [snapshotWithMemory, setSnapshotWithMemory] = React.useState(false);
  const [snapshotCreating, setSnapshotCreating] = React.useState(false);
  const [snapshotCreateError, setSnapshotCreateError] = React.useState("");
  const [snapshotActionLoading, setSnapshotActionLoading] = React.useState<string | null>(null);
  const [snapshotRevertConfirm, setSnapshotRevertConfirm] = React.useState<SnapshotInfo | null>(null);
  const [snapshotDeleteConfirm, setSnapshotDeleteConfirm] = React.useState<SnapshotInfo | null>(null);
  // XenCenter's Copy VM, Convert to Template, Create Template From Snapshot.
  const [copyOpen, setCopyOpen] = React.useState(false);
  const [convertOpen, setConvertOpen] = React.useState(false);
  const [snapshotTemplate, setSnapshotTemplate] = React.useState<SnapshotInfo | null>(null);

  const [guestOsVersion, setGuestOsVersion] = React.useState<string | null>(null);
  const [guestIpAddresses, setGuestIpAddresses] = React.useState<string[]>([]);
  const [guestRdpEnabled, setGuestRdpEnabled] = React.useState<boolean | null>(null);
  const [guestMetricsLoaded, setGuestMetricsLoaded] = React.useState<string | null>(null);

  // VmDetail renders this only for a connected pool that has the VM.
  const conn = state.connections[hostId];
  const vm = conn.vms[vmRef];

  const hostRecord = conn.hostRecords[vm.residentOn];
  const affinityRecord = vm.affinity && vm.affinity !== "OpaqueRef:NULL" ? conn.hostRecords[vm.affinity] : null;

  React.useEffect(() => {
    if (disksLoaded === vmRef) return;
    setDisksLoading(true);
    fetch("/api/xen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "vm_disks",
        host: conn.connectedVia || conn.host.address,
        port: conn.host.port,
        useSsl: conn.host.useSsl,
        sessionRef: conn.session!.sessionRef,
        vmRef,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        setDisks(data.disks || []);
        setDisksLoaded(vmRef);
      })
      .catch(() => setDisks([]))
      .finally(() => setDisksLoading(false));
  }, [vmRef, disksLoaded, conn]);

  React.useEffect(() => {
    if (nicsLoaded === vmRef) return;
    setNicsLoading(true);
    fetch("/api/xen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "vm_nics",
        host: conn.connectedVia || conn.host.address,
        port: conn.host.port,
        useSsl: conn.host.useSsl,
        sessionRef: conn.session!.sessionRef,
        vmRef,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        setNics(data.nics || []);
        setNicsLoaded(vmRef);
      })
      .catch(() => setNics([]))
      .finally(() => setNicsLoading(false));
  }, [vmRef, nicsLoaded, conn]);

  React.useEffect(() => {
    if (guestMetricsLoaded === vmRef) return;
    fetch("/api/xen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "vm_guest_metrics",
        host: conn.connectedVia || conn.host.address,
        port: conn.host.port,
        useSsl: conn.host.useSsl,
        sessionRef: conn.session!.sessionRef,
        vmRef,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        setGuestOsVersion(data.osVersion || null);
        setGuestIpAddresses(data.ipAddresses || []);
        setGuestRdpEnabled(data.rdpEnabled ?? null);
        setGuestMetricsLoaded(vmRef);
      })
      .catch(() => setGuestMetricsLoaded(vmRef));
  }, [vmRef, guestMetricsLoaded, conn]);

  function loadSnapshots() {
    setSnapshotsLoading(true);
    fetch("/api/xen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "vm_snapshots",
        host: conn.connectedVia || conn.host.address,
        port: conn.host.port,
        useSsl: conn.host.useSsl,
        sessionRef: conn.session!.sessionRef,
        vmRef,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        setSnapshots(data.snapshots || []);
        setSnapshotsLoaded(vmRef);
      })
      .catch(() => setSnapshots([]))
      .finally(() => setSnapshotsLoading(false));
  }

  React.useEffect(() => {
    if (snapshotsLoaded === vmRef) return;
    loadSnapshots();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmRef, snapshotsLoaded]);

  async function handleSnapshotCreate() {
    if (!snapshotName.trim()) return;
    setSnapshotCreating(true);
    setSnapshotCreateError("");
    try {
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_snapshot_create",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          vmRef,
          snapshotName: snapshotName.trim(),
          snapshotDescription: snapshotDescription.trim(),
          withMemory: snapshotWithMemory,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Snapshot failed");
      setSnapshotCreateOpen(false);
      setSnapshotName("");
      setSnapshotDescription("");
      setSnapshotWithMemory(false);
      setSnapshotsLoaded(null); // reload
    } catch (err) {
      setSnapshotCreateError(err instanceof Error ? err.message : "Snapshot failed");
    } finally {
      setSnapshotCreating(false);
    }
  }

  async function handleSnapshotRevert(snap: { ref: string }) {
    setSnapshotActionLoading(snap.ref);
    try {
      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_snapshot_revert",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          snapshotRef: snap.ref,
        }),
      });
      setSnapshotsLoaded(null);
      refreshHost(hostId!);
    } catch (err) {
      console.error("Revert failed:", err);
    } finally {
      setSnapshotActionLoading(null);
      setSnapshotRevertConfirm(null);
    }
  }

  async function handleSnapshotDelete(snap: { ref: string }) {
    setSnapshotActionLoading(snap.ref);
    try {
      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_snapshot_delete",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          snapshotRef: snap.ref,
        }),
      });
      setSnapshotsLoaded(null);
    } catch (err) {
      console.error("Delete snapshot failed:", err);
    } finally {
      setSnapshotActionLoading(null);
      setSnapshotDeleteConfirm(null);
    }
  }

  async function handlePowerAction(action: string) {
    setActionLoading(action);
    try {
      await vmPowerAction(hostId!, vmRef!, action);
    } catch (err) {
      console.error("Power action failed:", err);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleConsole() {
    setConsoleLoading(true);
    try {
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_console",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          vmRef,
        }),
      });
      const data = await res.json();
      if (data.available && data.url) {
        const params = new URLSearchParams({
          consoleUrl: data.url,
          sessionId: conn.session!.sessionRef,
          useSsl: String(conn.host.useSsl),
          label: `Console: ${vm.nameLabel}`,
          host: conn.connectedVia || conn.host.address,
          port: String(conn.host.port),
          vmRef: vmRef!,
        });
        window.open(
          `/console?${params}`,
          "_blank",
          "width=1024,height=768,noopener,noreferrer",
        );
      }
    } catch (err) {
      console.error("Console fetch failed:", err);
    } finally {
      setConsoleLoading(false);
    }
  }

  async function handleDeleteVm() {
    setDeleteLoading(true);
    try {
      // Force shutdown if not halted
      if (vm.powerState !== "Halted") {
        await vmPowerAction(hostId!, vmRef!, "hard_shutdown");
        // Wait briefly for shutdown to complete
        await new Promise((r) => setTimeout(r, 2000));
      }
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_delete",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          vmRef,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Delete failed");
      }
      selectVm(null);
      refreshHost(hostId!);
    } catch (err) {
      console.error("Delete VM failed:", err);
    } finally {
      setDeleteLoading(false);
      setDeleteConfirmOpen(false);
    }
  }

  async function handleExport() {
    if (!exportDir.trim()) return;
    setExportLoading(true);
    setExportError(null);
    setExportStatus(null);
    setExportJobId(null);
    setExportTargetPath(null);
    try {
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_export_ssh",
          hostId: hostId,
          sshHost: conn.connectedVia || conn.host.address,
          vmUuid: vm.uuid,
          vmName: vm.nameLabel,
          exportDir: exportDir.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Export failed");
      setExportJobId(data.jobId);
      setExportTargetPath(data.targetPath);
      setExportStatus("running");
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportLoading(false);
    }
  }

  async function handleVdiExport() {
    if (!vdiExportDir.trim() || !vdiExportDisk) return;
    setVdiExportLoading(true);
    setVdiExportError(null);
    setVdiExportStatus(null);
    setVdiExportJobId(null);
    setVdiExportTargetPath(null);
    try {
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vdi_export_ssh",
          hostId: hostId,
          sshHost: conn.connectedVia || conn.host.address,
          vdiUuid: vdiExportDisk.uuid,
          vdiName: vdiExportDisk.name,
          exportDir: vdiExportDir.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Export failed");
      setVdiExportJobId(data.jobId);
      setVdiExportTargetPath(data.targetPath);
      setVdiExportStatus("running");
    } catch (err) {
      setVdiExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setVdiExportLoading(false);
    }
  }

  // Poll VDI export job status
  React.useEffect(() => {
    if (!vdiExportJobId || vdiExportStatus !== "running") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/xen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "vm_export_status", jobId: vdiExportJobId }),
        });
        const data = await res.json();
        if (data.status === "success") {
          setVdiExportStatus("success");
          clearInterval(interval);
        } else if (data.status === "failure") {
          setVdiExportStatus("failure");
          setVdiExportError(data.error || "Export failed");
          clearInterval(interval);
        }
      } catch {
        // keep polling
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [vdiExportJobId, vdiExportStatus]);

  // Poll export job status
  React.useEffect(() => {
    if (!exportJobId || exportStatus !== "running") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/xen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "vm_export_status", jobId: exportJobId }),
        });
        const data = await res.json();
        if (data.status === "success") {
          setExportStatus("success");
          clearInterval(interval);
        } else if (data.status === "failure") {
          setExportStatus("failure");
          setExportError(data.error || "Export failed");
          clearInterval(interval);
        }
      } catch {
        // keep polling
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [exportJobId, exportStatus]);

  const availableActions = getAvailableActions(vm.powerState);

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-7xl px-3 pb-20 pt-3 sm:px-6 sm:pt-6 md:pb-6">
        {/* VM Header */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                onClick={() => selectVm(null)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <h2 className="min-w-0 break-words text-xl font-semibold text-zinc-900 dark:text-zinc-100">
                {vm.nameLabel}
              </h2>
              <Badge
                variant="outline"
                className={`${powerStateColor[vm.powerState]}`}
              >
                {vm.powerState}
              </Badge>
            </div>
            {vm.nameDescription && (
              <p className="mt-1 break-words text-sm text-zinc-500">{vm.nameDescription}</p>
            )}
            <p className="mt-1 break-all font-mono text-xs text-zinc-400">{vm.uuid}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {canAct && (
              <>
                {/* Console */}
                {vm.powerState === "Running" && (
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

                {/* Remote Desktop: a .rdp file with the address the VM tools report */}
                {vm.powerState === "Running" && rdpAddress(guestIpAddresses) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => downloadRdpFile(vm.nameLabel, rdpAddress(guestIpAddresses)!)}
                    title={
                      `Remote Desktop to ${rdpAddress(guestIpAddresses)} — opens in this computer's Remote Desktop client.` +
                      (guestRdpEnabled === false ? "\nThe VM's tools report Remote Desktop as switched off." : "")
                    }
                  >
                    <MonitorUp className="mr-1.5 h-3.5 w-3.5" />
                    Remote Desktop
                  </Button>
                )}

                {/* Quick Actions */}
                {vm.powerState === "Halted" && (
                  <Button
                    size="sm"
                    onClick={() =>
                      setPendingAction({
                        key: "start",
                        label: "Start",
                        icon: <Play className="h-4 w-4" />,
                      })
                    }
                    disabled={actionLoading !== null}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                    Start
                  </Button>
                )}
                {vm.powerState === "Running" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setPendingAction({
                        key: "clean_shutdown",
                        label: "Shutdown",
                        icon: <Square className="h-4 w-4" />,
                      })
                    }
                    disabled={actionLoading !== null}
                  >
                    <Square className="mr-1.5 h-3.5 w-3.5" />
                    Shutdown
                  </Button>
                )}

                {/* Export */}
                {(vm.powerState === "Halted" || vm.powerState === "Suspended") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setExportStatus(null);
                      setExportError(null);
                      setExportJobId(null);
                      setExportTargetPath(null);
                      setExportOpen(true);
                    }}
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    Export
                  </Button>
                )}

                {/* Settings */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings className="mr-1.5 h-3.5 w-3.5" />
                  Settings
                </Button>
              </>
            )}

            {canAct && (
            /* More Actions */
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
                {availableActions.map((action) => (
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
              </DropdownMenuContent>
            </DropdownMenu>
            )}

            {canAct && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" title="More" disabled={actionLoading !== null}>
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* CopyVMCommand / ConvertVMToTemplateCommand: a VM that is shut down. */}
                  <DropdownMenuItem disabled={vm.powerState !== "Halted"} onClick={() => setCopyOpen(true)}>
                    <Copy className="h-4 w-4" />
                    <span className="ml-2">Copy VM...</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={vm.powerState !== "Halted"} onClick={() => setConvertOpen(true)}>
                    <LayoutTemplate className="h-4 w-4" />
                    <span className="ml-2">Convert to Template...</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {canAct && (
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {actionLoading && (
          <div className="mb-4 rounded-md bg-zinc-50 px-4 py-2 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            Executing {actionLoading.replace("_", " ")}...
          </div>
        )}

        {/* Tabs */}
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="storage">Storage</TabsTrigger>
            <TabsTrigger value="network">Network</TabsTrigger>
            <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-4">
            {/* Resource Summary */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <Cpu className="h-4 w-4" />
                    vCPUs
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {vm.vcpusMax}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {vm.vcpusAtStartup} at startup
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <MemoryStick className="h-4 w-4" />
                    Memory
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatBytes(vm.memoryStaticMax)}
                  </p>
                  <p className="text-xs text-zinc-400">
                    Dynamic: {formatBytes(vm.memoryDynamicMin)} -{" "}
                    {formatBytes(vm.memoryDynamicMax)}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <Info className="h-4 w-4" />
                    Type
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {vm.domainType === "pv_in_pvh" ? "PV in PVH"
                      : vm.domainType ? vm.domainType.toUpperCase()
                      : "N/A"}
                  </p>
                  <p className="text-xs text-zinc-400">Virtualization</p>
                </CardContent>
              </Card>
            </div>

            {/* Details Table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Details</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500 w-40">
                        UUID
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {vm.uuid}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Power State
                      </TableCell>
                      <TableCell>{vm.powerState}</TableCell>
                    </TableRow>
                    {vm.startTime && vm.powerState === "Running" && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Uptime
                        </TableCell>
                        <TableCell>{formatUptime(vm.startTime)}</TableCell>
                      </TableRow>
                    )}
                    {guestOsVersion && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Operating System
                        </TableCell>
                        <TableCell>{guestOsVersion}</TableCell>
                      </TableRow>
                    )}
                    {guestIpAddresses.length > 0 && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          IP {guestIpAddresses.length > 1 ? "Addresses" : "Address"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {guestIpAddresses.join(", ")}
                        </TableCell>
                      </TableRow>
                    )}
                    {hostRecord && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          Host
                        </TableCell>
                        <TableCell>
                          {hostRecord.nameLabel} ({hostRecord.address})
                        </TableCell>
                      </TableRow>
                    )}
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Home Server
                      </TableCell>
                      <TableCell>
                        {affinityRecord
                          ? `${affinityRecord.nameLabel} (${affinityRecord.address})`
                          : <span className="text-zinc-400">—</span>}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        vCPUs
                      </TableCell>
                      <TableCell>
                        {vm.vcpusMax} max / {vm.vcpusAtStartup} at startup
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Memory (Static Max)
                      </TableCell>
                      <TableCell>{formatBytes(vm.memoryStaticMax)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Memory (Dynamic)
                      </TableCell>
                      <TableCell>
                        {formatBytes(vm.memoryDynamicMin)} -{" "}
                        {formatBytes(vm.memoryDynamicMax)}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Virtualization Type
                      </TableCell>
                      <TableCell>
                        {vm.domainType === "pv_in_pvh" ? "PV in PVH"
                          : vm.domainType ? vm.domainType.toUpperCase()
                          : "N/A"}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        Boot Mode
                      </TableCell>
                      <TableCell>
                        {vm.domainType === "pv" || vm.domainType === "pv_in_pvh"
                          ? "N/A (PV)"
                          : vm.hvmBootParams?.firmware === "uefi"
                            ? vm.platform?.secureboot === "true"
                              ? "UEFI + Secure Boot"
                              : "UEFI"
                            : "BIOS"}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium text-zinc-500">
                        vTPM
                      </TableCell>
                      <TableCell>
                        {vm.VTPMs && vm.VTPMs.length > 0 ? "Connected" : "Not connected"}
                      </TableCell>
                    </TableRow>
                    {vm.tags.length > 0 && (
                      <TableRow>
                        <TableCell className="font-medium text-zinc-500">
                          <div className="flex items-center gap-1">
                            <Tag className="h-3 w-3" /> Tags
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {vm.tags.map((tag) => (
                              <Badge
                                key={tag}
                                variant="secondary"
                                className="text-xs"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="storage" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <HardDrive className="h-4 w-4" />
                  Virtual Disks
                </CardTitle>
              </CardHeader>
              <CardContent>
                {disksLoading ? (
                  <p className="text-sm text-zinc-400">Loading disks...</p>
                ) : disks.length === 0 ? (
                  <p className="text-sm text-zinc-400">
                    No disks attached
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Storage Repository</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Used</TableHead>
                        <TableHead>Device</TableHead>
                        <TableHead>Mode</TableHead>
                        <TableHead>Attached</TableHead>
                        {canAct && <TableHead className="w-10"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {disks.map((disk) => (
                        <TableRow key={disk.vbd.ref}>
                          <TableCell className="font-medium">
                            {disk.vdi?.nameLabel || "—"}
                          </TableCell>
                          <TableCell>
                            {disk.sr ? (
                              <div>
                                <span>{disk.sr.nameLabel}</span>
                                <span className="ml-1.5 text-[11px] uppercase text-zinc-400">
                                  {disk.sr.type}
                                </span>
                              </div>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {disk.vdi ? formatBytes(disk.vdi.virtualSize) : "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {disk.vdi
                              ? formatBytes(disk.vdi.physicalUtilisation)
                              : "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {disk.vbd.device || "—"}
                          </TableCell>
                          <TableCell className="text-xs uppercase text-zinc-500">
                            {disk.vbd.mode}
                          </TableCell>
                          <TableCell>
                            {disk.vbd.currentlyAttached ? (
                              <Badge
                                variant="outline"
                                className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[10px]"
                              >
                                Yes
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-zinc-400 text-[10px]"
                              >
                                No
                              </Badge>
                            )}
                          </TableCell>
                          {canAct && (
                            <TableCell className="text-right">
                              {disk.vdi && disk.vbd.type === "Disk" && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
                                  title="Export disk (RAW)"
                                  onClick={() => {
                                    setVdiExportDisk({ uuid: disk.vdi!.uuid, name: disk.vdi!.nameLabel || `disk-${disk.vbd.device}` });
                                    setVdiExportDir("");
                                    setVdiExportStatus(null);
                                    setVdiExportError(null);
                                    setVdiExportJobId(null);
                                    setVdiExportTargetPath(null);
                                    setVdiExportOpen(true);
                                  }}
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="network" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Network className="h-4 w-4" />
                  Virtual Network Interfaces
                </CardTitle>
              </CardHeader>
              <CardContent>
                {nicsLoading ? (
                  <p className="text-sm text-zinc-400">Loading network interfaces...</p>
                ) : nics.length === 0 ? (
                  <p className="text-sm text-zinc-400">
                    No network interfaces attached
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Device</TableHead>
                        <TableHead>Network</TableHead>
                        <TableHead>MAC Address</TableHead>
                        <TableHead>Attached</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {nics.map((nic) => (
                        <TableRow key={nic.vif.ref}>
                          <TableCell className="font-mono text-xs font-medium">
                            eth{nic.vif.device}
                          </TableCell>
                          <TableCell>
                            {nic.network ? (
                              <div>
                                <span>{nic.network.nameLabel}</span>
                                <span className="ml-1.5 font-mono text-[11px] text-zinc-400">
                                  {nic.network.bridge}
                                </span>
                              </div>
                            ) : (
                              <span className="text-xs text-zinc-400">—</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-zinc-500">
                            {nic.vif.mac}
                          </TableCell>
                          <TableCell>
                            {nic.vif.currentlyAttached ? (
                              <div className="flex items-center gap-1 text-emerald-600">
                                <CheckCircle className="h-3.5 w-3.5" />
                                <span className="text-xs">Connected</span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 text-zinc-400">
                                <XCircle className="h-3.5 w-3.5" />
                                <span className="text-xs">Disconnected</span>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="snapshots" className="mt-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Camera className="h-4 w-4" />
                  Snapshots
                </CardTitle>
                {canAct && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const now = new Date();
                      setSnapshotName(`${vm.nameLabel} (${dates.dateTime(now, { seconds: false })})`);
                      setSnapshotDescription("");
                      setSnapshotWithMemory(false);
                      setSnapshotCreateError("");
                      setSnapshotCreateOpen(true);
                    }}
                  >
                    <Camera className="mr-1.5 h-3.5 w-3.5" />
                    Create Snapshot
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {snapshotsLoading ? (
                  <p className="text-sm text-zinc-400">Loading snapshots...</p>
                ) : snapshots.length === 0 ? (
                  <p className="text-sm text-zinc-400">No snapshots</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Date/Time</TableHead>
                        <TableHead>Memory</TableHead>
                        {canAct && <TableHead className="w-20"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshots.map((snap) => (
                        <TableRow key={snap.ref}>
                          <TableCell className="font-medium text-sm">{snap.nameLabel}</TableCell>
                          <TableCell className="text-xs text-zinc-500">{snap.nameDescription || "—"}</TableCell>
                          <TableCell className="text-xs text-zinc-500">
                            {snap.snapshotTime ? (() => {
                              const t = parseXenTimestamp(snap.snapshotTime);
                              return isNaN(t) ? snap.snapshotTime : dates.dateTime(t);
                            })() : "—"}
                          </TableCell>
                          <TableCell>
                            {snap.hasMemory ? (
                              <div className="flex items-center gap-1 text-violet-600">
                                <BrainCircuit className="h-3.5 w-3.5" />
                                <span className="text-xs">Yes</span>
                              </div>
                            ) : (
                              <span className="text-xs text-zinc-400">No</span>
                            )}
                          </TableCell>
                          {canAct && (
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-zinc-400 hover:text-blue-600"
                                  title="Save as Template"
                                  disabled={snapshotActionLoading !== null}
                                  onClick={() => setSnapshotTemplate(snap)}
                                >
                                  <LayoutTemplate className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-zinc-400 hover:text-amber-600"
                                  title="Revert to snapshot"
                                  disabled={snapshotActionLoading !== null}
                                  onClick={() => setSnapshotRevertConfirm(snap)}
                                >
                                  <RotateCw className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-zinc-400 hover:text-red-600"
                                  title="Delete snapshot"
                                  disabled={snapshotActionLoading !== null}
                                  onClick={() => setSnapshotDeleteConfirm(snap)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Mounted only while open: it polls the host while shown. */}
          {/* key: another VM starts afresh, without the last one's figures. */}
          <TabsContent value="performance" className="mt-4">
            <PerfCharts key={`${hostId}:${vmRef}`} conn={conn} vmRef={vmRef} />
          </TabsContent>

          <TabsContent value="memory" className="mt-4">
            <MemoryTab key={`${hostId}:${vmRef}`} conn={conn} vmRef={vmRef} canEdit={canAct} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Power Action Confirmation */}
      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.label} &quot;{vm.nameLabel}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.destructive
                ? `This will forcefully ${pendingAction.label.toLowerCase()} the VM. This may cause data loss.`
                : `Are you sure you want to ${pendingAction?.label.toLowerCase()} this virtual machine?`}
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
                  handlePowerAction(pendingAction.key);
                  setPendingAction(null);
                }
              }}
            >
              {pendingAction?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <VmSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        vm={vm}
        hostId={hostId}
        conn={conn}
        onSaved={() => refreshHost(hostId)}
      />

      {/* Export VM Dialog */}
      <Dialog open={exportOpen} onOpenChange={(o) => { if (!exportLoading && exportStatus !== "running") setExportOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export VM</DialogTitle>
            <DialogDescription>
              The VM will be exported via SSH to a directory on the XenServer.
              The file will be named <span className="font-mono text-xs">&lt;vmname&gt;_&lt;timestamp&gt;.xva</span>.
            </DialogDescription>
          </DialogHeader>

          {exportStatus === null && (
            <div className="grid gap-3 py-2">
              <Label htmlFor="exportDir">Target Directory on XenServer</Label>
              <Input
                id="exportDir"
                placeholder="/mnt/backup"
                value={exportDir}
                onChange={(e) => setExportDir(e.target.value)}
                disabled={exportLoading}
              />
              {exportError && (
                <p className="text-sm text-red-500">{exportError}</p>
              )}
            </div>
          )}

          {exportStatus === "running" && (
            <div className="flex items-center gap-3 py-4 text-sm text-zinc-600 dark:text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <div>
                <p>Export in progress...</p>
                {exportTargetPath && (
                  <p className="mt-1 font-mono text-xs text-zinc-400">{exportTargetPath}</p>
                )}
              </div>
            </div>
          )}

          {exportStatus === "success" && (
            <div className="py-4 text-sm text-emerald-600">
              <p className="font-medium">Export completed successfully.</p>
              {exportTargetPath && (
                <p className="mt-1 font-mono text-xs text-zinc-500">{exportTargetPath}</p>
              )}
            </div>
          )}

          {exportStatus === "failure" && (
            <div className="py-4 text-sm text-red-600">
              <p className="font-medium">Export failed.</p>
              {exportError && <p className="mt-1 text-xs">{exportError}</p>}
            </div>
          )}

          <DialogFooter>
            {exportStatus === null && (
              <>
                <Button variant="outline" onClick={() => setExportOpen(false)} disabled={exportLoading}>
                  Cancel
                </Button>
                <Button
                  onClick={handleExport}
                  disabled={exportLoading || !exportDir.trim()}
                >
                  {exportLoading ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Starting...</> : <><Download className="mr-1.5 h-3.5 w-3.5" />Export</>}
                </Button>
              </>
            )}
            {(exportStatus === "success" || exportStatus === "failure") && (
              <Button onClick={() => setExportOpen(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* VDI Export Dialog */}
      <Dialog open={vdiExportOpen} onOpenChange={(o) => { if (!vdiExportLoading && vdiExportStatus !== "running") setVdiExportOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export Disk (RAW)</DialogTitle>
            <DialogDescription>
              The disk <span className="font-medium">{vdiExportDisk?.name}</span> will be exported as a RAW image via SSH to a directory on the XenServer.
              The file will be named <span className="font-mono text-xs">&lt;diskname&gt;_&lt;timestamp&gt;.raw</span>.
            </DialogDescription>
          </DialogHeader>

          {vdiExportStatus === null && (
            <div className="grid gap-3 py-2">
              <Label htmlFor="vdiExportDir">Target Directory on XenServer</Label>
              <Input
                id="vdiExportDir"
                placeholder="/mnt/backup"
                value={vdiExportDir}
                onChange={(e) => setVdiExportDir(e.target.value)}
                disabled={vdiExportLoading}
              />
              {vdiExportError && (
                <p className="text-sm text-red-500">{vdiExportError}</p>
              )}
            </div>
          )}

          {vdiExportStatus === "running" && (
            <div className="flex items-center gap-3 py-4 text-sm text-zinc-600 dark:text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <div>
                <p>Export in progress...</p>
                {vdiExportTargetPath && (
                  <p className="mt-1 font-mono text-xs text-zinc-400">{vdiExportTargetPath}</p>
                )}
              </div>
            </div>
          )}

          {vdiExportStatus === "success" && (
            <div className="py-4 text-sm text-emerald-600">
              <p className="font-medium">Export completed successfully.</p>
              {vdiExportTargetPath && (
                <p className="mt-1 font-mono text-xs text-zinc-500">{vdiExportTargetPath}</p>
              )}
            </div>
          )}

          {vdiExportStatus === "failure" && (
            <div className="py-4 text-sm text-red-600">
              <p className="font-medium">Export failed.</p>
              {vdiExportError && <p className="mt-1 text-xs">{vdiExportError}</p>}
            </div>
          )}

          <DialogFooter>
            {vdiExportStatus === null && (
              <>
                <Button variant="outline" onClick={() => setVdiExportOpen(false)} disabled={vdiExportLoading}>
                  Cancel
                </Button>
                <Button
                  onClick={handleVdiExport}
                  disabled={vdiExportLoading || !vdiExportDir.trim()}
                >
                  {vdiExportLoading ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Starting...</> : <><Download className="mr-1.5 h-3.5 w-3.5" />Export</>}
                </Button>
              </>
            )}
            {(vdiExportStatus === "success" || vdiExportStatus === "failure") && (
              <Button onClick={() => setVdiExportOpen(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Snapshot Dialog */}
      <Dialog open={snapshotCreateOpen} onOpenChange={(o) => { if (!snapshotCreating) setSnapshotCreateOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Snapshot</DialogTitle>
            <DialogDescription>
              Save the current state of <span className="font-medium">{vm.nameLabel}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="snapName">Name</Label>
              <Input
                id="snapName"
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
                disabled={snapshotCreating}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="snapDesc">Description</Label>
              <Input
                id="snapDesc"
                placeholder="Optional"
                value={snapshotDescription}
                onChange={(e) => setSnapshotDescription(e.target.value)}
                disabled={snapshotCreating}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="snapMem" className="cursor-pointer">Include RAM</Label>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Save memory state (checkpoint). Only available for running VMs.
                </p>
              </div>
              <Switch
                id="snapMem"
                checked={snapshotWithMemory}
                onCheckedChange={setSnapshotWithMemory}
                disabled={snapshotCreating || vm.powerState !== "Running"}
              />
            </div>
            {snapshotCreateError && <p className="text-sm text-red-500">{snapshotCreateError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnapshotCreateOpen(false)} disabled={snapshotCreating}>Cancel</Button>
            <Button onClick={handleSnapshotCreate} disabled={snapshotCreating || !snapshotName.trim()}>
              {snapshotCreating ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Creating...</> : <><Camera className="mr-1.5 h-3.5 w-3.5" />Create</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revert Snapshot Confirmation */}
      <AlertDialog open={snapshotRevertConfirm !== null} onOpenChange={(o) => { if (!o) setSnapshotRevertConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert to &quot;{snapshotRevertConfirm?.nameLabel}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              The VM will be reverted to this snapshot state. Any changes made after the snapshot will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => snapshotRevertConfirm && handleSnapshotRevert(snapshotRevertConfirm)}
            >
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Snapshot Confirmation */}
      <AlertDialog open={snapshotDeleteConfirm !== null} onOpenChange={(o) => { if (!o) setSnapshotDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{snapshotDeleteConfirm?.nameLabel}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This snapshot will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => snapshotDeleteConfirm && handleSnapshotDelete(snapshotDeleteConfirm)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {copyOpen && (
        <CopyVmDialog conn={conn} hostId={hostId!} vmRef={vmRef!} vmName={vm.nameLabel} onClose={() => setCopyOpen(false)} />
      )}
      {convertOpen && (
        <ConvertToTemplateDialog
          conn={conn}
          vmRef={vmRef!}
          vmName={vm.nameLabel}
          onClose={() => setConvertOpen(false)}
          onDone={() => {
            // A template is no VM of the tree any more.
            setConvertOpen(false);
            selectVm(null);
            refreshHost(hostId!);
          }}
        />
      )}
      {snapshotTemplate && (
        <SnapshotTemplateDialog
          conn={conn}
          hostId={hostId!}
          snapshotRef={snapshotTemplate.ref}
          snapshotName={snapshotTemplate.nameLabel}
          onClose={() => setSnapshotTemplate(null)}
        />
      )}

      {/* Delete VM Confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={(o) => { setDeleteConfirmOpen(o); if (!o) setDeleteConfirmName(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{vm.nameLabel}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently destroy the VM and all its associated disks.
              {vm.powerState !== "Halted" && " The VM will be force-shut down first."}
              {" "}This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <label className="text-sm text-zinc-500">Type <span className="font-semibold text-foreground">{vm.nameLabel}</span> to confirm</label>
            <input
              className="mt-1.5 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={deleteConfirmName}
              onChange={(e) => setDeleteConfirmName(e.target.value)}
              placeholder={vm.nameLabel}
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={(e) => {
                e.preventDefault();
                handleDeleteVm();
              }}
              disabled={deleteLoading || deleteConfirmName !== vm.nameLabel}
            >
              {deleteLoading ? "Deleting..." : "Delete VM"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface PowerAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  destructive?: boolean;
  separator?: boolean;
}

function getAvailableActions(powerState: VmPowerState): PowerAction[] {
  switch (powerState) {
    case "Halted":
      return [
        { key: "start", label: "Start", icon: <Play className="h-4 w-4" /> },
      ];
    case "Running":
      return [
        {
          key: "clean_shutdown",
          label: "Shutdown",
          icon: <Square className="h-4 w-4" />,
        },
        {
          key: "clean_reboot",
          label: "Reboot",
          icon: <RotateCcw className="h-4 w-4" />,
        },
        {
          key: "suspend",
          label: "Suspend",
          icon: <CircleDot className="h-4 w-4" />,
        },
        { key: "pause", label: "Pause", icon: <Pause className="h-4 w-4" /> },
        {
          key: "hard_shutdown",
          label: "Force Shutdown",
          icon: <Power className="h-4 w-4" />,
          destructive: true,
          separator: true,
        },
        {
          key: "hard_reboot",
          label: "Force Reboot",
          icon: <RotateCcw className="h-4 w-4" />,
          destructive: true,
        },
      ];
    case "Paused":
      return [
        {
          key: "unpause",
          label: "Unpause",
          icon: <Play className="h-4 w-4" />,
        },
        {
          key: "hard_shutdown",
          label: "Force Shutdown",
          icon: <Power className="h-4 w-4" />,
          destructive: true,
          separator: true,
        },
      ];
    case "Suspended":
      return [
        { key: "resume", label: "Resume", icon: <Play className="h-4 w-4" /> },
        {
          key: "hard_shutdown",
          label: "Force Shutdown",
          icon: <Power className="h-4 w-4" />,
          destructive: true,
          separator: true,
        },
      ];
    default:
      return [];
  }
}
