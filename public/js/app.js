// App shell: sidebar + drawer, hash routing, theme and settings.
import { settings, set, onChange, resetAll } from "./store.js";
import { $, $$, toast, openDrawer, closeDrawer } from "./ui.js";
import { initRuntime, initBrowser, setTransport } from "./browser.js";
import { initGateway, showGateway } from "./gateway.js";
import { initAnnotate } from "./annotate.js";
import { initAccount, showAdmin } from "./accounts.js";
import { initRecipes, showRecipes } from "./recipes.js";
import { initChat, showChat } from "./chat.js";
import { initPhoto, showPhoto } from "./photo.js";
import { initCut, showCut } from "./cut.js";

const app = $("#app");
let me = null;
const ACCENTS = ["#5b8cff", "#7c5cff", "#e05297", "#f07c3a", "#1fb57a", "#14a3c7", "#8a919e"];
const TITLES = {
  browser: "Isolated Browser",
  gateway: "Gateway & Streams",
  settings: "Settings",
  account: "Account",
  admin: "People",
  recipes: "Recipes",
  chat: "Chat",
  photo: "Photos",
  cut: "BoetyCut",
};

// ───────── Routing ─────────
function route() {
  const [view, query = ""] = location.hash.replace("#/", "").split("?");
  let known = view && view in TITLES ? view : "browser";
  if (known === "admin" && me?.role !== "admin") known = "browser";
  $$(".view").forEach((v) => (v.hidden = true));
  $(`#view-${known}`).hidden = false;
  $("#viewTitle").textContent = TITLES[known];
  $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.view === known));
  showGateway(known === "gateway");
  showAdmin(known === "admin");
  showRecipes(known === "recipes", new URLSearchParams(query));
  showChat(known === "chat");
  showPhoto(known === "photo");
  showCut(known === "cut");
  closeDrawer();
}

// ───────── Sidebar / drawer ─────────
const isDrawer = () => matchMedia("(max-width: 1023px)").matches;

function initSidebar() {
  $("#menuBtn").addEventListener("click", openDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  $("#railToggle").addEventListener("click", () => set({ rail: !settings.rail }));

  // Edge swipe from the left opens the drawer; swipe left closes it.
  let x0 = null, y0 = 0;
  addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    const open = app.classList.contains("drawer-open");
    if (isDrawer() && (open || t.clientX < 24)) { x0 = t.clientX; y0 = t.clientY; }
  }, { passive: true });
  addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
    if (dy < 60 && dx > 60) openDrawer();
    if (dy < 60 && dx < -60) closeDrawer();
    x0 = null;
  }, { passive: true });
}

// ───────── Theme ─────────
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = settings.theme;
  root.style.setProperty("--accent", settings.accent);
  app.classList.toggle("rail", settings.rail);
  const dark = settings.theme === "dark" || (settings.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  $('meta[name="theme-color"]').content = dark ? "#0e1116" : "#f4f5f8";
}

// ───────── Settings view ─────────
function initSettings() {
  const search = $("#setSearch");
  search.value = settings.search;
  search.addEventListener("change", () => set({ search: search.value }));

  const restore = $("#setRestore");
  restore.checked = settings.restoreTabs;
  restore.addEventListener("change", () => set({ restoreTabs: restore.checked, tabs: [] }));

  const rail = $("#setRail");
  rail.checked = settings.rail;
  rail.addEventListener("change", () => set({ rail: rail.checked }));

  const wisp = $("#setWisp");
  wisp.value = settings.wispUrl;
  $("#applyWisp").addEventListener("click", async () => {
    const v = wisp.value.trim();
    if (v && !/^wss?:\/\//.test(v)) return toast("Relay URL must start with wss://");
    set({ wispUrl: v });
    try { await setTransport(); toast("Transport reconnected"); }
    catch (err) { toast("Reconnect failed: " + err.message); }
  });

  const seg = $("#setTheme");
  const paintSeg = () => $$("button", seg).forEach((b) => b.classList.toggle("on", b.dataset.v === settings.theme));
  seg.addEventListener("click", (e) => { const v = e.target.closest("button")?.dataset.v; if (v) set({ theme: v }); });

  const sw = $("#setAccent");
  sw.innerHTML = ACCENTS.map((c) => `<button data-c="${c}" style="background:${c}" aria-label="Accent ${c}"></button>`).join("");
  const paintSw = () => $$("button", sw).forEach((b) => b.classList.toggle("on", b.dataset.c === settings.accent));
  sw.addEventListener("click", (e) => { const c = e.target.closest("button")?.dataset.c; if (c) set({ accent: c }); });

  $("#resetAll").addEventListener("click", async () => {
    if (!confirm("Reset tabs, settings, notes and unregister the service worker?")) return;
    resetAll();
    for (const r of (await navigator.serviceWorker?.getRegistrations()) || []) await r.unregister();
    location.reload();
  });

  paintSeg();
  paintSw();
  return () => { paintSeg(); paintSw(); rail.checked = settings.rail; };
}

// ───────── Connection pill ─────────
function setConn(state, detail) {
  const pill = $("#connPill");
  pill.dataset.state = state;
  $("#connText").textContent = state === "ok" ? "Relay connected" : state === "bad" ? "Relay offline · tap for details" : "Connecting…";
  pill.title = detail || "";
}
// No hover on iPad: tapping the pill shows why it's offline.
$("#connPill").addEventListener("click", () => {
  const detail = $("#connPill").title;
  if (detail) toast(detail, 8000);
});

// ───────── Boot ─────────
const repaint = initSettings();
applyTheme();
onChange(() => { applyTheme(); repaint(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

initRuntime(setConn);
initSidebar();
initAnnotate();
initGateway();
initBrowser();
initRecipes();
initPhoto();
initCut();

me = await initAccount();
initChat();
addEventListener("hashchange", route);
route();

addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "l") { e.preventDefault(); location.hash = "#/browser"; $("#address").focus(); }
  if (e.key === "Escape") { closeDrawer(); app.classList.remove("focus"); }
});
