import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { isAppliance } from "@/lib/appliance-update";
import {
  assess,
  CRITICAL_DAYS,
  mailStatus,
  readAlertSettings,
  saveAlertSettings,
  WARN_DAYS,
} from "@/lib/os-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How loud the reminder about waiting security updates is right now. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  if (!isAppliance()) return NextResponse.json({ appliance: false });

  return NextResponse.json({
    appliance: true,
    alert: await assess(),
    thresholds: { warnDays: WARN_DAYS, criticalDays: CRITICAL_DAYS },
    settings: readAlertSettings(),
    mail: mailStatus(),
  });
}

/** Turns the reminders, and the mails to admins, on or off. */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  if (!isAppliance()) {
    return NextResponse.json({ error: "Only available on the appliance" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const change = (body ?? {}) as { enabled?: unknown; emailAdmins?: unknown };
  const keys = ["enabled", "emailAdmins"] as const;
  const given = keys.filter((k) => change[k] !== undefined);
  if (given.length === 0 || given.some((k) => typeof change[k] !== "boolean")) {
    return NextResponse.json(
      { error: "enabled and emailAdmins must be true or false" },
      { status: 400 },
    );
  }

  const settings = { ...readAlertSettings() };
  for (const k of given) settings[k] = change[k] as boolean;
  saveAlertSettings(settings);
  auditRequest(request, {
    category: "config",
    action: "os_update_reminders_changed",
    target: !settings.enabled ? "off" : settings.emailAdmins ? "notice and email" : "notice only",
    outcome: "success",
  });
  return NextResponse.json({ settings: readAlertSettings() });
}
