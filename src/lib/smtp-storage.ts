import fs from "fs";
import path from "path";
import { SmtpConfig } from "./types";
import { needsReseal, seal, unseal } from "./secret-box";
import { writeFileAtomic } from "./atomic-write";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const SMTP_FILE = path.join(DATA_DIR, "smtp.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadSmtpConfig(): SmtpConfig | null {
  try {
    ensureDataDir();
    if (!fs.existsSync(SMTP_FILE)) return null;
    const raw = fs.readFileSync(SMTP_FILE, "utf-8");
    const config: SmtpConfig = JSON.parse(raw);
    if (config.password) {
      const stored = config.password;
      try {
        config.password = unseal(stored);
      } catch (err) {
        // Written by another installation: the rest of the settings still count.
        console.error(`[smtp] password: ${err instanceof Error ? err.message : err}`);
        config.password = "";
        return config;
      }
      // Written before with another key: now with the current one.
      if (needsReseal(stored)) saveSmtpConfig(config);
    }
    return config;
  } catch {
    return null;
  }
}

export function saveSmtpConfig(config: SmtpConfig) {
  ensureDataDir();
  const encrypted: SmtpConfig = {
    ...config,
    password: config.password ? seal(config.password) : "",
  };
  writeFileAtomic(SMTP_FILE, JSON.stringify(encrypted, null, 2), 0o600);
}
