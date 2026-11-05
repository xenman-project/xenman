"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, LogOut, Monitor, Moon, Server, Settings, Sun } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { useTheme } from "@/context/theme-context";
import { useXen } from "@/context/xen-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PAGE_TITLES: Record<string, string> = {
  "/settings": "Settings",
  "/events": "Notifications",
  "/audit": "Audit Log",
  "/users": "Users",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  operator: "Operator",
  viewer: "Viewer",
};

/** The petrol bar across the top: product left, user right. */
export function AppTopBar() {
  const { username, role } = useAuth();
  const { theme, setTheme } = useTheme();
  const { selectHost } = useXen();
  const router = useRouter();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between bg-[var(--shell-bar)] pl-8 pr-4 text-white">
      <button
        type="button"
        onClick={() => {
          selectHost(null);
          router.push("/");
        }}
        className="flex items-center gap-3.5 text-left text-[#bdf0ed]"
      >
        <span className="flex items-center gap-2 text-[22px] font-light leading-none tracking-tight">
          <Server className="h-[18px] w-[18px]" />
          xenman
        </span>
        <span className="h-5 w-px bg-[#bdf0ed]/60" />
        <span className="text-[16px] leading-none">XenServer Management</span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-white/90 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40">
          {username ?? "…"}
          <ChevronDown className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="font-normal">
            <div className="text-sm font-medium">{username}</div>
            {role && <div className="text-xs text-muted-foreground">{ROLE_LABELS[role] ?? role}</div>}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
            <DropdownMenuRadioItem value="light">
              <Sun className="h-4 w-4" /> Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon className="h-4 w-4" /> Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <Monitor className="h-4 w-4" /> System
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings className="h-4 w-4" /> Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/signed-out";
            }}
          >
            <LogOut className="h-4 w-4" /> Logout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

/** The white strip above every page: where one is, with each step a way back. */
export function AppBreadcrumb() {
  const pathname = usePathname();
  const { state, selectHost, selectXenHost } = useXen();
  const router = useRouter();

  const steps: { label: string; onClick?: () => void }[] = [
    {
      label: "Home",
      onClick: () => {
        selectHost(null);
        router.push("/");
      },
    },
  ];

  const page = PAGE_TITLES[pathname];
  if (page) {
    steps.push({ label: page });
  } else if (state.selectedHostId) {
    const conn = state.connections[state.selectedHostId];
    const hostId = state.selectedHostId;
    const pool = conn?.status === "connected" ? Object.values(conn.pools)[0] : undefined;
    steps.push({
      label: pool?.nameLabel || conn?.host.name || "Pool",
      onClick: () => selectHost(hostId),
    });
    const vm = state.selectedVmRef ? conn?.vms[state.selectedVmRef] : undefined;
    const xenHost = state.selectedXenHostRef ? conn?.hostRecords[state.selectedXenHostRef] : undefined;
    // A VM is shown under the host it runs on, as the tree does.
    const residentHost = vm?.residentOn ? conn?.hostRecords[vm.residentOn] : undefined;
    const hostStep = xenHost ?? residentHost;
    if (hostStep) {
      steps.push({
        label: hostStep.nameLabel,
        onClick: vm ? () => selectXenHost(hostStep.ref) : undefined,
      });
    }
    if (vm) steps.push({ label: vm.nameLabel });
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-4 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        return (
          <span key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-zinc-400" />}
            {step.onClick && !last ? (
              <button
                type="button"
                onClick={step.onClick}
                className="truncate text-[var(--shell-link)] hover:underline"
              >
                {step.label}
              </button>
            ) : (
              <span className="truncate text-zinc-700 dark:text-zinc-300">{step.label}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
