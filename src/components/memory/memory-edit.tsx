"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Circle, Loader2, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import { memorySize, type MemoryEditContext, type VmMemoryRow } from "@/lib/xen-memory";
import type { VmMemoryJob } from "@/lib/vm-memory-job";
import {
  amounts,
  basisOf,
  change,
  displayRange,
  dmcUnavailable,
  finalChange,
  fromDisplay,
  GIB,
  increment,
  initialState,
  MIB,
  ranges,
  settle,
  toDisplay,
  unitsFor,
  type MemoryEditBasis,
  type MemoryEditState,
  type SpinnerRange,
  type Units,
} from "@/lib/vm-memory-edit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { xenNet } from "@/components/networking/host-networking";
import { Grid, Segment, Shine, SliderHandle, UNUSED, useWidth, VM_USED } from "./shiny-bar";

// XenCenter's "Edit..." on the Memory tab: for one VM the Memory Settings
// dialog (BallooningDialog), for several the Memory Settings wizard
// (BallooningWizard: ChooseVMs, MemorySettings). The controls are
// VMMemoryControlsBasic (a fixed memory, or a range) or, when the VM already
// uses a range below its static maximum, VMMemoryControlsAdvanced. Texts as
// XenCenter's. The change runs as a job in XenMan (lib/vm-memory-job.ts).

type Step = "vms" | "settings";
const STEPS: Record<Step, { label: string; title: string }> = {
  vms: { label: "Select VMs", title: "Choose the VMs whose memory settings you want to adjust" },
  settings: { label: "Adjust memory settings", title: "Configure the memory settings for your selected VMs" },
};

export function MemoryEditDialog({
  conn,
  row,
  ctx,
  onClose,
  onChanged,
}: {
  conn: HostConnection;
  row: VmMemoryRow;
  ctx: MemoryEditContext;
  onClose: () => void;
  onChanged: () => void;
}) {
  const wizard = row.vms.length > 1;
  const [step, setStep] = useState<Step>(wizard ? "vms" : "settings");
  const [checked, setChecked] = useState<string[]>(row.vms.map((v) => v.ref));
  const chosen = row.vms.filter((v) => checked.includes(v.ref));
  const basis = basisOf(row, chosen, ctx);
  const units = unitsFor(row.staticMax);

  // MemorySettings.PageLoaded: set up again only when the choice of VMs changed.
  const [state, setState] = useState<{ key: string; value: MemoryEditState }>(() => ({
    key: checked.join(),
    value: settle(basis, initialState(row, ctx), units),
  }));
  const goToSettings = () => {
    if (state.key !== checked.join()) setState({ key: checked.join(), value: settle(basis, initialState(row, ctx), units) });
    setStep("settings");
  };

  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<VmMemoryJob | null>(null);

  const submit = async (confirmReboot: boolean) => {
    const fc = finalChange(basis, state.value);
    setBusy(true);
    setError(null);
    try {
      const res = await xenNet(conn, {
        action: "vm_memory_change",
        vmRefs: chosen.map((v) => v.ref),
        dynamicMin: fc.dynamicMin,
        dynamicMax: fc.dynamicMax,
        staticMax: fc.staticMax,
        confirmReboot,
      });
      setJob(res.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const finish = () => {
    // ChangeMemorySettings: ask first when VMs that are not halted must be rebooted.
    const fc = finalChange(basis, state.value);
    if (fc.confirm) setConfirm(fc.confirm);
    else void submit(false);
  };

  // The job's progress, until it is over.
  const jobId = job?.id;
  const jobRunning = job?.state === "running";
  const changedRef = useRef(onChanged);
  useEffect(() => {
    changedRef.current = onChanged;
  });
  useEffect(() => {
    if (!jobId || !jobRunning) return;
    const timer = setInterval(async () => {
      try {
        const res = await xenNet(conn, { action: "vm_memory_job_status", jobId });
        setJob(res.job);
        if (res.job.state !== "running") changedRef.current();
      } catch {
        // The next poll may get through.
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [conn, jobId, jobRunning]);

  const settings = (
    <SettingsPage
      basis={basis}
      state={state.value}
      units={units}
      onChange={(value) => setState((s) => ({ ...s, value }))}
      rubric={
        wizard
          ? "Assign the VMs a fixed memory or indicate the range you want them to use. When ready, press Finish to apply the configuration."
          : state.value.advanced
            ? "Set the memory range and static maximum memory for this VM."
            : "Set a fixed memory for this VM, or set a memory range and allow the VM's memory allocation to be adjusted automatically."
      }
    />
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className={`overflow-hidden p-0 ${wizard ? "sm:max-w-4xl" : "sm:max-w-2xl"}`}>
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Memory Settings</DialogTitle>
        </DialogHeader>

        {job ? (
          <div className="max-h-[calc(100dvh-14rem)] overflow-y-auto p-6 text-sm">
            <JobView job={job} />
          </div>
        ) : wizard ? (
          <div className="flex min-w-0 h-[min(560px,calc(100dvh-12rem))] flex-col sm:flex-row">
            <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-52 sm:flex-col sm:border-b-0 sm:border-r">
              {(Object.keys(STEPS) as Step[]).map((s) => (
                <div key={s} className={`rounded-md px-3 py-2 text-sm whitespace-nowrap ${s === step ? "bg-accent font-medium" : "text-muted-foreground"}`}>
                  {STEPS[s].label}
                </div>
              ))}
            </nav>
            <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-6 text-sm">
              <h3 className="text-base font-semibold">{STEPS[step].title}</h3>
              {step === "vms" ? (
                <ChooseVms row={row} checked={checked} onChange={setChecked} />
              ) : (
                settings
              )}
              {error && <ErrorNote text={error} />}
            </div>
          </div>
        ) : (
          <div className="max-h-[calc(100dvh-14rem)] space-y-4 overflow-y-auto p-6 text-sm">
            {settings}
            {error && <ErrorNote text={error} />}
          </div>
        )}

        <DialogFooter className="border-t px-6 py-3">
          {job ? (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          ) : wizard ? (
            <>
              <Button variant="outline" disabled={step === "vms" || busy} onClick={() => setStep("vms")}>
                &lt; Previous
              </Button>
              {step === "vms" ? (
                <Button disabled={!checked.length} onClick={goToSettings}>
                  Next &gt;
                </Button>
              ) : (
                <Button disabled={busy} onClick={finish}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Finish
                </Button>
              )}
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={finish}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                OK
              </Button>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            </>
          )}
        </DialogFooter>

        {/* WarningDialog with Yes / No, inside the dialog so its focus trap lets it be used. */}
        <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Memory Settings
              </AlertDialogTitle>
              <AlertDialogDescription className="whitespace-pre-line">{`${confirm ?? ""}\n\nDo you want to continue?`}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button disabled={busy} onClick={() => void submit(true)}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Yes
              </Button>
              <AlertDialogCancel disabled={busy}>No</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 whitespace-pre-line text-destructive">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
      {text}
    </p>
  );
}

/** ChooseVMs: the row's VMs, all checked; Select All / Clear All. */
function ChooseVms({ row, checked, onChange }: { row: VmMemoryRow; checked: string[]; onChange: (refs: string[]) => void }) {
  const toggle = (ref: string, on: boolean) =>
    onChange(on ? [...checked.filter((r) => r !== ref), ref] : checked.filter((r) => r !== ref));
  return (
    <>
      <p>Select which VMs you would like to configure from the list below.</p>
      <div className="max-h-72 overflow-y-auto rounded-md border p-2">
        {row.vms.map((vm) => (
          <label key={vm.ref} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-accent">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={checked.includes(vm.ref)} onChange={(e) => toggle(vm.ref, e.target.checked)} />
            {vm.name}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={checked.length === row.vms.length} onClick={() => onChange(row.vms.map((v) => v.ref))}>
          Select All
        </Button>
        <Button variant="outline" size="sm" disabled={!checked.length} onClick={() => onChange([])}>
          Clear All
        </Button>
      </div>
    </>
  );
}

/** The controls: Basic (fixed or a range, with the bar) or Advanced (range and static maximum). */
function SettingsPage({
  basis,
  state,
  units,
  onChange,
  rubric,
}: {
  basis: MemoryEditBasis;
  state: MemoryEditState;
  units: Units;
  onChange: (s: MemoryEditState) => void;
  rubric: string;
}) {
  const r = ranges(basis, state);
  const set = (field: "fixed" | "dynMin" | "dynMax" | "statMax") => (bytes: number) => onChange(change(basis, state, field, bytes, units));
  const unitLabel = units === "GB" ? "GiB" : "MiB";
  const staticMax = amounts(state).staticMax;

  if (state.advanced) {
    return (
      <div className="space-y-4">
        <p>{rubric}</p>
        <div className="grid max-w-md grid-cols-[auto_auto_auto] items-center gap-x-3 gap-y-2">
          <SpinnerRow label="Minimum memory:" value={state.dynMin} range={r.dynMin} units={units} unitLabel={unitLabel} staticMax={staticMax} onChange={set("dynMin")} />
          <SpinnerRow label="Maximum memory:" value={state.dynMax} range={r.dynMax} units={units} unitLabel={unitLabel} staticMax={staticMax} onChange={set("dynMax")} />
          <SpinnerRow label="Static maximum:" value={state.statMax} range={r.statMax} units={units} unitLabel={unitLabel} staticMax={staticMax} onChange={set("statMax")} />
        </div>
      </div>
    );
  }

  const reason = dmcUnavailable(basis);
  return (
    <div className="space-y-4">
      <p>{rubric}</p>
      <label className="flex flex-wrap items-center gap-2">
        <input type="radio" className="accent-primary" checked={!state.dynamic} onChange={() => onChange(settle(basis, { ...state, dynamic: false }, units))} />
        Set a fixed memory of
        <Spinner value={state.fixed} range={r.fixed} units={units} staticMax={staticMax} onChange={set("fixed")} />
        {unitLabel}
      </label>
      <label className={`flex items-center gap-2 ${reason ? "text-muted-foreground" : ""}`}>
        <input
          type="radio"
          className="accent-primary"
          disabled={Boolean(reason)}
          checked={state.dynamic}
          onChange={() => onChange(settle(basis, { ...state, dynamic: true }, units))}
        />
        Automatically allocate memory within this range:
      </label>
      {reason && (
        <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {reason}
        </p>
      )}
      <fieldset disabled={Boolean(reason)} className={`space-y-4 rounded-md border bg-muted/30 p-4 ${reason ? "opacity-60" : ""}`}>
        <EditBar basis={basis} state={state} units={units} onChange={onChange} />
        {basis.hasBallooning && (
          <div className="mx-auto grid w-fit grid-cols-[auto_auto_auto_auto] items-center gap-x-3 gap-y-2">
            <SliderHandle kind="min" />
            <SpinnerRow label="Minimum memory:" value={state.dynMin} range={r.dynMin} units={units} unitLabel={unitLabel} staticMax={staticMax} onChange={set("dynMin")} />
            <SliderHandle kind="max" />
            <SpinnerRow label="Maximum memory:" value={state.dynMax} range={r.dynMax} units={units} unitLabel={unitLabel} staticMax={staticMax} onChange={set("dynMax")} />
          </div>
        )}
      </fieldset>
    </div>
  );
}

function SpinnerRow(props: {
  label: string;
  value: number;
  range: SpinnerRange;
  units: Units;
  unitLabel: string;
  staticMax: number;
  onChange: (bytes: number) => void;
}) {
  return (
    <>
      <span>{props.label}</span>
      <Spinner value={props.value} range={props.range} units={props.units} staticMax={props.staticMax} onChange={props.onChange} />
      <span>{props.unitLabel}</span>
    </>
  );
}

/** MemorySpinner: GB with one decimal (MB up to 1 GiB), kept inside its range, taken when left or stepped. */
export function Spinner({
  value,
  range,
  units,
  staticMax,
  onChange,
}: {
  value: number;
  range: SpinnerRange;
  units: Units;
  staticMax: number;
  onChange: (bytes: number) => void;
}) {
  const shown = toDisplay(value, units);
  const text = units === "GB" ? shown.toFixed(1) : String(shown);
  const [draft, setDraft] = useState<string | null>(null);
  const [lo, hi] = range.min <= range.max ? displayRange(range.min, range.max, units) : [shown, shown];
  const step = increment(value, staticMax, units);

  const take = (v: number) => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(hi, Math.max(lo, v));
    const rounded = units === "GB" ? Math.round(clamped * 10) / 10 : Math.round(clamped);
    // Unchanged in what it shows: keep the exact amount (the spinner does not touch ValueMB).
    if (rounded !== shown) onChange(fromDisplay(rounded, units));
  };
  const commit = () => {
    if (draft !== null) take(Number(draft.replace(",", ".")));
    setDraft(null);
  };

  return (
    <span className="inline-flex items-stretch overflow-hidden rounded-md border bg-background">
      <input
        className="w-20 bg-transparent px-2 py-1 text-right tabular-nums outline-none disabled:opacity-60"
        inputMode="decimal"
        value={draft ?? text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setDraft(null);
            take(shown + (e.key === "ArrowUp" ? step : -step));
          }
        }}
      />
      <span className="flex flex-col border-l">
        <button type="button" className="flex h-1/2 items-center px-1 hover:bg-accent disabled:opacity-50" aria-label="Up" disabled={shown >= hi} onClick={() => take(shown + step)}>
          <ChevronUp className="h-3 w-3" />
        </button>
        <button type="button" className="flex h-1/2 items-center px-1 hover:bg-accent disabled:opacity-50" aria-label="Down" disabled={shown <= lo} onClick={() => take(shown - step)}>
          <ChevronDown className="h-3 w-3" />
        </button>
      </span>
    </span>
  );
}

/**
 * VMShinyBar while editing: the memory in use in green up to the static
 * maximum (which only grows while editing), with the two sliders below to drag
 * within their limits, in steps of the increment -- or back to where they began.
 */
function EditBar({ basis, state, units, onChange }: { basis: MemoryEditBasis; state: MemoryEditState; units: Units; onChange: (s: MemoryEditState) => void }) {
  const [ref, width] = useWidth();
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"min" | "max" | null>(null);
  const a = amounts(state);
  const [barMax, setBarMax] = useState(Math.max(basis.vm0.staticMax, a.staticMax));
  if (a.staticMax > barMax) setBarMax(a.staticMax);
  const max = Math.max(barMax, a.staticMax);
  const orig = useRef({ min: basis.vm0.dynamicMin, max: basis.vm0.dynamicMax });

  const used = basis.used;
  const at = (bytes: number) => `${Math.min(100, (Math.max(0, bytes) / max) * 100)}%`;
  const usedText = memorySize(used, false);
  const tip = basis.vms.length > 1 ? `Current memory usage: ${usedText} per VM` : `Current memory usage: ${usedText}`;

  const r = ranges(basis, state);
  // VMShinyBar.SetRanges: rounded inwards to the spinners' units.
  const limits = (kind: "min" | "max"): [number, number] => {
    const lim = kind === "min" ? r.dynMin : { min: a.dynamicMin, max: r.dynMax.max };
    const [lo, hi] = displayRange(lim.min, lim.max, units);
    return [fromDisplay(lo, units), fromDisplay(hi, units)];
  };
  const stepBytes = units === "GB" ? 0.1 * GIB : increment(0, a.staticMax, "MB") * MIB;

  const drag = (kind: "min" | "max", clientX: number) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const pos = ((clientX - rect.left) / rect.width) * max;
    const [lo, hi] = limits(kind);
    const original = kind === "min" ? orig.current.min : orig.current.max;
    let bytes: number;
    if (pos <= lo) bytes = lo;
    else if (pos >= hi) bytes = hi;
    else {
      const rounded = Math.round(Math.trunc((pos + stepBytes / 2) / stepBytes) * stepBytes * 10) / 10;
      bytes = Math.abs(pos - rounded) >= Math.abs(pos - original) ? original : rounded;
      bytes = Math.min(hi, Math.max(lo, bytes));
    }
    const field = kind === "min" ? "dynMin" : "dynMax";
    if (bytes !== state[field]) onChange(change(basis, state, field, bytes, units));
  };

  return (
    <div ref={ref} className="px-2 pt-7 pb-6">
      <div className="relative" ref={barRef}>
        <Grid total={max} width={width} />
        <div className="relative flex h-5 overflow-hidden rounded-[5px] border border-zinc-800 dark:border-zinc-600">
          {used > 0 && <Segment color={VM_USED} width={at(used)} caption={[usedText]} align="right" tip={tip} />}
          {used < max && <Segment color={UNUSED} grow />}
          <Shine />
        </div>
        {/* DrawSliderRanges: while a slider is held, the range it may move in, light grey under the bar. */}
        {dragging && (
          <span
            className="pointer-events-none absolute top-full h-2.5 bg-zinc-300 dark:bg-zinc-600"
            style={{ left: at(limits(dragging)[0]), width: `calc(${at(limits(dragging)[1])} - ${at(limits(dragging)[0])})` }}
          />
        )}
        {/* DrawSliders: with ballooning both are there, at the range the spinners hold. */}
        {basis.hasBallooning &&
          (["min", "max"] as const).map((kind) => {
            const bytes = kind === "min" ? state.dynMin : state.dynMax;
            return (
              <span
                key={kind}
                role="slider"
                aria-label={kind === "min" ? "Minimum memory" : "Maximum memory"}
                aria-valuenow={bytes}
                tabIndex={-1}
                className={`group absolute top-full z-10 cursor-ew-resize touch-none ${kind === "min" ? "-translate-x-full" : ""}`}
                style={{ left: at(bytes) }}
                onPointerDown={(e) => {
                  // The group is disabled when no range may be set.
                  if (dmcUnavailable(basis)) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDragging(kind);
                }}
                onPointerMove={(e) => dragging === kind && drag(kind, e.clientX)}
                onPointerUp={() => setDragging(null)}
                onPointerCancel={() => setDragging(null)}
              >
                <SliderHandle kind={kind} active={dragging === kind} />
              </span>
            );
          })}
      </div>
    </div>
  );
}

function JobView({ job }: { job: VmMemoryJob }) {
  const icon = (state: string) =>
    state === "done" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
    ) : state === "running" ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : state === "failed" ? (
      <XCircle className="h-4 w-4 text-destructive" />
    ) : (
      <Circle className="h-4 w-4 text-muted-foreground" />
    );
  return (
    <div className="space-y-3">
      <p className="font-medium">
        {job.state === "running" ? "Changing memory settings" : job.state === "done" ? "Memory settings changed" : "Changing memory settings failed"}
      </p>
      <ul className="space-y-2">
        {job.vms.map((v) => (
          <li key={v.ref} className="flex items-start gap-2">
            <span className="mt-0.5">{icon(v.state)}</span>
            <span>
              {v.name}
              <span className={`block text-xs ${v.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                {v.state === "failed" ? v.error : v.step}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {job.state === "running" && (
        <p className="text-xs text-muted-foreground">This goes on in XenMan even if you close the window.</p>
      )}
    </div>
  );
}
