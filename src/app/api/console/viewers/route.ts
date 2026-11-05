import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";

/**
 * Who else is on a VM console.
 *
 * The register is filled by vnc-proxy.js, which runs outside the Next module
 * graph — every VNC session is proxied through this process, so the answer is
 * exact and costs XAPI nothing. See the note there for the shape.
 */
interface ViewerEntry {
  actor: string;
  since: number;
}

function viewerRegistry(): Map<string, Map<string, ViewerEntry>> | undefined {
  return (
    globalThis as typeof globalThis & {
      _xenVncViewers?: Map<string, Map<string, ViewerEntry>>;
    }
  )._xenVncViewers;
}

export interface ConsoleViewer {
  actor: string;
  /** Open connections for this person — a second browser tab counts here. */
  sessions: number;
  /** Earliest connection, ISO-8601. */
  since: string;
  self: boolean;
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const consoleUrl = request.nextUrl.searchParams.get("consoleUrl");
  if (!consoleUrl) {
    return NextResponse.json({ error: "Missing consoleUrl" }, { status: 400 });
  }

  const entries = [...(viewerRegistry()?.get(consoleUrl)?.values() ?? [])];

  // The only people who may ask who is on a console are the people on it. That
  // makes this self-authorising: no second pool-grant check to keep in sync,
  // and no way to probe which consoles anyone else has open.
  const me = auth.sub.toLowerCase();
  if (!entries.some((e) => e.actor.toLowerCase() === me)) {
    return NextResponse.json(
      { error: "Not connected to this console" },
      { status: 403 },
    );
  }

  // One row per person, not per tab.
  const byActor = new Map<string, { actor: string; sessions: number; since: number }>();
  for (const entry of entries) {
    const key = entry.actor.toLowerCase();
    const existing = byActor.get(key);
    if (existing) {
      existing.sessions += 1;
      existing.since = Math.min(existing.since, entry.since);
    } else {
      byActor.set(key, { actor: entry.actor, sessions: 1, since: entry.since });
    }
  }

  const viewers: ConsoleViewer[] = [...byActor.entries()]
    .map(([key, v]) => ({
      actor: v.actor,
      sessions: v.sessions,
      since: new Date(v.since).toISOString(),
      self: key === me,
    }))
    .sort((a, b) => a.since.localeCompare(b.since));

  return NextResponse.json({ viewers });
}
