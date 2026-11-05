import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import {
  currentVersion,
  installedRelease,
  isDowngrade,
  isInstalling,
  requestInstall,
  stagedManifest,
  UploadError,
} from "@/lib/appliance-update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts the installation. This only writes the trigger file a root path unit
 * watches — the updater then checks the package against the release key and
 * decides for itself. XenMan cannot install anything by asking nicely.
 *
 * The response is sent before the service is stopped, but the client will lose
 * the connection moments later: it is updating the server answering it. The UI
 * treats that as expected and polls until the new version answers.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  if (isInstalling()) {
    return NextResponse.json({ error: "An update is already in progress" }, { status: 409 });
  }

  const manifest = await stagedManifest();
  if (!manifest) {
    return NextResponse.json({ error: "No package has been uploaded" }, { status: 400 });
  }

  // The updater would refuse this too, as root; answering here saves a round
  // trip and records the attempt under the name of whoever made it.
  const installed = installedRelease();
  if (isDowngrade(manifest, installed)) {
    auditRequest(request, {
      category: "system",
      action: "appliance_update_started",
      target: `${currentVersion()} -> ${manifest.version}`,
      outcome: "denied",
      detail: `package built ${manifest.builtAt} is older than the installed ${installed?.version} (built ${installed?.builtAt})`,
    });
    return NextResponse.json(
      {
        error:
          "This package is older than the installed version. Downgrades are refused from the web interface; one made on purpose needs a root shell on the appliance: xenman-updater --allow-downgrade <package>",
      },
      { status: 409 },
    );
  }

  try {
    await requestInstall();
  } catch (err) {
    const message = err instanceof UploadError ? err.message : "could not start the update";
    auditRequest(request, {
      category: "system",
      action: "appliance_update_started",
      target: manifest.version,
      outcome: "failure",
      detail: message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Recorded here as well as by the updater: this line names the person who
  // asked, which the root service cannot know.
  auditRequest(request, {
    category: "system",
    action: "appliance_update_started",
    target: `${currentVersion()} -> ${manifest.version}`,
    outcome: "success",
    detail: `commit=${manifest.commit}`,
  });

  return NextResponse.json({ started: true, version: manifest.version });
}
