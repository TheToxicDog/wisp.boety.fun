// Picks up new deploys without the user clearing anything. The page carries
// its asset version (a meta tag from lib/pages.js); we compare it with
// /api/version when the app comes back to the foreground and every few
// minutes. Coming back after a while: reload straight away. Otherwise: offer
// a Reload button, so nobody loses what they're in the middle of.

const CHECK_EVERY = 5 * 60 * 1000;
const AUTO_AFTER_HIDDEN = 30 * 1000;
const current = document.querySelector('meta[name="app-version"]')?.content;
let hiddenAt = 0;
let shown = false;

async function latest() {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    return r.ok ? (await r.json()).assets : null;
  } catch { return null; }
}

function busy() {
  // Don't yank the page out from under a call.
  return !!document.querySelector("#call:not([hidden])");
}

function offer() {
  if (shown) return;
  shown = true;
  const bar = document.createElement("div");
  bar.className = "update-bar";
  bar.setAttribute("role", "status");
  bar.innerHTML = "<span>A new version is ready.</span>";
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "Reload";
  b.addEventListener("click", () => location.reload());
  bar.append(b);
  document.body.append(bar);
}

async function check(resumed) {
  if (!current) return;
  const v = await latest();
  if (!v || v === current) return;
  if (resumed && !busy()) location.reload();
  else offer();
}

export function initUpdates() {
  if (!current) return;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    check(hiddenAt && Date.now() - hiddenAt > AUTO_AFTER_HIDDEN);
  });
  addEventListener("online", () => check(false));
  // iOS restores home-screen apps from memory without reloading them
  addEventListener("pageshow", (e) => { if (e.persisted) check(true); });
  setInterval(() => { if (!document.hidden) check(false); }, CHECK_EVERY);
}
