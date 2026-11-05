"use client";

import { useDates } from "@/context/date-format-context";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, Copy, KeyRound, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/context/auth-context";

// The certificates XenMan trusts its XenServer hosts with (lib/host-trust.ts):
// confirming one when a pool is added, the warning when a host presents
// another, and the list per pool in the settings.

export interface ProbedCertificate {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}

interface TrustedCert {
  fingerprint: string;
  source: "admin" | "pool" | "migrated";
  since: string;
  host?: string;
  address?: string;
  notAfter?: string;
}

interface PoolTrustView {
  poolId: string;
  name: string;
  useSsl: boolean;
  certs: TrustedCert[];
  pendingReview?: boolean;
  mismatch?: {
    address: string;
    fingerprint: string;
    subject?: string;
    notAfter?: string;
    at: string;
    expected: { fingerprint: string; host?: string; address?: string }[];
  };
  sshKeys?: Record<string, { fingerprint: string; since: string }>;
  sshMismatch?: { address: string; fingerprint: string; expected: string; at: string };
}

/** Where XenServer keeps the certificate it serves, and how to print its fingerprint there. */
export const FINGERPRINT_COMMAND = "openssl x509 -noout -fingerprint -sha256 -in /etc/xensource/xapi-ssl.pem";

/** A fingerprint in two halves, so it can be compared by eye. */
export function Fingerprint({ value, className = "" }: { value: string; className?: string }) {
  const half = Math.ceil(value.length / 2 / 3) * 3;
  return (
    <code className={`block break-all font-mono text-xs leading-relaxed ${className}`}>
      {value.slice(0, half)}
      <br />
      {value.slice(half)}
    </code>
  );
}

function CopyCommand() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{FINGERPRINT_COMMAND}</code>
      <button
        type="button"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(FINGERPRINT_COMMAND).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** The certificate a new pool presents, to be compared before it is trusted. */
export function CertConfirm({ cert, address }: { cert: ProbedCertificate; address: string }) {
  const dates = useDates();
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <ShieldQuestion className="h-4 w-4 text-amber-600" /> Is this {address}?
      </p>
      <p className="text-xs text-muted-foreground">
        XenServer certificates are self-signed, so only you can tell. Compare this fingerprint with the one the host
        shows on its console (or over SSH) before trusting it. From then on XenMan connects to this pool only if it
        presents this certificate – or one of its members&apos; certificates, which the pool reports itself.
      </p>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">SHA-256 fingerprint</p>
        <Fingerprint value={cert.fingerprint} className="rounded-md bg-background p-2" />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="break-all">{cert.subject}</dd>
        <dt className="text-muted-foreground">Issuer</dt>
        <dd className="break-all">{cert.selfSigned ? "self-signed" : cert.issuer}</dd>
        <dt className="text-muted-foreground">Valid until</dt>
        <dd>{dates.date(cert.validTo)}</dd>
      </dl>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">On the host:</p>
        <CopyCommand />
      </div>
    </div>
  );
}

function useTrust(intervalMs: number) {
  const [pools, setPools] = useState<PoolTrustView[] | null>(null);
  // When they were read: what "expires soon" is measured from.
  const [at, setAt] = useState(0);
  const load = useCallback(async () => {
    const res = await fetch("/api/host-trust", { cache: "no-store" }).catch(() => null);
    if (res?.ok) {
      setPools((await res.json()).pools ?? []);
      setAt(Date.now());
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, intervalMs);
    // A connection refused for its certificate says so at once (xen-context).
    window.addEventListener("xenman:trust-changed", load);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("xenman:trust-changed", load);
    };
  }, [load, intervalMs]);
  return { pools, load, at };
}

async function trustAction(body: object): Promise<string | null> {
  const res = await fetch("/api/host-trust", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return "XenMan did not answer";
  if (!res.ok) return (await res.json().catch(() => ({}))).error ?? "Not done";
  window.dispatchEvent(new Event("xenman:trust-changed"));
  return null;
}

/**
 * At the top of every page: a host that presented a certificate it is not
 * trusted with (red, for everyone), and pools taken over without their
 * fingerprint having been compared (amber, for admins).
 */
export function HostTrustBanner() {
  const dates = useDates();
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { pools } = useTrust(60_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!pools) return null;
  const refused = pools.filter((p) => p.mismatch || p.sshMismatch);
  const review = isAdmin ? pools.filter((p) => p.pendingReview && !p.mismatch) : [];
  if (!refused.length && !review.length) return null;

  const act = async (body: object) => {
    setBusy(true);
    setError(await trustAction(body));
    setBusy(false);
  };

  return (
    <div className="max-h-[50dvh] shrink-0 space-y-2 overflow-y-auto px-4 pt-3 sm:px-6">
      {refused.map((p) => (
        <div key={p.poolId} className="rounded-lg border border-red-600/50 bg-red-500/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-red-700 dark:text-red-400">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {p.mismatch
              ? `${p.mismatch.address} (${p.name}) presented a certificate XenMan does not trust`
              : `The SSH host key of ${p.sshMismatch!.address} (${p.name}) has changed`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            XenMan refused the connection, so no password or session went to it. If the host was renewed or reinstalled on
            purpose, compare the fingerprint below with the host and accept it. If not, someone may be intercepting the
            connection.
          </p>
          {p.mismatch && (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium">Presented now</p>
                <Fingerprint value={p.mismatch.fingerprint} className="rounded-md bg-background p-2" />
                {p.mismatch.notAfter && (
                  <p className="mt-1 text-xs text-muted-foreground">valid until {dates.date(p.mismatch.notAfter)}</p>
                )}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">Trusted{p.mismatch.expected.length > 1 ? ` (${p.mismatch.expected.length})` : ""}</p>
                {p.mismatch.expected.slice(0, 2).map((e) => (
                  <div key={e.fingerprint} className="mb-1">
                    <Fingerprint value={e.fingerprint} className="rounded-md bg-background p-2 text-muted-foreground" />
                    {(e.host || e.address) && <p className="text-xs text-muted-foreground">{e.host ?? e.address}</p>}
                  </div>
                ))}
                {p.mismatch.expected.length === 0 && <p className="text-xs text-muted-foreground">none yet</p>}
              </div>
            </div>
          )}
          {p.sshMismatch && (
            <div className="mt-2 grid gap-1 text-xs">
              <p>
                Presented now: <code className="break-all font-mono">{p.sshMismatch.fingerprint}</code>
              </p>
              <p className="text-muted-foreground">
                Known: <code className="break-all font-mono">{p.sshMismatch.expected}</code>
              </p>
            </div>
          )}
          {isAdmin ? (
            <div className="mt-3 space-y-2">
              {p.mismatch && <CopyCommand />}
              <div className="flex flex-wrap gap-2">
                {p.mismatch && (
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => act({ action: "accept", poolId: p.poolId, fingerprint: p.mismatch!.fingerprint })}>
                    Compared – trust the new certificate
                  </Button>
                )}
                {p.sshMismatch && (
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => act({ action: "accept_ssh", poolId: p.poolId, address: p.sshMismatch!.address })}>
                    Trust the new SSH key
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "dismiss", poolId: p.poolId })}>
                  Not trusted – hide this
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs font-medium">Ask an admin to look at this.</p>
          )}
        </div>
      ))}
      {review.map((p) => (
        <div key={p.poolId} className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
            <ShieldQuestion className="h-4 w-4 shrink-0" /> Please compare the certificate of {p.name}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            XenMan now checks the certificates of XenServer hosts. It took this pool&apos;s over when it first connected
            after the update – compare it with the host once, so you know it was the real one.
          </p>
          {p.certs
            .filter((c) => c.source === "migrated")
            .map((c) => (
              <div key={c.fingerprint} className="mt-2">
                <p className="mb-1 text-xs">{c.address ?? c.host}</p>
                <Fingerprint value={c.fingerprint} className="rounded-md bg-background p-2" />
              </div>
            ))}
          <div className="mt-2 space-y-2">
            <CopyCommand />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "reviewed", poolId: p.poolId })}>
              <Check className="h-4 w-4" /> Compared, it matches
            </Button>
          </div>
        </div>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** "56:37:C1:C6:5C:05 … DA:D4:95": enough to recognise one, the whole of it on hover. */
const shortFingerprint = (fp: string) => (fp.length > 30 ? `${fp.slice(0, 17)} … ${fp.slice(-8)}` : fp);

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      title="Copy"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

const SOURCE_LABEL: Record<TrustedCert["source"], string> = {
  admin: "confirmed",
  pool: "from the pool",
  migrated: "taken over",
};

/** Settings → Pools: what each pool is trusted with. */
export function HostTrustPanel() {
  const dates = useDates();
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { pools, at } = useTrust(120_000);
  const [error, setError] = useState<string | null>(null);
  if (!pools || pools.length === 0) return null;
  const act = async (body: object) => setError(await trustAction(body));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" /> Host certificates
        </CardTitle>
        <CardDescription>
          XenMan connects to a pool only if the host presents one of these certificates. The coordinator&apos;s is confirmed
          when a pool is added; the members&apos; come from the pool itself and follow their renewals.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {pools.map((p) => {
          const certs = [...p.certs].sort((a, b) =>
            (a.host ?? a.address ?? "").localeCompare(b.host ?? b.address ?? "", undefined, { numeric: true }),
          );
          const counts = (["admin", "pool", "migrated"] as const)
            .map((src) => [src, certs.filter((c) => c.source === src).length] as const)
            .filter(([, n]) => n > 0)
            .map(([src, n]) => `${n} ${SOURCE_LABEL[src]}`);
          const expiries = certs.map((c) => (c.notAfter ? Date.parse(c.notAfter) : NaN)).filter((t) => !Number.isNaN(t));
          const nextExpiry = expiries.length ? Math.min(...expiries) : null;
          const soon = nextExpiry !== null && nextExpiry - at < 30 * 86_400_000;
          const ssh = Object.entries(p.sshKeys ?? {});
          return (
            // Folded: a pool of 19 hosts is 19 rows. Open when there is something to look at.
            <details key={p.poolId} open={!!(p.pendingReview || p.mismatch)} className="group rounded-md border">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                <span className="font-medium">{p.name}</span>
                {!p.useSsl && (
                  <Badge variant="outline" className="border-red-600/40 text-red-700 dark:text-red-400">
                    unencrypted (HTTP)
                  </Badge>
                )}
                {p.pendingReview && (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
                    to be compared
                  </Badge>
                )}
                {p.mismatch && (
                  <Badge variant="outline" className="border-red-600/40 text-red-700 dark:text-red-400">
                    certificate refused
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {p.useSsl && certs.length === 0
                    ? "nothing trusted yet – taken over on the first connection"
                    : certs.length > 0
                      ? `${certs.length} host${certs.length === 1 ? "" : "s"} · ${counts.join(", ")}`
                      : ""}
                  {ssh.length > 0 && ` · ${ssh.length} SSH key${ssh.length === 1 ? "" : "s"}`}
                </span>
                {nextExpiry !== null && (
                  <span className={`ml-auto text-xs ${soon ? "font-medium text-amber-600" : "text-muted-foreground"}`}>
                    next expiry {dates.date(nextExpiry)}
                  </span>
                )}
              </summary>
              {(certs.length > 0 || ssh.length > 0) && (
                <ul className="divide-y border-t text-xs">
                  {certs.map((c) => (
                    <li
                      key={c.fingerprint}
                      className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-3 py-1.5 md:grid-cols-[minmax(0,10rem)_7.5rem_minmax(0,1fr)_auto_auto]"
                    >
                      <span className="truncate text-sm">{c.host ?? c.address ?? "host"}</span>
                      <span className="text-muted-foreground md:order-none">{c.host ? c.address : ""}</span>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <code className="truncate font-mono text-muted-foreground" title={c.fingerprint}>
                          {shortFingerprint(c.fingerprint)}
                        </code>
                        <CopyButton text={c.fingerprint} />
                      </span>
                      <span className={`whitespace-nowrap ${c.notAfter && Date.parse(c.notAfter) - at < 30 * 86_400_000 ? "font-medium text-amber-600" : "text-muted-foreground"}`}>
                        {SOURCE_LABEL[c.source]}
                        {c.notAfter && ` · until ${dates.date(c.notAfter)}`}
                      </span>
                      {isAdmin ? (
                        <button
                          type="button"
                          className="justify-self-end text-muted-foreground hover:text-destructive"
                          title="No longer trust this certificate"
                          aria-label="No longer trust this certificate"
                          onClick={() => act({ action: "remove", poolId: p.poolId, fingerprint: c.fingerprint })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : (
                        <span />
                      )}
                    </li>
                  ))}
                  {ssh.map(([address, k]) => (
                    <li
                      key={address}
                      className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-3 py-1.5 md:grid-cols-[minmax(0,10rem)_7.5rem_minmax(0,1fr)_auto_auto]"
                    >
                      <span className="flex items-center gap-1.5 text-sm">
                        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" /> SSH
                      </span>
                      <span className="text-muted-foreground">{address}</span>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <code className="truncate font-mono text-muted-foreground" title={k.fingerprint}>
                          {k.fingerprint}
                        </code>
                        <CopyButton text={k.fingerprint} />
                      </span>
                      <span className="whitespace-nowrap text-muted-foreground">since {dates.date(k.since)}</span>
                      {isAdmin ? (
                        <button
                          type="button"
                          className="justify-self-end text-muted-foreground hover:text-destructive"
                          title="Forget this key (learned again on the next export)"
                          aria-label="Forget this SSH key"
                          onClick={() => act({ action: "remove_ssh", poolId: p.poolId, address })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : (
                        <span />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          );
        })}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
