"use client";

import React, { useEffect, useRef, useState } from "react";
import { useXen } from "@/context/xen-context";
import { useAuth } from "@/context/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Server,
  Monitor,
  Power,
  Pause,
  Square,
  CircleDot,
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  CheckCircle,
  XCircle,
  Wrench,
  Plus,
  Upload,
  Loader2,
  RefreshCw,
  Info,
  Disc,
  PackageCheck,
  Activity,
  Scale,
  CircuitBoard,
} from "lucide-react";
import { GpuTab } from "@/components/gpu/gpu-tab";
import { MemoryTab } from "@/components/memory/memory-tab";
import { AddServerDialog } from "@/components/pool/add-server-dialog";
import { HardDriveDownload, ServerCog } from "lucide-react";
import { XenUpdatesTab } from "@/components/xen-updates-tab";
import { WlbTab } from "@/components/wlb-tab";
import { PvsTab } from "@/components/pvs/pvs-tab";
import { HostNetworking } from "@/components/networking/host-networking";
import { PerfCharts } from "@/components/perf-charts";
import { takePendingPoolTab } from "@/components/xen-updates-overview";
import type { HostConnection } from "@/lib/types";
import { VmPowerState, XenHostRecord } from "@/lib/types";
import { CreateVmDialog } from "@/components/create-vm-dialog";
import { ImportVmDialog } from "@/components/vm/import-vm-dialog";
import { SrActionsMenu, useSrStates } from "@/components/storage/sr-actions";

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

interface ConnInfo {
  host: { address: string; port: number; useSsl: boolean };
  session: { sessionRef: string } | null;
  connectedVia?: string;
}

async function apiCall(conn: ConnInfo, body: Record<string, unknown>) {
  const res = await fetch("/api/xen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      host: conn.connectedVia || conn.host.address,
      port: conn.host.port,
      useSsl: conn.host.useSsl,
      sessionRef: conn.session!.sessionRef,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "API call failed");
  }
  return res.json();
}

type SRType = "nfs" | "lvmoiscsi" | "lvm" | "ext";

const SR_TYPE_LABELS: Record<SRType, string> = {
  nfs: "NFS",
  lvmoiscsi: "iSCSI",
  lvm: "LVM (local)",
  ext: "EXT (local)",
};

function AddSRDialog({
  open,
  onOpenChange,
  conn,
  hosts,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn: ConnInfo;
  hosts: XenHostRecord[];
  onCreated: () => void;
}) {
  const [srType, setSrType] = useState<SRType>("nfs");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shared, setShared] = useState(true);
  const [hostRef, setHostRef] = useState("");

  // NFS fields
  const [nfsServer, setNfsServer] = useState("");
  const [nfsPath, setNfsPath] = useState("");
  const [nfsVersion, setNfsVersion] = useState("3");

  // iSCSI fields
  const [iscsiTarget, setIscsiTarget] = useState("");
  const [iscsiTargetIQN, setIscsiTargetIQN] = useState("");
  const [iscsiSCSIid, setIscsiSCSIid] = useState("");
  const [iscsiPort, setIscsiPort] = useState("3260");
  const [iscsiChapUser, setIscsiChapUser] = useState("");
  const [iscsiChapPassword, setIscsiChapPassword] = useState("");

  // Local (LVM/EXT) fields
  const [localDevice, setLocalDevice] = useState("");

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Reset when the dialog opens, not whenever the pool data refreshes: a
  // refresh hands over new arrays, and the choices made so far were lost.
  const prevOpen = useRef(false);
  useEffect(() => {
    const justOpened = open && !prevOpen.current;
    prevOpen.current = open;
    if (justOpened) {
      setSrType("nfs");
      setName("");
      setDescription("");
      setShared(true);
      setHostRef(hosts.length > 0 ? hosts[0].ref : "");
      setNfsServer("");
      setNfsPath("");
      setNfsVersion("3");
      setIscsiTarget("");
      setIscsiTargetIQN("");
      setIscsiSCSIid("");
      setIscsiPort("3260");
      setIscsiChapUser("");
      setIscsiChapPassword("");
      setLocalDevice("");
      setError("");
      setCreating(false);
    }
  }, [open, hosts]);

  // The hosts arriving only after the dialog opened: the first one.
  useEffect(() => {
    if (open && !hostRef && hosts.length > 0) setHostRef(hosts[0].ref);
  }, [open, hostRef, hosts]);

  function buildDeviceConfig(): Record<string, string> {
    switch (srType) {
      case "nfs": {
        const cfg: Record<string, string> = { server: nfsServer, serverpath: nfsPath };
        if (nfsVersion && nfsVersion !== "3") cfg.nfsversion = nfsVersion;
        return cfg;
      }
      case "lvmoiscsi": {
        const cfg: Record<string, string> = {
          target: iscsiTarget,
          targetIQN: iscsiTargetIQN,
          SCSIid: iscsiSCSIid,
        };
        if (iscsiPort && iscsiPort !== "3260") cfg.port = iscsiPort;
        if (iscsiChapUser) {
          cfg.chapuser = iscsiChapUser;
          cfg.chappassword = iscsiChapPassword;
        }
        return cfg;
      }
      case "lvm":
      case "ext":
        return { device: localDevice };
    }
  }

  function isValid(): boolean {
    if (!name.trim() || !hostRef) return false;
    switch (srType) {
      case "nfs": return !!(nfsServer.trim() && nfsPath.trim());
      case "lvmoiscsi": return !!(iscsiTarget.trim() && iscsiTargetIQN.trim() && iscsiSCSIid.trim());
      case "lvm":
      case "ext": return !!localDevice.trim();
    }
  }

  async function handleCreate() {
    if (!isValid()) return;
    setCreating(true);
    setError("");
    try {
      await apiCall(conn, {
        action: "sr_create",
        hostRef,
        nameLabel: name.trim(),
        nameDescription: description.trim(),
        srType,
        deviceConfig: buildDeviceConfig(),
        shared,
      });
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create SR");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!creating) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Storage Repository</DialogTitle>
          <DialogDescription>
            Create a new storage repository and attach it to the pool.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Host</Label>
            <Select value={hostRef} onValueChange={setHostRef}>
              <SelectTrigger>
                <SelectValue placeholder="Select host..." />
              </SelectTrigger>
              <SelectContent>
                {hosts.filter((h) => h.enabled).map((h) => (
                  <SelectItem key={h.ref} value={h.ref}>
                    {h.nameLabel} ({h.address})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>Type</Label>
            <Select value={srType} onValueChange={(v) => setSrType(v as SRType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SR_TYPE_LABELS) as SRType[]).map((t) => (
                  <SelectItem key={t} value={t}>{SR_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="sr-name">Name</Label>
            <Input id="sr-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Storage" />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="sr-desc">Description</Label>
            <Input id="sr-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>

          {/* NFS fields */}
          {srType === "nfs" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="nfs-server">Server</Label>
                  <Input id="nfs-server" value={nfsServer} onChange={(e) => setNfsServer(e.target.value)} placeholder="192.168.1.100" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="nfs-version">NFS Version</Label>
                  <Select value={nfsVersion} onValueChange={setNfsVersion}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3">NFSv3</SelectItem>
                      <SelectItem value="4">NFSv4</SelectItem>
                      <SelectItem value="4.1">NFSv4.1</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="nfs-path">Share Path</Label>
                <Input id="nfs-path" value={nfsPath} onChange={(e) => setNfsPath(e.target.value)} placeholder="/export/storage" />
              </div>
            </>
          )}

          {/* iSCSI fields */}
          {srType === "lvmoiscsi" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="iscsi-target">Target Host</Label>
                  <Input id="iscsi-target" value={iscsiTarget} onChange={(e) => setIscsiTarget(e.target.value)} placeholder="192.168.1.100" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="iscsi-port">Port</Label>
                  <Input id="iscsi-port" value={iscsiPort} onChange={(e) => setIscsiPort(e.target.value)} placeholder="3260" />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="iscsi-iqn">Target IQN</Label>
                <Input id="iscsi-iqn" value={iscsiTargetIQN} onChange={(e) => setIscsiTargetIQN(e.target.value)} placeholder="iqn.2001-04.com.example:storage" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="iscsi-scsi">SCSI ID</Label>
                <Input id="iscsi-scsi" value={iscsiSCSIid} onChange={(e) => setIscsiSCSIid(e.target.value)} placeholder="360000..." />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="iscsi-chap-user">CHAP User</Label>
                  <Input id="iscsi-chap-user" value={iscsiChapUser} onChange={(e) => setIscsiChapUser(e.target.value)} placeholder="Optional" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="iscsi-chap-pw">CHAP Password</Label>
                  <Input id="iscsi-chap-pw" type="password" value={iscsiChapPassword} onChange={(e) => setIscsiChapPassword(e.target.value)} placeholder="Optional" />
                </div>
              </div>
            </>
          )}

          {/* Local LVM/EXT fields */}
          {(srType === "lvm" || srType === "ext") && (
            <div className="grid gap-2">
              <Label htmlFor="local-device">Device Path</Label>
              <Input id="local-device" value={localDevice} onChange={(e) => setLocalDevice(e.target.value)} placeholder="/dev/sdb" />
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor="sr-shared" className="cursor-pointer">Shared (accessible from all hosts)</Label>
            <Switch id="sr-shared" checked={shared} onCheckedChange={setShared} />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>Cancel</Button>
          <Button onClick={handleCreate} disabled={!isValid() || creating}>
            {creating ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...</>
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddISOLibraryDialog({
  open,
  onOpenChange,
  conn,
  hosts,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn: ConnInfo;
  hosts: XenHostRecord[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shareType, setShareType] = useState<"nfs" | "smb">("nfs");
  const [server, setServer] = useState("");
  const [sharePath, setSharePath] = useState("");
  const [smbUsername, setSmbUsername] = useState("");
  const [smbPassword, setSmbPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setShareType("nfs");
      setServer("");
      setSharePath("");
      setSmbUsername("");
      setSmbPassword("");
      setError("");
      setCreating(false);
    }
  }, [open]);

  const hostRef = hosts.find((h) => h.enabled)?.ref || "";
  const isValid = !!(name.trim() && hostRef && server.trim() && sharePath.trim());

  async function handleCreate() {
    if (!isValid) return;
    setCreating(true);
    setError("");
    try {
      const deviceConfig: Record<string, string> =
        shareType === "nfs"
          ? { location: `${server.trim()}:${sharePath.trim()}`, type: "nfs" }
          : {
              location: `\\\\${server.trim()}\\${sharePath.trim()}`,
              type: "cifs",
              ...(smbUsername.trim() ? { username: smbUsername.trim() } : {}),
              ...(smbPassword ? { cifspassword: smbPassword } : {}),
            };

      await apiCall(conn, {
        action: "sr_create",
        hostRef,
        nameLabel: name.trim(),
        nameDescription: description.trim(),
        srType: "iso",
        contentType: "iso",
        deviceConfig,
        shared: true,
      });
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create ISO library");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!creating) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add ISO Library</DialogTitle>
          <DialogDescription>
            Add an ISO library to make ISO images available pool-wide.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="iso-name">Name</Label>
            <Input id="iso-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ISO Library" />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="iso-desc">Description</Label>
            <Input id="iso-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>

          <div className="grid gap-2">
            <Label>Share Type</Label>
            <Select value={shareType} onValueChange={(v) => setShareType(v as "nfs" | "smb")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nfs">NFS</SelectItem>
                <SelectItem value="smb">SMB/CIFS</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="iso-server">Server</Label>
            <Input id="iso-server" value={server} onChange={(e) => setServer(e.target.value)} placeholder="192.168.1.100" />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="iso-path">Share Path</Label>
            <Input
              id="iso-path"
              value={sharePath}
              onChange={(e) => setSharePath(e.target.value)}
              placeholder={shareType === "nfs" ? "/export/isos" : "isos"}
            />
          </div>

          {shareType === "smb" && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="iso-smb-user">Username</Label>
                <Input id="iso-smb-user" value={smbUsername} onChange={(e) => setSmbUsername(e.target.value)} placeholder="Optional" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="iso-smb-pass">Password</Label>
                <Input id="iso-smb-pass" type="password" value={smbPassword} onChange={(e) => setSmbPassword(e.target.value)} placeholder="Optional" />
              </div>
            </>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>Cancel</Button>
          <Button onClick={handleCreate} disabled={!isValid || creating}>
            {creating ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...</>
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HostDetail() {
  const { state, selectVm, selectXenHost, refreshHost } = useXen();
  const { role } = useAuth();
  const canAct = role === "admin" || role === "operator";
  const isAdmin = role === "admin";
  const [createVmOpen, setCreateVmOpen] = useState(false);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Opened from the dashboard's update card: straight on the Updates tab.
  const [firstTab] = useState(() => takePendingPoolTab() ?? "overview");

  const hostId = state.selectedHostId;
  if (!hostId) return null;

  const conn = state.connections[hostId];
  if (!conn) return null;

  // Not connected - show minimal info
  if (conn.status !== "connected") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Server className="mx-auto mb-3 h-12 w-12 text-zinc-200 dark:text-zinc-700" />
          <h2 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">
            {conn.host.name}
          </h2>
          <p className="mt-1 break-words text-sm text-zinc-500">
            {conn.status === "connecting"
              ? "Connecting..."
              : conn.status === "error"
                ? conn.error || "Connection failed"
                : "Not connected"}
          </p>
        </div>
      </div>
    );
  }

  // Host.CompareTo in XenCenter: the coordinator first, then by name (numbers as numbers).
  const masterRef = Object.values(conn.pools)[0]?.master;
  const xenHosts = Object.values(conn.hostRecords).sort(
    (a, b) =>
      Number(b.ref === masterRef) - Number(a.ref === masterRef) ||
      a.nameLabel.localeCompare(b.nameLabel, undefined, { numeric: true, sensitivity: "base" }),
  );
  const vms = Object.values(conn.vms);
  const pools = Object.values(conn.pools);
  const pool = pools[0];
  const srs = Object.values(conn.srs).sort((a, b) =>
    a.nameLabel.localeCompare(b.nameLabel),
  );

  const runningVms = vms.filter((vm) => vm.powerState === "Running").length;
  const haltedVms = vms.filter((vm) => vm.powerState === "Halted").length;
  const pausedVms = vms.filter(
    (vm) => vm.powerState === "Paused" || vm.powerState === "Suspended",
  ).length;

  const totalMemory = xenHosts.reduce((sum, h) => sum + h.memoryTotal, 0);
  const freeMemory = xenHosts.reduce((sum, h) => sum + h.memoryFree, 0);
  const usedMemory = totalMemory - freeMemory;
  const memoryPercent =
    totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : 0;

  const totalVCpus = vms.reduce(
    (sum, vm) => sum + (vm.powerState === "Running" ? vm.vcpusMax : 0),
    0,
  );

  const totalSockets = xenHosts.reduce((sum, h) => sum + h.cpuInfo.socketCount, 0);
  const totalThreads = xenHosts.reduce((sum, h) => sum + h.cpuInfo.cpuCount, 0);
  const cpuPercent = totalThreads > 0 ? Math.round((totalVCpus / totalThreads) * 100) : 0;

  const totalStorage = srs.reduce((sum, sr) => sum + sr.physicalSize, 0);
  const usedStorage = srs.reduce((sum, sr) => sum + sr.physicalUtilisation, 0);
  const storagePercent =
    totalStorage > 0 ? Math.round((usedStorage / totalStorage) * 100) : 0;

  // Build global VM color map (consistent colors across hosts)
  const allRunningVms = vms
    .filter((vm) => vm.powerState === "Running")
    .sort((a, b) => b.memoryStaticMax - a.memoryStaticMax);
  const vmColorMap = new Map<string, string>(
    allRunningVms.map((vm, i) => [vm.ref, VM_COLORS[i % VM_COLORS.length]]),
  );

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-7xl px-3 pb-20 pt-3 sm:px-6 sm:pt-6 md:pb-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="min-w-0 break-words text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {conn.host.name}
            </h2>
            <Badge
              variant="outline"
              className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
            >
              Connected
            </Badge>
            {(canAct || isAdmin) && (
              <div className="ml-auto flex flex-wrap gap-2">
                {/* XenCenter: Pool > Add Server > Add New Server... */}
                {isAdmin && (
                  <Button size="sm" variant="outline" onClick={() => setAddServerOpen(true)}>
                    <ServerCog className="mr-1.5 h-3.5 w-3.5" />
                    Add Server
                  </Button>
                )}
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
                {/* XenCenter: File > Import, for an XVA. */}
                {canAct && (
                  <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    Import
                  </Button>
                )}
              </div>
            )}
            {importOpen && (
              <ImportVmDialog
                conn={conn}
                hostId={hostId}
                poolName={pool?.nameLabel || conn.host.name}
                onClose={() => setImportOpen(false)}
                onDone={() => void refreshHost(hostId)}
              />
            )}
            {addServerOpen && (
              <AddServerDialog
                conn={conn}
                poolName={pool?.nameLabel || conn.host.name}
                onClose={() => setAddServerOpen(false)}
                onDone={() => void refreshHost(hostId)}
              />
            )}
          </div>
          <p className="mt-1 break-words text-sm text-zinc-500">
            {conn.host.address}:{conn.host.port}
            {pool && pool.nameLabel ? ` \u2014 Pool: ${pool.nameLabel}` : ""}
          </p>
        </div>

        <Tabs defaultValue={firstTab}>
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
            <TabsTrigger value="networks" className="gap-2">
              <Network className="h-4 w-4" />
              Networks
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
            <TabsTrigger value="wlb" className="gap-2">
              <Scale className="h-4 w-4" />
              WLB
            </TabsTrigger>
            <TabsTrigger value="pvs" className="gap-2">
              <HardDriveDownload className="h-4 w-4" />
              PVS
            </TabsTrigger>
          </TabsList>

          {/* ── Overview Tab ── */}
          <TabsContent value="overview" className="space-y-6">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <Server className="h-4 w-4" />
                    Hosts
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {xenHosts.length}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {xenHosts.filter((h) => h.enabled).length} enabled
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <Monitor className="h-4 w-4" />
                    VMs
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {vms.length}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {runningVms} running, {haltedVms} halted
                    {pausedVms > 0 ? `, ${pausedVms} other` : ""}
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
                    {totalThreads > 0
                      ? `of ${totalThreads} threads / ${totalSockets} ${totalSockets === 1 ? "socket" : "sockets"} (${cpuPercent}%)`
                      : "Allocated to running VMs"}
                  </p>
                  {totalThreads > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-zinc-600 dark:bg-zinc-400 transition-all"
                        style={{ width: `${Math.min(cpuPercent, 100)}%` }}
                      />
                    </div>
                  )}
                  {xenHosts.length === 1 && xenHosts[0].cpuInfo.modelname && (
                    <p className="mt-1.5 text-[11px] text-zinc-400 truncate" title={xenHosts[0].cpuInfo.modelname}>
                      {xenHosts[0].cpuInfo.modelname}
                    </p>
                  )}
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
                    {formatBytes(usedMemory)}
                  </p>
                  <p className="text-xs text-zinc-400">
                    of {formatBytes(totalMemory)} ({memoryPercent}%)
                  </p>
                  {totalMemory > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-zinc-600 dark:bg-zinc-400 transition-all"
                        style={{ width: `${memoryPercent}%` }}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-500">
                    <HardDrive className="h-4 w-4" />
                    Storage
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatBytes(usedStorage)}
                  </p>
                  <p className="text-xs text-zinc-400">
                    of {formatBytes(totalStorage)} ({storagePercent}%)
                  </p>
                  {totalStorage > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-zinc-600 dark:bg-zinc-400 transition-all"
                        style={{ width: `${storagePercent}%` }}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Pool Hosts Table */}
            {xenHosts.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <Server className="h-4 w-4" />
                    Pool Hosts
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Address</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>CPU</TableHead>
                        <TableHead>Memory</TableHead>
                        <TableHead>VMs</TableHead>
                        <TableHead>Software</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {xenHosts.map((xh) => {
                        const residentVmCount = vms.filter(
                          (vm) =>
                            vm.residentOn === xh.ref && vm.powerState === "Running",
                        ).length;
                        const isMaster = pool && pool.master === xh.ref;
                        const memUsed = xh.memoryTotal - xh.memoryFree;
                        const memPct =
                          xh.memoryTotal > 0
                            ? Math.round((memUsed / xh.memoryTotal) * 100)
                            : 0;

                        return (
                          <TableRow
                            key={xh.ref}
                            className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                            onClick={() => selectXenHost(xh.ref)}
                          >
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2">
                                {xh.nameLabel}
                                {isMaster && (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] px-1 py-0"
                                  >
                                    coordinator
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-zinc-500 font-mono text-xs">
                              {xh.address}
                            </TableCell>
                            <TableCell>
                              {xh.enabled ? (
                                <div className="flex items-center gap-1 text-emerald-600">
                                  <CheckCircle className="h-3.5 w-3.5" />
                                  <span className="text-xs">Enabled</span>
                                </div>
                              ) : xh.otherConfig?.MAINTENANCE_MODE === "true" ? (
                                <div className="flex items-center gap-1 text-amber-600">
                                  <Wrench className="h-3.5 w-3.5" />
                                  <span className="text-xs">Maintenance</span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1 text-zinc-400">
                                  <XCircle className="h-3.5 w-3.5" />
                                  <span className="text-xs">Disabled</span>
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-xs max-w-[220px]">
                              {xh.cpuInfo.modelname ? (
                                <div>
                                  <p className="truncate text-zinc-700 dark:text-zinc-300" title={xh.cpuInfo.modelname}>
                                    {xh.cpuInfo.modelname}
                                  </p>
                                  <p className="text-zinc-400">
                                    {xh.cpuInfo.socketCount > 0
                                      ? `${xh.cpuInfo.socketCount} socket${xh.cpuInfo.socketCount > 1 ? "s" : ""} · ${xh.cpuInfo.cpuCount} threads`
                                      : xh.cpuInfo.vendor || "—"}
                                    {xh.cpuInfo.speed > 0 && ` · ${(xh.cpuInfo.speed / 1000).toFixed(2)} GHz`}
                                  </p>
                                </div>
                              ) : (
                                <span className="text-zinc-400">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="space-y-1">
                                <span className="text-xs">
                                  {formatBytes(memUsed)} /{" "}
                                  {formatBytes(xh.memoryTotal)}
                                </span>
                                {xh.memoryTotal > 0 && (
                                  <div className="h-1 w-20 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                                    <div
                                      className="h-full rounded-full bg-zinc-500 transition-all"
                                      style={{ width: `${memPct}%` }}
                                    />
                                  </div>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs">
                              {residentVmCount} running
                            </TableCell>
                            <TableCell className="text-xs text-zinc-500">
                              {xh.softwareVersion?.product_version ||
                                xh.softwareVersion?.xen ||
                                "N/A"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Memory Allocation */}
            {xenHosts.length > 0 && totalMemory > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <MemoryStick className="h-4 w-4" />
                    Memory Allocation
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-6">
                    {xenHosts.map((xh) => {
                      const hostRunningVms = allRunningVms.filter((vm) => vm.residentOn === xh.ref);
                      const hostVmSegments = hostRunningVms.map((vm) => ({
                        vm,
                        bytes: vm.memoryStaticMax,
                        percent: xh.memoryTotal > 0 ? (vm.memoryStaticMax / xh.memoryTotal) * 100 : 0,
                        color: vmColorMap.get(vm.ref) ?? VM_COLORS[0],
                      }));
                      const hostVmAllocated = hostVmSegments.reduce((sum, s) => sum + s.bytes, 0);
                      const hostOverheadBytes = Math.max(0, (xh.memoryTotal - xh.memoryFree) - hostVmAllocated);
                      const hostOverheadPercent = xh.memoryTotal > 0 ? (hostOverheadBytes / xh.memoryTotal) * 100 : 0;
                      const hostUsedMemory = xh.memoryTotal - xh.memoryFree;
                      const hostMemPct = xh.memoryTotal > 0 ? Math.round((hostUsedMemory / xh.memoryTotal) * 100) : 0;
                      const isMaster = pool && pool.master === xh.ref;

                      return (
                        <div key={xh.ref} className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              {xh.nameLabel}
                              {isMaster && (
                                <Badge variant="outline" className="text-[10px] px-1 py-0">
                                  coordinator
                                </Badge>
                              )}
                            </div>
                            <span className="text-xs text-zinc-500">
                              {formatBytes(hostUsedMemory)} / {formatBytes(xh.memoryTotal)} ({hostMemPct}%)
                            </span>
                          </div>

                          {/* Bar */}
                          <div className="h-6 w-full overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800 flex">
                            {hostVmSegments.map((seg) => (
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
                            {hostOverheadPercent > 0.5 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    className="bg-zinc-400 dark:bg-zinc-500 h-full border-r border-white/20 dark:border-zinc-900/20"
                                    style={{ width: `${hostOverheadPercent}%` }}
                                  />
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p className="font-medium">System / Overhead</p>
                                  <p className="text-xs text-zinc-400">
                                    {formatBytes(hostOverheadBytes)} ({hostOverheadPercent.toFixed(1)}%)
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>

                          {/* Legend */}
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            {hostVmSegments.map((seg) => (
                              <button
                                key={seg.vm.ref}
                                onClick={() => selectVm(seg.vm.ref)}
                                className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
                              >
                                <div className={`h-2 w-2 rounded-sm ${seg.color}`} />
                                <span>{seg.vm.nameLabel}</span>
                                <span className="text-zinc-400">({formatBytes(seg.bytes)})</span>
                              </button>
                            ))}
                            {hostOverheadPercent > 0.5 && (
                              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <div className="h-2 w-2 rounded-sm bg-zinc-400 dark:bg-zinc-500" />
                                <span>System / Overhead</span>
                                <span className="text-zinc-400">({formatBytes(hostOverheadBytes)})</span>
                              </div>
                            )}
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <div className="h-2 w-2 rounded-sm bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700" />
                              <span>Free</span>
                              <span className="text-zinc-400">({formatBytes(xh.memoryFree)})</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Storage Tab ── */}
          <TabsContent value="storage">
            <StorageTab key={hostId} conn={conn} hostId={hostId} hostRef={null} isAdmin={isAdmin} />
          </TabsContent>

          {/* ── Networks Tab ── */}
          <TabsContent value="networks">
            <HostNetworking key={hostId} conn={conn} hostRef={null} isAdmin={isAdmin} />
          </TabsContent>

          {/* ── VMs Tab ── */}
          <TabsContent value="vms">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Monitor className="h-4 w-4" />
                  Virtual Machines
                </CardTitle>
              </CardHeader>
              <CardContent>
                {vms.length === 0 ? (
                  <p className="py-4 text-center text-sm text-zinc-400">
                    No VMs found
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
                        <TableHead>Host</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {vms
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
                          const hostRecord = conn.hostRecords[vm.residentOn];
                          return (
                            <TableRow
                              key={vm.ref}
                              className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                              onClick={() => selectVm(vm.ref)}
                            >
                              <TableCell className="font-medium">
                                {vm.nameLabel}
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
                              <TableCell className="text-zinc-500">
                                {hostRecord?.nameLabel ||
                                  (vm.powerState === "Halted" ? "-" : "Unknown")}
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

          {/* One line per host; mounted only while open, as it polls every host. */}
          {/* key: another pool starts afresh, without the last one's figures. */}
          <TabsContent value="performance">
            <PerfCharts key={hostId} conn={conn} pool />
          </TabsContent>

          <TabsContent value="updates">
            <XenUpdatesTab key={hostId} hostId={hostId} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="memory">
            <MemoryTab key={hostId} conn={conn} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="gpu">
            <GpuTab key={hostId} conn={conn} hostRef={null} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="wlb">
            <WlbTab key={hostId} conn={conn} poolName={pool?.nameLabel ?? ""} isAdmin={isAdmin} />
          </TabsContent>
          <TabsContent value="pvs">
            <PvsTab key={hostId} conn={conn} poolName={pool?.nameLabel ?? ""} isAdmin={isAdmin} canAct={canAct} />
          </TabsContent>
        </Tabs>
      </div>

      <CreateVmDialog
        open={createVmOpen}
        onOpenChange={setCreateVmOpen}
        hostId={hostId}
        conn={conn}
        hostRecords={xenHosts}
        onCreated={() => refreshHost(hostId)}
      />

    </div>
  );
}

/**
 * The Storage tab: the pool's storage repositories, or (hostRef) those a server
 * sees -- the shared ones and its own, i.e. those with a PBD on it, as XenCenter's
 * Storage tab of a server lists them. Add ISO Library / Add SR for admins.
 */
export function StorageTab({
  conn,
  hostId,
  hostRef,
  isAdmin,
}: {
  conn: HostConnection;
  hostId: string;
  hostRef: string | null;
  isAdmin: boolean;
}) {
  const { refreshHost } = useXen();
  const [addSrOpen, setAddSrOpen] = useState(false);
  const [addIsoOpen, setAddIsoOpen] = useState(false);
  const [scanningSr, setScanningSr] = useState<string | null>(null);
  const [isoInfoSr, setIsoInfoSr] = useState<{ ref: string; name: string } | null>(null);
  const [isoList, setIsoList] = useState<{ ref: string; nameLabel: string }[]>([]);
  const [isoListLoading, setIsoListLoading] = useState(false);
  // XenCenter's SR menu: what each SR allows, reloaded whenever the pool's SRs change.
  const { states: srStates, reload: reloadSrStates } = useSrStates(conn, conn.srs);

  const xenHosts = Object.values(conn.hostRecords).sort((a, b) => a.nameLabel.localeCompare(b.nameLabel));
  const hostPbds = hostRef ? new Set(conn.hostRecords[hostRef]?.pbds ?? []) : null;
  const srs = Object.values(conn.srs)
    .filter((sr) => !hostPbds || sr.pbds.some((pbd) => hostPbds.has(pbd)))
    .sort((a, b) => a.nameLabel.localeCompare(b.nameLabel));

  return (
    <>
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <HardDrive className="h-4 w-4" />
                  Storage Repositories
                  {isAdmin && (
                    <div className="flex flex-wrap gap-2 sm:ml-auto">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAddIsoOpen(true)}
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Add ISO Library
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAddSrOpen(true)}
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Add SR
                      </Button>
                    </div>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {srs.length === 0 ? (
                  <p className="py-4 text-center text-sm text-zinc-400">No storage repositories</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Usage</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead className="w-[50px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {srs.map((sr) => {
                        const usedPct =
                          sr.physicalSize > 0
                            ? Math.round(
                                (sr.physicalUtilisation / sr.physicalSize) * 100,
                              )
                            : 0;
                        return (
                          <TableRow key={sr.ref}>
                            <TableCell className="font-medium">
                              <span className="inline-flex flex-wrap items-center gap-1.5">
                                {sr.nameLabel}
                                {srStates[sr.ref]?.isDefault && (
                                  <Badge variant="outline" className="text-[10px]">Default</Badge>
                                )}
                                {srStates[sr.ref] && "repair" in srStates[sr.ref].commands && (
                                  <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-[10px] text-red-600">Broken</Badge>
                                )}
                                {srStates[sr.ref]?.commands.detach === "The SR is currently detached." && (
                                  <Badge variant="outline" className="text-[10px] text-zinc-500">Detached</Badge>
                                )}
                              </span>
                              {sr.nameDescription && (
                                <p className="text-[11px] text-zinc-400 truncate max-w-xs">
                                  {sr.nameDescription}
                                </p>
                              )}
                            </TableCell>
                            <TableCell className="text-xs uppercase text-zinc-500">
                              {sr.type}
                            </TableCell>
                            <TableCell>
                              <div className="space-y-1">
                                <span className="text-xs">
                                  {formatBytes(sr.physicalUtilisation)} /{" "}
                                  {formatBytes(sr.physicalSize)}
                                </span>
                                {sr.physicalSize > 0 && (
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
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs text-zinc-500">
                              {formatBytes(sr.physicalSize)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center justify-end gap-0.5">
                              {sr.type === "iso" && (
                                <div className="flex items-center gap-0.5">
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    title="Show available ISOs"
                                    onClick={async () => {
                                      setIsoInfoSr({ ref: sr.ref, name: sr.nameLabel });
                                      setIsoList([]);
                                      setIsoListLoading(true);
                                      try {
                                        const data = await apiCall(conn, { action: "vm_isos" });
                                        const filtered = (data.isos || [])
                                          .filter((iso: { srRef: string }) => iso.srRef === sr.ref);
                                        setIsoList(filtered);
                                      } catch { /* ignore */ }
                                      setIsoListLoading(false);
                                    }}
                                  >
                                    <Info className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    title="Scan for new ISOs"
                                    disabled={scanningSr === sr.ref}
                                    onClick={async () => {
                                      setScanningSr(sr.ref);
                                      try {
                                        await apiCall(conn, { action: "sr_scan", srRef: sr.ref });
                                        refreshHost(hostId);
                                      } catch { /* ignore */ }
                                      setScanningSr(null);
                                    }}
                                  >
                                    <RefreshCw className={`h-3.5 w-3.5 ${scanningSr === sr.ref ? "animate-spin" : ""}`} />
                                  </Button>
                                </div>
                              )}
                              {isAdmin && srStates[sr.ref] && (
                                <SrActionsMenu
                                  conn={conn}
                                  state={srStates[sr.ref]}
                                  onDone={() => {
                                    void reloadSrStates();
                                    void refreshHost(hostId);
                                  }}
                                />
                              )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* ISO Info Dialog */}
            <Dialog open={isoInfoSr !== null} onOpenChange={(open) => { if (!open) setIsoInfoSr(null); }}>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Disc className="h-4 w-4" />
                    {isoInfoSr?.name}
                  </DialogTitle>
                  <DialogDescription>
                    {isoListLoading
                      ? "Loading ISOs..."
                      : `${isoList.length} ISO${isoList.length !== 1 ? "s" : ""} available`}
                  </DialogDescription>
                </DialogHeader>
                {isoListLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                  </div>
                ) : isoList.length === 0 ? (
                  <p className="py-4 text-center text-sm text-zinc-500">
                    No ISOs found in this library.
                  </p>
                ) : (
                  <div className="max-h-80 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>ISO Name</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {isoList.map((iso) => (
                          <TableRow key={iso.ref}>
                            <TableCell className="text-xs">
                              <div className="flex items-center gap-2">
                                <Disc className="h-3 w-3 shrink-0 text-zinc-400" />
                                {iso.nameLabel}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </DialogContent>
            </Dialog>

      <AddSRDialog
        open={addSrOpen}
        onOpenChange={setAddSrOpen}
        conn={conn}
        hosts={xenHosts}
        onCreated={() => refreshHost(hostId)}
      />

      <AddISOLibraryDialog
        open={addIsoOpen}
        onOpenChange={setAddIsoOpen}
        conn={conn}
        hosts={xenHosts}
        onCreated={() => refreshHost(hostId)}
      />
    </>
  );
}
