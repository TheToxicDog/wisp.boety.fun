// Point & Note: tap any element tagged with data-ui to pin a change request
// to it. Notes are copied as a plain-text list you can paste to Claude.
import { notesStore } from "./store.js";
import { $, $$, toast, escapeHtml, closeDrawer } from "./ui.js";

// Controls that drive annotation itself are never targets.
const IGNORE = "#annotateToggle, #annotateBanner, #notes, #sheet, #toast";

let notes = notesStore.load();
let on = false;
let editing = null; // { id, el } for the open sheet
let hoverEl = null;


function targetFrom(e) {
  if (e.target.closest(IGNORE)) return null;
  return e.target.closest("[data-ui]");
}

function describe(el) {
  // Prefer a short, human name: aria-label, a heading inside, or the first line of text.
  const heading = el.querySelector("h1, h2, h3")?.textContent;
  const firstLine = (el.innerText || "").trim().split("\n")[0];
  const text = (el.getAttribute("aria-label") || heading || firstLine || el.querySelector("input")?.placeholder || "").trim().replace(/\s+/g, " ");
  return text.length > 48 ? text.slice(0, 47) + "…" : text;
}

function save() {
  notesStore.save(notes);
  renderList();
  renderPins();
}

function openSheet(el, note) {
  const id = el ? el.dataset.ui : note.ui;
  editing = { note, el };
  $$(".ui-pick").forEach((n) => n.classList.remove("ui-pick"));
  el?.classList.add("ui-pick");
  $("#sheetTarget").textContent = id;
  $("#sheetText").value = note?.text || "";
  $("#sheetDelete").hidden = !note;
  $("#sheet").hidden = false;
  setTimeout(() => $("#sheetText").focus(), 50);
}

function closeSheet() {
  $("#sheet").hidden = true;
  $$(".ui-pick").forEach((n) => n.classList.remove("ui-pick"));
  editing = null;
}

function onPick(e) {
  if (!on) return;
  const el = targetFrom(e);
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  openSheet(el, notes.find((n) => n.ui === el.dataset.ui));
}

function onHover(e) {
  if (!on || e.pointerType === "touch") return;
  const el = targetFrom(e);
  if (el === hoverEl) return;
  hoverEl?.classList.remove("ui-hover");
  hoverEl = el;
  el?.classList.add("ui-hover");
}

export function setAnnotating(value) {
  on = value;
  document.body.classList.toggle("annotating", on);
  $("#annotateToggle").setAttribute("aria-pressed", on);
  $("#annotateBanner").hidden = !on;
  if (!on) { hoverEl?.classList.remove("ui-hover"); hoverEl = null; }
  if (on) closeDrawer();
  renderPins();
}

// ───────── Notes drawer ─────────
function renderList() {
  const count = $("#noteCount");
  count.textContent = notes.length;
  count.hidden = !notes.length;
  $("#noteList").innerHTML = notes.length
    ? notes.map((n, i) => `
      <li data-i="${i}">
        <span class="n">${i + 1}</span>
        <div class="body"><code>${escapeHtml(n.ui)}${n.label ? " · " + escapeHtml(n.label) : ""}</code>${escapeHtml(n.text)}</div>
      </li>`).join("")
    : `<li class="empty-note">No notes yet. Turn on Point &amp; Note and tap something.</li>`;
}

function renderPins() {
  $$(".pin").forEach((p) => p.remove());
  if (!on && !$("#notes").classList.contains("open")) return;
  notes.forEach((n, i) => {
    const el = document.querySelector(`[data-ui="${CSS.escape(n.ui)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const pin = document.createElement("div");
    pin.className = "pin";
    pin.textContent = i + 1;
    pin.style.left = Math.min(innerWidth - 14, r.right - 10) + "px";
    pin.style.top = Math.max(14, r.top + 10) + "px";
    document.body.appendChild(pin);
  });
}

export function toggleNotes(force) {
  const open = $("#notes").classList.toggle("open", force);
  renderPins();
  return open;
}

function exportText() {
  const view = location.hash.replace("#/", "") || "browser";
  return [
    `Wisp UI change notes — ${location.host} (current view: ${view})`,
    "",
    ...notes.map((n, i) => `${i + 1}. [${n.ui}]${n.label ? ` "${n.label}"` : ""} — ${n.text}`),
  ].join("\n");
}

async function copy() {
  if (!notes.length) return toast("Nothing to copy yet");
  const text = exportText();
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${notes.length} note${notes.length > 1 ? "s" : ""}`);
  } catch {
    // Clipboard API can be blocked; fall back to a selectable textarea.
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Copied");
  }
}

export function initAnnotate() {
  // Capture phase so annotation wins over the element's own handler.
  document.addEventListener("click", onPick, true);
  document.addEventListener("submit", (e) => { if (on && !e.target.closest(IGNORE)) e.preventDefault(); }, true);
  document.addEventListener("pointermove", onHover, true);

  $("#annotateToggle").addEventListener("click", () => {
    setAnnotating(!on);
    if (on) toast("Tap any part of the interface");
  });
  $("#annotateDone").addEventListener("click", () => { setAnnotating(false); toggleNotes(true); });
  $("#closeNotes").addEventListener("click", () => toggleNotes(false));
  $("#copyNotes").addEventListener("click", copy);
  $("#clearNotes").addEventListener("click", () => {
    if (!notes.length || !confirm("Delete all notes?")) return;
    notes = [];
    save();
  });
  $("#noteList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    const note = notes[Number(li.dataset.i)];
    openSheet(document.querySelector(`[data-ui="${CSS.escape(note.ui)}"]`), note);
  });

  $("#sheetForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#sheetText").value.trim();
    if (!text) return closeSheet();
    if (editing.note) editing.note.text = text;
    else notes.push({ ui: editing.el.dataset.ui, label: describe(editing.el), text, at: Date.now() });
    save();
    closeSheet();
    toast("Note saved");
  });
  $("#sheetCancel").addEventListener("click", closeSheet);
  $("#sheetDelete").addEventListener("click", () => {
    notes = notes.filter((n) => n !== editing.note);
    save();
    closeSheet();
  });
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });

  addEventListener("resize", renderPins);
  addEventListener("hashchange", () => requestAnimationFrame(renderPins));
  renderList();
}
