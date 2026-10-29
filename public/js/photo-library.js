// Photos: the Library module — grid, filters, ratings/flags/labels,
// collections, keywords, metadata and Quick Develop.
import { h, svgIcon, segmented, selectBox } from "./photo-ui.js";
import { fmtShutter } from "./photo-exif.js";
import { BUILTIN_PRESETS, WB_PRESETS_RAW } from "./photo-params.js";

export const LABEL_COLORS = { red: "#e5484d", yellow: "#e9c63b", green: "#46b04a", blue: "#3f74e0", purple: "#8a56d6" };
const LABEL_KEYS = { 6: "red", 7: "yellow", 8: "green", 9: "blue" };

export class Library {
  constructor(app) {
    this.app = app;
    this.filter = { text: "", rating: 0, ratingOp: ">=", flag: "all", label: "", kind: "all", edited: false, source: "all" };
    this.sort = "captured";
    this.sortDir = 1;
    this.size = 170;
    this.build();
  }

  build() {
    const f = this.filter;
    const search = h("input", { class: "ph-search", type: "search", placeholder: "Search names, keywords, captions", oninput: (e) => { f.text = e.target.value.toLowerCase(); this.app.refreshList(); } });
    const rating = selectBox([["0", "Any rating"], ["1", "★ and up"], ["2", "★★ and up"], ["3", "★★★ and up"], ["4", "★★★★ and up"], ["5", "★★★★★"], ["-1", "Unrated"]], "0", (v) => { f.rating = +v; this.app.refreshList(); });
    const flag = selectBox([["all", "Any flag"], ["pick", "Picked"], ["none", "Unflagged"], ["reject", "Rejected"], ["notreject", "Not rejected"]], "all", (v) => { f.flag = v; this.app.refreshList(); });
    const label = selectBox([["", "Any label"], ...Object.keys(LABEL_COLORS).map((k) => [k, k[0].toUpperCase() + k.slice(1)]), ["none", "No label"]], "", (v) => { f.label = v; this.app.refreshList(); });
    const kind = selectBox([["all", "All files"], ["raw", "Raw"], ["image", "JPEG / PNG / other"], ["edited", "Edited"], ["virtual", "Virtual copies"]], "all", (v) => { f.kind = v; this.app.refreshList(); });
    const sort = selectBox([["captured", "Capture time"], ["added", "Import time"], ["name", "File name"], ["rating", "Rating"], ["edited", "Edit time"]], this.sort, (v) => { this.sort = v; this.app.refreshList(); });
    const dir = h("button", { class: "icon-btn sm", type: "button", title: "Reverse sort", onclick: () => { this.sortDir *= -1; this.app.refreshList(); } }, svgIcon('<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>', 18));
    const size = h("input", { type: "range", min: 90, max: 320, value: this.size, class: "ph-size", "aria-label": "Thumbnail size", oninput: (e) => { this.size = +e.target.value; this.grid.style.setProperty("--cell", this.size + "px"); } });
    this.countEl = h("span", { class: "ph-count muted small" });
    this.toolbar = h("div", { class: "ph-filter" }, search, rating.el, flag.el, label.el, kind.el, h("span", { class: "ph-sep" }), sort.el, dir, size, this.countEl);
    this.grid = h("div", { class: "ph-grid", tabindex: "0", style: { "--cell": this.size + "px" } });
    this.empty = h("div", { class: "ph-empty" },
      svgIcon('<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M21 15.5l-5-5-8.5 8.5"/>', 48),
      h("h3", {}, "Import photos to start"),
      h("p", { class: "muted" }, "JPEG, PNG, WebP, HEIC (Safari) and camera raw files — CR2, NEF, ARW, DNG, RAF, ORF, RW2, PEF and more. Photos stay in this browser; edits never change the originals."),
      h("button", { class: "btn primary", type: "button", onclick: () => this.app.pickFiles() }, "Import photos"));
    this.main = h("div", { class: "ph-lib" }, this.toolbar, this.grid, this.empty);
    this.grid.addEventListener("click", (e) => this.cellClick(e));
    this.grid.addEventListener("dblclick", (e) => { const id = e.target.closest(".ph-cell")?.dataset.id; if (id) this.app.openDevelop(id); });

    // Left: catalog + collections
    this.catalogList = h("div", { class: "pd-list" });
    this.collList = h("div", { class: "pd-list" });
    this.storage = h("div", { class: "muted small ph-storage" });
    this.left = h("div", { class: "ph-scroll ph-libleft" },
      h("section", { class: "ps-panel open" }, h("div", { class: "ps-panel-head static" }, h("span", {}, "Catalog")), h("div", { class: "ps-panel-body" }, this.catalogList)),
      h("section", { class: "ps-panel open" }, h("div", { class: "ps-panel-head static" }, h("span", {}, "Collections"),
        h("span", { class: "ps-reset", role: "button", onclick: () => this.newCollection() }, "+ New")), h("div", { class: "ps-panel-body" }, this.collList)),
      this.storage);

    // Right: quick develop, keywords, metadata
    this.quick = h("div", {});
    this.keywords = h("div", {});
    this.meta = h("div", { class: "ph-meta" });
    const sec = (title, body, open = true) => {
      const head = h("button", { class: "ps-panel-head", type: "button" }, h("span", {}, title), svgIcon('<path d="M6 9l6 6 6-6"/>', 16));
      const s = h("section", { class: "ps-panel" + (open ? " open" : "") }, head, h("div", { class: "ps-panel-body" }, body));
      head.addEventListener("click", () => s.classList.toggle("open"));
      return s;
    };
    this.right = h("div", { class: "ph-scroll ph-libright" }, sec("Quick Develop", this.quick), sec("Keywording", this.keywords), sec("Metadata", this.meta));
    this.buildQuick();
  }

  buildQuick() {
    const q = (key, label, steps) => h("div", { class: "ph-qrow" }, h("span", {}, label),
      ...steps.map(([d, t]) => h("button", { class: "btn xs", type: "button", title: `${label} ${d > 0 ? "+" : ""}${d}`, onclick: () => this.app.quickAdjust(key, d) }, t)));
    const preset = selectBox([["", "Apply preset…"], ...BUILTIN_PRESETS.map((p) => [p.name, p.group + ": " + p.name])], "", async (v) => {
      if (!v) return;
      await this.app.applyPresetToSelection(BUILTIN_PRESETS.find((p) => p.name === v));
      preset.set("");
    });
    this.userPresetSel = preset;
    const wb = selectBox([["", "White balance…"], ...WB_PRESETS_RAW.filter(([n]) => n !== "Custom").map(([n]) => [n, n])], "", (v) => { if (v) this.app.quickWB(v); wb.set(""); });
    const treat = segmented([["0", "Color"], ["1", "B&W"]], "", (v) => this.app.quickSet({ treatment: +v }, +v ? "Black & White" : "Color"));
    this.quick.append(preset.el, wb.el, h("div", { class: "pd-field" }, h("span", {}, "Treatment"), treat.el),
      q("exposure", "Exposure", [[-1, "◀◀"], [-0.33, "◀"], [0.33, "▶"], [1, "▶▶"]]),
      q("contrast", "Contrast", [[-20, "◀◀"], [-5, "◀"], [5, "▶"], [20, "▶▶"]]),
      q("highlights", "Highlights", [[-20, "◀◀"], [-5, "◀"], [5, "▶"], [20, "▶▶"]]),
      q("shadows", "Shadows", [[-20, "◀◀"], [-5, "◀"], [5, "▶"], [20, "▶▶"]]),
      q("whites", "Whites", [[-20, "◀◀"], [-5, "◀"], [5, "▶"], [20, "▶▶"]]),
      q("blacks", "Blacks", [[-20, "◀◀"], [-5, "◀"], [5, "▶"], [20, "▶▶"]]),
      q("clarity", "Clarity", [[-20, "◀◀"], [-5, "◀"], [5, "▶"], [20, "▶▶"]]),
      q("vibrance", "Vibrance", [[-20, "◀◀"], [-5, "◀"], [5, "▶"], [20, "▶▶"]]),
      h("div", { class: "pd-row" },
        h("button", { class: "btn sm", type: "button", onclick: () => this.app.syncSettings() }, "Sync settings…"),
        h("button", { class: "btn sm ghost", type: "button", onclick: () => this.app.resetSelection() }, "Reset all")));
  }

  // ───────── Grid ─────────
  render(list) {
    const app = this.app;
    this.empty.hidden = app.photos.length > 0;
    this.grid.hidden = app.photos.length === 0;
    this.countEl.textContent = `${list.length} of ${app.photos.length}`;
    const existing = new Map([...this.grid.children].map((c) => [c.dataset.id, c]));
    const cells = list.map((p) => {
      const c = existing.get(p.id) || h("div", { class: "ph-cell", "data-id": p.id, draggable: "true" });
      this.paintCell(c, p);
      return c;
    });
    this.grid.replaceChildren(...cells);
    this.paintSide();
  }

  paintCell(c, p) {
    const app = this.app;
    const url = app.thumbURL(p);
    const stars = p.rating ? "★".repeat(p.rating) : "";
    c.className = "ph-cell" + (app.selection.has(p.id) ? " sel" : "") + (p.id === app.currentId ? " cur" : "") + (p.flag === -1 ? " rejected" : "");
    c.innerHTML = "";
    c.append(
      h("div", { class: "ph-thumb" }, url ? h("img", { src: url, alt: "", loading: "lazy", decoding: "async" }) : h("div", { class: "ph-noimg" }, p.kind === "raw" ? "RAW" : "…")),
      h("div", { class: "ph-cap" },
        p.flag === 1 ? h("span", { class: "ph-flag pick", title: "Picked" }, "⚑") : p.flag === -1 ? h("span", { class: "ph-flag rej", title: "Rejected" }, "⚑") : null,
        h("span", { class: "ph-stars" }, stars),
        p.label ? h("span", { class: "ph-label", style: { background: LABEL_COLORS[p.label] } }) : null,
        h("span", { class: "ph-badges" }, p.kind === "raw" ? h("em", {}, "RAW") : null, p.edited ? h("em", { title: "Edited" }, "±") : null, p.virtual ? h("em", { title: "Virtual copy" }, "VC") : null)),
      h("div", { class: "ph-name", title: p.name }, p.name + (p.copyName ? ` (${p.copyName})` : "")));
    c.ondragstart = (e) => {
      if (!app.selection.has(p.id)) { app.select(p.id, false); }
      e.dataTransfer.setData("text/x-photo-ids", JSON.stringify([...app.selection]));
    };
  }

  cellClick(e) {
    const cell = e.target.closest(".ph-cell");
    const app = this.app;
    if (!cell) { app.selection.clear(); app.refreshSelection(); return; }
    const id = cell.dataset.id;
    if (e.shiftKey && app.currentId) {
      const ids = app.list.map((p) => p.id);
      const a = ids.indexOf(app.currentId), b = ids.indexOf(id);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) app.selection.add(ids[i]);
      app.refreshSelection();
    } else app.select(id, e.metaKey || e.ctrlKey);
  }

  paintSide() {
    this.paintCatalog();
    this.paintMeta();
    this.paintKeywords();
  }

  async paintCatalog() {
    const app = this.app;
    const f = this.filter;
    const n = (fn) => app.photos.filter(fn).length;
    const item = (key, label, count) => {
      const b = h("button", { type: "button", class: "pd-item" + (f.source === key ? " on" : "") }, h("span", { class: "pd-mname" }, label), h("span", { class: "muted small" }, String(count)));
      b.addEventListener("click", () => { f.source = key; app.refreshList(); });
      return b;
    };
    this.catalogList.replaceChildren(
      item("all", "All Photographs", app.photos.length),
      item("last", "Previous Import", n((p) => p.batch === app.lastBatch)),
      item("picks", "Picks", n((p) => p.flag === 1)),
      item("edited", "Edited", n((p) => p.edited)),
    );
    const colls = app.collections;
    this.collList.replaceChildren(...(colls.length ? colls.map((c) => {
      const del = h("span", { class: "pd-x", role: "button", title: "Delete collection" }, "×");
      const add = h("span", { class: "pd-x", role: "button", title: "Add selected photos" }, "+");
      const b = h("button", { type: "button", class: "pd-item" + (f.source === "c:" + c.id ? " on" : "") },
        svgIcon('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M7 6V4h10v2"/>', 16),
        h("span", { class: "pd-mname" }, c.name), h("span", { class: "muted small" }, String(n((p) => p.collections?.includes(c.id)))), add, del);
      b.addEventListener("click", (e) => {
        if (e.target === del) return app.deleteCollection(c.id);
        if (e.target === add) return app.addToCollection(c.id, [...app.selection]);
        f.source = "c:" + c.id; app.refreshList();
      });
      b.addEventListener("dragover", (e) => { e.preventDefault(); b.classList.add("drop"); });
      b.addEventListener("dragleave", () => b.classList.remove("drop"));
      b.addEventListener("drop", (e) => {
        e.preventDefault(); b.classList.remove("drop");
        try { app.addToCollection(c.id, JSON.parse(e.dataTransfer.getData("text/x-photo-ids"))); } catch { /* not photos */ }
      });
      return b;
    }) : [h("p", { class: "pd-hint" }, "Group photos into collections. Drag thumbnails onto a collection to add them.")]));
    const est = await app.storageEstimate();
    if (est?.usage) this.storage.textContent = `Using ${(est.usage / 1e9).toFixed(2)} GB of ${(est.quota / 1e9).toFixed(1)} GB browser storage`;
  }

  async newCollection() {
    const name = prompt("Collection name");
    if (name) await this.app.createCollection(name.trim());
  }

  paintKeywords() {
    const app = this.app;
    const sel = app.selected();
    if (!sel.length) { this.keywords.replaceChildren(h("p", { class: "pd-hint" }, "Select photos to tag them.")); return; }
    const all = new Map();
    for (const p of sel) for (const k of p.keywords || []) all.set(k, (all.get(k) || 0) + 1);
    const input = h("input", { class: "ph-kw-in", type: "text", placeholder: "Add keywords, comma separated", enterkeyhint: "done" });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const kws = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (kws.length) app.editKeywords(kws, []);
      input.value = "";
    });
    const chips = [...all.entries()].sort().map(([k, n]) => {
      const x = h("button", { type: "button", class: "ph-chip" + (n < sel.length ? " partial" : ""), title: "Remove" }, k, " ×");
      x.addEventListener("click", () => app.editKeywords([], [k]));
      return x;
    });
    this.keywords.replaceChildren(input, h("div", { class: "ph-chips" }, chips));
  }

  paintMeta() {
    const app = this.app;
    const sel = app.selected();
    const p = sel.length === 1 ? sel[0] : app.photos.find((x) => x.id === app.currentId);
    if (!p) { this.meta.replaceChildren(h("p", { class: "pd-hint" }, "No photo selected.")); return; }
    const m = p.exif || {};
    const row = (k, v) => (v || v === 0 ? h("div", { class: "ph-mrow" }, h("span", {}, k), h("b", {}, String(v))) : null);
    const stars = h("div", { class: "ph-rate" }, [1, 2, 3, 4, 5].map((n) => {
      const b = h("button", { type: "button", class: n <= (p.rating || 0) ? "on" : "", "aria-label": n + " stars" }, "★");
      b.addEventListener("click", () => app.setRating(n === p.rating ? 0 : n));
      return b;
    }));
    const labels = h("div", { class: "ph-labels" }, Object.entries(LABEL_COLORS).map(([k, c]) => {
      const b = h("button", { type: "button", class: p.label === k ? "on" : "", style: { background: c }, title: k, "aria-label": k + " label" });
      b.addEventListener("click", () => app.setLabel(p.label === k ? "" : k));
      return b;
    }));
    const flagSel = segmented([["1", "Pick"], ["0", "None"], ["-1", "Reject"]], String(p.flag || 0), (v) => app.setFlag(+v));
    const title = h("input", { type: "text", class: "ph-in", value: p.title || "", placeholder: "Title" });
    title.addEventListener("change", () => app.updateMeta({ title: title.value }));
    const caption = h("textarea", { class: "ph-in", rows: 2, placeholder: "Caption" }, p.caption || "");
    caption.addEventListener("change", () => app.updateMeta({ caption: caption.value }));
    const dims = p.info ? `${p.info.w} × ${p.info.h}` : m.pixelWidth ? `${m.pixelWidth} × ${m.pixelHeight}` : "";
    this.meta.replaceChildren(
      row("File", p.name + (p.copyName ? ` (${p.copyName})` : "")),
      row("Size", p.size ? (p.size / 1e6).toFixed(1) + " MB" : ""),
      row("Dimensions", dims),
      h("div", { class: "ph-mrow" }, h("span", {}, "Rating"), stars),
      h("div", { class: "ph-mrow" }, h("span", {}, "Flag"), flagSel.el),
      h("div", { class: "ph-mrow" }, h("span", {}, "Label"), labels),
      title, caption,
      row("Captured", p.captured ? new Date(p.captured).toLocaleString() : ""),
      row("Camera", [m.make, m.model].filter(Boolean).join(" ") || [p.info?.make, p.info?.model].filter(Boolean).join(" ")),
      row("Lens", m.lens),
      row("Exposure", [fmtShutter(m.exposureTime), m.fNumber && "f/" + (+m.fNumber.toFixed(1))].filter(Boolean).join(" at ")),
      row("ISO", m.iso),
      row("Focal length", m.focalLength && `${Math.round(m.focalLength)} mm` + (m.focal35 ? ` (${m.focal35} mm eq.)` : "")),
      row("Exposure bias", m.exposureBias ? `${m.exposureBias > 0 ? "+" : ""}${(+m.exposureBias).toFixed(1)} EV` : ""),
      row("Flash", m.flash != null ? (m.flash & 1 ? "Fired" : "Did not fire") : ""),
      row("Artist", m.artist), row("Copyright", m.copyright), row("Software", m.software),
      m.gps ? h("div", { class: "ph-mrow" }, h("span", {}, "GPS"), h("a", { href: `https://www.openstreetmap.org/?mlat=${m.gps.lat}&mlon=${m.gps.lon}#map=15/${m.gps.lat}/${m.gps.lon}`, target: "_blank", rel: "noopener noreferrer" }, `${m.gps.lat.toFixed(5)}, ${m.gps.lon.toFixed(5)}`)) : null,
      row("Imported", p.added ? new Date(p.added).toLocaleString() : ""),
    );
  }

  key(e) {
    const app = this.app;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "a") { app.selection = new Set(app.list.map((p) => p.id)); app.refreshSelection(); return true; }
    if (e.metaKey || e.ctrlKey) return false;
    if (k === "ArrowRight" || k === "ArrowLeft" || k === "ArrowDown" || k === "ArrowUp") {
      const cols = Math.max(1, Math.floor(this.grid.clientWidth / (this.size + 12)));
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[k];
      app.step(step, e.shiftKey);
      return true;
    }
    if (k === "Enter" && app.currentId) { app.openDevelop(app.currentId); return true; }
    if ((k === "Delete" || k === "Backspace") && app.selection.size) { app.removeSelected(); return true; }
    if (LABEL_KEYS[k]) { app.setLabel(LABEL_KEYS[k], true); return true; }
    return false;
  }
}
