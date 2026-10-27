// Tiny persisted store. Everything is per-device (localStorage) and every
// access is guarded so private mode / blocked storage never breaks the UI.
const KEY = "wisp.settings.v1";

export const defaults = {
  search: "https://duckduckgo.com/?q=%s",
  restoreTabs: true,
  wispUrl: "",
  theme: "auto",
  accent: "#5b8cff",
  rail: false,
  quickLinks: [
    { title: "Wikipedia", url: "https://en.wikipedia.org" },
    { title: "YouTube", url: "https://www.youtube.com" },
    { title: "Reddit", url: "https://www.reddit.com" },
    { title: "GitHub", url: "https://github.com" },
    { title: "Hacker News", url: "https://news.ycombinator.com" },
    { title: "DuckDuckGo", url: "https://duckduckgo.com" },
  ],
  tabs: [],
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const listeners = new Set();
export const settings = { ...defaults, ...read(KEY, {}) };

export function set(patch) {
  Object.assign(settings, patch);
  write(KEY, settings);
  listeners.forEach((fn) => fn(patch));
}
export function onChange(fn) { listeners.add(fn); }

export const notesStore = {
  load: () => read("wisp.notes.v1", []),
  save: (notes) => write("wisp.notes.v1", notes),
};

export function wispUrl() {
  if (settings.wispUrl) return settings.wispUrl;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
}

export function resetAll() {
  try { localStorage.clear(); } catch {}
}
