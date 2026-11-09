"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/auth-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_RULES } from "@/lib/password-policy";

/** The rules of the password policy, shown while typing (the server also refuses the user name and common passwords). */
const RULES = PASSWORD_RULES;

/**
 * Where a login with the default password lands: nothing else in XenMan opens
 * until the password is changed (proxy.ts).
 */
export default function ChangePasswordPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const valid = RULES.every((r) => r.ok(next));
  const matches = next === repeat;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!valid) return setError("The new password does not meet the rules below");
    if (!matches) return setError("The passwords do not match");
    setSaving(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error || "The password could not be changed");
        return;
      }
      // A full load: the new session cookie opens the rest of XenMan.
      window.location.href = "/";
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/signed-out";
  }

  return (
    <AuthShell>
      <Card className="w-full max-w-sm border-0 shadow-none dark:bg-transparent">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
            <KeyRound className="h-6 w-6 text-zinc-600 dark:text-zinc-400" />
          </div>
          <CardTitle>Choose a new password</CardTitle>
          <CardDescription>
            You signed in with the default password. Choose your own before you continue — anyone who knows XenMan
            knows the default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="current">Current password</Label>
              <Input
                id="current"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new">New password</Label>
              <Input id="new" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
              <ul className="grid gap-0.5 text-xs">
                {RULES.map((r) => (
                  <li key={r.text} className={r.ok(next) ? "text-green-600 dark:text-green-500" : "text-zinc-500"}>
                    {r.ok(next) ? "✓" : "○"} {r.text}
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="repeat">Repeat the new password</Label>
              <Input
                id="repeat"
                type="password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                autoComplete="new-password"
              />
              {repeat && !matches && <p className="text-xs text-red-600 dark:text-red-400">The passwords do not match</p>}
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <Button type="submit" disabled={saving || !current || !valid || !matches}>
              {saving ? "Saving…" : "Save and continue"}
            </Button>
            <button
              type="button"
              className="text-center text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              onClick={signOut}
            >
              Sign out
            </button>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
