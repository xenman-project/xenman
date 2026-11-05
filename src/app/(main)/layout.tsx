import { XenProvider } from "@/context/xen-context";
import { TaskProvider } from "@/context/task-context";
import { AuthProvider } from "@/context/auth-context";
import { AppShell } from "@/components/app-shell";
import { TaskWidget } from "@/components/task-widget";
import { AlertBell } from "@/components/alert-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OsUpdateBanner } from "@/components/os-update-banner";
import { ApplianceHealthBanner } from "@/components/appliance-health-banner";
import { VersionBanner } from "@/components/version-banner";
import { HostTrustBanner } from "@/components/host-trust";
import { AppBreadcrumb, AppTopBar } from "@/components/app-topbar";
import { InactivityGuard } from "@/components/inactivity-guard";
import { DateFormatProvider } from "@/context/date-format-context";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <DateFormatProvider>
      <XenProvider>
        <TaskProvider>
          <TooltipProvider>
          {/* h-dvh: on a phone the browser's own bars come and go; h-screen would hide the bottom under them. */}
          <div className="flex h-dvh flex-col overflow-hidden bg-[var(--shell-canvas)]">
            {/* On a phone the menu button's bar takes its place. */}
            <div className="hidden md:contents">
              <AppTopBar />
            </div>
            <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* The sidebar beside the content -- or, on a phone, behind a menu button. */}
            <AppShell>
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {/* Renders nothing unless XenMan was updated since this page loaded. */}
                <VersionBanner />
                {/* Renders nothing unless security updates on the appliance are overdue. */}
                <OsUpdateBanner />
                <ApplianceHealthBanner />
                {/* Renders nothing unless a host presented a certificate it is not trusted with. */}
                <HostTrustBanner />
                <div className="hidden md:contents">
                  <AppBreadcrumb />
                </div>
                <main className="flex flex-1 overflow-hidden">{children}</main>
                <footer className="hidden shrink-0 border-t border-zinc-200 bg-[var(--shell-canvas)] px-4 py-1.5 md:flex items-center justify-between text-[11px] text-zinc-400 dark:border-zinc-800">
                  <span className="font-mono">{process.env.NEXT_PUBLIC_GIT_COMMIT}</span>
                </footer>
              </div>
            </AppShell>
            </div>
            {/* One anchored row so the bell and the task pill sit side by side
                and neither jumps when the other appears. */}
            {/* Signs out after the inactivity timeout, when one is set. */}
            <InactivityGuard />
            <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 md:bottom-12">
              <AlertBell />
              <TaskWidget />
            </div>
          </div>
          </TooltipProvider>
        </TaskProvider>
      </XenProvider>
      </DateFormatProvider>
    </AuthProvider>
  );
}
