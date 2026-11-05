// XenCenter's memory settings ("Edit..." on the Memory tab): the limits of the
// spinners and what is finally set, after xenadmin
// Controls/Ballooning/VMMemoryControlsEdit.cs, VMMemoryControlsBasic.cs,
// VMMemoryControlsAdvanced.cs and MemorySpinner.cs. No server imports: the
// dialog uses it, and the server checks what comes back.

import type { MemoryEditContext, VmMemoryEditVm, VmMemoryRow } from "./xen-memory";

export const MIB = 1024 ** 2;
export const GIB = 1024 ** 3;

export type Units = "MB" | "GB";

/** MemorySpinner.Initialize: MB up to 1 GiB of static maximum, else GB with one decimal. */
export const unitsFor = (staticMax: number): Units => (staticMax <= GIB ? "MB" : "GB");

/** What the spinner shows for an amount (Util.ToGB(…, Nearest, 1) / ToMB(…, Nearest)). */
export function toDisplay(bytes: number, units: Units): number {
  return units === "GB" ? Math.round((bytes / GIB) * 10) / 10 : Math.round(bytes / MIB);
}

/** What a value typed or stepped into the spinner is (ValueMB = GB × 1024). */
export function fromDisplay(value: number, units: Units): number {
  return units === "GB" ? value * 1024 * MIB : value * MIB;
}

/** MemorySpinner.CalcGBRanges / CalcMBRanges: rounded inwards, unrounded if that crosses. */
export function displayRange(min: number, max: number, units: Units): [number, number] {
  const f = units === "GB" ? GIB / 10 : MIB;
  const scale = units === "GB" ? 10 : 1;
  let lo = Math.ceil(min / f - 1e-9) / scale;
  let hi = Math.floor(max / f + 1e-9) / scale;
  if (lo > hi) {
    lo = min / f / scale;
    hi = max / f / scale;
  }
  return [lo, hi];
}

/** MemorySpinner.Increment and VMMemoryControlsEdit.CalcIncrement, in display units. */
export function increment(bytes: number, staticMax: number, units: Units): number {
  if (units === "GB") return bytes < 10 * GIB ? 0.1 : 1;
  let i = 1;
  while (i < staticMax / MIB / 8 && i < 128) i *= 2;
  return i;
}

/** What the controls hold: Basic (fixed, or a range) or Advanced (range and static maximum). */
export interface MemoryEditState {
  advanced: boolean;
  /** Basic only: "Automatically allocate memory within this range". */
  dynamic: boolean;
  fixed: number;
  dynMin: number;
  dynMax: number;
  /** Advanced only. */
  statMax: number;
}

/** Everything the limits depend on: the VMs chosen (the first leads, as vm0) and the pool. */
export interface MemoryEditBasis {
  vm0: { power: string; staticMin: number; staticMax: number; dynamicMin: number; dynamicMax: number };
  vms: VmMemoryEditVm[];
  /** vm0.SupportsBallooning. */
  hasBallooning: boolean;
  /** VMShinyBar.CalcMemoryUsed: what the VMs use on average (the row's). */
  used: number;
  ctx: MemoryEditContext;
}

export function basisOf(row: VmMemoryRow, chosen: VmMemoryEditVm[], ctx: MemoryEditContext): MemoryEditBasis {
  return {
    vm0: { power: chosen[0]?.power ?? row.power, staticMin: row.staticMin, staticMax: row.staticMax, dynamicMin: row.dynamicMin, dynamicMax: row.dynamicMax },
    vms: chosen,
    hasBallooning: row.ballooning,
    used: row.used,
    ctx,
  };
}

/** BallooningDialog / MemorySettings: Advanced when DMC is licensed and vm0 uses ballooning, else Basic. */
export function initialState(row: VmMemoryRow, ctx: MemoryEditContext): MemoryEditState {
  return {
    advanced: !ctx.dmcRestricted && row.usesBallooning,
    // Basic's radio buttons: a range when ballooning is possible and the minimum differs from the static maximum.
    dynamic: row.ballooning && !ctx.dmcRestricted && row.dynamicMin !== row.staticMax,
    fixed: row.staticMax,
    dynMin: row.dynamicMin,
    dynMax: row.dynamicMax,
    statMax: row.staticMax,
  };
}

/** The three amounts the controls stand for (dynamic_min, dynamic_max, static_max). */
export function amounts(s: MemoryEditState): { dynamicMin: number; dynamicMax: number; staticMax: number } {
  if (s.advanced) return { dynamicMin: s.dynMin, dynamicMax: s.dynMax, staticMax: s.statMax };
  return s.dynamic
    ? { dynamicMin: s.dynMin, dynamicMax: s.dynMax, staticMax: s.dynMax }
    : { dynamicMin: s.fixed, dynamicMax: s.fixed, staticMax: s.fixed };
}

/** GetMemoryRatio: the more constraining ratio when HVM and PV VMs are mixed. */
export function memoryRatio(b: MemoryEditBasis): number {
  const hvm = b.vms.some((v) => v.hvm);
  const pv = b.vms.some((v) => !v.hvm);
  if (!pv) return b.ctx.ratioHvm;
  if (!hvm) return b.ctx.ratioPv;
  return Math.max(b.ctx.ratioHvm, b.ctx.ratioPv);
}

/**
 * CalcMaxDynMin: for running (or paused) VMs, what their dynamic minimum may
 * reach on their host -- its memory less overheads, control domain and the other
 * VMs' minimums, shared among those chosen. -1: no constraint.
 */
export function maxDynMin(b: MemoryEditBasis): number {
  if (b.vm0.power !== "Running" && b.vm0.power !== "Paused") return -1;
  if (!b.ctx.hostTotal || !b.vms.length) return -1;
  const others = b.ctx.hostCommitted - b.vms.reduce((n, v) => n + v.dynamicMin, 0);
  return Math.max(0, b.ctx.hostTotal - others) / b.vms.length;
}

/** MemorySpinnerMax: the larger of the static maximum and what the templates allow (the least of the VMs). */
function spinnerMax(b: MemoryEditBasis): number {
  const allowed = b.vms.length ? Math.min(...b.vms.map((v) => v.maxMemAllowed)) : 1024 ** 4;
  return Math.max(b.vm0.staticMax, allowed);
}

export interface SpinnerRange {
  min: number;
  max: number;
}

export interface MemoryRanges {
  fixed: SpinnerRange;
  dynMin: SpinnerRange;
  dynMax: SpinnerRange;
  statMax: SpinnerRange;
}

/** SetSpinnerRanges of Basic and Advanced, in bytes. */
export function ranges(b: MemoryEditBasis, s: MemoryEditState): MemoryRanges {
  const { dynamicMin, dynamicMax, staticMax } = amounts(s);
  const mdm = maxDynMin(b);
  const msm = spinnerMax(b);
  const frac = memoryRatio(b);
  const sMin = b.vm0.staticMin;

  // DynMinSpinnerMax / DynMinSpinnerMin / StatMaxSpinnerMax.
  let maxDM = dynamicMax;
  if (mdm >= 0 && mdm < maxDM) maxDM = Math.max(mdm, sMin);
  if (maxDM < dynamicMin) maxDM = dynamicMin;
  let minDM = Math.max(sMin, Math.trunc(staticMax * frac));
  if (minDM > dynamicMin) minDM = dynamicMin;
  let maxSM = mdm >= 0 && msm * frac > Math.trunc(mdm) ? mdm / frac : msm;
  if (maxSM < staticMax) maxSM = staticMax;

  const maxFixed = mdm >= 0 && mdm <= msm ? mdm : msm;
  return {
    fixed: { min: Math.max(sMin, MIB), max: maxFixed },
    dynMin: { min: minDM, max: maxDM },
    dynMax: s.advanced ? { min: dynamicMin, max: staticMax } : { min: Math.max(dynamicMin, MIB), max: maxSM },
    statMax: { min: Math.max(dynamicMax, MIB), max: maxSM },
  };
}

type Field = "fixed" | "dynMin" | "dynMax" | "statMax";

/** A NumericUpDown's range change: the value it shows is moved inside, if it can be. */
function clampField(s: MemoryEditState, field: Field, r: SpinnerRange, units: Units): MemoryEditState {
  if (r.min > r.max) return s; // MemorySpinner.SetRange ignores a crossed range
  const [lo, hi] = displayRange(r.min, r.max, units);
  const shown = toDisplay(s[field], units);
  if (shown < lo) return { ...s, [field]: fromDisplay(lo, units) };
  if (shown > hi) return { ...s, [field]: fromDisplay(hi, units) };
  return s;
}

/** The ranges set again until nothing moves, as the spinners' events would. */
export function settle(b: MemoryEditBasis, s: MemoryEditState, units: Units): MemoryEditState {
  const fields: Field[] = s.advanced ? ["dynMin", "dynMax", "statMax"] : b.hasBallooning ? ["fixed", "dynMin", "dynMax"] : ["fixed"];
  let cur = s;
  for (let i = 0; i < 8; i++) {
    const r = ranges(b, cur);
    let next = cur;
    for (const f of fields) next = clampField(next, f, r[f], units);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * A spinner changed: Basic's dynamic spinners pick "Automatically allocate",
 * the fixed one "Set a fixed memory"; a new (static) maximum lifts the minimum
 * to the supported ratio (Initialize(min, RoundingBehaviour.Up)).
 */
export function change(b: MemoryEditBasis, s: MemoryEditState, field: Field, bytes: number, units: Units): MemoryEditState {
  let next: MemoryEditState = { ...s, [field]: bytes };
  if (!s.advanced) next.dynamic = field !== "fixed";
  if ((s.advanced && field === "statMax") || (!s.advanced && field === "dynMax")) {
    const min = Math.trunc(amounts(next).staticMax * memoryRatio(b));
    if (next.dynMin < min) next = { ...next, dynMin: Math.ceil(min / MIB) * MIB };
  }
  return settle(b, next, units);
}

export interface MemoryChange {
  dynamicMin: number;
  dynamicMax: number;
  staticMax: number;
  /** Set when a VM that is not halted must be rebooted for it: the question XenCenter asks. */
  confirm: string | null;
}

/** ChangeMemorySettings: what is set, and whether to ask first. */
export function finalChange(b: MemoryEditBasis, s: MemoryEditState): MemoryChange {
  const a = amounts(s);
  const orig = b.vm0.staticMax;
  let staticMax = Math.trunc(a.staticMax);
  // dynamic_min and dynamic_max stay equal to static_max for VMs without ballooning.
  let dynamicMin = b.hasBallooning ? Math.trunc(a.dynamicMin) : staticMax;
  let dynamicMax = b.hasBallooning ? Math.trunc(a.dynamicMax) : staticMax;
  let confirm: string | null = null;
  if (Math.trunc(orig / MIB) === Math.trunc(staticMax / MIB)) {
    // Not a change, only rounding: keep the static maximum as it is.
    if (dynamicMin === staticMax) dynamicMin = orig;
    if (dynamicMax === staticMax) dynamicMax = orig;
    staticMax = orig;
  } else if (b.vms.some((v) => v.power !== "Halted")) {
    const one = b.vms.length === 1;
    if (s.advanced) {
      confirm = one
        ? "Changing the static maximum memory of this VM will cause it to be rebooted."
        : "Changing the static maximum memory of these VMs will cause them to be rebooted.";
    } else if (b.hasBallooning && !b.ctx.dmcRestricted) {
      confirm = one
        ? "Changing the maximum memory of this VM will cause it to be rebooted."
        : "Changing the maximum memory of these VMs will cause them to be rebooted.";
    } else {
      confirm = one
        ? "Changing the memory of this VM while it is running will cause it to be forcibly rebooted. This operation can cause data loss."
        : "Changing the memory of these VMs while they are running will cause them to be forcibly rebooted. This operation can cause data loss.";
    }
  }
  return { dynamicMin, dynamicMax, staticMax, confirm };
}

const VM_TOOLS = "XenServer VM Tools";

/** VMMemoryControlsBasic: why "Automatically allocate memory within this range" is off. */
export function dmcUnavailable(b: MemoryEditBasis): string | null {
  if (b.hasBallooning && !b.ctx.dmcRestricted) return null;
  if (b.ctx.dmcRestricted) return "The Dynamic Memory Control (DMC) is not available due to license restrictions on the server.";
  const v0 = b.vms[0];
  if (!v0) return null;
  if (b.vms.length > 1) {
    if (!b.vms.every((v) => v.tools === v0.tools)) return "A memory range cannot be set for these VMs.";
    if (v0.tools === "io") return "A memory range cannot be set because the operating systems on these VMs do not support it.";
    return v0.windows
      ? "A memory range cannot be set because I/O drivers are not installed on these VMs."
      : `A memory range cannot be set because ${VM_TOOLS} are not installed on these VMs.`;
  }
  if (v0.tools === "io") return "A memory range cannot be set because the operating system on this VM does not support it.";
  return v0.windows
    ? "A memory range cannot be set because I/O drivers are not installed on this VM."
    : `A memory range cannot be set because ${VM_TOOLS} are not installed on this VM.`;
}
