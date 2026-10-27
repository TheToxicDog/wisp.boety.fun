// Isolated browser: tabs of Scramjet frames whose traffic flows
// SW → bare-mux → epoxy (WASM TLS) → Wisp WebSocket relay.
import { settings, set, wispUrl } from "./store.js";
import { SW_URL, SW_SCOPE } from "./config.js";
import { $, toast, escapeHtml, hue, icon } from "./ui.js";

const X = icon('<path d="M6 6l12 12M18 6L6 18"/>');
const PLUS = icon('<path d="M12 5v14M5 12h14"/>');

let scramjet;
let connection;
let ready;
const tabs = [];
let active = null;
let nextId = 1;

// navigator.serviceWorker.ready never settles here: this page sits outside
// the /service/ scope. Wait on the registration's own worker instead.
function activated(reg) {
  const sw = reg.installing || reg.waiting || reg.active;
  if (sw.state === "activated") return Promise.resolve(reg);
  return new Promise((resolve, reject) => {
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") resolve(reg);
      if (sw.state === "redundant") reject(new Error("Service worker failed to install"));
    });
  });
}

export function initRuntime(onStatus) {
  ready = (async () => {
    if (!("serviceWorker" in navigator)) throw new Error("Service workers are unavailable in this browser");
    const { ScramjetController } = window.$scramjetLoadController();
    scramjet = new ScramjetController({
      prefix: SW_SCOPE,
      files: {
        wasm: "/scram/scramjet.wasm.wasm",
        all: "/scram/scramjet.all.js",
        sync: "/scram/scramjet.sync.js",
      },
    });
    await scramjet.init();
    // Drop workers left at other scopes by earlier versions of this site.
    for (const r of await navigator.serviceWorker.getRegistrations()) {
      if (r.scope !== location.origin + SW_SCOPE) await r.unregister();
    }
    await activated(await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }));
    connection = new window.BareMux.BareMuxConnection("/baremux/worker.js");
    await setTransport();
  })();
  ready.then(() => onStatus("ok"), (err) => { console.error(err); onStatus("bad", err.message); });
  return ready;
}

export async function setTransport() {
  await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl() }]);
}

// ───────── URL handling ─────────
function toUrl(input) {
  const q = input.trim();
  if (!q) return null;
  if (/^https?:\/\//i.test(q)) return q;
  if (/^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(q) || /^localhost(:\d+)?/.test(q)) return "https://" + q;
  return settings.search.replace("%s", encodeURIComponent(q));
}
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

// ───────── Tabs ─────────
function persist() {
  if (!settings.restoreTabs) return;
  set({ tabs: tabs.map((t) => ({ url: t.url, title: t.title })) });
}

export function newTab(url, title, lazy = false) {
  const tab = { id: nextId++, url: url || "", title: title || "New tab", frame: null };
  tabs.push(tab);
  if (lazy) return tab;
  select(tab);
  if (!url) $("#ntpInput").focus({ preventScroll: true });
  persist();
  return tab;
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  tab.frame?.frame.remove();
  tabs.splice(i, 1);
  if (!tabs.length) newTab();
  else if (active === tab) select(tabs[Math.max(0, i - 1)]);
  render();
  persist();
}

function select(tab) {
  active = tab;
  for (const t of tabs) if (t.frame) t.frame.frame.hidden = t !== tab;
  $("#ntp").hidden = !!tab.url;
  $("#address").value = tab.url;
  render();
  // New and restored tabs load when first shown.
  if (tab.url && !tab.frame && !tab.starting) navigate(tab.url, tab);
}

function frameFor(tab) {
  if (tab.frame) return tab.frame;
  const f = scramjet.createFrame();
  f.frame.setAttribute("data-ui", "browser.viewport.page");
  f.frame.setAttribute("allow", "fullscreen; clipboard-write; autoplay");
  f.frame.hidden = tab !== active;
  f.addEventListener("urlchange", (e) => {
    tab.url = e.url;
    tab.title = hostOf(e.url);
    if (active === tab) $("#address").value = e.url;
    render();
    persist();
  });
  f.frame.addEventListener("load", () => {
    loading(false);
    try {
      const t = f.frame.contentDocument?.title;
      if (t) { tab.title = t; render(); persist(); }
    } catch {}
  });
  $("#viewport").appendChild(f.frame);
  tab.frame = f;
  return f;
}

export async function navigate(input, tab = active) {
  const url = toUrl(input);
  if (!url) return;
  tab.url = url;
  tab.title = hostOf(url);
  tab.starting = true;
  if (tab === active) {
    $("#ntp").hidden = true;
    $("#address").value = url;
    loading(true);
  }
  render();
  try {
    await ready;
  } catch (err) {
    loading(false);
    return toast("Gateway unavailable: " + err.message);
  } finally {
    tab.starting = false;
  }
  if (!tabs.includes(tab)) return;
  frameFor(tab).go(url);
  persist();
}

// Renders the active page in a bare about:blank window instead of the tab frame.
function openBlank() {
  if (!active.url) return toast("Open a page first");
  const win = window.open("about:blank", "_blank");
  if (!win) return toast("Pop-up blocked — allow pop-ups for this site");
  const doc = win.document;
  doc.title = active.title;
  doc.body.style.margin = "0";
  const f = doc.createElement("iframe");
  f.src = new URL(scramjet.encodeUrl(active.url), location.origin).href;
  f.allow = "fullscreen; clipboard-write; autoplay";
  f.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
  doc.body.appendChild(f);
}

function loading(on) {
  const p = $("#progress");
  p.classList.toggle("on", on);
  p.classList.toggle("done", !on);
  if (!on) setTimeout(() => p.classList.remove("done"), 500);
}

function render() {
  $("#tabs").innerHTML = tabs.map((t) => `
    <div class="tab ${t === active ? "active" : ""}" role="tab" data-id="${t.id}" data-ui="browser.tabs.tab" aria-selected="${t === active}">
      <i class="fav" style="background:${t.url ? hue(hostOf(t.url)) : "var(--surface-2)"}"></i>
      <span class="ttl">${escapeHtml(t.title)}</span>
      <button class="x" data-close="${t.id}" aria-label="Close tab">${X}</button>
    </div>`).join("");
  $("#tabs .tab.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

// ───────── Quick links ─────────
let editing = false;
function renderLinks() {
  const grid = $("#quickGrid");
  grid.classList.toggle("editing", editing);
  grid.innerHTML = settings.quickLinks.map((l, i) => `
    <button class="quick" data-url="${escapeHtml(l.url)}" data-ui="browser.newtab.quicklink">
      <span class="ico" style="background:${hue(hostOf(l.url))}">${escapeHtml(l.title[0] || "?")}</span>
      <span class="lbl">${escapeHtml(l.title)}</span>
      <span class="rm" data-rm="${i}" aria-label="Remove">${X}</span>
    </button>`).join("") +
    `<button class="quick add" id="addLink" data-ui="browser.newtab.addlink"><span class="ico">${PLUS}</span><span class="lbl">Add</span></button>`;
}

// ───────── Wiring ─────────
export function initBrowser() {
  $("#omnibox").addEventListener("submit", (e) => { e.preventDefault(); navigate($("#address").value); $("#address").blur(); });
  $("#ntpSearch").addEventListener("submit", (e) => { e.preventDefault(); navigate($("#ntpInput").value); $("#ntpInput").value = ""; $("#ntpInput").blur(); });
  $("#clearAddr").addEventListener("click", () => { $("#address").value = ""; $("#address").focus(); });
  $("#address").addEventListener("focus", (e) => e.target.select());

  $("#newTabBtn").addEventListener("click", () => newTab());
  $("#tabs").addEventListener("click", (e) => {
    const el = e.target.closest(".tab");
    const tab = el && tabs.find((t) => t.id === Number(el.dataset.id));
    if (!tab) return;
    e.target.closest("[data-close]") ? closeTab(tab) : select(tab);
  });

  $("#backBtn").addEventListener("click", () => active.frame?.back());
  $("#fwdBtn").addEventListener("click", () => active.frame?.forward());
  $("#reloadBtn").addEventListener("click", () => { if (active.frame) { loading(true); active.frame.reload(); } });
  $("#homeBtn").addEventListener("click", () => {
    active.frame?.frame.remove();
    Object.assign(active, { frame: null, url: "", title: "New tab" });
    select(active);
    persist();
  });
  $("#blankBtn").addEventListener("click", openBlank);
  $("#fullBtn").addEventListener("click", () => {
    const on = document.getElementById("app").classList.toggle("focus");
    toast(on ? "Focus mode — tap again to exit" : "Focus mode off");
  });

  $("#editLinks").addEventListener("click", (e) => {
    editing = !editing;
    e.target.textContent = editing ? "Done" : "Edit";
    renderLinks();
  });
  $("#quickGrid").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      set({ quickLinks: settings.quickLinks.filter((_, i) => i !== Number(rm.dataset.rm)) });
      return renderLinks();
    }
    if (e.target.closest("#addLink")) {
      const url = prompt("Link address", "https://");
      if (!url || url === "https://") return;
      const title = prompt("Name", hostOf(toUrl(url))) || hostOf(url);
      set({ quickLinks: [...settings.quickLinks, { title, url: toUrl(url) }] });
      return renderLinks();
    }
    const q = e.target.closest(".quick");
    if (q && !editing) navigate(q.dataset.url);
  });

  renderLinks();
  const saved = settings.restoreTabs ? settings.tabs : [];
  if (saved.length) {
    saved.forEach((t) => newTab(t.url, t.title, true));
    select(tabs[tabs.length - 1]);
  } else newTab();
}
