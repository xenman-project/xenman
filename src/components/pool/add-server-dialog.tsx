"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { JoinVerdict } from "@/lib/pool-join-rules";
import type { PoolMemberJob } from "@/lib/pool-membership-job";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { CertConfirm, type ProbedCertificate } from "@/components/host-trust";
import { xenNet } from "@/components/networking/host-networking";

// XenCenter's Add New Server to a pool (AddServerDialog, AddNewHostToPoolCommand,
// AddHostToPoolCommand), texts as XenCenter's. XenMan adds the certificate
// check it does for every new server, and the join runs as a job
// (lib/pool-membership-job.ts).

export function AddServerDialog({
  conn,
  poolName,
  onClose,
  onDone,
}: {
  conn: HostConnection;
  poolName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [cert, setCert] = useState<ProbedCertificate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ name: string; reason: string } | null>(null);
  const [cpuQuestion, setCpuQuestion] = useState<string | null>(null);
  const [job, setJob] = useState<PoolMemberJob | null>(null);

  const server = address.trim();
  const body = { address: server, username, password, fingerprint: cert?.fingerprint };

  // Another address: its certificate is checked again.
  const edit = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setError(null);
  };

  async function probe() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "probe", address: server, port: 443 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "No answer");
      setCert(json.certificate);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function add(confirmCpu: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (!confirmCpu) {
        // AddHostToPoolCommand: PoolJoinRules first, then XenCenter's questions.
        const res = await xenNet(conn, { action: "pool_add_server_check", ...body });
        const verdict: JoinVerdict = res.verdict;
        if (verdict.reason) {
          setRefused({ name: verdict.name || server, reason: verdict.reason });
          return;
        }
        if (verdict.cpuQuestion) {
          setCpuQuestion(verdict.cpuQuestion);
          return;
        }
      }
      const res = await xenNet(conn, { action: "pool_add_server", ...body, confirmCpu });
      setCpuQuestion(null);
      setJob(res.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // The job, until it is over.
  const jobId = job?.id;
  const running = job?.state === "running";
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  useEffect(() => {
    if (!jobId || !running) return;
    const timer = setInterval(async () => {
      try {
        const res = await xenNet(conn, { action: "pool_member_job_status", jobId });
        setJob(res.job);
        if (res.job.state !== "running") doneRef.current();
      } catch {
        // The next poll may get through.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [conn, jobId, running]);

  const canSubmit = Boolean(server && username && password) && !busy;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add New Server</DialogTitle>
        </DialogHeader>

        {job ? (
          <MemberJobView job={job} />
        ) : (
          <div className="space-y-4 text-sm">
            <p>Enter the host name or IP address of the server you want to add and your user login credentials for that server.</p>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
              <Label htmlFor="add-server">Server:</Label>
              <Input
                id="add-server"
                value={address}
                autoFocus
                onChange={(e) => {
                  edit(setAddress)(e);
                  setCert(null);
                }}
              />
            </div>
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-xs text-muted-foreground">User login credentials</legend>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
                <Label htmlFor="add-user">Username:</Label>
                <Input id="add-user" value={username} autoComplete="off" onChange={edit(setUsername)} />
                <Label htmlFor="add-password">Password:</Label>
                <Input id="add-password" type="password" value={password} autoComplete="new-password" onChange={edit(setPassword)} />
              </div>
            </fieldset>
            {cert && <CertConfirm cert={cert} address={server} />}
            {error && (
              <p className="flex items-start gap-2 whitespace-pre-line text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {job ? (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button disabled={!canSubmit} onClick={() => (cert ? void add(false) : void probe())}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {cert ? "Compared – add" : "Add"}
              </Button>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            </>
          )}
        </DialogFooter>

        {/* CommandErrorDialog: why it may not join. */}
        <AlertDialog open={refused !== null} onOpenChange={(o) => !o && setRefused(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <XCircle className="h-5 w-5 text-destructive" />
                Error Adding Server to Pool
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>The following servers could not be added to the pool &apos;{poolName}&apos;:</p>
                  <p>
                    <span className="font-medium text-foreground">{refused?.name}</span>: {refused?.reason}
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>OK</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* GetPermissionForCpuFeatureLevelling: Yes / No. */}
        <AlertDialog open={cpuQuestion !== null} onOpenChange={(o) => !o && !busy && setCpuQuestion(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Add New Server
              </AlertDialogTitle>
              <AlertDialogDescription className="whitespace-pre-line">{`${cpuQuestion ?? ""}\n\nDo you want to do this?`}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button disabled={busy} onClick={() => void add(true)}>
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

/** The steps of adding or removing a server. */
export function MemberJobView({ job }: { job: PoolMemberJob }) {
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
  const what = job.kind === "add" ? "Adding to pool" : "Removing from pool";
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">
        {job.state === "running" ? what : job.state === "done" ? (job.kind === "add" ? "Added to pool" : "Removed from pool") : `${what} failed`}
      </p>
      <ul className="space-y-2">
        {job.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5">{icon(s.state)}</span>
            <span>
              {s.label}
              {s.detail && <span className={`block text-xs ${s.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{s.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      {job.state === "failed" && job.error && !job.steps.some((s) => s.state === "failed") && <p className="text-destructive">{job.error}</p>}
      {job.state === "running" && <p className="text-xs text-muted-foreground">This goes on in XenMan even if you close the window.</p>}
    </div>
  );
}
