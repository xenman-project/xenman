import fs from "fs";
import path from "path";
import { XenHost } from "./types";
import { keySource, needsReseal, seal, unseal } from "./secret-box";
import { writeFileAtomic } from "./atomic-write";
import { audit } from "./audit";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const HOSTS_FILE = path.join(DATA_DIR, "hosts.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// What could not be decrypted -- written by another installation, whose key
// is not here -- is kept as it was, so that saving the list does not lose it.
const g = globalThis as unknown as { _xenmanUnreadableHostPasswords?: Map<string, string> };
const unreadable = (g._xenmanUnreadableHostPasswords ??= new Map());

export function loadHostsFromDisk(): XenHost[] {
  let stored: XenHost[];
  try {
    ensureDataDir();
    if (!fs.existsSync(HOSTS_FILE)) return [];
    stored = JSON.parse(fs.readFileSync(HOSTS_FILE, "utf-8"));
  } catch {
    return [];
  }
  let reseal = 0;
  // Each password on its own: one that does not open costs that pool its
  // password, not the whole list.
  const hosts = stored.map((h) => {
    try {
      const password = unseal(h.password ?? "");
      if (needsReseal(h.password ?? "")) reseal++;
      unreadable.delete(h.id);
      return { ...h, password };
    } catch (err) {
      if (!unreadable.has(h.id)) {
        console.error(`[hosts] password of "${h.name || h.address}": ${err instanceof Error ? err.message : err}`);
      }
      unreadable.set(h.id, h.password);
      return { ...h, password: "", passwordUnreadable: true };
    }
  });
  // Written before with another key -- the login secret's, or the fallback --
  // now with the current one.
  if (reseal) {
    saveHostsToDisk(hosts);
    audit({
      actor: "system",
      role: "-",
      ip: "-",
      category: "config",
      action: "host_passwords_resealed",
      outcome: "success",
      detail: `${reseal} stored password(s) re-encrypted with ${
        keySource() === "credential"
          ? "the appliance's own key, kept outside the data directory"
          : "a key of the data directory's own, apart from the login secret"
      }`,
    });
  }
  return hosts;
}

export function saveHostsToDisk(hosts: XenHost[]) {
  ensureDataDir();
  const encrypted = hosts.map((host) => {
    const h: XenHost = { ...host };
    delete h.passwordUnreadable;
    // An empty password is one that could not be read: what was stored stays.
    return { ...h, password: h.password ? seal(h.password) : (unreadable.get(h.id) ?? "") };
  });
  // Readable by XenMan only.
  writeFileAtomic(HOSTS_FILE, JSON.stringify(encrypted, null, 2), 0o600);
}
