"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ipAllowedBy, parseIpEntry } from "@/lib/ip-match";

// Who may reach the web interface: only the NetScaler (and an admin network,
// if wanted). Applied as root on probation, like the network settings: this
// page confirms the change as soon as it reaches XenMan under the new rules --
// which it can only through an allowed address. A browser that came directly
// cannot, and after CONFIRM_SECONDS the previous rules are back.

/** The root side uses the same. */
const CONFIRM_SECONDS = 120;
const POLL_MS = 1500;
// A connection the new rules drop does not refuse, it goes silent: a limit,
// or the page would wait on it for minutes.
const REQUEST_TIMEOUT_MS = 4000;

interface Info {
  appliance: boolean;
  config?: { enabled: boolean; allow: string[]; sshAllow: string[] };
  state?: { state: string; id?: string | null; deadline?: string; message?: string } | null;
  client?: { address: string; allowed: boolean };
}

type Phase =
  | { kind: "idle" }
  | { kind: "applying"; id: string; token: string }
  | { kind: "cut-off"; deadline: number }
  | { kind: "done"; ok: boolean; message: string };

const lines = (s: string) => s.split(/[\s,]+/).filter(Boolean);

export function AccessSettings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [allow, setAllow] = useState("");
  const [sshAllow, setSshAllow] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/appliance/firewall", { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) return null;
      const next: Info = await res.json();
      setInfo(next);
      if (next.config) {
        setEnabled(next.config.enabled);
        setAllow(next.config.allow.join("\n"));
        setSshAllow(next.config.sshAllow.join("\n"));
      }
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  // The change on its way through the root side, then confirmed from here.
  useEffect(() => {
    if (phase.kind !== "applying") return;
    let asking = false;
    let silent = 0;
    const timer = setInterval(async () => {
      if (asking) return;
      asking = true;
      try {
        const res = await fetch("/api/os-update/boot", { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        silent = 0;
        if (!res.ok) return;
        const r = (await res.json()).request;
        if (!r || r.id !== phase.id || r.state === "running") return;
        if (r.state === "failed") {
          setPhase({ kind: "done", ok: false, message: r.message });
          return;
        }
        // Applied, and still reachable: that is what the confirmation proves.
        const c = await fetch("/api/appliance/firewall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "confirm", token: phase.token }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        setPhase(
          c.ok
            ? { kind: "done", ok: true, message: "Access rules saved — this browser still reaches XenMan through them." }
            : { kind: "done", ok: false, message: (await c.json().catch(() => ({}))).error ?? "Could not be confirmed; the change will be undone." },
        );
        setTimeout(load, 1500);
      } catch {
        // Silent: the new rules drop this browser's connection.
        if (++silent >= 3) setPhase({ kind: "cut-off", deadline: Date.now() + CONFIRM_SECONDS * 1000 });
      } finally {
        asking = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [phase, load]);

  // Cut off: the old rules return at the deadline; then the page loads again.
  useEffect(() => {
    if (phase.kind !== "cut-off") return;
    const timer = setInterval(async () => {
      setNow(Date.now());
      if (Date.now() < phase.deadline - 5000) return;
      const back = await load();
      if (back) setPhase({ kind: "done", ok: false, message: "This browser could not reach XenMan under the new rules, so they were undone. Make the change through the NetScaler." });
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, load]);

  if (!info?.appliance) return null;

  const allowList = lines(allow);
  const sshList = lines(sshAllow);
  const bad = [...allowList, ...sshList].find((x) => !parseIpEntry(x));
  const client = info.client?.address ?? "";
  const clientAllowed = client ? ipAllowedBy(client, allowList) : false;
  const busy = phase.kind === "applying" || phase.kind === "cut-off";

  async function save() {
    setError(null);
    const res = await fetch("/api/appliance/firewall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, allow: allowList, sshAllow: sshList }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      setError(json.error ?? "XenMan did not answer");
      return;
    }
    setPhase({ kind: "applying", id: json.id, token: json.confirmToken });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {info.config?.enabled ? <ShieldCheck className="h-4 w-4 text-green-600" /> : <ShieldOff className="h-4 w-4" />}
          Access
        </CardTitle>
        <CardDescription>
          Let the web interface answer only the NetScaler — its SNIP addresses, both nodes of an HA pair — and, if you
          want, an admin network. Everything else is dropped. The VM console stays open; at the console, menu item
          &quot;Access&quot; switches this off again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex items-center gap-2">
          <Switch id="acc-on" checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
          <Label htmlFor="acc-on">Allow the web interface only from these addresses</Label>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acc-allow">Web interface (ports 80 and 443)</Label>
          <textarea
            id="acc-allow"
            className="min-h-24 w-full rounded-md border bg-background p-2 font-mono text-xs"
            placeholder={"10.49.0.20\n10.49.0.21\n10.49.10.0/24"}
            value={allow}
            onChange={(e) => setAllow(e.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">One address or network per line, IPv4 or IPv6.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acc-ssh">SSH, when it is switched on (optional)</Label>
          <textarea
            id="acc-ssh"
            className="min-h-16 w-full rounded-md border bg-background p-2 font-mono text-xs"
            placeholder="empty: not limited by address"
            value={sshAllow}
            onChange={(e) => setSshAllow(e.target.value)}
            disabled={busy}
          />
        </div>

        {client && enabled && (
          <p className={`flex items-start gap-2 text-xs ${clientAllowed ? "text-muted-foreground" : "text-amber-600"}`}>
            {!clientAllowed && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            {clientAllowed
              ? `This browser reaches XenMan from ${client}, which these rules allow.`
              : `This browser reaches XenMan from ${client}, which these rules do not allow — if that is not the NetScaler, it loses the connection and the change is undone after ${CONFIRM_SECONDS / 60} minutes.`}
          </p>
        )}
        {bad && <p className="text-xs text-destructive">{bad} is not an IP address or network.</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {phase.kind === "applying" && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Applying — the first time, nftables is installed first…
          </p>
        )}
        {phase.kind === "cut-off" && (
          <p className="text-amber-600">
            This browser no longer reaches XenMan under the new rules. Unless it is confirmed through an allowed address,
            the previous rules come back in {Math.max(0, Math.round((phase.deadline - (now || phase.deadline)) / 1000))} s.
          </p>
        )}
        {phase.kind === "done" && <p className={phase.ok ? "text-green-600" : "text-destructive"}>{phase.message}</p>}

        <Button onClick={save} disabled={busy || Boolean(bad) || (enabled && allowList.length === 0)}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
