"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_DATE_FORMAT, formatDate, formatDateTime, formatTime, isDateFormat, type DateFormat } from "@/lib/date-format";

// The date format set under Settings -> Time, for every page (lib/date-format.ts).

interface DateFormatContext {
  format: DateFormat;
  /** After an admin saved a new one. */
  setFormat: (f: DateFormat) => void;
}

const Ctx = createContext<DateFormatContext>({ format: DEFAULT_DATE_FORMAT, setFormat: () => {} });

export function DateFormatProvider({ children }: { children: React.ReactNode }) {
  const [format, setFormat] = useState<DateFormat>(DEFAULT_DATE_FORMAT);
  useEffect(() => {
    let gone = false;
    fetch("/api/display-settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!gone && d && isDateFormat(d.dateFormat)) setFormat(d.dateFormat);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  const value = useMemo(() => ({ format, setFormat }), [format]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDateFormat() {
  return useContext(Ctx);
}

/** Formatters in the format that is set: dateTime, date, time. */
export function useDates() {
  const { format } = useContext(Ctx);
  const dateTime = useCallback((d: Date | string | number, opts?: { seconds?: boolean }) => formatDateTime(d, format, opts), [format]);
  const date = useCallback((d: Date | string | number) => formatDate(d, format), [format]);
  const time = useCallback((d: Date | string | number, opts?: { seconds?: boolean }) => formatTime(d, format, opts), [format]);
  return useMemo(() => ({ format, dateTime, date, time }), [format, dateTime, date, time]);
}
