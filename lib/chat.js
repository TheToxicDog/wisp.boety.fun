// Chat room for signed-in people: messages and photos over a WebSocket
// (/chat/), plus signalling for a group video call. Call media goes
// browser-to-browser over WebRTC; the server only relays the handshakes.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import express from "express";
import { WebSocketServer } from "ws";
import { DATA_DIR, loadJson, saveJson } from "./store.js";
import { requireUser, authorizeUpgrade } from "./auth.js";

const MAX_MESSAGES = 1000;
const HISTORY = 200; // sent to each client on connect
const MAX_TEXT = 2000;
const MAX_PHOTOS = 6; // per message
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const CALL_LIMIT = 8; // a mesh call sends every stream to everyone
const PHOTO_DIR = join(DATA_DIR, "chat-photos");
mkdirSync(PHOTO_DIR, { recursive: true, mode: 0o700 });

// Free public STUN servers find a direct path between browsers. Networks that
// block that need a TURN relay: set CHAT_TURN_URL / _USER / _PASS.
const ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
if (process.env.CHAT_TURN_URL) {
  ICE_SERVERS.push({ urls: process.env.CHAT_TURN_URL.split(","), username: process.env.CHAT_TURN_USER, credential: process.env.CHAT_TURN_PASS });
}

// ───────── State ─────────
// messages: [{ id, user, text, photos: [{ id, w, h }], at }]
// photos:   { [id]: { user, type, at } }  (files live in PHOTO_DIR/<id>)
const db = loadJson("chat.json", { messages: [], photos: {} });
const save = () => saveJson("chat.json", () => db, 500);

const clients = new Map(); // ws -> { id, user, role }
const call = new Map(); // connection id -> user name
const now = () => Date.now();
const newId = () => randomBytes(9).toString("base64url");

const PHOTO_TYPES = [
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))],
  ["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];
const sniff = (buf) => PHOTO_TYPES.find(([, test]) => buf.length > 12 && test(buf))?.[0] || null;

function removePhoto(id) {
  delete db.photos[id];
  rmSync(join(PHOTO_DIR, id), { force: true });
}

// Photos uploaded but never sent, and files no longer listed, are removed.
function sweepPhotos() {
  const used = new Set(db.messages.flatMap((m) => m.photos.map((p) => p.id)));
  for (const [id, p] of Object.entries(db.photos)) {
    if (!used.has(id) && now() - p.at > 3600_000) removePhoto(id);
    else if (!existsSync(join(PHOTO_DIR, id))) delete db.photos[id];
  }
  save();
}
sweepPhotos();
setInterval(sweepPhotos, 3600_000).unref();

// ───────── Rate limiting ─────────
const buckets = new Map();
function limited(key, max, windowMs) {
  const b = buckets.get(key);
  if (!b || b.reset < now()) { buckets.set(key, { n: 1, reset: now() + windowMs }); return false; }
  return ++b.n > max;
}
setInterval(() => { for (const [k, b] of buckets) if (b.reset < now()) buckets.delete(k); }, 600_000).unref();

// ───────── Broadcasting ─────────
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(s); };
const online = () => [...new Set([...clients.values()].map((c) => c.user))].sort();
const callMembers = () => [...call].map(([id, user]) => ({ id, user }));

function leaveCall(c) {
  if (!call.delete(c.id)) return;
  broadcast({ t: "call", members: callMembers() });
}

// ───────── Messages from a client ─────────
function handle(ws, c, msg) {
  switch (msg.t) {
    case "send": {
      if (limited("msg:" + c.user, 20, 10_000)) return send(ws, { t: "error", error: "Slow down a little" });
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, MAX_TEXT) : "";
      const photos = (Array.isArray(msg.photos) ? msg.photos : []).slice(0, MAX_PHOTOS)
        .filter((p) => db.photos[p?.id]?.user === c.user)
        .map((p) => ({ id: p.id, w: Math.min(Math.max(+p.w || 0, 0), 20000) | 0, h: Math.min(Math.max(+p.h || 0, 0), 20000) | 0 }));
      if (!text && !photos.length) return;
      const m = { id: newId(), user: c.user, text, photos, at: now() };
      db.messages.push(m);
      for (const old of db.messages.splice(0, Math.max(0, db.messages.length - MAX_MESSAGES))) old.photos.forEach((p) => removePhoto(p.id));
      save();
      broadcast({ t: "msg", m });
      return;
    }
    case "delete": {
      const i = db.messages.findIndex((m) => m.id === msg.id);
      if (i < 0) return;
      const m = db.messages[i];
      if (m.user !== c.user && c.role !== "admin") return send(ws, { t: "error", error: "You can only delete your own messages" });
      db.messages.splice(i, 1);
      m.photos.forEach((p) => removePhoto(p.id));
      save();
      broadcast({ t: "delete", id: m.id });
      return;
    }
    case "typing":
      if (limited("typing:" + c.id, 1, 2_000)) return;
      for (const [other, oc] of clients) if (oc.user !== c.user) send(other, { t: "typing", user: c.user });
      return;
    case "call-join":
      if (call.has(c.id)) return;
      if (call.size >= CALL_LIMIT) return send(ws, { t: "error", error: `The call is full (${CALL_LIMIT} people)` });
      call.set(c.id, c.user);
      broadcast({ t: "call", members: callMembers() });
      return;
    case "call-leave":
      return leaveCall(c);
    case "signal": {
      // WebRTC offer/answer/ICE, passed only between two people in the call.
      if (!call.has(c.id) || !call.has(msg.to)) return;
      const data = JSON.stringify(msg.data ?? null);
      if (data.length > 64_000) return;
      for (const [other, oc] of clients) if (oc.id === msg.to) send(other, { t: "signal", from: c.id, data: JSON.parse(data) });
      return;
    }
  }
}

// ───────── WebSocket ─────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

wss.on("connection", (ws, user) => {
  const c = { id: newId(), user: user.name, role: user.role };
  clients.set(ws, c);
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg && typeof msg === "object") handle(ws, c, msg);
  });
  ws.on("close", () => {
    clients.delete(ws);
    leaveCall(c);
    broadcast({ t: "presence", online: online() });
  });
  send(ws, {
    t: "hello", me: { id: c.id, user: c.user, admin: c.role === "admin" },
    messages: db.messages.slice(-HISTORY), online: online(), call: callMembers(),
    iceServers: ICE_SERVERS, callLimit: CALL_LIMIT,
  });
  broadcast({ t: "presence", online: online() });
});

// Pings keep the socket under Cloudflare's 100s idle cutoff and drop dead peers.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

// Called from the server's upgrade handler for /chat/.
export function chatUpgrade(req, socket, head) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
    return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }
  // Tracked like relay sockets, so disabling someone also drops their chat.
  const user = authorizeUpgrade(req, socket);
  if (!user) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, user));
}

// ───────── Photos ─────────
export function chatRouter() {
  const r = express.Router();

  r.post("/photo", requireUser, express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), (req, res) => {
    const user = req.auth.user.name;
    if (limited("photo:" + user, 40, 600_000)) return res.status(429).json({ error: "Too many photos, try again in a few minutes" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = sniff(body);
    if (!type) return res.status(415).json({ error: "That file isn't a photo (JPEG, PNG, GIF or WebP)" });
    const id = newId();
    writeFileSync(join(PHOTO_DIR, id), body, { mode: 0o600 });
    db.photos[id] = { user, type, at: now() };
    save();
    res.json({ id });
  });

  r.get("/photo/:id", requireUser, (req, res) => {
    const p = /^[\w-]{12}$/.test(req.params.id) && db.photos[req.params.id];
    if (!p) return res.status(404).end();
    res.set({ "Content-Type": p.type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    res.sendFile(join(PHOTO_DIR, req.params.id), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  r.use((err, _req, res, next) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Photos can be up to 10 MB" });
    next(err);
  });
  return r;
}
