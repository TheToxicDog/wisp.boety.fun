// Shared DOM helpers.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function openDrawer() { $("#app").classList.add("drawer-open"); $("#scrim").hidden = false; }
export function closeDrawer() { $("#app").classList.remove("drawer-open"); $("#scrim").hidden = true; }

let toastTimer;
export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

export function icon(path) {
  return `<svg viewBox="0 0 24 24">${path}</svg>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Stable pastel colour for a string, used for quick-link and tab tiles.
export function hue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 52%)`;
}
