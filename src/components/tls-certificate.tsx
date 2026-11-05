"use client";

import { useDates } from "@/context/date-format-context";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Lock, Upload, XCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

interface CertInfo {
  subject: string;
  issuer: string;
  names: string[];
  validFrom: string;
  validTo: string;
  daysLeft: number;
  selfSigned: boolean;
  fingerprint: string;
  chainLength: number;
}

type Format = "pem" | "pfx";

const WARN_DAYS = 30;

async function readText(file: File | undefined): Promise<string | undefined> {
  return file ? await file.text() : undefined;
}

async function readBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The certificate the HTTPS server presents, and a way to replace it with one
 * from your own CA -- as PEM files or a PFX -- or go back to a self-signed one.
 */
export function TlsCertificate() {
  const dates = useDates();
  const [cert, setCert] = useState<CertInfo | null | undefined>(undefined);
  const [openssl, setOpenssl] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [format, setFormat] = useState<Format>("pem");
  const [files, setFiles] = useState<{ cert?: File; key?: File; chain?: File; pfx?: File }>({});
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/appliance/certificate", { cache: "no-store" });
      if (res.status === 403) return setForbidden(true);
      if (!res.ok) return;
      const json = await res.json();
      setCert(json.cert ?? null);
      setOpenssl(Boolean(json.openssl));
    } catch {
      // keep what we have
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  if (forbidden || cert === undefined) return null;

  async function post(body: object, success: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/appliance/certificate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "The certificate could not be installed");
        return;
      }
      setCert(json.cert);
      setUploading(false);
      setFiles({});
      setPassword("");
      setDone(success);
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (format === "pfx") {
      if (!files.pfx) return setError("Choose the PFX file");
      return post(
        { action: "upload", pfx: await readBase64(files.pfx), pfxPassword: password },
        "Certificate installed.",
      );
    }
    if (!files.cert || !files.key) return setError("Choose the certificate and the private key");
    return post(
      {
        action: "upload",
        cert: await readText(files.cert),
        key: await readText(files.key),
        chain: await readText(files.chain),
        keyPassphrase: password || undefined,
      },
      "Certificate installed.",
    );
  }

  const expiring = cert && !cert.selfSigned && cert.daysLeft <= WARN_DAYS;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Lock className="h-4 w-4" /> HTTPS Certificate
              </CardTitle>
              <CardDescription>What browsers are shown when they connect to XenMan</CardDescription>
            </div>
            {!uploading && (
              <Button size="sm" variant="outline" onClick={() => { setUploading(true); setError(null); setDone(null); }}>
                <Upload className="mr-2 h-4 w-4" /> Upload certificate
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {cert ? (
            <>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Issued to</span>
                <span className="text-right break-all">{cert.subject}</span>
              </div>
              {cert.names.length > 0 && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Valid for</span>
                  <span className="text-right font-mono text-xs break-all">{cert.names.join(", ")}</span>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Issued by</span>
                <span className="flex items-center gap-2 text-right break-all">
                  {cert.selfSigned ? <Badge variant="outline">self-signed</Badge> : cert.issuer}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Valid until</span>
                <span className={expiring ? "text-amber-700 dark:text-amber-400" : ""}>
                  {dates.date(cert.validTo)} ({cert.daysLeft} days)
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">SHA-256</span>
                <span className="text-right font-mono text-[10px] break-all">{cert.fingerprint}</span>
              </div>
              {cert.selfSigned && (
                <p className="text-xs text-muted-foreground">
                  Browsers warn about a self-signed certificate. Upload one from your own
                  certificate authority to remove the warning.
                </p>
              )}
              {expiring && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <p>
                    {cert.daysLeft < 0
                      ? "This certificate has expired."
                      : `This certificate expires in ${cert.daysLeft} days.`}{" "}
                    Upload its successor before then.
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              No PEM certificate in use — HTTPS runs on the certificate generated at installation.
            </p>
          )}

          {uploading && (
            <div className="rounded-md border p-3 space-y-4">
              <div className="flex gap-2">
                <Button size="sm" variant={format === "pem" ? "default" : "outline"} onClick={() => setFormat("pem")}>
                  PEM files
                </Button>
                <Button
                  size="sm"
                  variant={format === "pfx" ? "default" : "outline"}
                  onClick={() => setFormat("pfx")}
                  disabled={!openssl}
                  title={openssl ? undefined : "Needs openssl, which this installation lacks"}
                >
                  PFX / PKCS#12
                </Button>
              </div>

              {format === "pem" ? (
                <div className="grid gap-3">
                  <div className="grid gap-1">
                    <Label htmlFor="cert-file">Certificate (.crt, .pem)</Label>
                    <Input id="cert-file" type="file" accept=".pem,.crt,.cer"
                      onChange={(e) => setFiles({ ...files, cert: e.target.files?.[0] })} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="key-file">Private key (.key, .pem)</Label>
                    <Input id="key-file" type="file" accept=".pem,.key"
                      onChange={(e) => setFiles({ ...files, key: e.target.files?.[0] })} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="chain-file">Intermediate certificates (optional)</Label>
                    <Input id="chain-file" type="file" accept=".pem,.crt,.cer"
                      onChange={(e) => setFiles({ ...files, chain: e.target.files?.[0] })} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="key-pass">Key passphrase (only if the key is encrypted)</Label>
                    <Input id="key-pass" type="password" autoComplete="off" value={password}
                      onChange={(e) => setPassword(e.target.value)} />
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="grid gap-1">
                    <Label htmlFor="pfx-file">PFX file (.pfx, .p12)</Label>
                    <Input id="pfx-file" type="file" accept=".pfx,.p12"
                      onChange={(e) => setFiles({ ...files, pfx: e.target.files?.[0] })} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="pfx-pass">Password</Label>
                    <Input id="pfx-pass" type="password" autoComplete="off" value={password}
                      onChange={(e) => setPassword(e.target.value)} />
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                The key is checked against the certificate before anything changes. XenMan
                switches over without a restart; reload the page to see the new certificate.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={upload} disabled={busy}>
                  Install
                </Button>
                <Button size="sm" variant="outline" onClick={() => setUploading(false)} disabled={busy}>
                  Cancel
                </Button>
                {openssl && cert && !cert.selfSigned && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirmReset(true)} disabled={busy}>
                    Back to self-signed
                  </Button>
                )}
              </div>
            </div>
          )}

          {done && (
            <div className="flex items-start gap-2 rounded-md border border-green-600/40 bg-green-600/10 p-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <p>{done} Reload the page to see it in your browser.</p>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p>{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Go back to a self-signed certificate?</AlertDialogTitle>
            <AlertDialogDescription>
              The uploaded certificate is replaced by a newly generated one, and browsers will
              warn again. Keep a copy of your certificate if you want to install it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => post({ action: "self-signed" }, "Self-signed certificate created.")}>
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
