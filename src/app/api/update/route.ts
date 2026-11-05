import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { auditRequest } from "@/lib/audit";
import {
  discardPackage,
  installedRelease,
  isAppliance,
  isDowngrade,
  isInstalling,
  readStatus,
  stagePackage,
  stagedManifest,
  systemInfo,
  updatesEnabled,
  UploadError,
} from "@/lib/appliance-update";

// fs and child_process rule out the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  if (!isAppliance()) {
    return NextResponse.json({ appliance: false });
  }

  const staged = await stagedManifest();
  const installed = installedRelease();
  return NextResponse.json({
    appliance: true,
    enabled: updatesEnabled(),
    installing: isInstalling(),
    status: readStatus(),
    staged,
    installed,
    stagedIsDowngrade: staged ? isDowngrade(staged, installed) : false,
    system: await systemInfo(),
  });
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  if (!updatesEnabled()) {
    return NextResponse.json(
      { error: "This appliance was built without a release key and cannot install updates." },
      { status: 400 },
    );
  }
  if (isInstalling()) {
    return NextResponse.json({ error: "An update is already in progress" }, { status: 409 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "No package in the request body" }, { status: 400 });
  }

  try {
    // Compared with what actually arrives, to catch a body cut short on the way.
    const announced = Number(request.headers.get("content-length"));
    const manifest = await stagePackage(
      request.body,
      Number.isFinite(announced) && announced > 0 ? announced : null,
    );
    auditRequest(request, {
      category: "system",
      action: "appliance_update_uploaded",
      target: manifest.version,
      outcome: "success",
      detail: `commit=${manifest.commit}, built=${manifest.builtAt}, ${manifest.payloadBytes} bytes`,
    });
    return NextResponse.json({ manifest });
  } catch (err) {
    const message = err instanceof UploadError ? err.message : "upload failed";
    auditRequest(request, {
      category: "system",
      action: "appliance_update_uploaded",
      outcome: "failure",
      detail: message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  if (isInstalling()) {
    return NextResponse.json({ error: "An update is already in progress" }, { status: 409 });
  }

  await discardPackage();
  auditRequest(request, {
    category: "system",
    action: "appliance_update_discarded",
    outcome: "success",
  });
  return NextResponse.json({ success: true });
}
