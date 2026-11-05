import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import {
  readAudit,
  knownActors,
  auditToCsv,
  type AuditEntry,
  type AuditQuery,
} from "@/lib/audit";

/** Rows per readAudit() call when paging through an export. */
const CSV_CHUNK = 1000;
/** Upper bound on an export so a huge archive cannot exhaust memory. */
const CSV_MAX_ROWS = 20_000;

function queryFrom(request: NextRequest): AuditQuery {
  const params = request.nextUrl.searchParams;
  const query: AuditQuery = {};
  const category = params.get("category");
  const outcome = params.get("outcome");
  const actor = params.get("actor");
  const q = params.get("q");
  if (category) query.category = category;
  if (outcome) query.outcome = outcome;
  if (actor) query.actor = actor;
  if (q?.trim()) query.q = q.trim();
  return query;
}

export async function GET(request: NextRequest) {
  // The audit log records who did what to the infrastructure — admins only.
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  const params = request.nextUrl.searchParams;
  const filters = queryFrom(request);

  if (params.get("format") === "csv") {
    const rows: AuditEntry[] = [];
    for (let offset = 0; offset < CSV_MAX_ROWS; offset += CSV_CHUNK) {
      const page = readAudit({ ...filters, limit: CSV_CHUNK, offset });
      rows.push(...page.entries);
      if (!page.hasMore) break;
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new NextResponse(auditToCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="xenman-audit-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const limit = Number(params.get("limit")) || 100;
  const offset = Number(params.get("offset")) || 0;
  const page = readAudit({ ...filters, limit, offset });

  return NextResponse.json({
    entries: page.entries,
    hasMore: page.hasMore,
    actors: knownActors(),
  });
}
