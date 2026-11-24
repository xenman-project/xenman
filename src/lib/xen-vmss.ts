// VM snapshot schedules (XAPI class VMSS), as XenCenter keeps them:
// XenModel/Actions/VMSS (create, assign, destroy, run now, enable),
// XenAPI/VMSS.cs SaveChanges (the order of the setters), XenAPI-Extensions/
// VMSS.cs (next run), Wizards/NewPolicyWizard and Dialogs/ScheduledSnapshots.
// The values XAPI accepts are those of ocaml/xapi/xapi_vmss.ml.

import type { XapiCall } from "./xen-network-actions";

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

export type VmssFrequency = "hourly" | "daily" | "weekly";
export type VmssType = "snapshot" | "checkpoint" | "snapshot_with_quiesce";

/** xapi_vmss.ml: schedule_min_enum, and the days as XenCenter writes them. */
export const VMSS_MINUTES = [0, 15, 30, 45];
export const VMSS_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const JS_DAY: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

const NULL_REF = "OpaqueRef:NULL";
const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith("OpaqueRef:") && v !== NULL_REF;

export interface VmssMessage {
  ts: string | null;
  name: string;
  body: string;
  priority: number;
}

export interface VmssSchedule {
  ref: string;
  uuid: string;
  name: string;
  description: string;
  enabled: boolean;
  type: VmssType;
  retained: number;
  frequency: VmssFrequency;
  min: number;
  hour: number;
  days: string[];
  vms: string[];
  lastRun: string | null;
  /** The next run in the pool coordinator's local time ("2026-11-21 02:00"), and in how many minutes. */
  nextRun: string | null;
  nextRunInMin: number | null;
  /** Its alerts, newest first: what the last runs did. */
  messages: VmssMessage[];
}

export interface VmssOverview {
  licensed: boolean;
  checkpointAllowed: boolean;
  /** The coordinator's local time, as XenServer gives it; null when it could not be read. */
  serverLocalTime: string | null;
  schedules: VmssSchedule[];
  vms: { ref: string; name: string; schedule: string | null; powerState: string }[];
}

/** BoolKeyPreferTrue over every host, as Helpers.FeatureForbidden: restricted unless each licence says "false". */
function restricted(hosts: Recs, key: string): boolean {
  return Object.values(hosts).some((h) => {
    const lp = (h.license_params as Record<string, string>) || {};
    return (lp[key] ?? "").toLowerCase() !== "false";
  });
}

// ─── time ────────────────────────────────────────────────────────────────────

/** A XAPI datetime ("20261121T15:30:00Z", or without the Z for a host's local time) as its parts. */
function parseXapiTime(v: unknown): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):?(\d{2}):?(\d{2})/.exec(String(v ?? ""));
  if (!m || m[1] === "1970") return null;
  // Held as UTC, the wall clock unchanged: only differences and the fields are used.
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

const pad = (n: number) => String(n).padStart(2, "0");
const wallClock = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

/** VMSS.GetNextRunTime: the next run after `now`, both in the pool's wall clock. */
export function nextRun(frequency: VmssFrequency, min: number, hour: number, days: string[], now: Date): Date | null {
  const at = (d: Date, h: number) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0));
  if (frequency === "hourly") {
    const next = at(now, now.getUTCHours());
    return next < now ? new Date(next.getTime() + 3600_000) : next;
  }
  if (frequency === "daily") {
    const next = at(now, hour);
    return next < now ? new Date(next.getTime() + 86_400_000) : next;
  }
  const base = at(now, hour);
  const runs = days
    .map((d) => JS_DAY[d])
    .filter((d) => d !== undefined)
    .map((d) => {
      let diff = (d - base.getUTCDay() + 7) % 7;
      if (diff === 0 && base < now) diff = 7;
      return new Date(base.getTime() + diff * 86_400_000);
    })
    .sort((a, b) => a.getTime() - b.getTime());
  return runs[0] ?? null;
}

// ─── reading ─────────────────────────────────────────────────────────────────

function scheduleOf(rec: Rec): VmssSchedule {
  const s = (rec.schedule as Record<string, string>) || {};
  const frequency = (["hourly", "daily", "weekly"].includes(String(rec.frequency)) ? rec.frequency : "daily") as VmssFrequency;
  const days = String(s.days ?? "")
    .split(/[,\s]+/)
    .map((d) => d.toLowerCase())
    .filter((d) => VMSS_DAYS.includes(d));
  return {
    ref: "",
    uuid: String(rec.uuid ?? ""),
    name: String(rec.name_label ?? ""),
    description: String(rec.name_description ?? ""),
    enabled: Boolean(rec.enabled),
    type: (String(rec.type ?? "snapshot") as VmssType),
    retained: Number(rec.retained_snapshots) || 0,
    frequency,
    min: Number(s.min) || 0,
    hour: Number(s.hour) || 0,
    days,
    vms: ((rec.VMs as string[]) || []).filter(isRef),
    lastRun: (() => {
      const d = parseXapiTime(rec.last_run_time);
      return d ? wallClock(d) : null;
    })(),
    nextRun: null,
    nextRunInMin: null,
    messages: [],
  };
}

/** Everything the Snapshot Schedules tab shows. */
export async function vmssOverview(call: XapiCall): Promise<VmssOverview> {
  const [vmss, vms, hosts, pools, messages] = await Promise.all([
    call<Recs>("VMSS.get_all_records", []).catch(() => ({}) as Recs),
    call<Recs>("VM.get_all_records", []),
    call<Recs>("host.get_all_records", []),
    call<Recs>("pool.get_all_records", []),
    call<Recs>("message.get_all_records", []).catch(() => ({}) as Recs),
  ]);
  const coordinator = String(Object.values(pools)[0]?.master ?? "");
  const local = isRef(coordinator)
    ? parseXapiTime(await call<string>("host.get_server_localtime", [coordinator]).catch(() => ""))
    : null;

  // XenCenter's ScheduledSnapshotsDialog: the VMSS alerts by the schedule's uuid, newest first.
  const byUuid = new Map<string, VmssMessage[]>();
  for (const m of Object.values(messages)) {
    if (String(m.cls) !== "VMSS") continue;
    const list = byUuid.get(String(m.obj_uuid)) ?? [];
    const ts = parseXapiTime(m.timestamp);
    list.push({ ts: ts ? ts.toISOString() : null, name: String(m.name ?? ""), body: String(m.body ?? ""), priority: Number(m.priority) || 0 });
    byUuid.set(String(m.obj_uuid), list);
  }

  const schedules = Object.entries(vmss).map(([ref, rec]) => {
    const s = { ...scheduleOf(rec), ref };
    s.messages = (byUuid.get(s.uuid) ?? []).sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? "")).slice(0, 10);
    if (local) {
      const next = nextRun(s.frequency, s.min, s.hour, s.days, local);
      if (next) {
        s.nextRun = wallClock(next);
        s.nextRunInMin = Math.round((next.getTime() - local.getTime()) / 60_000);
      }
    }
    return s;
  });
  schedules.sort((a, b) => a.name.localeCompare(b.name));

  return {
    licensed: !restricted(hosts, "restrict_vmss"),
    checkpointAllowed: !restricted(hosts, "restrict_checkpoint"),
    serverLocalTime: local ? wallClock(local) : null,
    schedules,
    vms: Object.entries(vms)
      .filter(([, v]) => !v.is_a_template && !v.is_a_snapshot && !v.is_control_domain)
      .map(([ref, v]) => ({
        ref,
        name: String(v.name_label ?? ""),
        schedule: isRef(v.snapshot_schedule) ? v.snapshot_schedule : null,
        powerState: String(v.power_state ?? ""),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ─── checking what is asked ──────────────────────────────────────────────────

export interface VmssInput {
  name: string;
  description: string;
  enabled: boolean;
  type: VmssType;
  retained: number;
  frequency: VmssFrequency;
  min: number;
  hour: number;
  days: string[];
  vms: string[];
  runNow: boolean;
}

export class VmssRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A request's schedule, checked as xapi_vmss.ml would, and more strictly where XenMan can tell. */
export function parseVmssInput(v: unknown): VmssInput {
  const b = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 255) throw new VmssRefused("Enter a name for the schedule.");
  const description = typeof b.description === "string" ? b.description.slice(0, 1024) : "";
  if (!["snapshot", "checkpoint", "snapshot_with_quiesce"].includes(String(b.type))) throw new VmssRefused("Invalid snapshot type.");
  if (!["hourly", "daily", "weekly"].includes(String(b.frequency))) throw new VmssRefused("Invalid frequency.");
  const frequency = b.frequency as VmssFrequency;
  const retained = Number(b.retained);
  if (!Number.isInteger(retained) || retained < 1 || retained > 10) throw new VmssRefused("Keep between 1 and 10 snapshots.");
  const min = Number(b.min);
  if (!VMSS_MINUTES.includes(min)) throw new VmssRefused("Snapshots can be taken on the hour or at 15, 30 or 45 minutes past.");
  const hour = Number(b.hour ?? 0);
  if (frequency !== "hourly" && (!Number.isInteger(hour) || hour < 0 || hour > 23)) throw new VmssRefused("Invalid hour.");
  const days = Array.isArray(b.days) ? [...new Set(b.days.map((d) => String(d).toLowerCase()))] : [];
  if (days.some((d) => !VMSS_DAYS.includes(d))) throw new VmssRefused("Invalid day of the week.");
  if (frequency === "weekly" && days.length === 0) throw new VmssRefused("Select at least one day of the week.");
  const vms = Array.isArray(b.vms) ? [...new Set(b.vms.filter(isRef))] : [];
  if (vms.length > 1000) throw new VmssRefused("Too many VMs.");
  return {
    name,
    description,
    enabled: b.enabled !== false,
    type: b.type as VmssType,
    retained,
    frequency,
    min,
    hour: frequency === "hourly" ? 0 : hour,
    days: frequency === "weekly" ? VMSS_DAYS.filter((d) => days.includes(d)) : [],
    vms,
    runNow: b.runNow === true,
  };
}

/** The schedule map for a frequency (xapi_vmss.ml schedule_frequency_*_keys), as XenCenter writes it. */
function scheduleMap(i: Pick<VmssInput, "frequency" | "min" | "hour" | "days">): Record<string, string> {
  if (i.frequency === "hourly") return { min: String(i.min) };
  if (i.frequency === "daily") return { hour: String(i.hour), min: String(i.min) };
  return { hour: String(i.hour), min: String(i.min), days: i.days.join(",") };
}

const sameMap = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** What XenServer's licence allows, and that the VMs are VMs of this pool. */
async function assertAllowed(call: XapiCall, input: VmssInput | null, previousType?: VmssType): Promise<void> {
  const hosts = await call<Recs>("host.get_all_records", []);
  if (restricted(hosts, "restrict_vmss")) {
    throw new VmssRefused("The pool's XenServer license does not include snapshot schedules.", 409);
  }
  if (!input) return;
  if (input.type === "checkpoint" && previousType !== "checkpoint" && restricted(hosts, "restrict_checkpoint")) {
    throw new VmssRefused("The pool's XenServer license does not include disk and memory snapshots.", 409);
  }
  // Quiesced snapshots no longer exist on current XenServer (XenCenter hides them): only kept, never chosen.
  if (input.type === "snapshot_with_quiesce" && previousType !== "snapshot_with_quiesce") {
    throw new VmssRefused("Quiesced snapshots are no longer available.");
  }
  if (input.vms.length) {
    const vms = await call<Recs>("VM.get_all_records", []);
    const bad = input.vms.find((r) => !vms[r] || vms[r].is_a_template || vms[r].is_a_snapshot || vms[r].is_control_domain);
    if (bad) throw new VmssRefused("Only VMs of this pool can be scheduled.");
  }
}

// ─── changing ────────────────────────────────────────────────────────────────

/** AssignVMsToPolicyAction: those no longer chosen out, the chosen ones in (from another schedule too). */
async function assignVms(call: XapiCall, ref: string, wanted: string[], current: string[]): Promise<void> {
  for (const vm of current.filter((r) => !wanted.includes(r))) await call("VM.set_snapshot_schedule", [vm, NULL_REF]);
  if (!wanted.length) return;
  const vms = await call<Recs>("VM.get_all_records", []);
  for (const vm of wanted) {
    if (vms[vm]?.snapshot_schedule !== ref) await call("VM.set_snapshot_schedule", [vm, ref]);
  }
}

/**
 * A new schedule (CreateVMPolicy) or a changed one (VMSS.SaveChanges: only
 * what changed, the frequency before the schedule). Returns its ref and, when
 * a first run was asked for, the snapshots being taken (see snapshotNow).
 */
export async function saveVmss(call: XapiCall, ref: string | null, input: VmssInput): Promise<{ ref: string; snapshot: Promise<unknown> | null }> {
  let current: Rec | null = null;
  if (ref) {
    current = await call<Rec>("VMSS.get_record", [ref]);
  }
  await assertAllowed(call, input, current ? (String(current.type) as VmssType) : undefined);
  const schedule = scheduleMap(input);

  if (!ref || !current) {
    ref = await call<string>("VMSS.create", [
      {
        name_label: input.name,
        name_description: input.description,
        enabled: input.enabled,
        type: input.type,
        retained_snapshots: String(input.retained),
        frequency: input.frequency,
        schedule,
      },
    ]);
    await assignVms(call, ref, input.vms, []);
  } else {
    if (current.name_label !== input.name) await call("VMSS.set_name_label", [ref, input.name]);
    if (current.name_description !== input.description) await call("VMSS.set_name_description", [ref, input.description]);
    if (Boolean(current.enabled) !== input.enabled) await call("VMSS.set_enabled", [ref, input.enabled]);
    if (current.type !== input.type) await call("VMSS.set_type", [ref, input.type]);
    if (Number(current.retained_snapshots) !== input.retained) await call("VMSS.set_retained_snapshots", [ref, String(input.retained)]);
    if (current.frequency !== input.frequency) await call("VMSS.set_frequency", [ref, input.frequency]);
    // After a new frequency XenServer may have filled in its own values: compare with what it holds now.
    const held = current.frequency !== input.frequency
      ? ((await call<Rec>("VMSS.get_record", [ref])).schedule as Record<string, string>) || {}
      : (current.schedule as Record<string, string>) || {};
    if (!sameMap(held, schedule)) await call("VMSS.set_schedule", [ref, schedule]);
    await assignVms(call, ref, input.vms, ((current.VMs as string[]) || []).filter(isRef));
  }
  return { ref, snapshot: input.runNow ? snapshotNow(call, ref) : null };
}

/** DestroyPolicyAction: its VMs out of it first, then the schedule. */
export async function deleteVmss(call: XapiCall, ref: string): Promise<{ name: string; vms: number }> {
  await assertAllowed(call, null);
  const rec = await call<Rec>("VMSS.get_record", [ref]);
  const vms = ((rec.VMs as string[]) || []).filter(isRef);
  for (const vm of vms) await call("VM.set_snapshot_schedule", [vm, NULL_REF]);
  await call("VMSS.destroy", [ref]);
  return { name: String(rec.name_label ?? ""), vms: vms.length };
}

export async function setVmssEnabled(call: XapiCall, ref: string, enabled: boolean): Promise<string> {
  await assertAllowed(call, null);
  const rec = await call<Rec>("VMSS.get_record", [ref]);
  if (Boolean(rec.enabled) !== enabled) await call("VMSS.set_enabled", [ref, enabled]);
  return String(rec.name_label ?? "");
}

/**
 * VMSS.snapshot_now, which XenServer has only as a synchronous call (no
 * Async.VMSS.snapshot_now: the datamodel gives it the Session flag alone). It
 * returns once the snapshots of all the schedule's VMs are taken, so it is not
 * awaited here: the caller follows the promise (lib/task-registry.ts,
 * startBackground) and the request returns at once, as XenCenter's
 * RunPolicyNowAction runs it in the background.
 */
function snapshotNow(call: XapiCall, ref: string): Promise<unknown> {
  return call("VMSS.snapshot_now", [ref]);
}

/** RunPolicyNowAction: the snapshots of all its VMs, taken in the background. */
export async function runVmssNow(call: XapiCall, ref: string): Promise<{ name: string; snapshot: Promise<unknown> }> {
  await assertAllowed(call, null);
  const rec = await call<Rec>("VMSS.get_record", [ref]);
  if (!((rec.VMs as string[]) || []).some(isRef)) throw new VmssRefused("The schedule has no VMs.", 409);
  return { name: String(rec.name_label ?? ""), snapshot: snapshotNow(call, ref) };
}

/** One VM into a schedule, or out of any (vmss null). */
export async function setVmSchedule(call: XapiCall, vmRef: string, vmss: string | null): Promise<string | null> {
  await assertAllowed(call, null);
  const vm = await call<Rec>("VM.get_record", [vmRef]);
  if (vm.is_a_template || vm.is_a_snapshot || vm.is_control_domain) throw new VmssRefused("Only VMs can be scheduled.");
  const name = vmss ? String((await call<Rec>("VMSS.get_record", [vmss])).name_label ?? "") : null;
  await call("VM.set_snapshot_schedule", [vmRef, vmss ?? NULL_REF]);
  return name;
}
