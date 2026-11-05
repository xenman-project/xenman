"use client";

import { useEffect, useRef, useState } from "react";
import type { HostConnection } from "@/lib/types";
import type { PoolMemberJob } from "@/lib/pool-membership-job";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmNameDialog } from "@/components/networking/confirm-name";
import { xenNet } from "@/components/networking/host-networking";
import { MemberJobView } from "./add-server-dialog";

// XenCenter's Remove From Pool (RemoveHostFromPoolCommand): its question, and
// -- XenMan's own -- the server's name typed, as its local storage is wiped.
// Then a job (lib/pool-membership-job.ts); at its end the server is a
// connection of its own (onDone gets its id).

/** RemoveHostFromPoolCommand.GetCantRunReasonCore, for the menu. */
export function removeBlockedReason(conn: HostConnection, hostRef: string): string | null {
  const pool = Object.values(conn.pools)[0];
  const h = conn.hostRecords[hostRef];
  if (!h || !pool) return null;
  if (pool.master === hostRef) return "You cannot remove the coordinator from the pool.";
  if (h.residentVMs.length > 1) return "This server has running VMs";
  return null;
}

export function RemoveServerDialog({
  conn,
  hostRef,
  hostName: name,
  poolName,
  onClose,
  onDone,
}: {
  conn: HostConnection;
  hostRef: string;
  /** As they were when it opened: the server leaves the pool meanwhile. */
  hostName: string;
  poolName: string;
  onClose: () => void;
  onDone: (newHostId: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<PoolMemberJob | null>(null);

  async function remove(typed: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await xenNet(conn, { action: "pool_remove_server", hostRef, confirmName: typed });
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
        if (res.job.state !== "running") doneRef.current(res.job.newHostId);
      } catch {
        // The next poll may get through.
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [conn, jobId, running]);

  if (!job) {
    return (
      <ConfirmNameDialog
        title="Remove Server from Pool"
        message={`Do you want to remove '${name}' from pool '${poolName}'?\n\nThis will permanently delete and reinitialize all local storage on '${name}'. Your data will be lost, and the server will be rebooted. If Active Directory is configured for pool '${poolName}', the server will be removed from the domain.`}
        confirmName={name}
        what="server's name"
        actionLabel="Remove From Pool"
        busy={busy}
        error={error}
        onConfirm={(typed) => void remove(typed)}
        onCancel={onClose}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Removing server &apos;{name}&apos; from pool &apos;{poolName}&apos;</DialogTitle>
        </DialogHeader>
        <MemberJobView job={job} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
