"use client";

// XenCenter's ShinyBar (Controls/Ballooning/ShinyBar.cs): the grid above a bar
// and the glossy segments in it, shared by the Memory tab and its "Edit...".

import { useEffect, useRef, useState } from "react";
import { memorySize } from "@/lib/xen-memory";

// ShinyBar's palette.
export const XEN = "#a9a9a9"; // DarkGray
export const CONTROL_DOMAIN = "#696969"; // DimGray
export const VM_COLORS = ["#191970", "#4682b4"]; // MidnightBlue, SteelBlue
export const VM_USED = "#228b22"; // ForestGreen
export const UNUSED = "#000000";

/** The element's width, kept up to date. */
export function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); // reports the first size right away
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * ShinyBar.DrawGrid: ticks from half a MiB upwards, doubled until two of them
 * leave room for the longest label; a label on every other tick, above 1 GiB
 * only at whole half-GiB.
 */
export function Grid({ total, width }: { total: number; width: number }) {
  if (width <= 0) return null;
  const bytesPerPixel = total / width;
  const longest = `${Math.round(total / 1024 ** 2)} MB`.length * 7;
  let incr = 1024 ** 2 / 2;
  while ((incr / bytesPerPixel) * 2 < 40 + longest) incr *= 2;
  const ticks: { x: number; label: string | null }[] = [];
  let withLabel = true;
  for (let x = 0; x <= total; x += incr) {
    const show = withLabel && (total <= 1024 ** 3 || x % (1024 ** 3 / 2) === 0);
    ticks.push({ x, label: show ? memorySize(x, false) : null });
    withLabel = !withLabel;
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 -top-7 h-7 text-[11px] text-zinc-400 dark:text-zinc-500">
      {ticks.map((t) => {
        const left = `${(t.x / total) * 100}%`;
        return (
          <div key={t.x}>
            <span className="absolute bottom-0 h-3 w-px bg-zinc-400 dark:bg-zinc-600" style={{ left }} />
            {t.label !== null && (
              <span className="absolute top-0 -translate-x-1/2 whitespace-nowrap" style={{ left }}>
                {t.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A segment as ShinyBar draws it: the colour fading lighter downwards, a shine on the upper half. */
export function Segment({
  color,
  width,
  caption,
  tip,
  grow,
  align = "center",
}: {
  color: string;
  width?: string;
  caption?: string[];
  tip?: string;
  grow?: boolean;
  align?: "center" | "right";
}) {
  return (
    <div
      title={tip}
      className={`relative h-full overflow-hidden ${grow ? "min-w-0 flex-1" : "shrink-0"}`}
      style={{ width: grow ? undefined : width, background: `linear-gradient(to bottom, ${color}, color-mix(in srgb, ${color} 45%, white))` }}
    >
      {/* Centred (or at the right end), from the left when too narrow, the last pixels faded out. */}
      {caption && (
        <div
          className={`absolute inset-0 flex items-center overflow-hidden whitespace-nowrap px-[3px] text-[12px] leading-[1.15] text-white ${
            align === "right" ? "justify-[safe_flex-end]" : "justify-[safe_center]"
          }`}
          style={{ maskImage: "linear-gradient(to right, black calc(100% - 11px), transparent calc(100% - 3px))" }}
        >
          <span>
            {caption.map((line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            ))}
          </span>
        </div>
      )}
      <span
        className="pointer-events-none absolute inset-x-[2px] top-[2px] h-[49%] rounded-t-[3px]"
        style={{ background: "linear-gradient(to bottom, rgba(255,255,255,0.47), rgba(255,255,255,0.12))" }}
      />
    </div>
  );
}

/** memory_dynmin/dynmax_slider_noedit: a line down from the bar with a foot to the left (minimum) or right (maximum). */
export function SliderMark({ kind }: { kind: "min" | "max" }) {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" className="block text-indigo-900 dark:text-indigo-300" aria-hidden>
      <path d={kind === "min" ? "M9.5 0 V13.5 H0" : "M0.5 0 V13.5 H10"} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * memory_dynmin/dynmax_slider: the half triangles one drags (Edit); together a
 * triangle. Lighter under the mouse (…_light), darker while held (…_dark).
 */
export function SliderHandle({ kind, active }: { kind: "min" | "max"; active?: boolean }) {
  const tone = active
    ? "text-indigo-950 dark:text-indigo-100"
    : "text-indigo-800 group-hover:text-indigo-500 dark:text-indigo-300 dark:group-hover:text-indigo-200";
  return (
    <svg width="11" height="18" viewBox="0 0 11 18" className={`block ${tone}`} aria-hidden>
      <path d={kind === "min" ? "M11 0 L11 18 L0 18 Z" : "M0 0 L11 18 L0 18 Z"} fill="currentColor" />
    </svg>
  );
}
