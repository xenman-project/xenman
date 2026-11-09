const net = require("net");
const tls = require("tls");
const nodeCrypto = require("crypto");
const { URL } = require("url");

// Who is watching which console.
//
// Every VNC session in XenMan is proxied through this process, so this is the
// one place that can answer it -- and it can answer it exactly, without asking
// XAPI anything. A XenServer console is shared: several viewers see the same
// screen and every one of them can type. Knowing that a colleague is already on
// a VM before you touch its keyboard is the point.
//
// On globalThis because the reader is a Next route handler, which lives in a
// different module graph than this file. Matches how lib/xen-sessions.ts and
// lib/xen-event-pump.ts hold their state.
//
// Shape: Map<consoleUrl, Map<connectionId, { actor, since }>>
function viewerRegistry() {
  if (!globalThis._xenVncViewers) globalThis._xenVncViewers = new Map();
  return globalThis._xenVncViewers;
}

function addViewer(consoleUrl, connectionId, actor) {
  const registry = viewerRegistry();
  let viewers = registry.get(consoleUrl);
  if (!viewers) {
    viewers = new Map();
    registry.set(consoleUrl, viewers);
  }
  viewers.set(connectionId, { actor, since: Date.now() });
}

// What each console connection measures, for the console's connection info
// (api/console/stats), under an id the page chose. Shape:
// Map<statsId, { actor, read(): object }>
function statsRegistry() {
  if (!globalThis._xenVncStats) globalThis._xenVncStats = new Map();
  return globalThis._xenVncStats;
}

/** The middle of the last few samples: one slow picture says little. */
function median(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

function removeViewer(consoleUrl, connectionId) {
  const registry = viewerRegistry();
  const viewers = registry.get(consoleUrl);
  if (!viewers) return;
  viewers.delete(connectionId);
  // Drop the key as well, so a console nobody watches leaves no trace behind.
  if (viewers.size === 0) registry.delete(consoleUrl);
}

// --- Smoother pictures over long round trips ---
//
// noVNC asks for the next picture only once the last one has arrived, and
// XenServer's qemu offers nothing better ("continuous updates"). So every
// frame costs a full round trip browser -> NetScaler -> XenMan -> host and
// back: a few ms directly, tens of ms through a NetScaler -- and the console
// stutters. XenMan sits next to the host, so it repeats the browser's last
// incremental request itself every PUMP_MS. To qemu a request more only says
// "send what changed"; it still sends nothing when nothing did.
//
// The requests go in between the browser's own messages, never inside one,
// which is why ClientReader reads the browser's side of RFB along. Anything
// it does not understand switches this off for the connection, and the
// bytes pass as they always did.
const PUMP_MS = Number(process.env.XENMAN_VNC_PUMP_MS ?? 33);
/** The browser stopped asking (or is gone): so does XenMan. */
const PUMP_IDLE_MS = 2000;
/** Pictures waiting for the browser: no more requests until they are out. */
const PUMP_MAX_BUFFERED = 256 * 1024;
/** Waiting for the browser: stop reading from the host meanwhile. */
const TO_BROWSER_HIGH = 1024 * 1024;
/** A NetScaler drops a connection idle too long; a console can be quiet for hours. */
const PING_MS = Number(process.env.XENMAN_VNC_PING_MS ?? 25000);

// Client-to-server messages of a fixed length, by type.
const FIXED = { 0: 20, 3: 10, 4: 8, 5: 6, 150: 10, 250: 4 };
// "Extended mouse buttons" makes a pointer event 7 bytes instead of 6, decided
// by what the host answers -- which XenMan does not read. Not offered, so the
// length stays known; a VM console loses nothing by it.
const EXTENDED_MOUSE_BUTTONS = -316;

class ClientReader {
  constructor() {
    // version, security, auth, init, messages -- or lost: just passing bytes.
    this.phase = "version";
    this.held = Buffer.alloc(0);
    /** Bytes of a long message (clipboard text) still passing through. */
    this.through = 0;
    /** The browser's last incremental update request, and when it came. */
    this.request = null;
    this.requestAt = 0;
    /** Update requests from the browser so far. */
    this.requests = 0;
    this.version = "";
    /** Why reading along stopped, for the connection info. */
    this.lostReason = "";
  }

  get atBoundary() {
    return this.phase === "messages" && this.through === 0 && this.held.length === 0;
  }

  /** The bytes to pass to the host for this chunk from the browser. */
  feed(chunk) {
    if (this.phase === "lost") return chunk;
    let data = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    this.held = Buffer.alloc(0);
    const out = [];
    while (data.length) {
      if (this.through) {
        const n = Math.min(this.through, data.length);
        out.push(data.subarray(0, n));
        data = data.subarray(n);
        this.through -= n;
        continue;
      }
      const next = this.size(data);
      if (next === null) {
        this.held = Buffer.from(data);
        break;
      }
      if (next.len < 0) {
        this.phase = "lost";
        this.lostReason = `unknown message type ${data[0]}${data[0] === 255 ? `/${data[1]}` : ""}`;
        out.push(data);
        break;
      }
      if (next.len > data.length) {
        if (next.stream) {
          out.push(data);
          this.through = next.len - data.length;
        } else {
          this.held = Buffer.from(data);
        }
        break;
      }
      out.push(this.take(data.subarray(0, next.len)));
      data = data.subarray(next.len);
    }
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  /** {len, stream} of the next unit; null: too few bytes to tell; len -1: unknown. */
  size(d) {
    switch (this.phase) {
      case "version": return { len: 12 };
      case "security": return { len: 1 };
      case "auth": return { len: 16 };
      case "init": return { len: 1 };
    }
    const type = d[0];
    if (FIXED[type]) return { len: FIXED[type] };
    switch (type) {
      case 2: return d.length < 4 ? null : { len: 4 + 4 * d.readUInt16BE(2) };
      case 6: return d.length < 8 ? null : { len: 8 + Math.abs(d.readInt32BE(4)), stream: true };
      case 248: return d.length < 9 ? null : { len: 9 + d[8] };
      case 251: return d.length < 8 ? null : { len: 8 + 16 * d[6] };
      case 255: return d.length < 2 ? null : { len: d[1] === 0 ? 12 : -1 };
      default: return { len: -1 };
    }
  }

  take(msg) {
    switch (this.phase) {
      case "version":
        // 3.3 lets the host choose the security type; not worth following.
        this.version = msg.toString("latin1").trim();
        this.phase = /^RFB 003\.00[78]$/.test(this.version) ? "security" : "lost";
        if (this.phase === "lost") this.lostReason = this.version;
        return msg;
      case "security":
        this.phase = msg[0] === 1 ? "init" : msg[0] === 2 ? "auth" : "lost";
        if (this.phase === "lost") this.lostReason = `security type ${msg[0]}`;
        return msg;
      case "auth":
        this.phase = "init";
        return msg;
      case "init":
        this.phase = "messages";
        return msg;
    }
    if (msg[0] === 3) this.requests++;
    if (msg[0] === 3 && msg[1] === 1) {
      this.request = Buffer.from(msg);
      this.requestAt = Date.now();
    } else if (msg[0] === 2) {
      const encodings = [];
      for (let i = 4; i < msg.length; i += 4) {
        if (msg.readInt32BE(i) !== EXTENDED_MOUSE_BUTTONS) encodings.push(msg.subarray(i, i + 4));
      }
      const head = Buffer.from([2, 0, 0, 0]);
      head.writeUInt16BE(encodings.length, 2);
      return Buffer.concat([head, ...encodings]);
    }
    return msg;
  }
}

function handleVncUpgrade(ws, req, actor) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const consoleUrl = params.get("consoleUrl");
  const sessionId = params.get("sessionId");

  if (!consoleUrl || !sessionId) {
    ws.close(1008, "Missing consoleUrl or sessionId");
    return;
  }

  // Only a session XenMan opened, for the user asking: it says which pool
  // the console belongs to, and so which certificates it may present
  // (lib/xen-sessions.ts and lib/host-trust.ts, both on globalThis).
  const bound = globalThis._xenSessions && globalThis._xenSessions.get(sessionId);
  if (!bound || !actor || bound.actor.toLowerCase() !== String(actor).toLowerCase()) {
    ws.close(1008, "Unknown session");
    return;
  }
  // Only a console location XenMan handed out on this session (vm_console,
  // host_console): the client says which console, never where to connect.
  if (!bound.consoles || !bound.consoles.has(consoleUrl)) {
    ws.close(1008, "Unknown console");
    return;
  }
  let parsed;
  try {
    parsed = new URL(consoleUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    ws.close(1008, "Invalid console location");
    return;
  }
  const useSsl = bound.useSsl;
  const trust = globalThis._xenmanTrust;
  if (useSsl && !trust) {
    ws.close(1011, "Certificate check not available");
    return;
  }

  const connectionId = nodeCrypto.randomUUID();
  addViewer(consoleUrl, connectionId, actor || "-");
  const timers = [];
  const statsId = /^[A-Za-z0-9-]{8,64}$/.test(params.get("statsId") || "") ? params.get("statsId") : null;
  // One removal path for every way this can end -- close, error, or a failed
  // handshake -- so a stale name can never linger in someone else's viewer list.
  let released = false;
  const releaseViewer = () => {
    if (released) return;
    released = true;
    removeViewer(consoleUrl, connectionId);
    if (statsId) statsRegistry().delete(statsId);
    for (const t of timers) clearInterval(t);
  };
  // Keystrokes, pointer moves and update requests are a few bytes each: sent
  // at once, not held back to be combined with the next.
  req.socket.setNoDelay(true);

  const xenHost = parsed.hostname;
  const xenPort = parseInt(parsed.port || (useSsl ? "443" : "80"), 10);
  parsed.searchParams.set("session_id", sessionId);
  const requestPath = parsed.pathname + "?" + parsed.searchParams.toString();

  const httpRequest =
    `CONNECT ${requestPath} HTTP/1.1\r\n` +
    `Host: ${xenHost}:${xenPort}\r\n` +
    `\r\n`;

  let handshakeDone = false;
  let buffer = Buffer.alloc(0);

  const onData = (chunk) => {
    if (!handshakeDone) {
      buffer = Buffer.concat([buffer, chunk]);
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep !== -1) {
        // Check HTTP status before switching to passthrough
        const headerStr = buffer.slice(0, sep).toString();
        const statusLine = headerStr.split("\r\n")[0];
        const statusCode = parseInt(statusLine.split(" ")[1], 10);

        if (statusCode !== 200) {
          console.error("VNC proxy: XenServer returned", statusLine);
          ws.close(1011, `XenServer returned ${statusCode}`);
          xenSocket.destroy();
          return;
        }

        handshakeDone = true;
        const rfbData = buffer.slice(sep + 4);
        if (rfbData.length > 0) toBrowser(rfbData);
        buffer = Buffer.alloc(0);
      }
    } else {
      if (askedAt) {
        hostMs.push(Date.now() - askedAt);
        if (hostMs.length > 15) hostMs.shift();
        askedAt = 0;
      }
      toBrowser(chunk);
    }
  };

  // Measured for the connection info: how long the host takes to answer a
  // request it had nothing pending for, and the round trip to the browser.
  const hostMs = [];
  const netMs = [];
  let askedAt = 0;
  let ahead = 0;
  /** The most that waited here for the browser since the page last asked. */
  let queuedMax = 0;
  const asked = () => {
    if (!askedAt) askedAt = Date.now();
  };

  // The browser slower than the host: read nothing more from the host until
  // what waits for the browser is out, rather than piling it up here.
  let waiting = null;
  const toBrowser = (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > queuedMax) queuedMax = ws.bufferedAmount;
    if (waiting || ws.bufferedAmount < TO_BROWSER_HIGH) return;
    xenSocket.pause();
    waiting = setInterval(() => {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount > TO_BROWSER_HIGH / 4) return;
      clearInterval(waiting);
      waiting = null;
      xenSocket.resume();
    }, 20);
    timers.push(waiting);
  };

  let xenSocket;
  if (useSsl) {
    // XenServer's certificate is self-signed: not checked against a CA, but
    // against the pool's trusted fingerprints -- before the session id goes out.
    xenSocket = tls.connect(
      { host: xenHost, port: xenPort, rejectUnauthorized: false, session: undefined },
      () => {
        const verdict = trust.checkCertificate(bound.hostId, xenHost, xenSocket.getPeerCertificate());
        if (!verdict.ok) {
          console.error("VNC proxy:", verdict.error.message);
          releaseViewer();
          xenSocket.destroy();
          ws.close(1008, "Host certificate changed");
          return;
        }
        xenSocket.write(httpRequest);
      },
    );
  } else {
    xenSocket = net.connect({ host: xenHost, port: xenPort }, () =>
      xenSocket.write(httpRequest),
    );
  }

  xenSocket.setNoDelay(true);
  xenSocket.on("data", onData);
  xenSocket.on("error", (err) => {
    console.error("VNC proxy socket error:", err.message);
    releaseViewer();
    ws.close(1011, "XenServer socket error");
  });
  xenSocket.on("end", () => {
    releaseViewer();
    ws.close(1000, "XenServer closed");
  });

  const reader = new ClientReader();
  let hostBusy = false;
  const toHost = (bytes) => {
    if (!xenSocket.writable || !bytes.length) return;
    if (xenSocket.write(bytes) || hostBusy) return;
    // The host slower than the browser: the same, the other way round.
    hostBusy = true;
    ws.pause();
    xenSocket.once("drain", () => {
      hostBusy = false;
      ws.resume();
    });
  };
  ws.on("message", (data) => {
    const before = reader.requests;
    toHost(reader.feed(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    if (reader.requests !== before) asked();
  });
  if (statsId) {
    statsRegistry().set(statsId, {
      actor,
      read: () => ({
        rfb: reader.version || null,
        ahead:
          PUMP_MS <= 0 ? "switched off" : reader.phase === "lost" ? `off: ${reader.lostReason}` : reader.phase === "messages" ? "on" : "starting",
        aheadRequests: ahead,
        browserRequests: reader.requests,
        hostMs: median(hostMs),
        netMs: median(netMs),
        // A median hides the one long stall a proxy in between makes.
        netMaxMs: netMs.length ? Math.round(Math.max(...netMs)) : null,
        queuedKB: (() => {
          const kb = Math.round(queuedMax / 1024);
          queuedMax = 0;
          return kb;
        })(),
      }),
    });
  }

  if (PUMP_MS > 0) {
    timers.push(
      setInterval(() => {
        if (!handshakeDone || !reader.request || !reader.atBoundary || hostBusy) return;
        if (Date.now() - reader.requestAt > PUMP_IDLE_MS) return;
        if (ws.bufferedAmount > PUMP_MAX_BUFFERED || xenSocket.writableLength > 0) return;
        toHost(reader.request);
        ahead++;
        asked();
      }, PUMP_MS),
    );
  }

  // The round trip to the browser, from pings carrying their send time.
  const ping = () => {
    const at = Buffer.alloc(8);
    at.writeDoubleBE(Date.now());
    try {
      ws.ping(at);
    } catch {
      // closing anyway
    }
  };
  let missed = 0;
  ws.on("pong", (data) => {
    missed = 0;
    if (data.length !== 8) return;
    netMs.push(Date.now() - data.readDoubleBE(0));
    if (netMs.length > 15) netMs.shift();
  });
  if (statsId) timers.push(setInterval(ping, 2000));

  if (PING_MS > 0) {
    timers.push(
      setInterval(() => {
        // Gone without a word (a NetScaler failing over, a laptop lid shut):
        // closing it frees the viewer list and the host's connection.
        if (missed >= 2) return ws.terminate();
        missed++;
        ping();
      }, PING_MS),
    );
  }
  ws.on("close", () => {
    releaseViewer();
    xenSocket.destroy();
  });
  ws.on("error", (err) => {
    console.error("VNC proxy WS error:", err.message);
    releaseViewer();
    xenSocket.destroy();
  });
}

module.exports = { handleVncUpgrade };
