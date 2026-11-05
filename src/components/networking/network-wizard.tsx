"use client";

import { useState } from "react";
import { Info, Loader2, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { NicRow } from "@/lib/xen-networking";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { xenNet } from "@/components/networking/host-networking";
import { ConfirmNameDialog } from "@/components/networking/confirm-name";

// XenCenter's New Network wizard (NewNetworkWizard, NetWTypeSelect, NetWName,
// NetWDetails, NetWBondDetails/BondDetails, NetWSriovDetails), texts as
// XenCenter's: External, Single-Server Private, Bonded and SR-IOV networks.

type NetType = "external" | "private" | "bond" | "sriov";
type Step = "type" | "name" | "details" | "bond";
type BondChoice = "balance-slb" | "active-backup" | "lacp-src_mac" | "lacp-tcpudp_ports";

const MTU_MIN = 1500;
const MTU_MAX = 9216;
const VLAN_MAX = 4094;

const STEP_INFO: Record<Step, { label: string; title: string }> = {
  type: { label: "Select Type", title: "Choose the type of network to create" },
  name: { label: "Name", title: "Enter a name and description for the new network" },
  details: { label: "Network settings", title: "Configure the new network" },
  bond: { label: "Bond Members", title: "Select members for the new bonded network" },
};

// Helpers.MakeUniqueName: "New Network", then "New Network (1)", "New Network (2)", ...
function makeUniqueName(stub: string, names: string[]): string {
  let name = stub;
  for (let i = 1; names.includes(name); i++) name = `${stub} (${i})`;
  return name;
}

// NetWDetails: the VLAN kept if free on the NIC, else the first free one from 1.
function freeVlan(current: number, taken: number[] | undefined): number {
  if (!taken || !taken.includes(current)) return current;
  for (let i = 1; i <= VLAN_MAX; i++) if (!taken.includes(i)) return i;
  return current;
}

// NewNetworkWizard / NetWName: the default name of each type.
const DEFAULT_NAME: Record<NetType, string> = {
  external: "New Network",
  private: "New Private Network",
  sriov: "New SR-IOV network",
  bond: "",
};

export function NewNetworkWizard({
  conn,
  poolName,
  nics,
  names,
  vswitch,
  haEnabled,
  confirmName,
  sriovLicensed,
  onClose,
  onCreated,
}: {
  conn: HostConnection;
  poolName: string;
  /** The coordinator's NICs and bonds (the wizard's NIC list is the coordinator's). */
  nics: NicRow[];
  /** All network names in the pool, for a unique default name. */
  names: string[];
  vswitch: boolean;
  haEnabled: boolean;
  confirmName: string;
  sriovLicensed: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const choosable = nics.filter((n) => !n.bonded);
  // NetWSriovDetails: NICs that can do SR-IOV and do not yet (XenMan: none in a bond).
  const sriovNics = nics.filter((n) => n.sriovCapable && !n.sriovEnabled && !n.bonded && !n.isBond);
  // NetWTypeSelect: why SR-IOV cannot be chosen.
  const sriovBlock = !sriovLicensed
    ? "'SR-IOV' feature is disabled due to license restrictions on the server."
    : !nics.some((n) => n.sriovCapable)
      ? "SR-IOV networks require an SR-IOV capable NIC."
      : !sriovNics.length
        ? "SR-IOV is already enabled on all the SR-IOV capable NICs."
        : null;
  const [step, setStep] = useState<Step>("type");
  const [type, setType] = useState<NetType>("external");
  const [name, setName] = useState("");
  const [namedFor, setNamedFor] = useState<NetType | null>(null);
  const [description, setDescription] = useState("");
  const [pifRef, setPifRef] = useState(choosable[0]?.pifRef ?? "");
  const [vlanText, setVlanText] = useState(String(freeVlan(0, choosable[0]?.vlans)));
  const [onSriov, setOnSriov] = useState(false);
  const [sriovRef, setSriovRef] = useState(sriovNics[0]?.pifRef ?? "");
  const [mtuText, setMtuText] = useState(String(MTU_MIN));
  const [auto, setAuto] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [bondChoice, setBondChoice] = useState<BondChoice>("balance-slb");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const steps: Step[] = type === "bond" ? ["type", "bond"] : ["type", "name", "details"];
  const index = steps.indexOf(step);
  const last = index === steps.length - 1;

  const nic = choosable.find((n) => n.pifRef === pifRef);
  // "Create the VLAN on the SR-IOV network": only for a NIC with one; its tags are counted apart.
  const vlanOnSriov = onSriov && Boolean(nic?.sriovEnabled);
  const takenVlans = vlanOnSriov ? nic?.sriovVlans : nic?.vlans;
  const vlan = /^\d+$/.test(vlanText.trim()) ? Number(vlanText) : NaN;
  const mtu = /^\d+$/.test(mtuText.trim()) ? Number(mtuText) : NaN;

  // BondDetails: the NICs (not bonds), up to the size limit; the MTU up to the smallest member's.
  const bondLimit = vswitch ? 4 : 2;
  const bondNics = nics.filter((n) => !n.isBond);
  const chosen = bondNics.filter((n) => members.includes(n.pifRef));
  const mtuMax =
    type === "bond"
      ? chosen.length
        ? Math.max(MTU_MIN, Math.min(MTU_MAX, ...chosen.map((n) => n.mtu)))
        : MTU_MAX
      : Math.max(MTU_MIN, Math.min(nic?.mtu ?? MTU_MIN, MTU_MAX));
  const bondName = `Bond ${chosen.map((n) => n.device.replace("eth", "")).sort().join("+")}`;
  const primary = chosen.some((n) => n.management);
  const secondary = chosen.some((n) => n.secondary);
  // BondDetails.CanCreateBond: what stops a bond outright.
  const bondBlock =
    primary && secondary
      ? "This bond cannot be created because both management and secondary interfaces exist on your selected bond members.\n\nBoth types of interface cannot be added to the same bond. Choose different bond members, or move the management interfaces before creating the bond."
      : primary && haEnabled
        ? "Can't create this bond while HA is enabled\n\nA management interface exists on one of the selected NICs. Moving the management interface to the bond could result in HA network heartbeat failure, so this action is not allowed while HA is on.\n\nTo continue, either select different NICs for the bond, or disable HA, create the bond, and then enable HA again."
        : null;

  // NetWDetails.ValidateVLANValue / ValidateMtuValue.
  const vlanMessage: { error: boolean; text: string } | null = Number.isNaN(vlan)
    ? { error: true, text: "Invalid number" }
    : vlan < 0 || vlan > VLAN_MAX
      ? { error: true, text: `Allowed VLAN range: 0 to ${VLAN_MAX}` }
      : takenVlans?.includes(vlan)
        ? { error: true, text: "This VLAN number is already in use" }
        : vlan === 0
          ? { error: false, text: "VLAN 0 will receive all traffic not on any other VLAN" }
          : null;
  const mtuError = Number.isNaN(mtu) || mtu < MTU_MIN || mtu > mtuMax;
  const mtuInfo = Number.isNaN(mtu)
    ? "Invalid number"
    : mtuMax === MTU_MIN
      ? `Allowed MTU value: ${MTU_MIN}`
      : `Allowed MTU range: ${MTU_MIN} to ${mtuMax}`;

  const canNext =
    step === "type" ||
    (step === "name" && name.trim().length > 0) ||
    (step === "details" && type === "sriov" && Boolean(sriovNics.find((n) => n.pifRef === sriovRef))) ||
    (step === "details" && (type === "private" || (type === "external" && Boolean(nic) && !vlanMessage?.error && !mtuError))) ||
    (step === "bond" && chosen.length >= 2 && chosen.length <= bondLimit && !mtuError && !bondBlock);

  function next() {
    if (step === "type") {
      if (type === "bond") return setStep("bond");
      // NetWName.PopulatePage: a default name for the type, again when the type changed.
      if (namedFor !== type) {
        setName(makeUniqueName(DEFAULT_NAME[type], names));
        setNamedFor(type);
      }
      setStep("name");
    } else if (step === "name") {
      // NetWName.CheckUniqueName: a name in use gets " (n)" on its stem.
      if (names.includes(name)) {
        const stem = (name.includes("(") ? name.slice(0, name.indexOf("(")) : name).trimEnd();
        setName(makeUniqueName(stem, names));
      }
      setStep("details");
    }
  }

  async function finish(confirmTyped?: string) {
    setBusy(true);
    setError(null);
    try {
      if (type === "bond") {
        const [mode, hashing] = bondChoice.startsWith("lacp-") ? ["lacp", bondChoice.slice(5)] : [bondChoice, undefined];
        await xenNet(conn, {
          action: "network_create",
          type: "bond",
          pifRefs: chosen.map((n) => n.pifRef),
          mode,
          ...(hashing ? { hashing } : {}),
          mtu,
          auto,
          confirmName: confirmTyped,
        });
      } else if (type === "sriov") {
        await xenNet(conn, { action: "network_create", type: "sriov", name: name.trim(), description, auto, pifRef: sriovRef, confirmName: confirmTyped });
      } else {
        await xenNet(conn, {
          action: "network_create",
          type,
          name: name.trim(),
          description,
          auto,
          ...(type === "external" ? { pifRef, vlan, mtu, ...(vlanOnSriov ? { onSriov: true } : {}) } : {}),
        });
      }
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // BondDetails.CanCreateBond's warnings; XenMan asks for the pool's name each time.
  const bondWarning = primary
    ? "Creating this bond will automatically move the management interface on one of your selected bond members to the bond itself:\n\n- XenMan connections to the pool will temporarily be disturbed\n\n- If your network configuration is incorrect then XenMan may permanently lose the connection to the pool, or pool members may be unable to contact each other."
    : secondary
      ? "Creating this bond will disrupt traffic through the secondary interfaces on the bond members while the interfaces are moved onto the bond itself."
      : `${bondName} will be created on every server of the pool, from the same NICs.`;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-7xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>New Network - {poolName}</DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 h-[min(720px,calc(100dvh-10rem))] flex-col sm:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r">
            {steps.map((s, i) => (
              <div
                key={s}
                className={`rounded-md px-3 py-2 text-sm whitespace-nowrap ${
                  s === step ? "bg-accent font-medium" : i < index ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {STEP_INFO[s].label}
              </div>
            ))}
          </nav>

          <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-6 text-sm">
            <h3 className="text-base font-semibold">{STEP_INFO[step].title}</h3>

            {step === "type" && (
              <>
                <p>Select the type of new network you would like to create:</p>
                <Choice
                  checked={type === "external"}
                  onSelect={() => setType("external")}
                  label="External Network"
                  text="Create a network that passes traffic over one of your VLANs."
                />
                <Choice
                  checked={type === "private"}
                  onSelect={() => setType("private")}
                  label="Single-Server Private Network"
                  text={"Create a network that does not leave each server.\nThis can be used as a private connection between VMs on the same host."}
                />
                <Choice
                  checked={type === "bond"}
                  onSelect={() => setType("bond")}
                  label="Bonded Network"
                  text={"Create a network that bonds together two or more of your NICs.\nThis will create a single higher performing channel."}
                />
                <Choice
                  checked={type === "sriov"}
                  disabled={Boolean(sriovBlock)}
                  onSelect={() => setType("sriov")}
                  label="SR-IOV Network"
                  text="Enable SR-IOV on a NIC and create an SR-IOV network on that NIC."
                  note={sriovBlock ?? undefined}
                />
              </>
            )}

            {step === "name" && (
              <>
                <p>Provide a name and optional description for the new network.</p>
                <Row label="Name:">
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoFocus />
                </Row>
                <Row label="Description:" top>
                  <textarea
                    className="min-h-24 w-full rounded-md border bg-background p-2 text-sm"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={1000}
                  />
                </Row>
              </>
            )}

            {step === "details" && type === "external" && (
              <>
                <p>
                  Your new network will be mapped to an existing physical network interface and assigned a VLAN number to
                  use on that interface. You can select the physical interface you would like to use below.
                </p>
                <Row label="NIC:">
                  <Select
                    value={pifRef}
                    onValueChange={(v) => {
                      setPifRef(v);
                      const picked = choosable.find((n) => n.pifRef === v);
                      if (!Number.isNaN(vlan)) setVlanText(String(freeVlan(vlan, onSriov && picked?.sriovEnabled ? picked.sriovVlans : picked?.vlans)));
                    }}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder="No NIC" />
                    </SelectTrigger>
                    <SelectContent>
                      {choosable.map((n) => (
                        <SelectItem key={n.pifRef} value={n.pifRef}>
                          {n.nic}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>
                {nic?.sriovEnabled && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={onSriov} onChange={(e) => setOnSriov(e.target.checked)} />
                    Create the VLAN on the SR-IOV network
                  </label>
                )}
                <Row label="VLAN:">
                  <Input value={vlanText} onChange={(e) => setVlanText(e.target.value)} inputMode="numeric" className="w-28" />
                </Row>
                {vlanMessage && <Hint error={vlanMessage.error}>{vlanMessage.text}</Hint>}
                <MtuRow mtuText={mtuText} setMtuText={setMtuText} fixed={mtuMax === MTU_MIN} />
                <Hint error={mtuError}>{mtuInfo}</Hint>
                <AutoBox auto={auto} setAuto={setAuto} />
              </>
            )}

            {step === "details" && type === "sriov" && (
              <>
                <p>Select a NIC to enable SR-IOV.</p>
                <Row label="NIC:">
                  <Select value={sriovRef} onValueChange={setSriovRef}>
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder="No NIC" />
                    </SelectTrigger>
                    <SelectContent>
                      {sriovNics.map((n) => (
                        <SelectItem key={n.pifRef} value={n.pifRef}>
                          {n.nic}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                  Automatically add this network to new virtual machines.
                </label>
              </>
            )}

            {step === "details" && type === "private" && (
              <>
                <p>Select whether you would like to automatically add this network to new VMs.</p>
                <AutoBox auto={auto} setAuto={setAuto} />
              </>
            )}

            {step === "bond" && (
              <>
                <p>
                  Select the NICs you would like to use in this bond and the bond settings, and confirm whether this network
                  should be added to new VMs.
                </p>
                {/* Compact, and scrolling in itself when there are many NICs, so the settings stay in view. */}
                <div className="max-h-[26rem] overflow-auto rounded-md border text-xs [&_td]:py-1 [&_th]:h-8">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-background">
                      <TableRow>
                        <TableHead className="w-8" />
                        {["NIC", "MAC", "Link Status", "Speed", "Duplex", "Vendor", "Device", "PCI Bus Path"].map((h) => (
                          <TableHead key={h} className="whitespace-nowrap">
                            {h}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bondNics.map((n) => {
                        const on = members.includes(n.pifRef);
                        const checkable = on || (!n.bond && members.length < bondLimit);
                        const carrier = n.linkStatus === "Connected";
                        return (
                          <TableRow key={n.pifRef} className={checkable ? "" : "text-muted-foreground"}>
                            <TableCell>
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={!checkable || busy}
                                onChange={(e) => setMembers(e.target.checked ? [...members, n.pifRef] : members.filter((m) => m !== n.pifRef))}
                              />
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {n.nic}
                              {n.bond && <span className="ml-1.5 text-muted-foreground">already in {n.bond}</span>}
                            </TableCell>
                            <TableCell className="font-mono">{n.mac}</TableCell>
                            <TableCell className="whitespace-nowrap">{n.linkStatus}</TableCell>
                            <TableCell className="whitespace-nowrap">{carrier ? n.speed : "-"}</TableCell>
                            <TableCell>{carrier ? n.duplex : "-"}</TableCell>
                            <TableCell className="whitespace-nowrap">{n.vendor}</TableCell>
                            <TableCell className="whitespace-nowrap">{n.deviceName}</TableCell>
                            <TableCell className="font-mono">{n.pciBusPath}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
                <fieldset className="space-y-1 rounded-md border p-3">
                  <legend className="px-1">Bond mode</legend>
                  <BondRadio value="balance-slb" choice={bondChoice} set={setBondChoice} label="Active-active" />
                  <BondRadio value="active-backup" choice={bondChoice} set={setBondChoice} label="Active-passive" />
                  {vswitch && (
                    <>
                      <BondRadio value="lacp-src_mac" choice={bondChoice} set={setBondChoice} label="LACP with load balancing based on source MAC address" />
                      <BondRadio
                        value="lacp-tcpudp_ports"
                        choice={bondChoice}
                        set={setBondChoice}
                        label="LACP with load balancing based on IP and port of source and destination"
                      />
                    </>
                  )}
                  {bondChoice.startsWith("lacp-") && <Hint error={false}>LACP must also be configured on the switch ports</Hint>}
                </fieldset>
                <div className="space-y-3 pt-2">
                  <MtuRow mtuText={mtuText} setMtuText={setMtuText} fixed={mtuMax === MTU_MIN} />
                  <Hint error={mtuError}>{mtuInfo}</Hint>
                  <AutoBox auto={auto} setAuto={setAuto} />
                </div>
                </div>
                {bondBlock && <Hint error>{bondBlock}</Hint>}
              </>
            )}

            {error && !confirming && (
              <p className="flex items-start gap-2 whitespace-pre-line text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          <Button variant="outline" disabled={index === 0 || busy} onClick={() => setStep(steps[index - 1])}>
            Previous
          </Button>
          {last ? (
            <Button
              disabled={!canNext || busy}
              onClick={() => {
                if (type !== "bond" && type !== "sriov") return finish();
                setError(null);
                setConfirming(true);
              }}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Finish
            </Button>
          ) : (
            <Button disabled={!canNext} onClick={next}>
              Next
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
        {/* Inside the wizard's content, so the wizard's focus trap lets it be typed into. */}
        {confirming && (
          <ConfirmNameDialog
            title={type === "sriov" ? "New Network" : "Create Bond"}
            message={
              type === "sriov"
                ? "Creating this SR-IOV network will temporarily disturb XenMan connections to the pool.\n\nYou may need to reboot your server(s) to enable SR-IOV network."
                : bondWarning
            }
            confirmName={confirmName}
            actionLabel={type === "sriov" ? "Create SR-IOV anyway" : primary ? "Create bond anyway" : "Create bond"}
            busy={busy}
            error={error}
            onConfirm={(typed) => finish(typed)}
            onCancel={() => setConfirming(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BondRadio({ value, choice, set, label }: { value: BondChoice; choice: BondChoice; set: (v: BondChoice) => void; label: string }) {
  return (
    <label className="flex items-center gap-2">
      <input type="radio" checked={choice === value} onChange={() => set(value)} />
      {label}
    </label>
  );
}

function MtuRow({ mtuText, setMtuText, fixed }: { mtuText: string; setMtuText: (v: string) => void; fixed: boolean }) {
  return (
    <Row label="MTU:">
      <Input value={mtuText} onChange={(e) => setMtuText(e.target.value)} inputMode="numeric" className="w-28" disabled={fixed} />
    </Row>
  );
}

function Choice({
  checked = false,
  disabled = false,
  onSelect,
  label,
  text,
  note,
}: {
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  label: string;
  text: string;
  note?: string;
}) {
  return (
    <label className={`flex gap-3 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
      <input type="radio" name="network-type" className="mt-1" checked={checked} disabled={disabled} onChange={() => onSelect?.()} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block whitespace-pre-line text-muted-foreground">{text}</span>
        {note && (
          <span className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <Info className="h-3.5 w-3.5" />
            {note}
          </span>
        )}
      </span>
    </label>
  );
}

function AutoBox({ auto, setAuto }: { auto: boolean; setAuto: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
      Automatically add this network to new virtual machines
    </label>
  );
}

export function Hint({ error, children }: { error: boolean; children: React.ReactNode }) {
  return (
    <p className={`flex items-start gap-2 whitespace-pre-line text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>
      {error ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      {children}
    </p>
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
