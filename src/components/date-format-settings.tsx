"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DATE_FORMATS, formatDateTime, type DateFormat } from "@/lib/date-format";
import { useDateFormat } from "@/context/date-format-context";

/** The date format for every user and for XenMan's mails (lib/date-format.ts). */
export function DateFormatSettings() {
  const { format, setFormat } = useDateFormat();
  const [chosen, setChosen] = useState<DateFormat | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const current = chosen ?? format;
  // An example: now, as each format shows it.
  const [example] = useState(() => new Date());

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/display-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFormat: current }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setFormat(data.dateFormat);
        setChosen(null);
        setMessage({ ok: true, text: "Saved." });
      } else {
        setMessage({ ok: false, text: data.error || "Not saved." });
      }
    } catch {
      setMessage({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4" />
          Date format
        </CardTitle>
        <CardDescription>How dates and times are shown, for every user and in the mails XenMan sends.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {DATE_FORMATS.map((f) => (
            <label key={f.value} className="flex cursor-pointer items-center gap-3 text-sm">
              <input
                type="radio"
                name="date-format"
                className="accent-primary"
                checked={current === f.value}
                onChange={() => {
                  setChosen(f.value);
                  setMessage(null);
                }}
              />
              <span className="w-28">{f.label}</span>
              <span className="font-mono text-xs text-muted-foreground">{formatDateTime(example, f.value)}</span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={saving || current === format} onClick={save}>
            Save
          </Button>
          {message && <span className={`text-sm ${message.ok ? "text-emerald-600" : "text-destructive"}`}>{message.text}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
