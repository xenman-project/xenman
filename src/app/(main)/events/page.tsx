"use client";

import { useDates } from "@/context/date-format-context";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/auth-context";
import { useXen } from "@/context/xen-context";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FilterChecklist, type ChecklistOption } from "@/components/filter-checklist";
import type { XenAlert } from "@/lib/types";
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Download,
  History,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  alertSeverity,
  formatDuration,
  humanizeAlertName,
  kindLabel,
  severityStyle,
  statusStyle,
  type AlertSeverity,
} from "@/lib/alert-format";
import {
  applyDismissMarker,
  DATE_RANGE_LABELS,
  DATE_RANGE_ORDER,
  resolveDateRange,
  type DateRangeKey,
} from "@/lib/date-range";

const PAGE_SIZE = 100;

const SEVERITIES: AlertSeverity[] = ["critical", "warning", "info"];
const KINDS = ["alert", "task"] as const;

/** Events the viewer dismissed. A floor on `ts`, never a delete — see below. */
const DISMISS_MARKER_KEY = "xenman-events-dismissed-before";

interface HistoryEntry {
  id: string;
  ts: string;
  hostId: string;
  kind: "alert" | "task";
  severity: AlertSeverity;
  name: string;
  objectClass?: string;
  objectUuid?: string;
  target?: string;
  body?: string;
  status?: "success" | "failure" | "cancelled";
  error?: string;
  durationMs?: number;
}

interface PoolRef {
  id: string;
  name: string;
}

/** A live alert enriched with the pool it belongs to, for the table row. */
interface LiveAlert extends XenAlert {
  hostId: string;
  poolName: string;
  severity: AlertSeverity;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The events route rebuilds its pool list on every response, so storing it
 * unconditionally hands React a new array each time. Comparing by content lets
 * the common case — an unchanged list — keep the previous identity.
 */
function samePools(a: PoolRef[], b: PoolRef[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.id === b[i].id && p.name === b[i].name)
  );
}

/** Client-side CSV for the live alert list; the history exports server-side. */
function downloadAlertsCsv(alerts: LiveAlert[]) {
  const header = ["timestamp", "pool", "severity", "name", "class", "objectUuid", "body"];
  const rows = alerts.map((a) =>
    [a.timestamp, a.poolName, a.severity, a.name, a.cls, a.objUuid, a.body]
      .map(csvCell)
      .join(","),
  );
  const blob = new Blob([[header.join(","), ...rows].join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `xenman-alerts-${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function NotificationsPage() {
  const { role, loading: authLoading } = useAuth();
  // In the date format set under Settings, in the viewer's time zone.
  const { dateTime: formatTimestamp } = useDates();
  const { state, dismissAlert, dismissAllAlerts, fetchAlerts, selectHost, selectVm, selectXenHost } =
    useXen();
  const router = useRouter();

  const canDismiss = role !== "viewer";

  /* ── Pools, for the Location filter ── */

  const connectedPools = useMemo(
    () =>
      Object.entries(state.connections)
        .filter(([, c]) => c.status === "connected")
        .map(([hostId, c]) => ({
          id: hostId,
          name:
            Object.values(c.pools)[0]?.nameLabel || c.host.name || c.host.address,
        })),
    [state.connections],
  );

  const connectedHostIds = useMemo(
    () => connectedPools.map((p) => p.id),
    [connectedPools],
  );

  /* ── Live alerts, straight from the connection state ── */

  const { allAlerts, alertTotal } = useMemo(() => {
    const rows: LiveAlert[] = [];
    let total = 0;
    for (const [hostId, conn] of Object.entries(state.connections)) {
      if (conn.status !== "connected") continue;
      const poolName =
        Object.values(conn.pools)[0]?.nameLabel || conn.host.name || conn.host.address;
      total += conn.alertTotal;
      for (const alert of Object.values(conn.alerts)) {
        rows.push({ ...alert, hostId, poolName, severity: alertSeverity(alert.priority) });
      }
    }
    rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return { allAlerts: rows, alertTotal: total };
  }, [state.connections]);

  const [alertSeverities, setAlertSeverities] = useState<Set<string>>(
    () => new Set(SEVERITIES),
  );
  const [alertPools, setAlertPools] = useState<Set<string> | null>(null);
  // Pools arrive asynchronously; default to all of them once they do.
  const effectiveAlertPools = alertPools ?? new Set(connectedHostIds);

  const liveAlerts = useMemo(
    () =>
      allAlerts.filter(
        (a) => alertSeverities.has(a.severity) && effectiveAlertPools.has(a.hostId),
      ),
    // effectiveAlertPools is derived; depending on its source keeps this honest.
    [allAlerts, alertSeverities, alertPools, connectedHostIds], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [alertLimit, setAlertLimit] = useState(PAGE_SIZE);
  const shownAlerts = liveAlerts.slice(0, alertLimit);
  const [expanded, setExpanded] = useState<string | null>(null);

  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of allAlerts) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    return counts;
  }, [allAlerts]);

  const [dismissBusy, setDismissBusy] = useState<string | null>(null);
  const [alertError, setAlertError] = useState("");

  async function onDismiss(hostId: string, alertRef: string) {
    setDismissBusy(alertRef);
    setAlertError("");
    try {
      await dismissAlert(hostId, alertRef);
    } catch (err) {
      setAlertError(err instanceof Error ? err.message : "Failed to dismiss alert");
    } finally {
      setDismissBusy(null);
    }
  }

  /**
   * XenCenter's "Go To": jump to the object the alert is about. Alerts carry the
   * object uuid, and the VM and host records both carry theirs, so this resolves
   * without an extra XAPI call. Classes with no detail view of their own (SR,
   * Pool) land on the pool. Order matters: selectHost clears the VM selection.
   */
  function goToObject(alert: LiveAlert) {
    const conn = state.connections[alert.hostId];
    selectHost(alert.hostId);
    if (conn && alert.objUuid) {
      const vm = Object.values(conn.vms).find((v) => v.uuid === alert.objUuid);
      if (vm) {
        selectVm(vm.ref);
      } else {
        const xenHost = Object.values(conn.hostRecords).find(
          (h) => h.uuid === alert.objUuid,
        );
        if (xenHost) selectXenHost(xenHost.ref);
      }
    }
    router.push("/");
  }

  /* ── Bulk dismiss ── */

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState("");

  // Dismissing acts on the severities currently selected, which is how the
  // XenCenter-style checklist replaces a per-severity button.
  const bulkSeverities = SEVERITIES.filter((s) => alertSeverities.has(s));
  const bulkAll = bulkSeverities.length === SEVERITIES.length;
  const bulkPoolIds = connectedHostIds.filter((id) => effectiveAlertPools.has(id));
  const bulkCount = allAlerts.filter(
    (a) => alertSeverities.has(a.severity) && effectiveAlertPools.has(a.hostId),
  ).length;

  async function runBulkDismiss() {
    setBulkBusy(true);
    setAlertError("");
    setBulkResult("");
    try {
      // One request per pool per severity; the server fans out over
      // message.destroy with bounded concurrency.
      const results = await Promise.all(
        bulkPoolIds.flatMap((id) =>
          (bulkAll ? (["all"] as const) : bulkSeverities).map((sev) =>
            dismissAllAlerts(id, sev).catch(() => ({ dismissed: 0, failed: 1 })),
          ),
        ),
      );
      const dismissed = results.reduce((n, r) => n + r.dismissed, 0);
      const failed = results.reduce((n, r) => n + r.failed, 0);
      setBulkResult(
        `${dismissed} alert${dismissed === 1 ? "" : "s"} dismissed` +
          (failed > 0 ? `, ${failed} failed` : ""),
      );
      setAlertLimit(PAGE_SIZE);
      // The same call wrote any previously unseen message to the store.
      await load(0);
    } catch (err) {
      setAlertError(err instanceof Error ? err.message : "Failed to dismiss alerts");
    } finally {
      setBulkBusy(false);
      setBulkOpen(false);
    }
  }

  /* ── Events (history), from the persisted store ── */

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [pools, setPools] = useState<PoolRef[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [dateRange, setDateRange] = useState<DateRangeKey>("24h");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(KINDS));
  const [severities, setSeverities] = useState<Set<string>>(() => new Set(SEVERITIES));
  const [eventPools, setEventPools] = useState<Set<string> | null>(null);
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");

  // The dismissal marker. Deliberately a view floor in localStorage rather than a
  // delete: events.jsonl stays complete, so the record cannot be destroyed from
  // the UI — the same property that makes the audit log worth having.
  const [dismissMarker, setDismissMarker] = useState<string | undefined>();
  useEffect(() => {
    const stored = localStorage.getItem(DISMISS_MARKER_KEY);
    if (stored) setDismissMarker(stored);
  }, []);

  // All known pools, whether connected or not: the history outlives connections.
  const poolOptions: ChecklistOption[] = useMemo(() => {
    const byId = new Map<string, string>();
    for (const p of pools) byId.set(p.id, p.name);
    for (const p of connectedPools) byId.set(p.id, p.name);
    return [...byId].map(([value, label]) => ({ value, label }));
  }, [pools, connectedPools]);

  const effectiveEventPools = eventPools ?? new Set(poolOptions.map((p) => p.value));

  /**
   * The known pool ids as one sorted string.
   *
   * `filterParams` must not depend on `poolOptions` itself. That array is rebuilt
   * whenever a connection updates — every alert poll, every event batch — and a
   * fresh identity there gives `load` a fresh identity, which restarts the effect
   * that called it. Each response then triggers the next request: the
   * self-feeding loop xen-context.tsx warns about at fetchAlerts. A string
   * compares by value, so an unchanged set of pools is a no-op.
   */
  const allPoolIdsKey = useMemo(
    () => poolOptions.map((p) => p.value).sort().join(","),
    [poolOptions],
  );

  /** The `hostId` query value, or undefined while every pool is selected. */
  const hostIdParam = useMemo(() => {
    if (!allPoolIdsKey) return undefined;
    const allPoolIds = allPoolIdsKey.split(",");
    const selected = eventPools ?? new Set(allPoolIds);
    const chosen = allPoolIds.filter((id) => selected.has(id));
    if (chosen.length === allPoolIds.length) return undefined;
    // An empty selection must still narrow, so send a value the store cannot
    // match rather than omitting the parameter and showing everything. Host ids
    // are generated as lowercase base-36, so an underscore token cannot collide
    // — and unlike the NUL byte this replaces, it survives the URL round trip
    // and any proxy in front of the app.
    return chosen.length ? chosen.join(",") : "__none__";
  }, [allPoolIdsKey, eventPools]);

  const filterParams = useMemo(() => {
    const params = new URLSearchParams();

    const bounds = applyDismissMarker(
      resolveDateRange(dateRange, new Date(), customFrom, customTo),
      dismissMarker,
    );
    if (bounds.since) params.set("since", bounds.since);
    if (bounds.until) params.set("until", bounds.until);

    if (kinds.size < KINDS.length) params.set("kind", [...kinds].join(","));
    if (severities.size < SEVERITIES.length) {
      params.set("severity", [...severities].join(","));
    }
    if (hostIdParam) params.set("hostId", hostIdParam);
    if (search.trim()) params.set("q", search.trim());
    return params;
  }, [
    dateRange,
    customFrom,
    customTo,
    dismissMarker,
    kinds,
    severities,
    hostIdParam,
    search,
  ]);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams(filterParams);
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(offset));

        const res = await fetch(`/api/events?${params}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to load events");
        }
        const data = await res.json();
        setEntries((prev) => (offset === 0 ? data.entries : [...prev, ...data.entries]));
        const nextPools: PoolRef[] = data.pools || [];
        setPools((prev) => (samePools(prev, nextPools) ? prev : nextPools));
        setHasMore(!!data.hasMore);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load events");
      } finally {
        setLoading(false);
      }
    },
    [filterParams],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const poolName = useCallback(
    (hostId: string) =>
      poolOptions.find((p) => p.value === hostId)?.label || hostId,
    [poolOptions],
  );

  function dismissEventsView() {
    const marker = new Date().toISOString();
    localStorage.setItem(DISMISS_MARKER_KEY, marker);
    setDismissMarker(marker);
  }

  function showAllEvents() {
    localStorage.removeItem(DISMISS_MARKER_KEY);
    setDismissMarker(undefined);
  }

  const eventFiltersActive =
    dateRange !== "24h" ||
    kinds.size < KINDS.length ||
    severities.size < SEVERITIES.length ||
    !!search ||
    (poolOptions.length > 0 &&
      poolOptions.some((p) => !effectiveEventPools.has(p.value)));

  function resetEventFilters() {
    setDateRange("24h");
    setCustomFrom("");
    setCustomTo("");
    setKinds(new Set(KINDS));
    setSeverities(new Set(SEVERITIES));
    setEventPools(null);
    setSearch("");
    setSearchDraft("");
  }

  /**
   * A refresh does double duty: alerts_fetch re-reads the pools — which also
   * writes anything that happened while nobody was watching into the store —
   * and then the store itself is re-read. Deliberately not refreshHost(): that
   * no longer touches alerts, so it would leave this page stale.
   */
  async function refreshAll() {
    await Promise.all(connectedHostIds.map((id) => fetchAlerts(id).catch(() => {})));
    await load(0);
  }

  if (authLoading) return null;

  const severityOptions: ChecklistOption[] = SEVERITIES.map((s) => ({
    value: s,
    label: severityStyle[s].label,
    hint: severityCounts[s] ? String(severityCounts[s]) : undefined,
  }));

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-7xl px-3 pb-20 pt-3 sm:px-6 sm:pt-6 md:pb-6">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <Link href="/">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              Notifications
            </h1>
            <p className="text-sm text-zinc-500">
              What your pools report — alerts and finished operations, including the ones
              started from XenCenter or the command line
            </p>
          </div>
        </div>

        <Tabs defaultValue="alerts">
          <TabsList>
            <TabsTrigger value="alerts">
              <Bell className="mr-1.5 h-3.5 w-3.5" />
              Alerts
              {alertTotal > 0 && (
                <span className="ml-1.5 text-[10px] text-zinc-400">{alertTotal}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="events">
              <History className="mr-1.5 h-3.5 w-3.5" />
              Events
            </TabsTrigger>
          </TabsList>

          {/* ── Alerts: live state, acknowledgeable ── */}
          <TabsContent value="alerts" className="mt-4">
            {alertError && (
              <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
                {alertError}
                <button className="ml-2 underline" onClick={() => setAlertError("")}>
                  Dismiss
                </button>
              </div>
            )}

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Alerts</CardTitle>
                    <CardDescription>
                      {alertTotal === 0
                        ? "No open alerts"
                        : `${
                            allAlerts.length < alertTotal
                              ? `${allAlerts.length} of ${alertTotal} loaded`
                              : `${alertTotal} open`
                          }${
                            liveAlerts.length !== allAlerts.length
                              ? `, ${liveAlerts.length} shown by filter`
                              : ""
                          } across ${connectedHostIds.length} connected pool${
                            connectedHostIds.length === 1 ? "" : "s"
                          }`}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canDismiss && liveAlerts.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setBulkOpen(true)}
                        disabled={bulkBusy}
                      >
                        <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
                        {bulkAll ? "Dismiss all" : `Dismiss ${bulkCount}`}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadAlertsCsv(liveAlerts)}
                      disabled={liveAlerts.length === 0}
                    >
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      Export CSV
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refreshAll}
                      disabled={connectedHostIds.length === 0 || bulkBusy}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Refresh
                    </Button>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <FilterChecklist
                    label="Severity"
                    options={severityOptions}
                    selected={alertSeverities}
                    onChange={setAlertSeverities}
                  />
                  <FilterChecklist
                    label="Location"
                    options={connectedPools.map((p) => ({ value: p.id, label: p.name }))}
                    selected={effectiveAlertPools}
                    onChange={setAlertPools}
                  />
                </div>

                {bulkResult && (
                  <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                    {bulkResult}
                  </p>
                )}
                {allAlerts.length < alertTotal && (
                  <p className="mt-2 text-xs text-zinc-400">
                    Showing the newest {allAlerts.length} of {alertTotal} alerts the pools
                    hold. The Events tab has the full record.
                  </p>
                )}
              </CardHeader>

              <CardContent>
                {connectedHostIds.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    No pool connected — alerts appear as soon as a connection is up.
                  </p>
                ) : liveAlerts.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    {allAlerts.length === 0
                      ? "Nothing to report. Dismissed alerts stay under Events."
                      : "No alerts match these filters."}
                  </p>
                ) : (
                  <div className="rounded-md border dark:border-zinc-800">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[30px]" />
                          <TableHead className="w-[100px]">Severity</TableHead>
                          <TableHead>Alert</TableHead>
                          <TableHead className="w-[190px]">Location</TableHead>
                          <TableHead className="w-[150px]">Time</TableHead>
                          <TableHead className="w-[90px]" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shownAlerts.map((alert) => {
                          const badge = severityStyle[alert.severity];
                          const key = `${alert.hostId}-${alert.ref}`;
                          const isOpen = expanded === key;
                          return (
                            <React.Fragment key={key}>
                              <TableRow
                                className="cursor-pointer"
                                onClick={() => setExpanded(isOpen ? null : key)}
                              >
                                <TableCell className="text-zinc-400">
                                  {isOpen ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] ${badge.className}`}
                                  >
                                    {badge.label}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-xs font-medium">
                                  {humanizeAlertName(alert.name)}
                                </TableCell>
                                <TableCell className="text-xs text-zinc-500">
                                  {alert.poolName}
                                  {alert.cls ? ` · ${alert.cls}` : ""}
                                </TableCell>
                                <TableCell className="whitespace-nowrap font-mono text-xs text-zinc-500">
                                  {formatTimestamp(alert.timestamp)}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title="Go to object"
                                      className="h-6 w-6 p-0 text-zinc-400 hover:text-blue-600"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        goToObject(alert);
                                      }}
                                    >
                                      <ArrowUpRight className="h-3.5 w-3.5" />
                                    </Button>
                                    {canDismiss && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        title="Dismiss"
                                        className="h-6 w-6 p-0 text-zinc-400 hover:text-emerald-600"
                                        disabled={dismissBusy === alert.ref}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onDismiss(alert.hostId, alert.ref);
                                        }}
                                      >
                                        <Check className="h-3.5 w-3.5" />
                                      </Button>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                              {isOpen && (
                                <TableRow className="hover:bg-transparent">
                                  <TableCell />
                                  <TableCell colSpan={5} className="pb-4 pt-0">
                                    <p className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
                                      {alert.body || "No description."}
                                    </p>
                                    <p className="mt-2 font-mono text-[10px] text-zinc-400">
                                      {alert.name}
                                      {alert.objUuid ? ` · ${alert.cls} ${alert.objUuid}` : ""}
                                      {` · priority ${alert.priority}`}
                                    </p>
                                  </TableCell>
                                </TableRow>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </TableBody>
                    </Table>

                    {shownAlerts.length < liveAlerts.length && (
                      <div className="flex justify-center border-t p-4 dark:border-zinc-800">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setAlertLimit((n) => n + PAGE_SIZE)}
                        >
                          {`Show ${Math.min(PAGE_SIZE, liveAlerts.length - shownAlerts.length)} more`}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <p className="mt-4 text-xs text-zinc-400">
              XAPI has no read flag — dismissing destroys the message in the pool, for every
              user. It stays under Events.
            </p>
          </TabsContent>

          {/* ── Events: the persisted store ── */}
          <TabsContent value="events" className="mt-4">
            {error && (
              <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
                {error}
                <button className="ml-2 underline" onClick={() => setError("")}>
                  Dismiss
                </button>
              </div>
            )}

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Events</CardTitle>
                    <CardDescription>
                      {entries.length} entr{entries.length === 1 ? "y" : "ies"}
                      {hasMore ? " (more available)" : ""}
                      {eventFiltersActive ? " · filtered" : ""}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={dismissEventsView}
                      disabled={loading || entries.length === 0}
                    >
                      <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
                      Dismiss all
                    </Button>
                    <Button variant="outline" size="sm" onClick={refreshAll} disabled={loading}>
                      <RefreshCw
                        className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                      />
                      Refresh
                    </Button>
                    <a
                      href={`/api/events?${new URLSearchParams({
                        ...Object.fromEntries(filterParams),
                        format: "csv",
                      })}`}
                    >
                      <Button variant="outline" size="sm">
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        Export CSV
                      </Button>
                    </a>
                  </div>
                </div>

                {/* Filters */}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <div className="relative w-full sm:w-auto">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                    <Input
                      value={searchDraft}
                      onChange={(e) => setSearchDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setSearch(searchDraft);
                      }}
                      onBlur={() => setSearch(searchDraft)}
                      placeholder="Search event, object, detail, error…"
                      className="h-8 w-full pl-8 text-xs sm:w-56"
                    />
                  </div>

                  <Select
                    value={dateRange}
                    onValueChange={(v) => setDateRange(v as DateRangeKey)}
                  >
                    <SelectTrigger className="h-8 w-[150px] text-xs">
                      <SelectValue placeholder="Date" />
                    </SelectTrigger>
                    <SelectContent>
                      {DATE_RANGE_ORDER.map((key) => (
                        <SelectItem key={key} value={key}>
                          {DATE_RANGE_LABELS[key]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {dateRange === "custom" && (
                    <>
                      <Input
                        type="datetime-local"
                        value={customFrom}
                        onChange={(e) => setCustomFrom(e.target.value)}
                        className="h-8 w-[200px] text-xs"
                      />
                      <span className="text-xs text-zinc-400">to</span>
                      <Input
                        type="datetime-local"
                        value={customTo}
                        onChange={(e) => setCustomTo(e.target.value)}
                        className="h-8 w-[200px] text-xs"
                      />
                    </>
                  )}

                  <FilterChecklist
                    label="Type"
                    options={KINDS.map((k) => ({ value: k, label: kindLabel[k] ?? k }))}
                    selected={kinds}
                    onChange={setKinds}
                  />
                  <FilterChecklist
                    label="Severity"
                    options={SEVERITIES.map((s) => ({
                      value: s,
                      label: severityStyle[s].label,
                    }))}
                    selected={severities}
                    onChange={setSeverities}
                  />
                  <FilterChecklist
                    label="Location"
                    options={poolOptions}
                    selected={effectiveEventPools}
                    onChange={setEventPools}
                  />

                  {eventFiltersActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs text-zinc-500"
                      onClick={resetEventFilters}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      Clear
                    </Button>
                  )}
                </div>

                {dismissMarker && (
                  <p className="mt-2 text-xs text-zinc-400">
                    Hiding events before {formatTimestamp(dismissMarker)} — nothing was
                    deleted.
                    <button className="ml-1.5 underline" onClick={showAllEvents}>
                      Show all
                    </button>
                  </p>
                )}
              </CardHeader>

              <CardContent>
                {loading && entries.length === 0 ? (
                  <p className="text-sm text-zinc-500">Loading…</p>
                ) : entries.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    {eventFiltersActive || dismissMarker
                      ? "No entries match these filters."
                      : "Nothing recorded yet. Connect a pool — alerts and finished operations land here."}
                  </p>
                ) : (
                  <>
                    <div className="rounded-md border dark:border-zinc-800">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[150px]">Time</TableHead>
                            <TableHead className="w-[130px]">Location</TableHead>
                            <TableHead className="w-[90px]">Type</TableHead>
                            <TableHead className="w-[100px]">Severity</TableHead>
                            <TableHead className="w-[190px]">Event</TableHead>
                            <TableHead>Object</TableHead>
                            <TableHead className="w-[110px]">Result</TableHead>
                            <TableHead>Detail</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {entries.map((entry, i) => {
                            const badge = severityStyle[entry.severity];
                            const status = entry.status
                              ? statusStyle[entry.status]
                              : undefined;
                            return (
                              <TableRow key={`${entry.id}-${i}`}>
                                <TableCell className="whitespace-nowrap font-mono text-xs text-zinc-500">
                                  {formatTimestamp(entry.ts)}
                                </TableCell>
                                <TableCell className="text-xs">
                                  {poolName(entry.hostId)}
                                </TableCell>
                                <TableCell className="text-xs text-zinc-500">
                                  {kindLabel[entry.kind] ?? entry.kind}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] ${badge.className}`}
                                  >
                                    {badge.label}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-xs font-medium">
                                  {humanizeAlertName(entry.name)}
                                </TableCell>
                                <TableCell className="text-xs text-zinc-600 dark:text-zinc-400">
                                  {entry.target || entry.objectClass || "—"}
                                  {entry.kind === "task" &&
                                    entry.durationMs !== undefined && (
                                      <span className="ml-1.5 text-[10px] text-zinc-400">
                                        {formatDuration(entry.durationMs)}
                                      </span>
                                    )}
                                </TableCell>
                                <TableCell>
                                  {status ? (
                                    <Badge
                                      variant="outline"
                                      className={`text-[10px] ${status.className}`}
                                    >
                                      {status.label}
                                    </Badge>
                                  ) : (
                                    <span className="text-xs text-zinc-400">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs text-zinc-500">
                                  {entry.error || entry.body || "—"}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>

                    {hasMore && (
                      <div className="mt-4 flex justify-center">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={loading}
                          onClick={() => load(entries.length)}
                        >
                          {loading ? "Loading…" : `Load ${PAGE_SIZE} more`}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <p className="mt-4 text-xs text-zinc-400">
              The record lives in <code>events.jsonl</code> in the data directory and is
              rotated at 5 MB (3 archives kept). Dismissing hides events from this browser
              only — the file is never rewritten, so the record cannot be destroyed here.
            </p>
          </TabsContent>
        </Tabs>
      </div>

      {/* Bulk dismiss confirmation. message.destroy cannot be undone, so the
          exact count and what survives it are both spelled out. */}
      <AlertDialog open={bulkOpen} onOpenChange={(open) => !open && setBulkOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkAll ? "Dismiss all alerts" : "Dismiss the filtered alerts"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This destroys <strong>{bulkCount}</strong> message
              {bulkCount === 1 ? "" : "s"}
              {bulkAll ? "" : ` (${bulkSeverities.join(", ")})`} in{" "}
              {bulkPoolIds.length === 1
                ? "the selected pool"
                : `${bulkPoolIds.length} selected pools`}
              . XAPI has no read flag, so acknowledging means deleting — this cannot be
              undone, and the alerts disappear for every user.
              <br />
              <br />
              They remain under Events: each one is written to the record before it is
              destroyed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={bulkBusy}
              onClick={(e) => {
                // Keep the dialog up while the fan-out runs.
                e.preventDefault();
                runBulkDismiss();
              }}
            >
              {bulkBusy ? "Dismissing…" : `Dismiss ${bulkCount}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
