import nodemailer from "nodemailer";
import { loadSmtpConfig } from "./smtp-storage";
import type { SmtpConfig } from "./types";

/**
 * The transport for the configured mail server, with the same options the
 * invitation, password-reset and test routes use. Those still build their own;
 * new senders should come here instead of adding another copy.
 */
export function smtpTransport(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.encryption === "ssl",
    ...(config.encryption === "starttls" ? { requireTLS: true } : {}),
    ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
    tls: { rejectUnauthorized: config.validateCertificate },
  });
}

export function smtpConfigured(): boolean {
  return loadSmtpConfig() !== null;
}

/** Sends to everyone in `to` at once. "no-smtp" when no mail server is set up. */
export async function sendMail(message: {
  to: string[];
  subject: string;
  text: string;
  html: string;
}): Promise<"sent" | "no-smtp"> {
  const config = loadSmtpConfig();
  if (!config) return "no-smtp";
  await smtpTransport(config).sendMail({ from: config.from, ...message });
  return "sent";
}
