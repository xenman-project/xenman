"use client";

// Settings > Security: signing in with Microsoft Entra ID. The app
// registration's tenant, client and secret, where XenMan is reached (the
// redirect URI is made from it), and whether passwords are left to
// administrators. The secret is only ever sent, never shown again.

import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface View {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  address: string;
  localAdminsOnly: boolean;
  secretSet: boolean;
  redirectUri: string;
  suggestedAddress?: string;
}

export function SsoSettingsCard() {
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState({ enabled: false, tenantId: "", clientId: "", clientSecret: "", address: "", localAdminsOnly: false });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function take(v: View) {
    setView(v);
    setForm({
      enabled: v.enabled,
      tenantId: v.tenantId,
      clientId: v.clientId,
      clientSecret: "",
      address: v.address || v.suggestedAddress || "",
      localAdminsOnly: v.localAdminsOnly,
    });
  }

  useEffect(() => {
    fetch("/api/sso-config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && take(d))
      .catch(() => {});
  }, []);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setMessage(null);
  };

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/sso-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Not saved.");
      take({ ...d, suggestedAddress: view?.suggestedAddress });
      setMessage({ ok: true, text: "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/sso-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", tenantId: form.tenantId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Test failed.");
      setMessage({ ok: d.ok === true, text: d.detail });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  // Shown as it will be once saved.
  const redirectUri = form.address ? `${form.address.trim().replace(/\/+$/, "")}/api/auth/sso/callback` : "";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-zinc-500" />
          <div>
            <CardTitle className="text-base">Microsoft Entra ID</CardTitle>
            <CardDescription>Sign in with Microsoft; roles from the app roles XenMan.Admin, XenMan.Operator and XenMan.Viewer</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Sign in with Microsoft</span>
          <Switch checked={form.enabled} disabled={!view || saving} onCheckedChange={(v) => set("enabled", v)} />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="sso-tenant">Directory (tenant) ID</Label>
            <Input id="sso-tenant" value={form.tenantId} onChange={(e) => set("tenantId", e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-xs" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sso-client">Application (client) ID</Label>
            <Input id="sso-client" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-xs" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sso-secret">Client secret</Label>
            <Input
              id="sso-secret"
              type="password"
              autoComplete="new-password"
              value={form.clientSecret}
              onChange={(e) => set("clientSecret", e.target.value)}
              placeholder={view?.secretSet ? "Set -- leave empty to keep it" : "The secret's value"}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sso-address">XenMan address</Label>
            <Input id="sso-address" value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="https://xenman.example.org" />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label>Redirect URI</Label>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1.5 text-xs dark:bg-zinc-800">{redirectUri || "Enter the XenMan address first"}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!redirectUri}
              onClick={() => {
                void navigator.clipboard?.writeText(redirectUri);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            In Entra ID: App registrations, New registration, platform Web with this redirect URI. Under Certificates &amp; secrets a
            client secret; under App roles XenMan.Admin, XenMan.Operator and XenMan.Viewer (Users/Groups); then assign users or groups
            under Enterprise applications. XenMan has to reach login.microsoftonline.com over HTTPS.
          </p>
        </div>

        <label className="flex items-start justify-between gap-3 text-sm">
          <span>
            <span className="font-medium">Password sign-in for administrators only</span>
            <span className="block text-muted-foreground">
              Everyone else signs in with Microsoft. Administrators keep their password as the way in when Entra ID is not reachable.
            </span>
          </span>
          <Switch
            checked={form.localAdminsOnly}
            disabled={!view || saving || !form.enabled}
            onCheckedChange={(v) => set("localAdminsOnly", v)}
          />
        </label>

        {message && <p className={`text-sm ${message.ok ? "text-emerald-600" : "text-red-500"}`}>{message.text}</p>}

        <div className="flex flex-wrap gap-2">
          <Button disabled={!view || saving} onClick={() => void save()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
          <Button variant="outline" disabled={!form.tenantId || testing} onClick={() => void test()}>
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Test
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
