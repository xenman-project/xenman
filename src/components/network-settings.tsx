"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Network, RefreshCw, XCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Config {
  mode: "dhcp" | "static";
  address?: string;
  gateway?: string;
  dns: string[];
  domains: string[];
  hostname: string;
}

interface Info {
  appliance: boolean;
  config?: Config;
  live?: {
    interfaces: { name: string; mac: string | null; up: boolean; addresses: string[] }[];
    gateway: string | null;
    dns: string[];
  };
  state?: { state: string; deadline?: string; message?: string; at?: string } | null;
}

interface Draft {
  mode: "dhcp" | "static";
  address: string;
  gateway: string;
  dns: string;
  domains: string;
  hostname: string;
}

/** How long a change stays on probation; the root side uses the same. */
const CONFIRM_SECONDS = 90;
const POLL_MS = 1500;
// An address that went away does not refuse a request, it just never answers:
// without a limit the page would wait on it for minutes, past the deadline.
const REQUEST_TIMEOUT_MS = 4000;
/** Pause before the browser moves to the new address, for the link to be read. */
const MOVE_AFTER_MS = 3000;

type Phase =
  | { kind: "idle" }
  | { kind: "applying"; id: string; token: string; newUrl: string | null; sameAddress: boolean }
  | { kind: "waiting"; token: string; newUrl: string | null; deadline: number }
  | { kind: "done"; ok: boolean; message: string };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/**
 * The appliance's address, gateway, DNS and host name. A change is applied on
 * probation: if it moves the appliance to another address, it has to be
 * confirmed from there within CONFIRM_SECONDS, or the old settings return --
 * so a typo cannot lock anyone out.
 */
export function NetworkSettings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // When the state was read: "still pending?" is judged against this, not the render.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/appliance/network", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) setInfo({ appliance: false });
        return null;
      }
      const next: Info = await res.json();
      setInfo(next);
      setLoadedAt(Date.now());
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  // The request on its way through the root side.
  useEffect(() => {
    if (phase.kind !== "applying") return;
    let asking = false;
    const timer = setInterval(async () => {
      if (asking) return;
      asking = true;
      try {
        const res = await fetch("/api/os-update/boot", { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!res.ok) return;
        const r = (await res.json()).request;
        if (!r || r.id !== phase.id || r.state === "running") return;
        if (r.state === "failed") {
          setPhase({ kind: "done", ok: false, message: r.message });
          return;
        }
        if (phase.sameAddress) {
          // Still reachable here, which is all a confirmation proves.
          const c = await fetch("/api/appliance/network/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: phase.token }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          setPhase(
            c.ok
              ? { kind: "done", ok: true, message: "Network settings saved." }
              : { kind: "done", ok: false, message: "The settings were applied but could not be confirmed; they will be undone." },
          );
          setTimeout(load, 2000);
          return;
        }
        setPhase({ kind: "waiting", token: phase.token, newUrl: phase.newUrl, deadline: Date.now() + (CONFIRM_SECONDS - 3) * 1000 });
      } catch {
        // The old address went away mid-change -- refused or silent: that is
        // the address change itself.
        if (!phase.sameAddress) {
          setPhase({ kind: "waiting", token: phase.token, newUrl: phase.newUrl, deadline: Date.now() + (CONFIRM_SECONDS - 5) * 1000 });
        }
      } finally {
        asking = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [phase, load]);

  // Moved: the browser follows to the new address, where the page confirms.
  useEffect(() => {
    if (phase.kind !== "waiting" || !phase.newUrl) return;
    const url = phase.newUrl;
    const timer = setTimeout(() => window.location.assign(url), MOVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Counting down, then looking whether the old address is back.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const timer = setInterval(async () => {
      setNow(Date.now());
      if (Date.now() < phase.deadline + 10_000) return;
      const back = await Promise.race([load(), new Promise<null>((r) => setTimeout(() => r(null), REQUEST_TIMEOUT_MS))]);
      if (back?.state?.state === "rolled-back") {
        setPhase({ kind: "done", ok: false, message: "Not confirmed in time — the previous network settings are back." });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, load]);

  if (!info || !info.appliance || !info.config || !info.live) return null;
  const { config, live } = info;
  const addresses = live.interfaces.flatMap((i) => i.addresses);
  const pendingElsewhere =
    phase.kind === "idle" && info.state?.state === "pending" && info.state.deadline && Date.parse(info.state.deadline) > loadedAt;
  const recentRollback =
    phase.kind === "idle" && info.state?.state === "rolled-back" && info.state.at && loadedAt - Date.parse(info.state.at) < 3600_000;

  function startEditing() {
    setError(null);
    setDraft({
      mode: config.mode,
      address: config.address ?? addresses[0] ?? "",
      gateway: config.gateway ?? live.gateway ?? "",
      dns: (config.dns.length ? config.dns : live.dns).join(" "),
      domains: config.domains.join(" "),
      hostname: config.hostname,
    });
  }

  async function apply() {
    if (!draft) return;
    setConfirmOpen(false);
    setError(null);
    const res = await fetch("/api/appliance/network", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? "The settings were refused");
      return;
    }
    const here = window.location.hostname;
    const newIp = draft.mode === "static" ? draft.address.split("/")[0] : null;
    // Unchanged if the appliance already has that address -- whether this page
    // uses it or a DNS name pointing at it.
    const sameAddress = newIp
      ? newIp === here || addresses.some((a) => a.split("/")[0] === newIp)
      : config.mode === "dhcp";
    const newUrl = newIp
      ? `${window.location.protocol}//${newIp}${window.location.port ? `:${window.location.port}` : ""}/network-confirm?token=${json.confirmToken}`
      : null;
    setDraft(null);
    setPhase({ kind: "applying", id: json.id, token: json.confirmToken, newUrl, sameAddress });
  }

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => (d ? { ...d, [k]: e.target.value } : d));
  const remaining = phase.kind === "waiting" ? Math.max(0, Math.ceil((phase.deadline - now) / 1000)) : 0;
  const busy = phase.kind === "applying" || phase.kind === "waiting" || Boolean(pendingElsewhere);

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Network className="h-4 w-4" /> Network
              </CardTitle>
              <CardDescription>The appliance&apos;s address, gateway, DNS and host name</CardDescription>
            </div>
            {!draft && (
              <Button size="sm" variant="outline" onClick={startEditing} disabled={busy}>
                Change
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Configuration">
            {config.mode === "dhcp" ? <Badge variant="outline">DHCP</Badge> : <Badge variant="outline">static</Badge>}
          </Row>
          {live.interfaces.map((i) => (
            <Row key={i.name} label={i.name}>
              <span className="font-mono text-xs">
                {i.addresses.join(", ") || "no address"}
                {i.mac && <span className="text-muted-foreground"> · {i.mac}</span>}
              </span>
            </Row>
          ))}
          <Row label="Gateway">
            <span className="font-mono text-xs">{live.gateway ?? "none"}</span>
          </Row>
          <Row label="DNS servers">
            <span className="font-mono text-xs">{live.dns.join(", ") || "none"}</span>
          </Row>
          {config.domains.length > 0 && (
            <Row label="Search domains">
              <span className="font-mono text-xs">{config.domains.join(" ")}</span>
            </Row>
          )}
          <Row label="Host name">
            <span className="font-mono text-xs">{config.hostname}</span>
          </Row>

          {draft && (
            <div className="rounded-md border p-3 space-y-4">
              <div className="flex gap-2">
                <Button size="sm" variant={draft.mode === "dhcp" ? "default" : "outline"} onClick={() => setDraft({ ...draft, mode: "dhcp" })}>
                  DHCP
                </Button>
                <Button size="sm" variant={draft.mode === "static" ? "default" : "outline"} onClick={() => setDraft({ ...draft, mode: "static" })}>
                  Static address
                </Button>
              </div>
              {draft.mode === "static" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <Label htmlFor="net-address">Address / prefix</Label>
                    <Input id="net-address" className="font-mono" placeholder="10.0.0.5/24" value={draft.address} onChange={set("address")} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="net-gateway">Gateway</Label>
                    <Input id="net-gateway" className="font-mono" placeholder="10.0.0.1" value={draft.gateway} onChange={set("gateway")} />
                  </div>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1">
                  <Label htmlFor="net-dns">DNS servers {draft.mode === "dhcp" && "(empty: from DHCP)"}</Label>
                  <Input id="net-dns" className="font-mono" placeholder="10.0.0.2 10.0.0.3" value={draft.dns} onChange={set("dns")} />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="net-domains">Search domains (optional)</Label>
                  <Input id="net-domains" className="font-mono" placeholder="example.org" value={draft.domains} onChange={set("domains")} />
                </div>
              </div>
              <div className="grid gap-1 sm:w-1/2">
                <Label htmlFor="net-hostname">Host name</Label>
                <Input id="net-hostname" className="font-mono" value={draft.hostname} onChange={set("hostname")} />
              </div>
              <p className="text-xs text-muted-foreground">
                Several entries are separated by spaces. The change is undone after {CONFIRM_SECONDS} seconds
                unless you confirm it — from the new address, if it changes.
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setConfirmOpen(true)}>
                  Apply
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {phase.kind === "applying" && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" /> Applying the network settings…
              </p>
              {/* Known already, and needed if this page loses the appliance before it hears back. */}
              {!phase.sameAddress && phase.newUrl && (
                <p className="text-xs text-muted-foreground">
                  This page then moves to{" "}
                  <a href={phase.newUrl} className="break-all font-mono underline underline-offset-2">
                    {phase.newUrl}
                  </a>{" "}
                  — open it yourself if it does not.
                </p>
              )}
            </div>
          )}
          {phase.kind === "waiting" && (
            <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="space-y-2">
                  <p className="font-medium">
                    Confirm from the new address — {remaining > 0 ? `${remaining} seconds left` : "time is up"}
                  </p>
                  {phase.newUrl ? (
                    <>
                      <p>
                        Moving to the new address now. If the browser warns about the certificate, accept it
                        once; the page then confirms by itself and the settings stay. If nothing happens, open
                        the link.
                      </p>
                      <a
                        href={phase.newUrl}
                        className="inline-flex items-center gap-1 break-all font-mono text-xs underline underline-offset-2"
                      >
                        {phase.newUrl} <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </>
                  ) : (
                    <p>
                      With DHCP the new address is not known here. Look it up in XenCenter or on the
                      appliance console, then open{" "}
                      <span className="break-all font-mono text-xs">https://&lt;new address&gt;/network-confirm?token={phase.token}</span>
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Without confirmation the previous settings come back, and this page reconnects.
                  </p>
                </div>
              </div>
            </div>
          )}
          {phase.kind === "done" && (
            <div
              className={`flex items-start gap-2 rounded-md border p-3 ${
                phase.ok ? "border-green-600/40 bg-green-600/10" : "border-destructive/40 bg-destructive/10"
              }`}
            >
              {phase.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              )}
              <p>{phase.message}</p>
            </div>
          )}
          {pendingElsewhere && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> A network change is waiting for confirmation.
            </p>
          )}
          {recentRollback && (
            <p className="text-xs text-muted-foreground">
              The last network change was not confirmed in time and was undone.
            </p>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p>{error}</p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Locked out? On the appliance console, log in as root: a menu lets you set the network there.
          </p>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply the network settings?</AlertDialogTitle>
            <AlertDialogDescription>
              {draft?.mode === "static" && draft.address.split("/")[0] !== (typeof window !== "undefined" ? window.location.hostname : "")
                ? `The appliance moves to ${draft.address.split("/")[0]}. This page loses its connection; confirm from the new address within ${CONFIRM_SECONDS} seconds, or the old settings come back.`
                : `The settings take effect at once and are kept if this page can still reach the appliance afterwards.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={apply}>Apply</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
