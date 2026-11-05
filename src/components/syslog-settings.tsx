"use client";

import { useDates } from "@/context/date-format-context";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ScrollText, Send, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Config {
  enabled: boolean;
  host: string;
  port: number;
  protocol: "udp" | "tcp";
  journal: boolean;
}

interface Status {
  lastSentAt: string | null;
  sent: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

/**
 * Forwarding the audit log as RFC 5424 syslog to a collector -- an Elastic
 * Agent or Logstash input -- as a NetScaler does: address, port, UDP or TCP.
 */
export function SyslogSettings() {
  const dates = useDates();
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [journal, setJournal] = useState<"ok" | "missing" | "no-permission" | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/syslog", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const json = await res.json();
    setConfig((c) => c ?? json.config);
    setStatus(json.status);
    setJournal(json.journal ?? null);
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    // The status line follows what is being sent.
    const timer = setInterval(load, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  if (!config) return null;
  const set = (patch: Partial<Config>) => {
    setMessage(null);
    setConfig({ ...config, ...patch });
  };

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/syslog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const json = await res?.json().catch(() => ({}));
    return { ok: Boolean(res?.ok), json: json ?? {} };
  }

  async function save() {
    setSaving(true);
    const { ok, json } = await post({ ...config });
    setSaving(false);
    if (!ok) return setMessage({ ok: false, text: json.error ?? "Not saved" });
    setConfig(json.config);
    setStatus(json.status);
    setMessage({ ok: true, text: json.config.enabled ? "Saved — new audit entries are forwarded from now on." : "Saved — forwarding is off." });
  }

  async function test() {
    setTesting(true);
    const { ok, json } = await post({ ...config, action: "test" });
    setTesting(false);
    setMessage(
      ok
        ? { ok: true, text: `Test message sent to ${config!.host}:${config!.port}${config!.protocol === "udp" ? " — UDP cannot confirm it arrived; look for it in Elastic" : ""}.` }
        : { ok: false, text: json.error ?? "Not sent" },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="h-4 w-4" /> Log Forwarding (Syslog)
        </CardTitle>
        <CardDescription>
          Sends every audit log entry as RFC 5424 syslog to a collector, e.g. an Elastic Agent or Logstash input
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex items-center gap-2">
          <Switch id="syslog-on" checked={config.enabled} onCheckedChange={(v) => set({ enabled: v })} />
          <Label htmlFor="syslog-on">Forward the audit log</Label>
        </div>
        <div className="flex items-start gap-2">
          <Switch
            id="syslog-journal"
            checked={config.journal}
            disabled={!config.journal && journal !== "ok"}
            onCheckedChange={(v) => set({ journal: v })}
          />
          <Label htmlFor="syslog-journal" className="block leading-snug">
            Also forward the appliance&apos;s system log (journald)
            <span className="block text-xs font-normal text-muted-foreground">
              {journal === "missing"
                ? "Not available here: this installation has no system journal."
                : journal === "no-permission"
                  ? "XenMan may not read the system journal yet — it can after the next XenMan update or restart."
                  : "The XenMan service, updates, security updates, SSH and kernel messages, each with its own facility and severity; debug messages stay out."}
            </span>
          </Label>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem]">
          <div className="grid gap-1">
            <Label htmlFor="syslog-host">Server</Label>
            <Input id="syslog-host" className="font-mono" placeholder="10.0.0.20" value={config.host} onChange={(e) => set({ host: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="syslog-port">Port</Label>
            <Input
              id="syslog-port"
              type="number"
              className="font-mono"
              value={config.port}
              onChange={(e) => set({ port: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="grid gap-1">
            <Label>Protocol</Label>
            <Select value={config.protocol} onValueChange={(v) => set({ protocol: v as Config["protocol"] })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="udp">UDP</SelectItem>
                <SelectItem value="tcp">TCP</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Facility &quot;log audit&quot;, the entry&apos;s fields as structured data (
          <span className="font-mono">xenman@32473</span>). TCP sends one message per line and catches up after an
          outage; UDP does not know whether a message arrived. Syslog has no login: let the collector accept only
          this appliance&apos;s address.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="outline" onClick={test} disabled={testing || !config.host.trim()}>
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {testing ? "Sending…" : "Send test message"}
          </Button>
        </div>
        {message && (
          <p className={`flex items-start gap-2 ${message.ok ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
            {message.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="min-w-0 break-words">{message.text}</span>
          </p>
        )}
        {config.enabled && status && (
          <p className="text-xs text-muted-foreground">
            {status.lastSentAt
              ? `${status.sent} entr${status.sent === 1 ? "y" : "ies"} sent since XenMan started, the last at ${dates.dateTime(status.lastSentAt)}.`
              : "Nothing sent since XenMan started."}
            {status.lastError && (
              <span className="block text-destructive">
                Last error{status.lastErrorAt ? ` (${dates.time(status.lastErrorAt)})` : ""}: {status.lastError}
              </span>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
