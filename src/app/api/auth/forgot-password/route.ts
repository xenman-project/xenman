import { NextRequest, NextResponse } from "next/server";
import { generateResetToken } from "@/lib/auth";
import { auditRequest, clientIp } from "@/lib/audit";
import { resetAllowed } from "@/lib/login-guard";
import { mailBaseUrl } from "@/lib/public-url";
import { loadSmtpConfig } from "@/lib/smtp-storage";
import nodemailer from "nodemailer";

export async function POST(request: NextRequest) {
  try {
    const { usernameOrEmail } = await request.json();
    if (!usernameOrEmail?.trim()) {
      return NextResponse.json(
        { error: "Username or email is required" },
        { status: 400 },
      );
    }

    // Each request may send a mail: a few per address, then a pause.
    if (!resetAllowed(clientIp(request))) {
      return NextResponse.json(
        { error: "Too many requests from this address. Try again later." },
        { status: 429, headers: { "Retry-After": "900" } },
      );
    }

    const result = generateResetToken(usernameOrEmail.trim());

    // Always return success to prevent user enumeration
    if (!result.success || !result.token || !result.email) {
      // The response hides whether the account exists; the admin-only audit
      // log records what actually happened.
      auditRequest(request, {
        actor: String(usernameOrEmail).trim(),
        role: "-",
        category: "auth",
        action: "password_reset_requested",
        outcome: "failure",
        detail: result.error || "No reset token issued",
      });
      return NextResponse.json({ success: true });
    }

    auditRequest(request, {
      actor: result.username || String(usernameOrEmail).trim(),
      role: "-",
      category: "auth",
      action: "password_reset_requested",
      outcome: "success",
      detail: "Reset link issued, valid for 1 hour",
    });

    const config = loadSmtpConfig();
    if (!config || !config.host) {
      return NextResponse.json({ success: true });
    }

    // Never from this request: anyone can send it, with any Host header.
    const resetUrl = `${mailBaseUrl()}/reset-password?token=${result.token}`;

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.encryption === "ssl",
      ...(config.encryption === "starttls" ? { requireTLS: true } : {}),
      ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
      tls: { rejectUnauthorized: config.validateCertificate },
    });

    await transporter.sendMail({
      from: config.from,
      to: result.email,
      subject: "XenMan – Password Reset",
      text: `Hello ${result.username},\n\nA password reset was requested for your XenMan account. Click the link below to set a new password:\n\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>Hello <strong>${result.username}</strong>,</p><p>A password reset was requested for your XenMan account. Click the link below to set a new password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p><p style="color:#888;font-size:12px">If you did not request this, you can ignore this email.</p>`,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: true });
  }
}
