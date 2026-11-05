import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import { accessibleHosts } from "@/lib/pool-access";
import {
  readPoolEvents,
  poolEventsToCsv,
  type PoolEvent,
  type PoolEventQuery,
} from "@/lib/xen-events";

/** Rows per readPoolEvents() call when paging through an export. */
const CSV_CHUNK = 1000;
/** Upper bound on an export so a huge archive cannot exhaust memory. */
const CSV_MAX_ROWS = 20_000;

/** Comma-separated multi-select value, e.g. `severity=critical,warning`. */
function listParam(params: URLSearchParams, name: string): string[] | undefined {
  const raw = params.get(name);
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function queryFrom(request: NextRequest, allowedHostIds: string[]): PoolEventQuery {
  const params = request.nextUrl.searchParams;
  const query: PoolEventQuery = { allowedHostIds };

  const kinds = listParam(params, "kind");
  const severities = listParam(params, "severity");
  // Narrowing by location is still subject to allowedHostIds: readPoolEvents
  // checks the grant separately, so asking for a pool the caller has no grant
  // for yields nothing rather than leaking another pool's history.
  const hostIds = listParam(params, "hostId");
  const since = params.get("since");
  const until = params.get("until");
  const q = params.get("q");

  if (kinds) query.kinds = kinds;
  if (severities) query.severities = severities;
  if (hostIds) query.hostIds = hostIds;
  if (since) query.since = since;
  if (until) query.until = until;
  if (q?.trim()) query.q = q.trim();
  return query;
}

export async function GET(request: NextRequest) {
  // Unlike the audit log this is not admin-only: what a pool reports is
  // operational information every role needs. The pool grant does the scoping.
  const auth = authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const hosts = accessibleHosts(auth);
  const allowedHostIds = hosts.map((h) => h.id);
  const pools = hosts.map((h) => ({ id: h.id, name: h.name || h.address }));

  const params = request.nextUrl.searchParams;
  const filters = queryFrom(request, allowedHostIds);

  if (params.get("format") === "csv") {
    const rows: PoolEvent[] = [];
    for (let offset = 0; offset < CSV_MAX_ROWS; offset += CSV_CHUNK) {
      const page = readPoolEvents({ ...filters, limit: CSV_CHUNK, offset });
      rows.push(...page.entries);
      if (!page.hasMore) break;
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new NextResponse(poolEventsToCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="xenman-events-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const limit = Number(params.get("limit")) || 100;
  const offset = Number(params.get("offset")) || 0;
  const page = readPoolEvents({ ...filters, limit, offset });

  return NextResponse.json({
    entries: page.entries,
    hasMore: page.hasMore,
    // Pool names come from the host config, so the page can label rows without
    // needing a connection to that pool.
    pools,
  });
}
