"use client";

import { useDates } from "@/context/date-format-context";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth, type UserRole } from "@/context/auth-context";
import { useRouter } from "next/navigation";
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
import {
  ArrowLeft,
  ScrollText,
  Search,
  RefreshCw,
  Download,
  ShieldCheck,
  Wrench,
  Eye,
  X,
} from "lucide-react";
import Link from "next/link";

type AuditOutcome = "success" | "failure" | "denied";

interface AuditEntry {
  ts: string;
  actor: string;
  role: UserRole | "-";
  ip: string;
  category: string;
  action: string;
  target?: string;
  outcome: AuditOutcome;
  detail?: string;
}

const PAGE_SIZE = 100;

const CATEGORIES = [
  "auth",
  "user",
  "host",
  "vm",
  "storage",
  "network",
  "pool",
  "config",
  "system",
] as const;

const categoryStyle: Record<string, string> = {
  auth: "bg-violet-500/10 text-violet-600 border-violet-500/20 dark:text-violet-400",
  user: "bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400",
  host: "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
  vm: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  storage: "bg-cyan-500/10 text-cyan-600 border-cyan-500/20 dark:text-cyan-400",
  network: "bg-teal-500/10 text-teal-600 border-teal-500/20 dark:text-teal-400",
  pool: "bg-indigo-500/10 text-indigo-600 border-indigo-500/20 dark:text-indigo-400",
  config: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400",
  system: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20 dark:text-zinc-400",
};

const outcomeStyle: Record<AuditOutcome, { label: string; className: string }> = {
  success: {
    label: "Success",
    className:
      "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  },
  failure: {
    label: "Failure",
    className:
      "bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400",
  },
  denied: {
    label: "Denied",
    className:
      "bg-orange-500/10 text-orange-600 border-orange-500/20 dark:text-orange-400",
  },
};

const roleIcon: Record<string, React.ReactNode> = {
  admin: <ShieldCheck className="h-3 w-3" />,
  operator: <Wrench className="h-3 w-3" />,
  viewer: <Eye className="h-3 w-3" />,
};

export default function AuditPage() {
  const { role, loading: authLoading } = useAuth();
  // In the date format set under Settings, in the viewer's time zone.
  const { dateTime: formatTimestamp } = useDates();
  const router = useRouter();

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actors, setActors] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Committed filters (what the last fetch used).
  const [category, setCategory] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [actor, setActor] = useState("all");
  const [search, setSearch] = useState("");
  // Uncommitted search box — applied on Enter or via the button.
  const [searchDraft, setSearchDraft] = useState("");

  // Redirect non-admins, matching the Users page.
  useEffect(() => {
    if (!authLoading && role !== "admin") {
      router.push("/");
    }
  }, [authLoading, role, router]);

  const filterParams = useMemo(() => {
    const params = new URLSearchParams();
    if (category !== "all") params.set("category", category);
    if (outcome !== "all") params.set("outcome", outcome);
    if (actor !== "all") params.set("actor", actor);
    if (search.trim()) params.set("q", search.trim());
    return params;
  }, [category, outcome, actor, search]);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams(filterParams);
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(offset));

        const res = await fetch(`/api/audit?${params}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to load audit log");
        }
        const data = await res.json();
        setEntries((prev) =>
          offset === 0 ? data.entries : [...prev, ...data.entries],
        );
        setActors(data.actors || []);
        setHasMore(!!data.hasMore);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audit log");
      } finally {
        setLoading(false);
      }
    },
    [filterParams],
  );

  // Reload from the top whenever a filter changes.
  useEffect(() => {
    if (role !== "admin") return;
    load(0);
  }, [load, role]);

  function applySearch() {
    setSearch(searchDraft);
  }

  function resetFilters() {
    setCategory("all");
    setOutcome("all");
    setActor("all");
    setSearch("");
    setSearchDraft("");
  }

  const filtersActive =
    category !== "all" || outcome !== "all" || actor !== "all" || !!search;

  if (authLoading || role !== "admin") {
    return null;
  }

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
              Audit Log
            </h1>
            <p className="text-sm text-zinc-500">
              Logins, permission changes and every write action against your hosts
            </p>
          </div>
        </div>

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
              <div className="flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-zinc-500" />
                <div>
                  <CardTitle className="text-base">Activity</CardTitle>
                  <CardDescription>
                    {entries.length} entr{entries.length === 1 ? "y" : "ies"}
                    {hasMore ? " (more available)" : ""}
                    {filtersActive ? " · filtered" : ""}
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => load(0)}
                  disabled={loading}
                >
                  <RefreshCw
                    className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                  />
                  Refresh
                </Button>
                <a
                  href={`/api/audit?${new URLSearchParams({
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
                    if (e.key === "Enter") applySearch();
                  }}
                  onBlur={applySearch}
                  placeholder="Search action, target, detail, IP…"
                  className="h-8 w-full pl-8 text-xs sm:w-64"
                />
              </div>

              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={outcome} onValueChange={setOutcome}>
                <SelectTrigger className="h-8 w-[130px] text-xs">
                  <SelectValue placeholder="Outcome" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All outcomes</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="failure">Failure</SelectItem>
                  <SelectItem value="denied">Denied</SelectItem>
                </SelectContent>
              </Select>

              <Select value={actor} onValueChange={setActor}>
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <SelectValue placeholder="User" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {actors.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {filtersActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-zinc-500"
                  onClick={resetFilters}
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Clear
                </Button>
              )}
            </div>
          </CardHeader>

          <CardContent>
            {loading && entries.length === 0 ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-zinc-500">
                {filtersActive
                  ? "No entries match these filters."
                  : "No activity recorded yet."}
              </p>
            ) : (
              <>
                <div className="rounded-md border dark:border-zinc-800">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[150px]">Time</TableHead>
                        <TableHead className="w-[130px]">User</TableHead>
                        <TableHead className="w-[110px]">Category</TableHead>
                        <TableHead className="w-[190px]">Action</TableHead>
                        <TableHead>Target</TableHead>
                        <TableHead className="w-[100px]">Outcome</TableHead>
                        <TableHead>Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {entries.map((entry, i) => {
                        const badge = outcomeStyle[entry.outcome];
                        return (
                          <TableRow key={`${entry.ts}-${i}`}>
                            <TableCell className="whitespace-nowrap font-mono text-xs text-zinc-500">
                              {formatTimestamp(entry.ts)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {entry.role !== "-" && (
                                  <span
                                    className="text-zinc-400"
                                    title={entry.role}
                                  >
                                    {roleIcon[entry.role]}
                                  </span>
                                )}
                                <span className="font-medium">{entry.actor}</span>
                              </div>
                              <span className="font-mono text-[10px] text-zinc-400">
                                {entry.ip}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${
                                  categoryStyle[entry.category] ??
                                  categoryStyle.config
                                }`}
                              >
                                {entry.category}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {entry.action}
                            </TableCell>
                            <TableCell className="text-xs text-zinc-600 dark:text-zinc-400">
                              {entry.target || "—"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${badge.className}`}
                              >
                                {badge.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs text-zinc-500">
                              {entry.detail || "—"}
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
      </div>
    </div>
  );
}
