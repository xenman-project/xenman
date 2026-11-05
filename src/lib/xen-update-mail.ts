// The mail to the administrators once a XenServer update has ended -- finished,
// failed or stopped -- so whoever started it need not keep watching. Short:
// what came of it, the hosts where something did not go through, and what
// someone should know or do. Every step stays in XenMan, behind the link.

import { sendMail, smtpConfigured } from "./mailer";
import { adminRecipients } from "./os-alerts";
import { hardNote, type Job, type JobStep } from "./xen-update-jobs";
import { formatDateTime } from "./date-format";
import { serverDateFormat } from "./display-settings";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const OUTCOME: Partial<Record<Job["state"], string>> = {
  done: "finished",
  failed: "failed",
  stopped: "was stopped",
};

const MARK: Record<JobStep["state"], string> = { done: "✓", failed: "✗", skipped: "–", running: "…", todo: "·" };

function duration(job: Job): string {
  const ms = Date.parse(job.finishedAt ?? "") - Date.parse(job.createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Steps grouped by host, in the order they ran. */
function groups(job: Job): { name: string; host: boolean; steps: JobStep[] }[] {
  const out: { name: string; host: boolean; steps: JobStep[] }[] = [];
  for (const s of job.steps) {
    const name = s.hostName ?? "Pool";
    const last = out[out.length - 1];
    if (last && last.name === name) last.steps.push(s);
    else out.push({ name, host: s.host !== null, steps: [s] });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line for the hosts that went through: how many, with how many updates, restarted or not. */
function summary(job: Job, hosts: { name: string; steps: JobStep[] }[], ok: { name: string; steps: JobStep[] }[]): string {
  if (!hosts.length) return "";
  if (!ok.length) return `No host was updated (of ${hosts.length}).`;
  const counts = new Set(
    ok.map((g) => Number(/(\d+) update/.exec(g.steps.find((s) => s.kind === "apply")?.label ?? "")?.[1] ?? 0)).filter((n) => n > 0),
  );
  const each = counts.size === 1 ? [...counts][0] : null;
  const restarted = ok.filter((g) => g.steps.some((s) => s.kind === "reboot" && s.state === "done")).length;
  const back = job.steps.some((s) => s.kind === "vms-back" && s.state === "done");
  const who = ok.length === hosts.length ? (hosts.length === 1 ? ok[0].name : plural(hosts.length, "host")) : `${ok.length} of ${hosts.length} hosts`;
  return [
    `${who} updated`,
    each ? ` (${hosts.length === 1 ? plural(each, "update") : `${plural(each, "update")} each`})` : "",
    restarted === ok.length ? ", restarted" : restarted ? `, ${restarted} restarted` : "",
    back ? "; VMs moved back" : "",
    ".",
  ].join("");
}

/** What someone should know or do: VMs that had an outage or are still off, and what went wrong on the way. */
function toNote(job: Job): string[] {
  const vms = job.vgpuStopped ?? [];
  const out: string[] = [];
  const noTools = vms.filter((x) => x.reason === "no-tools" && x.started);
  if (noTools.length) {
    const hard = noTools.filter((x) => x.hard);
    out.push(
      `Without VM Tools, so shut down and started again on another host (a short outage each): ${noTools.map((x) => x.name).join(", ")}.` +
        (hard.length === noTools.length
          ? " None shut down by itself; all were switched off the hard way."
          : hard.length
            ? ` Switched off the hard way, as they did not shut down by themselves: ${hard.map((x) => x.name).join(", ")}.`
            : ""),
    );
  }
  const vgpu = vms.filter((x) => (x.reason ?? "vgpu") === "vgpu" && x.started);
  if (vgpu.length) out.push(`With a vGPU, shut down for the update and started again: ${vgpu.map((x) => x.name).join(", ")}.`);
  // The notes from the run -- among them the VMs still switched off --, not the
  // plan's warnings (known before it started), nor what is said above already.
  const said = new Set(vms.filter((x) => x.hard).map((x) => hardNote(x.name)));
  return [...out, ...job.notes.slice(job.planNotes ?? 0).filter((n) => !said.has(n))];
}

export function jobMail(job: Job): { subject: string; text: string; html: string } {
  const outcome = OUTCOME[job.state] ?? job.state;
  const subject = `XenMan: update of pool ${job.poolName} ${outcome}`;
  // In the date format set under Settings, in the appliance's time zone.
  const fmt = serverDateFormat();
  const when = `Started by ${job.by} on ${formatDateTime(job.createdAt, fmt)}${
    job.finishedAt ? `, ended ${formatDateTime(job.finishedAt, fmt)} (${duration(job)})` : ""
  }.`;
  const head =
    job.state === "stopped" && job.stopRequested
      ? `The update of pool ${job.poolName} was stopped by ${job.stopRequested.by}.`
      : `The update of pool ${job.poolName} ${outcome}.`;

  const all = groups(job);
  const hosts = all.filter((g) => g.host);
  const ok = hosts.filter((g) => g.steps.every((s) => s.state === "done"));
  // Only where something did not go through, with only those steps.
  const open = all.filter((g) => g.steps.some((s) => s.state !== "done")).map((g) => ({ ...g, steps: g.steps.filter((s) => s.state !== "done") }));
  const line = summary(job, hosts, ok);
  const notes = toNote(job);

  const text = [
    head,
    when,
    "",
    ...(line ? [line, ""] : []),
    ...open.flatMap((g) => [g.name, ...g.steps.map((s) => `  ${MARK[s.state]} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`), ""]),
    ...(job.error ? [`Error: ${job.error}`, ""] : []),
    ...(notes.length ? ["To note:", ...notes.map((n) => `  - ${n}`), ""] : []),
    ...(job.link ? [`Every step in XenMan: ${job.link}`] : []),
  ].join("\n");

  const color = job.state === "done" ? "#15803d" : job.state === "failed" ? "#b91c1c" : "#b45309";
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#18181b">
<p style="font-size:16px;font-weight:600;color:${color};margin:0 0 4px">${esc(head)}</p>
<p style="color:#71717a;margin:0 0 16px">${esc(when)}</p>
${line ? `<p style="margin:0 0 12px">${esc(line)}</p>` : ""}
${open
  .map(
    (g) => `<p style="font-weight:600;margin:12px 0 4px">${esc(g.name)}</p><ul style="list-style:none;padding-left:0;margin:0">${g.steps
      .map(
        (s) =>
          `<li style="margin:2px 0;color:${s.state === "failed" ? "#b91c1c" : "#71717a"}">${MARK[s.state]} ${esc(s.label)}${
            s.detail ? `<span style="color:#71717a"> — ${esc(s.detail)}</span>` : ""
          }</li>`,
      )
      .join("")}</ul>`,
  )
  .join("\n")}
${job.error ? `<p style="margin:16px 0 0;padding:8px;border:1px solid #fecaca;background:#fef2f2">${esc(job.error)}</p>` : ""}
${notes.length ? `<p style="font-weight:600;margin:16px 0 4px">To note</p><ul style="margin:0">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
${job.link ? `<p style="margin:16px 0 0"><a href="${esc(job.link)}">Every step in XenMan</a></p>` : ""}
</div>`;
  return { subject, text, html };
}

/** Sends it; what came of it, for the audit log. Never throws. */
export async function mailJobEnded(job: Job): Promise<{ sent: boolean; detail: string }> {
  const to = adminRecipients();
  if (!smtpConfigured()) return { sent: false, detail: "not sent: no mail server is set up" };
  if (!to.length) return { sent: false, detail: "not sent: no administrator has an email address" };
  try {
    await sendMail({ to, ...jobMail(job) });
    return { sent: true, detail: `sent to ${to.length} administrator${to.length === 1 ? "" : "s"}` };
  } catch (err) {
    return { sent: false, detail: `not sent: ${err instanceof Error ? err.message : "mail server error"}` };
  }
}
