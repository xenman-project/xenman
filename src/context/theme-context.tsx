"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";
export type SidebarView = "hosts-and-vms" | "hosts-only" | "vms-only" | "folder-view" | "folder-only";
export type SidebarLayout = "flat" | "tree";
export type SearchMode = "dropdown" | "filter";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  sidebarView: SidebarView;
  setSidebarView: (view: SidebarView) => void;
  sidebarLayout: SidebarLayout;
  setSidebarLayout: (layout: SidebarLayout) => void;
  searchMode: SearchMode;
  setSearchMode: (mode: SearchMode) => void;
  eventPolling: boolean;
  setEventPolling: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "xen-theme";
const SIDEBAR_VIEW_KEY = "xen-sidebar-view";
const VALID_SIDEBAR_VIEWS: SidebarView[] = ["hosts-and-vms", "hosts-only", "vms-only", "folder-view", "folder-only"];
const SIDEBAR_LAYOUT_KEY = "xen-sidebar-layout";
const VALID_SIDEBAR_LAYOUTS: SidebarLayout[] = ["flat", "tree"];
const SEARCH_MODE_KEY = "xen-search-mode";
const VALID_SEARCH_MODES: SearchMode[] = ["dropdown", "filter"];
const EVENT_POLLING_KEY = "xen-event-polling";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [sidebarView, setSidebarViewState] = useState<SidebarView>("hosts-and-vms");
  const [sidebarLayout, setSidebarLayoutState] = useState<SidebarLayout>("flat");
  const [searchMode, setSearchModeState] = useState<SearchMode>("dropdown");
  const [eventPolling, setEventPollingState] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (stored && ["light", "dark", "system"].includes(stored)) {
      setThemeState(stored);
    }
    const storedView = localStorage.getItem(SIDEBAR_VIEW_KEY) as SidebarView | null;
    if (storedView && VALID_SIDEBAR_VIEWS.includes(storedView)) {
      setSidebarViewState(storedView);
    }
    const storedLayout = localStorage.getItem(SIDEBAR_LAYOUT_KEY) as SidebarLayout | null;
    if (storedLayout && VALID_SIDEBAR_LAYOUTS.includes(storedLayout)) {
      setSidebarLayoutState(storedLayout);
    }
    const storedSearchMode = localStorage.getItem(SEARCH_MODE_KEY) as SearchMode | null;
    if (storedSearchMode && VALID_SEARCH_MODES.includes(storedSearchMode)) {
      setSearchModeState(storedSearchMode);
    }
    // Load autoRefresh from server; fall back to localStorage while request is in flight
    const storedEventPolling = localStorage.getItem(EVENT_POLLING_KEY);
    if (storedEventPolling !== null) {
      setEventPollingState(storedEventPolling !== "false");
    }
    fetch("/api/auth/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.autoRefresh === "boolean") {
          setEventPollingState(data.autoRefresh);
        }
      })
      .catch(() => {});
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const root = document.documentElement;

    function applyTheme(t: Theme) {
      if (t === "system") {
        const prefersDark = window.matchMedia(
          "(prefers-color-scheme: dark)"
        ).matches;
        root.classList.toggle("dark", prefersDark);
      } else {
        root.classList.toggle("dark", t === "dark");
      }
    }

    applyTheme(theme);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme, mounted]);

  function setTheme(t: Theme) {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
  }

  function setSidebarView(v: SidebarView) {
    setSidebarViewState(v);
    localStorage.setItem(SIDEBAR_VIEW_KEY, v);
    if (v === "folder-view" || v === "folder-only") {
      setSidebarLayoutState("flat");
      localStorage.setItem(SIDEBAR_LAYOUT_KEY, "flat");
      setSearchModeState("filter");
      localStorage.setItem(SEARCH_MODE_KEY, "filter");
    }
  }

  function setSidebarLayout(l: SidebarLayout) {
    setSidebarLayoutState(l);
    localStorage.setItem(SIDEBAR_LAYOUT_KEY, l);
  }

  function setSearchMode(m: SearchMode) {
    setSearchModeState(m);
    localStorage.setItem(SEARCH_MODE_KEY, m);
  }

  function setEventPolling(enabled: boolean) {
    setEventPollingState(enabled);
    localStorage.setItem(EVENT_POLLING_KEY, String(enabled));
    fetch("/api/auth/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoRefresh: enabled }),
    }).catch(() => {});
  }

  // Prevent flash: don't render children until mounted
  // The inline script in layout.tsx handles the initial class
  if (!mounted) {
    return null;
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, sidebarView, setSidebarView, sidebarLayout, setSidebarLayout, searchMode, setSearchMode, eventPolling, setEventPolling }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
