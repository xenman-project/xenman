import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { readDisplaySettings, saveDisplaySettings } from "@/lib/display-settings";
import { isDateFormat } from "@/lib/date-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How dates are shown. Every signed-in user reads it: their pages format with it. */
export async function GET(request: NextRequest) {
  if (!authenticateRequest(request)) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json(readDisplaySettings());
}

/** { dateFormat: "en-US" | "de-DE" | "iso" }. Admins only. */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!isDateFormat(body?.dateFormat)) return NextResponse.json({ error: "Unknown date format" }, { status: 400 });

  const before = readDisplaySettings();
  saveDisplaySettings({ dateFormat: body.dateFormat });
  auditRequest(request, {
    category: "config",
    action: "date_format_saved",
    target: "date format",
    outcome: "success",
    detail: `${before.dateFormat} -> ${body.dateFormat}`,
  });
  return NextResponse.json(readDisplaySettings());
}
