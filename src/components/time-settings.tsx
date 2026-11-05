"use client";

import { useDates } from "@/context/date-format-context";
import { formatDateTime } from "@/lib/date-format";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, XCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

interface TimeState {
  appliance: boolean;
  now?: string;
  timezone?: string | null;
  ntpEnabled?: boolean | null;
  synchronized?: boolean | null;
  server?: string | null;
  configured?: string[];
  defaults?: string[];
  maxServers?: number;
}

interface Result {
  id: string | null;
  state: "running" | "done" | "failed";
  message: string;
}

/** A clock this far from the browser's is worth pointing out. */
const DRIFT_WARN_S = 30;
const POLL_MS = 1500;

/**
 * The appliance's time zone and NTP servers. Changing them is done by the root
 * side, like the security update settings; this card asks and waits.
 */
export function TimeSettings() {
  const dates = useDates();
  const [data, setData] = useState<TimeState | null>(null);
  // Difference between the appliance's clock and the browser's, in ms.
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);
  const [zone, setZone] = useState("UTC");
  const [servers, setServers] = useState("");
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sent = Date.now();
      const res = await fetch("/api/appliance/time", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) setData({ appliance: false });
        return;
      }
      const next: TimeState = await res.json();
      setData(next);
      if (next.now) {
        // Half the round trip is the best guess for when the server read its clock.
        const received = Date.now();
        setOffset(Date.parse(next.now) - (sent + received) / 2);
      }
    } catch {
      // keep what we have
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, [load]);

  // Waiting for the root side to carry out a change.
  useEffect(() => {
    if (!waitingFor) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/os-update/boot", { cache: "no-store" });
        if (!res.ok) return;
        const r: Result | null = (await res.json()).request ?? null;
        if (r && r.id === waitingFor && r.state !== "running") {
          setWaitingFor(null);
          setResult(r);
          if (r.state === "done") setEditing(false);
          load();
        }
      } catch {
        // try again
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waitingFor, load]);

  const zones = useMemo(() => {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const all = intl.supportedValuesOf?.("timeZone") ?? [];
    return ["UTC", ...all.filter((z) => z !== "UTC")];
  }, []);

  if (!data || !data.appliance) return null;

  const tz = data.timezone ?? "UTC";
  const applianceNow = new Date(now + offset);
  let clock: string;
  try {
    clock = `${formatDateTime(applianceNow, dates.format, { timeZone: tz })} (${tz})`;
  } catch {
    clock = applianceNow.toISOString();
  }
  const drift = Math.abs(offset) / 1000;
  const max = data.maxServers ?? 5;

  function startEditing() {
    setZone(tz);
    setServers((data?.configured ?? []).join("\n"));
    setResult(null);
    setError(null);
    setEditing(true);
  }

  async function save() {
    setError(null);
    setResult(null);
    const list = servers.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (list.length > max) {
      setError(`At most ${max} NTP servers`);
      return;
    }
    const res = await fetch("/api/appliance/time", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: zone, ntpServers: list }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? "The request failed");
      return;
    }
    setWaitingFor(json.id ?? null);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" /> Date &amp; Time
            </CardTitle>
            <CardDescription>The appliance&apos;s clock, time zone and time servers</CardDescription>
          </div>
          {!editing && (
            <Button size="sm" variant="outline" onClick={startEditing} disabled={Boolean(waitingFor)}>
              Change
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Time</span>
          <span className="font-mono text-xs">{clock}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Time zone</span>
          <span>{tz}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Synchronisation</span>
          <span className="flex items-center gap-2 text-right">
            {data.synchronized ? (
              <Badge variant="outline" className="border-green-600/40 text-green-700 dark:text-green-400">
                synchronised
              </Badge>
            ) : (
              <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
                {data.ntpEnabled === false ? "NTP off" : "not synchronised"}
              </Badge>
            )}
            {data.server && <span className="font-mono text-xs">{data.server}</span>}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Time servers</span>
          <span className="text-right font-mono text-xs">
            {data.configured && data.configured.length > 0
              ? data.configured.join(", ")
              : `Debian defaults${data.defaults?.length ? ` (${data.defaults[0]}, …)` : ""}`}
          </span>
        </div>

        {drift > DRIFT_WARN_S && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>
              The appliance&apos;s clock differs from your computer&apos;s by {Math.round(drift)}{" "}
              seconds. Logins, logs and the maintenance window depend on it — set a time server
              the appliance can reach.
            </p>
          </div>
        )}
        {!data.synchronized && drift <= DRIFT_WARN_S && (
          <p className="text-xs text-muted-foreground">
            Not synchronised: the time servers cannot be reached. In networks that block public
            NTP, enter an internal time server (often the domain controller).
          </p>
        )}

        {editing && (
          <div className="rounded-md border p-3 space-y-4">
            <div className="space-y-1">
              <Label htmlFor="time-zone">Time zone</Label>
              <select
                id="time-zone"
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                value={zone}
                onChange={(e) => setZone(e.target.value)}
              >
                {[zone, ...zones.filter((z) => z !== zone)].map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Used for the console and system logs. The maintenance window keeps its own time
                zone.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="time-servers">Time servers (NTP), one per line</Label>
              <textarea
                id="time-servers"
                rows={3}
                placeholder="ntp.example.org"
                className="w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs"
                value={servers}
                onChange={(e) => setServers(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Up to {max}. Leave empty for Debian&apos;s public servers.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={Boolean(waitingFor)}>
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={Boolean(waitingFor)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {waitingFor && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" /> Applying…
          </p>
        )}
        {result && (
          <div
            className={`flex items-start gap-2 rounded-md border p-3 ${
              result.state === "failed"
                ? "border-destructive/40 bg-destructive/10"
                : "border-green-600/40 bg-green-600/10"
            }`}
          >
            {result.state === "failed" ? (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            ) : (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            )}
            <p>{result.message}</p>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p>{error}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
