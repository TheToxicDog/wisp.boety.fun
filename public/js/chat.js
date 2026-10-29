// Chat room: live messages and photos for everyone signed in, plus a group
// video call (WebRTC mesh; the server only relays the call handshakes).
import { $, toast, escapeHtml, hue } from "./ui.js";
import { api } from "./api.js";

const MAX_SIDE = 1920; // photos are resized to this before upload
const MAX_GIF = 8 * 1024 * 1024; // GIFs are sent as-is to keep the animation
const GROUP_MS = 5 * 60_000;

let ws = null;
let me = null;
let iceServers = [];
let messages = [];
let online = [];
let members = []; // [{ id, user }] in the video call
let visible = false;
let unread = 0;
let retry = 0;
let attachments = []; // [{ key, url, id?, w, h, failed? }]
let lastTyping = 0;
const typers = new Map(); // user -> timeout

// ───────── Connection ─────────
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/chat/`);
  let opened = false;
  ws.onopen = () => { opened = true; retry = 0; };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    ws = null;
    endCall(false);
    setStatus("Reconnecting…");
    // Repeated failures before opening usually mean the session ended.
    if (!opened && ++retry >= 2) api("/api/me").catch(() => {});
    setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(retry, 4)));
  };
}

const sendWs = (msg) => { if (ws?.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } return false; };

function onMessage(msg) {
  switch (msg.t) {
    case "hello":
      me = msg.me;
      iceServers = msg.iceServers || [];
      messages = msg.messages;
      online = msg.online;
      members = msg.call;
      renderLog();
      renderOnline();
      renderCallState();
      setStatus("");
      break;
    case "msg":
      messages.push(msg.m);
      appendMessage(msg.m);
      clearTyping(msg.m.user);
      if (msg.m.user !== me.user && !visible) { unread++; paintUnread(); }
      break;
    case "delete":
      messages = messages.filter((m) => m.id !== msg.id);
      renderLog(true);
      break;
    case "presence":
      online = msg.online;
      renderOnline();
      break;
    case "typing":
      showTyping(msg.user);
      break;
    case "call":
      members = msg.members;
      syncPeers();
      renderCallState();
      break;
    case "signal":
      onSignal(msg.from, msg.data);
      break;
    case "error":
      toast(msg.error);
      break;
  }
}

function setStatus(text) {
  const el = $("#chatStatus");
  el.textContent = text;
  el.hidden = !text;
}

// ───────── Messages ─────────
const avatar = (name) => `<span class="avatar" style="background:${hue(name)}">${escapeHtml(name[0].toUpperCase())}</span>`;
const photoSrc = (id) => `/api/chat/photo/${id}`;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function dayLabel(t) {
  const d = new Date(t), today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === new Date(today - 864e5).toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

// Escapes the text, then turns web links into links.
function linkify(text) {
  return escapeHtml(text).replace(/https?:\/\/[^\s<]+[^\s<.,:;!?)\]'"]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function messageHtml(m, prev) {
  const mine = m.user === me.user;
  const newDay = !prev || !sameDay(prev.at, m.at);
  const grouped = !newDay && prev.user === m.user && m.at - prev.at < GROUP_MS;
  const photos = m.photos.length ? `<div class="photos n${Math.min(m.photos.length, 3)}">${m.photos.map((p) =>
    `<img src="${photoSrc(p.id)}" alt="Photo from ${escapeHtml(m.user)}" loading="lazy" data-photo="${p.id}"${p.w && p.h ? ` style="aspect-ratio:${p.w}/${p.h}"` : ""}>`).join("")}</div>` : "";
  return `${newDay ? `<div class="day"><span>${dayLabel(m.at)}</span></div>` : ""}
    <div class="msg${mine ? " mine" : ""}${grouped ? " grouped" : ""}" data-id="${m.id}">
      ${grouped ? `<span class="avatar-gap"></span>` : avatar(m.user)}
      <div class="msg-body">
        ${grouped ? "" : `<div class="msg-meta"><b>${escapeHtml(m.user)}</b><time>${clock(m.at)}</time></div>`}
        ${photos}
        ${m.text ? `<div class="bubble">${linkify(m.text)}</div>` : ""}
        ${mine || me.admin ? `<button class="msg-del" type="button" data-del="${m.id}">Delete</button>` : ""}
      </div>
    </div>`;
}

const log = () => $("#chatLog");
const nearBottom = () => { const l = log(); return l.scrollHeight - l.scrollTop - l.clientHeight < 120; };
const toBottom = () => { const l = log(); l.scrollTop = l.scrollHeight; };

function renderLog(keepScroll) {
  const top = log().scrollTop;
  log().querySelectorAll(".msg, .day, .chat-empty").forEach((el) => el.remove());
  const html = messages.map((m, i) => messageHtml(m, messages[i - 1])).join("");
  log().insertAdjacentHTML("beforeend", html || `<div class="chat-empty muted">No messages yet. Say hi 👋</div>`);
  if (keepScroll) log().scrollTop = top; else toBottom();
}

function appendMessage(m) {
  const stick = nearBottom() || m.user === me.user;
  log().querySelector(".chat-empty")?.remove();
  log().insertAdjacentHTML("beforeend", messageHtml(m, messages[messages.length - 2]));
  if (stick) {
    toBottom();
    // Photos change the height as they load.
    log().querySelectorAll(`.msg[data-id="${m.id}"] img`).forEach((img) => img.addEventListener("load", toBottom, { once: true }));
  }
}

function renderOnline() {
  const shown = online.slice(0, 5);
  $("#chatOnline").innerHTML = `<span class="stack">${shown.map(avatar).join("")}</span>
    <span><b>${online.length} online</b><small class="muted">${escapeHtml(online.join(", "))}</small></span>`;
}

function paintUnread() {
  const tag = $("#chatTag");
  if (inCall()) { tag.hidden = false; tag.textContent = "Live"; return; }
  tag.hidden = !unread;
  tag.textContent = unread > 99 ? "99+" : unread;
}

// ───────── Typing ─────────
function showTyping(user) {
  clearTimeout(typers.get(user));
  typers.set(user, setTimeout(() => clearTyping(user), 3500));
  paintTyping();
}
function clearTyping(user) {
  clearTimeout(typers.get(user));
  typers.delete(user);
  paintTyping();
}
function paintTyping() {
  const names = [...typers.keys()];
  $("#chatTyping").textContent = !names.length ? "" : names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : "Several people are typing…";
}

// ───────── Photos ─────────
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that photo"));
    img.src = URL.createObjectURL(file);
  });
}

// Resizes and re-encodes as JPEG (which also drops location data); GIFs stay as they are.
async function preparePhoto(file) {
  const img = await loadImage(file);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (file.type === "image/gif" && file.size <= MAX_GIF) return { blob: file, w, h, url: img.src };
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs get a white background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("Couldn't read that photo");
  return { blob, w: canvas.width, h: canvas.height, url: img.src };
}

async function upload(blob) {
  const res = await fetch("/api/chat/photo", { method: "POST", body: blob, headers: { "Content-Type": blob.type || "application/octet-stream" }, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data.id;
}

async function addPhotos(files) {
  const images = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!images.length) return;
  const room = 6 - attachments.length;
  if (images.length > room) toast("Up to 6 photos per message");
  for (const file of images.slice(0, Math.max(0, room))) {
    const a = { key: Math.random().toString(36).slice(2), url: "", w: 0, h: 0 };
    attachments.push(a);
    renderTray();
    try {
      const p = await preparePhoto(file);
      Object.assign(a, { url: p.url, w: p.w, h: p.h });
      renderTray();
      a.id = await upload(p.blob);
    } catch (err) {
      toast(err.message);
      removeAttachment(a.key);
    }
    renderTray();
  }
}

function removeAttachment(key) {
  const a = attachments.find((x) => x.key === key);
  if (a?.url) URL.revokeObjectURL(a.url);
  attachments = attachments.filter((x) => x.key !== key);
  renderTray();
}

function renderTray() {
  const tray = $("#attachTray");
  tray.hidden = !attachments.length;
  tray.innerHTML = attachments.map((a) => `
    <div class="attach${a.id ? "" : " busy"}">
      ${a.url ? `<img src="${a.url}" alt="">` : ""}
      ${a.id ? "" : `<div class="spinner"></div>`}
      <button type="button" class="rm" data-rm="${a.key}" aria-label="Remove photo"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>`).join("");
  paintSend();
}

const uploading = () => attachments.some((a) => !a.id);
function paintSend() {
  $("#chatSend").disabled = uploading() || (!$("#chatText").value.trim() && !attachments.length);
}

function submit() {
  const text = $("#chatText").value.trim();
  if (uploading()) return toast("Photos are still uploading");
  if (!text && !attachments.length) return;
  if (!sendWs({ t: "send", text, photos: attachments.map(({ id, w, h }) => ({ id, w, h })) })) return toast("Not connected yet");
  attachments.forEach((a) => a.url && URL.revokeObjectURL(a.url));
  attachments = [];
  renderTray();
  $("#chatText").value = "";
  growText();
  paintSend();
}

function growText() {
  const t = $("#chatText");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

function openLightbox(id) {
  $("#lightboxImg").src = photoSrc(id);
  $("#lightboxSave").href = photoSrc(id);
  $("#lightbox").hidden = false;
}
const closeLightbox = () => { $("#lightbox").hidden = true; $("#lightboxImg").removeAttribute("src"); };

// ───────── Video call ─────────
let localStream = null;
const peers = new Map(); // connection id -> { pc, user, tile, polite, makingOffer, ignoreOffer }
let facing = "user";

const inCall = () => !!localStream;

async function getMedia() {
  const video = { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try { return await navigator.mediaDevices.getUserMedia({ video, audio }); }
  catch (err) {
    if (err.name === "NotFoundError" || err.name === "OverconstrainedError") return navigator.mediaDevices.getUserMedia({ audio });
    throw err;
  }
}

async function joinCall() {
  if (inCall()) return;
  if (!navigator.mediaDevices?.getUserMedia) return toast("This browser can't make video calls");
  if (!ws || ws.readyState !== 1) return toast("Not connected yet");
  $("#callBtn").disabled = true;
  try { localStream = await getMedia(); }
  catch (err) {
    $("#callBtn").disabled = false;
    return toast(err.name === "NotAllowedError" ? "Allow camera and microphone access to join" : "Couldn't start your camera: " + err.message);
  }
  $("#callBtn").disabled = false;
  $("#call").hidden = false;
  $("#chat").classList.add("in-call");
  addTile("me", `${me.user} (you)`, localStream, true);
  paintControls();
  const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === "videoinput");
  $("#flipBtn").hidden = cams.length < 2;
  sendWs({ t: "call-join" });
  renderCallState();
}

function endCall(tellServer = true) {
  if (!inCall()) return;
  if (tellServer) sendWs({ t: "call-leave" });
  for (const id of [...peers.keys()]) closePeer(id);
  localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  $("#callGrid").innerHTML = "";
  $("#call").hidden = true;
  $("#chat").classList.remove("in-call");
  renderCallState();
}

function addTile(id, name, stream, local) {
  const tile = document.createElement("div");
  tile.className = "tile" + (local ? " local" : "");
  tile.dataset.peer = id;
  tile.innerHTML = `<video autoplay playsinline${local ? " muted" : ""}></video>
    <span class="tile-ph" style="background:${hue(name)}">${escapeHtml(name[0].toUpperCase())}</span>
    <span class="tile-name">${escapeHtml(name)}</span>`;
  const video = tile.querySelector("video");
  if (stream) video.srcObject = stream;
  $("#callGrid").append(tile);
  paintGrid();
  return tile;
}

function paintGrid() {
  const n = $("#callGrid").children.length;
  $("#callGrid").dataset.n = Math.min(n, 9);
}

// Each pair of browsers connects directly. "Perfect negotiation": either side
// may offer; on a collision the polite side yields.
function createPeer(id, user) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = { pc, user, polite: me.id > id, makingOffer: false, ignoreOffer: false, tile: addTile(id, user, null, false) };
  peers.set(id, peer);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.ontrack = (e) => {
    const video = peer.tile.querySelector("video");
    if (video.srcObject !== e.streams[0]) video.srcObject = e.streams[0];
    peer.tile.classList.add("live");
  };
  pc.onicecandidate = (e) => { if (e.candidate) sendWs({ t: "signal", to: id, data: { candidate: e.candidate.toJSON() } }); };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendWs({ t: "signal", to: id, data: { description: pc.localDescription.toJSON() } });
    } catch (err) { console.error(err); }
    finally { peer.makingOffer = false; }
  };
  pc.onconnectionstatechange = () => {
    peer.tile.classList.toggle("weak", pc.connectionState === "disconnected" || pc.connectionState === "failed");
    if (pc.connectionState === "failed") pc.restartIce();
  };
  return peer;
}

async function onSignal(from, data) {
  if (!inCall() || !data) return;
  let peer = peers.get(from);
  if (!peer) {
    const member = members.find((m) => m.id === from);
    if (!member) return;
    peer = createPeer(from, member.user);
  }
  const { pc } = peer;
  try {
    if (data.description) {
      const collision = data.description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        await pc.setLocalDescription();
        sendWs({ t: "signal", to: from, data: { description: pc.localDescription.toJSON() } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); }
      catch (err) { if (!peer.ignoreOffer) throw err; }
    }
  } catch (err) { console.error("call signal", err); }
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.tile.remove();
  peers.delete(id);
  paintGrid();
}

// Connect to people who joined, drop people who left.
function syncPeers() {
  if (!inCall()) return;
  const ids = new Set(members.map((m) => m.id));
  if (!ids.has(me.id)) return endCall(false);
  for (const id of [...peers.keys()]) if (!ids.has(id)) closePeer(id);
  for (const m of members) if (m.id !== me.id && !peers.has(m.id)) createPeer(m.id, m.user);
}

function renderCallState() {
  const others = members.filter((m) => m.id !== me?.id).map((m) => m.user);
  const banner = $("#callBanner");
  banner.hidden = inCall() || !members.length;
  if (!banner.hidden) {
    banner.innerHTML = `<span class="live-dot"></span><span><b>${escapeHtml([...new Set(others)].join(", "))}</b> ${others.length === 1 ? "is" : "are"} in the video call</span>
      <button class="btn sm primary" type="button" id="joinBtn">Join</button>`;
  }
  $("#callBtnText").textContent = inCall() ? "Leave call" : members.length ? "Join call" : "Video call";
  $("#callBtn").classList.toggle("danger", inCall());
  paintUnread();
}

function paintControls() {
  const mic = localStream?.getAudioTracks()[0];
  const cam = localStream?.getVideoTracks()[0];
  $("#micBtn").setAttribute("aria-pressed", String(!!mic?.enabled));
  $("#micBtn").disabled = !mic;
  $("#camBtn").setAttribute("aria-pressed", String(!!cam?.enabled));
  $("#camBtn").disabled = !cam;
  $('.tile.local')?.classList.toggle("cam-off", !cam?.enabled);
}

function toggleTrack(kind) {
  const track = kind === "audio" ? localStream?.getAudioTracks()[0] : localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  paintControls();
}

async function flipCamera() {
  const old = localStream?.getVideoTracks()[0];
  if (!old) return;
  facing = facing === "user" ? "environment" : "user";
  try {
    const fresh = (await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } } })).getVideoTracks()[0];
    fresh.enabled = old.enabled;
    for (const { pc } of peers.values()) {
      const sender = pc.getSenders().find((s) => s.track === old);
      await sender?.replaceTrack(fresh);
    }
    localStream.removeTrack(old);
    localStream.addTrack(fresh);
    old.stop();
    $(".tile.local").classList.toggle("rear", facing === "environment");
    $(".tile.local video").srcObject = localStream;
  } catch (err) { toast("Couldn't switch camera"); }
}

// ───────── Setup ─────────
export function initChat() {
  connect();

  const text = $("#chatText");
  $("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  text.addEventListener("keydown", (e) => {
    // Enter sends on keyboards; Shift+Enter (or the iPad on-screen return) adds a line.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover: hover)").matches) { e.preventDefault(); submit(); }
  });
  text.addEventListener("input", () => {
    growText();
    paintSend();
    if (text.value.trim() && Date.now() - lastTyping > 2500) { lastTyping = Date.now(); sendWs({ t: "typing" }); }
  });
  text.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); addPhotos(files); }
  });

  $("#chatFile").addEventListener("change", (e) => { addPhotos(e.target.files); e.target.value = ""; });
  $("#attachTray").addEventListener("click", (e) => { const k = e.target.closest("[data-rm]")?.dataset.rm; if (k) removeAttachment(k); });

  const main = $(".chat-main");
  main.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); main.classList.add("drop"); } });
  main.addEventListener("dragleave", (e) => { if (!main.contains(e.relatedTarget)) main.classList.remove("drop"); });
  main.addEventListener("drop", (e) => { e.preventDefault(); main.classList.remove("drop"); addPhotos(e.dataTransfer.files); });

  log().addEventListener("click", (e) => {
    const photo = e.target.closest("[data-photo]");
    if (photo) return openLightbox(photo.dataset.photo);
    const del = e.target.closest("[data-del]");
    if (del) {
      if (confirm("Delete this message for everyone?")) sendWs({ t: "delete", id: del.dataset.del });
      return;
    }
    if (e.target.closest("a")) return;
    // Tap a message to show its Delete button.
    const msg = e.target.closest(".msg");
    log().querySelectorAll(".msg.picked").forEach((m) => m !== msg && m.classList.remove("picked"));
    msg?.classList.toggle("picked");
  });

  $("#lightbox").addEventListener("click", (e) => { if (!e.target.closest("#lightboxSave")) closeLightbox(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#lightbox").hidden) closeLightbox(); });

  $("#callBtn").addEventListener("click", () => (inCall() ? endCall() : joinCall()));
  $("#callBanner").addEventListener("click", (e) => { if (e.target.closest("#joinBtn")) joinCall(); });
  $("#leaveBtn").addEventListener("click", () => endCall());
  $("#micBtn").addEventListener("click", () => toggleTrack("audio"));
  $("#camBtn").addEventListener("click", () => toggleTrack("video"));
  $("#flipBtn").addEventListener("click", flipCamera);
  addEventListener("pagehide", () => endCall());

  paintSend();
}

export function showChat(show) {
  visible = show;
  if (!show) return;
  unread = 0;
  paintUnread();
  if (me) requestAnimationFrame(toBottom);
}
