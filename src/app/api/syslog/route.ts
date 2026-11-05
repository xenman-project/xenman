import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import {
  journalAvailable,
  parseSyslogConfig,
  readSyslogConfig,
  saveSyslogConfig,
  sendTest,
  syslogStatus,
} from "@/lib/syslog-forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the logs are forwarded to, how that is going, and whether the journal can be read. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  return NextResponse.json({ config: readSyslogConfig(), status: syslogStatus(), journal: await journalAvailable() });
}

/**
 * { enabled, host, port, protocol } saves; with action "test" the same
 * settings send one test message instead, saved or not.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = parseSyslogConfig({ ...body, enabled: body.action === "test" ? true : body.enabled });
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const c = parsed.config;
  const where = `${c.protocol.toUpperCase()} ${c.host}:${c.port}`;

  if (body.action === "test") {
    const error = await sendTest(c, auth.payload.sub);
    auditRequest(request, {
      category: "config",
      action: "syslog_test",
      target: where,
      outcome: error ? "failure" : "success",
      ...(error ? { detail: error } : {}),
    });
    if (error) return NextResponse.json({ error: `Not sent: ${error}` }, { status: 502 });
    return NextResponse.json({ ok: true });
  }

  await saveSyslogConfig(c);
  auditRequest(request, {
    category: "config",
    action: "syslog_config_saved",
    target: c.host ? where : "-",
    outcome: "success",
    detail: c.enabled ? `audit log${c.journal ? " and system journal" : ""} forwarded as RFC 5424 syslog` : "forwarding off",
  });
  return NextResponse.json({ config: readSyslogConfig(), status: syslogStatus(), journal: await journalAvailable() });
}
