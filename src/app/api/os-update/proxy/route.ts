import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { parseProxyInput } from "@/lib/os-update";
import { postOsRequest } from "@/lib/os-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sets or removes the proxy apt uses for Debian updates. */
export async function POST(request: NextRequest) {
  // Checked before the body is read, so an anonymous request costs nothing.
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = parseProxyInput(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const p = parsed.proxy;
  return postOsRequest(
    request,
    "set-proxy",
    { action: "os_proxy_requested", target: p ? `${p.host}:${p.port}` : "direct connection" },
    { proxy: p },
  );
}
