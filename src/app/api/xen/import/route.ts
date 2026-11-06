import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { mayAccessHost } from "@/lib/pool-access";
import { lookupSession } from "@/lib/xen-sessions";
import { withPool } from "@/lib/xen-tls";
import { XenApiError, xenApiCall } from "@/lib/xen-client";
import { XapiTaskError } from "@/lib/xen-network-actions";
import { ImportRefused, importNetworks, runImport } from "@/lib/vm-import";
import { describeRef } from "@/lib/ref-names";

// XenCenter's Import of an XVA (lib/vm-import.ts): the file, as the browser
// sends it, goes straight on to XAPI's /import -- nothing is stored here.
//
// Left out of proxy.ts like /api/update: Next.js would buffer the body there
// and cut it at 10 MB. So this route checks what proxy.ts and /api/xen check:
// a valid session without a pending password change, a role that may change
// VMs, and the pool the XenServer session belongs to.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isXenRef = (r: unknown): r is string => typeof r === "string" && /^OpaqueRef:[\w-]+$/.test(r);
/** An XVA larger than this is not a VM anyone uploads through a browser. */
const MAX_BYTES = 4 * 1024 ** 4;

export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin", "operator");
  if (auth.error) return auth.error;
  const q = request.nextUrl.searchParams;
  const sessionRef = q.get("sessionRef") ?? "";
  const srRef = q.get("srRef");
  const affinity = q.get("affinity");
  const fileName = (q.get("fileName") ?? "").slice(0, 255);

  const bound = lookupSession(sessionRef);
  if (!bound) return NextResponse.json({ error: "Session expired, please reconnect" }, { status: 401 });
  if (bound.actor.toLowerCase() !== auth.payload.sub.toLowerCase() || !mayAccessHost(auth.payload, bound.hostId)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  if (!isXenRef(srRef)) return NextResponse.json({ error: "Choose a storage repository" }, { status: 400 });
  if (affinity !== null && affinity !== "" && !isXenRef(affinity)) return NextResponse.json({ error: "Unknown home server" }, { status: 400 });
  const length = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isFinite(length) || length <= 0) {
    return NextResponse.json({ error: "No file in the request" }, { status: 400 });
  }
  if (length > MAX_BYTES) return NextResponse.json({ error: "The file is too large" }, { status: 413 });

  const audit = (outcome: "success" | "failure", detail: string, target?: string) =>
    auditRequest(request, {
      category: "vm",
      action: "vm_import",
      target: target ?? `pool ${bound.hostId}`,
      outcome,
      detail: [
        `file=${fileName || "?"}`,
        `size=${length}`,
        `sr=${describeRef("SR", srRef) ?? srRef}`,
        affinity ? `home server=${describeRef("host", affinity) ?? affinity}` : "no home server",
        detail,
      ]
        .filter(Boolean)
        .join(", "),
    });

  const ctx = { poolId: bound.hostId, address: bound.address, port: bound.port, useSsl: bound.useSsl, sessionRef };
  try {
    const body = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
    const vm = await withPool(bound.hostId, () =>
      runImport(ctx, { body, length, srRef, affinity: affinity || null, signal: request.signal }),
    );
    const { vifs, networks } = await withPool(bound.hostId, () =>
      importNetworks(
        <T,>(method: string, params: unknown[]) => xenApiCall<T>(ctx.address, ctx.port, ctx.useSsl, method, [sessionRef, ...params]),
        vm.vmRef,
        affinity || null,
      ),
    );
    audit("success", `imported as ${vm.name}`, `VM "${vm.name}"`);
    return NextResponse.json({ ...vm, vifs, networks });
  } catch (err) {
    const status = err instanceof ImportRefused ? 409 : request.signal.aborted ? 499 : 502;
    const message =
      err instanceof XapiTaskError || err instanceof XenApiError
        ? [err.message, ...((err as { data?: unknown[] }).data ?? []).map(String)].filter(Boolean).join(" ")
        : request.signal.aborted
          ? "Import canceled."
          : err instanceof Error
            ? err.message
            : String(err);
    audit("failure", message);
    return NextResponse.json({ error: message }, { status });
  }
}
