"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useXen } from "@/context/xen-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sidebar } from "@/components/sidebar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

const PAGE_TITLES: Record<string, string> = {
  "/settings": "Settings",
  "/events": "Notifications",
  "/audit": "Audit Log",
  "/users": "Users",
};

/**
 * The frame around every page. On a wide screen the sidebar sits beside the
 * content, as always; on a phone it slides in from the left behind a menu
 * button, and closes again once something is picked in it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const { state } = useXen();
  const pathname = usePathname();

  // Picking a pool, host or VM, or going to another page, closes the drawer.
  const where = `${pathname}|${state.selectedHostId}|${state.selectedXenHostRef}|${state.selectedVmRef}`;
  const [shownFor, setShownFor] = useState(where);
  if (where !== shownFor) {
    setShownFor(where);
    if (open) setOpen(false);
  }

  if (!mobile) {
    return (
      <>
        <Sidebar />
        {children}
      </>
    );
  }

  const conn = state.selectedHostId ? state.connections[state.selectedHostId] : undefined;
  const title =
    PAGE_TITLES[pathname] ??
    (state.selectedVmRef && conn?.vms[state.selectedVmRef]?.nameLabel) ??
    (state.selectedXenHostRef && conn?.hostRecords[state.selectedXenHostRef]?.nameLabel) ??
    conn?.host.name ??
    "Dashboard";

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 bg-[var(--shell-bar)] px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-white">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white/90 hover:bg-white/10"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="truncate text-sm font-semibold">{title || "XenMan"}</span>
      </header>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          // Quicker than the sheet's default 500 ms, which felt sluggish on a phone.
          className="w-[85vw] max-w-sm gap-0 border-0 bg-[var(--shell-nav)] p-0 text-white pt-[env(safe-area-inset-top)] data-[state=closed]:duration-150 data-[state=open]:duration-200"
          // No focus ring on the first entry, and no keyboard popping up.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <SheetTitle className="sr-only">XenMan</SheetTitle>
          <SheetDescription className="sr-only">Pools, hosts, VMs and pages</SheetDescription>
          <Sidebar variant="drawer" />
        </SheetContent>
      </Sheet>
      <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
