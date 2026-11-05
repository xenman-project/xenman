// A pool's licence as XenCenter's License Manager shows it (Dialogs/LicenseManager:
// LicenseStatus, LicenseDataGridViewRow, the summary decorators), texts as
// XenCenter's. Newer than xenadmin's published source: the cloud-based
// licence (edition "cloud", sku_marketing_name "XenServer Premium Edition
// (cloud-based)") -- shown as XenCenter 8 shows it: "Licensing Mode:
// Cloud-based", "Entitlement valid until:" (from license_params of a real host).

type Rec = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Rec).map(([k, x]) => [k, String(x)])) : {};

export type LicenseIcon = "ok" | "warning" | "error";

export interface LicenseRow {
  /** Column "License" and "License Type:". */
  license: string;
  /** "Licensing Mode:" -- only where it is known (cloud). */
  mode: string | null;
  /** Column "Status": "Licensed; Active CSS". */
  status: string;
  icon: LicenseIcon;
  /** "Entitlement valid until:" (ISO), null for free; "Never" when infinite. */
  expiry: string | null;
  expiryNever: boolean;
  /** "License Server:", with the link XenCenter opens (its web console, port 8082). */
  licenseServer: { text: string; link: string | null } | null;
  /** The licence lines under the summary, with their icon. */
  licenseLines: string[];
  licenseIcon: LicenseIcon;
  /** "Active support agreement" / "Expired support agreement" (with the pool's message). */
  supportLines: string[] | null;
  supportIcon: LicenseIcon;
  sockets: number;
  /** Whether a licence server is in use (XenCenter: Release License). */
  usesLicenseServer: boolean;
}

type State = "Unknown" | "Expired" | "ExpiresSoon" | "RegularGrace" | "UpgradeGrace" | "Licensed" | "PartiallyLicensed" | "Free" | "Unavailable";

const FREE = new Set(["", "free", "express", "trial", "basic"]);
const isFree = (h: Rec) => FREE.has(str(h.edition));

/** Host.LicenseExpiryUTC: license_params expiry, else far away. */
function expiryOf(h: Rec): number {
  const e = obj(h.license_params).expiry ?? "";
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(e);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.UTC(2030, 0, 1);
}

/** css_expiry: "2028.0125" (yyyy.MMdd), not an ISO date. */
function cssExpiryOf(h: Rec): number | null {
  const m = /^(\d{4})\.(\d{2})(\d{2})$/.exec((obj(h.license_params).css_expiry ?? "").trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

/** TimeSpan.FuzzyTime, roughly as XenCenter words it. */
function fuzzy(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2) return `${days} days`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 2) return `${hours} hours`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** XenCenter's licence name: the marketing name, the cloud-based mode said apart. */
function licenseName(h: Rec): string {
  const sku = (obj(h.license_params).sku_marketing_name ?? "").replace(/\s*\(cloud-based\)\s*$/i, "").trim();
  if (sku) return sku;
  const e = str(h.edition);
  return e ? e.charAt(0).toUpperCase() + e.slice(1) : "Unknown";
}

export function buildLicenseRow(hosts: Record<string, Rec>, masterRef: string, serverNow: number): LicenseRow {
  const all = Object.values(hosts);
  // LicenseStatus.SetMinimumLicenseValueHost: the host whose licence ends first speaks for the pool.
  let lh: Rec | undefined = hosts[masterRef];
  for (const h of all) if (!lh || expiryOf(h) < expiryOf(lh)) lh = h;
  if (!lh) {
    return {
      license: "Unknown", mode: null, status: "Unknown", icon: "warning", expiry: null, expiryNever: false, licenseServer: null,
      licenseLines: ["Unknown"], licenseIcon: "warning", supportLines: null, supportIcon: "ok", sockets: 0, usesLicenseServer: false,
    };
  }
  const lp = obj(lh.license_params);
  const expiresIn = expiryOf(lh) - serverNow;
  const days = expiresIn / 86_400_000;
  const free = isFree(lh);

  // CalculateCurrentState.
  const freeCount = all.filter(isFree).length;
  const partially = all.length > 1 && freeCount > 0 && freeCount < all.length;
  const expiry = new Date(expiryOf(lh));
  let state: State;
  if (lp.expiry && expiry.getUTCFullYear() === 1970 && expiry.getUTCMonth() === 0 && expiry.getUTCDate() === 1) state = "Unavailable";
  else if (partially) state = "PartiallyLicensed";
  else if (free) state = "Free";
  else if (days >= 30) state = "Licensed"; // not a grace licence (IsGraceLicence: under 30 days)
  else if (expiresIn <= 0) state = "Expired";
  else if (lp.grace === "regular grace") state = "RegularGrace";
  else if (lp.grace === "upgrade grace") state = "UpgradeGrace";
  else state = "ExpiresSoon";

  // The licence's own text and icon (ShouldShowLicenseWarningText).
  let licenseLines: string[];
  let licenseIcon: LicenseIcon;
  let statusText: string;
  const mixed = all.length > 1 && freeCount === 0 && new Set(all.map((h) => str(h.edition))).size > 1;
  switch (state) {
    case "Free":
      licenseLines = ["Trial license"];
      licenseIcon = "warning";
      statusText = "Unlicensed";
      break;
    case "PartiallyLicensed":
      licenseLines = ["The pool is partially licensed"];
      licenseIcon = "warning";
      statusText = "Partially Licensed";
      break;
    case "Licensed": {
      const sku = lp.sku_marketing_name ?? "";
      const level = /premium/i.test(sku) ? "Premium features enabled" : /standard/i.test(sku) ? "Standard features only" : null;
      licenseLines = mixed ? ["This pool has hosts with different types of license."] : ["Licensed", ...(level ? [level] : [])];
      licenseIcon = "ok";
      statusText = "Licensed";
      break;
    }
    case "Unavailable":
      licenseLines = ["No licenses available"];
      licenseIcon = "error";
      statusText = "Unlicensed";
      break;
    case "Expired":
      licenseLines = ["Your license has expired"];
      licenseIcon = "error";
      statusText = "Unlicensed";
      break;
    default:
      licenseLines = [`Your license expires in ${fuzzy(expiresIn)}`];
      licenseIcon = "warning";
      statusText = fuzzy(expiresIn);
  }

  // Support (CSS): from css_expiry; only shown when the host reports it.
  const css = cssExpiryOf(lh);
  let supportLines: string[] | null = null;
  let supportIcon: LicenseIcon = "ok";
  let supportStatus = "";
  if (css !== null) {
    const active = serverNow < css + 86_400_000;
    supportLines = active
      ? ["Active support agreement"]
      : ["Expired support agreement", "Your Customer Success Services (CSS) agreement has expired. This pool will not receive any updates, including security updates"];
    supportIcon = active ? "ok" : "error";
    supportStatus = active ? "Active CSS" : "Expired CSS";
  }
  // RowStatus: different verdicts read as a warning.
  const icon: LicenseIcon = supportLines && licenseIcon !== supportIcon ? "warning" : licenseIcon;

  const server = obj(lh.license_server);
  const address = free ? "" : (server.address ?? "");
  const port = free ? "" : (server.port ?? "");
  const sockets = all.reduce((n, h) => n + (Number(obj(h.license_params).sockets) || Number(obj(h.cpu_info).socket_count) || 0), 0);

  return {
    license: licenseName(lh),
    mode: str(lh.edition) === "cloud" ? "Cloud-based" : null,
    status: [statusText, supportStatus].filter(Boolean).join("; "),
    icon,
    expiry: free || !lp.expiry ? null : new Date(expiryOf(lh)).toISOString(),
    expiryNever: !free && days >= 3653,
    licenseServer: address
      ? { text: port ? `${address}:${port}` : address, link: address.toLowerCase() === "localhost" ? null : `http://${address}:8082` }
      : null,
    licenseLines,
    licenseIcon,
    supportLines,
    supportIcon,
    sockets,
    usesLicenseServer: Boolean(address),
  };
}
