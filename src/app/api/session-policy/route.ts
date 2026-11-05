import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { parseSessionPolicy, readSessionPolicy, saveSessionPolicy } from "@/lib/session-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The inactivity timeout. Every signed-in user reads it: their browser enforces it. */
export async function GET(request: NextRequest) {
  if (!authenticateRequest(request)) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json(readSessionPolicy());
}

/** { inactivityMinutes } -- 0 switches it off. Admins only. */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = parseSessionPolicy(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const before = readSessionPolicy();
  saveSessionPolicy(parsed.policy);
  const describe = (m: number) => (m === 0 ? "off" : `${m} min`);
  auditRequest(request, {
    category: "config",
    action: "session_policy_saved",
    target: "inactivity timeout",
    outcome: "success",
    detail: `${describe(before.inactivityMinutes)} -> ${describe(parsed.policy.inactivityMinutes)}`,
  });
  return NextResponse.json(parsed.policy);
}
