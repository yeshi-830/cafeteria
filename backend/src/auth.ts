import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../../database/src/index.js";
import { readBody, sendJson } from "./api.js";

const SESSION_COOKIE = "cafeteria_session";
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const PASSWORD_BYTES = 64;
const SESSION_COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const localPort = Number(process.env.PORT || 3000);
const frontendPort = Number(process.env.VITE_PORT || 5173);
const defaultTrustedOrigins = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  `http://127.0.0.1:${frontendPort}`,
  `http://localhost:${frontendPort}`,
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  `http://127.0.0.1:${localPort}`,
  `http://localhost:${localPort}`,
];
const trustedOrigins = new Set(
  (process.env.TRUSTED_ORIGINS || defaultTrustedOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

export interface Principal {
  id: number;
  username: string;
  displayName: string;
  role: "admin" | "manager" | "staff";
}

function userRole(value: unknown): Principal["role"] {
  if (value === "admin" || value === "manager" || value === "staff") return value;
  throw new Error("The database contains an invalid user role.");
}

function countRows(query: string): number {
  const result = db.prepare(query).get();
  if (!result) throw new Error("A database count query returned no result.");
  return Number(result.count);
}

function authError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

function hashPassword(password: string, salt = randomBytes(16)): string {
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, PASSWORD_BYTES).toString("base64")}`;
}

const DUMMY_PASSWORD_HASH = hashPassword("not-a-real-cafeteria-password", Buffer.from("cafeteria-auth-v1"));

function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, saltValue, hashValue] = storedHash.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64");
  if (expected.length !== PASSWORD_BYTES) return false;
  const actual = scryptSync(password, Buffer.from(saltValue, "base64"), PASSWORD_BYTES);
  return timingSafeEqual(actual, expected);
}

function publicUser(principal: Principal) {
  return {
    id: principal.id,
    username: principal.username,
    displayName: principal.displayName,
    role: principal.role,
  };
}

function hashSession(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(response: ServerResponse, token: string, maxAgeSeconds: number): void {
  const secure = SESSION_COOKIE_SECURE ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

function clearSessionCookie(response: ServerResponse): void {
  const secure = SESSION_COOKIE_SECURE ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function sessionToken(request: IncomingMessage): string | null {
  const cookies = request.headers.cookie?.split(";") || [];
  const values = cookies
    .map((cookie) => cookie.trim().split("="))
    .filter(([name]) => name === SESSION_COOKIE)
    .map(([, value]) => value || "");
  if (values.length !== 1) return null;
  const token = values[0];
  return token && /^[A-Za-z0-9_-]{40,60}$/.test(token) ? token : null;
}

function principalForToken(token: string): Principal | null {
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role
    FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).get(hashSession(token), Date.now());
  if (!row) return null;
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: userRole(row.role),
  };
}

const failedLogins = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function loginKey(request: IncomingMessage): string {
  return request.socket.remoteAddress || "unknown";
}

function loginBlocked(request: IncomingMessage): boolean {
  const key = loginKey(request);
  const attempt = failedLogins.get(key);
  if (!attempt || attempt.resetAt <= Date.now()) {
    failedLogins.delete(key);
    return false;
  }
  return attempt.count >= MAX_FAILED_LOGINS;
}

function recordFailedLogin(request: IncomingMessage): void {
  const now = Date.now();
  for (const [key, attempt] of failedLogins) {
    if (attempt.resetAt <= now) failedLogins.delete(key);
  }
  const key = loginKey(request);
  const current = failedLogins.get(key);
  failedLogins.set(key, current && current.resetAt > now
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: now + LOGIN_WINDOW_MS });
}

export function initializeAuth(host: string): void {
  const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!localHosts.has(host) && (!SESSION_COOKIE_SECURE || !process.env.TRUSTED_ORIGINS)) {
    throw new Error("Network binding requires COOKIE_SECURE=true and an explicit TRUSTED_ORIGINS allowlist.");
  }
  for (const origin of trustedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid trusted origin: ${origin}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Trusted origins must be exact http(s) origins: ${origin}`);
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const migration = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
    if (!migration) {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE auth_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_auth_sessions_expiration ON auth_sessions(expires_at);
        INSERT INTO schema_migrations (version) VALUES (1);
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now());
  const userCount = countRows("SELECT COUNT(*) AS count FROM users");
  if (userCount === 0) {
    const username = process.env.CAFETERIA_ADMIN_USERNAME?.trim().toLowerCase();
    const password = process.env.CAFETERIA_ADMIN_PASSWORD;
    if (!username || !/^[a-z0-9._-]{3,64}$/.test(username)) {
      throw new Error("Set CAFETERIA_ADMIN_USERNAME (3-64 letters, numbers, dots, underscores, or hyphens) to create the initial admin.");
    }
    if (!password || password.length < 12 || password.length > 256) {
      throw new Error("Set CAFETERIA_ADMIN_PASSWORD (12-256 characters) to create the initial admin.");
    }
    db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(username, username, hashPassword(password));
    console.log(`Created initial cafeteria admin account "${username}".`);
  }
}

export function isTrustedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || trustedOrigins.has(origin);
}

export function authenticateRequest(request: IncomingMessage, response: ServerResponse): Principal | null {
  const token = sessionToken(request);
  const principal = token ? principalForToken(token) : null;
  if (!principal) {
    sendJson(response, 401, { error: "Authentication required" });
    return null;
  }
  return principal;
}

function requireRole(principal: Principal, roles: Principal["role"][]): boolean {
  return roles.includes(principal.role);
}

export async function handleAuthRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  principal: Principal | null,
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const token = sessionToken(request);
    const currentUser = token ? principalForToken(token) : null;
    if (!currentUser) {
      sendJson(response, 401, { error: "Authentication required" });
      return;
    }
    sendJson(response, 200, { user: publicUser(currentUser) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    if (loginBlocked(request)) {
      response.setHeader("Retry-After", String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
      sendJson(response, 429, { error: "Too many failed sign-in attempts. Try again in 15 minutes." });
      return;
    }
    const body = await readBody(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = username.length <= 64
      ? db.prepare("SELECT id, username, display_name, password_hash, role FROM users WHERE username = ? AND active = 1").get(username)
      : null;
    const storedHash = user ? String(user.password_hash) : DUMMY_PASSWORD_HASH;
    const passwordMatches = password.length <= 256 && verifyPassword(password, storedHash);
    if (!user || !passwordMatches) {
      recordFailedLogin(request);
      sendJson(response, 401, { error: "Invalid username or password." });
      return;
    }
    failedLogins.delete(loginKey(request));
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(hashSession(token), user.id, expiresAt);
    setSessionCookie(response, token, SESSION_DURATION_MS / 1000);
    sendJson(response, 200, {
      user: publicUser({
        id: Number(user.id),
        username: String(user.username),
        displayName: String(user.display_name),
        role: userRole(user.role),
      }),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = sessionToken(request);
    if (token) db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashSession(token));
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/password") {
    if (!principal) {
      sendJson(response, 401, { error: "Authentication required" });
      return;
    }
    const body = await readBody(request);
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ? AND active = 1").get(principal.id);
    if (!user || !verifyPassword(currentPassword, String(user.password_hash))) {
      throw authError("Current password is incorrect.", 400);
    }
    if (newPassword.length < 12 || newPassword.length > 256) {
      throw authError("New password must be between 12 and 256 characters.", 400);
    }
    if (verifyPassword(newPassword, String(user.password_hash))) {
      throw authError("Choose a new password that differs from your current password.", 400);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), principal.id);
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(principal.id);
      db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(hashSession(token), principal.id, expiresAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    setSessionCookie(response, token, SESSION_DURATION_MS / 1000);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/staff" && request.method === "GET") {
    if (!principal || !requireRole(principal, ["admin", "manager"])) {
      sendJson(response, 403, { error: "Only managers and admins can view staff accounts." });
      return;
    }
    const staff = db.prepare(`
      SELECT id, username, display_name, role, active, created_at
      FROM users ORDER BY role, display_name
    `).all();
    sendJson(response, 200, staff);
    return;
  }

  if (url.pathname === "/api/staff" && request.method === "POST") {
    if (!principal || !requireRole(principal, ["admin", "manager"])) {
      sendJson(response, 403, { error: "Only managers and admins can create staff accounts." });
      return;
    }
    const body = await readBody(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role;
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
      throw authError("Username must be 3-64 letters, numbers, dots, underscores, or hyphens.", 400);
    }
    if (!displayName || displayName.length > 100) throw authError("Display name is required and must be 100 characters or fewer.", 400);
    if (password.length < 12 || password.length > 256) throw authError("Password must be between 12 and 256 characters.", 400);
    if (!["admin", "manager", "staff"].includes(role)) throw authError("Choose a valid staff role.", 400);
    if (principal.role === "manager" && role !== "staff") {
      sendJson(response, 403, { error: "Managers can create staff accounts only." });
      return;
    }
    try {
      const result = db.prepare(`
        INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)
      `).run(username, displayName, hashPassword(password), role);
      sendJson(response, 201, {
        id: Number(result.lastInsertRowid),
        username,
        display_name: displayName,
        role,
        active: 1,
      });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw authError("That username is already in use.", 409);
      throw error;
    }
    return;
  }

  const activeMatch = url.pathname.match(/^\/api\/staff\/(\d+)\/active$/);
  if (activeMatch && request.method === "PATCH") {
    if (!principal || !requireRole(principal, ["admin", "manager"])) {
      sendJson(response, 403, { error: "Only managers and admins can update staff accounts." });
      return;
    }
    const targetId = Number(activeMatch[1]);
    const body = await readBody(request);
    if (typeof body.active !== "boolean") throw authError("Active must be true or false.", 400);
    const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(targetId);
    if (!target) throw authError("Staff account not found.", 404);
    if (principal.role === "manager" && target.role !== "staff") {
      sendJson(response, 403, { error: "Managers can only update staff accounts." });
      return;
    }
    if (targetId === principal.id && !body.active) {
      sendJson(response, 400, { error: "You cannot deactivate your own account." });
      return;
    }
    if (target.role === "admin" && !body.active) {
      const activeAdmins = countRows("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1");
      if (activeAdmins <= 1) throw authError("The last active admin account cannot be deactivated.", 400);
    }
    db.prepare("UPDATE users SET active = ? WHERE id = ?").run(Number(body.active), targetId);
    if (!body.active) db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(targetId);
    sendJson(response, 200, { id: targetId, active: Number(body.active) });
    return;
  }

  sendJson(response, 404, { error: "Authentication route not found" });
}
