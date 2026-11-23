// A stand-in for Microsoft Entra ID's sign-in service, for sso-test.sh: the
// OpenID configuration, the tenant's signing keys, /authorize (which signs the
// user in at once and sends the browser back with a code) and /token (which
// trades the code, checked like Entra does: client secret, PKCE verifier,
// redirect URI, for an ID token signed RS256).
//
// Steered by files in STATE_DIR:
//   user.json        { oid, username, email, name, roles } -- who signs in
//   deny             /authorize answers error=access_denied
//   token-400        /token refuses (invalid_grant)
//   bad-aud, bad-iss, bad-tid, bad-nonce, expired, other-key, unknown-kid
//                    the ID token is wrong in that one way
// Every /authorize request's parameters go to STATE_DIR/authorize.log.
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || 4600);
const DIR = process.argv[3] || "/var/tmp/fake-entra";
const TENANT = process.env.FAKE_TENANT || "11111111-2222-3333-4444-555555555555";
const SECRET = process.env.FAKE_CLIENT_SECRET || "s3cret-value";
fs.mkdirSync(DIR, { recursive: true });
const flag = (n) => fs.existsSync(path.join(DIR, n));
const BASE = `http://127.0.0.1:${PORT}`;

const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "fake-key-1";
const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };

const codes = new Map();

function user() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, "user.json"), "utf8"));
  } catch {
    return { oid: "00000000-0000-0000-0000-0000000000a1", username: "alice@contoso.example", email: "alice@contoso.example", name: "Alice", roles: ["XenMan.Operator"] };
  }
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims, kid, privateKey) {
  const head = b64({ alg: "RS256", typ: "JWT", kid });
  const body = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, BASE);
    const parts = url.pathname.split("/").filter(Boolean);
    const tenant = parts[0];
    const rest = parts.slice(1).join("/");

    if (rest === "v2.0/.well-known/openid-configuration") {
      if (tenant !== TENANT) return send(res, 400, { error: "invalid_tenant", error_description: "AADSTS90002: Tenant not found.\r\nTrace ID: x" });
      return send(res, 200, {
        issuer: `${BASE}/${TENANT}/v2.0`,
        authorization_endpoint: `${BASE}/${TENANT}/oauth2/v2.0/authorize`,
        token_endpoint: `${BASE}/${TENANT}/oauth2/v2.0/token`,
        jwks_uri: `${BASE}/${TENANT}/discovery/v2.0/keys`,
      });
    }
    if (rest === "discovery/v2.0/keys") {
      fs.appendFileSync(path.join(DIR, "keys.log"), "keys\n");
      return send(res, 200, { keys: [jwk] });
    }
    if (rest === "oauth2/v2.0/authorize") {
      const q = Object.fromEntries(url.searchParams);
      fs.appendFileSync(path.join(DIR, "authorize.log"), JSON.stringify(q) + "\n");
      const back = new URL(q.redirect_uri);
      back.searchParams.set("state", q.state || "");
      if (flag("deny")) {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "AADSTS50105: The signed in user is not assigned to a role for the application.\r\nTrace ID: y");
      } else {
        const code = crypto.randomBytes(16).toString("hex");
        codes.set(code, { ...q, tenant });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (rest === "oauth2/v2.0/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const f = Object.fromEntries(new URLSearchParams(raw));
        const c = codes.get(f.code);
        codes.delete(f.code);
        const refuse = (why) => send(res, 400, { error: "invalid_grant", error_description: `AADSTS70008: ${why}\r\nTrace ID: z` });
        if (flag("token-400")) return refuse("The provided authorization code or refresh token has expired.");
        if (!c) return refuse("unknown code");
        if (f.client_secret !== SECRET) return send(res, 401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
        if (f.client_id !== c.client_id || f.redirect_uri !== c.redirect_uri) return refuse("client or redirect_uri differ");
        const challenge = crypto.createHash("sha256").update(f.code_verifier || "").digest("base64url");
        if (c.code_challenge_method !== "S256" || challenge !== c.code_challenge) return refuse("PKCE verification failed");
        const u = user();
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          aud: flag("bad-aud") ? "99999999-9999-9999-9999-999999999999" : c.client_id,
          iss: flag("bad-iss") ? `https://sts.example.org/${TENANT}/` : `${BASE}/${TENANT}/v2.0`,
          tid: flag("bad-tid") ? "66666666-7777-8888-9999-000000000000" : TENANT,
          oid: u.oid,
          preferred_username: u.username,
          email: u.email,
          name: u.name,
          ...(u.roles && u.roles.length ? { roles: u.roles } : {}),
          nonce: flag("bad-nonce") ? "not-the-nonce" : c.nonce,
          iat: flag("expired") ? now - 7200 : now,
          nbf: flag("expired") ? now - 7200 : now,
          exp: flag("expired") ? now - 3600 : now + 3600,
        };
        const kid = flag("unknown-kid") ? "no-such-key" : KID;
        const pk = flag("other-key") ? otherKey.privateKey : key.privateKey;
        send(res, 200, { token_type: "Bearer", id_token: sign(claims, kid, pk), access_token: "x", expires_in: 3600 });
      });
      return;
    }
    send(res, 404, { error: "not_found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake-entra on ${PORT}`));
