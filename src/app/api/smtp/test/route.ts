import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { loadSmtpConfig } from "@/lib/smtp-storage";
import { auditRequest } from "@/lib/audit";
import nodemailer from "nodemailer";

export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  try {
    const { to } = await request.json();
    if (!to?.trim()) {
      return NextResponse.json({ error: "Recipient address is required" }, { status: 400 });
    }

    const config = loadSmtpConfig();
    if (!config || !config.host) {
      return NextResponse.json({ error: "SMTP is not configured. Save settings first." }, { status: 400 });
    }

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.encryption === "ssl",
      ...(config.encryption === "starttls" ? { requireTLS: true } : {}),
      ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
      tls: {
        rejectUnauthorized: config.validateCertificate,
      },
    });

    await transporter.sendMail({
      from: config.from,
      to: to.trim(),
      subject: "XenMan – SMTP Test",
      text: "This is a test email from XenMan to verify your SMTP configuration.",
      html: "<p>This is a test email from <strong>XenMan</strong> to verify your SMTP configuration.</p>",
    });

    auditRequest(request, {
      category: "config",
      action: "smtp_test_sent",
      target: to.trim(),
      outcome: "success",
      detail: `via ${config.host}:${config.port}`,
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    auditRequest(request, {
      category: "config",
      action: "smtp_test_sent",
      outcome: "failure",
      detail: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
