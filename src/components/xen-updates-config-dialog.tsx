"use client";

import { useEffect, useRef, useState } from "react";
import { XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ChannelKey = "normal" | "early_access";

export interface UpdateConfig {
  channel: ChannelKey | null;
  sync: { supported: boolean; enabled: boolean; frequency: "daily" | "weekly"; day: number };
  proxy: { url: string; username: string; passwordSet: boolean };
}

const CHANNEL_NAMES: Record<ChannelKey, string> = { normal: "Normal", early_access: "Early Access" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** The pool's channel is neither Normal nor Early Access: kept unless another is chosen. */
const OTHER = "__other__";

/**
 * XenCenter's Configure Updates for one pool: the update channel, automatic
 * synchronization and the proxy server. Only what was changed is sent; after
 * a new channel, synchronizing is offered, as XenCenter does.
 */
export function XenUpdatesConfigDialog({
  open,
  onOpenChange,
  hostId,
  config,
  channelName,
  onSaved,
  onSync,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string;
  config: UpdateConfig;
  /** How the pool's current channel is shown, e.g. for one that is neither Normal nor Early Access. */
  channelName: string | null;
  onSaved: () => void;
  onSync: () => void;
}) {
  const [channel, setChannel] = useState<string>(OTHER);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [frequency, setFrequency] = useState<"daily" | "weekly">("weekly");
  const [day, setDay] = useState(0);
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyUser, setProxyUser] = useState("");
  // Empty and untouched: the stored password stays.
  const [proxyPassword, setProxyPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askSync, setAskSync] = useState(false);

  // The pool's settings as last read -- without starting the dialog over when
  // they are read again (as after saving, while it asks to synchronize).
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Each time it opens, and only then: the pool's current settings.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const c = configRef.current;
      setChannel(c.channel ?? OTHER);
      setSyncEnabled(c.sync.enabled);
      setFrequency(c.sync.frequency);
      setDay(c.sync.day);
      setProxyUrl(c.proxy.url);
      setProxyUser(c.proxy.username);
      setProxyPassword("");
      setPasswordTouched(false);
      setError(null);
      setAskSync(false);
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const proxyInvalid = proxyUrl.trim() !== "" && !/^https?:\/\/[^\s/?#]+/i.test(proxyUrl.trim());

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const changes: Record<string, unknown> = {};
      if (channel !== OTHER && channel !== config.channel) changes.channel = channel;
      const s = config.sync;
      if (s.supported && (syncEnabled !== s.enabled || frequency !== s.frequency || day !== s.day)) {
        changes.sync = { enabled: syncEnabled, frequency, day };
      }
      const p = config.proxy;
      if (proxyUrl.trim() !== p.url || proxyUser.trim() !== p.username || passwordTouched) {
        changes.proxy = { url: proxyUrl.trim(), username: proxyUser.trim(), ...(passwordTouched ? { password: proxyPassword } : {}) };
      }
      if (Object.keys(changes).length === 0) {
        onOpenChange(false);
        return;
      }
      const res = await fetch("/api/xen-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, action: "configure", config: changes }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "The settings could not be saved.");
        return;
      }
      onSaved();
      if (json.channelChanged) setAskSync(true);
      else onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {askSync ? (
          <>
            <DialogHeader>
              <DialogTitle>Synchronize with Update Channel</DialogTitle>
              <DialogDescription>
                XenMan recommends synchronizing with the new update channel now to retrieve the latest available updates.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Not Now
              </Button>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  onSync();
                }}
              >
                Synchronize Now
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Configure Updates</DialogTitle>
              <DialogDescription>Update channel, synchronization schedule and proxy server for this pool.</DialogDescription>
            </DialogHeader>

            <div className="space-y-5 text-sm">
              <section className="space-y-2">
                <h3 className="font-medium">Update Channel</h3>
                <p className="text-muted-foreground">Specify how soon you want to access updates.</p>
                <div className="flex items-center gap-3">
                  <Label htmlFor="xuc-channel" className="w-20 shrink-0 font-normal">
                    Channel
                  </Label>
                  <Select value={channel} onValueChange={setChannel}>
                    <SelectTrigger id="xuc-channel" className="w-full">
                      <SelectValue placeholder="Select a channel" />
                    </SelectTrigger>
                    <SelectContent>
                      {config.channel === null && (
                        <SelectItem value={OTHER}>{channelName ? `Other: ${channelName}` : "None"}</SelectItem>
                      )}
                      {(Object.keys(CHANNEL_NAMES) as ChannelKey[]).map((k) => (
                        <SelectItem key={k} value={k}>
                          {CHANNEL_NAMES[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </section>

              {config.sync.supported && (
                <section className="space-y-2">
                  <h3 className="font-medium">Synchronization Schedule</h3>
                  <div className="flex items-center gap-2">
                    <Switch id="xuc-sync" checked={syncEnabled} onCheckedChange={setSyncEnabled} />
                    <Label htmlFor="xuc-sync" className="font-normal">
                      Synchronize automatically with the selected update channel
                    </Label>
                  </div>
                  <div className={`space-y-2 pl-11 ${syncEnabled ? "" : "opacity-50"}`}>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="xuc-frequency"
                        checked={frequency === "daily"}
                        onChange={() => setFrequency("daily")}
                        disabled={!syncEnabled}
                      />
                      Daily
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="xuc-frequency"
                          checked={frequency === "weekly"}
                          onChange={() => setFrequency("weekly")}
                          disabled={!syncEnabled}
                        />
                        Weekly on this day:
                      </label>
                      <Select
                        value={String(day)}
                        onValueChange={(v) => setDay(Number(v))}
                        disabled={!syncEnabled || frequency !== "weekly"}
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEKDAYS.map((d, i) => (
                            <SelectItem key={d} value={String(i)}>
                              {d}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The time of day at which the synchronization takes place varies automatically.
                    </p>
                  </div>
                </section>
              )}

              <section className="space-y-2">
                <h3 className="font-medium">Proxy Server</h3>
                <p className="text-muted-foreground">
                  Optionally, specify a proxy to use when synchronizing with the selected update channel (example:
                  https://server:port).
                </p>
                <div className="grid grid-cols-[5rem_1fr] items-center gap-x-3 gap-y-2">
                  <Label htmlFor="xuc-proxy" className="font-normal">
                    Proxy URL
                  </Label>
                  <Input
                    id="xuc-proxy"
                    value={proxyUrl}
                    onChange={(e) => setProxyUrl(e.target.value)}
                    aria-invalid={proxyInvalid}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Label htmlFor="xuc-user" className="font-normal">
                    Username
                  </Label>
                  <Input
                    id="xuc-user"
                    value={proxyUser}
                    onChange={(e) => setProxyUser(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Label htmlFor="xuc-password" className="font-normal">
                    Password
                  </Label>
                  <Input
                    id="xuc-password"
                    type="password"
                    value={proxyPassword}
                    placeholder={config.proxy.passwordSet && !passwordTouched ? "Unchanged" : ""}
                    onChange={(e) => {
                      setProxyPassword(e.target.value);
                      setPasswordTouched(true);
                    }}
                    autoComplete="new-password"
                  />
                </div>
                {proxyInvalid && <p className="text-xs text-destructive">The proxy URL must start with http:// or https://.</p>}
              </section>

              {error && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <p>{error}</p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving || proxyInvalid}>
                {saving ? "Saving" : "Save"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
