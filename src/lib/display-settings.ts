// How dates and times are shown, for every user and in mails: display.json in
// the data directory. See lib/date-format.ts.

import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { DEFAULT_DATE_FORMAT, isDateFormat, type DateFormat } from "./date-format";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const CONFIG_FILE = path.join(DATA_DIR, "display.json");

export interface DisplaySettings {
  dateFormat: DateFormat;
}

export function readDisplaySettings(): DisplaySettings {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
    return { dateFormat: isDateFormat(raw.dateFormat) ? raw.dateFormat : DEFAULT_DATE_FORMAT };
  } catch {
    return { dateFormat: DEFAULT_DATE_FORMAT };
  }
}

export function saveDisplaySettings(settings: DisplaySettings) {
  writeFileAtomic(CONFIG_FILE, JSON.stringify(settings, null, 2));
}

/** The date format for what the server writes itself (mails). */
export function serverDateFormat(): DateFormat {
  return readDisplaySettings().dateFormat;
}
