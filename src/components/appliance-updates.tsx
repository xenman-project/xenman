"use client";

import { useDates } from "@/context/date-format-context";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Package,
  RefreshCw,
  RotateCcw,
  Server,
  Upload,
  XCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Manifest {
  version: string;
  commit: string;
  builtAt: string;
  payloadBytes: number;
}

interface Status {
  state: "verifying" | "installing" | "restarting" | "success" | "failed" | "rolled-back";
  message: string;
  fromVersion: string;
  toVersion: string;
  updatedAt: string;
}

interface SystemInfo {
  version: string;
  os: string;
  kernel: string;
  node?: string;
  rebootRequired: boolean;
  pendingSecurityUpdates: number | null;
  lastSecurityRun: string | null;
}

interface Health {
  uptimeSeconds: number;
  load: number[];
  cpus: number;
  memory: { totalBytes: number; availableBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  ssh: "on" | "off" | null;
}

interface UpdateState {
  appliance: boolean;
  enabled?: boolean;
  installing?: boolean;
  status?: Status | null;
  staged?: Manifest | null;
  installed?: { version: string; builtAt: string } | null;
  stagedIsDowngrade?: boolean;
  system?: SystemInfo;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : formatBytes(bytes);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"}, ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/** A labelled usage bar; amber from 85 %, red from 95 %, as the warnings are. */
function Usage({ label, used, total }: { label: string; used: number; total: number }) {
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = percent >= 95 ? "bg-red-600" : percent >= 85 ? "bg-amber-500" : "bg-green-600";
  return (
    <div className="space-y-1">
      <div className="flex justify-between">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-xs">
          {formatSize(used)} of {formatSize(total)} ({percent}%)
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
    </div>
  );
}

export function ApplianceUpdates() {
  const dates = useDates();
  const [data, setData] = useState<UpdateState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Set once the server stops answering during its own restart, so the UI can
  // say what is happening instead of showing a network error.
  const [unreachable, setUnreachable] = useState(false);
  // An installation this page watched: once it succeeds, the page reloads to
  // run the new version -- what is loaded in the browser is still the old one.
  const watching = useRef(false);
  const [reloading, setReloading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/update", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) setData({ appliance: false });
        return;
      }
      const next: UpdateState = await res.json();
      setData(next);
      setUnreachable(false);
      if (next.installing) watching.current = true;
      else if (watching.current) {
        watching.current = false;
        if (next.status?.state === "success") {
          setReloading(true);
          setTimeout(() => window.location.reload(), 1500);
        }
      }
      if (next.appliance) {
        const h = await fetch("/api/appliance/health", { cache: "no-store" });
        if (h.ok) setHealth((await h.json()).health ?? null);
      }
    } catch {
      // Expected while the service restarts mid-update.
      setUnreachable(true);
    }
  }, []);

  // Kicked off from a timer rather than the effect body: calling setState
  // synchronously inside an effect cascades renders, and the linter says so.
  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Poll only while something is happening: an idle appliance has no reason to
  // be asked every two seconds.
  const busy = Boolean(data?.installing) || unreachable;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [busy, load]);

  if (!data || !data.appliance) return null;

  const status = data.status ?? null;
  const system = data.system;

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    setUploadPercent(0);

    // XMLHttpRequest rather than fetch: a package is tens of
    // megabytes and fetch cannot report upload progress.
    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/update");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setUploadPercent(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status !== 200) {
          try {
            setError(JSON.parse(xhr.responseText).error ?? "Upload failed");
          } catch {
            setError("Upload failed");
          }
        }
        resolve();
      };
      xhr.onerror = () => {
        setError("Upload failed");
        resolve();
      };
      xhr.send(file);
    });

    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
    load();
  }

  async function install() {
    setError(null);
    const res = await fetch("/api/update/install", { method: "POST" });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "Could not start the update");
      return;
    }
    watching.current = true;
    setData((prev) => (prev ? { ...prev, installing: true } : prev));
  }

  async function discard() {
    await fetch("/api/update", { method: "DELETE" });
    load();
  }

  const installing = data.installing || unreachable;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4" />
            Appliance
          </CardTitle>
          <CardDescription>Version and operating system of this appliance</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">XenMan</span>
            <span className="font-mono">{system?.version}</span>
          </div>
          {data.installed?.builtAt && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Built</span>
              <span className="text-xs">{dates.dateTime(data.installed.builtAt)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Operating system</span>
            <span>{system?.os}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Kernel</span>
            <span className="font-mono text-xs">{system?.kernel}</span>
          </div>
          {system?.node && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Node.js</span>
              <span className="font-mono text-xs">{system.node}</span>
            </div>
          )}
          {health && (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Running for</span>
                <span>{formatUptime(health.uptimeSeconds)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Load (1 / 5 / 15 min)</span>
                <span className="font-mono text-xs">
                  {health.load.map((l) => l.toFixed(2)).join(" / ")} on {health.cpus} CPU
                  {health.cpus === 1 ? "" : "s"}
                </span>
              </div>
              {health.ssh && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">SSH</span>
                  <span className="text-right">
                    {health.ssh === "on" ? "On" : "Off"}
                    <span className="block text-xs text-muted-foreground">
                      Switched on and off in the VM console menu only
                    </span>
                  </span>
                </div>
              )}
              <Usage
                label="Memory"
                used={health.memory.totalBytes - health.memory.availableBytes}
                total={health.memory.totalBytes}
              />
              {health.disk && (
                <Usage
                  label="Disk"
                  used={health.disk.totalBytes - health.disk.freeBytes}
                  total={health.disk.totalBytes}
                />
              )}
            </>
          )}
          {/* Security updates and restarts have their own card, OsUpdates. */}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            XenMan Updates
          </CardTitle>
          <CardDescription>
            Install a signed update package. Host connections, users and the audit log are
            kept.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!data.enabled && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">Updates are disabled</p>
                <p className="text-muted-foreground">
                  This appliance was built without a release key, so no package can be
                  verified. Rebuild it with a key to enable updates.
                </p>
              </div>
            </div>
          )}

          {installing && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span>
                  {unreachable
                    ? "XenMan is restarting — this page will reconnect on its own"
                    : (status?.message ?? "Working")}
                </span>
              </div>
              <Progress value={undefined} />
              <p className="text-xs text-muted-foreground">
                Do not power off the appliance. If the new version does not answer within a
                minute, the previous one is restored automatically.
              </p>
            </div>
          )}

          {!installing && status?.state === "success" && (
            <div className="flex items-start gap-2 rounded-md border border-green-600/40 bg-green-600/10 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <div>
                <p className="font-medium">Running {status.toVersion}</p>
                <p className="text-muted-foreground">
                  Updated from {status.fromVersion}. The previous version is kept on disk
                  for a manual rollback.
                </p>
                {reloading && (
                  <p className="mt-1 flex items-center gap-2 text-muted-foreground">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading the new version…
                  </p>
                )}
              </div>
            </div>
          )}

          {!installing && (status?.state === "rolled-back" || status?.state === "failed") && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div>
                <p className="font-medium">
                  {status.state === "rolled-back" ? "Update rolled back" : "Update failed"}
                </p>
                <p className="text-muted-foreground">{status.message}</p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p>{error}</p>
            </div>
          )}

          {!installing && data.staged && (
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{data.staged.version}</p>
                  <p className="text-xs text-muted-foreground">
                    {data.staged.commit && `commit ${data.staged.commit} · `}
                    {formatBytes(data.staged.payloadBytes)} · built{" "}
                    {dates.dateTime(data.staged.builtAt)}
                  </p>
                </div>
                {data.stagedIsDowngrade ? (
                  <Badge variant="destructive">older than installed</Badge>
                ) : (
                  <Badge variant="outline">ready to install</Badge>
                )}
              </div>
              {data.stagedIsDowngrade ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <p>
                    This package was built before the version running now. An older release
                    is still genuinely signed but may carry a vulnerability a later one fixed,
                    so the appliance refuses it here. Going back on purpose needs a root shell
                    on the appliance: <code>xenman-updater --allow-downgrade</code>.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Installing stops XenMan for a moment. The package signature is checked
                  before anything is replaced.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => setConfirmOpen(true)}
                  disabled={!data.enabled || data.stagedIsDowngrade}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Install {data.staged.version}
                </Button>
                <Button size="sm" variant="outline" onClick={discard}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Discard
                </Button>
              </div>
            </div>
          )}

          {!installing && !data.staged && (
            <div className="space-y-2">
              {uploading && <Progress value={uploadPercent} />}
              <input
                ref={fileInput}
                type="file"
                accept=".xenup"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={uploading || !data.enabled}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="mr-2 h-4 w-4" />
                {uploading ? `Uploading ${uploadPercent}%` : "Upload update package"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Packages are built with <code>appliance/build-update.sh</code> and end in{" "}
                <code>.xenup</code>.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Install {data.staged?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              XenMan restarts and is unreachable for roughly half a minute. Running VMs and
              your hosts are not affected — only this management interface. If the new
              version fails to start, the current one is restored automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={install}>Install</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
