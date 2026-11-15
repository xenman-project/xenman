// Nominating a new pool coordinator, as XenCenter's EvacuateHostDialog decides
// it: which hosts can take over, and what stops a change now.
//
// XenCenter (EnableComboBox): a change is possible when any host's license
// restricts pool secret rotation -- older servers, where the pool knows
// nothing of it -- or else when no pool secret rotation is pending and the
// pool allows designate_new_master. Its reasons, in its words, when not.

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? (v as Record<string, string>) : {};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Host.RestrictPoolSecretRotation: BoolKeyPreferTrue -- a missing key counts as restricted. */
const restrictsPsr = (h: Rec) => (obj(h.license_params).restrict_pool_secret_rotation ?? "true").toLowerCase() !== "false";

export const COORDINATOR_TEXTS = {
  psrPending: "You cannot nominate a new coordinator while a pool secret rotation is in progress.",
  haEnabling: "You cannot nominate a new coordinator while HA is being enabled on the pool.",
  haDisabling: "You cannot nominate a new coordinator while HA is being disabled on the pool.",
  clusterCreating: "You cannot nominate a new coordinator while the pool is in the process of creating a cluster.",
  /** Not XenCenter's: it shows no reason when none of the above applies. */
  notNow: "The pool does not allow a new coordinator right now.",
} as const;

/** Why no new coordinator can be nominated now, or null when one can. */
export function coordinatorChangeBlocked(pool: Rec, hosts: Rec[]): string | null {
  if (hosts.some(restrictsPsr)) return null;
  const allowed = list(pool.allowed_operations);
  if (pool.is_psr_pending !== true && allowed.includes("designate_new_master")) return null;
  const current = Object.values(obj(pool.current_operations));
  if (pool.is_psr_pending === true) return COORDINATOR_TEXTS.psrPending;
  if (current.includes("ha_enable")) return COORDINATOR_TEXTS.haEnabling;
  if (current.includes("ha_disable")) return COORDINATOR_TEXTS.haDisabling;
  if (current.includes("cluster_create")) return COORDINATOR_TEXTS.clusterCreating;
  return COORDINATOR_TEXTS.notNow;
}

export interface CoordinatorCandidate {
  ref: string;
  name: string;
}

/** What the maintenance and "Make Pool Coordinator" dialogs offer (action pool_coordinator_options). */
export interface CoordinatorOptions {
  coordinator: CoordinatorCandidate;
  isCoordinator: boolean;
  /** Why no new coordinator can be nominated now, or null. */
  blocked: string | null;
  candidates: CoordinatorCandidate[];
}

/**
 * EvacuateHostDialog.PopulateHosts: the other hosts that are enabled and live,
 * by name. (XenCenter also lists hosts WLB would power on; XenMan powers no
 * hosts on.)
 */
export function coordinatorCandidates(
  hosts: Record<string, Rec>,
  metrics: Record<string, Rec>,
  except: string,
): CoordinatorCandidate[] {
  return Object.entries(hosts)
    .filter(([ref, h]) => ref !== except && h.enabled === true && metrics[str(h.metrics)]?.live === true)
    .map(([ref, h]) => ({ ref, name: str(h.name_label) || ref }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
