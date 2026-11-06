"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronUp, Loader2, XCircle } from "lucide-react";
import type { LicenseIcon, LicenseRow } from "@/lib/xen-licensing";
import { useXen } from "@/context/xen-context";
import { useAuth } from "@/context/auth-context";
import { Input } from "@/components/ui/input";
import { useDateFormat } from "@/context/date-format-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { xenNet } from "@/components/networking/host-networking";

// XenCenter's License Manager (Tools > License Manager...): every pool with its
// licence and status, the one highlighted summarised on the right, texts as
// XenCenter's. Assign License (admins) applies the licence server to the checked
// pools; Release License sets them to the trial edition, as XenCenter 8 does.

interface Entry {
  id: string;
  name: string;
  connected: boolean;
  row: LicenseRow | null;
  error: string | null;
  ha: boolean;
}

function Icon({ kind, className = "h-4 w-4" }: { kind: LicenseIcon; className?: string }) {
  if (kind === "ok") return <CheckCircle2 className={`${className} text-emerald-600`} />;
  if (kind === "warning") return <AlertTriangle className={`${className} text-amber-500`} />;
  return <XCircle className={`${className} text-destructive`} />;
}

/** "February 9, 2028" (DATEFORMAT_DMY_LONG), in the date format set under Settings. */
function longDate(iso: string, fmt: string): string {
  const d = new Date(iso);
  if (fmt === "iso") return d.toISOString().slice(0, 10);
  return d.toLocaleDateString(fmt === "de-DE" ? "de-DE" : "en-US", { day: "numeric", month: "long", year: "numeric" });
}

export function LicenseManagerDialog({ onClose }: { onClose: () => void }) {
  const { state } = useXen();
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { format } = useDateFormat();
  const [rows, setRows] = useState<Record<string, { row: LicenseRow | null; error: string | null; ha: boolean }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [failure, setFailure] = useState<{ text: string; details: string[] } | null>(null);

  // Each pool's licence, read when the window opens, and again after a change.
  const readPool = useCallback(
    (id: string) => {
      const conn = state.connections[id];
      if (!conn) return Promise.resolve();
      return xenNet(conn, { action: "license_overview" })
        .then((res) => setRows((r) => ({ ...r, [id]: { row: res.row, error: null, ha: Boolean(res.ha) } })))
        .catch((e) => setRows((r) => ({ ...r, [id]: { row: null, error: e instanceof Error ? e.message : String(e), ha: false } })));
    },
    [state.connections],
  );
  const connected = useMemo(
    () => state.hosts.filter((h) => state.connections[h.id]?.status === "connected").map((h) => h.id),
    [state.hosts, state.connections],
  );
  const key = connected.join();
  useEffect(() => {
    for (const id of key ? key.split(",") : []) void readPool(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again only when other pools connect
  }, [key]);

  // LicenseManagerController.UpdateButtonEnablement: the checked pools, connected, without HA.
  const haBlocked = checked.some((id) => rows[id]?.ha);
  const canAssign = isAdmin && checked.length > 0 && checked.every((id) => connected.includes(id)) && !haBlocked;

  // ReleaseLicenses: only where a licence server is in use, or the pool is partially licensed.
  const canRelease =
    canAssign && checked.some((id) => rows[id]?.row?.usesLicenseServer || rows[id]?.row?.status.startsWith("Partially Licensed"));
  const [confirmRelease, setConfirmRelease] = useState(false);

  /** ApplyLicenseEditionAction over the checked pools, one after the other ("Updating Licenses"). */
  async function assign(licenseServer: string | null) {
    setAssignOpen(false);
    setConfirmRelease(false);
    setUpdating(true);
    const failed: string[] = [];
    for (const id of checked) {
      const conn = state.connections[id];
      if (!conn) continue;
      try {
        await xenNet(conn, licenseServer === null ? { action: "license_release", confirmRelease: true } : { action: "license_assign", licenseServer });
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e));
      }
      await readPool(id);
    }
    setUpdating(false);
    if (failed.length) {
      setFailure({
        text: failed.length === 1 && checked.length === 1 ? failed[0].split(". ")[0] + "." : `The licensing action failed for ${failed.length} out of ${checked.length} of the selected servers.`,
        details: failed,
      });
    }
  }

  const entries: Entry[] = state.hosts
    .map((h) => {
      const conn = state.connections[h.id];
      const pool = conn ? Object.values(conn.pools)[0] : undefined;
      return {
        id: h.id,
        name: pool?.nameLabel || h.name || h.address,
        connected: conn?.status === "connected",
        row: rows[h.id]?.row ?? null,
        error: rows[h.id]?.error ?? null,
        ha: rows[h.id]?.ha ?? false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const current = entries.find((e) => e.id === (selected ?? entries[0]?.id));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>License Manager</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 p-4 md:h-[min(520px,calc(100dvh-14rem))] md:flex-row">
          {/* The pools. */}
          <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b text-left">
                  <th className="w-8 px-2 py-1.5" />
                  <th className="px-2 py-1.5 font-normal">
                    <span className="inline-flex items-center gap-1">
                      Pool/Host <ChevronUp className="h-3 w-3" />
                    </span>
                  </th>
                  <th className="px-2 py-1.5 font-normal">License</th>
                  <th className="px-2 py-1.5 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const active = e.id === current?.id;
                  return (
                    <tr
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                      className={`cursor-pointer border-b last:border-b-0 ${active ? "bg-primary text-primary-foreground" : "hover:bg-accent"} ${e.connected ? "" : "opacity-60"}`}
                    >
                      <td className="px-2 py-1.5" onClick={(ev) => ev.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          disabled={!e.connected}
                          checked={checked.includes(e.id)}
                          onChange={(ev) => setChecked((c) => (ev.target.checked ? [...c, e.id] : c.filter((x) => x !== e.id)))}
                        />
                      </td>
                      <td className="px-2 py-1.5">{e.name}</td>
                      <td className="px-2 py-1.5">{e.connected ? (e.row?.license ?? "") : "Unknown"}</td>
                      <td className="px-2 py-1.5">
                        {!e.connected ? (
                          "Unknown"
                        ) : e.row ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Icon kind={e.row.icon} />
                            {e.row.status}
                          </span>
                        ) : e.error ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Icon kind="error" />
                            {e.error}
                          </span>
                        ) : (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* The summary of the highlighted one. */}
          <div className="min-w-0 space-y-4 overflow-auto rounded-md border p-4 text-sm md:w-72 md:shrink-0">
            {current && (
              <>
                <p className="font-semibold">{current.name}</p>
                {!current.connected ? (
                  <p>Pool or host is not connected</p>
                ) : !current.row ? (
                  current.error ? <p className="text-destructive">{current.error}</p> : <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Summary label="License Type:">{current.row.license}</Summary>
                    {current.row.mode && <Summary label="Licensing Mode:">{current.row.mode}</Summary>}
                    {(current.row.expiry || current.row.expiryNever) && (
                      <Summary label="Entitlement valid until:">
                        {current.row.expiryNever ? "Never" : longDate(current.row.expiry!, format)}
                      </Summary>
                    )}
                    {current.row.licenseServer && (
                      <Summary label="License Server:">
                        {current.row.licenseServer.link ? (
                          <a href={current.row.licenseServer.link} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                            {current.row.licenseServer.text}
                          </a>
                        ) : (
                          current.row.licenseServer.text
                        )}
                      </Summary>
                    )}
                    <div className="space-y-2">
                      <p className="flex items-start gap-2">
                        <Icon kind={current.row.licenseIcon} className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="font-medium">
                          {current.row.licenseLines.map((l, i) => (
                            <span key={i} className="block">
                              {l}
                            </span>
                          ))}
                        </span>
                      </p>
                      {current.row.supportLines && (
                        <p className="flex items-start gap-2">
                          <Icon kind={current.row.supportIcon} className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>
                            <span className="block font-medium">{current.row.supportLines[0]}</span>
                            {current.row.supportLines.slice(1).map((l, i) => (
                              <span key={i} className="block text-muted-foreground">
                                {l}
                              </span>
                            ))}
                          </span>
                        </p>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-3 sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={!canAssign || updating} onClick={() => setAssignOpen(true)}>
              Assign License
            </Button>
            <Button variant="outline" disabled={!canRelease || updating} onClick={() => setConfirmRelease(true)}>
              Release License
            </Button>
            {haBlocked && <span className="text-xs text-amber-700 dark:text-amber-400">The license for a host cannot be changed when HA is on</span>}
          </div>
          <Button variant="outline" disabled={updating} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>

        {assignOpen && <ApplyLicenseDialog onCancel={() => setAssignOpen(false)} onOk={(server) => void assign(server)} />}

        {/* XenMan asks first: XenCenter releases at once. */}
        <Dialog open={confirmRelease} onOpenChange={(o) => !o && setConfirmRelease(false)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Release License
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p>Release the license of these pools? They then run as XenServer Trial Edition until a license is assigned again.</p>
              <ul className="list-disc pl-5">
                {entries
                  .filter((e) => checked.includes(e.id))
                  .map((e) => (
                    <li key={e.id}>{e.name}</li>
                  ))}
              </ul>
            </div>
            <DialogFooter>
              <Button variant="destructive" onClick={() => void assign(null)}>
                Release License
              </Button>
              <Button variant="outline" onClick={() => setConfirmRelease(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ActionProgressDialog: "Updating Licenses". */}
        <Dialog open={updating}>
          <DialogContent className="sm:max-w-sm [&>button]:hidden">
            <DialogHeader>
              <DialogTitle>XenMan</DialogTitle>
            </DialogHeader>
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Updating Licenses
            </p>
          </DialogContent>
        </Dialog>

        {/* CommandErrorDialog: what failed. */}
        <Dialog open={failure !== null} onOpenChange={(o) => !o && setFailure(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <XCircle className="h-5 w-5 text-destructive" />
                License Manager
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p>{failure?.text}</p>
              {failure?.details.map((d, i) => (
                <p key={i} className="text-muted-foreground">
                  {d}
                </p>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFailure(null)}>
                OK
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

/** XenCenter's Apply License: the licence server only, OK once one is entered. */
function ApplyLicenseDialog({ onOk, onCancel }: { onOk: (server: string) => void; onCancel: () => void }) {
  const [server, setServer] = useState("");
  const valid = /^[\w.-]{1,253}$/.test(server.trim());
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Apply License</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onOk(server.trim());
          }}
        >
          <p>To assign a new license to the servers you selected, enter the details, and then click OK.</p>
          <label className="flex items-center gap-3">
            <span className="shrink-0">License Server:</span>
            <Input autoFocus value={server} onChange={(e) => setServer(e.target.value)} placeholder="Examples: licenses.domain.com, 192.168.1.100" />
          </label>
          <DialogFooter>
            <Button type="submit" disabled={!valid}>
              OK
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Summary({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p>{label}</p>
      <p>{children}</p>
    </div>
  );
}
