// XenCenter's "Filter by date" steps, plus a custom window.
//
// Kept out of the page so the boundary arithmetic can be reasoned about — and
// tested — on its own.

export type DateRangeKey = "24h" | "3d" | "7d" | "30d" | "custom" | "all";

export const DATE_RANGE_LABELS: Record<DateRangeKey, string> = {
  "24h": "Last 24 hours",
  "3d": "Last 3 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  custom: "Custom range",
  all: "All time",
};

export const DATE_RANGE_ORDER: DateRangeKey[] = ["24h", "3d", "7d", "30d", "custom", "all"];

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESET_DAYS: Partial<Record<DateRangeKey, number>> = {
  "24h": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
};

export interface DateBounds {
  /** Inclusive lower bound, ISO-8601, or undefined for open-ended. */
  since?: string;
  /** Exclusive upper bound, ISO-8601, or undefined for open-ended. */
  until?: string;
}

/**
 * Resolve a range to absolute bounds. `now` is a parameter rather than read from
 * the clock so the result is reproducible.
 *
 * Custom inputs come from <input type="datetime-local">, i.e. wall-clock text in
 * the viewer's zone with no offset — `new Date()` reads those as local, which is
 * what the viewer means. An unparseable or empty side stays open-ended, so a
 * half-filled custom range still narrows on the side that was given.
 */
export function resolveDateRange(
  range: DateRangeKey,
  now: Date,
  customFrom?: string,
  customTo?: string,
): DateBounds {
  if (range === "all") return {};

  if (range === "custom") {
    const bounds: DateBounds = {};
    if (customFrom) {
      const from = new Date(customFrom);
      if (!Number.isNaN(from.getTime())) bounds.since = from.toISOString();
    }
    if (customTo) {
      const to = new Date(customTo);
      if (!Number.isNaN(to.getTime())) bounds.until = to.toISOString();
    }
    // A backwards range would silently show nothing; swapping is what the viewer
    // meant, and it beats an empty table with no explanation.
    if (bounds.since && bounds.until && bounds.since > bounds.until) {
      return { since: bounds.until, until: bounds.since };
    }
    return bounds;
  }

  const days = PRESET_DAYS[range];
  if (days === undefined) return {};
  return { since: new Date(now.getTime() - days * DAY_MS).toISOString() };
}

/**
 * Combine the date filter with the Events view's dismissal marker. The marker is
 * a floor: dismissing hides everything older, and picking a wider date range
 * must not bring it back.
 */
export function applyDismissMarker(bounds: DateBounds, marker?: string): DateBounds {
  if (!marker) return bounds;
  if (!bounds.since) return { ...bounds, since: marker };
  return { ...bounds, since: bounds.since > marker ? bounds.since : marker };
}
