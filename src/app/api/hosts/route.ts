import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requireRole } from "@/lib/api-auth";
import { loadHostsFromDisk, saveHostsToDisk } from "@/lib/host-storage";
import { auditRequest } from "@/lib/audit";
import { accessibleHosts, toPublicHost } from "@/lib/pool-access";
import { XenHost } from "@/lib/types";
import { forgetPool, normalizeFingerprint, probeCertificate, trustCertificate } from "@/lib/host-trust";
import { loginRefusedMessage, loginToHost, logout, xenApiCall, XenApiError } from "@/lib/xen-client";
import { NotConfirmedError, withPinned } from "@/lib/xen-tls";
import { cleanNat } from "@/lib/nat";
import { call, closePoolSession, friendlyXapiError, openPoolSession } from "@/lib/xen-updates";

const FINGERPRINT_RE = /^([0-9A-Fa-f]{2}:?){32}$/;
const ADDRESS_RE = /^[\w.:-]{1,253}$/;

/** Logs in over a connection that has to present this certificate, and out again. */
async function tryLogin(address: string, port: number, fingerprint: string, username: string, password: string) {
  await withPinned([fingerprint], async () => {
    const session = await loginToHost(address, port, true, username, password);
    await logout(address, port, true, session).catch(() => {});
  });
}

/** Identify a host in the log without ever touching its stored credentials. */
function hostLabel(host: { name: string; address: string; port: number }): string {
  return `host ${host.name || host.address} (${host.address}:${host.port})`;
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  // Only the pools this user is granted, and never the stored XAPI password —
  // the browser connects by host id and the server does the login.
  const hosts = accessibleHosts(auth).map(toPublicHost);
  return NextResponse.json(hosts);
}

export async function POST(request: NextRequest) {
  // Only admins can modify host configuration
  const auth = requireRole(request, "admin");
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const { action, host, hostId, fingerprint, coordinator } = body as {
      action: "add" | "remove" | "update" | "probe" | "verify" | "members";
      host?: XenHost;
      hostId?: string;
      /** add: the certificate fingerprint the admin compared and confirmed. */
      fingerprint?: string;
      /** add, when the address is a member: the coordinator's, confirmed too. */
      coordinator?: { address?: string; fingerprint?: string };
    };

    const hosts = loadHostsFromDisk();
    // The NAT setting is stored only as cleanNat() leaves it.
    if ((action === "add" || action === "update") && host) {
      const { nat, error } = cleanNat(host.nat);
      if (error) return NextResponse.json({ error }, { status: 400 });
      if (nat) host.nat = nat;
      else delete host.nat;
    }
    const natText = (h?: XenHost) =>
      h?.nat?.enabled ? `on (${Object.entries(h.nat.hosts).map(([a, b]) => `${a} at ${b}`).join(", ") || "no addresses"})` : "off";

    switch (action) {
      case "members": {
        // The pool's hosts as XenServer reports them, for the NAT table: which
        // address each one is to be reached at is the administrator's to say.
        const listed = (master: string, recs: Record<string, Record<string, unknown>>) =>
          Object.entries(recs)
            .map(([ref, r]) => ({ name: String(r.name_label ?? ""), address: String(r.address ?? ""), coordinator: ref === master }))
            .sort((a, b) => Number(b.coordinator) - Number(a.coordinator) || a.name.localeCompare(b.name));
        if (hostId) {
          if (!hosts.some((h) => h.id === hostId)) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
          try {
            const s = await openPoolSession(hostId);
            try {
              const [pool] = await call<string[]>(s, "pool.get_all");
              const master = await call<string>(s, "pool.get_master", pool);
              return NextResponse.json({ members: listed(master, await call<Record<string, Record<string, unknown>>>(s, "host.get_all_records")) });
            } finally {
              await closePoolSession(s);
            }
          } catch (err) {
            return NextResponse.json({ error: friendlyXapiError(err) }, { status: 502 });
          }
        }
        // A pool being added: with the login just typed, over the certificate
        // the administrator confirmed -- the password goes nowhere else.
        const address = typeof body.address === "string" ? body.address.trim() : "";
        const port = Number(body.port) || 443;
        const useSsl = body.useSsl !== false;
        const { username, password } = body as { username?: string; password?: string };
        if (!ADDRESS_RE.test(address) || port < 1 || port > 65535) return NextResponse.json({ error: "Enter the host's address and port" }, { status: 400 });
        if (useSsl && (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint))) {
          return NextResponse.json({ error: "Confirm the host's certificate first" }, { status: 400 });
        }
        if (!username || !password) return NextResponse.json({ error: "Enter the user name and password" }, { status: 400 });
        const read = async () => {
          const session = await loginToHost(address, port, useSsl, username, password);
          try {
            const [pool] = await xenApiCall<string[]>(address, port, useSsl, "pool.get_all", [session]);
            const master = await xenApiCall<string>(address, port, useSsl, "pool.get_master", [session, pool]);
            return listed(master, await xenApiCall<Record<string, Record<string, unknown>>>(address, port, useSsl, "host.get_all_records", [session]));
          } finally {
            await logout(address, port, useSsl, session).catch(() => {});
          }
        };
        try {
          return NextResponse.json({ members: useSsl ? await withPinned([fingerprint!], read) : await read() });
        } catch (err) {
          if (err instanceof XenApiError && err.message === "HOST_IS_SLAVE") {
            return NextResponse.json({ error: "Add the pool with its coordinator's address to set where its hosts are reached" }, { status: 400 });
          }
          if (err instanceof XenApiError && err.message === "SESSION_AUTHENTICATION_FAILED") {
            return NextResponse.json({ error: loginRefusedMessage(err, username) }, { status: 400 });
          }
          if (err instanceof NotConfirmedError) return NextResponse.json({ error: err.message }, { status: 409 });
          return NextResponse.json({ error: friendlyXapiError(err) }, { status: 502 });
        }
      }
      case "probe": {
        // The certificate the host presents, for the admin to compare before
        // trusting it. Only the TLS handshake: no credentials are sent.
        const address = typeof body.address === "string" ? body.address.trim() : "";
        const port = Number(body.port) || 443;
        if (!address || !/^[\w.:-]{1,253}$/.test(address) || port < 1 || port > 65535) {
          return NextResponse.json({ error: "Enter the host's address and port" }, { status: 400 });
        }
        try {
          return NextResponse.json({ certificate: await probeCertificate(address, port) });
        } catch (err) {
          return NextResponse.json({ error: err instanceof Error ? err.message : "No answer" }, { status: 502 });
        }
      }
      case "verify": {
        // After the admin confirmed the certificate: does the host take these
        // credentials, and is it the coordinator? Over a connection that must
        // present the confirmed certificate -- the password goes nowhere else.
        // A member names its coordinator, whose certificate is then shown too.
        const address = typeof body.address === "string" ? body.address.trim() : "";
        const port = Number(body.port) || 443;
        const { username, password } = body as { username?: string; password?: string };
        if (!ADDRESS_RE.test(address) || typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
          return NextResponse.json({ error: "Confirm the host's certificate first" }, { status: 400 });
        }
        if (!username || !password) return NextResponse.json({ error: "Enter the user name and password" }, { status: 400 });
        const said = (err: unknown) => {
          if (err instanceof NotConfirmedError) return NextResponse.json({ error: err.message }, { status: 409 });
          if (err instanceof XenApiError && err.message === "SESSION_AUTHENTICATION_FAILED") {
            return NextResponse.json({ error: loginRefusedMessage(err, username) }, { status: 400 });
          }
          return NextResponse.json({ error: err instanceof Error ? err.message : "No answer" }, { status: 502 });
        };
        try {
          await tryLogin(address, port, fingerprint, username, password);
          return NextResponse.json({ ok: true });
        } catch (err) {
          if (!(err instanceof XenApiError && err.message === "HOST_IS_SLAVE" && err.data?.length)) return said(err);
          const coordinatorAddress = String(err.data[0]);
          if (!ADDRESS_RE.test(coordinatorAddress)) return said(new Error("The pool named no usable coordinator"));
          // Second round: the coordinator's certificate confirmed as well.
          const cfp = coordinator?.fingerprint;
          if (typeof cfp === "string" && FINGERPRINT_RE.test(cfp)) {
            try {
              await tryLogin(coordinatorAddress, port, cfp, username, password);
              return NextResponse.json({ ok: true, coordinator: coordinatorAddress });
            } catch (e) {
              return said(e);
            }
          }
          try {
            return NextResponse.json({ member: true, coordinator: coordinatorAddress, certificate: await probeCertificate(coordinatorAddress, port) });
          } catch (e) {
            return said(e);
          }
        }
      }
      case "add": {
        if (!host) return NextResponse.json({ error: "Missing host" }, { status: 400 });
        // Over HTTPS a pool is only added with the certificate the admin confirmed:
        // without one, every connection would be refused anyway.
        if (host.useSsl && (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint))) {
          return NextResponse.json({ error: "Confirm the host's certificate first" }, { status: 400 });
        }
        const coord =
          host.useSsl && coordinator?.address && ADDRESS_RE.test(coordinator.address) && FINGERPRINT_RE.test(coordinator.fingerprint ?? "")
            ? { address: coordinator.address, fingerprint: coordinator.fingerprint! }
            : null;
        hosts.push(host);
        saveHostsToDisk(hosts);
        if (host.useSsl && fingerprint) trustCertificate(host.id, { fingerprint, address: host.address });
        if (coord) trustCertificate(host.id, coord);
        auditRequest(request, {
          category: "config",
          action: "host_added",
          target: hostLabel(host),
          outcome: "success",
          detail: `user=${host.username}, ssl=${host.useSsl}, autoConnect=${!!host.autoConnect}${host.nat?.enabled ? `, NAT ${natText(host)}` : ""}${
            host.useSsl ? `, certificate SHA-256 ${normalizeFingerprint(fingerprint ?? "")} confirmed` : ", unencrypted"
          }${coord ? `, coordinator ${coord.address} SHA-256 ${normalizeFingerprint(coord.fingerprint)} confirmed` : ""}`,
        });
        return NextResponse.json({ success: true });
      }
      case "remove": {
        if (!hostId) return NextResponse.json({ error: "Missing hostId" }, { status: 400 });
        const removed = hosts.find((h) => h.id === hostId);
        const filtered = hosts.filter((h) => h.id !== hostId);
        saveHostsToDisk(filtered);
        forgetPool(hostId);
        auditRequest(request, {
          category: "config",
          action: "host_removed",
          target: removed ? hostLabel(removed) : `host id ${hostId}`,
          outcome: "success",
        });
        return NextResponse.json({ success: true });
      }
      case "update": {
        if (!host) return NextResponse.json({ error: "Missing host" }, { status: 400 });
        const previous = hosts.find((h) => h.id === host.id);
        // GET no longer hands the password to the browser, so an edit dialog
        // submits it empty unless the admin typed a new one. Keep the stored
        // secret in that case instead of wiping it (same intent as the SMTP
        // route's mask handling).
        const merged: XenHost = {
          ...host,
          password: host.password ? host.password : (previous?.password ?? ""),
        };
        const updated = hosts.map((h) => (h.id === host.id ? merged : h));
        saveHostsToDisk(updated);
        // Compare only non-secret fields; a changed password is reported as a
        // fact, never as a value.
        const changes: string[] = [];
        if (previous) {
          if (previous.name !== host.name) changes.push(`name: ${previous.name} → ${host.name}`);
          if (previous.address !== host.address) changes.push(`address: ${previous.address} → ${host.address}`);
          if (previous.port !== host.port) changes.push(`port: ${previous.port} → ${host.port}`);
          if (previous.username !== host.username) changes.push(`user: ${previous.username} → ${host.username}`);
          if (previous.useSsl !== host.useSsl) changes.push(`ssl: ${previous.useSsl} → ${host.useSsl}`);
          if (previous.autoConnect !== host.autoConnect) changes.push(`autoConnect: ${!!previous.autoConnect} → ${!!host.autoConnect}`);
          if ((previous.backupAddress ?? "") !== (host.backupAddress ?? "")) changes.push(`backup address: ${previous.backupAddress || "none"} → ${host.backupAddress || "none"}`);
          if ((previous.sshPort ?? 22) !== (host.sshPort ?? 22)) changes.push(`SSH port: ${previous.sshPort ?? 22} → ${host.sshPort ?? 22}`);
          if (natText(previous) !== natText(host)) changes.push(`NAT: ${natText(previous)} → ${natText(host)}`);
          if (previous.password !== merged.password) changes.push("password changed");
        }
        auditRequest(request, {
          category: "config",
          action: "host_updated",
          target: hostLabel(host),
          outcome: "success",
          detail: changes.length ? changes.join(", ") : "no effective change",
        });
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
