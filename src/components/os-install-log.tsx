"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "lucide-react";

const POLL_MS = 1500;
/** What the browser keeps; a runaway log must not grow the page without end. */
const MAX_CHARS = 512 * 1024;

interface Chunk {
  exists: boolean;
  run: string | null;
  text: string;
  next: number;
  reset: boolean;
}

/**
 * The output of the current or last installation of security updates, as a
 * read-only console. While `live`, it follows the log as it grows; otherwise
 * it reads it once. It stays at the bottom unless the reader scrolls up.
 */
export function InstallLog({ live }: { live: boolean }) {
  const [text, setText] = useState("");
  const [exists, setExists] = useState<boolean | null>(null);
  const position = useRef<{ next: number; run: string | null } | null>(null);
  const inFlight = useRef(false);
  const box = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);

  const fetchMore = useCallback(async () => {
    // Two reads from the same position would show the same lines twice.
    if (inFlight.current) return;
    inFlight.current = true;
    const at = position.current;
    const query = at ? `?from=${at.next}&run=${encodeURIComponent(at.run ?? "")}` : "";
    try {
      const res = await fetch(`/api/os-update/log${query}`, { cache: "no-store" });
      if (!res.ok) return;
      const chunk: Chunk = await res.json();
      setExists(chunk.exists);
      position.current = { next: chunk.next, run: chunk.run };
      if (!at || chunk.reset) setText(chunk.text.slice(-MAX_CHARS));
      else if (chunk.text) setText((t) => (t + chunk.text).slice(-MAX_CHARS));
    } catch {
      // The next poll tries again; a gap is better than a broken card.
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Started from a timer, not the effect body: setState inside an effect
  // cascades renders. When `live` turns false, this reads once more, so the
  // last lines are not lost, and then stops.
  useEffect(() => {
    const first = setTimeout(fetchMore, 0);
    const timer = live ? setInterval(fetchMore, POLL_MS) : undefined;
    return () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }, [live, fetchMore]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  function onScroll() {
    const el = box.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return (
    <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
        <Terminal className="h-3.5 w-3.5" /> Installation log
        {live && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" /> live
          </span>
        )}
      </div>
      <pre
        ref={box}
        onScroll={onScroll}
        className="h-72 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed"
      >
        {text ||
          (exists === false
            ? "No installation has run yet."
            : live
              ? "Waiting for output…"
              : "")}
      </pre>
    </div>
  );
}
