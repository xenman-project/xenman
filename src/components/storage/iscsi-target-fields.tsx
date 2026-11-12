"use client";

// The iSCSI part of Add Storage Repository, as XenCenter's New Storage wizard
// (Frontends/LVMoISCSI.cs): target host and port, CHAP, "Scan Target Host" for
// the IQNs, the LUNs behind the IQN chosen -- picked from lists rather than
// typed. Then, on Create, what is on the LUN (IscsiLunDialog): reattach the SR
// found there, or format the LUN.

import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { IscsiIqn, IscsiLun, ProbeOutcome } from "@/lib/sr-iscsi";

type Field = "host" | "chap" | "lun" | null;

export interface IscsiState {
  target: string;
  port: string;
  useChap: boolean;
  chapUser: string;
  chapPassword: string;
  iqns: IscsiIqn[] | null;
  /** The chosen IQN entry, by its place in the list ("" for none). */
  iqn: string;
  luns: IscsiLun[] | null;
  /** The chosen LUN, by its place in the list ("" for none). */
  lun: string;
  busy: "iqns" | "luns" | null;
  error: { field: Field; text: string } | null;
}

export const EMPTY_ISCSI: IscsiState = {
  target: "",
  port: "3260",
  useChap: false,
  chapUser: "",
  chapPassword: "",
  iqns: null,
  iqn: "",
  luns: null,
  lun: "",
  busy: null,
  error: null,
};

type Call = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The error of a call, with the field it belongs to when the server says so. */
class FieldError extends Error {
  constructor(
    message: string,
    readonly field: Field,
  ) {
    super(message);
  }
}

/** Target and CHAP as the scans and the create send them. */
function chapOf(s: IscsiState): Record<string, string> {
  return s.useChap && s.chapUser.trim() ? { chapuser: s.chapUser.trim(), chappassword: s.chapPassword } : {};
}

const chosenIqn = (s: IscsiState) => (s.iqns && s.iqn !== "" ? s.iqns[Number(s.iqn)] ?? null : null);
const chosenLun = (s: IscsiState) => (s.luns && s.lun !== "" ? s.luns[Number(s.lun)] ?? null : null);

/** What the server needs for the LUN chosen: target and port of the IQN entry (multi-homing), IQN, LUN. */
export function iscsiRequest(s: IscsiState): Record<string, unknown> | null {
  const iqn = chosenIqn(s);
  const lun = chosenLun(s);
  if (!iqn || !lun) return null;
  return {
    target: iqn.address,
    iscsiPort: iqn.port,
    targetIQN: iqn.iqn,
    ...(lun.lunId === -1 ? { lunSerial: lun.serial } : { scsiId: lun.scsiId }),
    ...chapOf(s),
  };
}

/** XenCenter's description when none is given: "iSCSI SR [address (IQN; LUN)]". */
export function iscsiDescription(s: IscsiState): string {
  const iqn = chosenIqn(s);
  const lun = chosenLun(s);
  return iqn && lun ? `iSCSI SR [${iqn.address} (${iqn.iqn}; ${lun.label})]` : "";
}

export function iscsiReady(s: IscsiState): boolean {
  const lun = chosenLun(s);
  return !!lun && !lun.inUse && !s.busy;
}

export function IscsiTargetFields({ state, setState, call }: { state: IscsiState; setState: (f: (s: IscsiState) => IscsiState) => void; call: Call }) {
  const s = state;
  // Host or CHAP changed: what was scanned is not valid any more (LVMoISCSI's ...Changed handlers).
  const edit = (patch: Partial<IscsiState>) => setState((x) => ({ ...x, ...patch, iqns: null, iqn: "", luns: null, lun: "", error: null }));

  const run = async (body: Record<string, unknown>) => {
    try {
      return await call(body);
    } catch (e) {
      const err = e as Error & { field?: Field };
      throw new FieldError(err.message, err.field ?? null);
    }
  };

  const scanLuns = async (iqns: IscsiIqn[], index: string) => {
    const iqn = iqns[Number(index)];
    setState((x) => ({ ...x, iqn: index, luns: null, lun: "", busy: "luns", error: null }));
    try {
      const d = await run({ action: "sr_iscsi_scan_luns", target: iqn.address, iscsiPort: iqn.port, targetIQN: iqn.iqn, ...chapOf(s) });
      const luns = (d.luns as IscsiLun[]) ?? [];
      // One LUN only: chosen already.
      setState((x) => ({ ...x, luns, lun: luns.length === 1 ? "0" : "", busy: null }));
    } catch (e) {
      const err = e as FieldError;
      setState((x) => ({ ...x, busy: null, error: { field: err.field, text: err.message } }));
    }
  };

  const scanIqns = async () => {
    setState((x) => ({ ...x, iqns: null, iqn: "", luns: null, lun: "", busy: "iqns", error: null }));
    try {
      const d = await run({ action: "sr_iscsi_scan_iqns", target: s.target.trim(), iscsiPort: s.port.trim(), ...chapOf(s) });
      const iqns = (d.iqns as IscsiIqn[]) ?? [];
      setState((x) => ({ ...x, iqns, busy: null }));
      // One IQN only: chosen, and its LUNs scanned straight away.
      if (iqns.length === 1) await scanLuns(iqns, "0");
    } catch (e) {
      const err = e as FieldError;
      setState((x) => ({ ...x, busy: null, error: { field: err.field, text: err.message } }));
    }
  };

  const lun = chosenLun(s);
  const errorAt = (f: Field) => (s.error && s.error.field === f ? <p className="text-xs text-red-500">{s.error.text}</p> : null);

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
        <div className="grid gap-2">
          <Label htmlFor="iscsi-target">Target host name/IP address</Label>
          <Input id="iscsi-target" value={s.target} onChange={(e) => edit({ target: e.target.value })} placeholder="192.168.1.100" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="iscsi-port">Port</Label>
          <Input id="iscsi-port" value={s.port} onChange={(e) => setState((x) => ({ ...x, port: e.target.value }))} placeholder="3260" />
        </div>
      </div>
      {errorAt("host")}

      <div className="flex items-center gap-2">
        <Switch id="iscsi-chap" checked={s.useChap} onCheckedChange={(v) => edit({ useChap: v })} />
        <Label htmlFor="iscsi-chap" className="cursor-pointer">
          Use CHAP authentication
        </Label>
      </div>
      {s.useChap && (
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor="iscsi-chap-user">CHAP username</Label>
            <Input id="iscsi-chap-user" autoComplete="off" value={s.chapUser} onChange={(e) => edit({ chapUser: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="iscsi-chap-pw">CHAP password</Label>
            <Input id="iscsi-chap-pw" type="password" autoComplete="new-password" value={s.chapPassword} onChange={(e) => edit({ chapPassword: e.target.value })} />
          </div>
        </div>
      )}
      {errorAt("chap")}

      <div>
        <Button type="button" variant="outline" size="sm" disabled={!s.target.trim() || !!s.busy} onClick={scanIqns}>
          {s.busy === "iqns" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
          Scan Target Host
        </Button>
      </div>

      <div className="grid gap-2">
        <Label>Target IQN</Label>
        <Select value={s.iqn} disabled={!s.iqns?.length || !!s.busy} onValueChange={(v) => s.iqns && scanLuns(s.iqns, v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select target IQN" />
          </SelectTrigger>
          <SelectContent>
            {(s.iqns ?? []).map((q, i) => (
              <SelectItem key={i} value={String(i)}>
                {q.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label className="flex items-center gap-2">
          Target LUN {s.busy === "luns" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </Label>
        <Select value={s.lun} disabled={!s.luns?.length || !!s.busy} onValueChange={(v) => setState((x) => ({ ...x, lun: v, error: null }))}>
          <SelectTrigger>
            <SelectValue placeholder="Select target LUN" />
          </SelectTrigger>
          <SelectContent>
            {(s.luns ?? []).map((l, i) => (
              <SelectItem key={i} value={String(i)}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {lun?.inUse && <p className="text-xs text-red-500">{lun.inUse}</p>}
      </div>
      {errorAt("lun")}
      {s.error && s.error.field === null && <p className="text-xs text-red-500">{s.error.text}</p>}
    </div>
  );
}

/** Util.DiskSizeString, for the SR found on a LUN. */
function size(bytes: number): string {
  const units: [number, string][] = [
    [1024 ** 4, "TB"],
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
    [1024, "kB"],
  ];
  for (const [n, unit] of units) if (bytes >= n) return `${Math.round((bytes / n) * 10) / 10} ${unit}`;
  return `${bytes} B`;
}

/**
 * LVMoIsciWarningDialog: what is on the LUN, and what to do with it -- reattach
 * the SR found there, or format the LUN for a new one.
 */
export function IscsiLunDialog({
  probe,
  busy,
  onReattach,
  onFormat,
  onCancel,
}: {
  probe: ProbeOutcome | null;
  busy: boolean;
  onReattach: () => void;
  onFormat: () => void;
  onCancel: () => void;
}) {
  const found = probe?.found ?? null;
  const formatAllowed = !probe?.inUse;
  return (
    <AlertDialog open={!!probe} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{found ? "An existing iSCSI SR was found on the selected LUN" : "No existing SRs were found on the selected LUN"}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              {found && (
                <p className="whitespace-pre-line rounded border p-2 font-mono text-xs">
                  {`SR size: ${size(found.size)}\nSR UUID: ${found.uuid}`}
                </p>
              )}
              <div className={`rounded border p-2 ${found ? "" : "opacity-50"}`}>
                <p className="font-medium text-foreground">Reattach</p>
                <p>{found ? "Use the existing iSCSI SR" : "There is no existing SR to reattach"}</p>
              </div>
              {formatAllowed && (
                <div className="rounded border p-2">
                  <p className="font-medium text-foreground">Format</p>
                  <p>Destroy any data present on the disk and create a new iSCSI SR</p>
                </div>
              )}
              <p className="text-amber-700 dark:text-amber-400">
                {probe?.inUse ??
                  "To prevent data loss you must ensure that the LUN is not in use by any other system, including XenServer hosts that are not connected to XenMan."}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {found && (
            <Button disabled={busy} onClick={onReattach}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reattach
            </Button>
          )}
          {formatAllowed && (
            <Button variant="destructive" disabled={busy} onClick={onFormat}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Format
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
