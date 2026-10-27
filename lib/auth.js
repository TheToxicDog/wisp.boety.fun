// Per-person accounts: sign-up requests wait for the master account to
// approve them; only approved, signed-in users can open the app or the relay.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { join } from "node:path";
import { rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import express from "express";
import { DATA_DIR, loadJson, saveJson, saveJsonNow, flushAll } from "./store.js";

const scrypt = promisify(scryptCb);
const COOKIE = "wisp_session";
const SESSION_DAYS = 30;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
const MAX_PENDING = 200;
const SETUP_FILE = join(DATA_DIR, "setup-code");

// ───────── State ─────────
// users:    { [name]: { name, hash, role: "admin"|"user", status: "pending"|"active"|"disabled",
//                       mustChangePassword, note, created, approved, lastSeen } }
// sessions: { [sha256(token)]: { user, created, expires } }
const users = loadJson("users.json", {});
const sessions = loadJson("sessions.json", {});
const saveUsers = () => saveJson("users.json", () => users);
const saveSessions = () => saveJson("sessions.json", () => sessions);
export const flush = () => flushAll({ "users.json": () => users, "sessions.json": () => sessions });

// Live relay sockets per user, so access can be cut immediately.
const liveSockets = new Map();

const now = () => Date.now();
const tokenHash = (t) => createHash("sha256").update(t).digest("hex");
const hasAdmin = () => Object.values(users).some((u) => u.role === "admin");

// ───────── Passwords ─────────
async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
async function verifyPassword(pw, stored) {
  const [, N, r, p, salt, key] = stored.split("$");
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(actual, expected);
}

function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 200) return "Password is too long";
  return null;
}

// Readable temporary password, e.g. "kite-4821-mango-3307".
const WORDS = "amber birch cedar delta ember fable gamma harbor iris juniper kite lemon mango nova olive pixel quartz river sage tide umbra velvet willow xenon yarrow zephyr".split(" ");
function tempPassword() {
  const b = randomBytes(8);
  const w = (i) => WORDS[b[i] % WORDS.length];
  const n = (i) => String(b.readUInt16BE(i) % 10000).padStart(4, "0");
  return `${w(0)}-${n(1)}-${w(3)}-${n(4)}`;
}

// ───────── Sessions ─────────
function createSession(res, req, name) {
  const token = randomBytes(32).toString("base64url");
  sessions[tokenHash(token)] = { user: name, created: now(), expires: now() + SESSION_DAYS * 864e5 };
  saveSessions();
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    path: "/",
    maxAge: SESSION_DAYS * 864e5,
  });
}

function revokeSessions(name, exceptHash) {
  for (const [h, s] of Object.entries(sessions)) if (s.user === name && h !== exceptHash) delete sessions[h];
  saveSessions();
}

function dropSockets(name) {
  for (const s of liveSockets.get(name) || []) s.destroy();
  liveSockets.delete(name);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Resolves the signed-in, approved user for a request (HTTP or upgrade).
export function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const h = tokenHash(token);
  const s = sessions[h];
  if (!s) return null;
  if (s.expires < now()) { delete sessions[h]; saveSessions(); return null; }
  const u = users[s.user];
  if (!u || u.status !== "active") return null;
  if (now() - (u.lastSeen || 0) > 60_000) { u.lastSeen = now(); saveUsers(); }
  return { user: u, sessionHash: h };
}

// ───────── Rate limiting ─────────
const buckets = new Map();
function limited(key, max, windowMs) {
  const b = buckets.get(key);
  if (!b || b.reset < now()) { buckets.set(key, { n: 1, reset: now() + windowMs }); return false; }
  return ++b.n > max;
}
setInterval(() => { for (const [k, b] of buckets) if (b.reset < now()) buckets.delete(k); }, 600_000).unref();

const clientIp = (req) => req.get("x-real-ip") || req.socket.remoteAddress;

// ───────── Master setup code ─────────
export function ensureSetupCode() {
  if (hasAdmin()) { rmSync(SETUP_FILE, { force: true }); return null; }
  if (!existsSync(SETUP_FILE)) writeFileSync(SETUP_FILE, randomBytes(9).toString("base64url") + "\n", { mode: 0o600 });
  const code = readFileSync(SETUP_FILE, "utf8").trim();
  console.log(`No master account yet. Setup code: ${code}  (also in ${SETUP_FILE})`);
  return code;
}

// ───────── Middleware ─────────
export function requireUser(req, res, next) {
  const auth = userFromRequest(req);
  if (!auth) return res.status(401).json({ error: "Sign in required" });
  req.auth = auth;
  next();
}

// The app itself (not the API): send people without a session to /login.
// Remembers where they were going (e.g. a recipe link) across sign-in.
const loginUrl = (req) => (req.originalUrl === "/" ? "/login" : `/login?next=${encodeURIComponent(req.originalUrl)}`);

export function requirePage(req, res, next) {
  const auth = userFromRequest(req);
  if (!auth) return res.redirect(302, loginUrl(req));
  if (auth.user.mustChangePassword) return res.redirect(302, `${loginUrl(req)}#change`);
  req.auth = auth;
  next();
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.auth.user.role !== "admin") return res.status(403).json({ error: "Master account only" });
    next();
  });
}

// Cookie is SameSite=Lax and the API only accepts JSON, but also refuse
// state-changing requests that announce a foreign origin.
function sameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (req.method !== "GET" && origin && new URL(origin).host !== req.get("host")) {
    return res.status(403).json({ error: "Cross-origin request refused" });
  }
  next();
}

const publicUser = (u) => ({
  name: u.name, role: u.role, status: u.status, note: u.note || "",
  mustChangePassword: !!u.mustChangePassword,
  created: u.created, approved: u.approved || null, lastSeen: u.lastSeen || null,
  online: (liveSockets.get(u.name)?.size || 0) > 0,
});

// ───────── Relay gate ─────────
// Called on WebSocket upgrade; returns the user or null and tracks the socket.
export function authorizeUpgrade(req, socket) {
  const auth = userFromRequest(req);
  if (!auth || auth.user.mustChangePassword) return null;
  const name = auth.user.name;
  if (!liveSockets.has(name)) liveSockets.set(name, new Set());
  liveSockets.get(name).add(socket);
  socket.once("close", () => liveSockets.get(name)?.delete(socket));
  return auth.user;
}

// ───────── Routes ─────────
export function authRouter() {
  const r = express.Router();
  r.use(express.json({ limit: "8kb" }), sameOrigin);

  r.get("/auth/state", (req, res) => {
    const auth = userFromRequest(req);
    res.json({ setupRequired: !hasAdmin(), signedIn: !!auth, mustChangePassword: !!auth?.user.mustChangePassword });
  });

  r.post("/auth/setup", async (req, res) => {
    if (limited("setup:" + clientIp(req), 10, 3600_000)) return res.status(429).json({ error: "Too many attempts, try later" });
    if (hasAdmin()) return res.status(409).json({ error: "Master account already exists" });
    const { code, username, password } = req.body || {};
    const expected = existsSync(SETUP_FILE) ? readFileSync(SETUP_FILE, "utf8").trim() : "";
    if (!expected || typeof code !== "string" || code.trim().length !== expected.length ||
        !timingSafeEqual(Buffer.from(code.trim()), Buffer.from(expected))) {
      return res.status(403).json({ error: "Setup code is incorrect" });
    }
    const name = String(username || "").trim().toLowerCase();
    if (!USERNAME_RE.test(name)) return res.status(400).json({ error: "Username: 3–32 letters, numbers, . _ or -" });
    const bad = checkPassword(password);
    if (bad) return res.status(400).json({ error: bad });
    users[name] = { name, hash: await hashPassword(password), role: "admin", status: "active", created: now(), approved: now() };
    saveJsonNow("users.json", users);
    rmSync(SETUP_FILE, { force: true });
    createSession(res, req, name);
    res.json({ ok: true });
  });

  r.post("/auth/signup", async (req, res) => {
    if (limited("signup:" + clientIp(req), 5, 3600_000)) return res.status(429).json({ error: "Too many requests, try later" });
    const { username, password, note } = req.body || {};
    const name = String(username || "").trim().toLowerCase();
    if (!USERNAME_RE.test(name)) return res.status(400).json({ error: "Username: 3–32 letters, numbers, . _ or -" });
    if (users[name]) return res.status(409).json({ error: "That username is taken" });
    const bad = checkPassword(password);
    if (bad) return res.status(400).json({ error: bad });
    if (Object.values(users).filter((u) => u.status === "pending").length >= MAX_PENDING) {
      return res.status(503).json({ error: "Too many pending requests right now" });
    }
    users[name] = {
      name, hash: await hashPassword(password), role: "user", status: "pending",
      note: String(note || "").slice(0, 200), created: now(),
    };
    saveUsers();
    res.json({ ok: true, status: "pending" });
  });

  r.post("/auth/login", async (req, res) => {
    const { username, password } = req.body || {};
    const name = String(username || "").trim().toLowerCase();
    if (limited("login-ip:" + clientIp(req), 20, 900_000) || limited("login-user:" + name, 10, 900_000)) {
      return res.status(429).json({ error: "Too many attempts. Wait 15 minutes and try again." });
    }
    const u = users[name];
    const ok = await verifyPassword(String(password || ""), u ? u.hash : DUMMY_HASH);
    if (!u || !ok) return res.status(401).json({ error: "Wrong username or password" });
    if (u.status === "pending") return res.status(403).json({ error: "Your account is waiting for approval", status: "pending" });
    if (u.status === "disabled") return res.status(403).json({ error: "This account has been disabled", status: "disabled" });
    buckets.delete("login-user:" + name);
    u.lastSeen = now();
    saveUsers();
    createSession(res, req, name);
    res.json({ ok: true, mustChangePassword: !!u.mustChangePassword });
  });

  r.post("/auth/logout", (req, res) => {
    const auth = userFromRequest(req);
    if (auth) { delete sessions[auth.sessionHash]; saveSessions(); }
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // ── Signed-in user ──
  r.get("/me", requireUser, (req, res) => res.json(publicUser(req.auth.user)));

  r.post("/me/password", requireUser, async (req, res) => {
    const u = req.auth.user;
    if (limited("pw:" + u.name, 10, 900_000)) return res.status(429).json({ error: "Too many attempts, try later" });
    const { current, next } = req.body || {};
    if (!(await verifyPassword(String(current || ""), u.hash))) return res.status(403).json({ error: "Current password is wrong" });
    const bad = checkPassword(next);
    if (bad) return res.status(400).json({ error: bad });
    if (next === current) return res.status(400).json({ error: "Choose a different password" });
    u.hash = await hashPassword(next);
    u.mustChangePassword = false;
    saveUsers();
    revokeSessions(u.name, req.auth.sessionHash); // sign out other devices
    res.json({ ok: true });
  });

  // ── Master account ──
  const target = (req, res) => {
    const u = users[String(req.params.name).toLowerCase()];
    if (!u) { res.status(404).json({ error: "No such user" }); return null; }
    if (u.role === "admin" && u.name !== req.auth.user.name) { res.status(403).json({ error: "Can't change another master account" }); return null; }
    return u;
  };
  const notSelf = (req, res, u) => {
    if (u.name === req.auth.user.name) { res.status(400).json({ error: "Use Account to change your own password" }); return false; }
    return true;
  };

  r.get("/admin/users", requireAdmin, (_req, res) => {
    res.json(Object.values(users).map(publicUser).sort((a, b) => b.created - a.created));
  });

  r.post("/admin/users", requireAdmin, async (req, res) => {
    const name = String(req.body?.username || "").trim().toLowerCase();
    if (!USERNAME_RE.test(name)) return res.status(400).json({ error: "Username: 3–32 letters, numbers, . _ or -" });
    if (users[name]) return res.status(409).json({ error: "That username is taken" });
    const password = req.body?.password ? String(req.body.password) : tempPassword();
    const bad = checkPassword(password);
    if (bad) return res.status(400).json({ error: bad });
    users[name] = {
      name, hash: await hashPassword(password), role: "user", status: "active",
      mustChangePassword: true, created: now(), approved: now(),
    };
    saveUsers();
    res.json({ ok: true, user: publicUser(users[name]), password });
  });

  r.post("/admin/users/:name/approve", requireAdmin, (req, res) => {
    const u = target(req, res); if (!u) return;
    u.status = "active";
    u.approved = now();
    saveUsers();
    res.json(publicUser(u));
  });

  r.post("/admin/users/:name/disable", requireAdmin, (req, res) => {
    const u = target(req, res); if (!u || !notSelf(req, res, u)) return;
    u.status = "disabled";
    saveUsers();
    revokeSessions(u.name);
    dropSockets(u.name);
    res.json(publicUser(u));
  });

  r.post("/admin/users/:name/enable", requireAdmin, (req, res) => {
    const u = target(req, res); if (!u) return;
    u.status = "active";
    u.approved ||= now();
    saveUsers();
    res.json(publicUser(u));
  });

  r.post("/admin/users/:name/reset-password", requireAdmin, async (req, res) => {
    const u = target(req, res); if (!u || !notSelf(req, res, u)) return;
    const password = tempPassword();
    u.hash = await hashPassword(password);
    u.mustChangePassword = true;
    saveUsers();
    revokeSessions(u.name);
    dropSockets(u.name);
    res.json({ ok: true, password });
  });

  r.post("/admin/users/:name/signout", requireAdmin, (req, res) => {
    const u = target(req, res); if (!u || !notSelf(req, res, u)) return;
    revokeSessions(u.name);
    dropSockets(u.name);
    res.json({ ok: true });
  });

  r.delete("/admin/users/:name", requireAdmin, (req, res) => {
    const u = target(req, res); if (!u || !notSelf(req, res, u)) return;
    revokeSessions(u.name);
    dropSockets(u.name);
    delete users[u.name];
    saveUsers();
    res.json({ ok: true });
  });

  return r;
}

// Lockout recovery from the VPS shell (service stopped): see scripts/admin.js.
export const _internal = { users, hashPassword, tempPassword, saveUsersNow: () => saveJsonNow("users.json", users), revokeAll: (n) => { revokeSessions(n); flush(); } };
