"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Plus, Trash2, HardDrive, Disc, Network, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { XenHostRecord, XenTemplate } from "@/lib/types";

// ── Types ──

interface ConnInfo {
  host: { address: string; port: number; useSsl: boolean };
  session: { sessionRef: string } | null;
  connectedVia?: string;
}

interface CreateVmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string;
  conn: ConnInfo;
  hostRecords: XenHostRecord[];
  targetHostRef?: string;
  onCreated: () => void;
}

interface PlannedDisk {
  id: string;
  srRef: string;
  nameLabel: string;
  sizeGiB: number;
}

interface PlannedCd {
  id: string;
  isoRef: string;
}

interface PlannedNic {
  id: string;
  networkRef: string;
  mac: string;
}

interface SRInfo { ref: string; nameLabel: string; type: string; physicalSize: number; physicalUtilisation: number }
interface IsoInfo { ref: string; nameLabel: string; srName: string }
interface NetworkInfo { ref: string; nameLabel: string; bridge: string }

// ── Helpers ──

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

function bytesToGiB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function gibToBytes(gib: number): number {
  return Math.round(gib * 1024 * 1024 * 1024);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

let _id = 0;
function uid() { return `p-${++_id}`; }

const STEPS = [
  "Template & Basics",
  "CPU, Memory & Firmware",
  "Disks",
  "CD/DVD",
  "Network",
  "Summary",
];

// ── Main Component ──

export function CreateVmDialog({
  open,
  onOpenChange,
  // hostId is kept in the interface for callers but not used here
  conn,
  hostRecords,
  targetHostRef,
  onCreated,
}: CreateVmDialogProps) {
  // Navigation
  const [step, setStep] = useState(0);

  // Step 0: Template & Basics
  const [templates, setTemplates] = useState<XenTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [selectedHost, setSelectedHost] = useState(targetHostRef || "");
  const [vmName, setVmName] = useState("");
  const [vmDescription, setVmDescription] = useState("");
  const [startAfter, setStartAfter] = useState(false);

  // Step 1: CPU & Memory & Firmware
  const [vcpus, setVcpus] = useState(1);
  const [memoryGiB, setMemoryGiB] = useState(1);
  const [firmware, setFirmware] = useState<"bios" | "uefi" | "uefi-sb">("uefi");

  // Step 2: Disks
  const [provisionSrRef, setProvisionSrRef] = useState("");
  const [systemDiskGiB, setSystemDiskGiB] = useState(0);
  const [plannedDisks, setPlannedDisks] = useState<PlannedDisk[]>([]);
  const [srs, setSrs] = useState<SRInfo[]>([]);
  const [srsLoaded, setSrsLoaded] = useState(false);
  const [loadingSrs, setLoadingSrs] = useState(false);

  // Step 3: CD/DVD
  const [plannedCds, setPlannedCds] = useState<PlannedCd[]>([{ id: uid(), isoRef: "" }]);
  const [isos, setIsos] = useState<IsoInfo[]>([]);
  const [isosLoaded, setIsosLoaded] = useState(false);
  const [loadingIsos, setLoadingIsos] = useState(false);

  // Step 4: Network
  const [plannedNics, setPlannedNics] = useState<PlannedNic[]>([]);
  const [networks, setNetworks] = useState<NetworkInfo[]>([]);
  const [netsLoaded, setNetsLoaded] = useState(false);
  const [loadingNets, setLoadingNets] = useState(false);

  // Creation
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // ── Reset on open (only when dialog transitions from closed → open) ──
  const prevOpen = useRef(false);
  useEffect(() => {
    const justOpened = open && !prevOpen.current;
    prevOpen.current = open;
    if (!justOpened || !conn.session) return;

    setStep(0);
    setLoadingTemplates(true);
    setTemplates([]);
    setSelectedTemplate("");
    setSelectedHost(targetHostRef || "");
    setVmName("");
    setVmDescription("");
    setStartAfter(false);
    setVcpus(1);
    setMemoryGiB(1);
    setFirmware("uefi");
    setProvisionSrRef("");
    setSystemDiskGiB(0);
    setPlannedDisks([]);
    setSrs([]);
    setSrsLoaded(false);
    setPlannedCds([{ id: uid(), isoRef: "" }]);
    setIsos([]);
    setIsosLoaded(false);
    setPlannedNics([]);
    setNetworks([]);
    setNetsLoaded(false);
    setCreating(false);
    setError("");

    apiCall(conn, { action: "vm_templates" })
      .then((data) => setTemplates(data.templates || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoadingTemplates(false));
  }, [open, conn, targetHostRef]);

  // ── Lazy data loading ──
  useEffect(() => {
    if (step === 2 && !srsLoaded && !loadingSrs) {
      setLoadingSrs(true);
      apiCall(conn, { action: "vm_srs" })
        .then((d) => {
          const loaded = d.srs || [];
          setSrs(loaded);
          setSrsLoaded(true);
          if (loaded.length > 0 && !provisionSrRef) {
            const eligible = loaded.filter((s: SRInfo) => s.type !== "tmpfs");
            if (eligible.length > 0) {
              const best = eligible.reduce((a: SRInfo, b: SRInfo) =>
                (b.physicalSize - b.physicalUtilisation) > (a.physicalSize - a.physicalUtilisation) ? b : a
              );
              setProvisionSrRef(best.ref);
            }
          }
        })
        .catch(() => {})
        .finally(() => setLoadingSrs(false));
    }
  }, [step, srsLoaded, loadingSrs, conn]);

  useEffect(() => {
    if (step === 3 && !isosLoaded && !loadingIsos) {
      setLoadingIsos(true);
      apiCall(conn, { action: "vm_isos" })
        .then((d) => { setIsos(d.isos || []); setIsosLoaded(true); })
        .catch(() => {})
        .finally(() => setLoadingIsos(false));
    }
  }, [step, isosLoaded, loadingIsos, conn]);

  useEffect(() => {
    if (step === 4 && !netsLoaded && !loadingNets) {
      setLoadingNets(true);
      apiCall(conn, { action: "pool_networks" })
        .then((d) => {
          const nets: NetworkInfo[] = d.networks || [];
          setNetworks(nets);
          setNetsLoaded(true);
          // Default: one NIC on first network if none planned
          if (plannedNics.length === 0 && nets.length > 0) {
            setPlannedNics([{ id: uid(), networkRef: nets[0].ref, mac: "" }]);
          }
        })
        .catch(() => {})
        .finally(() => setLoadingNets(false));
    }
  }, [step, netsLoaded, loadingNets, conn, plannedNics.length]);

  // ── Derived: selected template info ──
  const selectedTemplateMeta = templates.find((t) => t.ref === selectedTemplate);
  const isPvTemplate = selectedTemplateMeta?.domainType === "pv" || selectedTemplateMeta?.domainType === "pv_in_pvh";

  // ── Template change handler ──
  function handleTemplateChange(ref: string) {
    setSelectedTemplate(ref);
    const tmpl = templates.find((t) => t.ref === ref);
    if (tmpl) {
      setVcpus(tmpl.vcpusAtStartup || 1);
      setMemoryGiB(Number(bytesToGiB(tmpl.memoryStaticMax)) || 1);
      // PV templates don't support firmware selection
      const isPv = tmpl.domainType === "pv" || tmpl.domainType === "pv_in_pvh";
      if (isPv) {
        setFirmware("bios");
      }
      // Parse default system disk size from provision XML
      const sizeMatch = tmpl.disksXml?.match(/size="(\d+)"/);
      const defaultBytes = sizeMatch ? Number(sizeMatch[1]) : 0;
      setSystemDiskGiB(defaultBytes > 0 ? parseFloat((defaultBytes / (1024 * 1024 * 1024)).toFixed(1)) : 0);
    }
  }

  // ── Create handler ──
  async function handleCreate() {
    setCreating(true);
    setError("");
    try {
      await apiCall(conn, {
        action: "vm_create_wizard",
        templateRef: selectedTemplate,
        vmName: vmName.trim(),
        vmDescription: vmDescription.trim(),
        vcpus,
        memoryBytes: gibToBytes(memoryGiB),
        startAfter,
        targetHostRef: selectedHost || undefined,
        firmware: firmware === "uefi-sb" ? "uefi" : firmware,
        secureboot: firmware === "uefi-sb",
        provisionSrRef: provisionSrRef || undefined,
        systemDiskSizeBytes: systemDiskGiB > 0 ? gibToBytes(systemDiskGiB) : undefined,
        extraDisks: plannedDisks.map((d) => ({ srRef: d.srRef, nameLabel: d.nameLabel, sizeBytes: gibToBytes(d.sizeGiB) })),
        extraCds: plannedCds.map((c) => ({ isoRef: c.isoRef || undefined })),
        extraNics: plannedNics.map((n) => ({ networkRef: n.networkRef, mac: n.mac || undefined })),
      });

      onOpenChange(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Creation failed");
    } finally {
      setCreating(false);
    }
  }

  // ── Validation ──
  const enabledHosts = hostRecords.filter((h) => h.enabled);
  const customTemplates = templates.filter((t) => !t.nameLabel.match(/^\[.*\]/));
  const defaultTemplates = templates.filter((t) => t.nameLabel.match(/^\[.*\]/));

  function canAdvance(): boolean {
    if (step === 0) return !!(selectedTemplate && vmName.trim());
    if (step === 4) return plannedNics.every((n) => n.networkRef);
    return true;
  }

  // ── Step progress indicator ──
  function StepIndicator() {
    return (
      <div className="flex items-center gap-1 pt-2 pb-1">
        {STEPS.map((_, i) => (
          <React.Fragment key={i}>
            {i > 0 && <div className={cn("h-px flex-1", i <= step ? "bg-primary" : "bg-zinc-200 dark:bg-zinc-800")} />}
            <div className={cn(
              "h-2 w-2 rounded-full shrink-0 transition-colors",
              i < step ? "bg-primary" :
              i === step ? "bg-primary ring-2 ring-primary/30" :
              "bg-zinc-200 dark:bg-zinc-800"
            )} />
          </React.Fragment>
        ))}
      </div>
    );
  }

  // ── Step content renderer ──
  function renderStep() {
    switch (step) {
      case 0: return renderTemplateBasics();
      case 1: return renderCpuMemory();
      case 2: return renderDisks();
      case 3: return renderCdDvd();
      case 4: return renderNetwork();
      case 5: return renderSummary();
      default: return null;
    }
  }

  // ── Step 0: Template & Basics ──
  function renderTemplateBasics() {
    if (loadingTemplates) {
      return (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          <span className="ml-2 text-sm text-zinc-500">Loading templates...</span>
        </div>
      );
    }
    return (
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label>Home Server</Label>
          <Select value={selectedHost || "__none__"} onValueChange={(v) => setSelectedHost(v === "__none__" ? "" : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {enabledHosts.map((h) => (
                <SelectItem key={h.ref} value={h.ref}>{h.nameLabel} ({h.address})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label>Template</Label>
          <Select value={selectedTemplate} onValueChange={handleTemplateChange}>
            <SelectTrigger><SelectValue placeholder="Select template..." /></SelectTrigger>
            <SelectContent>
              {customTemplates.length > 0 && customTemplates.map((t) => (
                <SelectItem key={t.ref} value={t.ref}>{t.nameLabel}</SelectItem>
              ))}
              {defaultTemplates.map((t) => (
                <SelectItem key={t.ref} value={t.ref}>{t.nameLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="vmName">VM Name</Label>
          <Input id="vmName" placeholder="My Virtual Machine" value={vmName} onChange={(e) => setVmName(e.target.value)} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="vmDesc">Description</Label>
          <Input id="vmDesc" placeholder="Optional description" value={vmDescription} onChange={(e) => setVmDescription(e.target.value)} />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <Label htmlFor="startAfter" className="cursor-pointer">Start after creation</Label>
          <Switch id="startAfter" checked={startAfter} onCheckedChange={setStartAfter} />
        </div>
      </div>
    );
  }

  // ── Step 1: CPU, Memory & Firmware ──
  function renderCpuMemory() {
    return (
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="vcpus">vCPUs</Label>
            <Input id="vcpus" type="number" min={1} max={64} value={vcpus} onChange={(e) => setVcpus(Math.max(1, parseInt(e.target.value) || 1))} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="memory">Memory (GiB)</Label>
            <Input id="memory" type="number" min={0.25} step={0.25} value={memoryGiB} onChange={(e) => setMemoryGiB(Math.max(0.25, parseFloat(e.target.value) || 0.25))} />
          </div>
        </div>

        {!isPvTemplate && (
          <div className="grid gap-2">
            <Label>Firmware</Label>
            <Select value={firmware} onValueChange={(v) => setFirmware(v as typeof firmware)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bios">BIOS</SelectItem>
                <SelectItem value="uefi">UEFI</SelectItem>
                <SelectItem value="uefi-sb">UEFI + Secure Boot</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    );
  }

  // ── Step 2: Disks ──
  function renderDisks() {
    if (loadingSrs) {
      return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>;
    }

    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">System Disk Storage</Label>
          <div className="flex gap-2">
            <div className="flex-1">
              <Select value={provisionSrRef} onValueChange={setProvisionSrRef}>
                <SelectTrigger className="h-8"><SelectValue placeholder="Select SR for template disk" /></SelectTrigger>
                <SelectContent>
                  {srs.filter((sr) => sr.type !== "tmpfs").map((sr) => (
                    <SelectItem key={sr.ref} value={sr.ref}>
                      {sr.nameLabel} ({formatBytes(sr.physicalSize - sr.physicalUtilisation)} free)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {systemDiskGiB > 0 && (
              <div className="w-28">
                <div className="relative">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={systemDiskGiB}
                    onChange={(e) => setSystemDiskGiB(Math.max(1, parseFloat(e.target.value) || 1))}
                    className="h-8 pr-9"
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-zinc-400">GiB</span>
                </div>
              </div>
            )}
          </div>
          <p className="text-xs text-zinc-500">Storage repository and size for the template&apos;s default system disk.</p>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500" />
          <p className="text-xs text-blue-600 dark:text-blue-400">Additional disks can be added below. They are created in addition to the template&apos;s default disk.</p>
        </div>

        {plannedDisks.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>SR</TableHead>
                <TableHead>Size</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {plannedDisks.map((d) => {
                const sr = srs.find((s) => s.ref === d.srRef);
                return (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs">{d.nameLabel}</TableCell>
                    <TableCell className="text-xs">{sr?.nameLabel || "—"}</TableCell>
                    <TableCell className="text-xs">{d.sizeGiB} GiB</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500" onClick={() => setPlannedDisks((p) => p.filter((x) => x.id !== d.id))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <DiskAddForm srs={srs} defaultName={`${vmName.trim() || "VM"}-disk${plannedDisks.length + 1}`} onAdd={(d) => setPlannedDisks((p) => [...p, d])} />
      </div>
    );
  }

  // ── Step 3: CD/DVD ──
  function renderCdDvd() {
    if (loadingIsos) {
      return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>;
    }

    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500" />
          <p className="text-xs text-blue-600 dark:text-blue-400">Templates typically include one CD/DVD drive. Drives below are added in addition.</p>
        </div>

        {plannedCds.map((cd) => (
          <div key={cd.id} className="flex items-center gap-2 rounded-lg border p-3">
            <Disc className="h-4 w-4 shrink-0 text-zinc-400" />
            <Select value={cd.isoRef || "__empty__"} onValueChange={(v) => setPlannedCds((p) => p.map((c) => c.id === cd.id ? { ...c, isoRef: v === "__empty__" ? "" : v } : c))}>
              <SelectTrigger className="flex-1 h-8"><SelectValue placeholder="Empty drive" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__empty__">Empty drive</SelectItem>
                {isos.map((iso) => (
                  <SelectItem key={iso.ref} value={iso.ref}>{iso.nameLabel}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500" onClick={() => setPlannedCds((p) => p.filter((c) => c.id !== cd.id))}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}

        <Button variant="outline" size="sm" onClick={() => setPlannedCds((p) => [...p, { id: uid(), isoRef: "" }])}>
          <Plus className="h-4 w-4 mr-1" /> Add CD/DVD Drive
        </Button>
      </div>
    );
  }

  // ── Step 4: Network ──
  function renderNetwork() {
    if (loadingNets) {
      return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>;
    }

    return (
      <div className="space-y-4">
        {plannedNics.map((nic) => (
          <div key={nic.id} className="flex items-center gap-2 rounded-lg border p-3">
            <Network className="h-4 w-4 shrink-0 text-zinc-400" />
            <Select value={nic.networkRef} onValueChange={(v) => setPlannedNics((p) => p.map((n) => n.id === nic.id ? { ...n, networkRef: v } : n))}>
              <SelectTrigger className="flex-1 h-8"><SelectValue placeholder="Select network..." /></SelectTrigger>
              <SelectContent>
                {networks.map((net) => (
                  <SelectItem key={net.ref} value={net.ref}>{net.nameLabel} ({net.bridge})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="Auto MAC"
              value={nic.mac}
              onChange={(e) => setPlannedNics((p) => p.map((n) => n.id === nic.id ? { ...n, mac: e.target.value } : n))}
              className="w-36 h-8 text-xs font-mono"
            />
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500" onClick={() => setPlannedNics((p) => p.filter((n) => n.id !== nic.id))}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}

        <Button variant="outline" size="sm" onClick={() => setPlannedNics((p) => [...p, { id: uid(), networkRef: networks[0]?.ref || "", mac: "" }])}>
          <Plus className="h-4 w-4 mr-1" /> Add Network Interface
        </Button>
      </div>
    );
  }

  // ── Step 5: Summary ──
  function renderSummary() {
    const tmpl = templates.find((t) => t.ref === selectedTemplate);
    const host = selectedHost ? hostRecords.find((h) => h.ref === selectedHost) : null;
    const fwLabel = firmware === "bios" ? "BIOS" : firmware === "uefi" ? "UEFI" : "UEFI + Secure Boot";

    return (
      <div className="space-y-4">
        <SummarySection title="Basics">
          <SummaryRow label="Template" value={tmpl?.nameLabel || "—"} />
          <SummaryRow label="Home Server" value={host ? `${host.nameLabel} (${host.address})` : "None"} />
          <SummaryRow label="Name" value={vmName} />
          {vmDescription && <SummaryRow label="Description" value={vmDescription} />}
          <SummaryRow label="Start after creation" value={startAfter ? "Yes" : "No"} />
        </SummarySection>

        <SummarySection title="CPU, Memory & Firmware">
          <SummaryRow label="vCPUs" value={String(vcpus)} />
          <SummaryRow label="Memory" value={`${memoryGiB} GiB`} />
          <SummaryRow label="Firmware" value={fwLabel} />
        </SummarySection>

        <SummarySection title="Disks">
          <SummaryRow label="System Disk" value={`${srs.find((s) => s.ref === provisionSrRef)?.nameLabel || "Pool default"}${systemDiskGiB > 0 ? ` — ${systemDiskGiB} GiB` : ""}`} />
          {plannedDisks.length === 0 ? (
            <p className="text-xs text-zinc-500">No additional disks</p>
          ) : (
            plannedDisks.map((d) => {
              const sr = srs.find((s) => s.ref === d.srRef);
              return <SummaryRow key={d.id} label={d.nameLabel} value={`${d.sizeGiB} GiB on ${sr?.nameLabel || "—"}`} />;
            })
          )}
        </SummarySection>

        <SummarySection title="Additional CD/DVD Drives">
          {plannedCds.length === 0 ? (
            <p className="text-xs text-zinc-500">None (template defaults only)</p>
          ) : (
            plannedCds.map((c) => {
              const iso = isos.find((i) => i.ref === c.isoRef);
              return <SummaryRow key={c.id} label="CD/DVD" value={iso?.nameLabel || "Empty"} />;
            })
          )}
        </SummarySection>

        <SummarySection title="Additional Network Interfaces">
          {plannedNics.length === 0 ? (
            <p className="text-xs text-zinc-500">None</p>
          ) : (
            plannedNics.map((n) => {
              const net = networks.find((x) => x.ref === n.networkRef);
              return <SummaryRow key={n.id} label={net?.nameLabel || "—"} value={n.mac || "Auto MAC"} />;
            })
          )}
        </SummarySection>

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!creating) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl h-[70vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Create Virtual Machine</DialogTitle>
          <DialogDescription>
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </DialogDescription>
          <StepIndicator />
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {renderStep()}
        </div>

        <DialogFooter className="flex-row gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
          <div className="flex-1" />
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep(step - 1)} disabled={creating}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(step + 1)} disabled={!canAdvance()}>
              Next
            </Button>
          ) : (
            <Button onClick={handleCreate} disabled={creating || !canAdvance()}>
              {creating ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...</> : "Create"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Sub-components ──

function DiskAddForm({ srs, defaultName, onAdd }: { srs: SRInfo[]; defaultName: string; onAdd: (d: PlannedDisk) => void }) {
  const [srRef, setSrRef] = useState("");
  const [name, setName] = useState("");
  const [size, setSize] = useState(20);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (srRef) return;
    const eligible = srs.filter((s) => s.type !== "iso" && s.type !== "udev" && s.type !== "tmpfs");
    if (eligible.length === 0) return;
    const best = eligible.reduce((a, b) =>
      (b.physicalSize - b.physicalUtilisation) > (a.physicalSize - a.physicalUtilisation) ? b : a
    );
    setSrRef(best.ref);
  }, [srs, srRef]);

  if (!showForm) {
    return (
      <Button variant="outline" size="sm" onClick={() => { setName(defaultName); setShowForm(true); }}>
        <Plus className="h-4 w-4 mr-1" /> Add Disk
      </Button>
    );
  }

  function handleAdd() {
    if (!srRef || !name.trim() || size <= 0) return;
    onAdd({ id: uid(), srRef, nameLabel: name.trim(), sizeGiB: size });
    setName("");
    setSize(20);
    setShowForm(false);
  }

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="grid gap-2">
        <Label className="text-xs">Storage Repository</Label>
        <Select value={srRef} onValueChange={setSrRef}>
          <SelectTrigger className="h-8"><SelectValue placeholder="Select SR..." /></SelectTrigger>
          <SelectContent>
            {srs.filter((s) => s.type !== "iso" && s.type !== "udev" && s.type !== "tmpfs").map((s) => (
              <SelectItem key={s.ref} value={s.ref}>
                {s.nameLabel} ({formatBytes(s.physicalSize - s.physicalUtilisation)} free)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label className="text-xs">Name</Label>
          <Input className="h-8" placeholder="Disk name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label className="text-xs">Size (GiB)</Label>
          <Input className="h-8" type="number" min={1} value={size} onChange={(e) => setSize(Math.max(1, parseInt(e.target.value) || 1))} />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
        <Button size="sm" onClick={handleAdd} disabled={!srRef || !name.trim()}>
          <Plus className="h-4 w-4 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}

function SummarySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{title}</h4>
      <div className="rounded-lg border divide-y">{children}</div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="text-xs font-medium">{value}</span>
    </div>
  );
}
