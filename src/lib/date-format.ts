// How XenMan shows dates and times: one setting for everyone (Settings -> Time,
// kept in display.json), used by the pages and by the mails alike. English (US)
// is the default -- what XenMan always showed in mails.
//
// No server imports: the browser formats with it too. The time zone is the
// reader's: the browser's in the pages, the appliance's in mails.

export type DateFormat = "en-US" | "de-DE" | "iso";

export const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: "en-US", label: "English (US)" },
  { value: "de-DE", label: "German" },
  { value: "iso", label: "ISO 8601" },
];

export const DEFAULT_DATE_FORMAT: DateFormat = "en-US";

export function isDateFormat(v: unknown): v is DateFormat {
  return v === "en-US" || v === "de-DE" || v === "iso";
}

type When = Date | string | number;
const toDate = (d: When) => (d instanceof Date ? d : new Date(d));
const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isoTime(d: Date, seconds: boolean) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ""}`;
}

const DE_DATE: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };

/** "11/4/2026, 2:17:50 PM" / "04.11.2026, 14:17:50" / "2026-11-04 14:17:50". */
export function formatDateTime(when: When, fmt: DateFormat, opts: { seconds?: boolean; timeZone?: string } = {}): string {
  const d = toDate(when);
  if (Number.isNaN(d.getTime())) return String(when);
  const seconds = opts.seconds ?? true;
  if (fmt === "iso" && !opts.timeZone) return `${isoDate(d)} ${isoTime(d, seconds)}`;
  const time: Intl.DateTimeFormatOptions = { hour: fmt === "en-US" ? "numeric" : "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) };
  if (fmt === "iso") {
    // In another zone: the parts in that zone, put together as ISO.
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { ...DE_DATE, ...time, hour12: false, timeZone: opts.timeZone }).formatToParts(d).map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${seconds ? `:${parts.second}` : ""}`;
  }
  const date: Intl.DateTimeFormatOptions = fmt === "de-DE" ? DE_DATE : { day: "numeric", month: "numeric", year: "numeric" };
  return d.toLocaleString(fmt, { ...date, ...time, timeZone: opts.timeZone });
}

/** "11/4/2026" / "04.11.2026" / "2026-11-04". */
export function formatDate(when: When, fmt: DateFormat): string {
  const d = toDate(when);
  if (Number.isNaN(d.getTime())) return String(when);
  if (fmt === "iso") return isoDate(d);
  return d.toLocaleDateString(fmt, fmt === "de-DE" ? DE_DATE : undefined);
}

/** "2:17:50 PM" / "14:17:50" (seconds: false drops them). */
export function formatTime(when: When, fmt: DateFormat, opts: { seconds?: boolean } = {}): string {
  const d = toDate(when);
  if (Number.isNaN(d.getTime())) return String(when);
  const seconds = opts.seconds ?? true;
  if (fmt === "iso") return isoTime(d, seconds);
  return d.toLocaleTimeString(fmt, { hour: fmt === "en-US" ? "numeric" : "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
}
