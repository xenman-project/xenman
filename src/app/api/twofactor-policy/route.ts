import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { listUsers } from "@/lib/auth";
import { parseTwoFactorPolicy, readTwoFactorPolicy, saveTwoFactorPolicy, type TwoFactorRequirement } from "@/lib/twofactor-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who has not set up two-factor sign-in yet, for the policy card: what switching it on means. */
function withoutTotp() {
  const users = listUsers().filter((u) => !u.invited);
  return {
    admins: users.filter((u) => u.role === "admin" && !u.totpEnabled).length,
    others: users.filter((u) => u.role !== "admin" && !u.totpEnabled).length,
  };
}

/** The two-factor policy; every signed-in user may read it. */
export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  return NextResponse.json({ ...readTwoFactorPolicy(), ...(auth.role === "admin" ? { withoutTotp: withoutTotp() } : {}) });
}

/** { require: "none" | "admins" | "all" }. Admins only. */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = parseTwoFactorPolicy(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const before = readTwoFactorPolicy();
  saveTwoFactorPolicy(parsed.policy);
  const describe = (r: TwoFactorRequirement) => (r === "none" ? "not required" : r === "admins" ? "required for administrators" : "required for everyone");
  auditRequest(request, {
    category: "config",
    action: "twofactor_policy_saved",
    target: "two-factor sign-in",
    outcome: "success",
    detail: `${describe(before.require)} -> ${describe(parsed.policy.require)}`,
  });
  return NextResponse.json({ ...parsed.policy, withoutTotp: withoutTotp() });
}
