"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The build this page was loaded from. */
const LOADED = process.env.NEXT_PUBLIC_GIT_COMMIT ?? "";
const POLL_MS = 60 * 1000;

/**
 * A strip across every page once XenMan runs a newer build than the one this
 * page came from -- after an update, until the page is reloaded. Not reloaded
 * by itself: someone may be halfway through a form.
 */
export function VersionBanner() {
  const [running, setRunning] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const version = (await res.json()).version;
      if (typeof version === "string" && version && LOADED && version !== LOADED) setRunning(version);
    } catch {
      // Expected while XenMan restarts for its update.
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(check, POLL_MS);
    const visible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [check]);

  if (!running) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-sky-600/40 bg-sky-600/15 px-4 py-2 text-sm text-sky-900 dark:text-sky-200"
    >
      <RefreshCw className="h-4 w-4 shrink-0" />
      <span className="flex-1">XenMan has been updated to {running}. Reload the page to use the new version.</span>
      <Button size="sm" variant="outline" className="h-7" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
