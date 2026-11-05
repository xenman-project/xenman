"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/** The default when switched on. */
const DEFAULT_MINUTES = 60;

/** The inactivity timeout for every user, in hours and minutes. */
export function InactivitySettings() {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [hours, setHours] = useState("1");
  const [mins, setMins] = useState("0");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/session-policy", { cache: "no-store" }).catch(() => null);
      if (cancelled || !res?.ok) return;
      const m: number = (await res.json()).inactivityMinutes ?? 0;
      const shown = m > 0 ? m : DEFAULT_MINUTES;
      setEnabled(m > 0);
      setHours(String(Math.floor(shown / 60)));
      setMins(String(shown % 60));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setMessage(null);
    const total = enabled ? (Number(hours) || 0) * 60 + (Number(mins) || 0) : 0;
    try {
      const res = await fetch("/api/session-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inactivityMinutes: total }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: data.error || "Not saved." });
    } catch {
      setMessage({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  const touched = () => setMessage(null);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-zinc-500" />
          <div>
            <CardTitle className="text-base">Inactivity timeout</CardTitle>
            <CardDescription>Sign out users automatically after a period without input.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Switch
            id="idle-on"
            checked={enabled}
            disabled={!loaded}
            onCheckedChange={(v) => {
              setEnabled(v);
              touched();
            }}
          />
          <Label htmlFor="idle-on">Sign out inactive users</Label>
        </div>
        <div className={`flex flex-wrap items-center gap-2 text-sm ${enabled ? "" : "opacity-50"}`}>
          <Label htmlFor="idle-hours" className="mr-1 font-normal">Inactivity duration:</Label>
          <Input
            id="idle-hours"
            type="number"
            min={0}
            max={24}
            value={hours}
            disabled={!enabled}
            onChange={(e) => {
              setHours(e.target.value);
              touched();
            }}
            className="h-8 w-20"
          />
          <span>hours</span>
          <Input
            id="idle-minutes"
            aria-label="Minutes"
            type="number"
            min={0}
            max={59}
            value={mins}
            disabled={!enabled}
            onChange={(e) => {
              setMins(e.target.value);
              touched();
            }}
            className="h-8 w-20"
          />
          <span>minutes</span>
        </div>
        <p className="text-xs text-zinc-500">5 minutes to 24 hours. Applies to all users.</p>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={!loaded || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          {message && (
            <span className={`text-xs ${message.ok ? "text-emerald-600" : "text-red-500"}`}>{message.text}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
