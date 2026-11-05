export interface XenHost {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
  autoConnect?: boolean;
  backupAddress?: string;
  sshPort?: number;
  /**
   * The stored password could not be decrypted (it was written by another
   * installation, whose key is not here): it has to be entered again.
   */
  passwordUnreadable?: boolean;
}

/**
 * A host as the browser sees it — without the stored XAPI password. The client
 * connects by host id and the server reads the credentials from disk, so the
 * secret never leaves the server.
 */
export type XenHostPublic = Omit<XenHost, "password">;

export interface XenSession {
  hostId: string;
  sessionRef: string;
  connectedAt: number;
}

export interface XenVM {
  uuid: string;
  ref: string;
  nameLabel: string;
  nameDescription: string;
  powerState: VmPowerState;
  vcpusMax: number;
  vcpusAtStartup: number;
  memoryStaticMax: number;
  memoryDynamicMax: number;
  memoryDynamicMin: number;
  residentOn: string;
  affinity: string;
  isATemplate: boolean;
  isASnapshot: boolean;
  isControlDomain: boolean;
  domainType: string;
  guestMetrics: string;
  vifs: string[];
  vbds: string[];
  tags: string[];
  otherConfig: Record<string, string>;
  platform: Record<string, string>;
  hvmBootParams: Record<string, string>;
  VTPMs: string[];
  startTime?: string;
}

export type VmPowerState = "Running" | "Halted" | "Paused" | "Suspended";

export interface XenHostRecord {
  uuid: string;
  ref: string;
  nameLabel: string;
  nameDescription: string;
  address: string;
  hostname: string;
  enabled: boolean;
  softwareVersion: Record<string, string>;
  residentVMs: string[];
  metrics: string;
  memoryTotal: number;
  memoryFree: number;
  cpuInfo: { socketCount: number; cpuCount: number; vendor: string; modelname: string; speed: number };
  otherConfig: Record<string, string>;
  /** host.PBDs: the storage connections on this host (an SR is seen from it when they share one). */
  pbds: string[];
}

export interface XenPoolRecord {
  uuid: string;
  ref: string;
  nameLabel: string;
  nameDescription: string;
  master: string;
  emptyFolders: string[];
  /** Workload Balancing: the server ("host:port", empty when none), and whether it acts (not paused). */
  wlbUrl: string;
  wlbUsername: string;
  wlbEnabled: boolean;
  wlbVerifyCert: boolean;
}

export interface XenSRRecord {
  uuid: string;
  ref: string;
  nameLabel: string;
  nameDescription: string;
  type: string;
  physicalSize: number;
  physicalUtilisation: number;
  virtualAllocation: number;
  /** SR.PBDs: its connections, one per host it is plugged on. */
  pbds: string[];
  shared: boolean;
}

export interface XenNetworkRecord {
  uuid: string;
  ref: string;
  nameLabel: string;
  nameDescription: string;
  bridge: string;
  mtu: number;
  vifs: string[];
  pifs: string[];
}

export interface XenPIFRecord {
  uuid: string;
  ref: string;
  device: string;
  network: string;
  host: string;
  mac: string;
  vlan: number;
  ip: string;
  netmask: string;
  gateway: string;
  dns: string;
  currentlyAttached: boolean;
  physical: boolean;
  management: boolean;
  bondSlaveOf: string;
  bondMasterOf: string;
}

export interface XenVIFRecord {
  uuid: string;
  ref: string;
  device: string;
  network: string;
  vm: string;
  mac: string;
  currentlyAttached: boolean;
}

export interface XenVBDRecord {
  uuid: string;
  ref: string;
  vm: string;
  vdi: string;
  device: string;
  type: string;
  mode: string;
  currentlyAttached: boolean;
}

export interface XenVDIRecord {
  uuid: string;
  ref: string;
  nameLabel: string;
  sr: string;
  virtualSize: number;
  physicalUtilisation: number;
  type: string;
}

export interface XenHostMetrics {
  memoryTotal: number;
  memoryFree: number;
  live: boolean;
  lastUpdated: string;
}

/**
 * A XAPI `message` object — what XenCenter calls an alert. The pool keeps these
 * until someone destroys them, which is why they reappear after a reconnect.
 */
export interface XenAlert {
  ref: string;
  uuid: string;
  /** e.g. "ALARM", "VM_SHUTDOWN", "SR_BACKEND_FAILURE_47". */
  name: string;
  /** 1 (most urgent) … 5 (informational). */
  priority: number;
  /** Class of the object the alert is about: "VM", "Host", "SR", "Pool", … */
  cls: string;
  objUuid: string;
  /** ISO-8601 UTC. */
  timestamp: string;
  body: string;
}

/**
 * A XAPI `task` object — one operation against the pool, wherever it was
 * started from. Distinct from XenTaskInfo, which tracks the async tasks this
 * client itself kicked off and shows in the task widget.
 */
export interface XenPoolTask {
  ref: string;
  uuid: string;
  /** e.g. "VM.start", "Async.VM.pool_migrate". */
  nameLabel: string;
  nameDescription: string;
  /** ISO-8601 UTC. */
  created: string;
  /** ISO-8601 UTC; the XAPI epoch value while the task is still running. */
  finished: string;
  status: "pending" | "success" | "failure" | "cancelling" | "cancelled";
  progress: number;
  errorInfo: string[];
  residentOn: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: unknown[];
  id: number;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown[];
  };
  id: number;
}

export interface HostConnection {
  host: XenHostPublic;
  session: XenSession | null;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  connectedVia?: string;
  hostRecords: Record<string, XenHostRecord>;
  vms: Record<string, XenVM>;
  pools: Record<string, XenPoolRecord>;
  srs: Record<string, XenSRRecord>;
  networks: Record<string, XenNetworkRecord>;
  pifs: Record<string, XenPIFRecord>;
  /**
   * Undismissed XAPI alerts for this pool, keyed by message ref — the newest
   * MAX_ALERTS_TO_CLIENT of them. Pool tasks are deliberately absent: they only
   * exist as history in the event store, never in the live connection state.
   */
  alerts: Record<string, XenAlert>;
  /**
   * How many the pool actually holds. Pools in the field carry tens of thousands
   * of unacknowledged messages, so `alerts` is a window — this is the number the
   * views quote so a capped list never reads as the whole truth.
   */
  alertTotal: number;
}

// Parsed event from event.from — already converted to typed XenMan objects by the backend
export type ParsedXenEvent =
  | { class: "vm"; operation: "add" | "mod"; ref: string; data: XenVM }
  | { class: "vm"; operation: "del"; ref: string }
  | { class: "host"; operation: "add" | "mod"; ref: string; data: XenHostRecord }
  | { class: "host"; operation: "del"; ref: string }
  | { class: "pool"; operation: "add" | "mod"; ref: string; data: XenPoolRecord }
  | { class: "pool"; operation: "del"; ref: string }
  | { class: "sr"; operation: "add" | "mod"; ref: string; data: XenSRRecord }
  | { class: "sr"; operation: "del"; ref: string }
  | { class: "network"; operation: "add" | "mod"; ref: string; data: XenNetworkRecord }
  | { class: "network"; operation: "del"; ref: string }
  | { class: "pif"; operation: "add" | "mod"; ref: string; data: XenPIFRecord }
  | { class: "pif"; operation: "del"; ref: string }
  | { class: "host_metrics"; operation: "mod"; ref: string; data: { memoryTotal: number; memoryFree: number } }
  | { class: "message"; operation: "add" | "mod"; ref: string; data: XenAlert }
  | { class: "message"; operation: "del"; ref: string }
  | { class: "task"; operation: "add" | "mod"; ref: string; data: XenPoolTask }
  | { class: "task"; operation: "del"; ref: string };

export interface XenTemplate {
  ref: string;
  nameLabel: string;
  nameDescription: string;
  vcpusAtStartup: number;
  memoryStaticMax: number;
  domainType: string;
  disksXml: string;
}

export interface XenTaskInfo {
  id: string;
  taskRef: string;
  hostId: string;
  type: "vm_migrate" | "host_evacuate" | "vm_create";
  label: string;
  description: string;
  status: "pending" | "success" | "failure" | "cancelled";
  progress: number;
  error?: string;
  createdAt: number;
  meta?: Record<string, unknown>;
}

/* ── SMTP Configuration ── */

export type SmtpEncryption = "none" | "starttls" | "ssl";

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  encryption: SmtpEncryption;
  validateCertificate: boolean;
  /** XenMan's address for links in mails, e.g. https://xenman.example.org (lib/public-url.ts). */
  publicUrl?: string;
}
