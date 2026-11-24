"use client";

import { useEffect, useMemo, useState } from "react";
import { XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import { nextRun, VMSS_DAYS, VMSS_MINUTES, type VmssFrequency, type VmssOverview, type VmssSchedule, type VmssType } from "@/lib/xen-vmss";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDates } from "@/context/date-format-context";
import { vmssCall } from "@/components/pool/snapshot-schedules-tab";

/** XenCenter's defaults when the frequency is chosen (NewPolicySnapshotFrequencyPage). */
const KEEP_DEFAULT: Record<VmssFrequency, number> = { hourly: 10, daily: 7, weekly: 4 };
const DAY_SHORT: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun",
};
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-21 15:30" (the pool's wall clock) as a Date held in UTC fields. */
function parseWall(s: string | null): Date | null {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s) : null;
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
}

/**
 * New or Edit Snapshot Schedule: XenCenter's New Policy wizard on one page --
 * name, VMs, snapshot type, schedule, how many to keep, and a first run.
 */
export function SnapshotScheduleDialog({
  open,
  onOpenChange,
  conn,
  overview,
  schedule,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn: HostConnection;
  overview: VmssOverview;
  /** The one edited; null: a new one. */
  schedule: VmssSchedule | null;
  onSaved: () => void;
}) {
  const dates = useDates();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [type, setType] = useState<VmssType>("snapshot");
  const [frequency, setFrequency] = useState<VmssFrequency>("daily");
  const [min, setMin] = useState(0);
  const [hour, setHour] = useState(0);
  const [days, setDays] = useState<string[]>([]);
  const [retained, setRetained] = useState(7);
  const [vms, setVms] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [runNow, setRunNow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each time it opens: the schedule as it is, or XenCenter's defaults.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const s = schedule;
      setName(s?.name ?? "");
      setDescription(s?.description ?? "");
      setEnabled(s?.enabled ?? true);
      setType(s?.type ?? "snapshot");
      setFrequency(s?.frequency ?? "daily");
      setMin(s?.min ?? 0);
      setHour(s?.hour ?? 0);
      setDays(s?.days ?? []);
      setRetained(s?.retained || 7);
      setVms(new Set(s?.vms ?? []));
      setFilter("");
      setRunNow(false);
      setError(null);
    }, 0);
    return () => clearTimeout(t);
    // Only on opening: a new overview read meanwhile must not undo what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chooseFrequency = (f: VmssFrequency) => {
    setFrequency(f);
    setRetained(KEEP_DEFAULT[f]);
  };

  const scheduleName = (ref: string | null) => overview.schedules.find((s) => s.ref === ref)?.name;
  const shownVms = overview.vms.filter((v) => v.name.toLowerCase().includes(filter.trim().toLowerCase()));

  // The next run, as XenCenter shows it: in the pool's time and in this browser's.
  const preview = useMemo(() => {
    const now = parseWall(overview.serverLocalTime);
    if (!now || (frequency === "weekly" && days.length === 0)) return null;
    const next = nextRun(frequency, min, hour, days, now);
    if (!next) return null;
    const pool = `${DAY_SHORT[VMSS_DAYS[(next.getUTCDay() + 6) % 7]]} ${pad(next.getUTCDate())}.${pad(next.getUTCMonth() + 1)}. ${pad(next.getUTCHours())}:${pad(next.getUTCMinutes())}`;
    const yours = dates.dateTime(Date.now() + (next.getTime() - now.getTime()), { seconds: false });
    return { pool, yours };
  }, [overview.serverLocalTime, frequency, min, hour, days, dates]);

  const invalid = !name.trim() || (frequency === "weekly" && days.length === 0);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await vmssCall(conn, {
        action: "vmss_save",
        ...(schedule ? { vmssRef: schedule.ref } : {}),
        schedule: { name: name.trim(), description, enabled, type, retained, frequency, min, hour, days, vms: [...vms], runNow: !schedule && runNow },
      });
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The schedule could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const radio = (checked: boolean, onChange: () => void, label: string, hint?: string, disabled = false) => (
    <label className={`flex items-start gap-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input type="radio" className="mt-1" checked={checked} onChange={onChange} disabled={disabled} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit Snapshot Schedule" : "New Snapshot Schedule"}</DialogTitle>
          <DialogDescription>Snapshots of the selected VMs are taken on a schedule; the oldest are deleted.</DialogDescription>
        </DialogHeader>

        {/* Only this part scrolls: the title and the buttons stay in view. */}
        <div className="-mr-2 min-h-0 flex-1 space-y-5 overflow-y-auto pr-2 text-sm">
          <section className="grid gap-2 sm:grid-cols-[8rem_1fr] sm:items-center">
            <Label htmlFor="vmss-name">Name</Label>
            <Input id="vmss-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
            <Label htmlFor="vmss-desc">Description</Label>
            <Input id="vmss-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1024} />
            <span />
            <div className="flex items-center gap-2">
              <Switch id="vmss-enabled" checked={enabled} onCheckedChange={setEnabled} />
              <Label htmlFor="vmss-enabled" className="font-normal">Enabled</Label>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Virtual Machines</h3>
            <Input placeholder="Filter VMs" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {shownVms.length === 0 && <p className="text-muted-foreground">No VMs.</p>}
              {shownVms.map((v) => {
                const other = v.schedule && v.schedule !== schedule?.ref ? scheduleName(v.schedule) : null;
                return (
                  <label key={v.ref} className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={vms.has(v.ref)}
                      onChange={(e) =>
                        setVms((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(v.ref);
                          else n.delete(v.ref);
                          return n;
                        })
                      }
                    />
                    <span className="truncate">{v.name}</span>
                    {other && <span className="truncate text-xs text-muted-foreground">in {other}</span>}
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {vms.size} selected. A VM can be in one schedule only; a VM in another schedule moves to this one.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Snapshot Type</h3>
            {radio(
              type === "snapshot",
              () => setType("snapshot"),
              "Disk only snapshot",
              "The VM's disks (storage) and metadata are saved. Crash-consistent; works for all VM types.",
              type === "snapshot_with_quiesce",
            )}
            {radio(
              type === "checkpoint",
              () => setType("checkpoint"),
              "Disk and memory snapshot",
              overview.checkpointAllowed
                ? "Also saves the VM's memory (RAM). These snapshots can be very large: make sure there is enough storage."
                : "This feature is disabled due to license restrictions on the server.",
              type === "snapshot_with_quiesce" || (!overview.checkpointAllowed && schedule?.type !== "checkpoint"),
            )}
            {type === "snapshot_with_quiesce" &&
              radio(true, () => {}, "Quiesced snapshot", "No longer available on current XenServer releases; kept as it is.")}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Schedule</h3>
            <div className="flex flex-wrap gap-4">
              {radio(frequency === "hourly", () => chooseFrequency("hourly"), "Hourly")}
              {radio(frequency === "daily", () => chooseFrequency("daily"), "Daily")}
              {radio(frequency === "weekly", () => chooseFrequency("weekly"), "Weekly")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {frequency === "hourly" ? (
                <>
                  <span>At</span>
                  <Select value={String(min)} onValueChange={(v) => setMin(Number(v))}>
                    <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper">
                      {VMSS_MINUTES.map((m) => <SelectItem key={m} value={String(m)}>{pad(m)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <span>minutes past each hour</span>
                </>
              ) : (
                <>
                  <span>At</span>
                  <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                    <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper">
                      {Array.from({ length: 24 }, (_, h) => <SelectItem key={h} value={String(h)}>{pad(h)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <span>:</span>
                  <Select value={String(min)} onValueChange={(v) => setMin(Number(v))}>
                    <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper">
                      {VMSS_MINUTES.map((m) => <SelectItem key={m} value={String(m)}>{pad(m)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground">pool time</span>
                </>
              )}
            </div>
            {frequency === "weekly" && (
              <div className="flex flex-wrap gap-3">
                {VMSS_DAYS.map((d) => (
                  <label key={d} className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={days.includes(d)}
                      onChange={(e) => setDays((ds) => (e.target.checked ? VMSS_DAYS.filter((x) => x === d || ds.includes(x)) : ds.filter((x) => x !== d)))}
                    />
                    {DAY_SHORT[d]}
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {preview
                ? `Next run: ${preview.pool} (pool time) · ${preview.yours} (your time)`
                : overview.serverLocalTime
                  ? "Select at least one day."
                  : "The pool coordinator's time could not be read; times are its local time."}
            </p>
          </section>

          <section className="flex flex-wrap items-center gap-2">
            <Label htmlFor="vmss-keep" className="font-normal">Number of snapshots to keep</Label>
            <Select value={String(retained)} onValueChange={(v) => setRetained(Number(v))}>
              <SelectTrigger id="vmss-keep" className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent position="popper">
                {Array.from({ length: 10 }, (_, i) => <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">The oldest snapshot is deleted when a new one is taken.</span>
          </section>

          {!schedule && (
            <div className="flex items-center gap-2">
              <Switch id="vmss-now" checked={runNow} onCheckedChange={setRunNow} disabled={vms.size === 0} />
              <Label htmlFor="vmss-now" className="font-normal">Take the first snapshots now</Label>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p>{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || invalid}>
            {saving ? "Saving" : schedule ? "Save" : "Create Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
