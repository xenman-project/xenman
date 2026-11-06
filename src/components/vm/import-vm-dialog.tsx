"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Upload } from "lucide-react";
import type { HostConnection } from "@/lib/types";
import type { ImportNetwork, ImportTargets, ImportVif } from "@/lib/vm-import";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { xenNet } from "@/components/networking/host-networking";
import { useTask } from "@/context/task-context";

// XenCenter's Import wizard for an XVA (lib/vm-import.ts): the file, its home
// server, its storage -- where "Import" starts the upload -- then its network
// interfaces, and whether to start it. The texts are XenCenter's.

type Step = "source" | "home" | "storage" | "upload" | "networks" | "finish";

interface Imported {
  vmRef: string;
  name: string;
  isTemplate: boolean;
  importTask: string;
  vifs: ImportVif[];
  networks: ImportNetwork[];
}

const STEPS: { key: Step; label: string }[] = [
  { key: "source", label: "Import Source" },
  { key: "home", label: "Home Server" },
  { key: "storage", label: "Storage" },
  { key: "networks", label: "Networking" },
  { key: "finish", label: "Finish" },
];

function size(bytes: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(1) : v} ${u[i]}`;
}

export function ImportVmDialog({
  conn,
  hostId,
  poolName,
  onClose,
  onDone,
}: {
  conn: HostConnection;
  hostId: string;
  poolName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { addTask } = useTask();
  const [step, setStep] = useState<Step>("source");
  const [file, setFile] = useState<File | null>(null);
  const [affinity, setAffinity] = useState<string | null>(null);
  const [targets, setTargets] = useState<ImportTargets | null>(null);
  const [srRef, setSrRef] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [sent, setSent] = useState(0);
  const [imported, setImported] = useState<Imported | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);

  const load = useCallback(
    async (home: string | null, keep: boolean) => {
      const t = (await xenNet(conn, { action: "vm_import_targets", affinity: home })) as ImportTargets;
      setTargets(t);
      setSrRef((cur) => (keep && cur && t.srs.some((s) => s.ref === cur && s.enabled) ? cur : t.defaultSr));
    },
    [conn],
  );

  // The hosts for the home server page, before an SR is chosen -- once: the
  // pool is refreshed after the upload, and the choice made must stay.
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    load(null, false).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  // An upload is not left running behind a closed dialog.
  useEffect(() => () => xhr.current?.abort(), []);

  async function rescan() {
    if (!targets) return;
    setScanning(true);
    try {
      await Promise.all(targets.srs.map((s) => xenNet(conn, { action: "sr_scan", srRef: s.ref }).catch(() => {})));
      await load(affinity, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  function upload() {
    if (!file || !srRef) return;
    setError(null);
    setSent(0);
    setStep("upload");
    const q = new URLSearchParams({ sessionRef: conn.session?.sessionRef ?? "", srRef, fileName: file.name });
    if (affinity) q.set("affinity", affinity);
    const req = new XMLHttpRequest();
    xhr.current = req;
    req.open("POST", `/api/xen/import?${q}`);
    req.setRequestHeader("Content-Type", "application/octet-stream");
    req.upload.onprogress = (e) => e.lengthComputable && setSent(e.loaded);
    req.onload = () => {
      xhr.current = null;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(req.responseText);
      } catch {}
      if (req.status !== 200) {
        setError(String(data.error ?? `HTTP ${req.status}`));
        setStep("storage");
        return;
      }
      const result = data as unknown as Imported;
      setImported(result);
      setChosen(Object.fromEntries(result.vifs.map((v) => [v.ref, v.network])));
      onDone();
      setStep(result.isTemplate ? "finish" : "networks");
    };
    req.onerror = () => {
      xhr.current = null;
      setError("The upload was interrupted.");
      setStep("storage");
    };
    req.onabort = () => {
      xhr.current = null;
    };
    req.send(file);
  }

  async function finish() {
    if (!imported) return;
    setBusy(true);
    setError(null);
    try {
      const res = await xenNet(conn, {
        action: "vm_import_finish",
        vmRef: imported.vmRef,
        importTask: imported.importTask,
        networks: chosen,
        start: start && !imported.isTemplate,
      });
      if (res.taskRef) {
        addTask({ taskRef: res.taskRef, hostId, type: "vm_create", label: `Starting ${imported.name}`, description: "After import" });
      }
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (step === "upload") {
      if (!window.confirm("Cancel the import? The upload stops.")) return;
      xhr.current?.abort();
    }
    onClose();
  }

  const uploading = step === "upload";
  const pct = file && file.size ? Math.min(100, Math.floor((sent / file.size) * 100)) : 0;
  const shownStep = uploading ? "storage" : step;
  const hostName = (ref: string | null) => targets?.hosts.find((h) => h.ref === ref)?.name ?? "";

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && cancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import XVA</DialogTitle>
        </DialogHeader>

        {/* The wizard's pages, as XenCenter lists them on the left. */}
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {STEPS.map((s, i) => (
            <li key={s.key} className={s.key === shownStep ? "font-semibold text-foreground" : ""}>
              {i + 1}. {s.label}
            </li>
          ))}
        </ol>

        <div className="min-h-[16rem] space-y-3 text-sm">
          {step === "source" && (
            <>
              <p className="font-medium">Locate the file you want to import</p>
              <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-4 py-6 hover:bg-muted/40">
                <Upload className="h-5 w-5 text-muted-foreground" />
                <span>{file ? `${file.name} (${size(file.size)})` : "Choose an XVA file"}</span>
                <input
                  type="file"
                  accept=".xva"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setError(f && !/\.xva$/i.test(f.name) ? "Choose a file ending in .xva" : null);
                    setFile(f && /\.xva$/i.test(f.name) ? f : null);
                  }}
                />
              </label>
            </>
          )}

          {step === "home" && (
            <>
              <p className="font-medium">Select the location where the imported VM will be placed</p>
              <p className="text-muted-foreground">Pool: {poolName}</p>
              <div className="space-y-1 rounded-md border p-2">
                <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-muted/50">
                  <input type="radio" name="home" className="mt-0.5" checked={affinity === null} onChange={() => setAffinity(null)} />
                  <span>
                    Don&apos;t assign this VM a home server. The VM will be started on any server with the necessary resources.
                    (Shared storage required).
                  </span>
                </label>
                {targets?.hosts.map((h) => (
                  <label
                    key={h.ref}
                    className={`flex items-center gap-2 rounded px-2 py-1.5 ${h.live ? "cursor-pointer hover:bg-muted/50" : "cursor-not-allowed opacity-50"}`}
                  >
                    <input type="radio" name="home" disabled={!h.live} checked={affinity === h.ref} onChange={() => setAffinity(h.ref)} />
                    {h.name}
                    {!h.live && <span className="text-xs text-muted-foreground">(not reachable)</span>}
                  </label>
                ))}
              </div>
            </>
          )}

          {(step === "storage" || uploading) && (
            <>
              <p className="font-medium">Select target storage</p>
              <p className="text-muted-foreground">
                Select a storage repository where virtual disks for the new VM will be stored. When you have finished, click
                &quot;Import&quot; to begin importing the VM and proceed to configure networking options.
              </p>
              <div className={`max-h-56 overflow-y-auto rounded-md border ${uploading ? "pointer-events-none opacity-60" : ""}`}>
                {targets?.srs.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No storage repository can hold the VM.</p>}
                {targets?.srs.map((s) => (
                  <button
                    key={s.ref}
                    type="button"
                    disabled={!s.enabled}
                    onClick={() => setSrRef(s.ref)}
                    className={`flex w-full items-center justify-between gap-3 border-b px-3 py-1.5 text-left last:border-b-0 ${
                      srRef === s.ref ? "bg-primary/10" : "hover:bg-muted/60"
                    } ${s.enabled ? "" : "cursor-not-allowed opacity-50"}`}
                  >
                    <span className="truncate">{s.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{s.description}</span>
                  </button>
                ))}
              </div>
              {!uploading && (
                <Button type="button" variant="outline" size="sm" onClick={rescan} disabled={scanning || !targets?.srs.length}>
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
                  Rescan
                </Button>
              )}
              {uploading && file && (
                <div className="space-y-1.5 rounded-md border px-3 py-2">
                  <p>
                    {pct < 100
                      ? `Uploading '${file.name}' to '${poolName}' (${pct}% done)`
                      : "Uploaded. XenServer is importing the VM"}
                  </p>
                  <Progress value={pct} />
                  <p className="text-xs text-muted-foreground">
                    {size(sent)} of {size(file.size)}. Keep this window open until the import is complete.
                  </p>
                </div>
              )}
            </>
          )}

          {step === "networks" && imported && (
            <>
              <p className="font-medium">Select network to connect VM</p>
              <p className="text-muted-foreground">
                Map the virtual network interfaces in the VMs you are importing to networks in the destination pool or standalone
                server.
              </p>
              <p className="text-xs text-muted-foreground">Virtual network interfaces installed on the new virtual machines:</p>
              {imported.vifs.length === 0 ? (
                <p className="text-muted-foreground">The VM has no network interfaces.</p>
              ) : (
                <table className="w-full text-left">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 font-medium">Name</th>
                      <th className="py-1 font-medium">MAC</th>
                      <th className="py-1 font-medium">Network</th>
                    </tr>
                  </thead>
                  <tbody>
                    {imported.vifs.map((v) => (
                      <tr key={v.ref} className="border-t">
                        <td className="py-1.5">interface {v.device}</td>
                        <td className="py-1.5 font-mono text-xs">{v.mac}</td>
                        <td className="py-1.5">
                          <select
                            className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                            value={chosen[v.ref] ?? ""}
                            onChange={(e) => setChosen((c) => ({ ...c, [v.ref]: e.target.value }))}
                          >
                            {imported.networks.map((n) => (
                              <option key={n.ref} value={n.ref}>
                                {n.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {step === "finish" && imported && (
            <>
              <p>
                All the necessary information has been collected and the wizard is ready to finish the import of{" "}
                <span className="font-medium">{imported.name}</span>.
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border px-3 py-2">
                <dt className="text-muted-foreground">File</dt>
                <dd>{file?.name}</dd>
                <dt className="text-muted-foreground">Home server</dt>
                <dd>{affinity ? hostName(affinity) : "None"}</dd>
                <dt className="text-muted-foreground">Storage</dt>
                <dd>{targets?.srs.find((s) => s.ref === srRef)?.name}</dd>
              </dl>
              {!imported.isTemplate && (
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
                  Start the new VM automatically as soon as the import is complete
                </label>
              )}
            </>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={cancel} disabled={busy}>
            {imported ? "Close" : "Cancel"}
          </Button>
          {step === "home" && (
            <Button variant="outline" onClick={() => setStep("source")}>
              Previous
            </Button>
          )}
          {step === "storage" && (
            <Button variant="outline" onClick={() => setStep("home")}>
              Previous
            </Button>
          )}
          {step === "finish" && imported && !imported.isTemplate && (
            <Button variant="outline" onClick={() => setStep("networks")} disabled={busy}>
              Previous
            </Button>
          )}
          {step === "source" && (
            <Button onClick={() => setStep("home")} disabled={!file}>
              Next
            </Button>
          )}
          {step === "home" && (
            <Button
              onClick={() => {
                setError(null);
                load(affinity, true)
                  .then(() => setStep("storage"))
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)));
              }}
            >
              Next
            </Button>
          )}
          {step === "storage" && (
            <Button onClick={upload} disabled={!srRef}>
              Import
            </Button>
          )}
          {uploading && (
            <Button disabled>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Importing
            </Button>
          )}
          {step === "networks" && (
            <Button onClick={() => setStep("finish")}>
              Next
            </Button>
          )}
          {step === "finish" && (
            <Button onClick={finish} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Finish
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
