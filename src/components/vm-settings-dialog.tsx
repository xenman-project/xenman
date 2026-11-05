"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
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
  Settings,
  Cpu,
  HardDrive,
  Network,
  Tag,
  X,
  Plus,
  Loader2,
  Save,
  Info,
  Pencil,
  Trash2,
  CheckCircle,
  XCircle,
  Disc,
  CircleX,
} from "lucide-react";
import { XenVM } from "@/lib/types";

interface ConnInfo {
  host: { address: string; port: number; useSsl: boolean };
  session: { sessionRef: string } | null;
  connectedVia?: string;
}

interface VmSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vm: XenVM;
  hostId: string;
  conn: ConnInfo;
  onSaved: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function bytesToGiB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function gibToBytes(gib: number): number {
  return Math.round(gib * 1024 * 1024 * 1024);
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

// ── General Tab ──
function GeneralTab({ vm, conn, onSaved }: { vm: XenVM; conn: ConnInfo; onSaved: () => void }) {
  const [name, setName] = useState(vm.nameLabel);
  const [description, setDescription] = useState(vm.nameDescription);
  const [tags, setTags] = useState<string[]>([...vm.tags]);
  const [folder, setFolder] = useState(vm.otherConfig?.folder ?? "");
  const [newTag, setNewTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setName(vm.nameLabel);
    setDescription(vm.nameDescription);
    setTags([...vm.tags]);
    setFolder(vm.otherConfig?.folder ?? "");
  }, [vm]);

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const promises: Promise<unknown>[] = [];
      if (name !== vm.nameLabel) {
        promises.push(apiCall(conn, { action: "vm_set_name", vmRef: vm.ref, value: name }));
      }
      if (description !== vm.nameDescription) {
        promises.push(apiCall(conn, { action: "vm_set_description", vmRef: vm.ref, value: description }));
      }
      // Handle tag changes
      const toAdd = tags.filter((t) => !vm.tags.includes(t));
      const toRemove = vm.tags.filter((t) => !tags.includes(t));
      for (const tag of toAdd) {
        promises.push(apiCall(conn, { action: "vm_add_tag", vmRef: vm.ref, tag }));
      }
      for (const tag of toRemove) {
        promises.push(apiCall(conn, { action: "vm_remove_tag", vmRef: vm.ref, tag }));
      }
      const currentFolder = vm.otherConfig?.folder ?? "";
      if (folder !== currentFolder) {
        promises.push(apiCall(conn, { action: "vm_set_folder", vmRef: vm.ref, folder: folder.trim() || null }));
      }
      await Promise.all(promises);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function addTag() {
    const t = newTag.trim();
    if (t && !tags.includes(t)) {
      setTags([...tags, t]);
      setNewTag("");
    }
  }

  const currentFolder = vm.otherConfig?.folder ?? "";
  const hasChanges = name !== vm.nameLabel || description !== vm.nameDescription ||
    JSON.stringify([...tags].sort()) !== JSON.stringify([...vm.tags].sort()) ||
    folder !== currentFolder;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="vm-name">Name</Label>
        <Input id="vm-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="vm-desc">Description</Label>
        <Input id="vm-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="vm-folder">Folder</Label>
        <Input
          id="vm-folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="e.g. /Production/Web Servers"
        />
        <p className="text-xs text-zinc-400">Use / to create subfolders, e.g. /Production/Web</p>
      </div>
      <div className="space-y-2">
        <Label>Tags</Label>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              <button onClick={() => setTags(tags.filter((t) => t !== tag))} className="ml-0.5 rounded-full hover:bg-zinc-300 dark:hover:bg-zinc-600 p-0.5">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
            placeholder="Add tag..."
            className="h-8 text-xs"
          />
          <Button size="sm" variant="outline" onClick={addTag} disabled={!newTag.trim()}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || !hasChanges} size="sm">
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving...</> : <><Save className="h-4 w-4" /> Save</>}
        </Button>
      </div>
    </div>
  );
}

// ── CPU & Memory Tab ──
function CpuMemoryTab({ vm, conn, onSaved }: { vm: XenVM; conn: ConnInfo; onSaved: () => void }) {
  const [vcpusMax, setVcpusMax] = useState(vm.vcpusMax);
  const [vcpusStartup, setVcpusStartup] = useState(vm.vcpusAtStartup);
  const [memStaticMax, setMemStaticMax] = useState(bytesToGiB(vm.memoryStaticMax));
  const [memDynMin, setMemDynMin] = useState(bytesToGiB(vm.memoryDynamicMin));
  const [memDynMax, setMemDynMax] = useState(bytesToGiB(vm.memoryDynamicMax));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isHalted = vm.powerState === "Halted";

  useEffect(() => {
    setVcpusMax(vm.vcpusMax);
    setVcpusStartup(vm.vcpusAtStartup);
    setMemStaticMax(bytesToGiB(vm.memoryStaticMax));
    setMemDynMin(bytesToGiB(vm.memoryDynamicMin));
    setMemDynMax(bytesToGiB(vm.memoryDynamicMax));
  }, [vm]);

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const promises: Promise<unknown>[] = [];

      if (vcpusMax !== vm.vcpusMax) {
        promises.push(apiCall(conn, { action: "vm_set_vcpus_max", vmRef: vm.ref, value: vcpusMax }));
      }
      if (vcpusStartup !== vm.vcpusAtStartup) {
        promises.push(apiCall(conn, { action: "vm_set_vcpus_startup", vmRef: vm.ref, value: vcpusStartup }));
      }

      const newStaticMax = gibToBytes(parseFloat(memStaticMax));
      const newDynMin = gibToBytes(parseFloat(memDynMin));
      const newDynMax = gibToBytes(parseFloat(memDynMax));
      const oldStaticMax = vm.memoryStaticMax;
      const oldDynMin = vm.memoryDynamicMin;
      const oldDynMax = vm.memoryDynamicMax;

      if (newStaticMax !== oldStaticMax || newDynMin !== oldDynMin || newDynMax !== oldDynMax) {
        promises.push(apiCall(conn, {
          action: "vm_set_memory_limits",
          vmRef: vm.ref,
          staticMin: newDynMin, // static_min = dynamic_min is common practice
          staticMax: newStaticMax,
          dynMin: newDynMin,
          dynMax: newDynMax,
        }));
      }

      await Promise.all(promises);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const vcpuMaxChanged = vcpusMax !== vm.vcpusMax;
  const vcpuStartupChanged = vcpusStartup !== vm.vcpusAtStartup;
  const memChanged =
    gibToBytes(parseFloat(memStaticMax)) !== vm.memoryStaticMax ||
    gibToBytes(parseFloat(memDynMin)) !== vm.memoryDynamicMin ||
    gibToBytes(parseFloat(memDynMax)) !== vm.memoryDynamicMax;
  const hasChanges = vcpuMaxChanged || vcpuStartupChanged || memChanged;

  return (
    <div className="space-y-5">
      {!isHalted && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>vCPUs Max and Static Memory Max can only be changed when the VM is shut down. Dynamic memory can be adjusted while running.</span>
        </div>
      )}

      <div>
        <h4 className="text-sm font-medium mb-3">vCPUs</h4>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="vcpus-max" className="text-xs">Maximum vCPUs</Label>
            <Input
              id="vcpus-max"
              type="number"
              min={1}
              value={vcpusMax}
              onChange={(e) => setVcpusMax(parseInt(e.target.value) || 1)}
              disabled={!isHalted}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vcpus-startup" className="text-xs">vCPUs at Startup</Label>
            <Input
              id="vcpus-startup"
              type="number"
              min={1}
              max={vcpusMax}
              value={vcpusStartup}
              onChange={(e) => setVcpusStartup(Math.min(parseInt(e.target.value) || 1, vcpusMax))}
              disabled={!isHalted}
              className="h-8"
            />
          </div>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-medium mb-3">Memory (GiB)</h4>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="mem-static-max" className="text-xs">Static Max</Label>
            <Input
              id="mem-static-max"
              type="number"
              min={0.1}
              step={0.1}
              value={memStaticMax}
              onChange={(e) => setMemStaticMax(e.target.value)}
              disabled={!isHalted}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-dyn-min" className="text-xs">Dynamic Min</Label>
            <Input
              id="mem-dyn-min"
              type="number"
              min={0.1}
              step={0.1}
              value={memDynMin}
              onChange={(e) => setMemDynMin(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-dyn-max" className="text-xs">Dynamic Max</Label>
            <Input
              id="mem-dyn-max"
              type="number"
              min={0.1}
              step={0.1}
              value={memDynMax}
              onChange={(e) => setMemDynMax(e.target.value)}
              className="h-8"
            />
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || !hasChanges} size="sm">
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving...</> : <><Save className="h-4 w-4" /> Save</>}
        </Button>
      </div>
    </div>
  );
}

// ── Disks Tab ──
interface DiskInfo {
  vbd: { ref: string; device: string; type: string; mode: string; currentlyAttached: boolean };
  vdi: { ref: string; nameLabel: string; virtualSize: number; physicalUtilisation: number; type: string } | null;
  sr: { ref: string; nameLabel: string; type: string } | null;
}

interface SRInfo {
  ref: string;
  nameLabel: string;
  type: string;
  physicalSize: number;
  physicalUtilisation: number;
}

function DiskResizeDialog({
  open,
  onOpenChange,
  conn,
  disk,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn: ConnInfo;
  disk: DiskInfo | null;
  onSaved: () => void;
}) {
  const currentGiB = disk?.vdi ? bytesToGiB(disk.vdi.virtualSize) : "0";
  const [newSizeGiB, setNewSizeGiB] = useState(currentGiB);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset when the dialog opens, not whenever the pool data refreshes: a
  // refresh hands over new arrays, and the choices made so far were lost.
  const prevOpen = useRef(false);
  useEffect(() => {
    const justOpened = open && !prevOpen.current;
    prevOpen.current = open;
    if (justOpened && disk?.vdi) {
      setNewSizeGiB(bytesToGiB(disk.vdi.virtualSize));
      setError("");
    }
  }, [open, disk]);

  const currentBytes = disk?.vdi?.virtualSize || 0;
  const newBytes = gibToBytes(parseFloat(newSizeGiB));
  const isValid = !isNaN(newBytes) && newBytes > currentBytes;

  async function handleSave() {
    if (!disk?.vdi || !isValid) return;
    setSaving(true);
    setError("");
    try {
      await apiCall(conn, { action: "vdi_resize", vdiRef: disk.vdi.ref, size: newBytes });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resize failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resize Disk</DialogTitle>
          <DialogDescription>
            Resize &quot;{disk?.vdi?.nameLabel}&quot; ({disk?.vbd.device}).
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>Disks can only be increased in size, not shrunk.</span>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Current Size</Label>
            <Input value={`${currentGiB} GiB (${disk?.vdi ? formatBytes(disk.vdi.virtualSize) : "—"})`} disabled className="h-8 text-sm" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-disk-size">New Size (GiB)</Label>
            <Input
              id="new-disk-size"
              type="number"
              min={parseFloat(currentGiB)}
              step={0.1}
              value={newSizeGiB}
              onChange={(e) => setNewSizeGiB(e.target.value)}
              className="h-8 text-sm"
            />
            {newSizeGiB && !isNaN(parseFloat(newSizeGiB)) && (
              <p className="text-xs text-muted-foreground">
                New size: {formatBytes(gibToBytes(parseFloat(newSizeGiB)))}
              </p>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !isValid}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Resizing...</> : <><Save className="h-4 w-4" /> Resize</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiskAddDialog({
  open,
  onOpenChange,
  conn,
  vm,
  srs,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn: ConnInfo;
  vm: XenVM;
  srs: SRInfo[];
  onSaved: () => void;
}) {
  const [srRef, setSrRef] = useState("");
  const [diskName, setDiskName] = useState("");
  const [sizeGiB, setSizeGiB] = useState("8");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset when the dialog opens, not whenever the pool data refreshes: a
  // refresh hands over new arrays, and the choices made so far were lost.
  const prevOpen = useRef(false);
  useEffect(() => {
    const justOpened = open && !prevOpen.current;
    prevOpen.current = open;
    if (justOpened) {
      setSrRef(srs.length > 0 ? srs[0].ref : "");
      setDiskName("");
      setSizeGiB("8");
      setError("");
    }
  }, [open, srs]);

  // The storage list arriving only after the dialog opened: the first one.
  useEffect(() => {
    if (open && !srRef && srs.length > 0) setSrRef(srs[0].ref);
  }, [open, srRef, srs]);

  const sizeBytes = gibToBytes(parseFloat(sizeGiB));
  const isValid = srRef && !isNaN(sizeBytes) && sizeBytes > 0;
  const selectedSr = srs.find((s) => s.ref === srRef);
  const freeSpace = selectedSr ? selectedSr.physicalSize - selectedSr.physicalUtilisation : 0;

  async function handleSave() {
    if (!isValid) return;
    setSaving(true);
    setError("");
    try {
      await apiCall(conn, {
        action: "disk_create",
        vmRef: vm.ref,
        srRef,
        nameLabel: diskName || `${vm.nameLabel} disk`,
        nameDescription: "",
        sizeBytes,
        bootable: false,
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create disk");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Disk</DialogTitle>
          <DialogDescription>
            Create a new virtual disk and attach it to {vm.nameLabel}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Storage Repository</Label>
            <Select value={srRef} onValueChange={setSrRef}>
              <SelectTrigger className="w-full h-8 text-sm">
                <SelectValue placeholder="Select SR..." />
              </SelectTrigger>
              <SelectContent>
                {srs.filter((s) => s.type !== "tmpfs").map((s) => (
                  <SelectItem key={s.ref} value={s.ref}>
                    {s.nameLabel} <span className="text-muted-foreground">({s.type}, {formatBytes(s.physicalSize - s.physicalUtilisation)} free)</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="disk-name">Name</Label>
            <Input
              id="disk-name"
              value={diskName}
              onChange={(e) => setDiskName(e.target.value)}
              placeholder={`${vm.nameLabel} disk`}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="disk-size">Size (GiB)</Label>
            <Input
              id="disk-size"
              type="number"
              min={0.25}
              step={0.25}
              value={sizeGiB}
              onChange={(e) => setSizeGiB(e.target.value)}
              className="h-8 text-sm"
            />
            {sizeGiB && !isNaN(parseFloat(sizeGiB)) && (
              <p className="text-xs text-muted-foreground">
                Size: {formatBytes(gibToBytes(parseFloat(sizeGiB)))}
                {selectedSr && <> &middot; SR free: {formatBytes(freeSpace)}</>}
              </p>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !isValid}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating...</> : <><Plus className="h-4 w-4" /> Add Disk</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisksTab({ vm, conn }: { vm: XenVM; conn: ConnInfo }) {
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [srs, setSrs] = useState<SRInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [resizeDialogOpen, setResizeDialogOpen] = useState(false);
  const [resizingDisk, setResizingDisk] = useState<DiskInfo | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DiskInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (loaded) return;
    setLoading(true);
    Promise.all([
      apiCall(conn, { action: "vm_disks", vmRef: vm.ref }),
      apiCall(conn, { action: "vm_srs" }),
    ])
      .then(([diskData, srData]) => {
        setDisks(diskData.disks);
        setSrs(srData.srs || []);
        setLoaded(true);
      })
      .catch(() => setError("Failed to load disks"))
      .finally(() => setLoading(false));
  }, [conn, vm.ref, loaded]);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError("");
    try {
      await apiCall(conn, {
        action: "disk_delete",
        vmRef: vm.ref,
        vbdRef: deleteTarget.vbd.ref,
        vdiRef: deleteTarget.vdi?.ref || null,
        currentlyAttached: deleteTarget.vbd.currentlyAttached,
      });
      setDeleteTarget(null);
      setLoaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> Add Disk
        </Button>
      </div>

      {disks.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No disks found</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Name</TableHead>
              <TableHead className="text-xs">SR</TableHead>
              <TableHead className="text-xs">Size</TableHead>
              <TableHead className="text-xs">Used</TableHead>
              <TableHead className="text-xs">Device</TableHead>
              <TableHead className="text-xs w-[80px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {disks.map((d) => (
              <TableRow key={d.vbd.ref}>
                <TableCell className="text-xs">{d.vdi?.nameLabel || "—"}</TableCell>
                <TableCell className="text-xs">{d.sr?.nameLabel || "—"}</TableCell>
                <TableCell className="text-xs">{d.vdi ? formatBytes(d.vdi.virtualSize) : "—"}</TableCell>
                <TableCell className="text-xs">{d.vdi ? formatBytes(d.vdi.physicalUtilisation) : "—"}</TableCell>
                <TableCell className="text-xs">{d.vbd.device}</TableCell>
                <TableCell className="text-xs">
                  <div className="flex gap-1">
                    {d.vdi && d.vbd.type === "Disk" && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => { setResizingDisk(d); setResizeDialogOpen(true); }}
                        title="Resize"
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                    {d.vbd.type === "Disk" && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setDeleteTarget(d)}
                        title="Delete"
                        className="text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}

      <DiskResizeDialog
        open={resizeDialogOpen}
        onOpenChange={setResizeDialogOpen}
        conn={conn}
        disk={resizingDisk}
        onSaved={() => setLoaded(false)}
      />

      <DiskAddDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        conn={conn}
        vm={vm}
        srs={srs}
        onSaved={() => setLoaded(false)}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Disk</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{deleteTarget?.vdi?.nameLabel || deleteTarget?.vbd.device}&quot;? This will permanently destroy the virtual disk and all data on it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── CD/DVD Tab ──
interface CdDriveInfo {
  vbd: { ref: string; device: string; currentlyAttached: boolean; empty: boolean };
  vdi: { ref: string; nameLabel: string } | null;
}

interface IsoInfo {
  ref: string;
  nameLabel: string;
  srName: string;
}

function CdDvdTab({ vm, conn }: { vm: XenVM; conn: ConnInfo }) {
  const [drives, setDrives] = useState<CdDriveInfo[]>([]);
  const [isos, setIsos] = useState<IsoInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CdDriveInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (loaded) return;
    setLoading(true);
    setError("");
    Promise.all([
      apiCall(conn, { action: "vm_disks", vmRef: vm.ref }),
      apiCall(conn, { action: "vm_isos" }),
    ])
      .then(([diskData, isoData]) => {
        const allDisks: DiskInfo[] = diskData.disks || [];
        const cdDrives: CdDriveInfo[] = allDisks
          .filter((d) => d.vbd.type === "CD")
          .map((d) => ({
            vbd: {
              ref: d.vbd.ref,
              device: d.vbd.device,
              currentlyAttached: d.vbd.currentlyAttached,
              empty: !d.vdi,
            },
            vdi: d.vdi ? { ref: d.vdi.ref, nameLabel: d.vdi.nameLabel } : null,
          }));
        setDrives(cdDrives);
        setIsos(isoData.isos || []);
        setLoaded(true);
      })
      .catch(() => setError("Failed to load CD/DVD drives"))
      .finally(() => setLoading(false));
  }, [conn, vm.ref, loaded]);

  async function handleInsert(vbdRef: string, vdiRef: string) {
    setActionLoading(vbdRef);
    setError("");
    try {
      await apiCall(conn, { action: "cd_insert", vbdRef, vdiRef });
      setLoaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to insert ISO");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleEject(vbdRef: string) {
    setActionLoading(vbdRef);
    setError("");
    try {
      await apiCall(conn, { action: "cd_eject", vbdRef });
      setLoaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to eject ISO");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleAdd() {
    setAdding(true);
    setError("");
    try {
      await apiCall(conn, { action: "cd_add", vmRef: vm.ref });
      setLoaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add CD/DVD drive");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError("");
    try {
      await apiCall(conn, {
        action: "cd_remove",
        vbdRef: deleteTarget.vbd.ref,
        currentlyAttached: deleteTarget.vbd.currentlyAttached,
      });
      setDeleteTarget(null);
      setLoaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove CD/DVD drive");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={handleAdd} disabled={adding}>
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {" "}Add Drive
        </Button>
      </div>

      {drives.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No CD/DVD drives found</p>
      ) : (
        <div className="space-y-3">
          {drives.map((drive) => (
            <div key={drive.vbd.ref} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Disc className="h-4 w-4 text-zinc-400" />
                <span className="text-xs font-medium">CD/DVD Drive (device {drive.vbd.device})</span>
                {drive.vdi ? (
                  <Badge variant="outline" className="text-[10px] bg-blue-500/10 text-blue-600 border-blue-500/20">
                    {drive.vdi.nameLabel}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">Empty</Badge>
                )}
                <div className="ml-auto">
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-red-500 hover:text-red-600"
                    onClick={() => setDeleteTarget(drive)}
                    title="Remove drive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {drive.vdi ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={actionLoading === drive.vbd.ref}
                    onClick={() => handleEject(drive.vbd.ref)}
                  >
                    {actionLoading === drive.vbd.ref ? (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    ) : (
                      <CircleX className="mr-1.5 h-3 w-3" />
                    )}
                    Eject
                  </Button>
                ) : (
                  <div className="flex items-center gap-2 flex-1">
                    <Select
                      onValueChange={(vdiRef) => handleInsert(drive.vbd.ref, vdiRef)}
                      disabled={actionLoading === drive.vbd.ref}
                    >
                      <SelectTrigger className="h-7 text-xs flex-1">
                        <SelectValue placeholder="Select ISO to mount..." />
                      </SelectTrigger>
                      <SelectContent>
                        {isos.map((iso) => (
                          <SelectItem key={iso.ref} value={iso.ref}>
                            {iso.nameLabel}
                            {iso.srName && <span className="text-muted-foreground ml-1">({iso.srName})</span>}
                          </SelectItem>
                        ))}
                        {isos.length === 0 && (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">No ISOs available</div>
                        )}
                      </SelectContent>
                    </Select>
                    {actionLoading === drive.vbd.ref && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove CD/DVD Drive</AlertDialogTitle>
            <AlertDialogDescription>
              Remove CD/DVD drive (device {deleteTarget?.vbd.device})?
              {deleteTarget?.vdi && <> The mounted ISO &quot;{deleteTarget.vdi.nameLabel}&quot; will be ejected.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Network Tab ──
interface NicInfo {
  vif: { ref: string; device: string; mac: string; currentlyAttached: boolean };
  network: { ref: string; nameLabel: string; bridge: string } | null;
}

interface NetworkInfo {
  ref: string;
  nameLabel: string;
  bridge: string;
}

function VifEditDialog({
  open,
  onOpenChange,
  conn,
  vm,
  vif,
  networks,
  existingDevices,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn: ConnInfo;
  vm: XenVM;
  vif: NicInfo | null; // null = add new
  networks: NetworkInfo[];
  existingDevices: string[];
  onSaved: () => void;
}) {
  const [networkRef, setNetworkRef] = useState(vif?.network?.ref || "");
  const [mac, setMac] = useState(vif?.vif.mac || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isEdit = vif !== null;
  const isRunning = vm.powerState === "Running";

  // Reset when the dialog opens, not whenever the pool data refreshes: a
  // refresh hands over new arrays, and the choices made so far were lost.
  const prevOpen = useRef(false);
  useEffect(() => {
    const justOpened = open && !prevOpen.current;
    prevOpen.current = open;
    if (justOpened) {
      setNetworkRef(vif?.network?.ref || "");
      setMac(vif?.vif.mac || "");
      setError("");
    }
  }, [open, vif]);

  const nextDevice = isEdit
    ? vif.vif.device
    : (() => {
        for (let i = 0; ; i++) {
          if (!existingDevices.includes(String(i))) return String(i);
        }
      })();

  async function handleSave() {
    if (!networkRef) {
      setError("Please select a network");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (isEdit) {
        // Destroy old VIF, create new one with same device number
        if (vif.vif.currentlyAttached) {
          await apiCall(conn, { action: "vif_unplug", vifRef: vif.vif.ref });
        }
        await apiCall(conn, { action: "vif_destroy", vifRef: vif.vif.ref });
        const { ref: newRef } = await apiCall(conn, {
          action: "vif_create",
          vmRef: vm.ref,
          networkRef,
          device: vif.vif.device,
          mac: mac || "",
        });
        if (isRunning) {
          await apiCall(conn, { action: "vif_plug", vifRef: newRef });
        }
      } else {
        // Create new VIF
        const { ref: newRef } = await apiCall(conn, {
          action: "vif_create",
          vmRef: vm.ref,
          networkRef,
          device: nextDevice,
          mac: mac || "",
        });
        if (isRunning) {
          await apiCall(conn, { action: "vif_plug", vifRef: newRef });
        }
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Interface" : "Add Interface"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? `Edit network interface eth${vif.vif.device}.`
              : `Add a new network interface (eth${nextDevice}).`}
          </DialogDescription>
        </DialogHeader>

        {isRunning && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <span>The VM is running. The interface will be automatically plugged after {isEdit ? "updating" : "creation"}.</span>
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Device</Label>
            <Input value={`eth${nextDevice}`} disabled className="h-8 text-sm" />
          </div>
          <div className="space-y-2">
            <Label>Network</Label>
            <Select value={networkRef} onValueChange={setNetworkRef}>
              <SelectTrigger className="w-full h-8 text-sm">
                <SelectValue placeholder="Select network..." />
              </SelectTrigger>
              <SelectContent>
                {networks.map((n) => (
                  <SelectItem key={n.ref} value={n.ref}>
                    {n.nameLabel} <span className="text-muted-foreground">({n.bridge})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>MAC Address</Label>
            <Input
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              placeholder="Auto-generate (leave empty)"
              className="h-8 text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground">Leave empty to auto-generate a MAC address.</p>
          </div>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !networkRef}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving...</> : <><Save className="h-4 w-4" /> {isEdit ? "Update" : "Add"}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NetworkTab({ vm, conn }: { vm: XenVM; conn: ConnInfo }) {
  const [nics, setNics] = useState<NicInfo[]>([]);
  const [networks, setNetworks] = useState<NetworkInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingVif, setEditingVif] = useState<NicInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NicInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (loaded) return;
    setLoading(true);
    apiCall(conn, { action: "vm_nics", vmRef: vm.ref })
      .then((data) => {
        setNics(data.nics);
        setNetworks(data.networks || []);
        setLoaded(true);
      })
      .catch(() => setError("Failed to load NICs"))
      .finally(() => setLoading(false));
  }, [conn, vm.ref, loaded]);

  function openAdd() {
    setEditingVif(null);
    setEditDialogOpen(true);
  }

  function openEdit(nic: NicInfo) {
    setEditingVif(nic);
    setEditDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError("");
    try {
      if (deleteTarget.vif.currentlyAttached) {
        await apiCall(conn, { action: "vif_unplug", vifRef: deleteTarget.vif.ref });
      }
      await apiCall(conn, { action: "vif_destroy", vifRef: deleteTarget.vif.ref });
      setDeleteTarget(null);
      setLoaded(false); // reload
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const existingDevices = nics.map((n) => n.vif.device);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={openAdd}>
          <Plus className="h-3.5 w-3.5" /> Add Interface
        </Button>
      </div>

      {nics.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No network interfaces found</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Device</TableHead>
              <TableHead className="text-xs">Network</TableHead>
              <TableHead className="text-xs">MAC Address</TableHead>
              <TableHead className="text-xs">Attached</TableHead>
              <TableHead className="text-xs w-[80px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nics.map((n) => (
              <TableRow key={n.vif.ref}>
                <TableCell className="text-xs">eth{n.vif.device}</TableCell>
                <TableCell className="text-xs">{n.network?.nameLabel || "—"}</TableCell>
                <TableCell className="text-xs font-mono">{n.vif.mac}</TableCell>
                <TableCell className="text-xs">
                  {n.vif.currentlyAttached ? (
                    <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-zinc-400" />
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <div className="flex items-center gap-1">
                    <Button size="xs" variant="ghost" onClick={() => openEdit(n)} title="Edit">
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setDeleteTarget(n)} title="Delete" className="text-red-500 hover:text-red-600">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}

      <VifEditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        conn={conn}
        vm={vm}
        vif={editingVif}
        networks={networks}
        existingDevices={existingDevices}
        onSaved={() => setLoaded(false)}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete eth{deleteTarget?.vif.device}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the network interface{deleteTarget?.network ? ` (${deleteTarget.network.nameLabel})` : ""} from the VM.
              {deleteTarget?.vif.currentlyAttached && " The interface will be unplugged first."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-red-600 hover:bg-red-700">
              {deleting ? <><Loader2 className="h-4 w-4 animate-spin" /> Deleting...</> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Boot Tab ──
type FirmwareMode = "bios" | "uefi" | "uefi-sb";

function BootTab({ vm, conn, onSaved }: { vm: XenVM; conn: ConnInfo; onSaved: () => void }) {
  const [bootOrder, setBootOrder] = useState("");
  const [originalOrder, setOriginalOrder] = useState("");
  const [firmware, setFirmware] = useState<FirmwareMode>("uefi");
  const [originalFirmware, setOriginalFirmware] = useState<FirmwareMode>("uefi");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingFirmware, setSavingFirmware] = useState(false);
  const [error, setError] = useState("");

  const isHalted = vm.powerState === "Halted";

  useEffect(() => {
    Promise.all([
      apiCall(conn, { action: "vm_get_boot_params", vmRef: vm.ref }),
      apiCall(conn, { action: "vm_get_platform", vmRef: vm.ref }),
    ])
      .then(([bootData, platformData]) => {
        const order = bootData.params?.order || "dc";
        setBootOrder(order);
        setOriginalOrder(order);

        const plat = platformData.platform || {};
        const hvmFw = bootData.params?.firmware;
        let mode: FirmwareMode = "bios";
        if (hvmFw === "uefi") {
          mode = plat.secureboot === "true" ? "uefi-sb" : "uefi";
        }
        setFirmware(mode);
        setOriginalFirmware(mode);
      })
      .catch(() => setError("Failed to load boot params"))
      .finally(() => setLoading(false));
  }, [conn, vm.ref]);

  async function handleSaveBootOrder() {
    setSaving(true);
    setError("");
    try {
      await apiCall(conn, { action: "vm_set_boot_order", vmRef: vm.ref, value: bootOrder });
      setOriginalOrder(bootOrder);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveFirmware() {
    setSavingFirmware(true);
    setError("");
    try {
      await apiCall(conn, {
        action: "vm_set_firmware",
        vmRef: vm.ref,
        firmware: firmware === "uefi-sb" ? "uefi" : firmware,
        secureboot: firmware === "uefi-sb",
      });
      setOriginalFirmware(firmware);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingFirmware(false);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const bootChars: Record<string, string> = {
    c: "CD/DVD",
    d: "Disk",
    n: "Network (PXE)",
  };

  return (
    <div className="space-y-6">
      {/* Firmware Mode */}
      <div className="space-y-3">
        <Label>Firmware Mode</Label>
        <Select value={firmware} onValueChange={(v) => setFirmware(v as FirmwareMode)} disabled={!isHalted}>
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bios">BIOS</SelectItem>
            <SelectItem value="uefi">UEFI</SelectItem>
            <SelectItem value="uefi-sb">UEFI + Secure Boot</SelectItem>
          </SelectContent>
        </Select>
        {!isHalted && (
          <p className="text-xs text-amber-500">VM must be shut down to change firmware mode.</p>
        )}
        {firmware !== originalFirmware && (
          <div className="flex justify-end">
            <Button onClick={handleSaveFirmware} disabled={savingFirmware || !isHalted} size="sm">
              {savingFirmware ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving...</> : <><Save className="h-4 w-4" /> Save Firmware</>}
            </Button>
          </div>
        )}
      </div>

      <div className="border-t" />

      {/* Boot Order */}
      <div className="space-y-2">
        <Label htmlFor="boot-order">Boot Order</Label>
        <Input
          id="boot-order"
          value={bootOrder}
          onChange={(e) => setBootOrder(e.target.value.toLowerCase())}
          placeholder="e.g. dc, cdn"
          className="h-8 font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Characters: {Object.entries(bootChars).map(([k, v]) => `${k} = ${v}`).join(", ")}
        </p>
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Current boot sequence:</Label>
        <div className="flex gap-2">
          {bootOrder.split("").map((ch, i) => (
            <Badge key={i} variant="outline" className="text-xs">
              {i + 1}. {bootChars[ch] || ch}
            </Badge>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {bootOrder !== originalOrder && (
        <div className="flex justify-end">
          <Button onClick={handleSaveBootOrder} disabled={saving} size="sm">
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving...</> : <><Save className="h-4 w-4" /> Save Boot Order</>}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Main Dialog ──
export function VmSettingsDialog({ open, onOpenChange, vm, hostId, conn, onSaved }: VmSettingsDialogProps) {
  // Freeze the vm snapshot on open so auto-refresh doesn't reset tabs mid-edit
  const prevOpen = useRef(false);
  const frozenVm = useRef(vm);
  if (open && !prevOpen.current) {
    frozenVm.current = vm;
  }
  prevOpen.current = open;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl h-[70vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Settings: {frozenVm.current.nameLabel}
          </DialogTitle>
          <DialogDescription>
            Configure virtual machine settings. Some changes require the VM to be shut down.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex-1 overflow-hidden flex flex-col">
          <TabsList variant="line">
            <TabsTrigger value="general"><Tag className="h-3.5 w-3.5 mr-1.5" />General</TabsTrigger>
            <TabsTrigger value="cpu-memory"><Cpu className="h-3.5 w-3.5 mr-1.5" />CPU & Memory</TabsTrigger>
            <TabsTrigger value="disks"><HardDrive className="h-3.5 w-3.5 mr-1.5" />Disks</TabsTrigger>
            <TabsTrigger value="cd-dvd"><Disc className="h-3.5 w-3.5 mr-1.5" />CD/DVD</TabsTrigger>
            <TabsTrigger value="network"><Network className="h-3.5 w-3.5 mr-1.5" />Network</TabsTrigger>
            <TabsTrigger value="boot"><Settings className="h-3.5 w-3.5 mr-1.5" />Boot</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto mt-4">
            <TabsContent value="general">
              <GeneralTab vm={frozenVm.current} conn={conn} onSaved={onSaved} />
            </TabsContent>
            <TabsContent value="cpu-memory">
              <CpuMemoryTab vm={frozenVm.current} conn={conn} onSaved={onSaved} />
            </TabsContent>
            <TabsContent value="disks">
              <DisksTab vm={frozenVm.current} conn={conn} />
            </TabsContent>
            <TabsContent value="cd-dvd">
              <CdDvdTab vm={frozenVm.current} conn={conn} />
            </TabsContent>
            <TabsContent value="network">
              <NetworkTab vm={frozenVm.current} conn={conn} />
            </TabsContent>
            <TabsContent value="boot">
              <BootTab vm={frozenVm.current} conn={conn} onSaved={onSaved} />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
