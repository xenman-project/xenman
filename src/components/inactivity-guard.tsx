"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// The last input in any XenMan tab: working in one keeps the others signed in.
const LAST_ACTIVITY_KEY = "xen-last-activity";
/** How long before the end a warning offers to stay. */
const WARN_SECONDS = 60;
/** Writing on every mouse move would be pointless; this is precise enough. */
const SHARE_EVERY_MS = 5_000;
/** A changed setting reaches open tabs within this. */
const POLICY_REFRESH_MS = 5 * 60_000;

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;

function readShared(): number {
  try {
    return Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeShared(at: number) {
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(at));
  } catch {
    // Private mode or blocked storage: this tab still counts its own input.
  }
}

/**
 * Signs out after the inactivity timeout set under Settings. Only input counts -- the pages' own polling does not -- and a minute
 * before the end a dialog offers to stay. Renders nothing while it is off.
 */
export function InactivityGuard() {
  const [minutes, setMinutes] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const lastInput = useRef(0);
  const signingOut = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch("/api/session-policy", { cache: "no-store" }).catch(() => null);
      if (!cancelled && res?.ok) setMinutes((await res.json()).inactivityMinutes ?? 0);
    }
    load();
    const timer = setInterval(load, POLICY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (minutes <= 0) return;
    const limit = minutes * 60_000;
    let lastShared = 0;

    function onInput() {
      const now = Date.now();
      lastInput.current = now;
      if (now - lastShared > SHARE_EVERY_MS) {
        lastShared = now;
        writeShared(now);
      }
    }
    // Opening or reloading a page counts as being there.
    onInput();

    function tick() {
      if (signingOut.current) return;
      const last = Math.max(lastInput.current, readShared());
      const left = limit - (Date.now() - last);
      if (left <= 0) {
        signingOut.current = true;
        fetch("/api/auth/logout", { method: "POST" })
          .catch(() => {})
          .finally(() => {
            window.location.href = "/signed-out?reason=idle";
          });
        return;
      }
      setSecondsLeft(left <= WARN_SECONDS * 1000 ? Math.ceil(left / 1000) : null);
    }

    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { capture: true, passive: true });
    // Every second, so the warning counts down; a sleeping laptop is caught on wake.
    const timer = setInterval(tick, 1000);
    return () => {
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true });
      clearInterval(timer);
    };
  }, [minutes]);

  // Switched off while the warning showed: it goes with it.
  if (minutes <= 0 || secondsLeft === null) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div role="alertdialog" aria-labelledby="idle-title" className="w-full max-w-sm rounded-md border bg-card p-5 shadow-lg">
        <h2 id="idle-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Are you still there?
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          You will be signed out in {secondsLeft} {secondsLeft === 1 ? "second" : "seconds"} due to inactivity.
        </p>
        <div className="mt-4 flex justify-end">
          {/* The click itself is the input that resets the timer. */}
          <Button size="sm" onClick={() => setSecondsLeft(null)}>
            Stay signed in
          </Button>
        </div>
      </div>
    </div>
  );
}
