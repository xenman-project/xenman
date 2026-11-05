"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Info, Loader2, MinusCircle, Plus, X, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { InterfaceRow, NetworkRow } from "@/lib/xen-networking";
import type { StorageAtRisk } from "@/lib/xen-network-actions";
import type { MgmtJob } from "@/lib/network-mgmt-job";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { xenNet } from "@/components/networking/host-networking";
import { ConfirmNameDialog } from "@/components/networking/confirm-name";

// XenCenter's Configure IP Addresses dialog (NetworkingProperties,
// NetworkingPropertiesPage), texts as XenCenter's: the management interface
// and the secondary interfaces of one server -- or of the pool, where a static
// address is the start of a range, one address per server. The management
// interface is changed for one server at a time, on its own, as a job the
// server runs on (lib/network-mgmt-job.ts).

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function validNetmask(m: string): boolean {
  if (!IPV4.test(m)) return false;
  const n = m.split(".").reduce((a, b) => a * 256 + Number(b), 0);
  const hostPart = 0xffffffff - n;
  return n !== 0 && ((hostPart + 1) & hostPart) === 0;
}

interface Page {
  key: string;
  /** The interface this page started from; null for "Add IP address". */
  pifRef: string | null;
  name: string;
  networkRef: string;
  mode: "DHCP" | "Static";
  ip: string;
  netmask: string;
  gateway: string;
}

export function IpConfigDialog({
  conn,
  hostRef,
  objectName,
  hostCount,
  networks,
  interfaces,
  haEnabled,
  coordinator,
  managementOnVlan,
  onClose,
  onSaved,
}: {
  conn: HostConnection;
  /** The server configured, or null for the pool. */
  hostRef: string | null;
  objectName: string;
  hostCount: number;
  /** The networks, each with this server's (or the coordinator's) PIF. */
  networks: NetworkRow[];
  /** The interfaces with an address on this server (or the coordinator). */
  interfaces: InterfaceRow[];
  haEnabled: boolean;
  /** The server is the pool's coordinator: XenMan reaches the pool through it. */
  coordinator: boolean;
  /** The licence allows the management interface on a VLAN. */
  managementOnVlan: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const pool = hostRef === null;
  const management = interfaces.find((i) => i.management) ?? null;
  // The management page, as NetworkingPropertiesPage's primary one.
  const startMg = {
    networkRef: management?.networkRef ?? "",
    mode: (management?.ipSetup === "DHCP" ? "DHCP" : "Static") as "DHCP" | "Static",
    ip: management?.ip ?? "",
    netmask: management?.netmask ?? "",
    gateway: management?.gateway ?? "",
    dns: [...(management?.dns ?? "").split(","), "", "", ""].slice(0, 3).map((d) => d.trim()),
  };
  const [mg, setMg] = useState(startMg);
  const [confirmMg, setConfirmMg] = useState(false);
  const [job, setJob] = useState<MgmtJob | null>(null);
  // MakeProposedInUseMap: networks with a PIF here, no SR-IOV ones.
  const choosable = networks
    .filter((n) => n.pifRef && n.kind !== "sriov")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const [pages, setPages] = useState<Page[]>(() =>
    interfaces
      .filter((i) => !i.management)
      .map((i) => ({
        key: i.pifRef,
        pifRef: i.pifRef,
        name: i.interface === "Unknown" ? "unknown" : i.interface,
        networkRef: i.networkRef,
        mode: i.ipSetup === "DHCP" ? "DHCP" : "Static",
        ip: i.ip,
        netmask: i.netmask,
        gateway: i.gateway,
      })),
  );
  const [selected, setSelected] = useState<string>("management");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageAtRisk[] | null>(null);
  const [added, setAdded] = useState(0);

  // FindOtherPurpose: who else uses a network (the management interface, or another page).
  const usedBy = (networkRef: string, self: string): string | null => {
    if (self !== "management" && networkRef === mg.networkRef) return "the primary interface";
    const other = pages.find((p) => p.key !== self && p.networkRef === networkRef);
    return other ? other.name : null;
  };
  const netName = (ref: string) => choosable.find((n) => n.ref === ref)?.name ?? "";

  const pageValid = (p: Page) =>
    p.name.trim().length > 0 &&
    Boolean(p.networkRef) &&
    !usedBy(p.networkRef, p.key) &&
    (p.mode === "DHCP" || (IPV4.test(p.ip) && validNetmask(p.netmask) && (p.gateway === "" || IPV4.test(p.gateway))));
  const allValid = pages.every(pageValid);

  // What may change on the management page, and whether it did.
  const mgEditable = !pool && !haEnabled;
  const mgNetworks = choosable.filter((n) => managementOnVlan || n.kind !== "vlan" || n.ref === startMg.networkRef);
  const mgChanged = JSON.stringify(mg) !== JSON.stringify(startMg);
  const [startPages] = useState(() => JSON.stringify(pages));
  const pagesChanged = JSON.stringify(pages) !== startPages;
  const mgValid =
    Boolean(mg.networkRef) &&
    !usedBy(mg.networkRef, "management") &&
    !(coordinator && mg.mode === "DHCP" && mgChanged) &&
    (mg.mode === "DHCP" ||
      (IPV4.test(mg.ip) && validNetmask(mg.netmask) && (mg.gateway === "" || IPV4.test(mg.gateway)) && mg.dns.every((d) => d === "" || IPV4.test(d))));
  const both = mgChanged && pagesChanged;

  // The job, followed until it ends; it goes on in the server whatever happens here.
  useEffect(() => {
    if (!job || job.state !== "running") return;
    const t = setTimeout(async () => {
      try {
        const r = await xenNet(conn, { action: "network_job_status", jobId: job.id });
        setJob(r.job);
        if (r.job.state !== "running") onSaved();
      } catch {
        // XenMan's own connection to the pool may be what is moving: ask again.
        setJob({ ...job });
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [job, conn, onSaved]);

  async function startManagement(typed: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await xenNet(conn, {
        action: "network_management_change",
        hostRef,
        networkRef: mg.networkRef,
        mode: mg.mode,
        ...(mg.mode === "Static" ? { ip: mg.ip, netmask: mg.netmask, gateway: mg.gateway, dns: mg.dns.filter(Boolean) } : {}),
        confirmName: typed,
      });
      setConfirmMg(false);
      setJob(r.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // AddButton.Enabled: fewer pages than networks to put an address on.
  const canAdd = choosable.length > pages.length + 1;
  function addPage() {
    // AuxTabName: "Storage 1", "Storage 2", ... not yet taken. SelectFirstUnusedNetwork.
    const names = ["Management Interface", ...pages.map((p) => p.name)];
    let n = 1;
    while (names.includes(`Storage ${n}`)) n++;
    const free = choosable.find((x) => x.ref !== management?.networkRef && !pages.some((p) => p.networkRef === x.ref));
    const key = `new-${added + 1}`;
    setAdded(added + 1);
    setPages([...pages, { key, pifRef: null, name: `Storage ${n}`, networkRef: free?.ref ?? "", mode: "DHCP", ip: "", netmask: "", gateway: "" }]);
    setSelected(key);
  }
  function removePage(key: string) {
    const i = pages.findIndex((p) => p.key === key);
    const rest = pages.filter((p) => p.key !== key);
    setPages(rest);
    setSelected(rest[Math.min(i, rest.length - 1)]?.key ?? "management");
  }
  const update = (key: string, patch: Partial<Page>) => setPages(pages.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  async function save(confirmStorage: boolean) {
    if (mgChanged) {
      setError(null);
      setConfirmMg(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "network_configure_ip",
          ...(hostRef ? { hostRef } : {}),
          interfaces: pages.map(({ pifRef, name, networkRef, mode, ip, netmask, gateway }) => ({
            pifRef,
            name: name.trim(),
            networkRef,
            mode,
            ...(mode === "Static" ? { ip, netmask, gateway } : {}),
          })),
          confirmStorage,
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session?.sessionRef,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 && Array.isArray(json.storage)) {
        setStorage(json.storage);
        return;
      }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const page = pages.find((p) => p.key === selected) ?? null;
  const rangeEnd = (ip: string) => {
    if (!IPV4.test(ip)) return "";
    const b = ip.split(".");
    return `to ${b[0]}.${b[1]}.${b[2]}.${Number(b[3]) + hostCount - 1}`;
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Configure IP Addresses - {objectName}</DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 h-[min(75vh,600px)] flex-col sm:flex-row">
          <nav className="flex shrink-0 flex-col border-b sm:w-60 sm:border-b-0 sm:border-r">
            <div className="flex gap-1 overflow-x-auto p-2 sm:flex-col sm:overflow-y-auto">
              <Tab
                active={selected === "management"}
                onClick={() => setSelected("management")}
                title="Management Interface"
                sub={management ? `${management.network}; ${management.ipSetup}` : "<None>"}
              />
              {pages.map((p) => (
                <Tab
                  key={p.key}
                  active={selected === p.key}
                  onClick={() => setSelected(p.key)}
                  title={p.name || " "}
                  sub={p.networkRef ? `${netName(p.networkRef)}; ${p.mode}` : "<None>"}
                  invalid={!pageValid(p)}
                  onRemove={busy ? undefined : () => removePage(p.key)}
                />
              ))}
            </div>
            <div className="border-t p-2 sm:mt-auto">
              <Button size="sm" variant="outline" className="w-full" disabled={!canAdd || busy} onClick={addPage}>
                <Plus className="mr-1 h-4 w-4" />
                Add IP address
              </Button>
            </div>
          </nav>

          <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-6 text-sm">
            <p className="whitespace-pre-line text-muted-foreground">
              {pool
                ? `Configure IP address settings for server management traffic (the management interface) on all of the servers in pool '${objectName}' here.\nYou can also assign IP addresses for dedicated storage or other types of network traffic (secondary interfaces) in the pool.`
                : `Configure IP address settings for server management traffic (the management interface) on '${objectName}' here.\nYou can also assign IP addresses for dedicated storage or other types of network traffic (secondary interfaces).`}
            </p>

            {job && <JobView job={job} />}

            {!job && selected === "management" && management && (
              <>
                <Row label="Network:">
                  <Select value={mg.networkRef} onValueChange={(v) => setMg({ ...mg, networkRef: v })} disabled={busy || !mgEditable}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="<None>" />
                    </SelectTrigger>
                    <SelectContent>
                      {mgNetworks.map((n) => {
                        const by = usedBy(n.ref, "management");
                        return (
                          <SelectItem key={n.ref} value={n.ref}>
                            {by ? `${n.name} (in use by ${by})` : n.name}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </Row>
                {usedBy(mg.networkRef, "management") && (
                  <Note icon="error">{`${netName(mg.networkRef)} is currently in use by ${usedBy(mg.networkRef, "management")}`}</Note>
                )}
                <p>IP address and DNS server settings:</p>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={mg.mode === "DHCP"} onChange={() => setMg({ ...mg, mode: "DHCP" })} disabled={busy || !mgEditable} />
                  Automatically obtain settings using DHCP
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={mg.mode === "Static"} onChange={() => setMg({ ...mg, mode: "Static" })} disabled={busy || !mgEditable} />
                  Use these settings:
                </label>
                <div className="space-y-3 pl-6">
                  {(
                    [
                      ["IP address:", "ip"],
                      ["Subnet mask:", "netmask"],
                      ["Gateway:", "gateway"],
                    ] as const
                  ).map(([label, key]) => (
                    <Row key={key} label={label}>
                      <Input
                        value={mg[key]}
                        onChange={(e) => setMg({ ...mg, [key]: e.target.value.trim() })}
                        disabled={busy || !mgEditable || mg.mode !== "Static"}
                        className="w-40"
                      />
                    </Row>
                  ))}
                  {["Preferred DNS server:", "Alternate DNS server 1:", "Alternate DNS server 2:"].map((label, i) => (
                    <Row key={label} label={label}>
                      <Input
                        value={mg.dns[i]}
                        onChange={(e) => setMg({ ...mg, dns: mg.dns.map((d, j) => (j === i ? e.target.value.trim() : d)) })}
                        disabled={busy || !mgEditable || mg.mode !== "Static"}
                        className="w-40"
                      />
                    </Row>
                  ))}
                </div>
                {haEnabled && <Note icon="warn">The primary interface cannot be reconfigured because HA is enabled</Note>}
                {pool && !haEnabled && (
                  <Note icon="info">XenMan changes the management interface one server at a time: open a server&apos;s Networking tab for it.</Note>
                )}
                {coordinator && mgChanged && mg.mode === "DHCP" && (
                  <Note icon="error">
                    XenMan reaches the pool through this server and could not find it again under an address from DHCP. Give it a static
                    address, or change it in XenCenter.
                  </Note>
                )}
              </>
            )}

            {!job && page && (
              <>
                <Row label="Name:">
                  <Input value={page.name} onChange={(e) => update(page.key, { name: e.target.value })} disabled={busy} maxLength={100} />
                </Row>
                <Row label="Network:">
                  <Select value={page.networkRef} onValueChange={(v) => update(page.key, { networkRef: v })} disabled={busy}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="<None>" />
                    </SelectTrigger>
                    <SelectContent>
                      {choosable.map((n) => {
                        const by = usedBy(n.ref, page.key);
                        return (
                          <SelectItem key={n.ref} value={n.ref}>
                            {by ? `${n.name} (in use by ${by})` : n.name}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </Row>
                {page.networkRef && usedBy(page.networkRef, page.key) && (
                  <Note icon="error">
                    {usedBy(page.networkRef, page.key) === "the primary interface"
                      ? `${netName(page.networkRef)} is currently in use by the primary interface`
                      : `${netName(page.networkRef)} is currently in use by ${usedBy(page.networkRef, page.key)}`}
                  </Note>
                )}
                <p>IP address settings:</p>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={page.mode === "DHCP"} onChange={() => update(page.key, { mode: "DHCP" })} disabled={busy} />
                  Automatically obtain settings using DHCP
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={page.mode === "Static"} onChange={() => update(page.key, { mode: "Static" })} disabled={busy} />
                  Use these settings:
                </label>
                <div className="space-y-3 pl-6">
                  <Row label={pool ? "IP address range:" : "IP address:"}>
                    <div className="flex items-center gap-2">
                      <Input value={page.ip} onChange={(e) => update(page.key, { ip: e.target.value.trim() })} disabled={busy || page.mode !== "Static"} className="w-40" />
                      {pool && page.mode === "Static" && <span className="text-muted-foreground">{rangeEnd(page.ip)}</span>}
                    </div>
                  </Row>
                  <Row label="Subnet mask:">
                    <Input value={page.netmask} onChange={(e) => update(page.key, { netmask: e.target.value.trim() })} disabled={busy || page.mode !== "Static"} className="w-40" />
                  </Row>
                  <Row label="Gateway:">
                    <Input value={page.gateway} onChange={(e) => update(page.key, { gateway: e.target.value.trim() })} disabled={busy || page.mode !== "Static"} className="w-40" />
                  </Row>
                </div>
                {pool && page.mode === "Static" && (
                  <Note icon="info">Each server gets the next address of the range, in the order of their names.</Note>
                )}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => removePage(page.key)}>
                  Remove IP Address
                </Button>
              </>
            )}

            {storage && (
              <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
                <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Attached storage is reached over an interface you are changing or removing:
                </p>
                <ul className="list-disc pl-6">
                  {storage.map((s, i) => (
                    <li key={i}>
                      {s.sr} ({s.server}) on {s.host}, over {s.interface}
                    </li>
                  ))}
                </ul>
                <p>It may lose its connection, and VMs on it may stop. Go on only if that is intended.</p>
              </div>
            )}

            {!job && both && (
              <Note icon="warn">Change the management interface on its own: save the other interfaces first, or undo their changes.</Note>
            )}

            {error && !confirmMg && (
              <p className="flex items-start gap-2 text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          {job ? (
            <Button variant="outline" disabled={job.state === "running"} onClick={onClose}>
              {job.state === "running" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Close
            </Button>
          ) : storage ? (
            <Button variant="destructive" disabled={busy || !allValid} onClick={() => save(true)}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reconfigure anyway
            </Button>
          ) : (
            <Button disabled={busy || !allValid || both || (mgChanged && !mgValid)} onClick={() => save(false)}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              OK
            </Button>
          )}
          {!job && (
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          )}
        </DialogFooter>
        {confirmMg && (
          <ConfirmNameDialog
            title="Configure IP Addresses"
            message={`You are reconfiguring the primary management interface.  If the new settings are incorrect then XenMan may permanently lose the connection to the server.\n\nYou should only proceed if you have verified that these settings are correct.${
              coordinator
                ? "\n\nThis server is the pool's coordinator: XenMan finds it again under its new address and, if it reached the pool at the old one, takes the new one."
                : ""
            }`}
            confirmName={objectName}
            what="server's name"
            actionLabel="Reconfigure anyway"
            busy={busy}
            error={error}
            onConfirm={startManagement}
            onCancel={() => setConfirmMg(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// The job's steps as it reports them; it may outlast this dialog, and runs on without it.
function JobView({ job }: { job: MgmtJob }) {
  const icon = (state: string) =>
    state === "done" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
    ) : state === "running" ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : state === "failed" ? (
      <XCircle className="h-4 w-4 text-destructive" />
    ) : state === "skipped" ? (
      <MinusCircle className="h-4 w-4 text-muted-foreground" />
    ) : (
      <Circle className="h-4 w-4 text-muted-foreground" />
    );
  return (
    <div className="space-y-3">
      <p className="font-medium">
        {job.state === "running"
          ? "Reconfiguring server networking"
          : job.state === "done"
            ? "Networking reconfiguration done"
            : "Networking reconfiguration failed"}
      </p>
      <ul className="space-y-2">
        {job.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5">{icon(s.state)}</span>
            <span>
              {s.label}
              {s.detail && <span className="block text-xs text-muted-foreground">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      {job.error && <Note icon="error">{job.error}</Note>}
      {job.notes.map((n, i) => (
        <Note key={i} icon="info">
          {n}
        </Note>
      ))}
      {job.state === "running" && (
        <Note icon="info">This goes on in XenMan even if you close the window or the connection to the pool drops for a moment.</Note>
      )}
    </div>
  );
}

function Tab({
  active,
  onClick,
  title,
  sub,
  invalid = false,
  onRemove,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  sub: string;
  invalid?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className={`group flex items-start rounded-md ${active ? "bg-accent" : "hover:bg-accent/50"}`}>
      <button type="button" onClick={onClick} className="min-w-0 flex-1 px-3 py-2 text-left text-sm">
        <span className={`block truncate ${active ? "font-medium" : ""} ${invalid ? "text-destructive" : ""}`}>{title}</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:block">{sub}</span>
      </button>
      {onRemove && (
        <button type="button" title="Remove IP Address" onClick={onRemove} className="p-2 text-muted-foreground hover:text-destructive">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function Note({ icon, children }: { icon: "info" | "warn" | "error"; children: React.ReactNode }) {
  const Icon = icon === "info" ? Info : icon === "warn" ? AlertTriangle : XCircle;
  const color = icon === "info" ? "text-muted-foreground" : icon === "warn" ? "text-amber-600 dark:text-amber-400" : "text-destructive";
  return (
    <p className={`flex items-start gap-2 text-xs ${color}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
      <Label>{label}</Label>
      <div>{children}</div>
    </div>
  );
}
