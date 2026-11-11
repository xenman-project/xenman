"use client";

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from "react";
import { useTheme } from "@/context/theme-context";
import { MAX_ALERTS_TO_CLIENT, type AlertSeverity } from "@/lib/alert-format";
import {
  XenHost,
  XenHostPublic,
  XenVM,
  XenHostRecord,
  XenPoolRecord,
  XenSRRecord,
  XenNetworkRecord,
  XenPIFRecord,
  XenAlert,
  HostConnection,
  ParsedXenEvent,
} from "@/lib/types";

interface AppState {
  connections: Record<string, HostConnection>;
  // Comes from /api/hosts, which no longer sends the XAPI password.
  hosts: XenHostPublic[];
  selectedHostId: string | null;
  selectedVmRef: string | null;
  selectedXenHostRef: string | null;
}

type Action =
  | { type: "SET_HOSTS"; hosts: XenHostPublic[] }
  | { type: "ADD_HOST"; host: XenHost; fingerprint?: string; coordinator?: { address: string; fingerprint: string } }
  | { type: "REMOVE_HOST"; hostId: string }
  | { type: "UPDATE_HOST"; host: XenHost }
  | {
      type: "SET_CONNECTION_STATUS";
      hostId: string;
      status: HostConnection["status"];
      error?: string;
    }
  | {
      type: "SET_CONNECTION_DATA";
      hostId: string;
      sessionRef: string;
      connectedVia?: string;
      vms: XenVM[];
      hosts: XenHostRecord[];
      pools: XenPoolRecord[];
      srs: XenSRRecord[];
      networks: XenNetworkRecord[];
      pifs: XenPIFRecord[];
      alerts: XenAlert[];
      alertTotal: number;
    }
  // No alerts: a refresh runs after every action and deliberately leaves them
  // alone. The bell's poll and the event loop own them.
  | {
      type: "REFRESH_DATA";
      hostId: string;
      vms: XenVM[];
      hosts: XenHostRecord[];
      srs: XenSRRecord[];
      networks: XenNetworkRecord[];
      pifs: XenPIFRecord[];
    }
  | { type: "APPLY_EVENTS"; hostId: string; events: ParsedXenEvent[] }
  | {
      type: "SET_ALERTS";
      hostId: string;
      alerts: XenAlert[];
      alertTotal: number;
    }
  | { type: "DISMISS_ALERT"; hostId: string; alertRef: string }
  | { type: "DISCONNECT"; hostId: string }
  | { type: "SELECT_HOST"; hostId: string | null }
  | { type: "SELECT_VM"; vmRef: string | null }
  | { type: "SELECT_XEN_HOST"; xenHostRef: string | null }
;


async function fetchHostsFromServer(): Promise<XenHost[]> {
  try {
    const res = await fetch("/api/hosts");
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function persistHost(
  action: "add" | "remove" | "update",
  host?: XenHost,
  hostId?: string,
  /** add: the certificate fingerprint the admin confirmed. */
  fingerprint?: string,
  /** add, when the address is a member: the coordinator and its certificate, confirmed too. */
  coordinator?: { address: string; fingerprint: string },
) {
  fetch("/api/hosts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, host, hostId, fingerprint, coordinator }),
  }).catch(() => {});
}

/** Index a record list by its XAPI ref, the shape the connection state uses. */
function byRef<T extends { ref: string }>(records: T[] = []): Record<string, T> {
  const map: Record<string, T> = {};
  for (const record of records) map[record.ref] = record;
  return map;
}

/**
 * Keep only the newest MAX_ALERTS_TO_CLIENT entries. Mirrors the server's cap so
 * the incoming event stream cannot grow the map past it over a long session.
 */
function capAlerts(alerts: Record<string, XenAlert>): Record<string, XenAlert> {
  const refs = Object.keys(alerts);
  if (refs.length <= MAX_ALERTS_TO_CLIENT) return alerts;

  const newest = refs
    .sort((a, b) => alerts[b].timestamp.localeCompare(alerts[a].timestamp))
    .slice(0, MAX_ALERTS_TO_CLIENT);

  const capped: Record<string, XenAlert> = {};
  for (const ref of newest) capped[ref] = alerts[ref];
  return capped;
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_HOSTS": {
      const connections: Record<string, HostConnection> = {};
      action.hosts.forEach((h) => {
        connections[h.id] = state.connections[h.id] || {
          host: h,
          session: null,
          status: "disconnected",
          hostRecords: {},
          vms: {},
          pools: {},
          srs: {},
          networks: {},
          pifs: {},
          alerts: {},
          alertTotal: 0,
        };
      });
      return { ...state, hosts: action.hosts, connections };
    }
    case "ADD_HOST": {
      const hosts = [...state.hosts, action.host];
      persistHost("add", action.host, undefined, action.fingerprint, action.coordinator);
      return {
        ...state,
        hosts,
        connections: {
          ...state.connections,
          [action.host.id]: {
            host: action.host,
            session: null,
            status: "disconnected",
            hostRecords: {},
            vms: {},
            pools: {},
            srs: {},
            networks: {},
            pifs: {},
            alerts: {},
            alertTotal: 0,
          },
        },
      };
    }
    case "REMOVE_HOST": {
      const hosts = state.hosts.filter((h) => h.id !== action.hostId);
      persistHost("remove", undefined, action.hostId);
      const connections = { ...state.connections };
      delete connections[action.hostId];
      return {
        ...state,
        hosts,
        connections,
        selectedHostId:
          state.selectedHostId === action.hostId ? null : state.selectedHostId,
      };
    }
    case "UPDATE_HOST": {
      const hosts = state.hosts.map((h) =>
        h.id === action.host.id ? action.host : h,
      );
      persistHost("update", action.host);
      const conn = state.connections[action.host.id];
      return {
        ...state,
        hosts,
        connections: {
          ...state.connections,
          [action.host.id]: { ...conn, host: action.host },
        },
      };
    }
    case "SET_CONNECTION_STATUS": {
      const conn = state.connections[action.hostId];
      if (!conn) return state;
      return {
        ...state,
        connections: {
          ...state.connections,
          [action.hostId]: {
            ...conn,
            status: action.status,
            error: action.error,
          },
        },
      };
    }
    case "SET_CONNECTION_DATA": {
      const conn = state.connections[action.hostId];
      if (!conn) return state;
      const hostRecords: Record<string, XenHostRecord> = {};
      action.hosts.forEach((h) => {
        hostRecords[h.ref] = h;
      });
      const vms: Record<string, XenVM> = {};
      action.vms.forEach((v) => {
        vms[v.ref] = v;
      });
      const pools: Record<string, XenPoolRecord> = {};
      action.pools.forEach((p) => {
        pools[p.ref] = p;
      });
      const srs: Record<string, XenSRRecord> = {};
      action.srs.forEach((s) => {
        srs[s.ref] = s;
      });
      const networks: Record<string, XenNetworkRecord> = {};
      action.networks.forEach((n) => {
        networks[n.ref] = n;
      });
      const pifs: Record<string, XenPIFRecord> = {};
      action.pifs.forEach((p) => {
        pifs[p.ref] = p;
      });
      return {
        ...state,
        connections: {
          ...state.connections,
          [action.hostId]: {
            ...conn,
            session: {
              hostId: action.hostId,
              sessionRef: action.sessionRef,
              connectedAt: Date.now(),
            },
            status: "connected",
            error: undefined,
            connectedVia: action.connectedVia,
            hostRecords,
            vms,
            pools,
            srs,
            networks,
            pifs,
            alerts: byRef(action.alerts),
            alertTotal: action.alertTotal,
          },
        },
      };
    }
    case "REFRESH_DATA": {
      const conn = state.connections[action.hostId];
      if (!conn) return state;
      const hostRecords: Record<string, XenHostRecord> = {};
      action.hosts.forEach((h) => {
        hostRecords[h.ref] = h;
      });
      const vms: Record<string, XenVM> = {};
      action.vms.forEach((v) => {
        vms[v.ref] = v;
      });
      const srs: Record<string, XenSRRecord> = {};
      action.srs.forEach((s) => {
        srs[s.ref] = s;
      });
      const networks: Record<string, XenNetworkRecord> = {};
      action.networks.forEach((n) => {
        networks[n.ref] = n;
      });
      const pifs: Record<string, XenPIFRecord> = {};
      action.pifs.forEach((p) => {
        pifs[p.ref] = p;
      });
      return {
        ...state,
        connections: {
          ...state.connections,
          [action.hostId]: {
            ...conn,
            hostRecords,
            vms,
            srs,
            networks,
            pifs,
          },
        },
      };
    }
    case "APPLY_EVENTS": {
      const conn = state.connections[action.hostId];
      if (!conn) return state;
      if (action.events.length === 0) return state;

      const vms = { ...conn.vms };
      const hostRecords = { ...conn.hostRecords };
      const pools = { ...conn.pools };
      const srs = { ...conn.srs };
      const networks = { ...conn.networks };
      const pifs = { ...conn.pifs };
      const alerts = { ...conn.alerts };
      let alertTotal = conn.alertTotal;

      for (const evt of action.events) {
        switch (evt.class) {
          case "vm":
            if (evt.operation === "del") { delete vms[evt.ref]; }
            else { vms[evt.ref] = evt.data; }
            break;
          case "host":
            if (evt.operation === "del") { delete hostRecords[evt.ref]; }
            else {
              // Preserve existing memory metrics when host record updates
              const existing = hostRecords[evt.ref];
              hostRecords[evt.ref] = existing
                ? { ...evt.data, memoryTotal: existing.memoryTotal, memoryFree: existing.memoryFree }
                : evt.data;
            }
            break;
          case "pool":
            if (evt.operation === "del") { delete pools[evt.ref]; }
            else { pools[evt.ref] = evt.data; }
            break;
          case "sr":
            if (evt.operation === "del") { delete srs[evt.ref]; }
            else { srs[evt.ref] = evt.data; }
            break;
          case "network":
            if (evt.operation === "del") { delete networks[evt.ref]; }
            else { networks[evt.ref] = evt.data; }
            break;
          case "pif":
            if (evt.operation === "del") { delete pifs[evt.ref]; }
            else { pifs[evt.ref] = evt.data; }
            break;
          case "host_metrics": {
            // Find the host that references this metrics ref and update memory
            for (const [hRef, h] of Object.entries(hostRecords)) {
              if (h.metrics === evt.ref) {
                hostRecords[hRef] = { ...h, memoryTotal: evt.data.memoryTotal, memoryFree: evt.data.memoryFree };
                break;
              }
            }
            break;
          }
          case "message":
            // A `del` means someone acknowledged the alert — here, in XenCenter
            // or via `xe`. Either way it leaves the bell.
            if (evt.operation === "del") {
              if (alerts[evt.ref]) alertTotal = Math.max(0, alertTotal - 1);
              delete alerts[evt.ref];
            } else {
              if (!alerts[evt.ref]) alertTotal++;
              alerts[evt.ref] = evt.data;
            }
            break;
          // `task` events never reach the client — see event_poll in api/xen.
        }
      }

      // The server caps what it sends, but events arrive one at a time and would
      // grow this map without bound — that is exactly how a pool with 35k
      // messages ended up with all of them in the browser once before. Drop the
      // oldest back down to the cap; alertTotal still reports the truth.
      const cappedAlerts = capAlerts(alerts);

      return {
        ...state,
        connections: {
          ...state.connections,
          [action.hostId]: {
            ...conn,
            vms,
            hostRecords,
            pools,
            srs,
            networks,
            pifs,
            alerts: cappedAlerts,
            alertTotal,
          },
        },
      };
    }
    case "SET_ALERTS": {
      const conn = state.connections[action.hostId];
      if (!conn) return state;

      const alerts = byRef(action.alerts);
      // The bell polls this every 60s and most polls change nothing. Returning
      // the same state keeps every useXen() consumer — the sidebar included —
      // from re-rendering on a quiet minute. Refs are the identity: an alert is
      // immutable once created, so a matching ref set means matching contents.
      const before = Object.keys(conn.alerts);
      const after = Object.keys(alerts);
      if (
        conn.alertTotal === action.alertTotal &&
        before.length === after.length &&
        after.every((ref) => conn.alerts[ref] !== undefined)
      ) {
        return state;
      }

      return {
        ...state,
        connections: {
          ...state.connections,
          [action.hostId]: { ...conn, alerts, alertTotal: action.alertTotal },
        },
      };
    }
    case "DISMISS_ALERT": {
      const conn = state.connections[action.hostId];
      if (!conn?.alerts[action.alertRef]) return state;
      const alerts = { ...conn.alerts };
      delete alerts[action.alertRef];
      return {
        ...state,
        connections: {
          ...state.connections,
          [action.hostId]: {
            ...conn,
            alerts,
            alertTotal: Math.max(0, conn.alertTotal - 1),
          },
        },
      };
    }
    case "DISCONNECT": {
      const conn = state.connections[action.hostId];
      if (!conn) return state;
      return {
        ...state,
        connections: {
          ...state.connections,
          [action.hostId]: {
            ...conn,
            session: null,
            status: "disconnected",
            hostRecords: {},
            vms: {},
            pools: {},
            srs: {},
            networks: {},
            pifs: {},
            alerts: {},
            alertTotal: 0,
          },
        },
      };
    }
    case "SELECT_HOST":
      return {
        ...state,
        selectedHostId: action.hostId,
        selectedVmRef: null,
        selectedXenHostRef: null,
      };
    case "SELECT_VM":
      return {
        ...state,
        selectedVmRef: action.vmRef,
        selectedXenHostRef: null,
      };
    case "SELECT_XEN_HOST":
      return {
        ...state,
        selectedXenHostRef: action.xenHostRef,
        selectedVmRef: null,
      };
    default:
      return state;
  }
}

interface XenContextValue {
  state: AppState;
  /** fingerprint: of the certificate the admin confirmed (HTTPS pools). */
  addHost: (host: XenHost, fingerprint?: string, coordinator?: { address: string; fingerprint: string }) => void;
  removeHost: (hostId: string) => void;
  updateHost: (host: XenHost) => void;
  connectToHost: (hostId: string) => Promise<void>;
  /** The configured connections read again -- e.g. after the server added one -- and that one connected. */
  adoptHost: (hostId: string) => Promise<void>;
  disconnectFromHost: (hostId: string) => Promise<void>;
  refreshHost: (hostId: string) => Promise<void>;
  /** Alerts only — cheaper than refreshHost, and stable across renders. */
  fetchAlerts: (hostId: string) => Promise<void>;
  dismissAlert: (hostId: string, alertRef: string) => Promise<void>;
  /** Bulk dismiss for one pool; "all" or a single severity. Irreversible. */
  dismissAllAlerts: (
    hostId: string,
    severity: "all" | AlertSeverity,
  ) => Promise<{ dismissed: number; failed: number }>;
  selectHost: (hostId: string | null) => void;
  selectVm: (vmRef: string | null) => void;
  selectXenHost: (xenHostRef: string | null) => void;
  vmPowerAction: (
    hostId: string,
    vmRef: string,
    action: string,
  ) => Promise<void>;
  vmStartOn: (
    hostId: string,
    vmRef: string,
    targetHostRef: string,
  ) => Promise<void>;
  vmMigrate: (
    hostId: string,
    vmRef: string,
    targetHostRef: string,
  ) => Promise<string | null>;
  hostMaintenanceEnter: (
    hostId: string,
    xenHostRef: string,
  ) => Promise<string | null>;
  hostMaintenanceExit: (
    hostId: string,
    xenHostRef: string,
  ) => Promise<void>;
  poolJoin: (
    joiningHostId: string,
    masterHostId: string,
    poolName: string,
  ) => Promise<{ success: boolean; error?: string }>;
}

const XenContext = createContext<XenContextValue | null>(null);

export function XenProvider({ children }: { children: React.ReactNode }) {
  const { eventPolling } = useTheme();
  const [state, dispatch] = useReducer(reducer, {
    connections: {},
    hosts: [],
    selectedHostId: null,
    selectedVmRef: null,
    selectedXenHostRef: null,
  });

  // Live view of the connections for callbacks that must NOT change identity on
  // every state update. Anything a useEffect depends on belongs here: closing
  // over `state.connections` instead would hand the effect a fresh function
  // after each event batch, restarting it in a loop. Used by the event loop
  // below and by the alert helpers.
  const connectionsRef = useRef(state.connections);
  connectionsRef.current = state.connections;

  const initialized = useRef(false);
  const autoConnectDone = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      fetchHostsFromServer().then((hosts) => {
        dispatch({ type: "SET_HOSTS", hosts });
      });
    }
  }, []);

  const addHost = useCallback((host: XenHost, fingerprint?: string, coordinator?: { address: string; fingerprint: string }) => {
    dispatch({ type: "ADD_HOST", host, fingerprint, coordinator });
  }, []);

  const removeHost = useCallback((hostId: string) => {
    dispatch({ type: "REMOVE_HOST", hostId });
  }, []);

  const updateHost = useCallback((host: XenHost) => {
    dispatch({ type: "UPDATE_HOST", host });
  }, []);

  const connectToHost = useCallback(
    async (hostId: string) => {
      const host = state.hosts.find((h) => h.id === hostId);
      if (!host) return;
      await connectById(hostId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connectById is stable (dispatch only)
    [state.hosts],
  );

  // The configured connections read again, then the new one connected (after the
  // server added it, e.g. a server removed from its pool).
  const adoptHost = useCallback(async (hostId: string) => {
    const hosts = await fetchHostsFromServer();
    dispatch({ type: "SET_HOSTS", hosts });
    if (hosts.some((h) => h.id === hostId)) await connectById(hostId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connectById is stable (dispatch only)
  }, []);

  /** Connects a configured entry; the caller knows it exists. Whether it worked. */
  const connectById = useCallback(
    async (hostId: string): Promise<boolean> => {
      dispatch({ type: "SET_CONNECTION_STATUS", hostId, status: "connecting" });

      // Only the host id goes over the wire. The server checks the pool grant,
      // reads the credentials from disk, walks the primary/backup addresses and
      // follows any redirect to the pool master.
      try {
        const res = await fetch("/api/xen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "connect", hostId }),
        });

        const data = await res.json();
        if (!res.ok) {
          // The warning at the top shows it at once instead of within a minute.
          if (data.code === "CERT_CHANGED") window.dispatchEvent(new Event("xenman:trust-changed"));
          throw new Error(data.error || "Connection failed");
        }

        dispatch({
          type: "SET_CONNECTION_DATA",
          hostId,
          sessionRef: data.sessionRef,
          connectedVia: data.redirectedTo,
          vms: data.vms,
          hosts: data.hosts,
          pools: data.pools,
          srs: data.srs,
          networks: data.networks,
          pifs: data.pifs,
          alerts: data.alerts,
          alertTotal: data.alertTotal,
        });
        return true;
      } catch (err) {
        dispatch({
          type: "SET_CONNECTION_STATUS",
          hostId,
          status: "error",
          error: err instanceof Error ? err.message : "Connection failed",
        });
        return false;
      }
    },
    [],
  );

  /**
   * A pool's session is gone -- XenServer restarted its toolstack, as an update
   * does, or XenMan restarted -- while the pool still shows as connected. It is
   * connected again as a reload would, once at once and, while the pool is still
   * coming back, twice more. Not when it was disconnected meanwhile.
   */
  const reconnecting = useRef(new Set<string>());
  const reconnectAfterSessionLoss = useCallback(
    async (hostId: string) => {
      if (reconnecting.current.has(hostId)) return;
      reconnecting.current.add(hostId);
      try {
        for (const wait of [0, 10_000, 30_000]) {
          if (wait) await new Promise((r) => setTimeout(r, wait));
          const status = connectionsRef.current[hostId]?.status;
          if (!status || status === "disconnected") return;
          if (await connectById(hostId)) return;
        }
      } finally {
        reconnecting.current.delete(hostId);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connectById is stable (dispatch only); connectionsRef is a ref
    [],
  );

  const disconnectFromHost = useCallback(
    async (hostId: string) => {
      const conn = state.connections[hostId];
      if (!conn?.session) return;

      const apiHost = conn.connectedVia || conn.host.address;

      try {
        await fetch("/api/xen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "disconnect",
            host: apiHost,
            port: conn.host.port,
            useSsl: conn.host.useSsl,
            sessionRef: conn.session.sessionRef,
          }),
        });
      } catch {}

      dispatch({ type: "DISCONNECT", hostId });
    },
    [state.connections],
  );

  const refreshHost = useCallback(
    async (hostId: string) => {
      const conn = state.connections[hostId];
      if (!conn?.session) return;

      const apiHost = conn.connectedVia || conn.host.address;

      try {
        const res = await fetch("/api/xen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "refresh",
            host: apiHost,
            port: conn.host.port,
            useSsl: conn.host.useSsl,
            sessionRef: conn.session.sessionRef,
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        dispatch({
          type: "REFRESH_DATA",
          hostId,
          vms: data.vms,
          hosts: data.hosts,
          srs: data.srs,
          networks: data.networks,
          pifs: data.pifs,
        });
      } catch (err) {
        dispatch({
          type: "SET_CONNECTION_STATUS",
          hostId,
          status: "error",
          error: err instanceof Error ? err.message : "Refresh failed",
        });
      }
    },
    [state.connections],
  );

  /**
   * Pull the alert list without the full record refresh. Used by the alert bell
   * when the event loop is switched off, which is the default.
   *
   * Reads through connectionsRef so the identity stays stable: the bell polls
   * this from a useEffect, and each call dispatches SET_ALERTS. Depending on
   * `state.connections` would make every response restart that effect, which
   * fires the request again — a self-feeding request loop.
   */
  const fetchAlerts = useCallback(async (hostId: string) => {
    const conn = connectionsRef.current[hostId];
    if (!conn?.session) return;

    try {
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "alerts_fetch",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session.sessionRef,
        }),
      });
      if (!res.ok) {
        // Without the event loop (auto refresh off) this poll is what notices a
        // session XenServer or XenMan no longer knows.
        const failed = await res.json().catch(() => ({}));
        if (failed.error === "SESSION_INVALID" || (res.status === 401 && /^Session expired/.test(failed.error ?? ""))) {
          void reconnectAfterSessionLoss(hostId);
        }
        return;
      }
      const data = await res.json();
      dispatch({
        type: "SET_ALERTS",
        hostId,
        alerts: data.alerts,
        alertTotal: data.alertTotal,
      });
    } catch {
      // A failed alert poll is not worth surfacing — the next tick retries.
    }
  }, [reconnectAfterSessionLoss]);

  const dismissAlert = useCallback(
    async (hostId: string, alertRef: string) => {
      const conn = connectionsRef.current[hostId];
      if (!conn?.session) return;

      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "alert_dismiss",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session.sessionRef,
          alertRef,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to dismiss alert");
      }

      // XAPI also emits a `message` del event, but only for clients running the
      // event loop — drop it locally so the bell reacts either way.
      dispatch({ type: "DISMISS_ALERT", hostId, alertRef });
    },
    [],
  );

  /**
   * Dismiss a pool's alerts in one request, optionally only one severity.
   * Irreversible — the caller is expected to have confirmed. The server writes
   * everything to the event store before destroying, so the history keeps them.
   */
  const dismissAllAlerts = useCallback(
    async (hostId: string, severity: "all" | AlertSeverity) => {
      const conn = connectionsRef.current[hostId];
      if (!conn?.session) return { dismissed: 0, failed: 0 };

      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "alerts_dismiss_all",
          host: conn.connectedVia || conn.host.address,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session.sessionRef,
          severity,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to dismiss alerts");
      }

      const data = await res.json();
      dispatch({
        type: "SET_ALERTS",
        hostId,
        alerts: data.alerts,
        alertTotal: data.alertTotal,
      });
      return {
        dismissed: Number(data.dismissed || 0),
        failed: Number(data.failed || 0),
      };
    },
    [],
  );

  const selectHost = useCallback((hostId: string | null) => {
    dispatch({ type: "SELECT_HOST", hostId });
  }, []);

  const selectVm = useCallback((vmRef: string | null) => {
    dispatch({ type: "SELECT_VM", vmRef });
  }, []);

  const selectXenHost = useCallback((xenHostRef: string | null) => {
    dispatch({ type: "SELECT_XEN_HOST", xenHostRef });
  }, []);

  const vmPower = useCallback(
    async (hostId: string, vmRef: string, powerAction: string) => {
      const conn = state.connections[hostId];
      if (!conn?.session) return;

      const apiHost = conn.connectedVia || conn.host.address;

      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_power",
          host: apiHost,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session.sessionRef,
          vmRef,
          powerAction,
        }),
      });

      // Refresh after power action
      await refreshHost(hostId);
    },
    [state.connections, refreshHost],
  );

  const vmStartOnAction = useCallback(
    async (hostId: string, vmRef: string, targetHostRef: string) => {
      const conn = state.connections[hostId];
      if (!conn?.session) return;

      const apiHost = conn.connectedVia || conn.host.address;

      await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_start_on",
          host: apiHost,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session.sessionRef,
          vmRef,
          targetHostRef,
        }),
      });

      await refreshHost(hostId);
    },
    [state.connections, refreshHost],
  );

  const vmMigrateAction = useCallback(
    async (hostId: string, vmRef: string, targetHostRef: string): Promise<string | null> => {
      const conn = state.connections[hostId];
      if (!conn?.session) return null;

      const apiHost = conn.connectedVia || conn.host.address;

      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "vm_migrate",
          host: apiHost,
          port: conn.host.port,
          useSsl: conn.host.useSsl,
          sessionRef: conn.session.sessionRef,
          vmRef,
          targetHostRef,
        }),
      });

      const data = await res.json();
      return data.taskRef || null;
    },
    [state.connections],
  );

  const hostMaintenanceEnter = useCallback(
    async (hostId: string, xenHostRef: string): Promise<string | null> => {
      const conn = state.connections[hostId];
      if (!conn?.session) return null;

      const apiHost = conn.connectedVia || conn.host.address;
      const base = {
        host: apiHost,
        port: conn.host.port,
        useSsl: conn.host.useSsl,
        sessionRef: conn.session.sessionRef,
        hostRef: xenHostRef,
      };

      // A job on the server (lib/host-maintenance-job.ts); the task list follows it as "job:<id>".
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "host_maintenance_enter", ...base }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to enter maintenance mode");
      }

      const data = await res.json();
      await refreshHost(hostId);
      return data.job?.id ? `job:${data.job.id}` : null;
    },
    [state.connections, refreshHost],
  );

  const hostMaintenanceExit = useCallback(
    async (hostId: string, xenHostRef: string) => {
      const conn = state.connections[hostId];
      if (!conn?.session) return;

      const apiHost = conn.connectedVia || conn.host.address;
      const base = {
        host: apiHost,
        port: conn.host.port,
        useSsl: conn.host.useSsl,
        sessionRef: conn.session.sessionRef,
        hostRef: xenHostRef,
      };

      // Single composite action: enable → remove flag
      const res = await fetch("/api/xen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "host_maintenance_exit", ...base }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to exit maintenance mode");
      }

      await refreshHost(hostId);
    },
    [state.connections, refreshHost],
  );

  const poolJoinAction = useCallback(
    async (
      joiningHostId: string,
      masterHostId: string,
      poolName: string,
    ): Promise<{ success: boolean; error?: string }> => {
      const joiningConn = state.connections[joiningHostId];
      const masterConn = state.connections[masterHostId];
      if (!joiningConn?.session || !masterConn?.session) {
        return { success: false, error: "Both hosts must be connected" };
      }

      const joiningApiHost = joiningConn.connectedVia || joiningConn.host.address;
      const masterApiHost = masterConn.connectedVia || masterConn.host.address;

      try {
        // Rename pool on master if name changed
        const masterPools = Object.values(masterConn.pools);
        if (masterPools.length > 0 && poolName && poolName !== masterPools[0].nameLabel) {
          const renameRes = await fetch("/api/xen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "pool_set_name_label",
              host: masterApiHost,
              port: masterConn.host.port,
              useSsl: masterConn.host.useSsl,
              sessionRef: masterConn.session.sessionRef,
              poolRef: masterPools[0].ref,
              value: poolName,
            }),
          });
          if (!renameRes.ok) {
            const err = await renameRes.json();
            return { success: false, error: err.error || "Failed to rename pool" };
          }
        }

        // Join the pool
        const res = await fetch("/api/xen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "pool_join",
            host: joiningApiHost,
            port: joiningConn.host.port,
            useSsl: joiningConn.host.useSsl,
            sessionRef: joiningConn.session.sessionRef,
            // The server reads the master's credentials from disk; we only
            // identify which pool it is and which session addresses it.
            masterHostId: masterHostId,
            masterSessionRef: masterConn.session.sessionRef,
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          return { success: false, error: err.error || "pool.join failed" };
        }

        // Remove joining host (session is invalidated, config no longer needed)
        dispatch({ type: "REMOVE_HOST", hostId: joiningHostId });

        // Refresh master to show the new pool member
        await refreshHost(masterHostId);

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    },
    [state.connections, refreshHost],
  );

  // Auto-connect hosts on first load
  useEffect(() => {
    if (autoConnectDone.current || state.hosts.length === 0) return;
    autoConnectDone.current = true;
    for (const host of state.hosts) {
      if (host.autoConnect) {
        connectToHost(host.id);
      }
    }
  }, [state.hosts, connectToHost]);

  // Event-loop: use XAPI event.from for real-time updates (replaces 15s polling)
  //
  // We derive a stable key from the set of connected hostIds so the effect only
  // re-runs on connect/disconnect, NOT on every APPLY_EVENTS state change.
  // Connection data and refreshHost are accessed via refs to avoid effect
  // restarts; connectionsRef is declared at the top of the provider.
  const refreshHostRef = useRef(refreshHost);
  refreshHostRef.current = refreshHost;

  const connectedHostsKey = useMemo(() => {
    return Object.entries(state.connections)
      .filter(([, c]) => c.status === "connected" && c.session)
      .map(([id]) => id)
      .sort()
      .join(",");
  }, [state.connections]);

  /**
   * One loop for every pool, not one per pool.
   *
   * The constraint is the browser's limit of six concurrent HTTP/1.1
   * connections per origin, which server.js speaks. A long poll per pool held a
   * connection slot each, so five pools left a single slot for the rest of the
   * app and every navigation queued behind them -- measured at up to 18 seconds
   * for a 372-byte response.
   *
   * The tokens live on the server now. api/xen keeps one event.from per session
   * running independently of these rounds and this only drains it, so how often
   * the browser asks no longer decides how often the pools are called.
   */
  const eventLoopController = useRef<AbortController | null>(null);

  useEffect(() => {
    eventLoopController.current?.abort();
    eventLoopController.current = null;

    if (!eventPolling || !connectedHostsKey) return;

    const controller = new AbortController();
    eventLoopController.current = controller;

    /** Floor on the round trip, so no pool can turn the loop into a busy wait. */
    const MIN_ROUND_MS = 500;

    interface PollResult {
      index: number;
      events?: ParsedXenEvent[];
      error?: string;
    }

    // Captured once. A re-render must not swap a session out from under a poll
    // that is already in flight; if one changes, connectedHostsKey restarts the
    // effect and this map is rebuilt.
    const sessionOf = new Map<string, string>();
    for (const hostId of connectedHostsKey.split(",")) {
      const session = connectionsRef.current[hostId]?.session?.sessionRef;
      if (session) sessionOf.set(hostId, session);
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      while (!controller.signal.aborted) {
        const batch = [...sessionOf].map(([hostId, sessionRef]) => ({ hostId, sessionRef }));
        if (batch.length === 0) break;

        const startedAt = Date.now();
        try {
          const res = await fetch("/api/xen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "event_poll_multi",
              pools: batch.map(({ sessionRef }) => ({ sessionRef })),
            }),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error("event_poll_multi failed");
          const data = await res.json();
          const batchResults = (data.results ?? []) as PollResult[];

          for (const result of batchResults) {
            const entry = batch[result.index];
            if (!entry) continue;

            if (result.error === "EVENTS_LOST") {
              // Our picture of this pool is stale. The pump re-registers itself;
              // all we owe is a full refresh of the records.
              await refreshHostRef.current(entry.hostId);
              continue;
            }
            if (result.error === "SESSION_INVALID") {
              // The session is gone; polling it again cannot help. Connected
              // again, the pool changes connectedHostsKey, which restarts this
              // effect with its new session.
              sessionOf.delete(entry.hostId);
              void reconnectAfterSessionLoss(entry.hostId);
              continue;
            }
            // Anything else is transient: ask again next round.
            if (result.error) continue;

            if (result.events && result.events.length > 0) {
              dispatch({
                type: "APPLY_EVENTS",
                hostId: entry.hostId,
                events: result.events,
              });
            }
          }

          // Every pool failing at once is an outage, not a reason to keep
          // asking at full speed. Recovery still costs only one round.
          if (
            batchResults.length > 0 &&
            batchResults.every((r) => r.error) &&
            !controller.signal.aborted
          ) {
            await sleep(5000);
          }
        } catch {
          if (controller.signal.aborted) break;
          await sleep(5000);
          continue;
        }

        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_ROUND_MS && !controller.signal.aborted) {
          await sleep(MIN_ROUND_MS - elapsed);
        }
      }
    })();

    return () => controller.abort();
  }, [connectedHostsKey, eventPolling, reconnectAfterSessionLoss]);

  return (
    <XenContext.Provider
      value={{
        state,
        addHost,
        removeHost,
        updateHost,
        connectToHost,
        adoptHost,
        disconnectFromHost,
        refreshHost,
        fetchAlerts,
        dismissAlert,
        dismissAllAlerts,
        selectHost,
        selectVm,
        selectXenHost,
        vmPowerAction: vmPower,
        vmStartOn: vmStartOnAction,
        vmMigrate: vmMigrateAction,
        hostMaintenanceEnter,
        hostMaintenanceExit,
        poolJoin: poolJoinAction,
      }}
    >
      {children}
    </XenContext.Provider>
  );
}

export function useXen() {
  const ctx = useContext(XenContext);
  if (!ctx) throw new Error("useXen must be used within XenProvider");
  return ctx;
}
