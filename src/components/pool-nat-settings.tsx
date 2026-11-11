"use client";

// A pool's hosts behind NAT (lib/nat.ts): a switch, and for each host
// XenServer reports the address XenMan reaches it at. In the pool's edit
// dialog -- the hosts are read with the pool's stored credentials.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { XenHost } from "@/lib/types";

interface Member {
  name: string;
  address: string;
  coordinator: boolean;
}

type Nat = NonNullable<XenHost["nat"]>;

export function PoolNatSettings({
  poolId,
  poolAddress,
  value,
  onChange,
}: {
  poolId: string;
  /** The address the pool is connected at: where its coordinator is reached. */
  poolAddress: string;
  value: Nat | undefined;
  onChange: (nat: Nat) => void;
}) {
  const nat: Nat = value ?? { enabled: false, hosts: {} };
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Asked once the switch is on: it takes a login at the pool.
  useEffect(() => {
    if (!nat.enabled || members) return;
    let gone = false;
    (async () => {
      const res = await fetch("/api/hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "members", hostId: poolId }),
      }).catch(() => null);
      const json = await res?.json().catch(() => ({}));
      if (gone) return;
      if (!res?.ok) setError(json?.error ?? "The pool's hosts could not be read");
      else {
        const list: Member[] = json.members ?? [];
        setMembers(list);
        // The coordinator is reached where the pool is connected: filled in, to be changed if wrong.
        const c = list.find((m) => m.coordinator);
        const key = c?.address.toLowerCase();
        if (key && poolAddress && key !== poolAddress.toLowerCase() && !nat.hosts[key]) {
          onChange({ ...nat, hosts: { ...nat.hosts, [key]: poolAddress } });
        }
      }
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked once per opening; what is typed meanwhile must not ask again
  }, [nat.enabled, members, poolId]);

  // Hosts the setting names that the pool no longer reports are kept and shown.
  const reported = new Set((members ?? []).map((m) => m.address.toLowerCase()));
  const rows: Member[] = [
    ...(members ?? []),
    ...Object.keys(nat.hosts)
      .filter((a) => members && !reported.has(a))
      .map((a) => ({ name: "no longer in the pool", address: a, coordinator: false })),
  ];
  const set = (address: string, to: string) => onChange({ ...nat, hosts: { ...nat.hosts, [address.toLowerCase()]: to } });

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>Hosts are behind NAT</Label>
          <p className="text-xs text-zinc-500">
            XenMan reaches the hosts at other addresses than XenServer reports, such as a firewall&apos;s virtual IP. Needed
            for consoles, performance graphs, imports and SSH exports.
          </p>
        </div>
        <Switch checked={nat.enabled} onCheckedChange={(enabled) => onChange({ ...nat, enabled })} />
      </div>
      {nat.enabled && (
        <div className="space-y-2 text-sm">
          {error && <p className="text-destructive">{error}</p>}
          {!members && !error && (
            <p className="flex items-center gap-2 text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Asking the pool for its hosts
            </p>
          )}
          {members && (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-x-3 gap-y-2">
              <span className="text-xs text-zinc-500">Host</span>
              <span className="text-xs text-zinc-500">Reported address</span>
              <span className="text-xs text-zinc-500">Reachable at</span>
              {rows.map((m) => (
                <div key={m.address} className="contents">
                  <span className="min-w-0 truncate" title={m.name}>
                    {m.name}
                    {m.coordinator && <span className="text-zinc-500"> (coordinator)</span>}
                  </span>
                  <span className="min-w-0 truncate font-mono text-xs" title={m.address}>
                    {m.address}
                  </span>
                  <Input
                    aria-label={`Reachable address of ${m.name}`}
                    className="h-8 font-mono text-xs"
                    value={nat.hosts[m.address.toLowerCase()] ?? ""}
                    placeholder={m.coordinator ? poolAddress : "as reported"}
                    onChange={(e) => set(m.address, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-zinc-500">
            Left empty, a host is reached at the address it reports. Each host&apos;s certificate is checked as before.
          </p>
        </div>
      )}
    </div>
  );
}
