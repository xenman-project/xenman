"use client";

import { useDates } from "@/context/date-format-context";
import { formatDateTime, type DateFormat } from "@/lib/date-format";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Globe,
  Power,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { InstallLog } from "@/components/os-install-log";
import { RestartOverlay } from "@/components/restart-overlay";
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

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * What the appliance applies while no policy has been written yet -- the
 * DEFAULTS in appliance/os-policy.js. Only the starting point of the editor:
 * saving sends a complete policy, and the root side validates it.
 */
const DEFAULT_POLICY = {
  mode: "window",
  days: ["Sun"],
  time: "02:00",
  timezone: "Europe/Berlin",
  rebootInWindow: false,
} as const;

/** How long a request may wait for the root side before the card says so. */
const REQUEST_PICKUP_MS = 60_000;

interface Policy {
  mode: "window" | "manual";
  days: string[];
  time: string;
  timezone: string;
  rebootInWindow: boolean;
}

interface PendingPackage {
  name: string;
  from: string | null;
  to: string;
}

interface RequestResult {
  id: string | null;
  action: string | null;
  state: "running" | "done" | "failed";
  message: string;
}

interface Reminders {
  alert: { level: "none" | "warn" | "critical"; message: string | null; days: number };
  thresholds: { warnDays: number; criticalDays: number };
  settings: { enabled: boolean; emailAdmins: boolean };
  mail: { smtpConfigured: boolean; adminsWithEmail: number };
}

interface ProxyInfo {
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
}

interface ProxyDraft {
  host: string;
  port: string;
  username: string;
  password: string;
}

interface OsState {
  appliance: boolean;
  policy?: Policy | null;
  status?: {
    lastRun?: string;
    lastCheck?: string;
    outcome?: "installed" | "nothing" | "failed";
    packages?: string[];
    deferred?: string;
  } | null;
  pending?: PendingPackage[] | null;
  listsUpdatedAt?: string | null;
  proxy?: ProxyInfo | null;
  installLog?: boolean;
  reboot?: { required: boolean; packages: string[] };
  boot?: { bootId: string | null; kernel: string | null };
  nextRun?: string | null;
  request?: RequestResult | null;
  requestPending?: boolean;
}

function describe(policy: {
  mode: Policy["mode"];
  days: readonly string[];
  time: string;
  timezone: string;
}): string {
  if (policy.mode === "manual") return "Manual — updates install only when you start them";
  const days = policy.days.length === 7 ? "Every day" : `Every ${policy.days.join(", ")}`;
  return `${days} at ${policy.time} (${policy.timezone})`;
}

function when(iso: string | undefined, fmt: DateFormat): string | null {
  return iso ? formatDateTime(iso, fmt) : null;
}

/** A moment shown in the window's own zone, the way the window itself is set. */
function inZone(iso: string, timezone: string, fmt: DateFormat): string {
  try {
    const weekday = new Date(iso).toLocaleDateString(fmt === "iso" ? "en-US" : fmt, { weekday: "short", timeZone: timezone });
    return `${weekday} ${formatDateTime(iso, fmt, { seconds: false, timeZone: timezone })} (${timezone})`;
  } catch {
    return formatDateTime(iso, fmt);
  }
}

export function OsUpdates() {
  const { format: dateFmt } = useDates();
  const [data, setData] = useState<OsState | null>(null);
  // Set while the appliance is restarting at our request, so the dropped
  // connection reads as expected rather than as an error.
  const [restarting, setRestarting] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  // What the restart page compares against: the boot and kernel before it.
  const [restartFrom, setRestartFrom] = useState<{
    bootId: string | null;
    kernelBefore: string | null;
    kernelExpected: string | null;
    requestId: string | null;
  } | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [confirm, setConfirm] = useState<"install" | "reboot" | null>(null);
  // Set when a request has gone unanswered too long: the root side is not
  // picking it up, and spinning on would only hide that.
  const [stale, setStale] = useState(false);
  const submitted = useRef<{ id: string | null; at: number } | null>(null);
  const [reminders, setReminders] = useState<Reminders | null>(null);
  const [proxyDraft, setProxyDraft] = useState<ProxyDraft | null>(null);
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/os-update", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) setData({ appliance: false });
        return;
      }
      const next: OsState = await res.json();
      setData(next);
      if (next.appliance) {
        const r = await fetch("/api/os-update/alert", { cache: "no-store" });
        if (r.ok) setReminders(await r.json());
      }
      setUnreachable(false);
      if (!next.reboot?.required) setRestarting(false);
      const mine = submitted.current;
      setStale(
        Boolean(
          mine &&
            next.requestPending &&
            next.request?.id !== mine.id &&
            Date.now() - mine.at > REQUEST_PICKUP_MS,
        ),
      );
    } catch {
      setUnreachable(true);
    }
  }, []);

  // Started from a timer, not the effect body: setState inside an effect
  // cascades renders.
  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const busy = Boolean(data?.requestPending) || restarting || unreachable;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const timezones = useMemo(() => {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf?.("timeZone") ?? [];
  }, []);

  if (!data || !data.appliance) return null;

  const policy = data.policy ?? null;
  const pending = data.pending;
  const result = data.request && data.request.id === submittedId ? data.request : null;
  // An installation started here is followed live, and its log stays open.
  const installResult = result?.action === "install-now" ? result : null;

  async function submit(url: string, body?: unknown) {
    setError(null);
    const res = await fetch(url, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? "The request failed");
      return false;
    }
    setSubmittedId(json.id ?? null);
    submitted.current = { id: json.id ?? null, at: Date.now() };
    setStale(false);
    setData((prev) => (prev ? { ...prev, requestPending: true } : prev));
    return true;
  }

  function startEditing() {
    setDraft(policy ? { ...policy } : { ...DEFAULT_POLICY, days: [...DEFAULT_POLICY.days] });
    setEditing(true);
  }

  async function save() {
    if (!draft) return;
    if (draft.mode === "window" && draft.days.length === 0) {
      setError("Choose at least one weekday");
      return;
    }
    if (await submit("/api/os-update/policy", draft)) setEditing(false);
  }

  function editProxy() {
    const p = data?.proxy;
    setProxyDraft({
      host: p?.host ?? "",
      port: p ? String(p.port) : "8080",
      username: p?.username ?? "",
      password: "",
    });
  }

  async function saveProxy(remove = false) {
    if (!proxyDraft) return;
    const proxy = remove
      ? null
      : {
          host: proxyDraft.host.trim(),
          port: Number(proxyDraft.port),
          ...(proxyDraft.username ? { username: proxyDraft.username } : {}),
          ...(proxyDraft.username && proxyDraft.password ? { password: proxyDraft.password } : {}),
        };
    if (await submit("/api/os-update/proxy", { proxy })) setProxyDraft(null);
  }

  async function saveReminders(change: { enabled?: boolean; emailAdmins?: boolean }) {
    setError(null);
    const res = await fetch("/api/os-update/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? "Could not save the setting");
      return;
    }
    setReminders((prev) => (prev ? { ...prev, settings: json.settings } : prev));
    // Let the banner follow at once instead of at its next poll.
    window.dispatchEvent(new Event("xenman-os-alert-changed"));
  }

  async function confirmed() {
    const action = confirm;
    setConfirm(null);
    if (action === "install") await submit("/api/os-update/install");
    if (action === "reboot") {
      const before = data?.boot;
      // Debian names each kernel package after its version: linux-image-6.12.111+deb13-amd64.
      const kernelPackage = data?.reboot?.packages.find((p) => /^linux-image-\d/.test(p));
      if (await submit("/api/os-update/reboot")) {
        setRestarting(true);
        setRestartFrom({
          bootId: before?.bootId ?? null,
          kernelBefore: before?.kernel ?? null,
          kernelExpected: kernelPackage ? kernelPackage.replace(/^linux-image-/, "") : null,
          requestId: submitted.current?.id ?? null,
        });
      }
    }
  }

  const toggleDay = (day: string) =>
    setDraft((d) =>
      d ? { ...d, days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day] } : d,
    );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Security Updates
          </CardTitle>
          <CardDescription>
            Debian security updates for the appliance itself. Your hosts and their VMs are
            not affected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 text-sm">
          {(restarting || unreachable) && (
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>
                {restarting
                  ? "The appliance is restarting — this page reconnects on its own"
                  : "The appliance is not answering — retrying"}
              </span>
            </div>
          )}

          {/* ── schedule ───────────────────────────────────────────────── */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-medium flex items-center gap-2">
                <CalendarClock className="h-4 w-4" /> Schedule
              </h3>
              {!editing && (
                <Button size="sm" variant="outline" onClick={startEditing} disabled={busy}>
                  Change
                </Button>
              )}
            </div>
            {!policy && !editing && (
              <p className="text-muted-foreground">
                No schedule saved yet, so the default applies: {describe(DEFAULT_POLICY)}.
              </p>
            )}
            {policy && !editing && (
              <div className="space-y-1">
                <p>{describe(policy)}</p>
                {policy.mode === "window" && (
                  <p className="text-muted-foreground">
                    {policy.rebootInWindow
                      ? "Restarts automatically after an update that requires it."
                      : "Does not restart automatically — you restart it when an update requires it."}
                    {data.nextRun && ` Next window: ${inZone(data.nextRun, policy.timezone, dateFmt)}.`}
                  </p>
                )}
              </div>
            )}

            {editing && draft && (
              <div className="rounded-md border p-3 space-y-4">
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={draft.mode === "window" ? "default" : "outline"}
                    onClick={() => setDraft({ ...draft, mode: "window" })}
                  >
                    Maintenance window
                  </Button>
                  <Button
                    size="sm"
                    variant={draft.mode === "manual" ? "default" : "outline"}
                    onClick={() => setDraft({ ...draft, mode: "manual" })}
                  >
                    Manual
                  </Button>
                </div>

                {draft.mode === "manual" ? (
                  <p className="text-muted-foreground">
                    Nothing installs on its own. Use “Install now” below when your change
                    process allows it.
                  </p>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label>Days</Label>
                      <div className="flex flex-wrap gap-1">
                        {WEEKDAYS.map((day) => (
                          <Button
                            key={day}
                            size="sm"
                            variant={draft.days.includes(day) ? "default" : "outline"}
                            onClick={() => toggleDay(day)}
                          >
                            {day}
                          </Button>
                        ))}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDraft({ ...draft, days: [...WEEKDAYS] })}
                        >
                          Every day
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-4">
                      <div className="space-y-1">
                        <Label htmlFor="os-window-time">Time</Label>
                        <Input
                          id="os-window-time"
                          type="time"
                          className="w-32"
                          value={draft.time}
                          onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="os-window-tz">Time zone</Label>
                        <select
                          id="os-window-tz"
                          className="h-9 rounded-md border bg-transparent px-2 text-sm"
                          value={draft.timezone}
                          onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                        >
                          {[draft.timezone, ...timezones.filter((t) => t !== draft.timezone)].map(
                            (tz) => (
                              <option key={tz} value={tz}>
                                {tz}
                              </option>
                            ),
                          )}
                        </select>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="os-window-reboot"
                          checked={draft.rebootInWindow}
                          onCheckedChange={(v) => setDraft({ ...draft, rebootInWindow: v })}
                        />
                        <Label htmlFor="os-window-reboot">Restart automatically if required</Label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Some updates, such as a new kernel, only take effect after a restart.
                        When this is on, the appliance restarts itself right after installing
                        them, still within the time set above. When it is off, the update waits
                        on disk until you restart the appliance yourself. Your hosts and their
                        VMs keep running either way.
                      </p>
                    </div>
                  </>
                )}

                <div className="flex gap-2">
                  <Button size="sm" onClick={save} disabled={busy}>
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* ── pending ────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Pending</h3>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => submit("/api/os-update/check")}
                  disabled={busy}
                >
                  <RefreshCw className="mr-2 h-4 w-4" /> Check now
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirm("install")}
                  disabled={busy || !pending || pending.length === 0}
                >
                  Install now
                </Button>
              </div>
            </div>
            {pending === null && (
              <p className="text-muted-foreground">Could not be determined.</p>
            )}
            {pending && pending.length === 0 && (
              <p className="flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> No security updates pending
              </p>
            )}
            {pending && pending.length > 0 && (
              <ul className="rounded-md border divide-y">
                {pending.map((p) => (
                  <li key={p.name} className="flex justify-between gap-4 px-3 py-1.5 text-xs">
                    <span className="font-mono">{p.name}</span>
                    <span className="font-mono text-muted-foreground">
                      {p.from ? `${p.from} → ${p.to}` : `${p.to} (new)`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              {data.listsUpdatedAt
                ? `Last checked ${when(data.listsUpdatedAt, dateFmt)}`
                : "Not checked yet"}
              {" "}— the appliance also checks once a day on its own.
            </p>
          </section>

          {/* ── proxy ──────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-medium flex items-center gap-2">
                <Globe className="h-4 w-4" /> Proxy
              </h3>
              {!proxyDraft && (
                <Button size="sm" variant="outline" onClick={editProxy} disabled={busy}>
                  Change
                </Button>
              )}
            </div>
            {!proxyDraft && (
              <p>
                {data.proxy
                  ? `Via ${data.proxy.host}:${data.proxy.port}${
                      data.proxy.username ? ` as ${data.proxy.username}` : ""
                    }`
                  : "Direct connection"}
              </p>
            )}
            {proxyDraft && (
              <div className="rounded-md border p-3 space-y-4">
                <p className="text-xs text-muted-foreground">
                  Used only to download Debian updates. Connections to your hosts do not go
                  through it. After saving, the appliance checks the connection right away.
                </p>
                <div className="flex flex-wrap gap-4">
                  <div className="space-y-1 flex-1 min-w-48">
                    <Label htmlFor="os-proxy-host">Host</Label>
                    <Input
                      id="os-proxy-host"
                      placeholder="proxy.example.com"
                      value={proxyDraft.host}
                      onChange={(e) => setProxyDraft({ ...proxyDraft, host: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="os-proxy-port">Port</Label>
                    <Input
                      id="os-proxy-port"
                      inputMode="numeric"
                      className="w-24"
                      value={proxyDraft.port}
                      onChange={(e) => setProxyDraft({ ...proxyDraft, port: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-4">
                  <div className="space-y-1 flex-1 min-w-40">
                    <Label htmlFor="os-proxy-user">Login (optional)</Label>
                    <Input
                      id="os-proxy-user"
                      autoComplete="off"
                      value={proxyDraft.username}
                      onChange={(e) => setProxyDraft({ ...proxyDraft, username: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1 flex-1 min-w-40">
                    <Label htmlFor="os-proxy-password">Password (optional)</Label>
                    <Input
                      id="os-proxy-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        data.proxy?.hasPassword && proxyDraft.username === data.proxy.username
                          ? "unchanged"
                          : ""
                      }
                      disabled={!proxyDraft.username}
                      value={proxyDraft.password}
                      onChange={(e) => setProxyDraft({ ...proxyDraft, password: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => saveProxy()} disabled={busy || !proxyDraft.host.trim()}>
                    Save
                  </Button>
                  {data.proxy && (
                    <Button size="sm" variant="outline" onClick={() => saveProxy(true)} disabled={busy}>
                      Remove proxy
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setProxyDraft(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* ── reminders ──────────────────────────────────────────────── */}
          {reminders && (
            <section className="space-y-2">
              <h3 className="font-medium">Reminders</h3>
              <div className="flex items-center gap-2">
                <Switch
                  id="os-remind"
                  checked={reminders.settings.enabled}
                  onCheckedChange={(enabled) => saveReminders({ enabled })}
                />
                <Label htmlFor="os-remind">Show reminders for overdue security updates</Label>
              </div>
              <p className="text-muted-foreground">
                {reminders.settings.enabled ? "After" : "When on: after"}{" "}
                {reminders.thresholds.warnDays} days a notice appears on every page for admins;
                after {reminders.thresholds.criticalDays} days it turns red and can no longer be
                dismissed.
              </p>
              {reminders.settings.enabled && (
                <>
                  {reminders.alert.level !== "none" && reminders.alert.message && (
                    <p
                      className={
                        reminders.alert.level === "critical"
                          ? "text-red-600 dark:text-red-400"
                          : "text-amber-700 dark:text-amber-400"
                      }
                    >
                      {reminders.alert.message}.
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Switch
                      id="os-remind-email"
                      checked={reminders.settings.emailAdmins}
                      onCheckedChange={(emailAdmins) => saveReminders({ emailAdmins })}
                    />
                    <Label htmlFor="os-remind-email">Send email notifications to administrators</Label>
                  </div>
                  {reminders.settings.emailAdmins && (
                    <p className="text-xs text-muted-foreground">
                      A notification is sent when the notice appears and when it turns red, then
                      weekly while it remains red.
                      {!reminders.mail.smtpConfigured &&
                        " No mail server is configured yet — set one up under Mail Server (SMTP) to enable delivery."}
                      {reminders.mail.smtpConfigured &&
                        reminders.mail.adminsWithEmail === 0 &&
                        " No administrator has an email address, so no notification can be delivered."}
                      {reminders.mail.smtpConfigured &&
                        reminders.mail.adminsWithEmail > 0 &&
                        ` Recipients: ${reminders.mail.adminsWithEmail} administrator${reminders.mail.adminsWithEmail === 1 ? "" : "s"} with an email address.`}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {/* ── restart ────────────────────────────────────────────────── */}
          {data.reboot?.required && !restarting && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="flex-1 space-y-2">
                <p className="font-medium">Restart required</p>
                <p className="text-muted-foreground">
                  Installed updates are on disk, but the running
                  {data.reboot.packages.length > 0
                    ? ` ${data.reboot.packages.join(", ")} `
                    : " kernel or libraries "}
                  are not yet the patched ones.
                </p>
                <Button size="sm" variant="outline" onClick={() => setConfirm("reboot")} disabled={busy}>
                  <Power className="mr-2 h-4 w-4" /> Restart now
                </Button>
              </div>
            </div>
          )}

          {/* ── what happened ──────────────────────────────────────────── */}
          {data.requestPending && !result && !stale && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> A request is being carried out…
            </p>
          )}
          {stale && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p>
                The appliance has not picked up this request after a minute. The service
                that carries it out may not be running — on the console,{" "}
                <code>systemctl enable --now xenman-os-request.path</code> starts it, and the
                waiting request is then carried out.
              </p>
            </div>
          )}
          {installResult && <InstallLog live={installResult.state === "running"} />}
          {result && (
            <div
              className={`flex items-start gap-2 rounded-md border p-3 ${
                result.state === "failed"
                  ? "border-destructive/40 bg-destructive/10"
                  : "border-green-600/40 bg-green-600/10"
              }`}
            >
              {result.state === "running" ? (
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              ) : result.state === "failed" ? (
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

          {data.status && (
            <section className="space-y-1 text-muted-foreground">
              <h3 className="font-medium text-foreground">Last run</h3>
              {data.status.lastRun && (
                <p>
                  {when(data.status.lastRun, dateFmt)} —{" "}
                  {data.status.outcome === "installed" ? (
                    <>installed {data.status.packages?.length ?? 0} package(s)</>
                  ) : data.status.outcome === "failed" ? (
                    <Badge variant="destructive">failed</Badge>
                  ) : (
                    "nothing to install"
                  )}
                </p>
              )}
              {data.status.deferred && (
                <p>
                  Last check {when(data.status.lastCheck, dateFmt)}: {data.status.deferred}
                </p>
              )}
              {data.installLog && !installResult && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowLog((v) => !v)}
                    className="text-xs underline underline-offset-2 hover:text-foreground"
                  >
                    {showLog ? "Hide log" : "Show log"}
                  </button>
                  {showLog && <InstallLog live={false} />}
                </>
              )}
            </section>
          )}
        </CardContent>
      </Card>

      {restartFrom && (
        <RestartOverlay
          {...restartFrom}
          onFailed={(message) => {
            setRestartFrom(null);
            setRestarting(false);
            setError(message);
          }}
        />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "reboot" ? "Restart the appliance?" : "Install security updates now?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "reboot"
                ? "XenMan is unreachable for about a minute. Your hosts and their running VMs are not affected — only this management appliance restarts."
                : `This installs ${pending?.length ?? 0} package(s) now, outside the maintenance window. It is recorded in the audit log.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmed}>
              {confirm === "reboot" ? "Restart" : "Install"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
