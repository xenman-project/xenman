"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { NetworkRow, NicRow } from "@/lib/xen-networking";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { xenNet } from "@/components/networking/host-networking";
import { Hint } from "@/components/networking/network-wizard";

// A network's properties, laid out as XenCenter's: General, Custom Fields,
// Network Settings, with XenCenter's texts (GeneralEditPage, EditNetworkPage).
// Admins change them; the server checks again what EditNetworkPage blocks.

type Page = "general" | "custom" | "settings";

const MTU_MIN = 1500;
const MTU_MAX = 9216;
const VLAN_MAX = 4094;
const INTERNAL = "internal";

// EditNetworkPage's bond mode radios; LACP with its load balancing on the vSwitch backend only.
const BOND_CHOICES: { value: string; label: string; lacp: boolean }[] = [
  { value: "balance-slb", label: "Active-active", lacp: false },
  { value: "active-backup", label: "Active-passive", lacp: false },
  { value: "lacp-src_mac", label: "LACP with load balancing based on source MAC address", lacp: true },
  { value: "lacp-tcpudp_ports", label: "LACP with load balancing based on IP and port of source and destination", lacp: true },
];
const bondChoiceOf = (n: NetworkRow) => (n.bondMode === "lacp" ? `lacp-${n.hashing === "tcpudp_ports" ? "tcpudp_ports" : "src_mac"}` : (n.bondMode ?? ""));

function settingsHint(n: NetworkRow): string {
  switch (n.kind) {
    case "physical":
      return "Physical device";
    case "bond":
      return "Bond";
    case "vlan":
      return `VLAN ${n.vlan}`;
    case "sriov":
      return "SR-IOV";
    default:
      return "Internal network";
  }
}

export function NetworkPropertiesDialog({
  conn,
  network: n,
  nics,
  canEdit,
  vswitch,
  onClose,
  onSaved,
}: {
  conn: HostConnection;
  network: NetworkRow;
  /** The coordinator's NICs (EditNetworkPage lists the coordinator's). */
  nics: NicRow[];
  canEdit: boolean;
  vswitch: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [page, setPage] = useState<Page>("general");
  const custom = Object.entries(n.customFields);

  // EditNetworkPage.Editable(): only a VLAN or a network without NIC may change NIC and VLAN.
  const nicEditable = n.kind === "vlan" || n.kind === "internal";
  const choosable = nics.filter((x) => !x.bonded);
  const startNic = n.kind === "internal" ? INTERNAL : (choosable.find((x) => x.device === n.device)?.pifRef ?? INTERNAL);
  const startVlan = n.kind === "vlan" ? n.vlan : "0";

  const [name, setName] = useState(n.name);
  const [description, setDescription] = useState(n.description);
  const [folder, setFolder] = useState(n.folder);
  const [tags, setTags] = useState(n.tags.join(", "));
  const [nicRef, setNicRef] = useState(startNic);
  const [vlanText, setVlanText] = useState(startVlan);
  const [mtuText, setMtuText] = useState(String(n.mtu));
  const [auto, setAuto] = useState(n.auto);
  const [bondChoice, setBondChoice] = useState(bondChoiceOf(n));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What blocks a change (SetNetSettingsEnablement, SetMTUControlEnablement).
  const runningVms = Object.values(conn.vms).filter(
    (vm) => vm.powerState === "Running" && vm.vifs?.some((v) => n.vifs.includes(v)),
  );
  const hasNic = n.kind !== "internal";
  const nicBlock =
    hasNic && n.ipInterface
      ? `(The network's NIC and VLAN cannot be changed as it is in use as the management interface '${n.ipInterface}')`
      : hasNic && runningVms.length
        ? "(The network's NIC and VLAN cannot be changed as there are active VMs attached)"
        : null;
  const selectedInternal = nicRef === INTERNAL;
  const mtuBlock =
    !selectedInternal && n.ipInterface
      ? `(The network's MTU cannot be changed because it is in use as the management interface '${n.ipInterface}')`
      : !selectedInternal && runningVms.length
        ? "(The network's MTU cannot be changed while running VMs are attached)"
        : null;

  const vlan = /^\d+$/.test(vlanText.trim()) ? Number(vlanText) : NaN;
  const mtu = /^\d+$/.test(mtuText.trim()) ? Number(mtuText) : NaN;
  const mtuMin = Math.min(n.mtu, MTU_MIN);
  const mtuMax = Math.max(n.mtu, MTU_MAX);
  const chosenNic = choosable.find((x) => x.pifRef === nicRef);
  const nicChanged = nicEditable && (nicRef !== startNic || (!selectedInternal && vlanText.trim() !== startVlan));
  // The network's own VLAN does not count as taken.
  const vlanTaken =
    !selectedInternal && nicChanged && chosenNic?.vlans.includes(vlan) && !(chosenNic.device === n.device && String(vlan) === n.vlan);
  const vlanMessage = selectedInternal
    ? null
    : Number.isNaN(vlan)
      ? { error: true, text: "Invalid number" }
      : vlan > VLAN_MAX
        ? { error: true, text: `Allowed VLAN range: 0 to ${VLAN_MAX}` }
        : vlanTaken
          ? { error: true, text: "This VLAN number is already in use" }
          : vlan === 0
            ? { error: false, text: "VLAN 0 will receive all traffic not on any other VLAN" }
            : null;
  const mtuChanged = !selectedInternal && mtu !== n.mtu;
  const mtuError = Number.isNaN(mtu) || mtu < mtuMin || mtu > mtuMax;
  const tagList = [...new Set(tags.split(",").map((t) => t.trim()).filter(Boolean))];

  const changes: Record<string, unknown> = {};
  if (name.trim() !== n.name) changes.name = name.trim();
  if (description !== n.description) changes.description = description;
  if (folder.trim() !== n.folder) changes.folder = folder.trim();
  if (tagList.join("\n") !== n.tags.join("\n")) changes.tags = tagList;
  if (auto !== n.auto) changes.auto = auto;
  if (mtuChanged) changes.mtu = mtu;
  if (nicChanged) {
    changes.nic = nicRef;
    if (!selectedInternal) changes.vlan = vlan;
  }
  const bondChanged = n.kind === "bond" && bondChoice !== bondChoiceOf(n);
  if (bondChanged) {
    changes.bondMode = bondChoice.startsWith("lacp-") ? "lacp" : bondChoice;
    if (bondChoice.startsWith("lacp-")) changes.hashing = bondChoice.slice(5);
  }
  const invalid =
    !name.trim() || (mtuChanged && mtuError) || (nicChanged && !selectedInternal && (!chosenNic || Boolean(vlanMessage?.error)));
  // EditNetworkPage.WillDisrupt().
  const disrupts = mtuChanged || nicChanged || bondChanged;

  async function save() {
    if (!Object.keys(changes).length) return onClose();
    setBusy(true);
    setError(null);
    try {
      await xenNet(conn, { action: "network_update", networkRef: n.ref, changes });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const pages: { id: Page; label: string; hint: string }[] = [
    { id: "general", label: "General", hint: name },
    { id: "custom", label: "Custom Fields", hint: custom.length ? custom.map(([k]) => k).join(", ") : "<None>" },
    { id: "settings", label: "Network Settings", hint: settingsHint(n) },
  ];
  const ro = !canEdit || busy;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>&apos;{n.name}&apos; Properties</DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 h-[min(70vh,520px)] flex-col sm:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-56 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
            {pages.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPage(p.id)}
                className={`rounded-md px-3 py-2 text-left text-sm whitespace-nowrap sm:whitespace-normal ${
                  page === p.id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                {p.label}
                <span className="hidden truncate text-xs font-normal text-muted-foreground sm:block">{p.hint}</span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-6 text-sm">
            {page === "general" && (
              <>
                <p className="text-muted-foreground">
                  XenMan provides several methods for labelling and organizing your resources. By using features such as
                  folders and tags you can quickly group and manage resources across your connected servers.
                </p>
                <Row label="Name:">
                  <Input value={name} onChange={(e) => setName(e.target.value)} disabled={ro} maxLength={255} />
                </Row>
                <Row label="Description:" top>
                  <textarea
                    className="min-h-20 w-full rounded-md border bg-background p-2 text-sm disabled:opacity-60"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={ro}
                    maxLength={1000}
                  />
                </Row>
                <Row label="Folder:">
                  <Input value={folder} onChange={(e) => setFolder(e.target.value)} disabled={ro} placeholder="<None>" />
                </Row>
                <Row label="Tags:">
                  <Input value={tags} onChange={(e) => setTags(e.target.value)} disabled={ro} placeholder="<None>" />
                </Row>
                {canEdit && <p className="text-xs text-muted-foreground">Use / for subfolders, e.g. /Storage. Separate tags with commas.</p>}
                <Row label="UUID:">
                  <Input value={n.uuid} disabled readOnly className="font-mono text-xs" />
                </Row>
              </>
            )}

            {page === "custom" &&
              (custom.length === 0 ? (
                <p className="text-muted-foreground">&lt;None&gt;</p>
              ) : (
                custom.map(([k, v]) => (
                  <Row key={k} label={`${k}:`}>
                    <Input value={v} disabled readOnly />
                  </Row>
                ))
              ))}

            {page === "settings" && (
              <>
                <p className="text-muted-foreground">
                  Use the controls below to configure advanced settings for your network. If your changes will result in
                  temporary disruption of the network you will be informed below. Changes will apply to all hosts in a pool.
                </p>
                {nicEditable && (
                  <>
                    <Row label="NIC:">
                      <Select value={nicRef} onValueChange={setNicRef} disabled={ro || Boolean(nicBlock)}>
                        <SelectTrigger className="w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={INTERNAL}>&lt;internal&gt;</SelectItem>
                          {choosable.map((x) => (
                            <SelectItem key={x.pifRef} value={x.pifRef}>
                              {x.nic}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                    <p className="text-xs text-muted-foreground">Network interface card. Can also be an &lt;internal&gt; Virtual Network.</p>
                    <Row label="VLAN:">
                      <Input
                        value={selectedInternal ? "" : vlanText}
                        onChange={(e) => setVlanText(e.target.value)}
                        inputMode="numeric"
                        className="w-28"
                        disabled={ro || selectedInternal || Boolean(nicBlock)}
                      />
                    </Row>
                    {vlanMessage && <Hint error={vlanMessage.error}>{vlanMessage.text}</Hint>}
                    {nicBlock && <p className="text-xs text-muted-foreground">{nicBlock}</p>}
                  </>
                )}
                {n.kind === "bond" && n.bondMode && (
                  <fieldset className="space-y-1 rounded-md border p-3">
                    <legend className="px-1 text-sm">Bond mode</legend>
                    {BOND_CHOICES.filter((c) => !c.lacp || vswitch || n.bondMode === "lacp").map((c) => (
                      <label key={c.value} className="flex items-center gap-2">
                        <input type="radio" checked={bondChoice === c.value} onChange={() => setBondChoice(c.value)} disabled={ro} />
                        {c.label}
                      </label>
                    ))}
                    {bondChoice.startsWith("lacp-") && (
                      <p className="text-xs text-muted-foreground">LACP must also be configured on the switch ports</p>
                    )}
                  </fieldset>
                )}
                <Row label="MTU:">
                  <Input
                    value={mtuText}
                    onChange={(e) => setMtuText(e.target.value)}
                    inputMode="numeric"
                    className="w-28"
                    disabled={ro || selectedInternal || Boolean(mtuBlock)}
                  />
                </Row>
                {mtuBlock ? (
                  <p className="text-xs text-muted-foreground">{mtuBlock}</p>
                ) : (
                  mtuChanged && (
                    <Hint error={mtuError}>{Number.isNaN(mtu) ? "Invalid number" : `Allowed MTU range: ${mtuMin} to ${mtuMax}`}</Hint>
                  )
                )}
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={ro} />
                  Automatically add this network to new virtual machines.
                </label>
                {canEdit && disrupts && (
                  <p className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    Warning: Your network will be temporarily disrupted when you apply these settings
                  </p>
                )}
              </>
            )}

            {error && (
              <p className="flex items-start gap-2 text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          {canEdit ? (
            <>
              <Button disabled={busy || Boolean(invalid)} onClick={save}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                OK
              </Button>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children, top = false }: { label: string; children: React.ReactNode; top?: boolean }) {
  return (
    <div className={`grid grid-cols-[8rem_1fr] gap-3 ${top ? "items-start" : "items-center"}`}>
      <Label className={top ? "pt-2" : undefined}>{label}</Label>
      <div>{children}</div>
    </div>
  );
}
