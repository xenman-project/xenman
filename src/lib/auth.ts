import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { writeFileAtomic } from "./atomic-write";
import { loginSessionValid } from "./login-sessions";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const USERS_FILE = path.join(DATA_DIR, "users.json");
const JWT_SECRET_FILE = path.join(DATA_DIR, ".jwt-secret");

export const COOKIE_NAME = "xenman-auth";
const JWT_EXPIRY = "24h";
const BCRYPT_ROUNDS = 10;

export type UserRole = "admin" | "operator" | "viewer";

/** Validate password against the password policy. Returns null if valid, or an error message. */
export function validatePassword(password: string): string | null {
  if (password.length < 6) return "Password must be at least 6 characters";
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a number";
  return null;
}

export interface UserSettings {
  autoRefresh?: boolean;
}

export interface StoredUser {
  username: string;
  passwordHash: string;
  createdAt: string;
  role: UserRole;
  email?: string;
  settings?: UserSettings;
  /**
   * Host ids (one per pool) this user may access. Absent or empty means no
   * access — pool grants are deny-by-default. Ignored for admins, who always
   * see every configured pool. See lib/pool-access.ts for the rule itself.
   */
  pools?: string[];
  inviteToken?: string;
  inviteTokenExpiry?: string;
  resetToken?: string;
  resetTokenExpiry?: string;
  /** Set for the admin/admin account created on first start: changed before anything else. */
  mustChangePassword?: boolean;
}

/**
 * Who a valid session token belongs to. The role is the user's role now, not
 * the one in the token: a changed role counts at once.
 */
export interface TokenPayload {
  sub: string;
  role: UserRole;
  /** The password has to be changed before anything else is allowed. */
  pwc?: boolean;
  /** The sign-in (lib/login-sessions.ts): ended by signing out, a new password, or the account's removal. */
  sid: string;
}

/**
 * Whether this login has to change its password first: the account created on
 * first start, and -- on installations from before that flag -- whoever still
 * logs in as admin with the password admin.
 */
export function mustChangePassword(user: StoredUser, password: string): boolean {
  return Boolean(user.mustChangePassword) || (user.username === "admin" && password === "admin");
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJwtSecret(): string | null {
  try {
    return fs.readFileSync(JWT_SECRET_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read the signing secret, creating it once if it does not exist.
 *
 * The creation is exclusive (`wx`) and the loser of the race reads the winner's
 * secret rather than keeping its own. server.js runs the same routine before
 * Next.js starts, so on a first boot both run at once — and two processes that
 * each kept their own secret would leave the file disagreeing with the secret
 * actually in use. That is not only an authentication problem: deriveEncryptionKey()
 * below derives the AES key for the stored XAPI passwords from this very value,
 * so a divergence makes every host password undecryptable after the next restart.
 */
export function ensureJwtSecret(): string {
  ensureDataDir();

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = readJwtSecret();
    if (existing) {
      process.env.JWT_SECRET = existing;
      return existing;
    }

    const candidate = crypto.randomBytes(64).toString("hex");
    try {
      fs.writeFileSync(JWT_SECRET_FILE, candidate, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      process.env.JWT_SECRET = candidate;
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Someone created it between our read and our write. Loop once to pick up
      // their value. If the file exists but is empty, no secret was ever in use,
      // so removing the stub and retrying loses nothing.
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
  process.env.JWT_SECRET = secret;
  return secret;
}

function loadUsers(): StoredUser[] {
  try {
    ensureDataDir();
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf-8");
    const users = JSON.parse(raw) as StoredUser[];
    let needsSave = false;
    for (const u of users) {
      if (!u.role) {
        u.role = "admin";
        needsSave = true;
      }
    }
    if (needsSave) saveUsers(users);
    return users;
  } catch {
    return [];
  }
}

function saveUsers(users: StoredUser[]) {
  ensureDataDir();
  // Atomic on purpose. A truncated users.json is not a partial loss: loadUsers()
  // below catches the parse error and returns [], ensureAdminUser() then sees no
  // users and recreates admin/admin, and every account and pool grant is gone
  // with nothing logged anywhere.
  // Password hashes and reset tokens: readable by XenMan only.
  writeFileAtomic(USERS_FILE, JSON.stringify(users, null, 2), 0o600);
}

export function ensureAdminUser() {
  const users = loadUsers();
  if (users.length > 0) return;
  const hash = bcrypt.hashSync("admin", BCRYPT_ROUNDS);
  users.push({
    username: "admin",
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    role: "admin",
    mustChangePassword: true,
  });
  saveUsers(users);
}

export function verifyCredentials(
  usernameOrEmail: string,
  password: string,
): StoredUser | null {
  const users = loadUsers();
  const input = usernameOrEmail.toLowerCase();
  const user = users.find(
    (u) =>
      u.username.toLowerCase() === input ||
      (u.email && u.email.toLowerCase() === input),
  );
  if (!user) return null;
  if (!user.passwordHash) return null; // Invited but not yet activated
  if (!bcrypt.compareSync(password, user.passwordHash)) return null;
  return user;
}

/** A session token for a sign-in recorded with startLoginSession(). */
export function signToken(username: string, role: UserRole, sid: string, passwordChangeRequired = false): string {
  const secret = process.env.JWT_SECRET || ensureJwtSecret();
  return jwt.sign({ sub: username, role, sid, ...(passwordChangeRequired ? { pwc: true } : {}) }, secret, {
    algorithm: "HS256",
    expiresIn: JWT_EXPIRY,
  });
}

let usersCache: { stamp: string; users: StoredUser[] } | null = null;

/** users.json for checking tokens, read again only when the file changed. Not to be modified. */
function usersForCheck(): StoredUser[] {
  let stamp = "none";
  try {
    const s = fs.statSync(USERS_FILE);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch {
    // No users yet.
  }
  if (!usersCache || usersCache.stamp !== stamp) usersCache = { stamp, users: loadUsers() };
  return usersCache.users;
}

/**
 * The signed-in user behind a token, or null. Besides the signature and the
 * expiry: the sign-in must still be recorded (signing out, a new password or
 * the account's removal end it) and the account must exist; the role is the
 * account's role now.
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const secret = process.env.JWT_SECRET || ensureJwtSecret();
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    }) as { sub?: string; sid?: string; pwc?: boolean };
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    if (!loginSessionValid(payload.sid, payload.sub)) return null;
    const user = usersForCheck().find((u) => u.username.toLowerCase() === payload.sub!.toLowerCase());
    if (!user || !user.passwordHash) return null;
    const pwc = Boolean(payload.pwc || user.mustChangePassword);
    return { sub: user.username, role: user.role, sid: payload.sid, ...(pwc ? { pwc: true } : {}) };
  } catch {
    return null;
  }
}

export function changePassword(
  username: string,
  currentPassword: string,
  newPassword: string,
): { success: boolean; error?: string } {
  const users = loadUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  if (!user) return { success: false, error: "User not found" };
  if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
    return { success: false, error: "Current password is incorrect" };
  }
  if (newPassword === currentPassword) {
    return { success: false, error: "The new password must differ from the current one" };
  }
  user.passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  delete user.mustChangePassword;
  dropPasswordLinks(user);
  saveUsers(users);
  return { success: true };
}

/** A new password: reset and invitation links sent before it no longer work. */
function dropPasswordLinks(user: StoredUser) {
  delete user.resetToken;
  delete user.resetTokenExpiry;
  delete user.inviteToken;
  delete user.inviteTokenExpiry;
}

// ── User management functions ───────────────────────────────────────────

export function getUserRole(username: string): UserRole | null {
  const users = loadUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  return user?.role ?? null;
}

export function listUsers(): (Omit<StoredUser, "passwordHash" | "inviteToken" | "inviteTokenExpiry"> & { invited?: boolean })[] {
  return loadUsers().map(({ passwordHash, inviteToken, inviteTokenExpiry: _exp, ...rest }) => ({
    ...rest,
    ...((!passwordHash && inviteToken) ? { invited: true } : {}),
  }));
}

export function acceptInvite(
  token: string,
  password: string,
): { success: boolean; error?: string } {
  const users = loadUsers();
  const user = users.find((u) => u.inviteToken === token);
  if (!user) return { success: false, error: "Invalid or expired invitation link" };
  if (user.inviteTokenExpiry && new Date(user.inviteTokenExpiry) < new Date()) {
    return { success: false, error: "Invitation has expired. Please ask your administrator for a new one." };
  }
  user.passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  delete user.mustChangePassword; // a password of their own choosing
  delete user.inviteToken;
  delete user.inviteTokenExpiry;
  saveUsers(users);
  return { success: true };
}

export function getInviteUser(token: string): { username: string; email?: string } | null {
  const users = loadUsers();
  const user = users.find((u) => u.inviteToken === token);
  if (!user) return null;
  if (user.inviteTokenExpiry && new Date(user.inviteTokenExpiry) < new Date()) return null;
  return { username: user.username, email: user.email };
}

export function refreshInviteToken(username: string): { success: boolean; inviteToken?: string; error?: string } {
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return { success: false, error: "User not found" };
  if (user.passwordHash) return { success: false, error: "User already has a password" };
  const token = crypto.randomBytes(32).toString("hex");
  user.inviteToken = token;
  user.inviteTokenExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  saveUsers(users);
  return { success: true, inviteToken: token };
}

export function addUser(
  username: string,
  password: string | undefined,
  role: UserRole,
  email?: string,
): { success: boolean; inviteToken?: string; error?: string } {
  const users = loadUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return { success: false, error: "Username already exists" };
  }
  const user: StoredUser = {
    username,
    passwordHash: password ? bcrypt.hashSync(password, BCRYPT_ROUNDS) : "",
    createdAt: new Date().toISOString(),
    role,
    email: email || "",
  };
  if (!password) {
    const token = crypto.randomBytes(32).toString("hex");
    user.inviteToken = token;
    user.inviteTokenExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  }
  users.push(user);
  saveUsers(users);
  return { success: true, inviteToken: user.inviteToken };
}

export function deleteUser(
  username: string,
  requestingUser: string,
): { success: boolean; error?: string } {
  if (username.toLowerCase() === requestingUser.toLowerCase()) {
    return { success: false, error: "Cannot delete your own account" };
  }
  const users = loadUsers();
  const target = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  if (!target) return { success: false, error: "User not found" };
  if (target.role === "admin") {
    const adminCount = users.filter((u) => u.role === "admin").length;
    if (adminCount <= 1) {
      return { success: false, error: "Cannot delete the last admin" };
    }
  }
  const filtered = users.filter(
    (u) => u.username.toLowerCase() !== username.toLowerCase(),
  );
  saveUsers(filtered);
  return { success: true };
}

export function updateUserRole(
  username: string,
  role: UserRole,
  requestingUser: string,
): { success: boolean; error?: string } {
  if (username.toLowerCase() === requestingUser.toLowerCase()) {
    return { success: false, error: "Cannot change your own role" };
  }
  const users = loadUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  if (!user) return { success: false, error: "User not found" };
  if (user.role === "admin" && role !== "admin") {
    const adminCount = users.filter((u) => u.role === "admin").length;
    if (adminCount <= 1) {
      return { success: false, error: "Cannot demote the last admin" };
    }
  }
  user.role = role;
  saveUsers(users);
  return { success: true };
}

export function updateUserEmail(
  username: string,
  email: string,
): { success: boolean; error?: string } {
  const users = loadUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  if (!user) return { success: false, error: "User not found" };
  user.email = email;
  saveUsers(users);
  return { success: true };
}

export function resetUserPassword(
  username: string,
  newPassword: string,
): { success: boolean; error?: string } {
  const users = loadUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  if (!user) return { success: false, error: "User not found" };
  user.passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  dropPasswordLinks(user);
  saveUsers(users);
  return { success: true };
}

// ── Password reset ──────────────────────────────────────────────────────

export function generateResetToken(usernameOrEmail: string): { success: boolean; token?: string; email?: string; username?: string; error?: string } {
  const users = loadUsers();
  const input = usernameOrEmail.toLowerCase();
  const user = users.find(
    (u) =>
      u.username.toLowerCase() === input ||
      (u.email && u.email.toLowerCase() === input),
  );
  if (!user) return { success: false, error: "User not found" };
  if (!user.email) return { success: false, error: "No email address configured for this account" };
  if (!user.passwordHash) return { success: false, error: "Account not yet activated" };
  const token = crypto.randomBytes(32).toString("hex");
  user.resetToken = token;
  user.resetTokenExpiry = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(); // 1 hour
  saveUsers(users);
  return { success: true, token, email: user.email, username: user.username };
}

export function getResetUser(token: string): { username: string } | null {
  const users = loadUsers();
  const user = users.find((u) => u.resetToken === token);
  if (!user) return null;
  if (user.resetTokenExpiry && new Date(user.resetTokenExpiry) < new Date()) return null;
  return { username: user.username };
}

export function acceptResetToken(token: string, password: string): { success: boolean; error?: string; username?: string } {
  const users = loadUsers();
  const user = users.find((u) => u.resetToken === token);
  if (!user) return { success: false, error: "Invalid or expired reset link" };
  if (user.resetTokenExpiry && new Date(user.resetTokenExpiry) < new Date()) {
    return { success: false, error: "Reset link has expired. Please request a new one." };
  }
  user.passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  delete user.mustChangePassword; // a password of their own choosing
  dropPasswordLinks(user);
  saveUsers(users);
  return { success: true, username: user.username };
}

// The stored XenServer and mail passwords are encrypted in lib/secret-box.ts,
// with a key of their own -- not one derived from the login secret above.

// ── User settings ───────────────────────────────────────────────────────

export function getUserSettings(username: string): UserSettings {
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  return user?.settings ?? {};
}

export function updateUserSettings(
  username: string,
  patch: Partial<UserSettings>,
): { success: boolean; error?: string } {
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return { success: false, error: "User not found" };
  user.settings = { ...user.settings, ...patch };
  saveUsers(users);
  return { success: true };
}

/* ── Pool grants ────────────────────────────────────────────────────────── */

/** Host ids this user is granted. Empty for users with no grant on record. */
export function getUserPools(username: string): string[] {
  const users = loadUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  return user?.pools ?? [];
}

export function setUserPools(
  username: string,
  hostIds: string[],
): { success: boolean; error?: string } {
  const users = loadUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  if (!user) return { success: false, error: "User not found" };
  // Deduplicate and drop empties so the stored list stays canonical.
  user.pools = [...new Set(hostIds.filter((id) => typeof id === "string" && id))];
  saveUsers(users);
  return { success: true };
}
