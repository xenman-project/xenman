"use client";

import { PoolNatSettings } from "@/components/pool-nat-settings";
import React, { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useXen } from "@/context/xen-context";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApplianceUpdates } from "@/components/appliance-updates";
import { SyslogSettings } from "@/components/syslog-settings";
import { OsUpdates } from "@/components/os-updates";
import { TimeSettings } from "@/components/time-settings";
import { DateFormatSettings } from "@/components/date-format-settings";
import { NetworkSettings } from "@/components/network-settings";
import { AccessSettings } from "@/components/access-settings";
import { TlsCertificate } from "@/components/tls-certificate";
import { InactivitySettings } from "@/components/inactivity-settings";
import {
  Plus,
  Server,
  MoreVertical,
  Pencil,
  Trash2,
  Plug,
  PlugZap,
  ArrowLeft,
  Sun,
  Moon,
  Monitor,
  KeyRound,
  LayoutList,
  List,
  GitBranch,
  GitMerge,
  Search,
  ListFilter,
  Folder,
  FolderOpen,
  Mail,
  ChevronDown,
  ChevronRight,
  Save,
  Send,
  Loader2,
  User,
  HardDrive,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { XenHost, XenHostPublic, SmtpConfig, SmtpEncryption } from "@/lib/types";
import { Activity } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme, SidebarView, SidebarLayout, SearchMode } from "@/context/theme-context";
import { useAuth } from "@/context/auth-context";
import { passwordProblem } from "@/lib/password-policy";
import { CertConfirm, HostTrustPanel, type ProbedCertificate } from "@/components/host-trust";

function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

const defaultHost: Omit<XenHost, "id"> = {
  name: "",
  address: "",
  backupAddress: "",
  port: 443,
  username: "root",
  password: "",
  useSsl: true,
  autoConnect: false,
  sshPort: 22,
};

/** The tabs only administrators see; ?tab=<one of them> opens it. */
const ADMIN_TABS = ["pools", "mail", "security", "appliance"];

export default function SettingsPage() {
  const {
    state,
    addHost,
    updateHost,
    removeHost,
    connectToHost,
    disconnectFromHost,
    poolJoin,
  } = useXen();
  const { role, username: signedInAs } = useAuth();
  const isAdmin = role === "admin";
  const { theme, setTheme, sidebarView, setSidebarView, sidebarLayout, setSidebarLayout, searchMode, setSearchMode, eventPolling, setEventPolling } = useTheme();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<XenHostPublic | null>(null);
  const [formData, setFormData] = useState<Omit<XenHost, "id">>(defaultHost);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // Adding a pool over HTTPS: the certificate it presents, to be compared first.
  // Then, if the address is a pool member, its coordinator's as well.
  const [probe, setProbe] = useState<{
    loading?: boolean;
    cert?: ProbedCertificate;
    coordinator?: { address: string; cert: ProbedCertificate };
    error?: string;
  } | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwChangeError, setPwChangeError] = useState("");
  const [pwChangeSuccess, setPwChangeSuccess] = useState(false);
  const [pwChanging, setPwChanging] = useState(false);
  const [joinPoolHostId, setJoinPoolHostId] = useState<string | null>(null);
  const [joinPoolMasterId, setJoinPoolMasterId] = useState<string>("");
  const [joinPoolName, setJoinPoolName] = useState<string>("");
  const [joinPoolLoading, setJoinPoolLoading] = useState(false);
  const [joinPoolError, setJoinPoolError] = useState<string>("");

  const [pwOpen, setPwOpen] = useState(false);

  // SMTP
  const [smtpOpen, setSmtpOpen] = useState(false);
  const [smtpConfig, setSmtpConfig] = useState<SmtpConfig>({
    host: "", port: 587, username: "", password: "", from: "",
    encryption: "starttls", validateCertificate: true,
  });
  const [smtpLoaded, setSmtpLoaded] = useState(false);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpError, setSmtpError] = useState("");
  const [smtpSuccess, setSmtpSuccess] = useState(false);
  const [smtpTestOpen, setSmtpTestOpen] = useState(false);
  const [smtpTestTo, setSmtpTestTo] = useState("");
  const [smtpTestSending, setSmtpTestSending] = useState(false);
  const [smtpTestError, setSmtpTestError] = useState("");
  const [smtpTestSuccess, setSmtpTestSuccess] = useState(false);
  const [tab, setTab] = useState("account");
  const params = useSearchParams();

  // Links elsewhere open this page where they mean: ?tab=<tab> on that tab
  // (?tab=admin, from before the tabs were split, on Pools), ?addHost straight
  // into the form for a new host. Taken out of the address afterwards, so a
  // reload does not do it again.
  useEffect(() => {
    if (!isAdmin) return;
    const addHost = params.has("addHost");
    const asked = params.get("tab");
    const target = addHost || asked === "admin" ? "pools" : ADMIN_TABS.includes(asked ?? "") ? asked : null;
    if (!target) return;
    const timer = setTimeout(() => {
      setTab(target);
      if (addHost) {
        setEditingHost(null);
        setFormData(defaultHost);
        setDialogOpen(true);
      }
      window.history.replaceState(null, "", "/settings");
    }, 0);
    return () => clearTimeout(timer);
  }, [isAdmin, params]);

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/smtp").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d) setSmtpConfig(d);
      setSmtpLoaded(true);
    }).catch(() => setSmtpLoaded(true));
  }, [isAdmin]);

  async function handleSmtpSave() {
    setSmtpError("");
    setSmtpSuccess(false);
    setSmtpSaving(true);
    try {
      const res = await fetch("/api/smtp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(smtpConfig),
      });
      const data = await res.json();
      if (!res.ok) {
        setSmtpError(data.error || "Failed to save");
      } else {
        setSmtpSuccess(true);
        const refresh = await fetch("/api/smtp");
        if (refresh.ok) {
          const updated = await refresh.json();
          if (updated) setSmtpConfig(updated);
        }
      }
    } catch {
      setSmtpError("Network error");
    } finally {
      setSmtpSaving(false);
    }
  }

  async function handleSmtpTest() {
    setSmtpTestError("");
    setSmtpTestSuccess(false);
    setSmtpTestSending(true);
    try {
      const res = await fetch("/api/smtp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: smtpTestTo }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSmtpTestError(data.error || "Failed to send test email");
      } else {
        setSmtpTestSuccess(true);
      }
    } catch {
      setSmtpTestError("Network error");
    } finally {
      setSmtpTestSending(false);
    }
  }

  function openAddDialog() {
    setProbe(null);
    setEditingHost(null);
    setFormData(defaultHost);
    setDialogOpen(true);
  }

  function openEditDialog(host: XenHostPublic) {
    setProbe(null);
    setEditingHost(host);
    setFormData({
      name: host.name,
      address: host.address,
      backupAddress: host.backupAddress ?? "",
      port: host.port,
      username: host.username,
      // The server no longer sends stored passwords to the browser. Leaving the
      // field empty means "keep the current one" — /api/hosts merges it back.
      password: "",
      useSsl: host.useSsl,
      autoConnect: host.autoConnect ?? false,
      sshPort: host.sshPort ?? 22,
      ...(host.nat ? { nat: host.nat } : {}),
    });
    setDialogOpen(true);
  }

  async function probeCertificate() {
    setProbe({ loading: true });
    const res = await fetch("/api/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "probe", address: formData.address.trim(), port: formData.port }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setProbe(res?.ok ? { cert: json.certificate } : { error: json.error ?? "XenMan did not answer" });
  }

  /**
   * With the confirmed certificate(s): log in once. A member answers with its
   * coordinator, whose certificate is then shown for confirming too.
   */
  async function verifyHost(): Promise<"ok" | "more" | "failed"> {
    if (!probe?.cert) return "failed";
    const cert = probe.cert;
    setProbe({ ...probe, loading: true, error: undefined });
    const res = await fetch("/api/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "verify",
        address: formData.address.trim(),
        port: formData.port,
        username: formData.username,
        password: formData.password,
        fingerprint: cert.fingerprint,
        coordinator: probe.coordinator ? { fingerprint: probe.coordinator.cert.fingerprint } : undefined,
      }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      setProbe({ ...probe, loading: false, error: json.error ?? "XenMan did not answer" });
      return "failed";
    }
    if (json.member) {
      setProbe({ ...probe, loading: false, coordinator: { address: json.coordinator, cert: json.certificate } });
      return "more";
    }
    setProbe({ ...probe, loading: false });
    return "ok";
  }

  async function handleSave() {
    if (!formData.name.trim() || !formData.address.trim()) return;

    if (editingHost) {
      updateHost({ ...formData, id: editingHost.id });
    } else {
      // Over HTTPS: first the certificate, compared by the admin; then a login
      // that must reach exactly that host -- and, for a member, its coordinator.
      if (formData.useSsl && !probe?.cert) {
        await probeCertificate();
        return;
      }
      if (formData.useSsl && (await verifyHost()) !== "ok") return;
      addHost(
        { ...formData, id: generateId() },
        formData.useSsl ? probe?.cert?.fingerprint : undefined,
        formData.useSsl && probe?.coordinator
          ? { address: probe.coordinator.address, fingerprint: probe.coordinator.cert.fingerprint }
          : undefined,
      );
    }

    setDialogOpen(false);
    setFormData(defaultHost);
    setEditingHost(null);
  }

  function canJoinPool(hostId: string): boolean {
    const conn = state.connections[hostId];
    if (!conn || conn.status !== "connected") return false;
    if (Object.keys(conn.hostRecords).length !== 1) return false;
    return state.hosts.some(
      (h) => h.id !== hostId && state.connections[h.id]?.status === "connected",
    );
  }

  function openJoinPoolDialog(hostId: string) {
    setJoinPoolHostId(hostId);
    setJoinPoolMasterId("");
    setJoinPoolName("");
    setJoinPoolError("");
    setJoinPoolLoading(false);
  }

  async function handleJoinPool() {
    if (!joinPoolHostId || !joinPoolMasterId) return;
    setJoinPoolLoading(true);
    setJoinPoolError("");

    const result = await poolJoin(joinPoolHostId, joinPoolMasterId, joinPoolName);

    if (result.success) {
      setJoinPoolHostId(null);
    } else {
      setJoinPoolError(result.error || "Failed to join pool");
      setJoinPoolLoading(false);
    }
  }

  async function handleChangePassword() {
    setPwChangeError("");
    setPwChangeSuccess(false);

    if (!currentPassword || !newPassword) {
      setPwChangeError("Please fill in all fields.");
      return;
    }
    const problem = passwordProblem(newPassword, signedInAs ?? undefined);
    if (problem) {
      setPwChangeError(`${problem}.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwChangeError("New passwords do not match.");
      return;
    }

    setPwChanging(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPwChangeError(data.error || "Failed to change password.");
      } else {
        setPwChangeSuccess(true);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      }
    } catch {
      setPwChangeError("Network error. Please try again.");
    } finally {
      setPwChanging(false);
    }
  }

  function handleDelete(hostId: string) {
    const conn = state.connections[hostId];
    if (conn?.status === "connected") {
      disconnectFromHost(hostId);
    }
    removeHost(hostId);
    setDeleteConfirmId(null);
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-6xl px-3 pb-20 pt-3 sm:px-6 sm:pt-6 md:pb-6">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              Settings
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              Manage your preferences and system configuration
            </p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="account" className="gap-2">
              <User className="h-4 w-4" />
              Account
            </TabsTrigger>
            {isAdmin && (
              <>
                <TabsTrigger value="pools" className="gap-2">
                  <Server className="h-4 w-4" />
                  Pools
                </TabsTrigger>
                <TabsTrigger value="mail" className="gap-2">
                  <Mail className="h-4 w-4" />
                  Mail &amp; Logging
                </TabsTrigger>
                <TabsTrigger value="security" className="gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  Security
                </TabsTrigger>
                <TabsTrigger value="appliance" className="gap-2">
                  <HardDrive className="h-4 w-4" />
                  Appliance
                </TabsTrigger>
              </>
            )}
          </TabsList>

          {/* ── User Tab ── */}
          <TabsContent value="account" className="space-y-6">

            {/* Appearance */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Appearance</CardTitle>
                <CardDescription>
                  Choose the color theme for the interface
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { value: "light" as const, label: "Light", icon: Sun },
                    { value: "dark" as const, label: "Dark", icon: Moon },
                    { value: "system" as const, label: "System", icon: Monitor },
                  ].map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => setTheme(value)}
                      className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors ${
                        theme === value
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                      {label}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Sidebar Display */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <LayoutList className="h-4 w-4 text-zinc-500" />
                  <div>
                    <CardTitle className="text-base">Sidebar Display</CardTitle>
                    <CardDescription>
                      Choose which items to show in the sidebar under each pool
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <Label className="mb-2 block text-xs text-zinc-500">Content</Label>
                    <div className="grid grid-cols-2 gap-3">
                      {([
                        { value: "hosts-and-vms", label: "Hosts & VMs", icon: Server },
                        { value: "hosts-only", label: "Hosts only", icon: Server },
                        { value: "vms-only", label: "VMs only", icon: Monitor },
                        { value: "folder-view", label: "Folder View", icon: Folder },
                        { value: "folder-only", label: "Folder Only", icon: FolderOpen },
                      ] as { value: SidebarView; label: string; icon: typeof Server }[]).map(({ value, label, icon: Icon }) => (
                        <button
                          key={value}
                          onClick={() => setSidebarView(value)}
                          className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors ${
                            sidebarView === value
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                          }`}
                        >
                          <Icon className="h-5 w-5" />
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label className="mb-2 block text-xs text-zinc-500">Layout</Label>
                    <div className="grid grid-cols-2 gap-3 max-w-xs">
                      {([
                        { value: "flat", label: "Flat", icon: List },
                        { value: "tree", label: "Tree", icon: GitBranch },
                      ] as { value: SidebarLayout; label: string; icon: typeof List }[]).map(({ value, label, icon: Icon }) => {
                        const disabled = sidebarView !== "hosts-and-vms";
                        return (
                          <button
                            key={value}
                            onClick={() => !disabled && setSidebarLayout(value)}
                            disabled={disabled}
                            className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors ${
                              disabled
                                ? "cursor-not-allowed opacity-40 border-border text-muted-foreground"
                                : sidebarLayout === value
                                  ? "border-primary bg-primary/5 text-primary"
                                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                            }`}
                          >
                            <Icon className="h-5 w-5" />
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    {sidebarView !== "hosts-and-vms" && (
                      <p className="mt-1.5 text-xs text-zinc-400">
                        Layout option requires &quot;Hosts &amp; VMs&quot; content mode
                      </p>
                    )}
                  </div>
                  <div>
                    <Label className="mb-2 block text-xs text-zinc-500">Search Behavior</Label>
                    <div className="grid grid-cols-2 gap-3 max-w-xs">
                      {([
                        { value: "dropdown", label: "Dropdown", icon: Search, desc: "Show results in a dropdown overlay" },
                        { value: "filter", label: "Filter", icon: ListFilter, desc: "Filter sidebar entries inline" },
                      ] as { value: SearchMode; label: string; icon: typeof Search; desc: string }[]).map(({ value, label, icon: Icon, desc }) => {
                        const disabled = sidebarView === "hosts-only" || sidebarView === "folder-view" || sidebarView === "folder-only";
                        const active = disabled ? (sidebarView === "folder-view" || sidebarView === "folder-only" ? value === "filter" : value === "dropdown") : searchMode === value;
                        return (
                          <button
                            key={value}
                            onClick={() => { if (!disabled) setSearchMode(value); }}
                            disabled={disabled}
                            className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors ${
                              disabled
                                ? "border-border text-muted-foreground/40 cursor-not-allowed opacity-50"
                                : active
                                  ? "border-primary bg-primary/5 text-primary"
                                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                            }`}
                          >
                            <Icon className="h-5 w-5" />
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    {sidebarView === "hosts-only" && (
                      <p className="mt-1.5 text-xs text-zinc-400">
                        Search behavior requires &quot;Hosts &amp; VMs&quot; or &quot;VMs Only&quot; content mode
                      </p>
                    )}
                    {(sidebarView === "folder-view" || sidebarView === "folder-only") && (
                      <p className="mt-1.5 text-xs text-zinc-400">
                        Folder view always uses filter search
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Auto-Refresh */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-zinc-500" />
                  <div>
                    <CardTitle className="text-base">Auto-Refresh</CardTitle>
                    <CardDescription>
                      Periodically refresh host data (status, memory, VMs)
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label>Auto-Refresh</Label>
                    <p className="text-xs text-zinc-500">
                      Automatically refresh host information every 15 seconds. Disable to reduce load with many hosts/VMs.
                    </p>
                  </div>
                  <Switch
                    checked={eventPolling}
                    onCheckedChange={setEventPolling}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Change Password */}
            <Card>
              <CardHeader className="cursor-pointer" onClick={() => setPwOpen(!pwOpen)}>
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-zinc-500" />
                    <div>
                      <CardTitle className="text-base">Change Password</CardTitle>
                      <CardDescription>
                        Update the password for your account
                      </CardDescription>
                    </div>
                  </div>
                  {pwOpen ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
                </div>
              </CardHeader>
              {pwOpen && (
                <CardContent>
                  <div className="grid max-w-sm gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="currentPassword">Current Password</Label>
                      <Input
                        id="currentPassword"
                        type="password"
                        value={currentPassword}
                        onChange={(e) => {
                          setCurrentPassword(e.target.value);
                          setPwChangeError("");
                          setPwChangeSuccess(false);
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="newPassword">New Password</Label>
                      <Input
                        id="newPassword"
                        type="password"
                        value={newPassword}
                        onChange={(e) => {
                          setNewPassword(e.target.value);
                          setPwChangeError("");
                          setPwChangeSuccess(false);
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="confirmPassword">Confirm New Password</Label>
                      <Input
                        id="confirmPassword"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => {
                          setConfirmPassword(e.target.value);
                          setPwChangeError("");
                          setPwChangeSuccess(false);
                        }}
                      />
                    </div>
                    {pwChangeError && (
                      <p className="text-sm text-red-500">{pwChangeError}</p>
                    )}
                    {pwChangeSuccess && (
                      <p className="text-sm text-emerald-600">
                        Password changed successfully.
                      </p>
                    )}
                    <div>
                      <Button
                        size="sm"
                        onClick={handleChangePassword}
                        disabled={pwChanging || !currentPassword || !newPassword || !confirmPassword}
                      >
                        {pwChanging ? "Changing..." : "Change Password"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>

          </TabsContent>

          {/* ── Admin tabs ── */}
          {isAdmin && (
            <>
            {/* Pools: the connections and how they work. */}
            <TabsContent value="pools" className="space-y-6">

              {/* Host Connections */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">Host Connections</CardTitle>
                      <CardDescription>
                        Configure connections to XenServer hosts and pools
                      </CardDescription>
                    </div>
                    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                      <DialogTrigger asChild>
                        <Button size="sm" onClick={openAddDialog}>
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add Host
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-h-[90dvh] overflow-y-auto">
                        <DialogHeader>
                          <DialogTitle>
                            {editingHost ? "Edit Host" : "Add Host Connection"}
                          </DialogTitle>
                          <DialogDescription>
                            {editingHost
                              ? "Update the connection details for this host."
                              : "Add a new XenServer host or pool coordinator to connect to."}
                          </DialogDescription>
                        </DialogHeader>

                        <div className="grid gap-4 py-4">
                          <div className="grid gap-2">
                            <Label htmlFor="name">Display Name</Label>
                            <Input
                              id="name"
                              placeholder="Production Pool"
                              value={formData.name}
                              onChange={(e) =>
                                setFormData({ ...formData, name: e.target.value })
                              }
                            />
                          </div>

                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                            <div className="grid gap-2 sm:col-span-2">
                              <Label htmlFor="address">Host Address</Label>
                              <Input
                                id="address"
                                placeholder="192.168.1.100"
                                value={formData.address}
                                onChange={(e) => {
                                  setProbe(null);
                                  setFormData({
                                    ...formData,
                                    address: e.target.value,
                                  });
                                }}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label htmlFor="port">Port</Label>
                              <Input
                                id="port"
                                type="number"
                                value={formData.port}
                                onChange={(e) => {
                                  setProbe(null);
                                  setFormData({
                                    ...formData,
                                    port: parseInt(e.target.value) || 443,
                                  });
                                }}
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
                            <div className="grid gap-2 sm:col-span-2">
                              <Label htmlFor="backupAddress">Backup Address</Label>
                              <Input
                                id="backupAddress"
                                placeholder="192.168.1.101 (optional)"
                                value={formData.backupAddress ?? ""}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    backupAddress: e.target.value,
                                  })
                                }
                              />
                              <p className="text-xs text-zinc-500">
                                Fallback address if primary host is unreachable
                              </p>
                            </div>
                            <div className="grid gap-2">
                              <Label htmlFor="sshPort">SSH Port</Label>
                              <Input
                                id="sshPort"
                                type="number"
                                value={formData.sshPort ?? 22}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    sshPort: parseInt(e.target.value) || 22,
                                  })
                                }
                              />
                              <p className="text-xs text-zinc-500">
                                For VM export
                              </p>
                            </div>
                          </div>

                          {/* items-start: the password cell is taller because of
                              its hint, and without this the shorter cell's rows
                              stretch and its input drifts out of alignment. */}
                          <div className="grid grid-cols-2 items-start gap-4">
                            <div className="grid gap-2">
                              <Label htmlFor="username">Username</Label>
                              <Input
                                id="username"
                                value={formData.username}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    username: e.target.value,
                                  })
                                }
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label htmlFor="password">Password</Label>
                              <Input
                                id="password"
                                type="password"
                                placeholder={editingHost ? "Unchanged" : ""}
                                value={formData.password}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    password: e.target.value,
                                  })
                                }
                              />
                              {editingHost && (
                                <p className="text-xs text-zinc-500">
                                  Leave empty to keep the stored password.
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center justify-between rounded-lg border p-3">
                            <div>
                              <Label>Use SSL/TLS</Label>
                              <p className="text-xs text-zinc-500">
                                Connect via HTTPS (recommended)
                              </p>
                              {!formData.useSsl && (
                                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                                  Unencrypted: the password and the consoles cross the network in plain text.
                                </p>
                              )}
                            </div>
                            <Switch
                              checked={formData.useSsl}
                              onCheckedChange={(checked) => {
                                setProbe(null);
                                setFormData({ ...formData, useSsl: checked });
                              }}
                            />
                          </div>

                          <div className="flex items-center justify-between rounded-lg border p-3">
                            <div>
                              <Label>Auto-Connect</Label>
                              <p className="text-xs text-zinc-500">
                                Automatically connect on application start
                              </p>
                            </div>
                            <Switch
                              checked={formData.autoConnect ?? false}
                              onCheckedChange={(checked) =>
                                setFormData({ ...formData, autoConnect: checked })
                              }
                            />
                          </div>

                          {/* Where its hosts are reached takes the stored login: once the pool is added. */}
                          {editingHost && (
                            <PoolNatSettings
                              poolId={editingHost.id}
                              poolAddress={formData.address.trim()}
                              value={formData.nat}
                              onChange={(nat) => setFormData((f) => ({ ...f, nat }))}
                            />
                          )}
                        </div>

                        {!editingHost && probe?.cert && (
                          <CertConfirm cert={probe.cert} address={formData.address.trim()} />
                        )}
                        {!editingHost && probe?.coordinator && (
                          <div className="space-y-2">
                            <p className="text-sm">
                              {formData.address.trim()} is a member of a pool; XenMan connects to its coordinator,{" "}
                              <span className="font-medium">{probe.coordinator.address}</span>. Compare its certificate as well:
                            </p>
                            <CertConfirm cert={probe.coordinator.cert} address={probe.coordinator.address} />
                          </div>
                        )}
                        {!editingHost && probe?.error && (
                          <p className="text-sm text-destructive">{probe.error}</p>
                        )}

                        <DialogFooter>
                          <Button
                            variant="outline"
                            onClick={() => setDialogOpen(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={handleSave}
                            disabled={
                              !formData.name.trim() || !formData.address.trim() || probe?.loading === true
                            }
                          >
                            {editingHost
                              ? "Save Changes"
                              : !formData.useSsl
                                ? "Add Host"
                                : probe?.loading
                                  ? "Checking…"
                                  : probe?.coordinator
                                    ? "Compared – trust both and add"
                                    : probe?.cert
                                      ? "Compared – trust and add"
                                      : "Check certificate"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </div>
                </CardHeader>
                <CardContent>
                  {state.hosts.length === 0 ? (
                    <div className="py-8 text-center">
                      <Server className="mx-auto mb-2 h-8 w-8 text-zinc-300 dark:text-zinc-600" />
                      <p className="text-sm text-zinc-500">No hosts configured yet</p>
                      <p className="mt-1 text-xs text-zinc-400">
                        Click &quot;Add Host&quot; to get started
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Address</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="w-12"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {state.hosts.map((host) => {
                          const conn = state.connections[host.id];
                          const status = conn?.status || "disconnected";

                          return (
                            <TableRow key={host.id}>
                              <TableCell className="font-medium">
                                {host.name}
                              </TableCell>
                              <TableCell className="text-zinc-500">
                                {host.address}:{host.port}
                                {host.backupAddress && (
                                  <span className="ml-1 text-zinc-400">
                                    / {host.backupAddress}
                                  </span>
                                )}
                                {host.useSsl && (
                                  <Badge
                                    variant="outline"
                                    className="ml-2 text-[10px]"
                                  >
                                    SSL
                                  </Badge>
                                )}
                                {host.nat?.enabled && (
                                  <Badge variant="outline" className="ml-1 text-[10px]" title="Its hosts are reached at other addresses than XenServer reports">
                                    NAT
                                  </Badge>
                                )}
                                {host.autoConnect && (
                                  <Badge
                                    variant="outline"
                                    className="ml-1 text-[10px] bg-blue-500/10 text-blue-600 border-blue-500/20"
                                  >
                                    Auto
                                  </Badge>
                                )}
                                {host.passwordUnreadable && (
                                  <Badge
                                    variant="outline"
                                    className="ml-1 border-red-600/40 text-[10px] text-red-700 dark:text-red-400"
                                    title="Saved by another XenMan installation: edit the pool and enter the password again."
                                  >
                                    password unreadable
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={
                                    status === "connected"
                                      ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                                      : status === "connecting"
                                        ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                                        : status === "error"
                                          ? "bg-red-500/10 text-red-600 border-red-500/20"
                                          : "bg-zinc-500/10 text-zinc-500 border-zinc-500/20"
                                  }
                                >
                                  {status}
                                </Badge>
                                {conn?.error && (
                                  <p className="mt-0.5 text-[10px] text-red-500">
                                    {conn.error}
                                  </p>
                                )}
                              </TableCell>
                              <TableCell>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0"
                                    >
                                      <MoreVertical className="h-3.5 w-3.5" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    {status === "connected" ? (
                                      <>
                                        <DropdownMenuItem
                                          onClick={() => disconnectFromHost(host.id)}
                                        >
                                          <PlugZap className="mr-2 h-4 w-4" />
                                          Disconnect
                                        </DropdownMenuItem>
                                        {canJoinPool(host.id) && (
                                          <DropdownMenuItem
                                            onClick={() => openJoinPoolDialog(host.id)}
                                          >
                                            <GitMerge className="mr-2 h-4 w-4" />
                                            Join Pool
                                          </DropdownMenuItem>
                                        )}
                                      </>
                                    ) : (
                                      <DropdownMenuItem
                                        onClick={() => connectToHost(host.id)}
                                        disabled={status === "connecting"}
                                      >
                                        <Plug className="mr-2 h-4 w-4" />
                                        Connect
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem
                                      onClick={() => openEditDialog(host)}
                                    >
                                      <Pencil className="mr-2 h-4 w-4" />
                                      Edit
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => setDeleteConfirmId(host.id)}
                                      className="text-red-600"
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              {/* Delete Confirmation Dialog */}
              <Dialog
                open={deleteConfirmId !== null}
                onOpenChange={() => setDeleteConfirmId(null)}
              >
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete Host</DialogTitle>
                    <DialogDescription>
                      Are you sure you want to remove this host connection? This
                      action cannot be undone.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setDeleteConfirmId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
                    >
                      Delete
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {/* Join Pool Dialog */}
              <Dialog
                open={joinPoolHostId !== null}
                onOpenChange={(open) => {
                  if (!open && !joinPoolLoading) setJoinPoolHostId(null);
                }}
              >
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Join Pool</DialogTitle>
                    <DialogDescription>
                      Join &quot;{state.hosts.find((h) => h.id === joinPoolHostId)?.name}&quot; to an
                      existing pool. This host will become a member of the selected pool.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label>Target Pool</Label>
                      <Select
                        value={joinPoolMasterId}
                        onValueChange={(value) => {
                          setJoinPoolMasterId(value);
                          const masterConn = state.connections[value];
                          if (masterConn) {
                            const pools = Object.values(masterConn.pools);
                            setJoinPoolName(pools.length > 0 ? pools[0].nameLabel : "");
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select pool master..." />
                        </SelectTrigger>
                        <SelectContent>
                          {joinPoolHostId &&
                            state.hosts
                              .filter((h) => h.id !== joinPoolHostId && state.connections[h.id]?.status === "connected")
                              .map((h) => {
                                const conn = state.connections[h.id];
                                const pools = conn ? Object.values(conn.pools) : [];
                                const poolLabel = pools.length > 0 && pools[0].nameLabel
                                  ? pools[0].nameLabel
                                  : h.name;
                                return (
                                  <SelectItem key={h.id} value={h.id}>
                                    {poolLabel} ({h.address})
                                  </SelectItem>
                                );
                              })}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="poolName">Pool Name</Label>
                      <Input
                        id="poolName"
                        placeholder="My Pool"
                        value={joinPoolName}
                        onChange={(e) => setJoinPoolName(e.target.value)}
                      />
                      <p className="text-xs text-zinc-500">
                        Optionally rename the pool after joining
                      </p>
                    </div>

                    {joinPoolError && (
                      <p className="text-sm text-red-500">{joinPoolError}</p>
                    )}
                  </div>

                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setJoinPoolHostId(null)}
                      disabled={joinPoolLoading}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleJoinPool}
                      disabled={!joinPoolMasterId || joinPoolLoading}
                    >
                      {joinPoolLoading ? "Joining..." : "Join Pool"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {/* Connection Info */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Connection Info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-zinc-500">
                  <p>
                    Connect to a XenServer host or pool coordinator using the XAPI
                    JSON-RPC interface. The connection is made via the backend to
                    avoid CORS restrictions.
                  </p>
                  <Separator />
                  <div className="space-y-1 text-xs">
                    <p>
                      <strong>Default Port:</strong> 443 (HTTPS)
                    </p>
                    <p>
                      <strong>Protocol:</strong> JSON-RPC v2.0 over HTTPS
                    </p>
                    <p>
                      <strong>Endpoint:</strong> /jsonrpc
                    </p>
                    <p>
                      <strong>Note:</strong> When connecting to a pool, use the pool
                      coordinator&apos;s address.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <HostTrustPanel />
            </TabsContent>

            {/* Mail & Logging: mail and the audit log to a collector. */}
            <TabsContent value="mail" className="space-y-6">
              {/* SMTP Mail Server */}
              <Card>
                <CardHeader className="cursor-pointer" onClick={() => setSmtpOpen(!smtpOpen)}>
                  <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-zinc-500" />
                      <div>
                        <CardTitle className="text-base">Mail Server (SMTP)</CardTitle>
                        <CardDescription>Configure outbound email for alerts and notifications</CardDescription>
                      </div>
                    </div>
                    {smtpOpen ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
                  </div>
                </CardHeader>
                {smtpOpen && (
                  <CardContent>
                    <div className="grid max-w-lg gap-4">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <div className="grid gap-2 sm:col-span-2">
                          <Label htmlFor="smtpHost">SMTP Host</Label>
                          <Input id="smtpHost" placeholder="smtp.example.com" value={smtpConfig.host} onChange={(e) => setSmtpConfig({ ...smtpConfig, host: e.target.value })} />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="smtpPort">Port</Label>
                          <Input id="smtpPort" type="number" value={smtpConfig.port} onChange={(e) => setSmtpConfig({ ...smtpConfig, port: parseInt(e.target.value) || 0 })} />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="grid gap-2">
                          <Label htmlFor="smtpUser">Username</Label>
                          <Input id="smtpUser" placeholder="(optional)" value={smtpConfig.username} onChange={(e) => setSmtpConfig({ ...smtpConfig, username: e.target.value })} />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="smtpPass">Password</Label>
                          <Input id="smtpPass" type="password" value={smtpConfig.password} onChange={(e) => setSmtpConfig({ ...smtpConfig, password: e.target.value })} />
                        </div>
                      </div>

                      <div className="grid gap-2">
                        <Label htmlFor="smtpFrom">Sender Address (From)</Label>
                        <Input id="smtpFrom" placeholder="XenMan <xenman@example.com>" value={smtpConfig.from} onChange={(e) => setSmtpConfig({ ...smtpConfig, from: e.target.value })} />
                      </div>

                      <div className="grid gap-2">
                        <Label htmlFor="smtpPublicUrl">XenMan Address in Emails</Label>
                        <Input
                          id="smtpPublicUrl"
                          placeholder="https://xenman.example.org"
                          value={smtpConfig.publicUrl ?? ""}
                          onChange={(e) => setSmtpConfig({ ...smtpConfig, publicUrl: e.target.value })}
                        />
                        <p className="text-xs text-muted-foreground">
                          Links in emails — password resets, invitations, update reports — point here. Empty:
                          invitations and update reports use the address you are signed in with, password resets
                          this server&apos;s own IP address — never one a request names.
                        </p>
                      </div>

                      <div className="grid gap-2">
                        <Label>Encryption</Label>
                        <Select value={smtpConfig.encryption} onValueChange={(v) => {
                          const enc = v as SmtpEncryption;
                          const portMap: Record<SmtpEncryption, number> = { none: 25, starttls: 587, ssl: 465 };
                          setSmtpConfig({ ...smtpConfig, encryption: enc, port: portMap[enc] });
                        }}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            <SelectItem value="starttls">STARTTLS (Port 587)</SelectItem>
                            <SelectItem value="ssl">SSL/TLS (Port 465)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex items-center justify-between rounded-lg border p-3">
                        <div>
                          <Label>Validate Certificate</Label>
                          <p className="text-xs text-zinc-500">Verify the server TLS certificate</p>
                        </div>
                        <Switch checked={smtpConfig.validateCertificate} onCheckedChange={(checked) => setSmtpConfig({ ...smtpConfig, validateCertificate: checked })} />
                      </div>

                      {smtpError && <p className="text-sm text-red-500">{smtpError}</p>}
                      {smtpSuccess && <p className="text-sm text-emerald-600">SMTP configuration saved.</p>}

                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSmtpSave} disabled={smtpSaving || !smtpConfig.host.trim()}>
                          <Save className="mr-1.5 h-3.5 w-3.5" />
                          {smtpSaving ? "Saving..." : "Save"}
                        </Button>
                        <Dialog open={smtpTestOpen} onOpenChange={(open) => { setSmtpTestOpen(open); if (!open) { setSmtpTestError(""); setSmtpTestSuccess(false); } }}>
                          <DialogTrigger asChild>
                            <Button size="sm" variant="outline" disabled={!smtpLoaded || !smtpConfig.host.trim()} onClick={() => { setSmtpTestTo(""); setSmtpTestError(""); setSmtpTestSuccess(false); }}>
                              <Send className="mr-1.5 h-3.5 w-3.5" />
                              Test
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="sm:max-w-md">
                            <DialogHeader>
                              <DialogTitle>Send Test Email</DialogTitle>
                              <DialogDescription>Send a test email to verify your SMTP configuration.</DialogDescription>
                            </DialogHeader>
                            <div className="grid gap-4 py-2">
                              <div className="grid gap-2">
                                <Label htmlFor="smtpTestTo">Recipient Address</Label>
                                <Input
                                  id="smtpTestTo"
                                  type="email"
                                  placeholder="test@example.com"
                                  value={smtpTestTo}
                                  onChange={(e) => setSmtpTestTo(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter" && smtpTestTo.trim() && !smtpTestSending) handleSmtpTest(); }}
                                />
                              </div>
                              {smtpTestError && <p className="text-sm text-red-500">{smtpTestError}</p>}
                              {smtpTestSuccess && <p className="text-sm text-emerald-600">Test email sent successfully.</p>}
                            </div>
                            <DialogFooter>
                              <Button size="sm" onClick={handleSmtpTest} disabled={smtpTestSending || !smtpTestTo.trim()}>
                                {smtpTestSending ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Sending...</> : <><Send className="mr-1.5 h-3.5 w-3.5" />Send</>}
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      </div>
                    </div>
                  </CardContent>
                )}
              </Card>

              {/* The audit log to a syslog collector (Elastic, Logstash). */}
              <SyslogSettings />
            </TabsContent>

            {/* Security: rules for every user's session, so admins only. */}
            <TabsContent value="security" className="space-y-6">
              <InactivitySettings />
            </TabsContent>

            {/* Appliance: the machine XenMan runs on. The cards render nothing
                off the appliance, except the certificate. */}
            <TabsContent value="appliance" className="space-y-6">
              <ApplianceUpdates />
              <OsUpdates />
              <NetworkSettings />
              <AccessSettings />
              <TimeSettings />
              <DateFormatSettings />
              <TlsCertificate />
            </TabsContent>
            </>
          )}
        </Tabs>
      </div>
    </div>
  );
}
