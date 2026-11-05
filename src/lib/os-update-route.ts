import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import { isAppliance, isInstalling } from "@/lib/appliance-update";
import { OsAction, OsRequestError, submitRequest } from "@/lib/os-update";

/**
 * The shared body of the routes that ask the root side to act: admin only,
 * appliance only, never across an application update, and audited under the
 * name of whoever asked -- the root side records what it then did.
 */
export async function postOsRequest(
  request: NextRequest,
  action: OsAction,
  audit: { action: string; target: string },
  payload?: Parameters<typeof submitRequest>[2],
  /** Returned with the request id, for what the browser needs next. */
  extra?: Record<string, unknown>,
): Promise<NextResponse> {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  if (!isAppliance()) {
    return NextResponse.json({ error: "Only available on the appliance" }, { status: 404 });
  }
  if (isInstalling()) {
    return NextResponse.json(
      { error: "An application update is in progress" },
      { status: 409 },
    );
  }

  try {
    const id = submitRequest(action, auth.payload.sub, payload);
    auditRequest(request, {
      category: "system",
      action: audit.action,
      target: audit.target,
      outcome: "success",
    });
    return NextResponse.json({ id, ...extra });
  } catch (err) {
    const message = err instanceof OsRequestError ? err.message : "Could not submit the request";
    auditRequest(request, {
      category: "system",
      action: audit.action,
      target: audit.target,
      outcome: "failure",
      detail: message,
    });
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
