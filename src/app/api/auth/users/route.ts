import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { listUsers, addUser, validatePassword, refreshInviteToken, type UserRole } from "@/lib/auth";
import { auditRequest } from "@/lib/audit";
import { loadSmtpConfig } from "@/lib/smtp-storage";
import { mailBaseUrl } from "@/lib/public-url";
import nodemailer from "nodemailer";

export async function GET(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  return NextResponse.json(listUsers());
}

async function sendInviteEmail(email: string, username: string, token: string, request: NextRequest) {
  const config = loadSmtpConfig();
  if (!config || !config.host) {
    throw new Error("SMTP is not configured");
  }

  // An administrator, signed in, sends it: where they are is a good address.
  const inviteUrl = `${mailBaseUrl(request)}/invite?token=${token}`;

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
    to: email,
    subject: "XenMan – You have been invited",
    text: `Hello ${username},\n\nYou have been invited to XenMan. Click the link below to set your password and activate your account:\n\n${inviteUrl}\n\nThis link expires in 48 hours.\n\nIf you did not expect this email, you can ignore it.`,
    html: `<p>Hello <strong>${username}</strong>,</p><p>You have been invited to XenMan. Click the link below to set your password and activate your account:</p><p><a href="${inviteUrl}">${inviteUrl}</a></p><p>This link expires in 48 hours.</p><p style="color:#888;font-size:12px">If you did not expect this email, you can ignore it.</p>`,
  });
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  try {
    const { username, password, role, email } = await request.json();
    if (!username || !role) {
      return NextResponse.json(
        { error: "Username and role are required" },
        { status: 400 },
      );
    }
    if (!["admin", "operator", "viewer"].includes(role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    // If no password provided, email is required for invite
    if (!password && !email) {
      return NextResponse.json(
        { error: "Either a password or an email address (for invitation) is required" },
        { status: 400 },
      );
    }

    if (password) {
      const pwError = validatePassword(password);
      if (pwError) {
        return NextResponse.json({ error: pwError }, { status: 400 });
      }
    }

    const result = addUser(username, password || undefined, role as UserRole, email);
    if (!result.success) {
      auditRequest(request, {
        category: "user",
        action: "user_created",
        target: `user ${username}`,
        outcome: "failure",
        detail: result.error,
      });
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    auditRequest(request, {
      category: "user",
      action: "user_created",
      target: `user ${username}`,
      outcome: "success",
      detail: `role=${role}${email ? `, email=${email}` : ""}${
        password ? ", password set by admin" : ", invitation pending"
      }`,
    });

    // Send invite email if no password was set
    if (!password && email && result.inviteToken) {
      try {
        await sendInviteEmail(email, username, result.inviteToken, request);
        auditRequest(request, {
          category: "user",
          action: "invite_sent",
          target: `user ${username}`,
          outcome: "success",
          detail: `to ${email}`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        auditRequest(request, {
          category: "user",
          action: "invite_sent",
          target: `user ${username}`,
          outcome: "failure",
          detail: msg,
        });
        return NextResponse.json(
          { error: `User created but invitation email failed: ${msg}` },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// PUT — resend invitation email
export async function PUT(request: NextRequest) {
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  try {
    const { username } = await request.json();
    if (!username) {
      return NextResponse.json({ error: "Username is required" }, { status: 400 });
    }

    const result = refreshInviteToken(username);
    if (!result.success) {
      auditRequest(request, {
        category: "user",
        action: "invite_resent",
        target: `user ${username}`,
        outcome: "failure",
        detail: result.error,
      });
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // Look up user email to send invite
    const users = listUsers();
    const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (user?.email && result.inviteToken) {
      try {
        await sendInviteEmail(user.email, username, result.inviteToken, request);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        auditRequest(request, {
          category: "user",
          action: "invite_resent",
          target: `user ${username}`,
          outcome: "failure",
          detail: msg,
        });
        return NextResponse.json(
          { error: `Token refreshed but invitation email failed: ${msg}` },
          { status: 500 },
        );
      }
    }

    auditRequest(request, {
      category: "user",
      action: "invite_resent",
      target: `user ${username}`,
      outcome: "success",
      detail: user?.email ? `to ${user.email}` : "new token issued, no email on file",
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
