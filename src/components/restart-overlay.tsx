"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Circle, Loader2, Power } from "lucide-react";

const COUNTDOWN_S = 60;
const POLL_MS = 2000;
/** A request that has not answered by then counts as "not reachable". */
const POLL_TIMEOUT_MS = 4000;
/** After this, say that it takes unusually long, and where to look. */
const SLOW_MS = 5 * 60 * 1000;
/** How long "back online" is shown before the page reloads. */
const BACK_HOLD_MS = 3000;

type Phase = "stopping" | "down" | "back";

interface Props {
  /** The boot before the restart; a different one means it has happened. */
  bootId: string | null;
  kernelBefore: string | null;
  /** The kernel the update installed, if it installed one. */
  kernelExpected: string | null;
  /** The reboot request, so a refused one is noticed instead of waited for. */
  requestId: string | null;
  onFailed: (message: string) => void;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A full-screen page while the appliance restarts: a one-minute countdown and
 * the steps the restart goes through, taken from what the appliance actually
 * answers -- the old boot still answering, then nothing, then a new boot. When
 * it is back, sooner or later than the minute, the page reloads.
 */
export function RestartOverlay({ bootId, kernelBefore, kernelExpected, requestId, onFailed }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState<Phase>("stopping");
  const [kernelNow, setKernelNow] = useState<string | null>(null);
  const start = useRef(0);
  const done = useRef(false);
  const failed = useRef(onFailed);

  useEffect(() => {
    failed.current = onFailed;
  }, [onFailed]);

  // The clock.
  useEffect(() => {
    start.current = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - start.current) / 1000), 250);
    return () => clearInterval(timer);
  }, []);

  // Asking the appliance how far it is.
  useEffect(() => {
    let wentDown = false;
    const poll = async () => {
      if (done.current) return;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS);
      try {
        const res = await fetch("/api/os-update/boot", { cache: "no-store", signal: abort.signal });
        if (res.status === 401) {
          // Back, but the session did not survive: log in again.
          done.current = true;
          setPhase("back");
          setTimeout(() => window.location.assign("/login"), BACK_HOLD_MS);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const info = await res.json();
        const newBoot =
          info.bootId && bootId
            ? info.bootId !== bootId
            : // No boot id to compare: answering again after being gone will do.
              wentDown;
        if (newBoot) {
          done.current = true;
          setKernelNow(info.kernel ?? null);
          setPhase("back");
          setTimeout(() => window.location.reload(), BACK_HOLD_MS);
          return;
        }
        // Still the old boot. Before it ever went away, the request may have
        // been refused -- then nothing is going to restart.
        if (!wentDown && info.request?.id === requestId && info.request?.state === "failed") {
          done.current = true;
          failed.current(info.request.message || "The restart was refused");
        }
      } catch {
        wentDown = true;
        setPhase((p) => (p === "back" ? p : "down"));
      } finally {
        clearTimeout(timeout);
      }
    };
    const first = setTimeout(poll, 500);
    const timer = setInterval(poll, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [bootId, requestId]);

  const remaining = COUNTDOWN_S - elapsed;
  const back = phase === "back";
  const slow = !back && elapsed * 1000 > SLOW_MS;
  const progress = back ? 1 : Math.min(1, elapsed / COUNTDOWN_S);
  const R = 70;
  const C = 2 * Math.PI * R;

  const steps: { label: string; state: "done" | "active" | "todo" }[] = [
    { label: "Stopping XenMan", state: phase === "stopping" ? "active" : "done" },
    {
      label: "Restarting the appliance",
      state: phase === "down" ? "active" : back ? "done" : "todo",
    },
    { label: "XenMan is back", state: back ? "done" : "todo" },
  ];

  const kernelChange =
    kernelExpected && kernelBefore && kernelExpected !== kernelBefore
      ? `${kernelBefore} → ${kernelExpected}`
      : null;

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="polite"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-950/95 p-4 text-zinc-100 backdrop-blur-sm"
    >
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="flex items-center justify-center gap-2 text-lg font-semibold">
          <Power className="h-5 w-5" />
          {back ? "Restart complete" : "Restart in progress"}
        </div>

        <div className="relative mx-auto h-44 w-44">
          <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90">
            <circle cx="80" cy="80" r={R} fill="none" strokeWidth="8" className="stroke-zinc-800" />
            <circle
              cx="80"
              cy="80"
              r={R}
              fill="none"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - progress)}
              // No transition into "back": the ring is simply full.
              className={
                back
                  ? "stroke-green-500"
                  : "stroke-sky-500 transition-[stroke-dashoffset] duration-300 ease-linear"
              }
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {back ? (
              <CheckCircle2 className="h-14 w-14 text-green-500" />
            ) : remaining > 0 ? (
              <>
                <span className="font-mono text-4xl tabular-nums">{clock(remaining)}</span>
                <span className="text-xs text-zinc-400">remaining</span>
              </>
            ) : (
              <>
                <Loader2 className="h-10 w-10 animate-spin text-sky-500" />
                <span className="mt-2 font-mono text-xs text-zinc-400 tabular-nums">
                  {clock(elapsed)}
                </span>
              </>
            )}
          </div>
        </div>

        <ul className="mx-auto w-fit space-y-2 text-left text-sm">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center gap-2">
              {s.state === "done" ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : s.state === "active" ? (
                <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
              ) : (
                <Circle className="h-4 w-4 text-zinc-600" />
              )}
              <span className={s.state === "todo" ? "text-zinc-500" : ""}>{s.label}</span>
            </li>
          ))}
        </ul>

        <div className="space-y-1 text-sm text-zinc-400">
          {back ? (
            <p>
              {kernelNow && <span className="break-all">Now running kernel {kernelNow}. </span>}
              Reloading…
            </p>
          ) : (
            <>
              <p>
                {remaining > 0
                  ? "The appliance restarts to activate the installed updates. This takes about a minute."
                  : "Taking a little longer — waiting for XenMan to answer."}
              </p>
              {kernelChange && <p className="break-all font-mono text-xs">Kernel {kernelChange}</p>}
              <p>Your hosts and their VMs keep running.</p>
            </>
          )}
        </div>

        {slow && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-left text-sm text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-2">
              <p>
                The appliance has not come back after five minutes. Look at its console in
                XenCenter or Xen Orchestra to see where the start is stuck. This page keeps
                waiting.
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded border border-amber-500/40 px-2 py-1 text-xs hover:bg-amber-500/10"
              >
                Reload now
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
