"use client";

// Two-factor sign-in with an authenticator app (api/auth/totp): setting it up
// with a QR code, the recovery codes shown once, new ones, switching it off.
// TotpEnrol is also the page a user lands on when the policy requires it
// (app/setup-2fa).

import { useEffect, useState } from "react";
import { Copy, Download, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

async function totpCall(body: Record<string, unknown>) {
  const res = await fetch("/api/auth/totp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed");
  return data;
}

const codeInput = (value: string) => value.replace(/\D/g, "").slice(0, 6);

/** The recovery codes, shown once: copy them or save them as a file. */
export function RecoveryCodes({ codes, username }: { codes: string[]; username?: string }) {
  const text = codes.join("\n");
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Keep these recovery codes somewhere safe, apart from your phone. Each one signs you in once if the phone is lost.
        They are shown only now.
      </p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border bg-muted/40 p-3 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard?.writeText(text).catch(() => {});
            setCopied(true);
          }}
        >
          <Copy className="mr-2 h-4 w-4" /> {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`XenMan recovery codes${username ? ` for ${username}` : ""}\n\n${text}\n`], { type: "text/plain" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "xenman-recovery-codes.txt";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          }}
        >
          <Download className="mr-2 h-4 w-4" /> Download
        </Button>
      </div>
    </div>
  );
}

/** Setting it up: the QR code, the key to type in, a code to confirm, then the recovery codes. */
export function TotpEnrol({
  username,
  onDone,
  onCancel,
  onEnabled,
}: {
  username?: string;
  onDone: () => void;
  onCancel?: () => void;
  /** Turned on: the codes are on show now, the state around may say so. */
  onEnabled?: () => void;
}) {
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    totpCall({ action: "start" })
      .then((d) => !gone && setSetup({ secret: d.secret, qrSvg: d.qrSvg }))
      .catch((e) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
  }, []);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setCodes((await totpCall({ action: "confirm", code })).recoveryCodes);
      onEnabled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <div className="grid gap-4">
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-600">
          <ShieldCheck className="h-4 w-4" /> Two-factor sign-in is on.
        </p>
        <RecoveryCodes codes={codes} username={username} />
        <div>
          <Button size="sm" onClick={onDone}>
            I have saved them
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={confirm} className="grid gap-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Scan the QR code with your authenticator app (Microsoft or Google Authenticator, 1Password and the like).</li>
        <li>Enter the six-digit code the app then shows.</li>
      </ol>
      {setup ? (
        <div className="flex flex-wrap items-center gap-4">
          {/* SVG drawn by XenMan itself (lib/totp-qr.ts) */}
          <div
            className="h-44 w-44 shrink-0 rounded-md bg-white p-1"
            aria-label="QR code for the authenticator app"
            dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
          />
          <div className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Cannot scan it? Enter this key in the app:</span>
            <code className="select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">{setup.secret}</code>
          </div>
        </div>
      ) : (
        !error && <p className="text-sm text-muted-foreground">Preparing…</p>
      )}
      <div className="grid max-w-[12rem] gap-2">
        <Label htmlFor="totp-confirm">Code from the app</Label>
        <Input
          id="totp-confirm"
          value={code}
          onChange={(e) => setCode(codeInput(e.target.value))}
          inputMode="numeric"
          autoComplete="one-time-code"
          className="font-mono tracking-widest"
          placeholder="123456"
        />
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !setup || code.length !== 6}>
          {busy ? "Checking…" : "Turn on"}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

interface TotpState {
  enabled: boolean;
  recoveryLeft: number;
  required: boolean;
}

/** Settings > Account: the user's own two-factor sign-in. */
export function TotpSettingsCard({ username }: { username?: string }) {
  const [state, setState] = useState<TotpState | null>(null);
  const [mode, setMode] = useState<"idle" | "enrol" | "codes" | "disable">("idle");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetch("/api/auth/totp", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setState(d))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const reset = () => {
    setMode("idle");
    setCode("");
    setPassword("");
    setError("");
  };

  async function regenerate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setCodes((await totpCall({ action: "regenerate", code })).recoveryCodes);
      setCode("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await totpCall({ action: "disable", password, code });
      reset();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-zinc-500" />
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              Two-factor authentication
              {state && (state.enabled ? <Badge variant="secondary">On</Badge> : <Badge variant="outline">Off</Badge>)}
            </CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {state && !state.enabled && mode !== "enrol" && (
          <div className="grid gap-2">
            {state.required && <p className="text-sm text-amber-600">Required for your account.</p>}
            <div>
              <Button size="sm" onClick={() => setMode("enrol")}>
                Set up
              </Button>
            </div>
          </div>
        )}
        {mode === "enrol" && (
          <TotpEnrol
            username={username}
            onEnabled={load}
            onCancel={reset}
            onDone={() => {
              reset();
              load();
            }}
          />
        )}

        {state?.enabled && mode === "idle" && !codes && (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              {state.recoveryLeft} recovery code{state.recoveryLeft === 1 ? "" : "s"} left.
              {state.required && " Required for your account: it cannot be turned off."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setMode("codes")}>
                New recovery codes
              </Button>
              {!state.required && (
                <Button size="sm" variant="outline" className="text-red-600" onClick={() => setMode("disable")}>
                  Turn off
                </Button>
              )}
            </div>
          </div>
        )}

        {codes && (
          <div className="grid gap-3">
            <RecoveryCodes codes={codes} username={username} />
            <div>
              <Button size="sm" onClick={() => setCodes(null)}>
                I have saved them
              </Button>
            </div>
          </div>
        )}

        {(mode === "codes" || mode === "disable") && !codes && (
          <form onSubmit={mode === "codes" ? regenerate : disable} className="grid max-w-sm gap-3">
            <p className="text-sm text-muted-foreground">
              {mode === "codes"
                ? "New recovery codes replace the old ones, which stop working."
                : "Turning it off signs you in with the password alone again."}
            </p>
            {mode === "disable" && (
              <div className="grid gap-2">
                <Label htmlFor="totp-off-pw">Password</Label>
                <Input id="totp-off-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            <div className="grid max-w-[12rem] gap-2">
              <Label htmlFor="totp-action-code">Code from the app</Label>
              <Input
                id="totp-action-code"
                value={code}
                onChange={(e) => setCode(codeInput(e.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="font-mono tracking-widest"
                placeholder="123456"
              />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                variant={mode === "disable" ? "destructive" : "default"}
                disabled={busy || code.length !== 6 || (mode === "disable" && !password)}
              >
                {mode === "codes" ? "Make new codes" : "Turn off"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={reset} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** Settings > Security: who has to sign in with a second factor. */
export function TwoFactorPolicyCard() {
  const [require, setRequire] = useState<"none" | "admins" | "all" | null>(null);
  const [without, setWithout] = useState<{ admins: number; others: number } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/twofactor-policy", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setRequire(d.require);
        setWithout(d.withoutTotp ?? null);
      })
      .catch(() => {});
  }, []);

  async function save(value: "none" | "admins" | "all") {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/twofactor-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ require: value }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Not saved.");
      setRequire(d.require);
      setWithout(d.withoutTotp ?? null);
      setMessage({ ok: true, text: "Saved." });
      // Covered now without having it: this session can only set it up.
      const me = await fetch("/api/auth/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (me?.mustSetUpTotp) window.location.assign("/setup-2fa");
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  const options: { value: "none" | "admins" | "all"; label: string; hint: string }[] = [
    { value: "none", label: "Not required", hint: "Each user decides under Settings > Account." },
    { value: "admins", label: "Required for administrators", hint: "Administrators without it have to set it up at their next sign-in." },
    { value: "all", label: "Required for everyone", hint: "Every user without it has to set it up at their next sign-in." },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-zinc-500" />
          <div>
            <CardTitle className="text-base">Two-factor sign-in</CardTitle>
            <CardDescription>Who has to sign in with a code from an authenticator app</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2" role="radiogroup">
          {options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="twofactor-require"
                className="mt-1"
                checked={require === o.value}
                disabled={saving || require === null}
                onChange={() => save(o.value)}
              />
              <span>
                <span className="font-medium">{o.label}</span>
                <span className="block text-muted-foreground">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {without && require !== "none" && (without.admins > 0 || (require === "all" && without.others > 0)) && (
          <p className="text-sm text-amber-600">
            Not set up yet: {without.admins} administrator{without.admins === 1 ? "" : "s"}
            {require === "all" ? `, ${without.others} other user${without.others === 1 ? "" : "s"}` : ""}. They are asked at their next
            sign-in -- you too, if you are one of them.
          </p>
        )}
        {message && <p className={`text-sm ${message.ok ? "text-emerald-600" : "text-red-500"}`}>{message.text}</p>}
      </CardContent>
    </Card>
  );
}
