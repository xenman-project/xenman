"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, XCircle } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { HostNetworking as Data, NetworkRow, NicRow } from "@/lib/xen-networking";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { NetworkPropertiesDialog } from "@/components/networking/network-properties";
import { NewNetworkWizard } from "@/components/networking/network-wizard";
import { IpConfigDialog } from "@/components/networking/ip-config-dialog";
import { ConfirmNameDialog } from "@/components/networking/confirm-name";

// XenCenter's Networking tab: the networks (Name, Description, NIC, VLAN, Auto,
// Link Status, MAC, MTU, SR-IOV) and the interfaces with an IP address. For a
// host (hostRef), or for the pool as a whole. Admins add, change and remove
// networks (Add Network, Properties, Remove Network).

const RELOAD_MS = 30_000;

export async function xenNet(conn: HostConnection, body: Record<string, unknown>) {
  const res = await fetch("/api/xen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      host: conn.connectedVia || conn.host.address,
      port: conn.host.port,
      useSsl: conn.host.useSsl,
      sessionRef: conn.session?.sessionRef,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// Why Remove Network is off for a network (NetworkList.UpdateEnablement,
// DestroyBondCommand; the IP and VM rules are XenMan's own, checked again on the server).
function removeBlock(n: NetworkRow, haEnabled: boolean): string | null {
  if (n.kind === "physical") return "This network cannot be removed because it is a physical device";
  if (n.kind === "bond" && n.management && haEnabled) {
    return "Can't delete this bond while HA is enabled. A management interface exists on one of the bonded NICs; disable HA, delete the bond, and then enable HA again.";
  }
  if (n.kind !== "bond" && n.ipInterface) return `The network carries the interface '${n.ipInterface}'. Remove its IP address first.`;
  if (n.vifCount) return "VMs still have network interfaces on this network";
  return null;
}

// DestroyBondCommand's question, by what the bond carries; XenMan names the VLANs on it besides.
function bondDeleteMessage(n: NetworkRow, vlans: string[]): string {
  const msg = `Are you sure that you want to delete ${n.nic}?`;
  const secondary = Boolean(n.ipInterface && n.ipInterface !== "Management");
  const text = n.management
    ? secondary
      ? `${msg}\n\nDeleting this bond will automatically transfer the management and secondary interfaces on the bond to the first other member of the bond: \n\n- XenMan connections to the pool will temporarily be disturbed\n\n- Traffic through the secondary interface will be disrupted\n\n- If your network configuration is incorrect then XenMan may permanently lose the connection to the pool, or pool members may be unable to contact each other.`
      : `${msg}\n\nDeleting this bond will automatically transfer the management interface on the bond to the first of the bonded members: \n\n- XenMan connections to the pool will temporarily be disturbed\n\n- If your network configuration is incorrect then XenMan may permanently lose the connection to the pool, or pool members may be unable to contact each other.`
    : secondary
      ? `${msg}\n\nDeleting this bond will disrupt traffic through the secondary interface on the bond while the interface is moved to the first of the bonded members.`
      : msg;
  return vlans.length ? `${text}\n\nXenServer moves the VLANs on it (${vlans.join(", ")}) to the first member as well.` : text;
}

export function HostNetworking({ conn, hostRef, isAdmin }: { conn: HostConnection; hostRef: string | null; isAdmin: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [properties, setProperties] = useState<NetworkRow | null>(null);
  // The pool's view, for the coordinator's NICs and every network's name (wizard, properties).
  const [pool, setPool] = useState<Data | null>(null);
  const [wizard, setWizard] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<NetworkRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ipDialog, setIpDialog] = useState(false);
  // A bond is deleted with DestroyBondCommand's question and the pool's name typed in.
  const [confirmBond, setConfirmBond] = useState<NetworkRow | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await xenNet(conn, { action: "host_networking", ...(hostRef ? { hostRef } : {}) }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [conn, hostRef]);

  // Again whenever a network or PIF changes (events), and now and then for the link state.
  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, RELOAD_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, conn.networks, conn.pifs]);

  // XenCenter lists the coordinator's NICs in the wizard and the properties, from any host.
  const loadPool = useCallback(async () => {
    try {
      setPool(hostRef ? await xenNet(conn, { action: "host_networking" }) : data);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, [conn, hostRef, data]);

  async function openWizard() {
    setActionError(null);
    await loadPool();
    setWizard(true);
  }

  async function openProperties(n: NetworkRow) {
    setActionError(null);
    await loadPool();
    setProperties(n);
  }

  async function remove(n: NetworkRow, confirmName?: string) {
    setBusy(true);
    setActionError(null);
    try {
      await xenNet(conn, { action: "network_destroy", networkRef: n.ref, ...(confirmName ? { confirmName } : {}) });
      setSelected(null);
      setConfirmBond(null);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          {error ? <XCircle className="h-4 w-4 text-destructive" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {error ?? "Loading networks…"}
        </CardContent>
      </Card>
    );
  }

  const chosen = data.networks.find((n) => n.ref === selected) ?? null;
  const chosenBlock = chosen ? removeBlock(chosen, data.haEnabled) : null;
  const poolName = Object.values(conn.pools)[0]?.nameLabel || conn.host.name;
  const coordinatorNics: NicRow[] = pool?.nics ?? [];
  const coordinatorRef = Object.values(conn.pools)[0]?.master ?? "";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{hostRef ? "Server Networks" : "Pool Networks"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {["Name", "Description", "NIC", "VLAN", "Auto", "Link Status", "MAC", "MTU", "SR-IOV"].map((h) => (
                    <TableHead key={h} className="whitespace-nowrap">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.networks.map((n) => (
                  <TableRow
                    key={n.ref}
                    onClick={() => setSelected(n.ref)}
                    onDoubleClick={() => openProperties(n)}
                    className={`cursor-pointer ${selected === n.ref ? "bg-accent" : ""}`}
                  >
                    <TableCell className="font-medium whitespace-nowrap">{n.name}</TableCell>
                    <TableCell className="text-muted-foreground">{n.description}</TableCell>
                    <TableCell className="whitespace-nowrap">{n.nic}</TableCell>
                    <TableCell>{n.vlan}</TableCell>
                    <TableCell>{n.auto ? "Yes" : "No"}</TableCell>
                    <TableCell className="whitespace-nowrap">{n.linkStatus}</TableCell>
                    <TableCell className="font-mono text-xs">{n.mac}</TableCell>
                    <TableCell>{n.mtu}</TableCell>
                    <TableCell>{n.sriov}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && (
              <Button size="sm" variant="outline" disabled={busy} onClick={openWizard}>
                Add Network
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={!chosen || busy} onClick={() => chosen && openProperties(chosen)}>
              Properties
            </Button>
            {isAdmin && (
              <span title={chosenBlock ?? undefined}>
                <Button size="sm" variant="outline" disabled={!chosen || Boolean(chosenBlock) || busy} onClick={() => (chosen?.kind === "bond" ? (setActionError(null), setConfirmBond(chosen)) : setConfirmRemove(chosen))}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Remove Network
                </Button>
              </span>
            )}
            {isAdmin && chosenBlock && <span className="text-xs text-muted-foreground">{chosenBlock}</span>}
          </div>
          {actionError && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {actionError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">IP Address Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {["Server", "Interface", "Network", "NIC", "IP Setup", "IP Address", "Subnet mask", "Gateway", "DNS"].map((h) => (
                    <TableHead key={h} className="whitespace-nowrap">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.interfaces.map((i) => (
                  <TableRow key={i.pifRef}>
                    <TableCell className="whitespace-nowrap">{i.server}</TableCell>
                    <TableCell className="whitespace-nowrap">{i.interface}</TableCell>
                    <TableCell className="whitespace-nowrap">{i.network}</TableCell>
                    <TableCell className="whitespace-nowrap">{i.nic}</TableCell>
                    <TableCell>{i.ipSetup}</TableCell>
                    <TableCell className="font-mono text-xs">{i.ip}</TableCell>
                    <TableCell className="font-mono text-xs">{i.netmask}</TableCell>
                    <TableCell className="font-mono text-xs">{i.gateway}</TableCell>
                    <TableCell className="font-mono text-xs">{i.dns}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {isAdmin && (
            <div className="mt-3">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setIpDialog(true)}>
                Configure
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {ipDialog && (
        <IpConfigDialog
          conn={conn}
          hostRef={hostRef}
          objectName={hostRef ? (conn.hostRecords[hostRef]?.nameLabel ?? poolName) : poolName}
          hostCount={Object.keys(conn.hostRecords).length}
          networks={data.networks}
          interfaces={data.interfaces.filter((i) => i.hostRef === (hostRef ?? coordinatorRef))}
          haEnabled={data.haEnabled}
          coordinator={hostRef !== null && hostRef === coordinatorRef}
          managementOnVlan={data.managementOnVlan}
          onClose={() => setIpDialog(false)}
          onSaved={load}
        />
      )}

      {properties && (
        <NetworkPropertiesDialog
          conn={conn}
          network={properties}
          nics={coordinatorNics}
          canEdit={isAdmin}
          vswitch={data.vswitch}
          onClose={() => setProperties(null)}
          onSaved={load}
        />
      )}

      {wizard && pool && (
        <NewNetworkWizard
          conn={conn}
          poolName={poolName}
          nics={coordinatorNics}
          names={pool.networks.map((n) => n.name)}
          vswitch={pool.vswitch}
          haEnabled={pool.haEnabled}
          confirmName={pool.confirmName}
          sriovLicensed={pool.sriovLicensed}
          onClose={() => setWizard(false)}
          onCreated={load}
        />
      )}

      {/* NetworkList.RemoveNetworkButton_Click: XenCenter's question. */}
      {confirmBond && (
        <ConfirmNameDialog
          title="Delete Bond"
          message={bondDeleteMessage(
            confirmBond,
            data.networks.filter((x) => x.kind === "vlan" && x.nic === confirmBond.nic).map((x) => x.name),
          )}
          confirmName={data.confirmName}
          actionLabel={confirmBond.management ? "Delete bond anyway" : "OK"}
          busy={busy}
          error={actionError}
          onConfirm={(typed) => remove(confirmBond, typed)}
          onCancel={() => setConfirmBond(null)}
        />
      )}

      <AlertDialog open={Boolean(confirmRemove)} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Network</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the selected network permanently. Continue?
              {confirmRemove && <span className="mt-2 block font-medium text-foreground">{confirmRemove.name}</span>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const n = confirmRemove;
                setConfirmRemove(null);
                if (n) remove(n);
              }}
            >
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
