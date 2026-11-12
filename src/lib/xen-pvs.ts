/**
 * PVS-Accelerator, as XenCenter's PVS tab and its dialogs show and change it
 * (TabPages/PvsPage.cs, Dialogs/EnablePvsReadCachingDialog.cs,
 * Dialogs/PvsPages/PvsCacheConfigurationPage.cs, Controls/PvsCacheStorageRow.cs,
 * Actions/PVS/*):
 *
 * - The tab: every real VM, whether read caching is on (a PVS_proxy on its
 *   VIF), its site and the proxy's status. Only where every host is licensed
 *   for it (license_params restrict_pvs_proxy "false") and the pool can do it
 *   (platform 3.3.0 or later, or the pvsaccelerator update on the coordinator).
 * - Enabling: PVS_proxy.create(site, the VM's VIF with device "0"); VMs that
 *   have a proxy already, or no VIF 0, are left out -- XenCenter silently,
 *   XenMan says which. Disabling: PVS_proxy.destroy.
 * - A site's cache, per host: not configured, memory only (the host's tmpfs
 *   SR, made as XenCenter makes it when there is none) or an SR that can hold
 *   it, 1 to 2048 GB. Storage in use -- a running VM of the site on that host
 *   caching through it -- cannot be changed. Saving destroys a host's old
 *   storage and creates the new one; "not configured" only destroys (where
 *   XenCenter, by a slip, would make memory storage instead).
 * - Removing a site: not while VMs are streamed from it; its servers are
 *   forgotten first, then the site.
 *
 * Texts are XenCenter's.
 */

import { asyncCall, type XapiCall } from "./xen-network-actions";

type Rec = Record<string, unknown>;
type Recs = Record<string, Rec>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v) || 0;
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const isRef = (v: unknown) => typeof v === "string" && /^OpaqueRef:[\w-]+$/.test(v) && v !== "OpaqueRef:NULL";

const GIB = 1024 ** 3;
export const PVS_CACHE = { minGb: 1, maxGb: 2048, defaultGb: 10 } as const;

export const PVS_TEXTS = {
  unlicensed: "PVS-Accelerator is not available with the license of this pool.",
  incapable: "PVS-Accelerator needs XenServer 8, or the PVS-Accelerator supplemental pack on the pool coordinator.",
  noSites: "No PVS site is configured. Configure PVS-Accelerator to add one.",
  incompletePvs: "(Incomplete PVS configuration)",
  incompleteCache: "(Incomplete Cache Storage configuration)",
  siteToComplete: "The PVS-Accelerator configuration for this site must be completed using the PVS console or MCLI.",
  inUseNote: "The cache storage cannot be changed on servers where it is in use.",
  sizeNote: "The cache size recommendation is at least 5GB per vDisk version. If Memory only is chosen, the allowed cache size depends on the server's Control Domain memory.",
  memoryShort: "Memory only (Not enough Control Domain memory)",
  siteStreaming: "This cache configuration cannot be removed because there are VMs that are streamed from this site.",
} as const;

const STATUS: Record<string, string> = {
  stopped: "Stopped",
  initialised: "Initialized",
  caching: "Caching",
  incompatible_write_cache_mode: "Incompatible write cache mode",
  incompatible_protocol_version: "Incompatible protocol version",
};
export const pvsStatusText = (status: unknown) => STATUS[str(status)] ?? "Unknown";

export interface PvsRecords {
  sites: Recs;
  servers: Recs;
  proxies: Recs;
  storages: Recs;
  vms: Recs;
  vifs: Recs;
  hosts: Recs;
  srs: Recs;
  pbds: Recs;
  sms: Recs;
  updates: Recs;
  pool: Rec;
}

export async function loadPvsRecords(call: XapiCall): Promise<PvsRecords> {
  const all = (cls: string) => call<Recs>(`${cls}.get_all_records`, []);
  // Pools without PVS objects (older XenServer) have none of these classes.
  const maybe = (cls: string) => all(cls).catch(() => ({}) as Recs);
  const [sites, servers, proxies, storages, vms, vifs, hosts, srs, pbds, sms, updates, pools] = await Promise.all([
    maybe("PVS_site"), maybe("PVS_server"), maybe("PVS_proxy"), maybe("PVS_cache_storage"),
    all("VM"), all("VIF"), all("host"), all("SR"), all("PBD"), all("SM"), maybe("pool_update"), all("pool"),
  ]);
  return { sites, servers, proxies, storages, vms, vifs, hosts, srs, pbds, sms, updates, pool: Object.values(pools)[0] ?? {} };
}

/** Host.RestrictPvsCache on every host (BoolKeyPreferTrue). */
const licensed = (r: PvsRecords) =>
  Object.values(r.hosts).every((h) => str(obj(h.license_params).restrict_pvs_proxy) === "false");

const atLeast = (version: string, want: number[]) => {
  const have = version.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < want.length; i++) if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i];
  return true;
};

/** Helpers.PvsCacheCapability: XenServer 8 (platform 3.3.0), or the supplemental pack on the coordinator. */
function capable(r: PvsRecords): boolean {
  const coordinator = r.hosts[str(r.pool.master)];
  if (!coordinator) return false;
  if (atLeast(str(obj(coordinator.software_version).platform_version), [3, 3, 0])) return true;
  return list(coordinator.updates).some((u) => str(r.updates[u]?.name_label).toLowerCase().startsWith("pvsaccelerator"));
}

/** VM.IsRealVm and Show: not a template, snapshot or control domain, not hidden. */
function realVm(vm: Rec): boolean {
  if (vm.is_a_template === true || vm.is_a_snapshot === true || vm.is_control_domain === true) return false;
  if (str(vm.name_label).startsWith("__gui__")) return false;
  return str(obj(vm.other_config).HideFromXenCenter) !== "true";
}

/** VM.PvsProxy: the proxy on one of its VIFs. */
function proxyOf(r: PvsRecords, vmRef: string): [string, Rec] | null {
  return Object.entries(r.proxies).find(([, p]) => str(r.vifs[str(p.VIF)]?.VM) === vmRef) ?? null;
}

/** PVS_site.NameWithWarning. */
function siteLabel(r: PvsRecords, siteRef: string): string {
  const site = r.sites[siteRef];
  if (!site) return "-";
  const name = str(site.name_label);
  if (!str(site.PVS_uuid)) return `${name} ${PVS_TEXTS.incompletePvs}`;
  const covered = new Set(list(site.cache_storage).map((s) => str(r.storages[s]?.host)));
  if (!Object.keys(r.hosts).every((h) => covered.has(h))) return `${name} ${PVS_TEXTS.incompleteCache}`;
  return name;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** SR.CanBeSeenFrom: a PBD of the SR attached on that host. */
const seenFrom = (r: PvsRecords, srRef: string, hostRef: string) =>
  list(r.srs[srRef]?.PBDs).some((p) => str(r.pbds[p]?.host) === hostRef && r.pbds[p]?.currently_attached === true);

/** SR.SupportsVdiCreate and SR.Show, with at least 1 GiB free: an SR the cache can go to. */
function eligibleSr(r: PvsRecords, srRef: string, hostRef: string): boolean {
  const sr = r.srs[srRef];
  if (!sr || !seenFrom(r, srRef, hostRef)) return false;
  if (str(sr.content_type) === "iso" || str(sr.type) === "tmpfs" || str(sr.type) === "local") return false;
  if (str(sr.name_label).startsWith("__gui__") || str(obj(sr.other_config).HideFromXenCenter) === "true") return false;
  const sm = Object.values(r.sms).find((s) => str(s.type) === str(sr.type));
  if (!list(sm?.capabilities).includes("VDI_CREATE")) return false;
  return freeSpace(sr) >= GIB;
}
const freeSpace = (sr: Rec) => num(sr.physical_size) - num(sr.physical_utilisation);

/** Host.dom0_memory_extra: what the control domain may be grown by. */
function dom0Extra(r: PvsRecords, hostRef: string): number {
  const dom0 = Object.values(r.vms).find((v) => v.is_control_domain === true && str(v.resident_on) === hostRef);
  return dom0 ? Math.max(0, num(dom0.memory_static_max) - num(dom0.memory_static_min)) : 0;
}

/** The host's memory SR (tmpfs), if there is one. */
function memorySr(r: PvsRecords, hostRef: string): string | null {
  return Object.keys(r.srs).find((s) => str(r.srs[s].type) === "tmpfs" && seenFrom(r, s, hostRef)) ?? null;
}

/** PVS_cache_storage.IsInUse: a running VM of the site on that host caches through it. */
function inUse(r: PvsRecords, storage: Rec): boolean {
  return Object.values(r.proxies).some(
    (p) =>
      p.currently_attached === true &&
      str(p.site) === str(storage.site) &&
      str(r.vms[str(r.vifs[str(p.VIF)]?.VM)]?.resident_on) === str(storage.host),
  );
}

const gbDown = (bytes: number) => Math.floor(bytes / GIB);

export interface PvsStorageOption {
  /** "none", "memory" or an SR ref. */
  value: string;
  label: string;
  disabled?: boolean;
  /** The largest cache it takes, in GB. */
  maxGb?: number;
}

export interface PvsHostRow {
  host: string;
  hostName: string;
  /** What is set now: "none", "memory" or an SR ref. */
  storage: string;
  sizeGb: number;
  inUse: boolean;
  options: PvsStorageOption[];
}

export interface PvsSiteView {
  ref: string;
  name: string;
  label: string;
  pvsUuid: string;
  streaming: number;
  servers: { addresses: string[]; firstPort: number; lastPort: number }[];
  hosts: PvsHostRow[];
}

export interface PvsVmRow {
  ref: string;
  name: string;
  enabled: boolean;
  site: string | null;
  siteLabel: string;
  status: string;
  running: boolean;
}

export interface PvsOverview {
  licensed: boolean;
  capable: boolean;
  vms: PvsVmRow[];
  sites: PvsSiteView[];
  /** The rows of a site not added yet. */
  newSiteHosts: PvsHostRow[];
}

function hostRows(r: PvsRecords, siteRef: string | null): PvsHostRow[] {
  const site = siteRef ? r.sites[siteRef] : undefined;
  return Object.entries(r.hosts)
    .map(([hostRef, h]) => {
      const storageEntry = site ? list(site.cache_storage).map((s) => [s, r.storages[s]] as const).find(([, s]) => s && str(s.host) === hostRef) : undefined;
      const storage = storageEntry?.[1];
      const extra = dom0Extra(r, hostRef);
      const options: PvsStorageOption[] = [{ value: "none", label: "Not configured" }];
      options.push(
        extra >= GIB
          ? { value: "memory", label: "Memory only", maxGb: Math.min(PVS_CACHE.maxGb, gbDown(extra)) }
          : { value: "memory", label: PVS_TEXTS.memoryShort, disabled: true },
      );
      const srs = Object.keys(r.srs)
        .filter((s) => eligibleSr(r, s, hostRef))
        .sort((a, b) => natural(str(r.srs[a].name_label), str(r.srs[b].name_label)));
      for (const s of srs) options.push({ value: s, label: str(r.srs[s].name_label), maxGb: Math.min(PVS_CACHE.maxGb, gbDown(freeSpace(r.srs[s]))) });
      let current = "none";
      if (storage) {
        const sr = r.srs[str(storage.SR)];
        current = sr && str(sr.type) === "tmpfs" ? "memory" : str(storage.SR);
        // Its SR is offered even when it would no longer qualify: it is where the cache is.
        if (current !== "memory" && !options.some((o) => o.value === current)) {
          options.push({ value: current, label: str(sr?.name_label) || current, maxGb: PVS_CACHE.maxGb });
        }
      }
      return {
        host: hostRef,
        hostName: str(h.name_label),
        storage: current,
        sizeGb: storage ? Math.max(PVS_CACHE.minGb, Math.round(num(storage.size) / GIB)) : PVS_CACHE.defaultGb,
        inUse: storage ? inUse(r, storage) : false,
        options,
      };
    })
    .sort((a, b) => natural(a.hostName, b.hostName));
}

export function buildPvsOverview(r: PvsRecords): PvsOverview {
  const vms: PvsVmRow[] = Object.entries(r.vms)
    .filter(([, vm]) => realVm(vm))
    .map(([ref, vm]) => {
      const proxy = proxyOf(r, ref)?.[1];
      const site = proxy && isRef(proxy.site) && r.sites[str(proxy.site)] ? str(proxy.site) : null;
      return {
        ref,
        name: str(vm.name_label),
        enabled: !!proxy,
        site,
        siteLabel: proxy && site ? siteLabel(r, site) : "-",
        status: proxy ? pvsStatusText(proxy.status) : "-",
        running: str(vm.power_state) === "Running",
      };
    })
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || natural(a.name, b.name));
  const sites: PvsSiteView[] = Object.entries(r.sites)
    .map(([ref, s]) => ({
      ref,
      name: str(s.name_label),
      label: siteLabel(r, ref),
      pvsUuid: str(s.PVS_uuid),
      streaming: Object.values(r.proxies).filter((p) => str(p.site) === ref).length,
      servers: Object.values(r.servers)
        .filter((sv) => str(sv.site) === ref)
        .map((sv) => ({ addresses: list(sv.addresses), firstPort: num(sv.first_port), lastPort: num(sv.last_port) })),
      hosts: hostRows(r, ref),
    }))
    .sort((a, b) => natural(a.name, b.name));
  return { licensed: licensed(r), capable: capable(r), vms, sites, newSiteHosts: hostRows(r, null) };
}

// ─── changes ──────────────────────────────────────────────────────────────────

/** Why PVS cannot be changed in this pool at all, or null. */
export function pvsBlocked(r: PvsRecords): string | null {
  if (!licensed(r)) return PVS_TEXTS.unlicensed;
  if (!capable(r)) return PVS_TEXTS.incapable;
  return null;
}

export interface PvsEnablePlan {
  create: { vm: string; vif: string; name: string }[];
  skipped: string[];
}

/** EnablePvsReadCachingDialog: which VMs get a proxy, and which are left out and why. */
export function planEnable(r: PvsRecords, vmRefs: string[], siteRef: string): PvsEnablePlan | { problem: string } {
  const blocked = pvsBlocked(r);
  if (blocked) return { problem: blocked };
  if (!r.sites[siteRef]) return { problem: "That PVS site is gone" };
  const plan: PvsEnablePlan = { create: [], skipped: [] };
  for (const ref of vmRefs) {
    const vm = r.vms[ref];
    if (!vm || !realVm(vm)) return { problem: "A VM is gone" };
    const name = str(vm.name_label);
    if (proxyOf(r, ref)) {
      plan.skipped.push(`${name} (PVS-Accelerator is already enabled)`);
      continue;
    }
    const vif = list(vm.VIFs).find((v) => str(r.vifs[v]?.device) === "0");
    if (!vif) {
      plan.skipped.push(`${name} (no network interface 0)`);
      continue;
    }
    plan.create.push({ vm: ref, vif, name });
  }
  return plan;
}

export async function applyEnable(call: XapiCall, plan: PvsEnablePlan, siteRef: string): Promise<string[]> {
  const failed: string[] = [];
  await Promise.all(
    plan.create.map((c) =>
      asyncCall(call, "PVS_proxy.create", [siteRef, c.vif]).catch((err: Error) => failed.push(`${c.name} (${err.message})`)),
    ),
  );
  return failed;
}

/** DisablePvsReadCachingCommand: the proxies of the VMs that have one. */
export function planDisable(r: PvsRecords, vmRefs: string[]): { destroy: { proxy: string; name: string }[] } | { problem: string } {
  const out: { proxy: string; name: string }[] = [];
  for (const ref of vmRefs) {
    const vm = r.vms[ref];
    if (!vm) return { problem: "A VM is gone" };
    const proxy = proxyOf(r, ref);
    if (proxy) out.push({ proxy: proxy[0], name: str(vm.name_label) });
  }
  return { destroy: out };
}

export async function applyDisable(call: XapiCall, destroy: { proxy: string; name: string }[]): Promise<string[]> {
  const failed: string[] = [];
  await Promise.all(
    destroy.map((d) => asyncCall(call, "PVS_proxy.destroy", [d.proxy]).catch((err: Error) => failed.push(`${d.name} (${err.message})`))),
  );
  return failed;
}

export interface PvsSiteInput {
  /** Absent: a new site. */
  site?: string;
  name: string;
  hosts: Record<string, { storage: string; sizeGb: number }>;
}

export interface PvsSitePlan {
  site: string | null;
  name: string;
  rename: boolean;
  changes: { host: string; hostName: string; storage: string; sizeGb: number; old: string | null; memorySr: string | null }[];
}

/** PvsCacheConfigurationPage: what changes, or why it may not. */
export function planSite(r: PvsRecords, input: PvsSiteInput): PvsSitePlan | { problem: string } {
  const blocked = pvsBlocked(r);
  if (blocked) return { problem: blocked };
  const name = input.name.trim();
  if (!name) return { problem: "Enter a name for the site" };
  const siteRef = input.site ?? null;
  if (siteRef && !r.sites[siteRef]) return { problem: "That PVS site is gone" };
  const rows = hostRows(r, siteRef);
  const changes: PvsSitePlan["changes"] = [];
  for (const [hostRef, want] of Object.entries(input.hosts)) {
    const row = rows.find((x) => x.host === hostRef);
    if (!row) return { problem: "A server is gone" };
    const size = Math.round(Number(want.sizeGb));
    const storage = want.storage;
    const changed = storage !== row.storage || (storage !== "none" && size !== row.sizeGb);
    if (!changed) continue;
    if (row.inUse) return { problem: `${row.hostName}: ${PVS_TEXTS.inUseNote}` };
    if (storage !== "none") {
      const option = row.options.find((o) => o.value === storage);
      if (!option || option.disabled) return { problem: `${row.hostName}: that storage cannot hold the cache` };
      const max = option.maxGb ?? PVS_CACHE.maxGb;
      if (!Number.isFinite(size) || size < PVS_CACHE.minGb || size > max) {
        return { problem: `${row.hostName}: the cache size must be between ${PVS_CACHE.minGb} and ${max} GB` };
      }
    }
    const site = siteRef ? r.sites[siteRef] : undefined;
    const old = site ? list(site.cache_storage).find((s) => str(r.storages[s]?.host) === hostRef) ?? null : null;
    changes.push({ host: hostRef, hostName: row.hostName, storage, sizeGb: size, old, memorySr: storage === "memory" ? memorySr(r, hostRef) : null });
  }
  const rename = !!siteRef && name !== str(r.sites[siteRef].name_label);
  return { site: siteRef, name, rename, changes };
}

/** ConfigurePvsSiteAction, with "not configured" only destroying. Returns the site's ref. */
export async function applySite(call: XapiCall, plan: PvsSitePlan): Promise<string> {
  let site = plan.site;
  if (!site) site = await asyncCall(call, "PVS_site.introduce", [plan.name, "", ""]);
  else if (plan.rename) await call("PVS_site.set_name_label", [site, plan.name]);
  for (const c of plan.changes) {
    let sr = c.storage;
    if (c.storage === "memory") {
      sr = c.memorySr ?? (await asyncCall(call, "SR.create", [c.host, { uri: "" }, 0, "MemorySR", "", "tmpfs", "", false, {}]));
    }
    if (c.old) await asyncCall(call, "PVS_cache_storage.destroy", [c.old]);
    if (c.storage === "none") continue;
    await asyncCall(call, "PVS_cache_storage.create", [
      { uuid: "", host: c.host, SR: sr, site, size: c.sizeGb * GIB, VDI: "OpaqueRef:NULL" },
    ]);
  }
  return site;
}

/** DeletePvsSiteAction: not while VMs are streamed from it; servers first, then the site. */
export function planRemoveSite(r: PvsRecords, siteRef: string): { servers: string[]; name: string } | { problem: string } {
  const site = r.sites[siteRef];
  if (!site) return { problem: "That PVS site is gone" };
  if (Object.values(r.proxies).some((p) => str(p.site) === siteRef)) return { problem: PVS_TEXTS.siteStreaming };
  return { servers: Object.keys(r.servers).filter((s) => str(r.servers[s].site) === siteRef), name: str(site.name_label) };
}

export async function applyRemoveSite(call: XapiCall, siteRef: string, servers: string[]): Promise<void> {
  for (const s of servers) await asyncCall(call, "PVS_server.forget", [s]);
  await asyncCall(call, "PVS_site.forget", [siteRef]);
}

/** XAPI's PVS errors, as XenCenter words them (FriendlyErrorNames.resx). */
export const PVS_ERRORS: Record<string, string> = {
  PVS_PROXY_ALREADY_PRESENT: "The VIF is already associated with a PVS proxy",
  PVS_SITE_CONTAINS_RUNNING_PROXIES: "The PVS site contains running proxies.",
  PVS_SITE_CONTAINS_SERVERS: "The PVS site contains servers and cannot be forgotten.",
  PVS_CACHE_STORAGE_ALREADY_PRESENT: "The PVS site already has cache storage configured for the host.",
  PVS_CACHE_STORAGE_IS_IN_USE: "The PVS cache storage is in use by the site and cannot be removed.",
  PVS_SERVER_ADDRESS_IN_USE: "The address specified is already in use by an existing PVS_server object",
};
export const pvsError = (err: unknown) => {
  const code = err instanceof Error ? err.message : String(err);
  return PVS_ERRORS[code] ?? code;
};
