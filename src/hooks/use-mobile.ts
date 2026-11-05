"use client";

import { useSyncExternalStore } from "react";

/** Below Tailwind's `md`: a phone, or a very narrow window. */
const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Whether the screen is phone-narrow; false while rendering on the server. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
