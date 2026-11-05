import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";

/**
 * What a console connection measures, for the console's connection info:
 * whether XenMan asks the host ahead for pictures (and if not, why), how long
 * the host takes to answer, and the round trip to the browser.
 *
 * Filled by vnc-proxy.js under an id the console page chose for its
 * connection; only the person on that connection gets it.
 */
interface StatsEntry {
  actor: string;
  read(): Record<string, unknown>;
}

function statsRegistry(): Map<string, StatsEntry> | undefined {
  return (globalThis as typeof globalThis & { _xenVncStats?: Map<string, StatsEntry> })._xenVncStats;
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const entry = statsRegistry()?.get(id);
  if (!entry || entry.actor.toLowerCase() !== auth.sub.toLowerCase()) {
    return NextResponse.json({ error: "No such console connection" }, { status: 404 });
  }
  return NextResponse.json(entry.read());
}
