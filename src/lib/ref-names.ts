// Maps XAPI OpaqueRefs to their name_label so the audit log can say
// `VM "db-01"` instead of `VM OpaqueRef:a3f2…`.
//
// The cache is filled from the record sets that `connect` and `refresh` already
// fetch, so resolving a name costs no extra XAPI round trip. It is best-effort:
// a cold cache (fresh process, action before the first refresh) falls back to a
// shortened ref, which is still unambiguous — just less readable.
//
// Kept on globalThis so it survives HMR module reloads in dev, matching how
// route.ts holds its SSH export jobs.

const MAX_ENTRIES = 10_000;

const g = globalThis as typeof globalThis & {
  _xenRefNames?: Map<string, string>;
  _xenUuidNames?: Map<string, string>;
};
if (!g._xenRefNames) g._xenRefNames = new Map();
if (!g._xenUuidNames) g._xenUuidNames = new Map();
const refNames = g._xenRefNames;
// XAPI alerts identify their subject by uuid rather than ref, so the same
// records feed a second index — one pass, two lookups.
const uuidNames = g._xenUuidNames;

function remember(cache: Map<string, string>, key: string, name: string) {
  // Re-insert so recently seen keys move to the end of the eviction order.
  cache.delete(key);
  cache.set(key, name);

  const excess = cache.size - MAX_ENTRIES;
  if (excess > 0) {
    const stale = [...cache.keys()].slice(0, excess);
    for (const k of stale) cache.delete(k);
  }
}

/** Record ref → name and uuid → name pairs, evicting oldest entries when full. */
export function rememberRefNames(
  records: Iterable<{ ref: string; nameLabel: string; uuid?: string }>,
): void {
  for (const record of records) {
    if (!record.nameLabel) continue;
    if (record.ref) remember(refNames, record.ref, record.nameLabel);
    if (record.uuid) remember(uuidNames, record.uuid, record.nameLabel);
  }
}

export function refName(ref?: string): string | undefined {
  if (!ref) return undefined;
  return refNames.get(ref);
}

/** Resolve a name from an object uuid — the identifier XAPI alerts carry. */
export function nameByUuid(uuid?: string): string | undefined {
  if (!uuid) return undefined;
  return uuidNames.get(uuid);
}

/** Shorten `OpaqueRef:5d3c9f1a-…` to `OpaqueRef:5d3c9f1a` for log readability. */
function shortenRef(ref: string): string {
  const match = /^OpaqueRef:([0-9a-f]{8})/i.exec(ref);
  return match ? `OpaqueRef:${match[1]}…` : ref;
}

/**
 * Render a ref for the audit log: the quoted name when known, otherwise a
 * shortened ref. `kind` prefixes the result, e.g. describeRef("VM", ref).
 */
export function describeRef(kind: string, ref?: string): string | undefined {
  if (!ref || ref === "OpaqueRef:NULL") return undefined;
  const name = refName(ref);
  return name ? `${kind} "${name}"` : `${kind} ${shortenRef(ref)}`;
}
