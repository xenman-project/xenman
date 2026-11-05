// Custom server wrapper that hooks into the Next.js standalone server
// to add WebSocket upgrade handling for VNC console proxy and HTTPS.
//
// Strategy: Monkey-patch http.createServer so that when Next.js creates
// its HTTP server, we intercept the 'upgrade' event for /api/vnc-proxy
// and also create an HTTPS server on a separate port.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const { execSync, spawnSync } = require("child_process");
const { parse } = require("url");
const { WebSocketServer } = require("ws");
const { handleVncUpgrade } = require("./vnc-proxy");

// --- JWT secret initialization (before Next.js starts) ---
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const JWT_SECRET_FILE = path.join(DATA_DIR, ".jwt-secret");

function readJwtSecret() {
  try {
    return fs.readFileSync(JWT_SECRET_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

// Mirrors ensureJwtSecret() in src/lib/auth.ts, and must keep mirroring it.
//
// Both run on a first boot -- this one before Next.js exists, that one from
// instrumentation.ts -- so the creation is exclusive (`wx`) and the loser reads
// the winner's secret instead of keeping its own. Two processes each holding a
// different secret would not only invalidate sessions: deriveEncryptionKey() in
// auth.ts derives the AES key for the stored XAPI passwords from this value, so
// a divergence makes every host password undecryptable after the next restart.
function ensureJwtSecret() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = readJwtSecret();
    if (existing) return existing;

    const candidate = nodeCrypto.randomBytes(64).toString("hex");
    try {
      fs.writeFileSync(JWT_SECRET_FILE, candidate, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      return candidate;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Created between our read and our write. Loop once to pick it up. An
      // existing but empty file means no secret was ever in use, so removing
      // the stub and retrying loses nothing.
      if (!readJwtSecret()) {
        try {
          fs.rmSync(JWT_SECRET_FILE, { force: true });
        } catch {
          // Fall through; the next read decides.
        }
      }
    }
  }

  const secret = readJwtSecret();
  if (!secret) {
    throw new Error(`Could not establish a JWT secret at ${JWT_SECRET_FILE}`);
  }
  return secret;
}

process.env.JWT_SECRET = ensureJwtSecret();

// --- JWT verification using Node.js crypto (no external deps) ---
//
// Returns the payload rather than a boolean: the console proxy needs to know
// *who* is connecting, not only that someone valid is. Callers that only care
// whether it verified can still treat the result as truthy.
function verifyJwtSync(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const expected = nodeCrypto
      .createHmac("sha256", secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest();

    const signature = Buffer.from(
      parts[2].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );

    if (
      signature.length !== expected.length ||
      !nodeCrypto.timingSafeEqual(signature, expected)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString(),
    );
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getTokenFromCookies(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)xenman-auth=([^;]*)/);
  return match ? match[1] : null;
}

// --- Self-signed TLS certificate ---
const TLS_PFX_PASSPHRASE = "xenman";

function generateCertOpenssl(certFile, keyFile) {
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 3650 -nodes -subj "/CN=XenMan"`,
    { stdio: "pipe" },
  );
  return "pem";
}

function generateCertPowershell(pfxFile) {
  const ps = `
$cert = New-SelfSignedCertificate -Subject 'CN=XenMan' -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddYears(10) -KeyExportPolicy Exportable
$pfxBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${TLS_PFX_PASSPHRASE}')
[IO.File]::WriteAllBytes('${pfxFile.replace(/'/g, "''").replace(/\\/g, "\\\\")}', $pfxBytes)
Remove-Item "Cert:\\CurrentUser\\My\\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
`.trim();
  // spawnSync with an argument array, not execSync with a command string.
  //
  // execSync routes through cmd.exe, and this script is multi-line: cmd.exe
  // ends the command at the first newline, so PowerShell received only the
  // New-SelfSignedCertificate line. It created a certificate, wrote no file,
  // never reached the Remove-Item, and exited 0 — so the caller logged success,
  // then failed to read the file it believed it had just written. HTTPS was
  // silently off on Windows, and a certificate accumulated in the store on
  // every start.
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  // PowerShell exits 0 even when a statement inside the script throws, so its
  // exit code proves nothing. The file is the only trustworthy evidence.
  if (!fs.existsSync(pfxFile)) {
    const reason = (result.stderr || "").trim().split("\n")[0] || "no error reported";
    throw new Error(`PowerShell produced no certificate: ${reason}`);
  }
  return "pfx";
}

function ensureTlsCert() {
  const certFile = path.join(DATA_DIR, "cert.pem");
  const keyFile = path.join(DATA_DIR, "key.pem");
  const pfxFile = path.join(DATA_DIR, "cert.pfx");

  // Check for existing PEM files
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  }
  // Check for existing PFX file
  if (fs.existsSync(pfxFile)) {
    return { pfx: fs.readFileSync(pfxFile), passphrase: TLS_PFX_PASSPHRASE };
  }

  // Try openssl first (Linux/Docker), fall back to PowerShell PFX (Windows)
  if (process.platform !== "win32") {
    try {
      generateCertOpenssl(certFile, keyFile);
      console.log("> Self-signed TLS certificate generated (PEM)");
      return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    } catch {
      // openssl not available
    }
  }

  try {
    generateCertPowershell(pfxFile);
    console.log("> Self-signed TLS certificate generated (PFX)");
    return { pfx: fs.readFileSync(pfxFile), passphrase: TLS_PFX_PASSPHRASE };
  } catch {
    // PowerShell not available or failed
  }

  if (process.platform === "win32") {
    try {
      generateCertOpenssl(certFile, keyFile);
      console.log("> Self-signed TLS certificate generated (PEM)");
      return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    } catch {
      // openssl not available
    }
  }

  console.warn("> HTTPS disabled: could not generate certificate (no openssl or powershell)");
  return null;
}

// A certificate installed in the web interface (or by hand) takes effect
// without a restart: the files are polled, and once both are readable and
// belong together the server switches to them. New connections get the new
// certificate; open ones keep theirs until they close.
function watchTlsFiles(httpsServer) {
  const certFile = path.join(DATA_DIR, "cert.pem");
  const keyFile = path.join(DATA_DIR, "key.pem");
  let timer = null;
  const reload = () => {
    timer = null;
    try {
      const opts = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
      httpsServer.setSecureContext(opts);
      console.log("> TLS certificate reloaded");
    } catch (err) {
      // Mid-write, or a pair that does not match: keep serving the old one.
      console.warn(`> TLS certificate not reloaded: ${err.message}`);
    }
  };
  const changed = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    // Key and certificate are two writes; wait for the second.
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, 1000);
  };
  for (const f of [certFile, keyFile]) {
    fs.watchFile(f, { interval: 2000, persistent: false }, changed);
  }
}

// --- WebSocket upgrade handler ---
function createUpgradeHandler(wss) {
  return (req, socket, head) => {
    const { pathname } = parse(req.url);
    if (pathname === "/api/vnc-proxy") {
      const token = getTokenFromCookies(req.headers.cookie);
      const payload = token ? verifyJwtSync(token, process.env.JWT_SECRET) : null;
      // pwc: still on the default password, which has to be changed first.
      if (!payload || payload.pwc) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      // The actor comes from the verified token, never from the request: the
      // viewer list is only worth anything if the names in it are trustworthy.
      wss.handleUpgrade(req, socket, head, (ws) =>
        handleVncUpgrade(ws, req, payload.sub),
      );
    }
  };
}

function newWss() {
  return new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has("binary") ? "binary" : false,
  });
}

// --- The client's address ---
// The app reads the client IP from X-Forwarded-For (audit log, login throttle).
// Reaching XenMan directly, that header is whatever the client chose to send,
// so it is replaced with the address of the connection itself. Behind a proxy
// that sets it, XENMAN_TRUST_PROXY=1 keeps the proxy's value.
const TRUST_PROXY = process.env.XENMAN_TRUST_PROXY === "1";

function withClientAddress(handler) {
  if (TRUST_PROXY || typeof handler !== "function") return handler;
  return function (req, res) {
    const addr = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    req.headers["x-forwarded-for"] = addr;
    delete req.headers["x-real-ip"];
    return handler.call(this, req, res);
  };
}

// --- Monkey-patch http.createServer ---
const originalCreateServer = http.createServer.bind(http);

let patched = false;

http.createServer = function (...args) {
  if (typeof args[args.length - 1] === "function") args[args.length - 1] = withClientAddress(args[args.length - 1]);
  const server = originalCreateServer(...args);

  if (!patched) {
    patched = true;

    // Attach WebSocket upgrade handler to HTTP server
    const wss = newWss();
    server.on("upgrade", createUpgradeHandler(wss));
    console.log("> VNC proxy WebSocket handler attached on /api/vnc-proxy");

    // Start HTTPS server on separate port
    const httpsPort = parseInt(process.env.HTTPS_PORT || "3001", 10);
    if (httpsPort > 0) {
      const tlsOpts = ensureTlsCert();
      if (tlsOpts) {
        const requestHandler = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
        if (requestHandler) {
          const httpsServer = https.createServer(tlsOpts, requestHandler);
          const wssHttps = newWss();
          httpsServer.on("upgrade", createUpgradeHandler(wssHttps));
          watchTlsFiles(httpsServer);
          const hostname = process.env.HOSTNAME || "0.0.0.0";
          httpsServer.listen(httpsPort, hostname, () => {
            console.log(`> HTTPS server listening on https://${hostname}:${httpsPort}`);
          });
        }
      }
    }
  }

  return server;
};

// Now load and run the original Next.js standalone server
require("./standalone-server.js");
