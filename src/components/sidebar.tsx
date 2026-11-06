"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { XenUpdatesBadge } from "@/components/xen-updates-badge";
import { useXen } from "@/context/xen-context";
import { useTask } from "@/context/task-context";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
  Settings,
  RefreshCw,
  Plug,
  PlugZap,
  ChevronDown,
  ChevronRight,
  LogOut,
  Search,
  X,
  Play,
  RotateCcw,
  Terminal,
  ArrowRightLeft,
  Wrench,
  ShieldCheck,
  Plus,
  Users,
  ScrollText,
  RotateCw,
  Crown,
  Folder,
  FolderOpen,
  FolderX,
  FolderPlus,
  PowerOff,
  Bell,
  Unlink,
  ServerCog,
  KeyRound,
  Copy,
  LayoutTemplate,
} from "lucide-react";
import { LicenseManagerDialog } from "@/components/license-manager";
import { AddServerDialog } from "@/components/pool/add-server-dialog";
import { RemoveServerDialog } from "@/components/pool/remove-server-dialog";
import { ConvertToTemplateDialog, CopyVmDialog } from "@/components/vm/copy-vm-dialog";
import { useAuth, type UserRole } from "@/context/auth-context";

/**
 * Shown when the sidebar has nothing to list. Two very different reasons look
 * identical from here: no pools are configured at all (an admin's job), or the
 * user simply has none assigned. Telling the latter to "add a host" would point
 * them at a page they cannot use.
 */
function EmptySidebarNotice({ role }: { role: UserRole | null }) {
  return (
    <div className="px-3 py-8 text-center">
      <Server className="mx-auto mb-2 h-8 w-8 text-zinc-300 dark:text-zinc-600" />
      {role === "admin" ? (
        <>
          <p className="text-xs text-zinc-500">No hosts configured</p>
          <Link href="/settings?addHost">
            <Button variant="outline" size="sm" className="mt-3">
              <Settings className="mr-1.5 h-3 w-3" />
              Add Host
            </Button>
          </Link>
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-500">No pools assigned</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
            Ask an administrator to grant you access to a pool.
          </p>
        </>
      )}
    </div>
  );
}
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
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
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useTheme } from "@/context/theme-context";
import { VmPowerState, XenVM, XenHostRecord } from "@/lib/types";
import { VmSettingsDialog } from "@/components/vm-settings-dialog";
import { CreateVmDialog } from "@/components/create-vm-dialog";

const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 288;

const powerStateIcon: Record<VmPowerState, React.ReactNode> = {
  Running: <Power className="h-3 w-3 text-emerald-500" />,
  Halted: <Square className="h-3 w-3 text-zinc-400" />,
  Paused: <Pause className="h-3 w-3 text-amber-500" />,
  Suspended: <CircleDot className="h-3 w-3 text-amber-500" />,
};

const powerStateMonitorColor: Record<VmPowerState, string> = {
  Running: "text-emerald-500",
  Halted: "text-zinc-400",
  Paused: "text-amber-500",
  Suspended: "text-amber-500",
};

type DraggingVm = {
  vmRef: string;
  vmName: string;
  hostId: string;
  powerState: VmPowerState;
  residentOn: string;
  conn: { host: { address: string; port: number; useSsl: boolean }; session: { sessionRef: string } | null; connectedVia?: string };
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

const vmSortOrder: Record<VmPowerState, number> = {
  Running: 0,
  Paused: 1,
  Suspended: 2,
  Halted: 3,
};

function sortVms(list: XenVM[]): XenVM[] {
  return [...list].sort(
    (a, b) =>
      vmSortOrder[a.powerState] - vmSortOrder[b.powerState] ||
      a.nameLabel.localeCompare(b.nameLabel),
  );
}

function normalizeFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function getUniqueFolders(vms: XenVM[]): string[] {
  const folders = new Set<string>();
  for (const vm of vms) {
    const f = vm.otherConfig?.folder;
    if (f) {
      const n = normalizeFolder(f);
      if (n) folders.add(n);
    }
  }
  return [...folders].sort();
}

interface PowerAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  destructive?: boolean;
  separator?: boolean;
}

function getVmPowerActions(powerState: VmPowerState): PowerAction[] {
  switch (powerState) {
    case "Halted":
      return [{ key: "start", label: "Start", icon: <Play className="h-4 w-4" /> }];
    case "Running":
      return [
        { key: "clean_shutdown", label: "Shutdown", icon: <Square className="h-4 w-4" /> },
        { key: "clean_reboot", label: "Reboot", icon: <RotateCcw className="h-4 w-4" /> },
        { key: "suspend", label: "Suspend", icon: <CircleDot className="h-4 w-4" /> },
        { key: "pause", label: "Pause", icon: <Pause className="h-4 w-4" /> },
        { key: "hard_shutdown", label: "Force Shutdown", icon: <Power className="h-4 w-4" />, destructive: true, separator: true },
        { key: "hard_reboot", label: "Force Reboot", icon: <RotateCcw className="h-4 w-4" />, destructive: true },
      ];
    case "Paused":
      return [
        { key: "unpause", label: "Unpause", icon: <Play className="h-4 w-4" /> },
        { key: "hard_shutdown", label: "Force Shutdown", icon: <Power className="h-4 w-4" />, destructive: true, separator: true },
      ];
    case "Suspended":
      return [
        { key: "resume", label: "Resume", icon: <Play className="h-4 w-4" /> },
        { key: "hard_shutdown", label: "Force Shutdown", icon: <Power className="h-4 w-4" />, destructive: true, separator: true },
      ];
    default:
      return [];
  }
}

function VmButton({
  vm,
  hostId,
  selectedVmRef,
  selectHost,
  selectVm,
  navigateHome,
  vmPowerAction,
  vmStartOn,
  conn,
  hostRecords,
  vmMigrate,
  refreshHost,
  onVmDragStart,
  onVmDragEnd,
  availableFolders,
}: {
  vm: XenVM;
  hostId: string;
  selectedVmRef: string | null;
  selectHost: (id: string) => void;
  selectVm: (ref: string) => void;
  navigateHome: () => void;
  vmPowerAction: (hostId: string, vmRef: string, action: string) => Promise<void>;
  vmStartOn: (hostId: string, vmRef: string, targetHostRef: string) => Promise<void>;
  conn: { host: { address: string; port: number; useSsl: boolean }; session: { sessionRef: string } | null; connectedVia?: string };
  hostRecords: XenHostRecord[];
  vmMigrate: (hostId: string, vmRef: string, targetHostRef: string) => Promise<string | null>;
  refreshHost: (hostId: string) => Promise<void>;
  onVmDragStart?: (info: DraggingVm) => void;
  onVmDragEnd?: () => void;
  availableFolders?: string[];
}) {
  const { addTask } = useTask();
  const { role: userRole } = useAuth();
  const isViewerRole = userRole === "viewer";
  const actions = getVmPowerActions(vm.powerState);
  const [pendingAction, setPendingAction] = useState<PowerAction | null>(null);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [targetHost, setTargetHost] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const { state: xenState, selectVm: selectVmCtx } = useXen();
  const fullConn = xenState.connections[hostId];

  const canMigrate = vm.powerState === "Running" && hostRecords.length > 1;
  const migrationTargets = hostRecords.filter((h) => h.ref !== vm.residentOn && h.enabled);

  async function handleMoveToFolder(folderPath: string) {
    try {
      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_set_folder",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          vmRef: vm.ref,
          folder: normalizeFolder(folderPath),
        }),
      });
      refreshHost(hostId);
    } catch (err) {
      console.error("Failed to move VM to folder:", err);
    }
  }

  async function openConsole() {
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
          vmRef: vm.ref,
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
          vmRef: vm.ref,
        });
        window.open(
          `/console?${params}`,
          "_blank",
          "width=1024,height=768,noopener,noreferrer",
        );
      }
    } catch (err) {
      console.error("Console fetch failed:", err);
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            draggable
            onClick={() => {
              selectHost(hostId);
              selectVm(vm.ref);
              navigateHome();
            }}
            onContextMenu={() => {
              selectHost(hostId);
              selectVm(vm.ref);
            }}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              onVmDragStart?.({ vmRef: vm.ref, vmName: vm.nameLabel, hostId, powerState: vm.powerState, residentOn: vm.residentOn, conn });
            }}
            onDragEnd={() => onVmDragEnd?.()}
            className={`flex w-full cursor-grab items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-zinc-100 active:cursor-grabbing dark:hover:bg-zinc-900 ${
              selectedVmRef === vm.ref ? "bg-zinc-100 dark:bg-[var(--shell-nav-active)] dark:text-white" : ""
            }`}
          >
            <Monitor className={`h-3 w-3 shrink-0 ${powerStateMonitorColor[vm.powerState]}`} />
            <span data-sidebar-label className="truncate text-zinc-700 dark:text-zinc-300">
              {vm.nameLabel}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {!isViewerRole && vm.powerState === "Running" && (
            <>
              <ContextMenuItem onClick={openConsole}>
                <Terminal className="h-4 w-4" />
                Console
              </ContextMenuItem>
              {canMigrate && (
                <ContextMenuItem onClick={() => { setTargetHost(""); setMigrateOpen(true); }}>
                  <ArrowRightLeft className="h-4 w-4" />
                  Migrate
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}
          {!isViewerRole && (
            <>
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Power className="h-4 w-4" />
                  Power
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {actions.map((action) => (
                    <React.Fragment key={action.key}>
                      {action.separator && <ContextMenuSeparator />}
                      <ContextMenuItem
                        onClick={() => setPendingAction(action)}
                        variant={action.destructive ? "destructive" : "default"}
                      >
                        {action.icon}
                        {action.label}
                      </ContextMenuItem>
                    </React.Fragment>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
              {vm.powerState === "Halted" && hostRecords.length > 1 && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <Server className="h-4 w-4" />
                    Start on
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {hostRecords.filter((h) => h.enabled).map((h) => (
                      <ContextMenuItem
                        key={h.ref}
                        onClick={() => vmStartOn(hostId, vm.ref, h.ref)}
                      >
                        <Server className="h-4 w-4" />
                        {h.nameLabel}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
              {((availableFolders && availableFolders.length > 0) || vm.otherConfig?.folder) && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <Folder className="h-4 w-4" />
                    Move to Folder
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {vm.otherConfig?.folder && (
                      <>
                        <ContextMenuItem onClick={() => handleMoveToFolder("")}>
                          <FolderOpen className="h-4 w-4" />
                          Remove from Folder
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    )}
                    {availableFolders?.map((folder) => (
                      <ContextMenuItem
                        key={folder}
                        onClick={() => handleMoveToFolder(folder)}
                        disabled={vm.otherConfig?.folder === folder}
                      >
                        <Folder className="h-4 w-4" />
                        {folder}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
              <ContextMenuSeparator />
              {/* XenCenter's Copy VM... and Convert to Template...: a VM that is shut down. */}
              <ContextMenuItem disabled={vm.powerState !== "Halted" || !fullConn} onClick={() => setCopyOpen(true)}>
                <Copy className="h-4 w-4" />
                Copy VM
              </ContextMenuItem>
              <ContextMenuItem disabled={vm.powerState !== "Halted" || !fullConn} onClick={() => setConvertOpen(true)}>
                <LayoutTemplate className="h-4 w-4" />
                Convert to Template
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setSettingsOpen(true)}>
                <Settings className="h-4 w-4" />
                Settings
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {copyOpen && fullConn && (
        <CopyVmDialog conn={fullConn} hostId={hostId} vmRef={vm.ref} vmName={vm.nameLabel} onClose={() => setCopyOpen(false)} />
      )}
      {convertOpen && fullConn && (
        <ConvertToTemplateDialog
          conn={fullConn}
          vmRef={vm.ref}
          vmName={vm.nameLabel}
          onClose={() => setConvertOpen(false)}
          onDone={() => {
            setConvertOpen(false);
            if (selectedVmRef === vm.ref) selectVmCtx(null);
            refreshHost(hostId);
          }}
        />
      )}

      <VmSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        vm={vm}
        hostId={hostId}
        conn={conn}
        onSaved={() => refreshHost(hostId)}
      />

      <AlertDialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
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
              className={pendingAction?.destructive ? "bg-red-600 hover:bg-red-700 text-white" : ""}
              onClick={() => {
                if (pendingAction) {
                  vmPowerAction(hostId, vm.ref, pendingAction.key);
                  setPendingAction(null);
                }
              }}
            >
              {pendingAction?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={migrateOpen} onOpenChange={(open) => { if (!open) setMigrateOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Migrate &quot;{vm.nameLabel}&quot;</DialogTitle>
            <DialogDescription>
              Select the target host for the live migration.
            </DialogDescription>
          </DialogHeader>
          <Select value={targetHost} onValueChange={setTargetHost}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select target host..." />
            </SelectTrigger>
            <SelectContent>
              {migrationTargets.map((h) => (
                <SelectItem key={h.ref} value={h.ref}>
                  <span className="flex items-center gap-2">
                    <Server className="h-3 w-3 text-emerald-500" />
                    {h.nameLabel}
                    <span className="text-xs text-muted-foreground">
                      ({formatBytes(h.memoryFree)} free)
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMigrateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!targetHost}
              onClick={async () => {
                const target = hostRecords.find((h) => h.ref === targetHost);
                const source = hostRecords.find((h) => h.ref === vm.residentOn);
                const taskRef = await vmMigrate(hostId, vm.ref, targetHost);
                setMigrateOpen(false);
                if (taskRef) {
                  addTask({
                    taskRef,
                    hostId,
                    type: "vm_migrate",
                    label: `Migrating ${vm.nameLabel}`,
                    description: `${source?.nameLabel || "?"} → ${target?.nameLabel || "?"}`,
                  });
                }
              }}
            >
              Migrate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HostButton({
  xh,
  hostId,
  selectedXenHostRef,
  selectHost,
  selectXenHost,
  navigateHome,
  conn,
  hostRecords,
  hostMaintenanceEnter,
  hostMaintenanceExit,
  refreshHost,
  isMaster,
  draggingVm,
  onHostDrop,
  onRemoveFromPool,
  children,
}: {
  xh: XenHostRecord;
  hostId: string;
  selectedXenHostRef: string | null;
  selectHost: (id: string) => void;
  selectXenHost: (ref: string) => void;
  navigateHome: () => void;
  conn: { host: { address: string; port: number; useSsl: boolean }; session: { sessionRef: string } | null; connectedVia?: string };
  hostRecords: XenHostRecord[];
  hostMaintenanceEnter: (hostId: string, xenHostRef: string) => Promise<string | null>;
  hostMaintenanceExit: (hostId: string, xenHostRef: string) => Promise<void>;
  refreshHost: (hostId: string) => Promise<void>;
  isMaster?: boolean;
  draggingVm?: DraggingVm | null;
  onHostDrop?: (hostId: string, xenHostRef: string) => void;
  /** XenCenter's Remove From Pool; the dialog lives in the sidebar, as the host leaves the list. */
  onRemoveFromPool?: () => void;
  children?: React.ReactNode;
}) {
  const { addTask } = useTask();
  const { role: userRole } = useAuth();
  const isViewerRole = userRole === "viewer";
  const isAdmin = userRole === "admin";
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmRestartToolstack, setConfirmRestartToolstack] = useState(false);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [createVmOpen, setCreateVmOpen] = useState(false);
  const canEnterMaintenance = xh.enabled && hostRecords.length > 1;
  const canDrop = draggingVm != null
    && draggingVm.hostId === hostId
    && draggingVm.powerState === "Running"
    && xh.enabled
    && xh.ref !== draggingVm.residentOn;

  async function openConsole() {
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
          hostRef: xh.ref,
        }),
      });
      const data = await res.json();
      if (data.available && data.url) {
        const params = new URLSearchParams({
          consoleUrl: data.url,
          sessionId: conn.session!.sessionRef,
          useSsl: String(conn.host.useSsl),
          label: `Console: ${xh.nameLabel}`,
        });
        window.open(
          `/console?${params}`,
          "_blank",
          "width=1024,height=768,noopener,noreferrer",
        );
      }
    } catch (err) {
      console.error("Host console fetch failed:", err);
    }
  }

  async function handleEnterMaintenance() {
    setConfirmOpen(false);
    try {
      const taskRef = await hostMaintenanceEnter(hostId, xh.ref);
      if (taskRef) {
        addTask({
          taskRef,
          hostId,
          type: "host_evacuate",
          label: `Evacuating ${xh.nameLabel}`,
          description: "Migrating all VMs to other hosts",
        });
      }
    } catch (err) {
      console.error("Enter maintenance failed:", err);
    }
  }

  async function handleExitMaintenance() {
    try {
      await hostMaintenanceExit(hostId, xh.ref);
    } catch (err) {
      console.error("Exit maintenance failed:", err);
    }
  }

  async function handleRestartToolstack() {
    setConfirmRestartToolstack(false);
    try {
      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "host_restart_toolstack",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          hostRef: xh.ref,
        }),
      });
    } catch (err) {
      console.error("Restart toolstack failed:", err);
    }
  }

  async function handleShutdown() {
    setConfirmShutdown(false);
    try {
      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "host_shutdown",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          hostRef: xh.ref,
        }),
      });
    } catch (err) {
      console.error("Host shutdown failed:", err);
    }
  }

  async function handleReboot() {
    setConfirmReboot(false);
    try {
      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "host_reboot",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          hostRef: xh.ref,
        }),
      });
    } catch (err) {
      console.error("Host reboot failed:", err);
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={() => {
              selectHost(hostId);
              selectXenHost(xh.ref);
              navigateHome();
            }}
            onContextMenu={() => {
              selectHost(hostId);
              selectXenHost(xh.ref);
            }}
            onDragOver={(e) => { if (canDrop) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
            onDrop={(e) => { e.preventDefault(); if (canDrop) onHostDrop?.(hostId, xh.ref); }}
            className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-900 ${
              selectedXenHostRef === xh.ref
                ? "bg-zinc-100 dark:bg-[var(--shell-nav-active)] dark:text-white"
                : "text-zinc-600 dark:text-zinc-400"
            } ${canDrop ? "ring-2 ring-inset ring-emerald-400/60" : ""}`}
          >
            <Server className={`h-3 w-3 shrink-0 ${xh.enabled ? "text-emerald-500" : xh.otherConfig?.MAINTENANCE_MODE === "true" ? "text-amber-500" : "text-zinc-400"}`} />
            <span data-sidebar-label className="truncate">{xh.nameLabel}</span>
            {isMaster && <Crown className="h-3 w-3 shrink-0 text-amber-500" />}
            <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
              {formatBytes(xh.memoryTotal - xh.memoryFree)} /{" "}
              {formatBytes(xh.memoryTotal)}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {!isViewerRole && (
            <ContextMenuItem onClick={() => setCreateVmOpen(true)}>
              <Plus className="h-4 w-4" />
              New VM
            </ContextMenuItem>
          )}
          {isAdmin && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={openConsole}>
                <Terminal className="h-4 w-4" />
                Console
              </ContextMenuItem>
              <ContextMenuSeparator />
              {xh.enabled ? (
                canEnterMaintenance && (
                  <ContextMenuItem onClick={() => setConfirmOpen(true)}>
                    <Wrench className="h-4 w-4" />
                    Enter Maintenance Mode
                  </ContextMenuItem>
                )
              ) : xh.otherConfig?.MAINTENANCE_MODE === "true" ? (
                <ContextMenuItem onClick={handleExitMaintenance}>
                  <ShieldCheck className="h-4 w-4" />
                  Exit Maintenance Mode
                </ContextMenuItem>
              ) : null}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setConfirmRestartToolstack(true)}>
                <RotateCw className="h-4 w-4" />
                Restart Toolstack
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => setConfirmShutdown(true)}
                className="text-red-600"
              >
                <PowerOff className="h-4 w-4" />
                Shutdown
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => setConfirmReboot(true)}
                className="text-red-600"
              >
                <RotateCw className="h-4 w-4" />
                Reboot
              </ContextMenuItem>
              {onRemoveFromPool && hostRecords.length > 1 && (
                <>
                  <ContextMenuSeparator />
                  {/* RemoveHostFromPoolCommand.CanRun: not the coordinator, no VMs but the control domain. */}
                  <ContextMenuItem disabled={isMaster || xh.residentVMs.length > 1} onClick={onRemoveFromPool} className="text-red-600">
                    <Unlink className="h-4 w-4" />
                    Remove From Pool
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {children}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enter Maintenance Mode</AlertDialogTitle>
            <AlertDialogDescription>
              This will disable <strong>{xh.nameLabel}</strong> and migrate all
              running VMs to other available hosts. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleEnterMaintenance}>
              Enter Maintenance
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRestartToolstack} onOpenChange={setConfirmRestartToolstack}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart Toolstack</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to restart the toolstack on <strong>{xh.nameLabel}</strong>?
              The connection to this server will be temporarily lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestartToolstack}>
              Restart Toolstack
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmShutdown} onOpenChange={setConfirmShutdown}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Shutdown &quot;{xh.nameLabel}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will shut down <strong>{xh.nameLabel}</strong>. The server will become
              unreachable until manually powered on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={handleShutdown}
            >
              Shutdown
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReboot} onOpenChange={setConfirmReboot}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reboot &quot;{xh.nameLabel}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will reboot <strong>{xh.nameLabel}</strong>. The server will be
              temporarily unreachable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={handleReboot}
            >
              Reboot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateVmDialog
        open={createVmOpen}
        onOpenChange={setCreateVmOpen}
        hostId={hostId}
        conn={conn}
        hostRecords={hostRecords}
        targetHostRef={xh.ref}
        onCreated={() => refreshHost(hostId)}
      />
    </>
  );
}

// ── Folder tree helpers ─────────────────────────────────────────────────

interface FolderNode {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
  vms: XenVM[];
}

function buildFolderTree(vms: XenVM[], emptyFolderPaths: string[] = []): { root: FolderNode; unfoldered: XenVM[] } {
  const root: FolderNode = { name: "", path: "", children: new Map(), vms: [] };
  const unfoldered: XenVM[] = [];

  for (const vm of vms) {
    const folder = vm.otherConfig?.folder?.trim();
    if (!folder) { unfoldered.push(vm); continue; }
    const parts = folder.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length === 0) { unfoldered.push(vm); continue; }

    let current = root;
    for (const part of parts) {
      if (!current.children.has(part)) {
        const p = current.path ? `${current.path}/${part}` : part;
        current.children.set(part, { name: part, path: p, children: new Map(), vms: [] });
      }
      current = current.children.get(part)!;
    }
    current.vms.push(vm);
  }

  for (const path of emptyFolderPaths) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;
    for (const part of parts) {
      if (!current.children.has(part)) {
        const p = current.path ? `${current.path}/${part}` : part;
        current.children.set(part, { name: part, path: p, children: new Map(), vms: [] });
      }
      current = current.children.get(part)!;
    }
  }

  return { root, unfoldered };
}

function FolderTreeNode({
  node, depth, expandedFolders, toggleFolder,
  hostId, selectedVmRef, selectHost, selectVm, navigateHome,
  vmPowerAction, vmStartOn, conn, hostRecords, vmMigrate, refreshHost,
  draggingVm, onFolderDrop, onVmDragStart, onVmDragEnd, availableFolders, onDeleteFolder,
}: {
  node: FolderNode;
  depth: number;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
  hostId: string;
  selectedVmRef: string | null;
  selectHost: (id: string) => void;
  selectVm: (ref: string) => void;
  navigateHome: () => void;
  vmPowerAction: (hostId: string, vmRef: string, action: string) => Promise<void>;
  vmStartOn: (hostId: string, vmRef: string, targetHostRef: string) => Promise<void>;
  conn: { host: { address: string; port: number; useSsl: boolean }; session: { sessionRef: string } | null; connectedVia?: string };
  hostRecords: XenHostRecord[];
  vmMigrate: (hostId: string, vmRef: string, targetHostRef: string) => Promise<string | null>;
  refreshHost: (hostId: string) => Promise<void>;
  draggingVm?: DraggingVm | null;
  onFolderDrop?: (path: string) => void;
  onVmDragStart?: (info: DraggingVm) => void;
  onVmDragEnd?: () => void;
  availableFolders?: string[];
  onDeleteFolder?: (path: string) => void;
}) {
  const isOpen = expandedFolders.has(node.path);
  const sortedChildren = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEmpty = node.vms.length === 0 && node.children.size === 0;

  const folderButton = (
    <button
      onClick={() => toggleFolder(node.path)}
      onDragOver={(e) => {
        if (!draggingVm) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!isOpen && !expandTimerRef.current) {
          expandTimerRef.current = setTimeout(() => {
            toggleFolder(node.path);
            expandTimerRef.current = null;
          }, 700);
        }
      }}
      onDragLeave={() => {
        if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
        onFolderDrop?.(node.path);
      }}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900 ${draggingVm ? "ring-2 ring-inset ring-amber-400/60" : ""}`}
    >
      {isOpen ? (
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      ) : (
        <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      )}
      <span data-sidebar-label className="truncate font-medium">{node.name}</span>
      {isOpen ? <ChevronDown className="ml-auto h-3 w-3 shrink-0" /> : <ChevronRight className="ml-auto h-3 w-3 shrink-0" />}
    </button>
  );

  return (
    <>
      {isEmpty && onDeleteFolder ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{folderButton}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onDeleteFolder(node.path)}>
              <FolderX className="h-4 w-4" />
              Delete Folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : folderButton}
      {isOpen && (
        <>
          {sortedChildren.map((child) => (
            <FolderTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              hostId={hostId}
              selectedVmRef={selectedVmRef}
              selectHost={selectHost}
              selectVm={selectVm}
              navigateHome={navigateHome}
              vmPowerAction={vmPowerAction}
              vmStartOn={vmStartOn}
              conn={conn}
              hostRecords={hostRecords}
              vmMigrate={vmMigrate}
              refreshHost={refreshHost}
              draggingVm={draggingVm}
              onFolderDrop={onFolderDrop}
              onVmDragStart={onVmDragStart}
              onVmDragEnd={onVmDragEnd}
              availableFolders={availableFolders}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
          {sortVms(node.vms).map((vm) => (
            <div key={vm.ref} style={{ paddingLeft: `${(depth + 1) * 12}px` }}>
              <VmButton vm={vm} hostId={hostId} selectedVmRef={selectedVmRef} selectHost={selectHost} selectVm={selectVm} navigateHome={navigateHome} vmPowerAction={vmPowerAction} vmStartOn={vmStartOn} conn={conn} hostRecords={hostRecords} vmMigrate={vmMigrate} refreshHost={refreshHost} onVmDragStart={onVmDragStart} onVmDragEnd={onVmDragEnd} availableFolders={availableFolders} />
            </div>
          ))}
        </>
      )}
    </>
  );
}

// ── Unified folder tree helpers (folder-only cross-pool mode) ──────────────────

type ConnSnapshot = {
  host: { address: string; port: number; useSsl: boolean };
  session: { sessionRef: string } | null;
  connectedVia?: string;
};

type EnrichedVM = {
  vm: XenVM;
  hostId: string;
  conn: ConnSnapshot;
  hostRecords: XenHostRecord[];
};

interface UnifiedFolderNode {
  name: string;
  path: string;
  children: Map<string, UnifiedFolderNode>;
  vms: EnrichedVM[];
}

function buildUnifiedFolderTree(items: EnrichedVM[], emptyFolderPaths: string[] = []): { root: UnifiedFolderNode; unfoldered: EnrichedVM[] } {
  const root: UnifiedFolderNode = { name: "", path: "", children: new Map(), vms: [] };
  const unfoldered: EnrichedVM[] = [];
  for (const item of items) {
    const folder = item.vm.otherConfig?.folder?.trim();
    if (!folder) { unfoldered.push(item); continue; }
    const parts = folder.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length === 0) { unfoldered.push(item); continue; }
    let current = root;
    for (const part of parts) {
      if (!current.children.has(part)) {
        const p = current.path ? `${current.path}/${part}` : part;
        current.children.set(part, { name: part, path: p, children: new Map(), vms: [] });
      }
      current = current.children.get(part)!;
    }
    current.vms.push(item);
  }
  for (const path of emptyFolderPaths) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;
    for (const part of parts) {
      if (!current.children.has(part)) {
        const p = current.path ? `${current.path}/${part}` : part;
        current.children.set(part, { name: part, path: p, children: new Map(), vms: [] });
      }
      current = current.children.get(part)!;
    }
  }
  return { root, unfoldered };
}

function sortEnrichedVms(list: EnrichedVM[]): EnrichedVM[] {
  return [...list].sort(
    (a, b) =>
      vmSortOrder[a.vm.powerState] - vmSortOrder[b.vm.powerState] ||
      a.vm.nameLabel.localeCompare(b.vm.nameLabel),
  );
}

function UnifiedFolderTreeNode({
  node, depth, expandedFolders, toggleFolder,
  selectedVmRef, selectHost, selectVm, navigateHome,
  vmPowerAction, vmStartOn, vmMigrate, refreshHost,
  draggingVm, onFolderDrop, onVmDragStart, onVmDragEnd, availableFolders, onDeleteFolder,
}: {
  node: UnifiedFolderNode;
  depth: number;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
  selectedVmRef: string | null;
  selectHost: (id: string) => void;
  selectVm: (ref: string) => void;
  navigateHome: () => void;
  vmPowerAction: (hostId: string, vmRef: string, action: string) => Promise<void>;
  vmStartOn: (hostId: string, vmRef: string, targetHostRef: string) => Promise<void>;
  vmMigrate: (hostId: string, vmRef: string, targetHostRef: string) => Promise<string | null>;
  refreshHost: (hostId: string) => Promise<void>;
  draggingVm?: DraggingVm | null;
  onFolderDrop?: (path: string) => void;
  onVmDragStart?: (info: DraggingVm) => void;
  onVmDragEnd?: () => void;
  availableFolders?: string[];
  onDeleteFolder?: (path: string) => void;
}) {
  const isOpen = expandedFolders.has(node.path);
  const sortedChildren = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEmpty = node.vms.length === 0 && node.children.size === 0;

  const folderButton = (
    <button
      onClick={() => toggleFolder(node.path)}
      onDragOver={(e) => {
        if (!draggingVm) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!isOpen && !expandTimerRef.current) {
          expandTimerRef.current = setTimeout(() => {
            toggleFolder(node.path);
            expandTimerRef.current = null;
          }, 700);
        }
      }}
      onDragLeave={() => {
        if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
        onFolderDrop?.(node.path);
      }}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900 ${draggingVm ? "ring-2 ring-inset ring-amber-400/60" : ""}`}
    >
      {isOpen ? (
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      ) : (
        <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      )}
      <span data-sidebar-label className="truncate font-medium">{node.name}</span>
      {isOpen ? <ChevronDown className="ml-auto h-3 w-3 shrink-0" /> : <ChevronRight className="ml-auto h-3 w-3 shrink-0" />}
    </button>
  );

  return (
    <>
      {isEmpty && onDeleteFolder ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{folderButton}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onDeleteFolder(node.path)}>
              <FolderX className="h-4 w-4" />
              Delete Folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : folderButton}
      {isOpen && (
        <>
          {sortedChildren.map((child) => (
            <UnifiedFolderTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              selectedVmRef={selectedVmRef}
              selectHost={selectHost}
              selectVm={selectVm}
              navigateHome={navigateHome}
              vmPowerAction={vmPowerAction}
              vmStartOn={vmStartOn}
              vmMigrate={vmMigrate}
              refreshHost={refreshHost}
              draggingVm={draggingVm}
              onFolderDrop={onFolderDrop}
              onVmDragStart={onVmDragStart}
              onVmDragEnd={onVmDragEnd}
              availableFolders={availableFolders}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
          {sortEnrichedVms(node.vms).map(({ vm, hostId, conn, hostRecords }) => (
            <div key={vm.ref} style={{ paddingLeft: `${(depth + 1) * 12}px` }}>
              <VmButton vm={vm} hostId={hostId} selectedVmRef={selectedVmRef} selectHost={selectHost} selectVm={selectVm} navigateHome={navigateHome} vmPowerAction={vmPowerAction} vmStartOn={vmStartOn} conn={conn} hostRecords={hostRecords} vmMigrate={vmMigrate} refreshHost={refreshHost} onVmDragStart={onVmDragStart} onVmDragEnd={onVmDragEnd} availableFolders={availableFolders} />
            </div>
          ))}
        </>
      )}
    </>
  );
}

function NewFolderDialog({ open, onOpenChange, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const invalid = !name.trim() || name.includes("/") || name.includes(";");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Folder</DialogTitle>
          <DialogDescription>Enter a name for the new folder.</DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Folder name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !invalid) { onConfirm(name.trim()); setName(""); }
          }}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => { onOpenChange(false); setName(""); }}>Cancel</Button>
          <Button disabled={invalid} onClick={() => { onConfirm(name.trim()); setName(""); }}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "docked": beside the content, sized to it and resizable (a wide screen).
 * "drawer": filling the slide-in panel on a phone (app-shell.tsx).
 */
/** One entry of the navigation: a link to a page, or a button. */
function NavItem({
  icon: Icon,
  label,
  href,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const className = `flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
    active
      ? "bg-[var(--shell-nav-active)] font-medium text-white"
      : "text-zinc-300 hover:bg-[var(--shell-nav-hover)] hover:text-white"
  }`;
  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  );
}

export function Sidebar({ variant = "docked" }: { variant?: "docked" | "drawer" } = {}) {
  const drawer = variant === "drawer";
  const {
    state,
    connectToHost,
    disconnectFromHost,
    refreshHost,
    selectHost,
    selectVm,
    selectXenHost,
    vmPowerAction,
    vmStartOn,
    vmMigrate,
    hostMaintenanceEnter,
    hostMaintenanceExit,
    adoptHost,
  } = useXen();
  const { role } = useAuth();
  const { addTask } = useTask();
  const { sidebarView, sidebarLayout, searchMode: rawSearchMode } = useTheme();
  const searchMode = sidebarView === "hosts-only" ? "dropdown" : rawSearchMode;
  const isViewer = role === "viewer";
  const router = useRouter();
  const pathname = usePathname();
  const [expandedHosts, setExpandedHosts] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const widthRef = useRef(DEFAULT_WIDTH);
  const [searchQuery, setSearchQuery] = useState("");
  const [createVmPoolId, setCreateVmPoolId] = useState<string | null>(null);
  const [licenseOpen, setLicenseOpen] = useState(false);
  // Add Server (pool) and Remove From Pool (host), as XenCenter's Pool and Server menus.
  const [addServerPoolId, setAddServerPoolId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ hostId: string; ref: string; name: string; poolName: string } | null>(null);
  const [newFolderPoolId, setNewFolderPoolId] = useState<string | null>(null);
  const [draggingVm, setDraggingVm] = useState<DraggingVm | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const sidebarRef = useRef<HTMLElement>(null);

  const navigateHome = useCallback(() => {
    if (pathname !== "/") router.push("/");
  }, [pathname, router]);

  const handleVmDragStart = useCallback((info: DraggingVm) => {
    setDraggingVm(info);
  }, []);

  const handleVmDragEnd = useCallback(() => {
    setDraggingVm(null);
  }, []);

  const handleFolderDrop = useCallback(async (folderPath: string) => {
    if (!draggingVm) return;
    const { vmRef, hostId, conn } = draggingVm;
    setDraggingVm(null);
    try {
      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_set_folder",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session!.sessionRef,
          vmRef,
          folder: normalizeFolder(folderPath),
        }),
      });
      refreshHost(hostId);
    } catch (err) {
      console.error("Failed to set folder via drag:", err);
    }
  }, [draggingVm, refreshHost]);

  const handleHostDrop = useCallback(async (hostId: string, targetXenHostRef: string) => {
    if (!draggingVm || draggingVm.hostId !== hostId) return;
    const { vmRef, vmName, residentOn } = draggingVm;
    setDraggingVm(null);
    const conn = state.connections[hostId];
    const hostRecords = conn?.status === "connected" ? Object.values(conn.hostRecords) : [];
    const target = hostRecords.find(h => h.ref === targetXenHostRef);
    const source = hostRecords.find(h => h.ref === residentOn);
    const taskRef = await vmMigrate(hostId, vmRef, targetXenHostRef);
    if (taskRef) {
      addTask({
        taskRef,
        hostId,
        type: "vm_migrate",
        label: `Migrating ${vmName}`,
        description: `${source?.nameLabel || "?"} → ${target?.nameLabel || "?"}`,
      });
    }
  }, [draggingVm, vmMigrate, state.connections, addTask]);

  const handleCreateFolder = useCallback(async (
    hostId: string, poolRef: string, currentFolders: string[],
    conn: { host: { address: string; port: number; useSsl: boolean }; session: { sessionRef: string } | null; connectedVia?: string },
    name: string,
  ) => {
    const normalized = normalizeFolder(name);
    if (!normalized || currentFolders.includes(normalized)) return;
    await fetch("/api/xen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "pool_set_empty_folders",
        host: conn.connectedVia || conn.host.address, port: conn.host.port,
        useSsl: conn.host.useSsl, sessionRef: conn.session!.sessionRef,
        poolRef, folders: [...currentFolders, normalized],
      }),
    });
    refreshHost(hostId);
  }, [refreshHost]);

  const handleDeleteFolder = useCallback(async (
    hostId: string, poolRef: string, currentFolders: string[],
    conn: { host: { address: string; port: number; useSsl: boolean }; session: { sessionRef: string } | null; connectedVia?: string },
    path: string,
  ) => {
    await fetch("/api/xen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "pool_set_empty_folders",
        host: conn.connectedVia || conn.host.address, port: conn.host.port,
        useSsl: conn.host.useSsl, sessionRef: conn.session!.sessionRef,
        poolRef, folders: currentFolders.filter(f => f !== path),
      }),
    });
    refreshHost(hostId);
  }, [refreshHost]);

  // Auto-fit sidebar width to content
  const contentSignatureRef = useRef("");
  useLayoutEffect(() => {
    const aside = sidebarRef.current;
    // In the drawer the panel decides the width.
    if (!aside || drawer) return;

    const labels = aside.querySelectorAll("[data-sidebar-label]");
    if (labels.length === 0) return;

    // Content signature check — skip if nothing changed
    const sig = Array.from(labels).map((el) => el.textContent).join("\n");
    if (sig === contentSignatureRef.current) return;
    contentSignatureRef.current = sig;

    // Temporarily shrink to MIN_WIDTH so the ScrollArea viewport's scrollWidth
    // reflects max(MIN_WIDTH, natural_content_width). The Radix ScrollArea uses
    // display:table internally which expands to max-content regardless of the
    // aside width — so span.getBoundingClientRect() is unreliable here.
    // viewport.scrollWidth correctly reports the full natural content width
    // even when overflow-x:hidden clips it visually.
    aside.style.width = `${MIN_WIDTH}px`;
    void aside.offsetWidth; // force synchronous layout

    const viewport = aside.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    const needed = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, viewport ? Math.ceil(viewport.scrollWidth) : DEFAULT_WIDTH));

    aside.style.width = `${needed}px`;
    widthRef.current = needed;
  });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDragging.current || !sidebarRef.current) return;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
      sidebarRef.current.style.width = `${newWidth}px`;
      widthRef.current = newWidth;
    }

    function onMouseUp() {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const toggleHost = (hostId: string) => {
    setExpandedHosts((prev) => ({ ...prev, [hostId]: !prev[hostId] }));
  };

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Search results
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return { vms: [], hosts: [] };

    const vmResults: { hostId: string; hostName: string; vm: XenVM }[] = [];
    const hostResults: { hostId: string; hostName: string; xh: XenHostRecord }[] = [];

    for (const host of state.hosts) {
      const conn = state.connections[host.id];
      if (conn?.status !== "connected") continue;

      for (const vm of Object.values(conn.vms)) {
        if (
          vm.nameLabel.toLowerCase().includes(q) ||
          vm.nameDescription.toLowerCase().includes(q) ||
          vm.tags.some((t) => t.toLowerCase().includes(q))
        ) {
          vmResults.push({ hostId: host.id, hostName: host.name, vm });
        }
      }

      for (const xh of Object.values(conn.hostRecords)) {
        if (
          xh.nameLabel.toLowerCase().includes(q) ||
          xh.hostname.toLowerCase().includes(q) ||
          xh.address.toLowerCase().includes(q)
        ) {
          hostResults.push({ hostId: host.id, hostName: host.name, xh });
        }
      }
    }

    return { vms: vmResults, hosts: hostResults };
  }, [searchQuery, state.hosts, state.connections]);

  const hasResults = searchResults.vms.length > 0 || searchResults.hosts.length > 0;
  const showDropdown = searchQuery.trim().length > 0;

  function highlightMatch(text: string) {
    const q = searchQuery.trim();
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <strong className="font-bold text-zinc-900 dark:text-zinc-100">{text.slice(idx, idx + q.length)}</strong>
        {text.slice(idx + q.length)}
      </>
    );
  }

  // Close dropdown on click outside (only in dropdown mode)
  useEffect(() => {
    if (searchMode !== "dropdown") return;
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchQuery("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [searchMode]);

  return (
    <aside
      ref={sidebarRef}
      style={drawer ? undefined : { width: widthRef.current }}
      className={
        drawer
          ? "shell-nav dark relative flex h-full w-full flex-col"
          : "shell-nav dark relative flex h-full shrink-0 flex-col"
      }
    >
      <div className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        Pools
      </div>

      {/* Search */}
      <div ref={searchRef} className="relative shrink-0 px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            placeholder="Search VMs, Hosts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchQuery("");
            }}
            className="h-7 pl-7 pr-7 text-xs"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Search Results Dropdown */}
        {showDropdown && searchMode === "dropdown" && (
          <div className="absolute left-0 right-0 top-full z-50 mx-2 max-h-64 overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            {!hasResults ? (
              <div className="px-3 py-4 text-center text-xs text-zinc-400">
                No results found
              </div>
            ) : (
              <>
                {searchResults.vms.length > 0 && (
                  <div>
                    <div className="sticky top-0 bg-zinc-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:bg-zinc-800">
                      VMs
                    </div>
                    {searchResults.vms.map((r) => (
                      <button
                        key={r.vm.ref}
                        onClick={() => {
                          selectHost(r.hostId);
                          selectVm(r.vm.ref);
                          navigateHome();
                          setSearchQuery("");
                        }}
                        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <Monitor className={`h-3 w-3 shrink-0 ${powerStateMonitorColor[r.vm.powerState]}`} />
                        <span className="truncate text-zinc-700 dark:text-zinc-300">
                          {highlightMatch(r.vm.nameLabel)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {searchResults.hosts.length > 0 && (
                  <div>
                    <div className="sticky top-0 bg-zinc-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:bg-zinc-800">
                      Hosts
                    </div>
                    {searchResults.hosts.map((r) => (
                      <button
                        key={r.xh.ref}
                        onClick={() => {
                          selectHost(r.hostId);
                          selectXenHost(r.xh.ref);
                          navigateHome();
                          setSearchQuery("");
                        }}
                        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <Server className="h-3 w-3 shrink-0 text-zinc-400" />
                        <span className="truncate text-zinc-700 dark:text-zinc-300">
                          {highlightMatch(r.xh.nameLabel)}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
                          {r.hostName}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Host List - scrollable */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {sidebarView === "folder-only" ? (
            /* ── Folder Only: unified cross-pool VM folder tree ── */
            (() => {
              const filterQuery = searchQuery.trim().toLowerCase();
              const allEnrichedVms: EnrichedVM[] = [];
              for (const host of state.hosts) {
                const conn = state.connections[host.id];
                if (conn?.status !== "connected") continue;
                const hostRecords = Object.values(conn.hostRecords);
                for (const vm of Object.values(conn.vms)) {
                  if (!filterQuery ||
                    vm.nameLabel.toLowerCase().includes(filterQuery) ||
                    vm.nameDescription.toLowerCase().includes(filterQuery) ||
                    vm.tags.some((t) => t.toLowerCase().includes(filterQuery))) {
                    allEnrichedVms.push({ vm, hostId: host.id, conn, hostRecords });
                  }
                }
              }
              if (state.hosts.length === 0) {
                return (
                  <EmptySidebarNotice role={role} />
                );
              }
              const allEmptyFolders = state.hosts.flatMap((h) => {
                const c = state.connections[h.id];
                if (c?.status !== "connected") return [];
                return Object.values(c.pools)[0]?.emptyFolders ?? [];
              });
              // Map from empty-folder path → the pool that owns it (first match wins)
              const emptyFolderToPool = new Map<string, { hostId: string; poolRef: string; conn: typeof state.connections[string]; currentFolders: string[] }>();
              for (const h of state.hosts) {
                const c = state.connections[h.id];
                if (c?.status !== "connected") continue;
                const pool = Object.values(c.pools)[0];
                if (!pool) continue;
                for (const folder of pool.emptyFolders) {
                  if (!emptyFolderToPool.has(folder))
                    emptyFolderToPool.set(folder, { hostId: h.id, poolRef: pool.ref, conn: c, currentFolders: pool.emptyFolders });
                }
              }
              if (allEnrichedVms.length === 0 && allEmptyFolders.length === 0) {
                return <div className="px-2 py-2 text-xs text-zinc-400">{filterQuery ? "No VMs match filter" : "No VMs found"}</div>;
              }
              const { root, unfoldered } = buildUnifiedFolderTree(allEnrichedVms, allEmptyFolders);
              const sortedFolders = [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name));
              const availableFolders = getUniqueFolders(allEnrichedVms.map(e => e.vm));
              return (
                <>
                  {sortedFolders.map((folder) => (
                    <UnifiedFolderTreeNode
                      key={folder.path}
                      node={folder}
                      depth={0}
                      expandedFolders={expandedFolders}
                      toggleFolder={toggleFolder}
                      selectedVmRef={state.selectedVmRef}
                      selectHost={selectHost}
                      selectVm={selectVm}
                      navigateHome={navigateHome}
                      vmPowerAction={vmPowerAction}
                      vmStartOn={vmStartOn}
                      vmMigrate={vmMigrate}
                      refreshHost={refreshHost}
                      draggingVm={draggingVm}
                      onFolderDrop={handleFolderDrop}
                      onVmDragStart={handleVmDragStart}
                      onVmDragEnd={handleVmDragEnd}
                      availableFolders={availableFolders}
                      onDeleteFolder={(path) => {
                        const info = emptyFolderToPool.get(path);
                        if (info) handleDeleteFolder(info.hostId, info.poolRef, info.currentFolders, info.conn, path);
                      }}
                    />
                  ))}
                  {sortEnrichedVms(unfoldered).map(({ vm, hostId, conn, hostRecords }) => (
                    <VmButton key={vm.ref} vm={vm} hostId={hostId} selectedVmRef={state.selectedVmRef} selectHost={selectHost} selectVm={selectVm} navigateHome={navigateHome} vmPowerAction={vmPowerAction} vmStartOn={vmStartOn} conn={conn} hostRecords={hostRecords} vmMigrate={vmMigrate} refreshHost={refreshHost} onVmDragStart={handleVmDragStart} onVmDragEnd={handleVmDragEnd} availableFolders={availableFolders} />
                  ))}
                </>
              );
            })()
          ) : state.hosts.length === 0 ? (
            <EmptySidebarNotice role={role} />
          ) : (
            [...state.hosts].sort((a, b) => {
              const connA = state.connections[a.id];
              const connB = state.connections[b.id];
              const nameA = (connA?.status === "connected" ? Object.values(connA.pools)[0]?.nameLabel : null) || a.name;
              const nameB = (connB?.status === "connected" ? Object.values(connB.pools)[0]?.nameLabel : null) || b.name;
              return nameA.localeCompare(nameB);
            }).map((host) => {
              const conn = state.connections[host.id];
              const isConnected = conn?.status === "connected";
              const isConnecting = conn?.status === "connecting";
              const filterQuery = searchMode === "filter" ? searchQuery.trim().toLowerCase() : "";
              const isExpanded = filterQuery ? true : (expandedHosts[host.id] ?? isConnected);
              const pools = isConnected ? Object.values(conn.pools) : [];
              const poolName = pools.length > 0 ? pools[0].nameLabel : null;
              const displayName = (isConnected && poolName) ? poolName : host.name;
              const poolRef = pools.length > 0 ? pools[0].ref : "";
              const emptyFolders = pools.length > 0 ? pools[0].emptyFolders : [];
              const allVms = isConnected ? Object.values(conn.vms) : [];
              const availableFolders = getUniqueFolders(allVms);
              const xenHosts = isConnected
                ? Object.values(conn.hostRecords)
                : [];
              const vmMatchesFilter = (vm: XenVM) =>
                vm.nameLabel.toLowerCase().includes(filterQuery) ||
                vm.nameDescription.toLowerCase().includes(filterQuery) ||
                vm.tags.some((t) => t.toLowerCase().includes(filterQuery));
              const hostMatchesFilter = (xh: XenHostRecord) =>
                xh.nameLabel.toLowerCase().includes(filterQuery) ||
                xh.hostname.toLowerCase().includes(filterQuery) ||
                xh.address.toLowerCase().includes(filterQuery);
              const vms = filterQuery
                ? allVms.filter(vmMatchesFilter)
                : allVms;
              const poolMasterRef = pools.length > 0 ? pools[0].master : null;
              // Host.CompareTo in XenCenter: the coordinator first, then by name (numbers as numbers).
              const sortedXenHosts = [...xenHosts].sort(
                (a, b) =>
                  Number(b.ref === poolMasterRef) - Number(a.ref === poolMasterRef) ||
                  a.nameLabel.localeCompare(b.nameLabel, undefined, { numeric: true, sensitivity: "base" }),
              );
              const filteredXenHosts = filterQuery
                ? sortedXenHosts.filter((xh) =>
                    hostMatchesFilter(xh) ||
                    allVms.some((vm) => vm.residentOn === xh.ref && vmMatchesFilter(vm))
                  )
                : sortedXenHosts;
              const runningVms = allVms.filter(
                (vm) => vm.powerState === "Running",
              ).length;

              // Hide pool entirely if filter is active and nothing matches
              if (filterQuery && vms.length === 0 && filteredXenHosts.length === 0) return null;

              return (
                <div key={host.id} className="mb-1">
                  {/* Host Header */}
                  <ContextMenu>
                  <ContextMenuTrigger asChild>
                  <div
                    className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-900 ${
                      state.selectedHostId === host.id && !state.selectedXenHostRef && !state.selectedVmRef
                        ? "bg-zinc-100 dark:bg-[var(--shell-nav-active)] dark:text-white"
                        : ""
                    }`}
                  >
                    <button
                      onClick={() => toggleHost(host.id)}
                      className="-ml-1 flex items-center p-1 text-zinc-400"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>

                    <button
                      onClick={() => {
                        selectHost(host.id);
                        navigateHome();
                      }}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <div
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          isConnected
                            ? "bg-emerald-500"
                            : isConnecting
                              ? "bg-amber-500 animate-pulse"
                              : conn?.status === "error"
                                ? "bg-red-500"
                                : "bg-zinc-300 dark:bg-zinc-600"
                        }`}
                      />
                      <span data-sidebar-label className="truncate font-medium text-zinc-700 dark:text-zinc-300">
                        {displayName}
                      </span>
                      {isConnected && <XenUpdatesBadge hostId={host.id} />}
                      {isConnected && (
                        <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
                          {runningVms}/{vms.length}
                        </span>
                      )}
                    </button>

                    {/* Shown on hover -- and always where there is no hover, on a touch screen. */}
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity [@media(hover:none)]:opacity-100">
                      {isConnected ? (
                        <>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => refreshHost(host.id)}
                                className="rounded p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                              >
                                <RefreshCw className="h-3 w-3" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              Refresh
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => disconnectFromHost(host.id)}
                                className="rounded p-0.5 text-zinc-400 hover:text-red-500"
                              >
                                <PlugZap className="h-3 w-3" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              Disconnect
                            </TooltipContent>
                          </Tooltip>
                        </>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => connectToHost(host.id)}
                              disabled={isConnecting}
                              className="rounded p-0.5 text-zinc-400 hover:text-emerald-500 disabled:opacity-50"
                            >
                              <Plug className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right">Connect</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  </ContextMenuTrigger>
                  {isConnected && !isViewer && (
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setCreateVmPoolId(host.id)}>
                        <Plus className="h-4 w-4" />
                        New VM
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => setNewFolderPoolId(host.id)}>
                        <FolderPlus className="h-4 w-4" />
                        New Folder
                      </ContextMenuItem>
                      {role === "admin" && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={() => setAddServerPoolId(host.id)}>
                            <ServerCog className="h-4 w-4" />
                            Add Server
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  )}
                  </ContextMenu>

                  {/* Error */}
                  {conn?.status === "error" && conn.error && (
                    <div className="ml-6 mr-2 mt-0.5 rounded bg-red-50 px-2 py-1 text-[10px] text-red-600 dark:bg-red-950/50 dark:text-red-400">
                      {conn.error}
                    </div>
                  )}

                  {/* Expanded Content */}
                  {isExpanded && isConnected && (
                    <div className="ml-3 mt-0.5">
                      {sidebarView === "folder-view" ? (
                        /* ── Folder View: Hosts flat + VMs in folder tree ── */
                        (() => {
                          const { root, unfoldered } = buildFolderTree(vms, emptyFolders);
                          const sortedFolders = [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name));
                          return (
                            <>
                              {xenHosts.length >= 1 && (
                                <>
                                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                                    Hosts
                                  </div>
                                  {filteredXenHosts.map((xh) => (
                                    <HostButton key={xh.ref} xh={xh} hostId={host.id} selectedXenHostRef={state.selectedXenHostRef} selectHost={selectHost} selectXenHost={selectXenHost} navigateHome={navigateHome} conn={conn} hostRecords={xenHosts} hostMaintenanceEnter={hostMaintenanceEnter} hostMaintenanceExit={hostMaintenanceExit} refreshHost={refreshHost} isMaster={xh.ref === poolMasterRef} draggingVm={draggingVm} onHostDrop={handleHostDrop} onRemoveFromPool={role === "admin" ? () => setRemoving({ hostId: host.id, ref: xh.ref, name: xh.nameLabel, poolName: pools[0]?.nameLabel || host.name }) : undefined} />
                                  ))}
                                  <Separator className="my-1" />
                                </>
                              )}
                              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                                Virtual Machines
                              </div>
                              {vms.length === 0 && emptyFolders.length === 0 ? (
                                <div className="px-2 py-2 text-xs text-zinc-400">No VMs found</div>
                              ) : (
                                <>
                                  {sortedFolders.map((folder) => (
                                    <FolderTreeNode
                                      key={folder.path}
                                      node={folder}
                                      depth={0}
                                      expandedFolders={expandedFolders}
                                      toggleFolder={toggleFolder}
                                      hostId={host.id}
                                      selectedVmRef={state.selectedVmRef}
                                      selectHost={selectHost}
                                      selectVm={selectVm}
                                      navigateHome={navigateHome}
                                      vmPowerAction={vmPowerAction}
                                      vmStartOn={vmStartOn}
                                      conn={conn}
                                      hostRecords={xenHosts}
                                      vmMigrate={vmMigrate}
                                      refreshHost={refreshHost}
                                      draggingVm={draggingVm}
                                      onFolderDrop={handleFolderDrop}
                                      onVmDragStart={handleVmDragStart}
                                      onVmDragEnd={handleVmDragEnd}
                                      availableFolders={availableFolders}
                                      onDeleteFolder={(path) => handleDeleteFolder(host.id, poolRef, emptyFolders, conn, path)}
                                    />
                                  ))}
                                  {sortVms(unfoldered).map((vm) => (
                                    <VmButton key={vm.ref} vm={vm} hostId={host.id} selectedVmRef={state.selectedVmRef} selectHost={selectHost} selectVm={selectVm} navigateHome={navigateHome} vmPowerAction={vmPowerAction} vmStartOn={vmStartOn} conn={conn} hostRecords={xenHosts} vmMigrate={vmMigrate} refreshHost={refreshHost} onVmDragStart={handleVmDragStart} onVmDragEnd={handleVmDragEnd} availableFolders={availableFolders} />
                                  ))}
                                </>
                              )}
                            </>
                          );
                        })()
                      ) : sidebarLayout === "tree" && sidebarView === "hosts-and-vms" && xenHosts.length >= 1 ? (
                        /* ── Tree View: VMs nested under their hosts ── */
                        <>
                          {filteredXenHosts.map((xh) => {
                            const hostVms = sortVms(vms.filter((vm) => vm.residentOn === xh.ref));
                            return (
                              <div key={xh.ref}>
                                <HostButton xh={xh} hostId={host.id} selectedXenHostRef={state.selectedXenHostRef} selectHost={selectHost} selectXenHost={selectXenHost} navigateHome={navigateHome} conn={conn} hostRecords={xenHosts} hostMaintenanceEnter={hostMaintenanceEnter} hostMaintenanceExit={hostMaintenanceExit} refreshHost={refreshHost} isMaster={xh.ref === poolMasterRef} draggingVm={draggingVm} onHostDrop={handleHostDrop} onRemoveFromPool={role === "admin" ? () => setRemoving({ hostId: host.id, ref: xh.ref, name: xh.nameLabel, poolName: pools[0]?.nameLabel || host.name }) : undefined}>
                                  {hostVms.length > 0 && (
                                    <div className="ml-3">
                                      {hostVms.map((vm) => (
                                        <VmButton key={vm.ref} vm={vm} hostId={host.id} selectedVmRef={state.selectedVmRef} selectHost={selectHost} selectVm={selectVm} navigateHome={navigateHome} vmPowerAction={vmPowerAction} vmStartOn={vmStartOn} conn={conn} hostRecords={xenHosts} vmMigrate={vmMigrate} refreshHost={refreshHost} onVmDragStart={handleVmDragStart} onVmDragEnd={handleVmDragEnd} availableFolders={availableFolders} />
                                      ))}
                                    </div>
                                  )}
                                </HostButton>
                              </div>
                            );
                          })}
                          {/* VMs not assigned to any host */}
                          {(() => {
                            const hostRefs = new Set(xenHosts.map((xh) => xh.ref));
                            const unassigned = sortVms(vms.filter((vm) => !vm.residentOn || !hostRefs.has(vm.residentOn)));
                            if (unassigned.length === 0) return null;
                            return (
                              <>
                                <Separator className="my-1" />
                                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                                  Other VMs
                                </div>
                                {unassigned.map((vm) => (
                                  <VmButton key={vm.ref} vm={vm} hostId={host.id} selectedVmRef={state.selectedVmRef} selectHost={selectHost} selectVm={selectVm} navigateHome={navigateHome} vmPowerAction={vmPowerAction} vmStartOn={vmStartOn} conn={conn} hostRecords={xenHosts} vmMigrate={vmMigrate} refreshHost={refreshHost} onVmDragStart={handleVmDragStart} onVmDragEnd={handleVmDragEnd} availableFolders={availableFolders} />
                                ))}
                              </>
                            );
                          })()}
                        </>
                      ) : (
                        /* ── Flat View: Hosts and VMs in separate sections ── */
                        <>
                          {/* Pool Hosts */}
                          {sidebarView !== "vms-only" && xenHosts.length >= 1 && (
                            <>
                              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                                Hosts
                              </div>
                              {filteredXenHosts.map((xh) => (
                                <HostButton key={xh.ref} xh={xh} hostId={host.id} selectedXenHostRef={state.selectedXenHostRef} selectHost={selectHost} selectXenHost={selectXenHost} navigateHome={navigateHome} conn={conn} hostRecords={xenHosts} hostMaintenanceEnter={hostMaintenanceEnter} hostMaintenanceExit={hostMaintenanceExit} refreshHost={refreshHost} isMaster={xh.ref === poolMasterRef} draggingVm={draggingVm} onHostDrop={handleHostDrop} onRemoveFromPool={role === "admin" ? () => setRemoving({ hostId: host.id, ref: xh.ref, name: xh.nameLabel, poolName: pools[0]?.nameLabel || host.name }) : undefined} />
                              ))}
                              {sidebarView !== "hosts-only" && <Separator className="my-1" />}
                            </>
                          )}

                          {/* VMs */}
                          {sidebarView !== "hosts-only" && (
                            <>
                              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                                Virtual Machines
                              </div>
                              {vms.length === 0 ? (
                                <div className="px-2 py-2 text-xs text-zinc-400">
                                  No VMs found
                                </div>
                              ) : (
                                sortVms(vms).map((vm) => (
                                  <VmButton key={vm.ref} vm={vm} hostId={host.id} selectedVmRef={state.selectedVmRef} selectHost={selectHost} selectVm={selectVm} navigateHome={navigateHome} vmPowerAction={vmPowerAction} vmStartOn={vmStartOn} conn={conn} hostRecords={xenHosts} vmMigrate={vmMigrate} refreshHost={refreshHost} onVmDragStart={handleVmDragStart} onVmDragEnd={handleVmDragEnd} availableFolders={availableFolders} />
                                ))
                              )}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {isConnected && createVmPoolId === host.id && (
                    <CreateVmDialog
                      open={true}
                      onOpenChange={(o) => { if (!o) setCreateVmPoolId(null); }}
                      hostId={host.id}
                      conn={conn}
                      hostRecords={xenHosts}
                      onCreated={() => refreshHost(host.id)}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* The pages, below the tree: the tree is what one works in, these are
          visited now and then. */}
      <nav className="shrink-0 space-y-0.5 border-t border-[var(--shell-nav-line)] p-2">
        <NavItem icon={Settings} label="Settings" href="/settings" active={pathname === "/settings"} />
        {/* Unlike Users and the audit log, what a pool reports is operational
            information every role needs — the pool grant does the scoping. */}
        <NavItem icon={Bell} label="Notifications" href="/events" active={pathname === "/events"} />
        {role === "admin" && <NavItem icon={Users} label="Users" href="/users" active={pathname === "/users"} />}
        {role === "admin" && <NavItem icon={ScrollText} label="Audit Log" href="/audit" active={pathname === "/audit"} />}
        {/* XenCenter: Tools > License Manager... */}
        <NavItem icon={KeyRound} label="License Manager" onClick={() => setLicenseOpen(true)} />
        <NavItem
          icon={LogOut}
          label="Logout"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/signed-out";
          }}
        />
      </nav>

      {/* Resize Handle */}
      {!drawer && (
        <div
          onMouseDown={onMouseDown}
          className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-[var(--shell-nav-active)] active:bg-[var(--shell-nav-active)]"
        />
      )}

      {licenseOpen && <LicenseManagerDialog onClose={() => setLicenseOpen(false)} />}

      {/* Add New Server to a pool */}
      {addServerPoolId && state.connections[addServerPoolId]?.status === "connected" && (
        <AddServerDialog
          conn={state.connections[addServerPoolId]}
          poolName={Object.values(state.connections[addServerPoolId].pools)[0]?.nameLabel || state.connections[addServerPoolId].host.name}
          onClose={() => setAddServerPoolId(null)}
          onDone={() => void refreshHost(addServerPoolId)}
        />
      )}
      {/* Remove From Pool */}
      {removing && state.connections[removing.hostId] && (
        <RemoveServerDialog
          conn={state.connections[removing.hostId]}
          hostRef={removing.ref}
          hostName={removing.name}
          poolName={removing.poolName}
          onClose={() => setRemoving(null)}
          onDone={(newHostId) => {
            if (newHostId) void adoptHost(newHostId);
            void refreshHost(removing.hostId);
          }}
        />
      )}

      {/* New Folder Dialog */}
      {newFolderPoolId && (() => {
        const conn = state.connections[newFolderPoolId];
        if (conn?.status !== "connected") return null;
        const pool = Object.values(conn.pools)[0];
        if (!pool) return null;
        return (
          <NewFolderDialog
            open={true}
            onOpenChange={(o) => { if (!o) setNewFolderPoolId(null); }}
            onConfirm={async (name) => {
              await handleCreateFolder(newFolderPoolId, pool.ref, pool.emptyFolders, conn, name);
              setNewFolderPoolId(null);
            }}
          />
        );
      })()}
    </aside>
  );
}
