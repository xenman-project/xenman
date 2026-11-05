// Every HTTPS request XenMan makes to a XenServer host goes through here, and
// is only sent once the host has shown a certificate its pool is trusted with
// (lib/host-trust.ts).
//
// The check sits in the agent's createConnection: the TLS socket is handed to
// HTTP only after the handshake and the fingerprint comparison, so not one
// byte of a request -- a password, a session id -- reaches a host that is not
// the one expected. Node's fetch has no such hook without the undici package;
// node:https does.
//
// Which pool a request is for: the pool the request is being handled for
// (withPool, set by /api/xen per session and by the update code per pool), or
// else the pool the address belongs to. A request no pool claims is refused.

import http from "http";
import https from "https";
import tls from "tls";
import type { Duplex } from "stream";
import { AsyncLocalStorage } from "async_hooks";
import type { PeerCertificate } from "tls";
import { checkCertificate, normalizeFingerprint, poolForAddress } from "./host-trust";

const context = new AsyncLocalStorage<{ poolId?: string; pinned?: string[] }>();

/** Runs fn -- and everything it starts -- on behalf of a pool. */
export function withPool<T>(poolId: string, fn: () => T): T {
  return context.run({ poolId }, fn);
}

/**
 * Runs fn against exactly these certificates, for a pool not stored yet: the
 * one an admin has just confirmed while adding it.
 */
export function withPinned<T>(fingerprints: string[], fn: () => T): T {
  return context.run({ pinned: fingerprints.map(normalizeFingerprint) }, fn);
}

export function currentPool(): string | undefined {
  return context.getStore()?.poolId;
}

/** A host that does not present the certificate an admin just confirmed. */
export class NotConfirmedError extends Error {
  readonly code = "CERT_CHANGED";
  constructor(address: string) {
    super(`${address} no longer presents the certificate you confirmed`);
    this.name = "NotConfirmedError";
  }
}

type Check = (address: string, cert: PeerCertificate) => { ok: true } | { ok: false; error: Error };

class PinnedAgent extends https.Agent {
  constructor(
    private readonly check: Check,
    keepAlive = true,
  ) {
    // No TLS session reuse: a resumed session would skip the certificate.
    // No cap on connections, as fetch had none: an event.from holds one for
    // half a minute, and a cap would queue everything else behind them.
    super({ keepAlive, maxCachedSessions: 0, rejectUnauthorized: false });
  }

  createConnection(options: http.ClientRequestArgs, done?: (err: Error | null, socket: Duplex) => void): Duplex | undefined {
    const socket = tls.connect({ ...(options as tls.ConnectionOptions), rejectUnauthorized: false, session: undefined });
    let settled = false;
    // Handed over only now -- or, refused, destroyed with the reason.
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      if (err) socket.destroy();
      done?.(err, socket);
    };
    socket.once("secureConnect", () => {
      const verdict = this.check(String(options.host ?? ""), socket.getPeerCertificate());
      finish(verdict.ok ? null : verdict.error);
    });
    socket.once("error", (err) => finish(err));
    return undefined;
  }
}

const g = globalThis as unknown as { _xenmanPinnedAgents?: Map<string, PinnedAgent> };
const agents = (g._xenmanPinnedAgents ??= new Map());

function agentFor(poolId: string): PinnedAgent {
  let a = agents.get(poolId);
  if (!a) {
    a = new PinnedAgent((address, cert) => checkCertificate(poolId, address, cert));
    agents.set(poolId, a);
  }
  return a;
}

/** Closes the pool's kept-alive connections, e.g. after its trust changed. */
export function resetPoolConnections(poolId: string) {
  agents.get(poolId)?.destroy();
  agents.delete(poolId);
}

export interface XenResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * fetch for XenServer hosts: the parts of it XenMan uses. Errors read as
 * fetch's do ("fetch failed", the cause attached), which the update jobs rely
 * on to tell a restarting host; a refused certificate is thrown as it is.
 */
export function xenFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; poolId?: string } = {},
): Promise<XenResponse> {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  let agent: http.Agent | undefined;
  const pinned = context.getStore()?.pinned;
  if (secure && pinned && !init.poolId) {
    // Not kept alive: used for the one check while a pool is being added.
    agent = new PinnedAgent((address, cert) =>
      pinned.includes(normalizeFingerprint(cert.fingerprint256 ?? "")) ? { ok: true } : { ok: false, error: new NotConfirmedError(address) },
    false);
  } else if (secure) {
    const poolId = init.poolId ?? currentPool() ?? poolForAddress(u.hostname);
    if (!poolId) {
      return Promise.reject(new Error(`fetch failed`, { cause: new Error(`${u.hostname} is not a host of any configured pool`) }));
    }
    agent = agentFor(poolId);
  }
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      u,
      {
        method: init.method ?? "GET",
        // With its length, as fetch sends it: XAPI hangs up on a body sent in
        // chunks, which is what node:https does when the length is not given.
        headers: init.body !== undefined ? { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) } : init.headers,
        agent,
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (err) => reject(new Error("fetch failed", { cause: err })));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? "",
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    // fetch (undici) gave up after five minutes without an answer; so does this.
    req.setTimeout(300_000, () => req.destroy(new Error("Headers Timeout Error")));
    req.on("error", (err) => {
      if (err && (err as { code?: string }).code === "CERT_CHANGED") reject(err);
      else if (err?.name === "AbortError" || init.signal?.aborted) reject(init.signal?.reason ?? err);
      else reject(new Error("fetch failed", { cause: err }));
    });
    req.end(init.body);
  });
}
