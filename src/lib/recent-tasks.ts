// The Recent Tasks list of a pool: XenMan's own actions and jobs, with who
// started them, and the XenServer tasks of other clients (XenCenter, xe), as
// XenCenter shows them (XenAdmin/Actions/GUIActions/MeddlingAction.cs: only
// operations it recognises, no subtasks, the object from other_config
// "applies_to", else the VM running the task, else the host it runs on).

import type { XapiCall } from "./xen-network-actions";
import {
  KEEP_MS,
  MAX_ENTRIES,
  isXenmanTask,
  linkedTaskRefs,
  settleAction,
  trackedActions,
  updateSeenTasks,
  type SeenTask,
  type TaskObject,
  type TaskState,
  type TrackedAction,
} from "./task-registry";
import { getMaintenanceJob } from "./host-maintenance-job";
import { getVmMemoryJob } from "./vm-memory-job";
import { getMemberJob } from "./pool-membership-job";
import { getDom0MemoryJob } from "./dom0-memory-job";
import { getMgmtJob } from "./network-mgmt-job";
import { listJobs } from "./xen-update-jobs";
import { syncState, xapiDate } from "./xen-updates";

export interface TaskLine {
  /** ISO time, when known. */
  at?: string;
  text: string;
}

export interface RecentTask {
  id: string;
  source: "xenman" | "update" | "xapi";
  startedAt: string;
  finishedAt?: string;
  object: TaskObject;
  /** Hosts it concerns: for the list of one host (a VM's own host is added by the browser). */
  hostRefs: string[];
  operation: string;
  state: TaskState;
  /** 0-100, where known. */
  progress?: number;
  lines: TaskLine[];
  error?: string;
  /** The XenMan user; "XenCenter" for XenCenter's tasks; none for another client. */
  by?: string;
  cancel?: { kind: "task"; ref: string; adminOnly: boolean } | { kind: "update-job"; id: string };
}

type Rec = Record<string, unknown>;

const NULL_REF = "OpaqueRef:NULL";
const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith("OpaqueRef:") && v !== NULL_REF;
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const isoOf = (v: string | number | undefined) =>
  v === undefined ? undefined : typeof v === "number" ? new Date(v).toISOString() : v;

// ─── XenServer tasks ─────────────────────────────────────────────────────────

/** XenCenter's recognised VM operations (MeddlingAction.RecognisedVmOperations), and their names here. */
const VM_OPERATIONS: Record<string, string> = {
  clean_reboot: "Reboot",
  clean_shutdown: "Shut down",
  clone: "Copy",
  copy: "Copy",
  hard_reboot: "Force reboot",
  hard_shutdown: "Force shut down",
  migrate_send: "Migrate",
  pool_migrate: "Migrate",
  resume: "Resume",
  resume_on: "Resume",
  start: "Start",
  start_on: "Start",
  suspend: "Suspend",
  checkpoint: "Checkpoint",
  snapshot: "Take snapshot",
};
/** Beyond XenCenter's list: what another client does to a whole host or the pool. */
const HOST_OPERATIONS: Record<string, string> = {
  "host.evacuate": "Evacuate",
  "host.apply_updates": "Install updates",
  "pool.sync_updates": "Synchronize with update channel",
};

/** An operation this list shows, from a task's name_label; null: not one. */
function operationOf(name: string): { label: string; vm: boolean } | null {
  if (name === "VM import") return { label: "Import", vm: true };
  if (name.startsWith("Export of VM: ")) return { label: "Export", vm: true };
  const n = name.replace(/^Async\./, "");
  if (n.startsWith("VM.")) {
    const op = VM_OPERATIONS[n.slice(3)];
    return op ? { label: op, vm: true } : null;
  }
  const op = HOST_OPERATIONS[n];
  return op ? { label: op, vm: false } : null;
}

/** Cancelling a VM's task is for operators too; everything else for administrators. */
export function cancelIsAdminOnly(name: string): boolean {
  return !(operationOf(name)?.vm ?? false);
}

function stateOf(rec: Rec): TaskState {
  switch (String(rec.status)) {
    case "success":
      return "done";
    case "failure":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

const progressOf = (rec: Rec) => {
  const p = Number(rec.progress);
  return Number.isFinite(p) && p >= 0 ? Math.round(Math.min(p, 1) * 100) : undefined;
};

const errorOf = (rec: Rec) => {
  const e = Array.isArray(rec.error_info) ? rec.error_info.map(String).filter(Boolean) : [];
  return e.length ? e.join(" ") : undefined;
};

const mayCancel = (rec: Rec) =>
  stateOf(rec) === "running" && Array.isArray(rec.allowed_operations) && rec.allowed_operations.map(String).includes("cancel");

// ─── XenMan's jobs ───────────────────────────────────────────────────────────

interface JobView {
  state: TaskState;
  progress?: number;
  lines: TaskLine[];
  error?: string;
  finishedAt?: string;
}

const stepLines = (steps: { label: string; state: string; detail?: string }[]): TaskLine[] =>
  steps
    .filter((s) => s.state !== "pending" && s.state !== "todo")
    .map((s) => ({ text: `${s.label}${s.detail ? ` (${s.detail})` : ""}${s.state === "failed" ? ": failed" : ""}` }));

const jobState = (s: string): TaskState => (s === "running" ? "running" : s === "done" ? "done" : "failed");

/** The export jobs live in the API route; read where it keeps them. */
interface ExportJob {
  status: "running" | "success" | "failure";
  error?: string;
  targetPath?: string;
  finishedAt?: number;
}
const exportJobs = () =>
  (globalThis as typeof globalThis & { _sshExportJobs?: Map<string, ExportJob> })._sshExportJobs ?? new Map<string, ExportJob>();

function jobView(link: { job: string; id: string }): JobView | null {
  switch (link.job) {
    case "maintenance": {
      const j = getMaintenanceJob(link.id);
      if (!j) return null;
      return {
        state: jobState(j.state),
        progress: Math.round((j.progress ?? 0) * 100),
        lines: j.step ? [{ text: j.step }] : [],
        error: j.error,
      };
    }
    case "vm-memory": {
      const j = getVmMemoryJob(link.id);
      if (!j) return null;
      return {
        state: jobState(j.state),
        lines: j.vms.map((v) => ({ text: `${v.name}: ${v.error ?? v.step}` })),
        finishedAt: j.finishedAt,
      };
    }
    case "pool-member": {
      const j = getMemberJob(link.id);
      if (!j) return null;
      return { state: jobState(j.state), lines: stepLines(j.steps), error: j.error, finishedAt: j.finishedAt };
    }
    case "dom0": {
      const j = getDom0MemoryJob(link.id);
      if (!j) return null;
      return { state: jobState(j.state), lines: j.step ? [{ text: j.step }] : [], error: j.error, finishedAt: j.finishedAt };
    }
    case "network": {
      const j = getMgmtJob(link.id);
      if (!j) return null;
      return { state: jobState(j.state), lines: stepLines(j.steps), error: j.error, finishedAt: j.finishedAt };
    }
    case "export": {
      const j = exportJobs().get(link.id);
      if (!j) return null;
      return {
        state: j.status === "running" ? "running" : j.status === "success" ? "done" : "failed",
        lines: j.targetPath ? [{ text: `To ${j.targetPath}` }] : [],
        error: j.error,
        finishedAt: iso(j.finishedAt),
      };
    }
  }
  return null;
}

// ─── the list ────────────────────────────────────────────────────────────────

function fromTracked(t: TrackedAction, tasks: Record<string, Rec>): RecentTask {
  const out: RecentTask = {
    id: t.id,
    source: "xenman",
    startedAt: new Date(t.startedAt).toISOString(),
    object: t.object,
    hostRefs: t.hostRefs,
    operation: t.operation,
    state: t.state,
    lines: [],
    by: t.actor,
  };
  if (t.link?.kind === "task" && t.state === "running") {
    const rec = tasks[t.link.ref];
    if (!rec) {
      // XenServer no longer lists it: its client read the result and destroyed it.
      settleAction(t, "ended");
    } else {
      out.state = stateOf(rec);
      out.progress = progressOf(rec);
      if (out.state !== "running") settleAction(t, out.state, errorOf(rec));
      else if (mayCancel(rec)) out.cancel = { kind: "task", ref: t.link.ref, adminOnly: cancelIsAdminOnly(String(rec.name_label ?? "")) };
    }
  } else if (t.link?.kind === "job") {
    const v = jobView(t.link);
    if (v) {
      out.lines = v.lines;
      out.progress = v.progress;
      if (t.state === "running" && v.state !== "running") {
        settleAction(t, v.state, v.error);
        if (v.finishedAt) t.finishedAt = Date.parse(v.finishedAt);
      }
      out.state = v.state;
      out.error = v.error;
    } else if (t.state === "running") {
      // The job is no longer kept (a maintenance job is forgotten an hour after it ends).
      settleAction(t, "ended");
    }
  }
  if (t.state !== "running") out.state = t.state;
  out.finishedAt = iso(t.finishedAt);
  out.error ??= t.error;
  return out;
}

/** Update jobs and the update channel's synchronization, from where XenMan keeps them. */
function updateEntries(poolId: string): RecentTask[] {
  const now = Date.now();
  const out: RecentTask[] = [];
  for (const j of listJobs(poolId)) {
    const ended = j.finishedAt ? Date.parse(j.finishedAt) : undefined;
    if (j.state !== "running" && now - (ended ?? Date.parse(j.createdAt)) >= KEEP_MS) continue;
    const hostSteps = j.steps.filter((s) => s.host);
    const first = hostSteps[0];
    const total = j.steps.length || 1;
    const done = j.steps.filter((s) => s.state === "done" || s.state === "skipped" || s.state === "failed").length;
    const lines = j.steps
      .filter((s) => s.startedAt)
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
      .map((s) => ({
        at: s.startedAt,
        text: `${s.hostName ? `${s.hostName}: ` : ""}${s.label}${s.detail ? ` (${s.detail})` : ""}${s.state === "failed" ? ": failed" : ""}`,
      }))
      .slice(-20);
    out.push({
      id: `update:${j.id}`,
      source: "update",
      startedAt: j.createdAt,
      finishedAt: j.finishedAt,
      object: j.scope === "pool" || !first ? { class: "pool", name: j.poolName } : { class: "host", ref: first.host!, name: first.hostName ?? undefined },
      hostRefs: [...new Set(hostSteps.map((s) => s.host!))],
      operation: "Install updates",
      state: j.state === "running" ? "running" : j.state === "done" ? "done" : j.state === "stopped" ? "cancelled" : "failed",
      progress: j.state === "running" ? Math.round((done / total) * 100) : undefined,
      lines,
      error: j.error ?? (j.state === "interrupted" ? "Interrupted by a restart of XenMan" : undefined),
      by: j.by,
      cancel: j.state === "running" && !j.stopRequested ? { kind: "update-job", id: j.id } : undefined,
    });
  }
  const s = syncState(poolId);
  if (s && (s.state === "running" || now - Date.parse(s.finishedAt ?? s.startedAt) < KEEP_MS)) {
    out.push({
      id: `sync:${s.startedAt}`,
      source: "update",
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      object: { class: "pool" },
      hostRefs: [],
      operation: "Synchronize with update channel",
      state: s.state === "running" ? "running" : s.state === "done" ? "done" : "failed",
      lines: [],
      error: s.error,
      by: s.by,
    });
  }
  return out;
}

/** The tasks of other clients, with their objects as XenCenter finds them. */
async function foreignEntries(poolId: string, tasks: Record<string, Rec>, call: XapiCall): Promise<SeenTask[]> {
  const linked = linkedTaskRefs(poolId);
  const now = Date.now();
  const candidates = Object.entries(tasks).filter(([ref, rec]) => {
    if (linked.has(ref) || isXenmanTask(ref)) return false;
    if (isRef(rec.subtask_of)) return false;
    return operationOf(String(rec.name_label ?? "")) !== null;
  });
  // Which refs are VMs, and which VM runs which task: only read when another client is at work.
  let vms: Record<string, Rec> = {};
  if (candidates.some(([, rec]) => operationOf(String(rec.name_label ?? ""))?.vm)) {
    vms = await call<Record<string, Rec>>("VM.get_all_records", []).catch(() => ({}));
  }
  return candidates.map(([ref, rec]): SeenTask => {
    const op = operationOf(String(rec.name_label ?? ""))!;
    const oc = (rec.other_config as Record<string, string>) || {};
    const appliesTo = typeof oc.applies_to === "string" ? oc.applies_to.split(",").filter(isRef) : [];
    const residentOn = isRef(rec.resident_on) ? rec.resident_on : undefined;
    let object: TaskObject;
    let vmHost: string | undefined;
    if (op.vm) {
      const vmRef =
        appliesTo.find((r) => vms[r]) ??
        Object.keys(vms).find((r) => Object.keys((vms[r].current_operations as Rec) || {}).includes(ref));
      object = vmRef ? { class: "VM", ref: vmRef, name: String(vms[vmRef].name_label ?? "") } : { class: "VM" };
      if (vmRef && isRef(vms[vmRef].resident_on)) vmHost = vms[vmRef].resident_on as string;
    } else {
      const hostRef = appliesTo[0] ?? residentOn;
      object = hostRef ? { class: "host", ref: hostRef } : { class: "pool" };
    }
    const started = xapiDate(rec.created);
    const finished = xapiDate(rec.finished);
    return {
      ref,
      poolId,
      startedAt: started ? Date.parse(started) : now,
      finishedAt: finished ? Date.parse(finished) : undefined,
      lastSeen: now,
      state: stateOf(rec),
      progress: progressOf(rec),
      operation: op.label,
      object,
      hostRefs: [...new Set([residentOn, vmHost, ...appliesTo.filter((r) => !vms[r])].filter((r): r is string => !!r))],
      by: oc.XenCenterUUID ? "XenCenter" : undefined,
      error: errorOf(rec),
      cancellable: mayCancel(rec),
      adminOnly: !op.vm,
    };
  });
}

/** Everything the Recent Tasks list of a pool shows, newest first. */
export async function recentTasks(poolId: string, call: XapiCall): Promise<RecentTask[]> {
  const tasks = await call<Record<string, Rec>>("task.get_all_records", []).catch(() => ({}) as Record<string, Rec>);
  const mine = trackedActions(poolId).map((t) => fromTracked(t, tasks));
  const seen = updateSeenTasks(poolId, await foreignEntries(poolId, tasks, call));
  const others: RecentTask[] = seen.map((t) => ({
    id: `xapi:${t.ref}`,
    source: "xapi",
    startedAt: isoOf(t.startedAt)!,
    finishedAt: isoOf(t.finishedAt),
    object: t.object,
    hostRefs: t.hostRefs,
    operation: t.operation,
    state: t.state,
    progress: t.state === "running" ? t.progress : undefined,
    lines: [],
    error: t.error,
    by: t.by,
    cancel: t.state === "running" && t.cancellable ? { kind: "task", ref: t.ref, adminOnly: t.adminOnly } : undefined,
  }));
  return [...mine, ...updateEntries(poolId), ...others]
    .sort((a, b) => (a.state === "running") !== (b.state === "running") ? (a.state === "running" ? -1 : 1) : b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_ENTRIES);
}
