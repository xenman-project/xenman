import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { loadSmtpConfig, saveSmtpConfig } from "@/lib/smtp-storage";
import { auditRequest } from "@/lib/audit";
import { SmtpConfig } from "@/lib/types";
import { parsePublicUrl } from "@/lib/public-url";

const PASSWORD_MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  const config = loadSmtpConfig();
  if (!config) return NextResponse.json(null);

  // Mask password in response
  return NextResponse.json({
    ...config,
    password: config.password ? PASSWORD_MASK : "",
  });
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  try {
    const body: SmtpConfig = await request.json();

    if (!body.host?.trim()) {
      return NextResponse.json({ error: "SMTP host is required" }, { status: 400 });
    }
    if (!body.port || body.port < 1 || body.port > 65535) {
      return NextResponse.json({ error: "Invalid port number" }, { status: 400 });
    }
    if (!body.from?.trim()) {
      return NextResponse.json({ error: "Sender address is required" }, { status: 400 });
    }

    const publicUrl = parsePublicUrl(body.publicUrl);
    if ("error" in publicUrl) {
      return NextResponse.json({ error: publicUrl.error }, { status: 400 });
    }
    body.publicUrl = publicUrl.url || undefined;

    // If password is the mask placeholder, preserve existing password
    if (body.password === PASSWORD_MASK) {
      const existing = loadSmtpConfig();
      if (existing) {
        body.password = existing.password;
      }
    }

    saveSmtpConfig(body);
    auditRequest(request, {
      category: "config",
      action: "smtp_config_saved",
      target: `${body.host}:${body.port}`,
      outcome: "success",
      detail: `from=${body.from}, encryption=${body.encryption}, validateCert=${body.validateCertificate}, links=${body.publicUrl ?? "automatic"}${
        body.username ? `, user=${body.username}` : ", unauthenticated"
      }`,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
