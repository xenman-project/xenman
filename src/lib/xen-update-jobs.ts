// Installing XenServer updates on a pool or a host, as XenCenter does it:
// host by host, the coordinator first, and per host
//
//   maintenance mode -> move VMs away (when it will restart) -> install ->
//   restart the toolstack / the host (when the update asks and the admin let
//   XenMan do it) -> leave maintenance mode -> move the VMs back
//
// A job runs inside the XenMan process with its own XAPI session, so closing
// the browser does not stop it. Its progress is written to DATA_DIR after
// every step; a job found "running" after XenMan restarted was cut short and
// is marked so, with the step it reached -- nothing tries to carry on blindly.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { writeFileAtomic } from "./atomic-write";
import { mailJobEnded } from "./xen-update-mail";
import { formatTime } from "./date-format";
import { serverDateFormat } from "./display-settings";
import { XenApiError } from "./xen-client";
import { CertMismatchError } from "./host-trust";
import {
  anyDate,
  awaitTask,
  call,
  closePoolSession,
  friendlyXapiError,
  openPoolSession,
  readPoolUpdates,
  StopRequested,
  TaskTimeout,
  type HostUpdateState,
  type PoolSession,
  type PoolUpdates,
} from "./xen-updates";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const JOB_DIR = path.join(DATA_DIR, "xen-update-jobs");
const KEEP = 20;

// Waits, generous on purpose: a host with a lot of memory takes its time.
const EVACUATE_MS = Number(process.env.XENMAN_XU_EVACUATE_MS) || 60 * 60 * 1000;
const APPLY_MS = 60 * 60 * 1000;
const MIGRATE_MS = Number(process.env.XENMAN_XU_MIGRATE_MS) || 30 * 60 * 1000;
// A clean shutdown gets this long, then the VM is switched off (the admin's
// choice: an update should not hang on a VM stuck in its own update).
const SHUTDOWN_MS = Number(process.env.XENMAN_XU_SHUTDOWN_MS) || 10 * 60 * 1000;
const HARD_SHUTDOWN_MS = 5 * 60 * 1000;
const START_MS = 10 * 60 * 1000;
// Moving VMs fails now and then for reasons that pass -- a migration that
// times out, memory not yet freed by the previous one. XenCenter then asks
// for "Retry"; this tries again by itself, waiting longer each time.
const RETRY_DELAYS_MS = (process.env.XENMAN_XU_RETRY_DELAYS_MS || "30000,60000,120000").split(",").map(Number);

/** "Another operation is running on the pool": what a lock the coordinator's toolstack keeps looks like. */
function poolBusy(err: unknown): boolean {
  const m = err instanceof Error ? err.message : "";
  return /OTHER_OPERATION_IN_PROGRESS|Another operation is running on the pool/.test(m);
}

/** Errors worth another attempt for steps that otherwise should not be repeated. */
function transient(err: unknown): boolean {
  if (err instanceof TaskTimeout) return true;
  const m = err instanceof Error ? err.message : "";
  return /OTHER_OPERATION_IN_PROGRESS|TOO_BUSY|fetch .*failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(m);
}
/**
 * Reasons a VM cannot be moved that no waiting changes: a passed-through PCI
 * device or GPU, a vGPU type the other host lacks, storage or a network only
 * this host has. Moving such a VM is not tried again.
 */
const PERMANENT_MOVE_ERRORS = new Set([
  "VM_HAS_PCI_ATTACHED",
  "VM_HAS_SRIOV_VIF",
  "VM_REQUIRES_SR",
  "VM_REQUIRES_NETWORK",
  "VM_REQUIRES_GPU",
  "VM_REQUIRES_VGPU",
  "VGPU_TYPE_NOT_SUPPORTED",
  "VGPU_TYPE_NOT_COMPATIBLE",
  "VGPU_DESTINATION_INCOMPATIBLE",
  "VGPU_GUEST_DRIVER_LIMIT",
  "VM_LACKS_FEATURE",
  "VM_IS_TEMPLATE",
  "VM_BAD_POWER_STATE",
  "OPERATION_NOT_ALLOWED",
  "LICENCE_RESTRICTION",
  "LICENSE_RESTRICTION",
]);

/** For moving VMs: anything is worth another try except what will not pass. */
function movable(err: unknown): boolean {
  const code = err instanceof Error ? err.message : "";
  // A vGPU that failed to move once is left in a state that does not move
  // the next time either (seen in the field: VM_HAS_PCI_ATTACHED afterwards).
  const detail = err instanceof XenApiError ? (err.data ?? []).map(String).join(" ") : "";
  if (/emu-manager|vgpu/i.test(detail)) return false;
  return !PERMANENT_MOVE_ERRORS.has(code) && !code.startsWith("VM_LACKS_FEATURE");
}

/**
 * XenServer's evacuation plans every VM at once and fails as a whole when it
 * finds no room for one -- HOST_NOT_ENOUGH_FREE_MEMORY naming that VM -- even
 * with memory free on the hosts. Not worth asking again: the VMs are moved
 * one by one instead (moveOneByOne).
 */
function noRoom(err: unknown): boolean {
  return err instanceof XenApiError && err.message === "HOST_NOT_ENOUGH_FREE_MEMORY";
}

const GiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GiB`;

/** How long GPUs may take to report their migration data again after a toolstack start. */
const GPU_WAIT_MS = Number(process.env.XENMAN_XU_GPU_WAIT_MS) || 3 * 60 * 1000;

/** Pause before VMs move back, for a freshly restarted toolstack to settle. */
const SETTLE_MS = process.env.XENMAN_XU_SETTLE_MS !== undefined ? Number(process.env.XENMAN_XU_SETTLE_MS) : 60_000;
const DOWN_MS = Number(process.env.XENMAN_XU_DOWN_MS) || 10 * 60 * 1000;
const UP_MS = Number(process.env.XENMAN_XU_UP_MS) || 30 * 60 * 1000;
const POLL_MS = Number(process.env.XENMAN_XU_POLL_MS) || 10_000;
/** VMs busy -- starting, migrating -- when their host is to be emptied: waited for this long. */
const BUSY_WAIT_MS = Number(process.env.XENMAN_XU_BUSY_WAIT_MS) || 30 * 60 * 1000;
const BUSY_POLL_MS = Number(process.env.XENMAN_XU_BUSY_POLL_MS) || 30_000;
/** A host's step that failed is tried again after these pauses, before the host is skipped. */
/**
 * VMs moved back at once, as XenServer's own evacuation moves several at a
 * time. VMs with a vGPU still go one by one: theirs is the heavy, fragile part.
 */
const MOVE_BACK_PARALLEL = Math.max(1, Number(process.env.XENMAN_XU_MOVE_BACK_PARALLEL) || 4);
const HOST_RETRY_DELAYS_MS = (process.env.XENMAN_XU_HOST_RETRY_MS || "120000,300000").split(",").map(Number);

export type StepState = "todo" | "running" | "done" | "failed" | "skipped";

export interface JobStep {
  id: string;
  host: string | null;
  hostName: string | null;
  kind: "maintenance" | "vgpu-off" | "evacuate" | "apply" | "toolstack" | "reboot" | "enable" | "vgpu-on" | "vms-back" | "refresh";
  label: string;
  state: StepState;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobOptions {
  /** Restart toolstack/host when the update asks for it. */
  automatic: boolean;
  /** Move VMs that were moved away back afterwards. */
  moveVmsBack: boolean;
  /**
   * Move VMs away from every host before updating it, also when no restart
   * is foreseen -- as XenCenter's maintenance mode does, and in case the host
   * turns out to need one after all.
   */
  evacuateAlways: boolean;
  /**
   * VMs with a vGPU on a host that is emptied are shut down and started again
   * on it afterwards instead of being live-migrated. Off by default: they are
   * live-migrated as XenCenter does, and one whose migration fails is not
   * tried live again but shut down and started cold (see coldMove).
   */
  vgpuShutdown: boolean;
  /**
   * VMs without the XenServer VM Tools cannot be live-migrated: when their
   * host is emptied they are shut down and started again on another host --
   * a short outage each -- and moved back the same way afterwards.
   */
  noToolsRestart?: boolean;
  /**
   * A pool update does not stop at a host that keeps failing: its step is
   * tried again after a pause; then the host is put back in service and
   * skipped, the others go on, and it is tried once more at the end.
   */
  skipFailingHosts?: boolean;
  /** Mail the administrators once the update has ended. */
  mail?: boolean;
}

/**
 * A VM this job shut down: one with a vGPU, to start again on its host; or
 * one without the VM Tools, started again on another host at once.
 */
export interface StoppedVm {
  vm: string;
  name: string;
  host: string;
  hostName: string | null;
  started?: boolean;
  /** It did not shut down by itself and was switched off the hard way. */
  hard?: boolean;
  /**
   * vgpu: shut down for its host's update, started there again. no-tools: no
   * VM Tools, so moved by a restart. vgpu-failed: its live migration failed,
   * so moved by a restart from then on -- a cold start gives it a clean vGPU.
   */
  reason?: "vgpu" | "no-tools" | "vgpu-failed";
}

export interface Job {
  id: string;
  hostId: string;
  poolName: string;
  by: string;
  scope: "pool" | "host";
  createdAt: string;
  finishedAt?: string;
  state: "running" | "done" | "failed" | "interrupted" | "stopped";
  /** Asked to stop; it does at the next point where nothing is left half done. */
  stopRequested?: { by: string; at: string };
  options: JobOptions;
  hash: string;
  steps: JobStep[];
  error?: string;
  /** What is left for someone to do by hand. */
  notes: string[];
  /** How many of the notes are the plan's warnings, known before it started (the mail leaves them out). */
  planNotes?: number;
  vgpuStopped?: StoppedVm[];
  /** Hosts skipped after their step kept failing, and why. */
  skipped?: { host: string; hostName: string | null; step: string; error: string; retried?: boolean }[];
  /** XenMan as the update was started from, for the mail. */
  link?: string;
  /** Workload Balancing was paused by this job and is still to be resumed. */
  wlbPaused?: boolean;
}

export interface Plan {
  hosts: { ref: string; name: string; isCoordinator: boolean; updates: number; steps: Omit<JobStep, "id" | "state">[] }[];
  /** Steps for the whole pool, after the last host. */
  finalSteps: string[];
  /** Reasons not to start; empty means it may. */
  blockers: string[];
  warnings: string[];
  hash: string | null;
  poolName: string;
  /** Running VMs with a vGPU on hosts this plan empties. */
  vgpuVms: number;
  /** Running VMs without the VM Tools on hosts this plan empties: they cannot be live-migrated. */
  noToolsVms: number;
}

/** The note for a VM without VM Tools that had to be switched off the hard way. */
export function hardNote(name: string): string {
  return `${name} did not shut down by itself and was switched off the hard way before its restart.`;
}

/** VMs this job shut down and has not started again, as "name (on host)". */
export function leftOff(job: Job): string[] {
  return (job.vgpuStopped ?? []).filter((x) => !x.started).map((x) => `${x.name} (on ${x.hostName ?? x.host})`);
}

function leftOffNote(job: Job): string | null {
  const off = leftOff(job);
  return off.length ? `Shut down by this update and not started again: ${off.join(", ")}. Start them once their host is back.` : null;
}

// ─── storage ─────────────────────────────────────────────────────────────────

// The jobs running in this process, as the runner holds them.
const g = globalThis as unknown as { _xenUpdateJobsLive?: Map<string, Job> };
const active = (g._xenUpdateJobsLive ??= new Map());

function save(job: Job) {
  fs.mkdirSync(JOB_DIR, { recursive: true });
  writeFileAtomic(path.join(JOB_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), 0o600);
}

function readJob(file: string): Job | null {
  try {
    const job = JSON.parse(fs.readFileSync(file, "utf-8")) as Job;
    // Running on disk but not in this process: XenMan restarted under it.
    if (job.state === "running" && !active.has(job.id)) {
      job.state = "interrupted";
      job.finishedAt = job.finishedAt ?? new Date().toISOString();
      job.error = "XenMan restarted while this was running. Check the hosts: one may still be in maintenance mode.";
      const off = leftOffNote(job);
      if (off) job.notes.push(off);
      for (const s of job.steps) if (s.state === "running") s.state = "failed";
      save(job);
    }
    return job;
  } catch {
    return null;
  }
}

export function listJobs(hostId?: string): Job[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(JOB_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => readJob(path.join(JOB_DIR, f)))
    .filter((j): j is Job => Boolean(j) && (!hostId || j!.hostId === hostId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id: string): Job | null {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  return readJob(path.join(JOB_DIR, `${id}.json`));
}

/**
 * Asks a running job to stop. It does so at the next safe point: an install
 * or a restart is never cut short, and neither is moving VMs with a vGPU.
 */
export function requestStop(id: string, by: string): Job | null {
  const job = active.get(id);
  if (!job || job.state !== "running") return null;
  if (!job.stopRequested) {
    job.stopRequested = { by, at: new Date().toISOString() };
    save(job);
  }
  return job;
}

function prune() {
  for (const old of listJobs().filter((j) => j.state !== "running").slice(KEEP)) {
    fs.rmSync(path.join(JOB_DIR, `${old.id}.json`), { force: true });
  }
}

// ─── planning ────────────────────────────────────────────────────────────────

/**
 * What a host needs. XAPI refuses to install while anything an earlier
 * installation asked for is still pending on the host (pending_guidances), so
 * that is done first; what the new updates ask for comes after them.
 */
function needs(h: HostUpdateState) {
  const install = h.updates.length > 0;
  const preReboot = h.pending.some((p) => p.startsWith("reboot_host"));
  const preToolstack = !preReboot && h.pending.includes("restart_toolstack");
  const postReboot = install && h.guidance.includes("RebootHost");
  const postToolstack = install && !postReboot && h.guidance.includes("RestartToolstack");
  return {
    install,
    preReboot,
    preToolstack,
    postReboot,
    postToolstack,
    reboot: preReboot || postReboot,
    evacuate: preReboot || postReboot || (install && h.guidance.includes("EvacuateHost")),
    // Only VMs restarting fixes this; XenMan does not restart VMs.
    pendingVmRestart: h.pending.includes("restart_device_model"),
    vmRestart: install && h.guidance.includes("RestartDeviceModel"),
  };
}

/** `vgpus`: running VMs with a vGPU on the host now; `noTools`: running VMs without the VM Tools. */
function stepsFor(h: HostUpdateState, o: JobOptions, vgpus = 0, noTools = 0): Omit<JobStep, "id" | "state">[] {
  const n = needs(h);
  const s = (kind: JobStep["kind"], label: string) => ({ host: h.ref, hostName: h.name, kind, label });
  const evacuate =
    n.postReboot || (o.automatic && n.preReboot) || (n.install && h.guidance.includes("EvacuateHost")) || o.evacuateAlways;
  const shutDown = evacuate && o.vgpuShutdown && vgpus > 0;
  const steps = [s("maintenance", evacuate ? "Enter maintenance mode" : "Disable the host (its VMs keep running)")];
  if (shutDown) steps.push(s("vgpu-off", vgpuOffLabel(vgpus)));
  if (evacuate) {
    steps.push(
      s(
        "evacuate",
        noTools && o.noToolsRestart
          ? `Move running VMs to other hosts — ${noTools} without the VM Tools: shut down and started there`
          : "Move running VMs to other hosts",
      ),
    );
  }
  if (o.automatic && n.preReboot) steps.push(s("reboot", "Restart the host (still pending from an earlier update)"));
  if (o.automatic && n.preToolstack) steps.push(s("toolstack", "Restart the toolstack (still pending from an earlier update)"));
  if (n.install) steps.push(s("apply", `Install ${h.updates.length} update${h.updates.length === 1 ? "" : "s"}`));
  if (o.automatic && n.postToolstack) steps.push(s("toolstack", "Restart the toolstack"));
  if (o.automatic && n.postReboot) steps.push(s("reboot", "Restart the host"));
  // A host still waiting for its restart stays in maintenance mode.
  const waitsForRestart = !o.automatic && n.postReboot;
  if (!waitsForRestart) steps.push(s("enable", "Leave maintenance mode"));
  if (shutDown && !waitsForRestart) steps.push(s("vgpu-on", VGPU_ON));
  if (steps.some((x) => x.kind === "evacuate") && o.moveVmsBack && !waitsForRestart) steps.push(s("vms-back", "Move the VMs back"));
  return steps;
}

const vgpuOffLabel = (n: number) => `Shut down ${n === 1 ? "the VM" : `${n} VMs`} with a vGPU`;
const VGPU_ON = "Start the VMs with a vGPU again";

const BACK_TO_HOMES = "Move back what is still away from its host";

/**
 * A pool update moves a host's VMs back as soon as the host is done, before
 * the next one -- as XenCenter does, so they are not crowded on the others for
 * the whole run; VMs with a vGPU too. A last step brings back whatever could
 * not be moved earlier.
 */
function poolShape(target: string, o: JobOptions, hosts: Plan["hosts"]): Pick<Plan, "hosts" | "finalSteps"> {
  if (target !== "pool") return { hosts, finalSteps: [] };
  const anyBack = hosts.some((h) => h.steps.some((st) => st.kind === "vms-back"));
  return { hosts, finalSteps: o.moveVmsBack && anyBack ? [BACK_TO_HOMES] : [] };
}

/**
 * Running VMs with a vGPU, per host, and those XenServer no longer lets
 * migrate because a failed vGPU migration left their vGPU pointing at a device
 * on another host (seen in the field: VM_HAS_PCI_ATTACHED afterwards).
 */
interface VgpuFacts {
  /** Running VMs with a vGPU, per host. */
  vms: Map<string, { vm: string; name: string }[]>;
  stuck: string[];
}

async function vgpuFacts(s: PoolSession): Promise<VgpuFacts> {
  const byHost = new Map<string, Map<string, string>>();
  const stuck: string[] = [];
  try {
    const [vms, vgpus, pcis] = await Promise.all([
      call<Record<string, Record<string, unknown>>>(s, "VM.get_all_records"),
      call<Record<string, Record<string, unknown>>>(s, "VGPU.get_all_records"),
      call<Record<string, Record<string, unknown>>>(s, "PCI.get_all_records").catch(() => ({})),
    ]);
    for (const [, g] of Object.entries(vgpus)) {
      const vm = vms[String(g.VM)];
      if (!vm || vm.power_state !== "Running") continue;
      const host = String(vm.resident_on);
      if (!byHost.has(host)) byHost.set(host, new Map());
      byHost.get(host)!.set(String(g.VM), String(vm.name_label));
      const pci = (pcis as Record<string, Record<string, unknown>>)[String(g.PCI)];
      if (pci && String(pci.host) !== host) stuck.push(String(vm.name_label));
    }
  } catch {
    // an older XenServer, or no GPUs
  }
  // A VM with two vGPUs counts once.
  const out = new Map([...byHost].map(([h, m]) => [h, [...m].map(([vm, name]) => ({ vm, name }))]));
  return { vms: out, stuck: [...new Set(stuck)].sort() };
}

/** A VM that cannot be moved off its host right now, and why. */
interface Stuck {
  vm: string;
  name: string;
  text: string;
  /** No XenServer VM Tools: it cannot be live-migrated, only shut down and started elsewhere. */
  noTools?: boolean;
  /** In the middle of something -- starting, migrating: over by itself soon. */
  busy: boolean;
  /** XenServer lists an operation whose task has ended: over only with a toolstack restart. */
  stale: boolean;
}

const OPERATION_NAMES: Record<string, string> = {
  start: "starting",
  start_on: "starting",
  resume: "resuming",
  resume_on: "resuming",
  pool_migrate: "migrating",
  migrate_send: "migrating",
  clean_shutdown: "shutting down",
  hard_shutdown: "switching off",
  clean_reboot: "restarting",
  hard_reboot: "restarting",
  snapshot: "taking a snapshot",
  checkpoint: "taking a checkpoint",
  suspend: "suspending",
  clone: "being cloned",
  copy: "being copied",
};

/**
 * VMs that could not be moved off a host right now. `skip`: VMs that will not
 * be moved anyway -- shut down instead. A VM "busy" (OTHER_OPERATION_IN_PROGRESS)
 * says what it is doing; one whose operation outlived its task is stale.
 */
async function evacuationProblems(s: PoolSession, hostRef: string, skip: Set<string> = new Set()): Promise<Stuck[]> {
  const prevent = await call<Record<string, string[]>>(s, "host.get_vms_which_prevent_evacuation", hostRef).catch(() => ({}));
  return Promise.all(
    Object.entries(prevent).filter(([vm]) => !skip.has(vm)).map(async ([vm, why]): Promise<Stuck> => {
      const name = await call<string>(s, "VM.get_name_label", vm).catch(() => vm);
      const code = (why || [])[0] ?? "cannot be moved";
      // What XenServer says of a guest without its tools (no PV drivers, so no suspend, so no live migration).
      if (/^VM_LACKS_FEATURE|PV_DRIVERS/.test(code)) {
        return { vm, name, text: `${name} (no VM Tools)`, busy: false, stale: false, noTools: true };
      }
      if (code !== "OTHER_OPERATION_IN_PROGRESS") return { vm, name, text: `${name} (${code})`, busy: false, stale: false };
      const ops = await call<Record<string, string>>(s, "VM.get_current_operations", vm).catch(() => ({}) as Record<string, string>);
      const [task, op] = Object.entries(ops)[0] ?? [];
      // Done meanwhile: nothing in the way any more.
      if (!task) return { vm, name, text: `${name} (busy)`, busy: true, stale: false };
      const rec = await call<Record<string, unknown>>(s, "task.get_record", task).catch(() => null);
      const what = OPERATION_NAMES[op] ?? op;
      if (!rec || rec.status !== "pending") {
        return { vm, name, text: `${name} (still marked as ${what}, though that ended)`, busy: false, stale: true };
      }
      const progress = Number(rec.progress);
      const since = rec.created ? anyDate(rec.created) : null;
      const detail = [
        since ? `since ${formatTime(since, serverDateFormat(), { seconds: false })}` : "",
        progress > 0 && progress < 1 ? `${Math.round(progress * 100)} %` : "",
      ].filter(Boolean).join(", ");
      return { vm, name, text: `${name} (${what}${detail ? `, ${detail}` : ""})`, busy: true, stale: false };
    }),
  );
}

const listStuck = (stuck: Stuck[]) => `${stuck.slice(0, 5).map((x) => x.text).join(", ")}${stuck.length > 5 ? ", …" : ""}`;

/** What a job would do, and what stands in its way -- without changing anything. */
export async function planJob(hostId: string, target: "pool" | string, o: JobOptions): Promise<Plan & { updates: PoolUpdates }> {
  const u = await readPoolUpdates(hostId);
  const blockers: string[] = [];
  const warnings: string[] = [];
  // Without automatic restarts, a host with nothing new to install has nothing
  // XenMan may do: what it waits for is a restart.
  const due = (h: HostUpdateState) =>
    h.updates.length > 0 || (o.automatic && h.pending.some((p) => p.startsWith("reboot_host") || p === "restart_toolstack"));
  let hosts = u.hosts.filter(due);
  if (target !== "pool") {
    const one = u.hosts.find((h) => h.ref === target);
    if (!one) blockers.push("This host is not in the pool.");
    else {
      const coordinator = u.hosts.find((h) => h.isCoordinator);
      if (!one.isCoordinator && coordinator && coordinator.updates.length > 0) {
        blockers.push(`Update the coordinator ${coordinator.name} first — or the whole pool at once.`);
      }
      hosts = due(one) ? [one] : [];
    }
  }
  if (u.problem) blockers.push(u.problem);
  if (!u.hash && hosts.some((h) => h.updates.length > 0)) blockers.push("No update list — check for updates first.");
  if (hosts.length === 0 && !u.problem) blockers.push("Nothing to install.");
  if (u.pool.haEnabled) blockers.push("High availability is on — switch it off for the update, as XenCenter would ask too.");
  if (u.pool.wlbActive) {
    warnings.push("Workload Balancing is paused for the update and resumed afterwards, so it does not move VMs while hosts are emptied and VMs brought back.");
  }
  if (listJobs(hostId).some((j) => j.state === "running")) blockers.push("An update is already running on this pool.");
  for (const h of hosts) if (!h.live) blockers.push(`${h.name} is offline.`);

  const evacuating = hosts.filter((h) => stepsFor(h, o).some((x) => x.kind === "evacuate"));
  let vgpu: VgpuFacts = { vms: new Map(), stuck: [] };
  const vgpusOn = (h: HostUpdateState) => vgpu.vms.get(h.ref)?.length ?? 0;
  let vgpuVms = 0;
  {
    const s = await openPoolSession(hostId);
    try {
      vgpu = await vgpuFacts(s);
      const { stuck } = vgpu;
      if (stuck.length) {
        warnings.push(
          `${stuck.join(", ")} cannot be migrated until shut down and started again: a failed vGPU migration left ${stuck.length === 1 ? "its" : "their"} vGPU pointing at a device on another host.`,
        );
      }
      vgpuVms = evacuating.reduce((n, h) => n + vgpusOn(h), 0);
      if (vgpuVms && o.vgpuShutdown) {
        const names = evacuating.flatMap((h) => (vgpu.vms.get(h.ref) ?? []).map((x) => x.name));
        warnings.push(
          `${vgpuVms} VM${vgpuVms === 1 ? "" : "s"} with a vGPU ${vgpuVms === 1 ? "is" : "are"} shut down while ${vgpuVms === 1 ? "its" : "their"} host is updated and started again on it afterwards: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}. Shutting down waits up to 10 minutes per VM, then switches it off.`,
        );
      } else if (vgpuVms) {
        warnings.push(
          `${vgpuVms} VM${vgpuVms === 1 ? "" : "s"} with a vGPU will be live-migrated, as XenCenter does — once the GPUs report their migration data. One whose migration fails is not tried again live: it is shut down and started on another host.`,
        );
      }
    } finally {
      await closePoolSession(s);
    }
  }
  // Running VMs without the VM Tools, per host emptied.
  const noToolsBy = new Map<string, number>();
  // VMs shut down rather than moved do not stand in the way of emptying a host.
  const skipFor = (h: HostUpdateState) => new Set(o.vgpuShutdown ? (vgpu.vms.get(h.ref) ?? []).map((x) => x.vm) : []);
  if (evacuating.length) {
    if (u.hosts.length < 2) {
      blockers.push("The update restarts the host, and a pool with one host has nowhere to move its VMs. Shut them down first.");
    } else {
      const s = await openPoolSession(hostId);
      try {
        // Every host at once: one by one, a pool of twenty took minutes.
        const found = new Map<string, Stuck[]>();
        for (let i = 0; i < evacuating.length; i += 4) {
          await Promise.all(evacuating.slice(i, i + 4).map(async (h) => found.set(h.ref, await evacuationProblems(s, h.ref, skipFor(h)))));
        }
        for (const h of evacuating) {
          const all = found.get(h.ref) ?? [];
          const noTools = all.filter((x) => x.noTools);
          if (noTools.length) {
            noToolsBy.set(h.ref, noTools.length);
            const names = listStuck(noTools).replace(/ \(no VM Tools\)/g, "");
            if (o.noToolsRestart) {
              warnings.push(
                `VMs on ${h.name} have no VM Tools and cannot be live-migrated: ${names}. They are shut down and started again on another host — a short outage each${o.moveVmsBack ? ", and once more when moved back" : ""}.`,
              );
            } else {
              blockers.push(
                `VMs on ${h.name} cannot be live-migrated, they have no XenServer VM Tools: ${names}. Let XenMan shut them down and start them on another host (switch above), or install the tools.`,
              );
            }
          }
          const busy = all.filter((x) => x.busy);
          const stale = all.filter((x) => x.stale);
          if (busy.length) {
            warnings.push(
              `VMs on ${h.name} are busy right now: ${listStuck(busy)}. When it is ${h.name}'s turn, XenMan waits for them (up to ${Math.round(BUSY_WAIT_MS / 60000)} minutes).`,
            );
          }
          if (stale.length) {
            blockers.push(
              `VMs on ${h.name} cannot be moved: ${listStuck(stale)}. XenServer still lists an operation whose task has ended; restarting the toolstack of ${h.name} clears it, the VMs keep running.`,
            );
          }
          const stuck = all.filter((x) => !x.busy && !x.stale && !x.noTools).map((x) => x.text);
          if (!stuck.length) continue;
          // "No host available" now may only mean that another host is in
          // maintenance mode -- one this plan brings back before it gets here.
          const comesBack = hosts
            .slice(0, hosts.indexOf(h))
            .some((x) => !x.enabled && stepsFor(x, o).some((st) => st.kind === "enable"));
          // Hosts in maintenance mode that this plan leaves there.
          const staysDown = u.hosts.filter((x) => x.ref !== h.ref && !x.enabled && !hosts.includes(x)).map((x) => x.name);
          const message = `VMs on ${h.name} cannot be moved to another host: ${stuck.slice(0, 5).join(", ")}${stuck.length > 5 ? ", …" : ""}`;
          const noHost = stuck.every((x) => x.includes("(NO_HOSTS_AVAILABLE)"));
          if (comesBack && noHost) {
            warnings.push(`${message}. That is because a host before it is in maintenance mode; it is checked again when it is ${h.name}'s turn.`);
          } else if (noHost && staysDown.length) {
            blockers.push(`${message}. ${staysDown.join(", ")} ${staysDown.length === 1 ? "is" : "are"} in maintenance mode — take ${staysDown.length === 1 ? "it" : "them"} out of maintenance mode first.`);
          } else {
            blockers.push(message);
          }
        }
      } finally {
        await closePoolSession(s);
      }
    }
  }
  for (const h of hosts) {
    const n = needs(h);
    if (n.install && n.pendingVmRestart) {
      blockers.push(`${h.name} still waits for its VMs to be restarted after an earlier update; XenServer installs nothing new until then.`);
    }
    if (!o.automatic && n.install && (n.preReboot || n.preToolstack)) {
      blockers.push(
        `${h.name} still waits for a ${n.preReboot ? "restart" : "toolstack restart"} from an earlier update, and XenServer installs nothing new until then. Allow automatic restarts, or restart it first.`,
      );
    }
    if (!o.automatic && n.postReboot) {
      warnings.push(
        `${h.name} needs a restart afterwards and stays in maintenance mode until you restart it.${o.vgpuShutdown && vgpusOn(h) ? " Its VMs with a vGPU stay shut down until then; start them afterwards." : ""}`,
      );
    }
    if (!o.automatic && n.postToolstack) warnings.push(`${h.name}: restart its toolstack afterwards.`);
    if (n.vmRestart) warnings.push(`VMs on ${h.name} need a restart to use the update; XenMan does not restart VMs.`);
  }
  return {
    updates: u,
    poolName: u.pool.name,
    hash: u.hash,
    blockers,
    warnings,
    vgpuVms,
    noToolsVms: [...noToolsBy.values()].reduce((a, b) => a + b, 0),
    ...poolShape(
      target,
      o,
      hosts.map((h) => ({
        ref: h.ref,
        name: h.name,
        isCoordinator: h.isCoordinator,
        updates: h.updates.length,
        steps: stepsFor(h, o, vgpusOn(h), noToolsBy.get(h.ref) ?? 0),
      })),
    ),
  };
}

// ─── running ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startJob(
  hostId: string,
  target: "pool" | string,
  options: JobOptions,
  by: string,
  onEvent: (action: string, outcome: "success" | "failure", target: string, detail?: string) => void,
  link?: string,
): Promise<{ job?: Job; blockers?: string[] }> {
  const plan = await planJob(hostId, target, options);
  if (plan.blockers.length) return { blockers: plan.blockers };
  const job: Job = {
    id: crypto.randomUUID(),
    hostId,
    poolName: plan.poolName,
    by,
    scope: target === "pool" ? "pool" : "host",
    createdAt: new Date().toISOString(),
    state: "running",
    options,
    hash: plan.hash ?? "",
    steps: [
      ...plan.hosts.flatMap((h) => h.steps.map((s) => ({ ...s, id: crypto.randomUUID(), state: "todo" as StepState }))),
      ...plan.finalSteps.map((label) => ({ id: crypto.randomUUID(), host: null, hostName: null, kind: "vms-back" as const, label, state: "todo" as StepState })),
      { id: crypto.randomUUID(), host: null, hostName: null, kind: "refresh", label: "Refresh the update list", state: "todo" },
    ],
    notes: plan.warnings,
    planNotes: plan.warnings.length,
    ...(link ? { link } : {}),
  };
  active.set(job.id, job);
  save(job);
  prune();
  onEvent("xen_update_started", "success", `pool ${job.poolName}`, plan.hosts.map((h) => `${h.name}: ${h.steps.map((s) => s.label).join(", ")}`).join("; "));
  run(job, onEvent).finally(() => active.delete(job.id));
  return { job };
}

/** A session that survives the coordinator going away: reopened when needed. */
class Conn {
  s: PoolSession | null = null;
  constructor(private hostId: string) {}
  async get(): Promise<PoolSession> {
    if (!this.s) this.s = await openPoolSession(this.hostId);
    return this.s;
  }
  async call<T>(method: string, ...params: unknown[]): Promise<T> {
    try {
      return await call<T>(await this.get(), method, ...params);
    } catch (err) {
      if (err instanceof Error && /SESSION_INVALID|fetch .*failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(err.message)) {
        this.s = null;
        return call<T>(await this.get(), method, ...params);
      }
      throw err;
    }
  }
  async task(method: string, timeout: number, ...params: unknown[]): Promise<string> {
    return this.stoppable(() => false, method, timeout, ...params);
  }
  /** A task cancelled once `cancelWhen` says so; StopRequested is thrown then. */
  async stoppable(cancelWhen: () => boolean, method: string, timeout: number, ...params: unknown[]): Promise<string> {
    const s = await this.get();
    const task = await call<string>(s, method, ...params);
    return awaitTask(s, task, timeout, undefined, cancelWhen);
  }
  /** Waits until the pool answers again -- after a coordinator restart. */
  async reconnect(deadline: number): Promise<void> {
    this.s = null;
    for (;;) {
      try {
        await this.get();
        return;
      } catch (err) {
        // A host that came back with another certificate is not waited for.
        if (err instanceof CertMismatchError) throw err;
        if (Date.now() > deadline) throw new Error("The pool did not come back in time");
        await sleep(POLL_MS);
      }
    }
  }
  async close() {
    if (this.s) await closePoolSession(this.s);
  }
}

async function run(job: Job, onEvent: (action: string, outcome: "success" | "failure", target: string, detail?: string) => void) {
  const c = new Conn(job.hostId);
  /** The update has ended: tell the administrators, if asked to. In the background. */
  const mailEnd = () => {
    if (!job.options.mail) return;
    void mailJobEnded(job).then((r) => onEvent("xen_update_mail", r.sent ? "success" : "failure", `pool ${job.poolName}`, r.detail));
  };
  // Once stopped, the wrap-up itself must not be stopped again.
  let wrappingUp = false;
  const stopping = () => Boolean(job.stopRequested) && !wrappingUp;
  /** A wait that ends early, with StopRequested, when the job is asked to stop. */
  const pause = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (stopping()) throw new StopRequested();
      await sleep(Math.min(1000, until - Date.now()));
    }
  };
  const never = () => false;
  /**
   * Workload Balancing moves VMs on its own judgement: not while this job
   * empties hosts and brings VMs back. Paused only if it was acting, so a WLB
   * someone paused on purpose stays paused afterwards too.
   */
  const pauseWlb = async () => {
    const [p] = await c.call<string[]>("pool.get_all");
    const [url, acting] = await Promise.all([
      c.call<string>("pool.get_wlb_url", p).catch(() => ""),
      c.call<boolean>("pool.get_wlb_enabled", p).catch(() => false),
    ]);
    if (!url || !acting) return;
    try {
      await c.call("pool.set_wlb_enabled", p, false);
    } catch (e) {
      throw new Error(`Workload Balancing could not be paused for the update (${friendlyXapiError(e)}); nothing was changed`);
    }
    job.wlbPaused = true;
    save(job);
    onEvent("xen_update_wlb", "success", `pool ${job.poolName}`, "Workload Balancing paused for the update");
  };
  /** Restarts a host's toolstack and waits until the pool counts it as online again. */
  const restartToolstack = async (step: JobStep, h: string) => {
    const isCoordinator = (await c.call<string[]>("pool.get_all").then((p) => c.call<string>("pool.get_master", p[0]))) === h;
    await c.call("host.restart_agent", h).catch(() => {});
    await sleep(POLL_MS);
    if (isCoordinator) await c.reconnect(Date.now() + UP_MS);
    // A member's toolstack has to report back to the coordinator before the
    // pool counts the host as online again.
    const upBy = Date.now() + UP_MS;
    while (!(await c.call<boolean>("host_metrics.get_live", await c.call<string>("host.get_metrics", h)).catch(() => false))) {
      if (Date.now() > upBy) throw new Error("The host did not come back after its toolstack restart");
      if (step.detail !== "waiting for the host to report back") {
        step.detail = "waiting for the host to report back";
        save(job);
      }
      await sleep(POLL_MS);
    }
    if (step.detail === "waiting for the host to report back") step.detail = undefined;
  };

  // NVIDIA GPUs that carried migration data when the job began. XAPI reads it
  // from the host's GPU monitor when its toolstack starts; started before the
  // monitor was ready, it stays empty -- and then no vGPU VM on that host may
  // be migrated (XenCenter hides "Migrate"), seen in the field.
  const gpusWithData = new Map<string, string>();
  try {
    const pgpus = await c.call<Record<string, Record<string, unknown>>>("PGPU.get_all_records");
    for (const [ref, g] of Object.entries(pgpus)) {
      const meta = (g.compatibility_metadata as Record<string, string>) || {};
      if (meta.nvidia) gpusWithData.set(ref, String(g.host));
    }
  } catch {
    // no GPUs, or an older XenServer: nothing to watch
  }
  const gpusMissingData = async (h: string): Promise<number> => {
    const watched = [...gpusWithData].filter(([, host]) => host === h).map(([ref]) => ref);
    if (!watched.length) return 0;
    const pgpus = await c.call<Record<string, Record<string, unknown>>>("PGPU.get_all_records").catch(() => ({}));
    return watched.filter((ref) => !((pgpus as Record<string, Record<string, unknown>>)[ref]?.compatibility_metadata as Record<string, string> | undefined)?.nvidia).length;
  };
  const waitForGpuData = async (step: JobStep, h: string): Promise<boolean> => {
    const until = Date.now() + GPU_WAIT_MS;
    for (;;) {
      if ((await gpusMissingData(h)) === 0) return true;
      if (Date.now() > until) return false;
      step.detail = "waiting for the GPUs to report their migration data";
      save(job);
      await sleep(POLL_MS);
    }
  };
  /**
   * After a toolstack or host restart: the GPUs' migration data must be back
   * before VMs move. Missing after a wait, the toolstack is restarted once
   * more -- by then the GPU monitor runs -- and if that does not help either,
   * the job stops before any VM gets stuck.
   */
  const gpusReady = async (step: JobStep, h: string) => {
    if (![...gpusWithData.values()].includes(h)) return;
    if (await waitForGpuData(step, h)) {
      if (step.detail?.startsWith("waiting for the GPUs")) step.detail = undefined;
      return;
    }
    step.detail = "the GPUs report no migration data — restarting the toolstack once more";
    save(job);
    await restartToolstack(step, h);
    if (await waitForGpuData(step, h)) {
      step.detail = "GPU migration data back after a second toolstack restart";
      return;
    }
    throw new Error(
      `the GPUs of ${step.hostName} report no migration data, so no vGPU VM there can be migrated. ` +
        "On the host: systemctl restart xcp-rrdd-gpumon && xe-toolstack-restart",
    );
  };

  // Where each VM ran before this job moved it: its way home.
  const home = new Map<string, string>();
  // Hosts skipped and not (yet) done on their second try.
  const unresolved = new Set<string>();
  // Hosts whose step failed because another operation held the pool, and
  // whether the coordinator's toolstack was restarted for it (once per update).
  const poolBusyHosts = new Map<string, string>();
  let coordinatorRestarted = false;
  // VMs whose way back failed for good (a passed-through device, a vGPU):
  // not tried again by a later step.
  const gaveUp = new Set<string>();
  const begin = (s: JobStep) => {
    s.state = "running";
    s.startedAt = new Date().toISOString();
    save(job);
  };
  const end = (s: JobStep, state: StepState, detail?: string) => {
    s.state = state;
    s.finishedAt = new Date().toISOString();
    if (detail) s.detail = detail;
    // A retry's progress note has no business on a finished step.
    else if (state === "done" && /attempt \d+ of \d+/.test(s.detail ?? "")) s.detail = "done after a retry";
    save(job);
  };
  /**
   * Runs `fn`, and when it fails in a way `retryable` accepts, waits and runs
   * it again -- up to RETRY_DELAYS_MS.length more times. The step shows which
   * attempt it is on and why the last one failed.
   */
  const retry = async <T>(
    step: JobStep,
    fn: () => Promise<T>,
    retryable: (err: unknown) => boolean,
    what = "",
  ): Promise<{ value: T; attempts: number }> => {
    const total = RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return { value: await fn(), attempts: attempt };
      } catch (err) {
        if (err instanceof StopRequested || attempt >= total || !retryable(err)) throw err;
        const wait = RETRY_DELAYS_MS[attempt - 1];
        step.detail = `${what}attempt ${attempt} of ${total} failed (${friendlyXapiError(err)}) — trying again in ${Math.round(wait / 1000)} s`;
        save(job);
        await pause(wait);
        step.detail = `${what}attempt ${attempt + 1} of ${total}`;
        save(job);
      }
    }
  };

  /**
   * What the host itself now says is left to do. The metadata may not have
   * said -- and XenServer will not let a host out of maintenance mode while
   * anything mandatory is pending -- so the steps for it are added here.
   */
  const followPending = async (applied: JobStep) => {
    const h = applied.host!;
    const pending = await c.call<string[]>("host.get_pending_guidances", h).catch(() => [] as string[]);
    const at = job.steps.indexOf(applied);
    const later = job.steps.slice(at + 1).filter((x) => x.host === h);
    const has = (kind: JobStep["kind"]) => later.some((x) => x.kind === kind);
    const reboot = pending.some((p) => p.startsWith("reboot_host"));
    const toolstack = !reboot && pending.includes("restart_toolstack");
    if (pending.includes("restart_device_model") || pending.includes("restart_vm")) {
      job.notes.push(`VMs on ${applied.hostName} need a restart to use the update; XenMan does not restart VMs.`);
    }
    if (!reboot && !toolstack) return;
    if ((reboot && has("reboot")) || (toolstack && (has("toolstack") || has("reboot")))) return;

    const mk = (kind: JobStep["kind"], label: string): JobStep => ({
      id: crypto.randomUUID(), host: h, hostName: applied.hostName, kind, label, state: "todo",
    });
    if (!job.options.automatic) {
      // Left in maintenance mode, as XenServer requires, and said so.
      for (const x of later) if (x.kind === "enable" || x.kind === "vgpu-on" || x.kind === "vms-back") x.state = "skipped";
      job.notes.push(
        `${applied.hostName} needs a ${reboot ? "restart" : "toolstack restart"} to finish its update and stays in maintenance mode until then.`,
      );
      save(job);
      return;
    }
    const insert: JobStep[] = [];
    const evacuated = job.steps.slice(0, at).some((x) => x.host === h && x.kind === "evacuate");
    // Emptied only now: VMs with a vGPU are shut down rather than migrated here
    // too, or the option would not hold when the metadata kept quiet.
    const vgpus = reboot && !evacuated && job.options.vgpuShutdown ? ((await vgpuFacts(await c.get())).vms.get(h)?.length ?? 0) : 0;
    if (vgpus) insert.push(mk("vgpu-off", vgpuOffLabel(vgpus)));
    if (reboot && !evacuated) insert.push(mk("evacuate", "Move running VMs to other hosts"));
    insert.push(reboot ? mk("reboot", "Restart the host (the update asked for it)") : mk("toolstack", "Restart the toolstack (the update asked for it)"));
    job.steps.splice(at + 1, 0, ...insert);
    const enableAt = () => job.steps.findIndex((x, i) => i > at && x.host === h && x.kind === "enable");
    if (reboot && !evacuated && job.options.moveVmsBack) {
      if (!has("vms-back") && enableAt() >= 0) job.steps.splice(enableAt() + 1, 0, mk("vms-back", "Move the VMs back"));
      if (job.scope === "pool" && !job.steps.some((x) => x.kind === "vms-back" && !x.host)) {
        const refresh = job.steps.findIndex((x) => x.kind === "refresh");
        job.steps.splice(refresh, 0, { ...mk("vms-back", BACK_TO_HOMES), host: null, hostName: null });
      }
    }
    if (vgpus && enableAt() >= 0) job.steps.splice(enableAt() + 1, 0, mk("vgpu-on", VGPU_ON));
    save(job);
  };

  /**
   * Shuts down the VMs with a vGPU on a host: cleanly, and after SHUTDOWN_MS
   * -- or at once when the VM refuses, e.g. without a guest agent -- the hard
   * way. Recorded before anything happens, so a stop, a failure or a restart
   * of XenMan still knows which VMs to start again.
   */
  const vgpuOff = async (step: JobStep, h: string) => {
    const vms = (await vgpuFacts(await c.get())).vms.get(h) ?? [];
    const known = new Set((job.vgpuStopped ?? []).filter((x) => !x.started).map((x) => x.vm));
    job.vgpuStopped = [
      ...(job.vgpuStopped ?? []),
      ...vms.filter((x) => !known.has(x.vm)).map((x) => ({ ...x, host: h, hostName: step.hostName })),
    ];
    save(job);
    const forced: string[] = [];
    await Promise.all(
      vms.map(async ({ vm, name }) => {
        try {
          await c.task("Async.VM.clean_shutdown", SHUTDOWN_MS, vm);
        } catch {
          if ((await c.call<string>("VM.get_power_state", vm).catch(() => "")) === "Halted") return;
          await c.task("Async.VM.hard_shutdown", HARD_SHUTDOWN_MS, vm);
          forced.push(name);
        }
      }),
    );
    end(step, "done", `${vms.length} shut down${forced.length ? `; switched off the hard way: ${forced.join(", ")}` : ""}`);
  };

  /** Shuts a VM down cleanly; after SHUTDOWN_MS, or when it refuses, the hard way. True when it took the hard way. */
  const shutDown = async (vm: string): Promise<boolean> => {
    try {
      await c.task("Async.VM.clean_shutdown", SHUTDOWN_MS, vm);
      return false;
    } catch {
      if ((await c.call<string>("VM.get_power_state", vm).catch(() => "")) === "Halted") return false;
      await c.task("Async.VM.hard_shutdown", HARD_SHUTDOWN_MS, vm);
      return true;
    }
  };

  /**
   * The VMs without the VM Tools on a host being emptied: shut down and
   * started again where XenServer places them -- not on this host, which is
   * in maintenance mode. Recorded first, so that whatever happens, the job
   * knows to start them. Returns their names.
   */
  const restartElsewhere = async (step: JobStep, h: string): Promise<string[]> => {
    const vms = (await evacuationProblems(await c.get(), h)).filter((x) => x.noTools && !x.busy);
    if (!vms.length) return [];
    const known = new Set((job.vgpuStopped ?? []).filter((x) => !x.started).map((x) => x.vm));
    job.vgpuStopped = [
      ...(job.vgpuStopped ?? []),
      ...vms.filter((x) => !known.has(x.vm)).map((x) => ({ vm: x.vm, name: x.name, host: h, hostName: step.hostName, reason: "no-tools" as const })),
    ];
    save(job);
    const failed: string[] = [];
    for (const x of vms) {
      step.detail = `restarting ${x.name} on another host (no VM Tools)`;
      save(job);
      try {
        const hard = await shutDown(x.vm);
        await c.task("Async.VM.start", START_MS, x.vm, false, false);
        const entry = job.vgpuStopped!.find((y) => y.vm === x.vm && !y.started);
        if (entry) Object.assign(entry, { started: true, ...(hard ? { hard: true } : {}) });
        if (hard) job.notes.push(hardNote(x.name));
        save(job);
      } catch (err) {
        failed.push(`${x.name} (${friendlyXapiError(err)})`);
      }
    }
    delete step.detail;
    if (failed.length) {
      throw new Error(`not started again on another host: ${failed.join(", ")}. They are started on ${step.hostName} once it is back.`);
    }
    return vms.map((x) => x.name);
  };

  /**
   * Moves a VM by restarting it: shut down (after SHUTDOWN_MS the hard way),
   * then started on `to` -- or, with `to` null, where XenServer places it,
   * which is not its host while that is in maintenance mode. Recorded before
   * anything happens (vgpu-failed), so the way back is a restart too and a
   * failure still knows to start it. Never left off: when it does not start
   * on `to`, it is started wherever it can be.
   */
  const coldMove = async (vm: string, name: string, to: string | null, step: JobStep, from?: string) => {
    if (from && !(job.vgpuStopped ?? []).some((x) => x.vm === vm && x.reason === "vgpu-failed")) {
      job.vgpuStopped = [...(job.vgpuStopped ?? []), { vm, name, host: from, hostName: step.hostName, reason: "vgpu-failed", started: false }];
      save(job);
    }
    step.detail = `restarting ${name}${to ? "" : " on another host"} (its vGPU migration failed)`;
    save(job);
    await shutDown(vm);
    if (to) {
      try {
        await c.task("Async.VM.start_on", START_MS, vm, to, false, false);
      } catch (err) {
        await c.task("Async.VM.start", START_MS, vm, false, false);
        throw err;
      }
    } else {
      await c.task("Async.VM.start", START_MS, vm, false, false);
    }
    const entry = (job.vgpuStopped ?? []).find((x) => x.vm === vm && x.reason === "vgpu-failed");
    if (entry) entry.started = true;
    delete step.detail;
    save(job);
  };

  /**
   * Empties a host VM by VM, the biggest first, each to the host XenServer
   * says can run it (VM.assert_can_boot_here) with the most memory free --
   * for when its evacuation found no plan for all of them at once. A VM no
   * host takes is named, with what it needs and why not.
   */
  const moveOneByOne = async (step: JobStep, h: string, cancel: () => boolean): Promise<string> => {
    const vms: { vm: string; name: string; mem: number }[] = [];
    for (const vm of await c.call<string[]>("host.get_resident_VMs", h)) {
      const rec = await c.call<Record<string, unknown>>("VM.get_record", vm).catch(() => null);
      if (!rec || rec.is_control_domain || rec.power_state !== "Running") continue;
      vms.push({ vm, name: String(rec.name_label), mem: Number(rec.memory_dynamic_max ?? rec.memory_static_max ?? 0) });
    }
    vms.sort((a, b) => b.mem - a.mem);
    const others = (await c.call<string[]>("host.get_all")).filter((x) => x !== h);
    const noHost: string[] = [];
    let moved = 0;
    for (const { vm, name, mem } of vms) {
      if (stopping()) throw new StopRequested();
      step.detail = `moving ${name} on its own — XenServer found no plan for all VMs at once`;
      save(job);
      let best: string | null = null;
      let bestFree = -1;
      let why = "";
      for (const x of others) {
        if (!(await c.call<boolean>("host.get_enabled", x).catch(() => false))) continue;
        try {
          await c.call("VM.assert_can_boot_here", vm, x);
        } catch (e) {
          why = friendlyXapiError(e);
          continue;
        }
        const free = Number(await c.call<string>("host.compute_free_memory", x).catch(() => "0"));
        if (free > bestFree) {
          best = x;
          bestFree = free;
        }
      }
      if (!best) {
        noHost.push(`${name} (${mem ? `${GiB(mem)}, ` : ""}${why || "no host takes it"})`);
        continue;
      }
      const vgpu = (await c.call<string[]>("VM.get_VGPUs", vm).catch(() => [] as string[])).length > 0;
      try {
        await c.stoppable(vgpu ? never : cancel, "Async.VM.pool_migrate", MIGRATE_MS, vm, best, { live: "true" });
        moved++;
      } catch (e) {
        if (e instanceof StopRequested) throw e;
        if (vgpu) {
          // As everywhere: a vGPU VM is not tried live again but restarted.
          await coldMove(vm, name, null, step, h);
          moved++;
        } else {
          noHost.push(`${name} (${friendlyXapiError(e)})`);
        }
      }
    }
    delete step.detail;
    if (noHost.length) {
      throw new Error(`XenServer found no host for: ${noHost.join(", ")} — even moving them one by one`);
    }
    return `${moved} moved one by one (XenServer found no plan for all at once)`;
  };

  /** Starts a host's VMs with a vGPU that this job shut down, on that host. */
  const vgpuOn = async (h: string): Promise<{ started: number; failed: string[] }> => {
    const failed: string[] = [];
    let started = 0;
    for (const x of (job.vgpuStopped ?? []).filter((y) => y.host === h && !y.started)) {
      try {
        // Started by someone in the meantime: nothing to do.
        if ((await c.call<string>("VM.get_power_state", x.vm).catch(() => "")) !== "Running") {
          await c.task("Async.VM.start_on", START_MS, x.vm, h, false, false);
        }
        x.started = true;
        started++;
        save(job);
      } catch (err) {
        failed.push(`${x.name} (${friendlyXapiError(err)})`);
      }
    }
    return { started, failed };
  };

  /** VMs this job shut down whose host is in service again: started; the rest said. */
  const startWhatCan = async () => {
    for (const h of new Set((job.vgpuStopped ?? []).filter((x) => !x.started).map((x) => x.host))) {
      if (await c.call<boolean>("host.get_enabled", h).catch(() => false)) await vgpuOn(h);
    }
    const off = leftOffNote(job);
    if (off) job.notes.push(off);
  };
  const after = (attempts: number) => (attempts > 1 ? ` (after ${attempts} attempts)` : "");

  /** Takes a host out of maintenance mode, once its restarted toolstack lets it. */
  const enableHost = async (step: JobStep, h: string) => {
    // After a toolstack or host restart XAPI answers before it is ready
    // and refuses with HOST_STILL_BOOTING for a while: waited out.
    const until = Date.now() + UP_MS;
    for (;;) {
      try {
        await retry(step, () => c.call("host.enable", h), transient);
        break;
      } catch (err) {
        // HOST_STILL_BOOTING from the host itself, HOST_OFFLINE while a
        // member has not yet reported back to the coordinator.
        const starting = err instanceof Error && ["HOST_STILL_BOOTING", "HOST_OFFLINE"].includes(err.message);
        if (!starting || Date.now() > until) throw err;
        if (step.detail !== "waiting for the toolstack to finish starting") {
          step.detail = "waiting for the toolstack to finish starting";
          save(job);
        }
        await sleep(POLL_MS);
      }
    }
    if (step.detail === "waiting for the toolstack to finish starting") step.detail = undefined;
  };

  /**
   * After a stop: the host this job had in maintenance mode comes out of it
   * when nothing is pending there -- otherwise it stays, and the notes say
   * why. Nothing else is touched; what was not done is said.
   */
  /**
   * A host's step failed. Tried again after a pause (HOST_RETRY_DELAYS_MS);
   * then, in a pool update, the host is put back in service as far as it can
   * be and skipped -- the others go on -- and its steps are added once more
   * after the last host. Not for the coordinator, which the others depend on,
   * nor for a stop or a certificate that changed: those end the job.
   */
  const onHostFailure = async (step: JobStep, err: unknown, round: number): Promise<"again" | "skip" | "stop"> => {
    if (err instanceof StopRequested || err instanceof CertMismatchError || stopping()) return "stop";
    if (!job.options.skipFailingHosts || job.scope !== "pool" || !step.host) return "stop";
    const h = step.host;
    const message = friendlyXapiError(err);
    const coordinatorOf = () =>
      c.call<string[]>("pool.get_all").then((p) => c.call<string>("pool.get_master", p[0])).catch(() => "");
    // Another operation holds the pool -- for one host after the other, or for the
    // coordinator through all its tries: a lock its toolstack keeps, seen in the field
    // (XenCenter got stuck the same way; restarting the coordinator's toolstack freed
    // it). Done once per update, with automatic restarts allowed; then tried again.
    const busy = poolBusy(err) && job.options.automatic && !coordinatorRestarted;
    const restartCoordinator = async (coordinator: string): Promise<"again"> => {
      coordinatorRestarted = true;
      const name = await c.call<string>("host.get_name_label", coordinator).catch(() => "the coordinator");
      const blocked = [...poolBusyHosts.values()].join(", ");
      step.detail = `another operation keeps blocking the pool — restarting the toolstack of ${name}`;
      save(job);
      onEvent("xen_update_coordinator_toolstack", "success", `host ${name}`, `the pool was blocked for ${blocked}`);
      await restartToolstack(step, coordinator);
      job.notes.push(`Another operation kept blocking the pool (${blocked}). XenMan restarted the toolstack of the coordinator ${name} and tried again.`);
      step.detail = `trying again after restarting the toolstack of ${name}`;
      save(job);
      return "again";
    };
    if (busy) {
      // Another host blocked the same way before, or this one again on its second try.
      const another = [...poolBusyHosts.keys()].some((x) => x !== h) || (poolBusyHosts.has(h) && step.label.endsWith("(second try)"));
      poolBusyHosts.set(h, step.hostName ?? h);
      if (another) {
        const coordinator = await coordinatorOf();
        if (coordinator) return restartCoordinator(coordinator);
      }
    }
    if (round <= HOST_RETRY_DELAYS_MS.length) {
      const wait = HOST_RETRY_DELAYS_MS[round - 1];
      step.detail = `failed (${message}) — trying again in ${Math.round(wait / 60000) || 1} min`;
      save(job);
      onEvent("xen_update_step_retry", "failure", `host ${step.hostName}`, `${step.label}: ${message}`);
      await pause(wait);
      step.detail = `try ${round + 1} of ${HOST_RETRY_DELAYS_MS.length + 1}`;
      save(job);
      return "again";
    }
    const coordinator = await coordinatorOf();
    if (coordinator === h && busy) return restartCoordinator(coordinator);
    if (coordinator === h) return "stop";

    end(step, "failed", message);
    const first = !(job.skipped ?? []).some((x) => x.host === h);
    // The rest of this host's steps, this time round.
    for (const x of job.steps) if (x.host === h && x.state === "todo") x.state = "skipped";
    job.skipped = [...(job.skipped ?? []), { host: h, hostName: step.hostName, step: step.label, error: message, retried: !first }];
    unresolved.add(h);
    onEvent("xen_update_host_skipped", "failure", `host ${step.hostName}`, `${step.label}: ${message}`);

    // Back in service, unless something it needs is pending (it then stays in maintenance mode).
    const live = await c.call<boolean>("host_metrics.get_live", await c.call<string>("host.get_metrics", h)).catch(() => false);
    const enabled = await c.call<boolean>("host.get_enabled", h).catch(() => true);
    const pending = await c.call<string[]>("host.get_pending_guidances", h).catch(() => [] as string[]);
    let state = "";
    if (!live) state = "is not reachable";
    else if (!enabled && pending.some((x) => x.startsWith("reboot_host") || x === "restart_toolstack")) state = "stays in maintenance mode: a restart is pending";
    else if (!enabled) {
      const tmp: JobStep = { ...step, id: crypto.randomUUID(), detail: undefined };
      try {
        await enableHost(tmp, h);
        state = "is back in service";
      } catch (e) {
        state = `stays in maintenance mode (${friendlyXapiError(e)})`;
      }
    } else state = "is in service";
    if (state === "is back in service" || state === "is in service") await vgpuOn(h).catch(() => ({ started: 0, failed: [] }));
    job.notes.push(`${step.hostName} was skipped — ${step.label} failed: ${message}. It ${state}.${first ? " It is tried again at the end." : ""}`);

    // Once more after the last host, as the host is now.
    if (first) {
      try {
        const u = await readPoolUpdates(job.hostId);
        const now = u.hosts.find((x) => x.ref === h);
        if (now && (now.updates.length > 0 || now.pending.length > 0 || !now.enabled)) {
          const vgpus = (await vgpuFacts(await c.get())).vms.get(h)?.length ?? 0;
          const again = stepsFor(now, job.options, vgpus).map((x) => ({ ...x, id: crypto.randomUUID(), state: "todo" as StepState, label: `${x.label} (second try)` }));
          const at = job.steps.findIndex((x) => x.host === null);
          job.steps.splice(at < 0 ? job.steps.length : at, 0, ...again);
        } else {
          unresolved.delete(h);
        }
      } catch {
        // not readable now: it stays skipped
      }
    }
    save(job);
    return "skip";
  };

  const wrapUp = async (err: unknown) => {
    wrappingUp = true;
    const running = job.steps.find((s) => s.state === "running");
    if (running?.kind === "enable") running.state = "todo"; // done below
    else if (running) {
      if (err instanceof StopRequested) end(running, "skipped", running.kind === "vms-back" ? undefined : "stopped");
      else end(running, "failed", friendlyXapiError(err));
    }
    const enableOf = (h: string | null) => job.steps.find((x) => x.host === h && x.kind === "enable");
    const current = job.steps.find((s) => s.kind === "maintenance" && s.state !== "todo" && enableOf(s.host)?.state === "todo");
    // An install is never cut short: one not done did not start.
    const notUpdated = [...new Set(job.steps.filter((s) => s.kind === "apply" && s.state !== "done").map((s) => s.hostName ?? s.host))];
    for (const s of job.steps) if (s.state === "todo" && s !== enableOf(current?.host ?? null)) s.state = "skipped";

    if (current) {
      const h = current.host!;
      const enable = enableOf(h)!;
      const pending = await c.call<string[]>("host.get_pending_guidances", h).catch(() => [] as string[]);
      const reboot = pending.some((p) => p.startsWith("reboot_host"));
      if (reboot || pending.includes("restart_toolstack")) {
        enable.state = "skipped";
        job.notes.push(
          `${current.hostName} stays in maintenance mode: it needs a ${reboot ? "restart" : "toolstack restart"} to finish its update. Restart it, then take it out of maintenance mode.`,
        );
      } else {
        begin(enable);
        try {
          await enableHost(enable, h);
          end(enable, "done", "after the stop");
        } catch (e) {
          end(enable, "failed", friendlyXapiError(e));
          job.notes.push(`${current.hostName} could not be taken out of maintenance mode (${friendlyXapiError(e)}). Do it in XenCenter.`);
        }
      }
    }
    if (notUpdated.length) job.notes.push(`Not updated: ${notUpdated.join(", ")}.`);
    await startWhatCan();
    const away: string[] = [];
    for (const [vm, from] of home) {
      const [state, at] = await Promise.all([
        c.call<string>("VM.get_power_state", vm).catch(() => ""),
        c.call<string>("VM.get_resident_on", vm).catch(() => from),
      ]);
      if (state === "Running" && at !== from) away.push(await c.call<string>("VM.get_name_label", vm).catch(() => vm));
    }
    if (away.length) {
      job.notes.push(
        `Moved away by this update and not back: ${away.slice(0, 10).join(", ")}${away.length > 10 ? ` and ${away.length - 10} more` : ""}. They keep running where they are.`,
      );
    }
    job.state = "stopped";
    job.finishedAt = new Date().toISOString();
    save(job);
    onEvent("xen_update_stopped", "success", `pool ${job.poolName}`, [`stopped by ${job.stopRequested?.by}`, ...job.notes].join(" "));
    mailEnd();
  };

  try {
    await pauseWlb();
    // Steps may be added or skipped as the job learns what a host needs.
    steps: for (const step of job.steps) {
      if (step.state === "skipped") continue;
      // Between steps nothing is half done: the place to stop.
      if (stopping()) throw new StopRequested();
      begin(step);
      const h = step.host!;
      // A step that fails is tried again, then its host skipped (onHostFailure).
      for (let round = 1; ; round++) {
      try {
      switch (step.kind) {
        case "maintenance": {
          // Checked again now, before this host changes at all: the plan saw
          // the pool as it was, and hosts before this one have moved VMs.
          if (job.steps.some((x) => x.host === h && x.kind === "evacuate")) {
            // VMs about to be shut down need not move.
            const shutDown = job.steps.some((x) => x.host === h && x.kind === "vgpu-off");
            const skip = new Set(shutDown ? ((await vgpuFacts(await c.get())).vms.get(h) ?? []).map((x) => x.vm) : []);
            // VMs in the middle of something -- a VDI desktop starting -- are
            // waited for, as XenCenter would leave them to finish.
            const busyUntil = Date.now() + BUSY_WAIT_MS;
            // VMs without the tools are the evacuation's to restart elsewhere, when allowed.
            const problems = async () =>
              (await evacuationProblems(await c.get(), h, skip)).filter((x) => !(x.noTools && job.options.noToolsRestart));
            let stuck = await problems();
            while (stuck.length && stuck.every((x) => x.busy) && Date.now() < busyUntil) {
              step.detail = `waiting for ${listStuck(stuck)}`;
              save(job);
              await pause(BUSY_POLL_MS);
              stuck = await problems();
            }
            delete step.detail;
            if (stuck.length) {
              const why = stuck.some((x) => x.stale)
                ? " -- XenServer still lists an operation whose task has ended; restarting this host's toolstack clears it"
                : stuck.every((x) => x.busy)
                  ? ` -- still busy after ${Math.round(BUSY_WAIT_MS / 60000)} minutes`
                  : "";
              throw new Error(`its VMs cannot be moved to another host: ${listStuck(stuck)}${why}`);
            }
          }
          await retry(step, () => c.call("host.disable", h), transient);
          break;
        }
        case "vgpu-off":
          // Not interrupted by a stop: a VM half shut down is worse than one off.
          await vgpuOff(step, h);
          continue steps;
        case "vgpu-on": {
          const { started, failed } = await vgpuOn(h);
          end(step, "done", failed.length ? `${started} started; not started: ${failed.join(", ")}` : `${started} started`);
          continue steps;
        }
        case "evacuate": {
          const resident = await c.call<string[]>("host.get_resident_VMs", h);
          const running: string[] = [];
          for (const vm of resident) {
            const rec = await c.call<Record<string, unknown>>("VM.get_record", vm).catch(() => null);
            if (rec && !rec.is_control_domain && rec.power_state === "Running") running.push(vm);
          }
          for (const vm of running) if (!home.has(vm)) home.set(vm, h);
          // Without the VM Tools: shut down and started on another host first,
          // since XenServer cannot live-migrate them.
          const restarted = job.options.noToolsRestart ? await restartElsewhere(step, h) : [];
          // A stop cancels the evacuation -- XenServer rolls back the VM it is
          // moving -- unless VMs with a vGPU are among them: such a migration
          // is not interrupted, the job stops once the host is empty.
          const vgpus = (await vgpuFacts(await c.get())).vms.get(h)?.length ?? 0;
          const cancel = vgpus ? never : stopping;
          // VMs with a vGPU are migrated live once; one whose migration fails
          // is not tried live again (a failed vGPU migration can leave a VM
          // unable to migrate at all, seen in the field) but shut down and
          // started on another host -- then the rest is moved.
          const coldMoved: string[] = [];
          if (vgpus) {
            try {
              await c.stoppable(cancel, "Async.host.evacuate", EVACUATE_MS, h);
            } catch (err) {
              if (err instanceof StopRequested) throw err;
              for (const { vm, name } of (await vgpuFacts(await c.get())).vms.get(h) ?? []) {
                await coldMove(vm, name, null, step, h);
                coldMoved.push(name);
              }
              if (!coldMoved.length) throw err;
              job.notes.push(`Live migration of VMs with a vGPU off ${step.hostName} failed (${friendlyXapiError(err)}); shut down and started on another host instead: ${coldMoved.join(", ")}.`);
            }
          }
          // Another evacuate moves whatever the last one left behind -- unless
          // XenServer found no plan for all of them: then one by one.
          let attempts = 1;
          let oneByOne = "";
          try {
            ({ attempts } = await retry(step, () => c.stoppable(cancel, "Async.host.evacuate", EVACUATE_MS, h), (e) => movable(e) && !noRoom(e)));
          } catch (err) {
            if (!noRoom(err)) throw err;
            oneByOne = await moveOneByOne(step, h, cancel);
          }
          const moved = running.length - restarted.length;
          end(
            step,
            "done",
            (running.length ? `${moved} VM${moved === 1 ? "" : "s"} moved` : "no running VMs") +
              (restarted.length ? `; shut down and started on another host (no VM Tools): ${restarted.join(", ")}` : "") +
              (coldMoved.length ? `; vGPU migration failed, restarted on another host: ${coldMoved.join(", ")}` : "") +
              (oneByOne ? `; ${oneByOne}` : "") +
              after(attempts),
          );
          continue steps;
        }
        case "apply": {
          const { attempts } = await retry(step, () => c.task("Async.host.apply_updates", APPLY_MS, h, job.hash), transient);
          if (attempts > 1) step.detail = `done${after(attempts)}`;
          await followPending(step);
          break;
        }
        case "toolstack":
          await restartToolstack(step, h);
          await gpusReady(step, h);
          break;
        case "reboot": {
          const pool = (await c.call<string[]>("pool.get_all"))[0];
          const isCoordinator = (await c.call<string>("pool.get_master", pool)) === h;
          const metrics = await c.call<string>("host.get_metrics", h);
          if (round > 1) {
            // Tried again: the restart was asked for already -- only waited for, longer.
            await c.reconnect(Date.now() + UP_MS);
          } else {
          // The call itself may not return when the coordinator goes down.
          await c.call("host.reboot", h).catch(() => {});
          if (isCoordinator) {
            // Gone first, then back: login fails, then works again.
            const downBy = Date.now() + DOWN_MS;
            c.s = null;
            for (;;) {
              try {
                await c.get();
                await c.close();
                c.s = null;
                if (Date.now() > downBy) break; // never seen down; carry on
                await sleep(POLL_MS);
              } catch {
                break;
              }
            }
            await c.reconnect(Date.now() + UP_MS);
          } else {
            const downBy = Date.now() + DOWN_MS;
            while (Date.now() < downBy && (await c.call<boolean>("host_metrics.get_live", metrics).catch(() => true))) await sleep(POLL_MS);
          }
          }
          const upBy = Date.now() + UP_MS;
          while (!(await c.call<boolean>("host_metrics.get_live", await c.call<string>("host.get_metrics", h)).catch(() => false))) {
            if (Date.now() > upBy) throw new Error("The host did not come back after its restart");
            await sleep(POLL_MS);
          }
          await gpusReady(step, h);
          break;
        }
        case "enable":
          await enableHost(step, h);
          break;
        case "vms-back": {
          // This host's VMs, or for a pool every VM this job moved -- several
          // at once (MOVE_BACK_PARALLEL), those with a vGPU one at a time.
          const candidates = [...home].filter(([, from]) => !step.host || from === step.host);
          // Only what is still away counts: most of the VMs a pool's run moved
          // came back after their own host, and "22 of 360" would only mislead.
          const due: [string, string][] = [];
          for (let i = 0; i < candidates.length; i += 8) {
            const batch = await Promise.all(
              candidates.slice(i, i + 8).map(async ([vm, to]) => {
                if (gaveUp.has(vm)) return null;
                const [state, at] = await Promise.all([
                  c.call<string>("VM.get_power_state", vm).catch(() => ""),
                  c.call<string>("VM.get_resident_on", vm).catch(() => ""),
                ]);
                return state === "Running" && at !== to ? ([vm, to] as [string, string]) : null;
              }),
            );
            for (const x of batch) if (x) due.push(x);
          }
          const failed: string[] = [];
          let moved = 0;
          let settle: Promise<void> | null = null;
          let gpuTurn: Promise<unknown> = Promise.resolve();
          const stopHere = () => {
            step.detail = `${moved} moved back, then stopped`;
            return new StopRequested();
          };
          const progress = () => {
            step.detail = `${moved} of ${due.length} moved back`;
            save(job);
          };
          const oneVm = async (vm: string, to: string) => {
            if (stopping()) throw stopHere();
            if (gaveUp.has(vm)) return;
            const [state, at] = await Promise.all([
              c.call<string>("VM.get_power_state", vm).catch(() => ""),
              c.call<string>("VM.get_resident_on", vm).catch(() => ""),
            ]);
            if (state !== "Running" || at === to) return;
            if (!(await c.call<boolean>("host.get_enabled", to).catch(() => false))) return;
            // Once, before the first VM moves, for every VM.
            settle ??=
              SETTLE_MS > 0
                ? (async () => {
                    step.detail = "letting the restarted toolstacks settle";
                    save(job);
                    await pause(SETTLE_MS);
                  })()
                : Promise.resolve();
            await settle.catch(() => {
              throw stopHere();
            });
            if (stopping()) throw stopHere();
            // Moved by a restart -- no VM Tools, or a vGPU migration that failed -- it comes back the same way.
            if ((job.vgpuStopped ?? []).some((x) => x.vm === vm && (x.reason === "no-tools" || x.reason === "vgpu-failed"))) {
              const name = await c.call<string>("VM.get_name_label", vm).catch(() => vm);
              try {
                await shutDown(vm);
                try {
                  await c.task("Async.VM.start_on", START_MS, vm, to, false, false);
                } catch (err) {
                  // Never left off: wherever XenServer will have it, then.
                  await c.task("Async.VM.start", START_MS, vm, false, false);
                  throw err;
                }
                moved++;
                progress();
              } catch (err) {
                gaveUp.add(vm);
                failed.push(`${name} (${friendlyXapiError(err)})`);
              }
              return;
            }
            // A vGPU VM's migration is not interrupted by a stop.
            const vgpu = (await c.call<string[]>("VM.get_VGPUs", vm).catch(() => [] as string[])).length > 0;
            const name = await c.call<string>("VM.get_name_label", vm).catch(() => vm);
            const toName = await c.call<string>("host.get_name_label", to).catch(() => to);
            if (vgpu) {
              // One at a time. Once, live; failing that, not again live but by a restart on its host.
              const turn = gpuTurn.then(async () => {
                try {
                  await c.stoppable(never, "Async.VM.pool_migrate", MIGRATE_MS, vm, to, { live: "true" });
                  moved++;
                  progress();
                } catch (err) {
                  try {
                    await coldMove(vm, name, to, step);
                    moved++;
                    progress();
                    job.notes.push(`${name}'s migration back failed (${friendlyXapiError(err)}); it was shut down and started again on ${toName}.`);
                  } catch (e) {
                    gaveUp.add(vm);
                    failed.push(`${name} → ${toName} (${friendlyXapiError(e)})`);
                  }
                }
              });
              gpuTurn = turn.catch(() => {});
              await turn;
              return;
            }
            try {
              await retry(step, () => c.stoppable(stopping, "Async.VM.pool_migrate", MIGRATE_MS, vm, to, { live: "true" }), movable, `${name}: `);
              moved++;
              progress();
            } catch (err) {
              if (err instanceof StopRequested) throw stopHere();
              gaveUp.add(vm);
              failed.push(`${name} → ${toName} (${friendlyXapiError(err)})`);
            }
          };
          const queue = [...due];
          const worker = async () => {
            for (let next = queue.shift(); next; next = queue.shift()) await oneVm(next[0], next[1]);
          };
          await Promise.all(Array.from({ length: Math.min(MOVE_BACK_PARALLEL, queue.length) }, worker));
          end(
            step,
            "done",
            !due.length ? "nothing was still away" : failed.length ? `${moved} moved back; not moved: ${failed.join(", ")}` : `${moved} moved back`,
          );
          if (failed.length) {
            job.notes.push(`Some VMs could not be moved back and keep running where they are: ${failed.join(", ")}`);
          }
          continue steps;
        }
        case "refresh":
          try {
            await readPoolUpdates(job.hostId);
          } catch {
            // the list is a convenience; the update itself is done
          }
          break;
      }
      break;
      } catch (err) {
        const next = await onHostFailure(step, err, round);
        if (next === "again") continue;
        if (next === "skip") continue steps;
        throw err;
      }
      }
      end(step, "done");
      // A host skipped before, done now on its second try.
      if (step.kind === "enable") unresolved.delete(h);
      if (step.kind === "enable" || (step.kind === "apply" && !job.steps.some((x) => x.host === h && x.state === "todo"))) {
        onEvent("xen_update_host_done", "success", `host ${step.hostName}`);
      }
    }
    // A host left in maintenance mode for its restart keeps its VMs off.
    const off = leftOffNote(job);
    if (off) job.notes.push(off);
    if (unresolved.size) {
      // Per host still not done: why, the last time.
      const left = [...unresolved].map((h) => [...(job.skipped ?? [])].reverse().find((x) => x.host === h)!).filter(Boolean);
      job.state = "failed";
      job.error = `Not updated: ${left.map((x) => `${x.hostName} (${x.step}: ${x.error})`).join("; ")}. The other hosts were updated.`;
      job.finishedAt = new Date().toISOString();
      save(job);
      onEvent("xen_update_finished", "failure", `pool ${job.poolName}`, job.error);
      mailEnd();
      return;
    }
    job.state = "done";
    job.finishedAt = new Date().toISOString();
    save(job);
    onEvent("xen_update_finished", "success", `pool ${job.poolName}`, job.notes.join(" ") || undefined);
    mailEnd();
  } catch (err) {
    if (job.stopRequested) {
      await wrapUp(err).catch((e) => {
        job.state = "stopped";
        job.finishedAt = new Date().toISOString();
        job.notes.push(`Tidying up after the stop failed (${friendlyXapiError(e)}). Check the hosts: one may still be in maintenance mode.`);
        save(job);
      });
      return;
    }
    const running = job.steps.find((s) => s.state === "running");
    const message = friendlyXapiError(err);
    if (running) end(running, "failed", message);
    for (const s of job.steps) if (s.state === "todo") s.state = "skipped";
    job.state = "failed";
    // Failed while being emptied, before anything was installed: back in service.
    let restored = false;
    if (running?.host && ["maintenance", "vgpu-off", "evacuate"].includes(running.kind)) {
      const h = running.host;
      const installed = job.steps.some((x) => x.host === h && x.kind === "apply" && x.state === "done");
      const disabled = !(await c.call<boolean>("host.get_enabled", h).catch(() => true));
      if (!installed && disabled) {
        try {
          await enableHost({ ...running, id: crypto.randomUUID(), detail: undefined }, h);
          restored = true;
        } catch {
          // said below: it may still be in maintenance mode
        }
      }
    }
    const untouched = running?.kind === "maintenance" || restored;
    job.error = running?.hostName
      ? `${running.label} failed on ${running.hostName}: ${message}.${
          restored
            ? ` Nothing was installed on ${running.hostName}; it is back in service.`
            : untouched
              ? ` Nothing was changed on ${running.hostName}.`
              : " The host may still be in maintenance mode."
        }`
      : message;
    await startWhatCan().catch(() => {});
    job.finishedAt = new Date().toISOString();
    save(job);
    onEvent("xen_update_finished", "failure", `pool ${job.poolName}`, job.error);
    mailEnd();
  } finally {
    // However the job ended: Workload Balancing acts again, if this job paused it.
    if (job.wlbPaused) {
      try {
        const [p] = await c.call<string[]>("pool.get_all");
        await c.call("pool.set_wlb_enabled", p, true);
        job.wlbPaused = false;
        onEvent("xen_update_wlb", "success", `pool ${job.poolName}`, "Workload Balancing resumed after the update");
      } catch (e) {
        job.notes.push(`Workload Balancing, paused for this update, could not be resumed (${friendlyXapiError(e)}). Resume it in the pool's WLB tab.`);
        onEvent("xen_update_wlb", "failure", `pool ${job.poolName}`, `Workload Balancing not resumed: ${friendlyXapiError(e)}`);
      }
      save(job);
    }
    await c.close();
  }
}

/**
 * Workload Balancing that an update paused and never got to resume -- XenMan
 * restarted under it. Called once at start, so WLB does not stay paused for
 * good without anyone noticing.
 */
export async function resumeWlbLeftPaused(): Promise<void> {
  for (const job of listJobs()) {
    if (!job.wlbPaused || job.state === "running") continue;
    let s: PoolSession | null = null;
    try {
      s = await openPoolSession(job.hostId);
      const [p] = await call<string[]>(s, "pool.get_all");
      await call(s, "pool.set_wlb_enabled", p, true);
      job.wlbPaused = false;
      job.notes.push("Workload Balancing, paused for this update, was resumed when XenMan started again.");
    } catch (e) {
      const note = `Workload Balancing, paused for this update, is still paused (${friendlyXapiError(e)}). Resume it in the pool's WLB tab.`;
      if (!job.notes.includes(note)) job.notes.push(note);
    } finally {
      if (s) await closePoolSession(s).catch(() => {});
    }
    save(job);
  }
}
