"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ShieldAlert, X } from "lucide-react";

interface Warning {
  id: string;
  level: "warn" | "critical";
  message: string;
}

const POLL_MS = 10 * 60 * 1000;

function dismissKey(w: Warning) {
  return `xenman-health-dismissed:${w.id}:${w.level}`;
}

/**
 * A strip across every page for what an admin should act on before it
 * breaks something: a filling disk, an expiring certificate. Admins only, like
 * the security update strip; a warning can be put away for the session, a
 * critical one cannot.
 */
export function ApplianceHealthBanner() {
  const [items, setItems] = useState<Warning[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/appliance/health", { cache: "no-store" });
      if (!res.ok) return setItems([]);
      const next: Warning[] = (await res.json()).warnings ?? [];
      setItems(next);
      try {
        setDismissed(next.filter((w) => sessionStorage.getItem(dismissKey(w)) === "1").map(dismissKey));
      } catch {
        setDismissed([]);
      }
    } catch {
      // A missing strip is better than a broken page.
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  const visible = items.filter((w) => w.level === "critical" || !dismissed.includes(dismissKey(w)));
  if (visible.length === 0) return null;

  function dismiss(w: Warning) {
    try {
      sessionStorage.setItem(dismissKey(w), "1");
    } catch {
      // private mode: dismissed until the next reload only
    }
    setDismissed((d) => [...d, dismissKey(w)]);
  }

  return (
    <>
      {visible.map((w) => {
        const critical = w.level === "critical";
        return (
          <div
            key={w.id}
            role="alert"
            className={`flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm ${
              critical
                ? "border-red-600/40 bg-red-600/15 text-red-900 dark:text-red-200"
                : "border-amber-500/40 bg-amber-500/15 text-amber-900 dark:text-amber-200"
            }`}
          >
            {critical ? <ShieldAlert className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
            <span className="flex-1">
              {w.message}.{" "}
              <Link href="/settings?tab=appliance" className="font-medium underline underline-offset-2">
                {w.id === "cert" ? "Settings → Appliance → HTTPS Certificate" : "Settings → Appliance"}
              </Link>
            </span>
            {!critical && (
              <button
                type="button"
                onClick={() => dismiss(w)}
                className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
                aria-label="Dismiss for this session"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
