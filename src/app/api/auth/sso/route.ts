import { NextResponse } from "next/server";
import { readSsoConfig, ssoActive } from "@/lib/sso-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For the sign-in page, before anyone is signed in: is there a Microsoft button, and who may use a password. */
export async function GET() {
  const config = readSsoConfig();
  const enabled = ssoActive(config);
  return NextResponse.json({ enabled, localAdminsOnly: enabled && config.localAdminsOnly });
}
