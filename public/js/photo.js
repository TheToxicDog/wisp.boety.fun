// Photos module: a raw photo editor and catalog in the browser. The develop
// engine is Rust compiled to WebAssembly (photo/ → public/photo/develop.wasm),
// running in a worker; this file is the app shell — Library/Develop switching,
// import, filmstrip, thumbnails, settings sync and keyboard shortcuts.
import { $ } from "./ui.js";
import { Engine } from "./photo-engine.js";
import * as db from "./photo-catalog.js";
import { readMeta, previewBlob, exifSegment, RAW_EXT } from "./photo-exif.js";
import { defaults, clone, serialize, GROUPS, PASTE_DEFAULT_OFF, pick, applyPartial, WB_PRESETS_RAW, WB_PRESETS_IMG } from "./photo-params.js";
import { h, svgIcon, segmented } from "./photo-ui.js";
import { Develop } from "./photo-develop.js";
import { Library } from "./photo-library.js";
import { exportDialog } from "./photo-export.js";

const THUMB = 420;
let app = null;

class PhotoApp {
  constructor(root) {
    this.root = root;
    this.engine = new Engine();
    this.groups = GROUPS;
    this.photos = [];
    this.list = [];
    this.selection = new Set();
    this.currentId = null;
    this.module = "library";
    this.thumbs = new Map(); // id → object URL
    this.collections = [];
    this.clipboard = null;
    this.lastSettings = null;
    this.thumbQueue = [];
    this.build();
  }

  // ───────── Layout ─────────
  build() {
    this.lib = new Library(this);
    this.dev = new Develop(this);
    this.modSel = segmented([["library", "Library"], ["develop", "Develop"]], "library", (v) => this.setModule(v), "ph-mods");
    this.fileInput = h("input", { type: "file", multiple: true, hidden: true, accept: "image/*,.dng,.cr2,.cr3,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.pef,.srw,.x3f,.3fr,.erf,.mrw,.mos,.kdc,.dcr,.iiq,.rwl" });
    this.fileInput.addEventListener("change", () => { this.importFiles([...this.fileInput.files]); this.fileInput.value = ""; });
    const tbtn = (icon, label, fn, cls = "") => h("button", { class: "btn sm " + cls, type: "button", onclick: fn, title: label }, svgIcon(icon, 18), h("span", { class: "ph-blabel" }, label));
    this.progress = h("div", { class: "ph-progress", hidden: true });
    this.flagBtns = h("div", { class: "ph-quickflags" });
    const top = h("header", { class: "ph-top" },
      h("button", { class: "icon-btn sm ph-toggle-left", type: "button", title: "Show left panel", onclick: () => this.togglePanel("left") }, svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', 18)),
      this.modSel.el,
      tbtn('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>', "Import", () => this.pickFiles(), "primary"),
      tbtn('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>', "Export", () => this.exportSelected()),
      tbtn('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>', "Virtual copy", () => this.virtualCopy()),
      this.progress,
      h("span", { class: "ph-spacer" }),
      this.flagBtns,
      h("button", { class: "icon-btn sm", type: "button", title: "Keyboard shortcuts", onclick: () => this.shortcuts() }, "?"),
      h("button", { class: "icon-btn sm ph-toggle-film", type: "button", title: "Show filmstrip", onclick: () => this.togglePanel("film") }, svgIcon('<rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 14v6M11 14v6M15 14v6"/>', 18)),
      h("button", { class: "icon-btn sm ph-toggle-right", type: "button", title: "Show right panel", onclick: () => this.togglePanel("right") }, svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>', 18)),
      this.fileInput);
    this.leftEl = h("aside", { class: "ph-left" });
    this.mainEl = h("div", { class: "ph-main" });
    this.rightEl = h("aside", { class: "ph-right" });
    this.film = h("div", { class: "ph-film" });
    this.filmWrap = h("footer", { class: "ph-filmwrap" }, this.film);
    this.drop = h("div", { class: "ph-drop", hidden: true }, "Drop photos to import");
    this.scrim = h("div", { class: "ph-scrim", onclick: () => this.root.classList.remove("show-left", "show-right") });
    this.root.append(top, h("div", { class: "ph-body" }, this.leftEl, this.mainEl, this.rightEl, this.scrim), this.filmWrap, this.drop);
    this.film.addEventListener("click", (e) => {
      const id = e.target.closest(".ph-fcell")?.dataset.id;
      if (!id) return;
      if (this.module === "develop") this.openDevelop(id);
      else this.select(id, e.metaKey || e.ctrlKey);
    });
    // Drag & drop import
    let depth = 0;
    this.root.addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { depth++; this.drop.hidden = false; } });
    this.root.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; this.drop.hidden = true; } });
    this.root.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    this.root.addEventListener("drop", (e) => {
      depth = 0; this.drop.hidden = true;
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      this.importFiles([...e.dataTransfer.files]);
    });
    this.setModule("library");
  }

  togglePanel(which) {
    const narrow = matchMedia("(max-width: 1100px)").matches;
    if (which === "film") { this.root.classList.toggle("no-film"); this.dev.redraw(true); return; }
    if (narrow) {
      const cls = "show-" + which;
      const on = !this.root.classList.contains(cls);
      this.root.classList.remove("show-left", "show-right");
      this.root.classList.toggle(cls, on);
    } else {
      this.root.classList.toggle("hide-" + which);
      setTimeout(() => this.dev.redraw(true), 220);
    }
  }

  setModule(m) {
    if (m === "develop") {
      const id = this.currentId || this.list[0]?.id;
      if (!id) { this.toast("Import a photo first"); this.modSel.set("library"); return; }
      if (this.module !== "develop" || this.dev.photo?.id !== id) { this.module = "develop"; this.openDevelop(id); return; }
    }
    if (this.module === "develop" && m !== "develop") { this.dev.close(); this.lastSettings = this.dev.s && clone(this.dev.s); }
    this.module = m;
    this.modSel.set(m);
    this.root.dataset.module = m;
    if (m === "library") {
      this.leftEl.replaceChildren(this.lib.left);
      this.mainEl.replaceChildren(this.lib.main);
      this.rightEl.replaceChildren(this.lib.right);
      this.refreshList();
    } else {
      this.leftEl.replaceChildren(this.dev.left);
      this.mainEl.replaceChildren(this.dev.center_);
      this.rightEl.replaceChildren(this.dev.right);
    }
    this.paintFilm();
    this.paintFlags();
  }

  async openDevelop(id) {
    const p = this.photos.find((x) => x.id === id);
    if (!p) return;
    if (this.dev.photo && this.dev.photo.id !== id) { this.dev.close(); this.lastSettings = this.dev.s && clone(this.dev.s); }
    this.currentId = id;
    if (!this.selection.has(id) || this.selection.size > 1) this.selection = new Set([id]);
    if (this.module !== "develop" || this.mainEl.firstChild !== this.dev.center_) {
      this.module = "develop";
      this.modSel.set("develop");
      this.root.dataset.module = "develop";
      this.leftEl.replaceChildren(this.dev.left);
      this.mainEl.replaceChildren(this.dev.center_);
      this.rightEl.replaceChildren(this.dev.right);
    }
    this.paintFilm();
    this.paintFlags();
    await this.dev.open(p);
  }

  // ───────── Catalog load ─────────
  async load() {
    this.photos = await db.allPhotos();
    this.collections = await db.getMeta("collections", []);
    this.lastBatch = await db.getMeta("lastBatch", null);
    await Promise.all(this.photos.map(async (p) => {
      const b = await db.getThumb(p.id);
      if (b) this.thumbs.set(p.id, URL.createObjectURL(b));
    }));
    this.refreshList();
    for (const p of this.photos) if (p.thumbStale) this.queueThumb(p);
  }

  refreshList() {
    const f = this.lib.filter;
    const text = f.text;
    let list = this.photos.filter((p) => {
      if (f.source === "last" && p.batch !== this.lastBatch) return false;
      if (f.source === "picks" && p.flag !== 1) return false;
      if (f.source === "edited" && !p.edited) return false;
      if (f.source.startsWith("c:") && !p.collections?.includes(f.source.slice(2))) return false;
      if (text && ![p.name, p.title, p.caption, ...(p.keywords || []), p.exif?.model, p.exif?.lens].some((s) => s && String(s).toLowerCase().includes(text))) return false;
      if (f.rating === -1 ? p.rating : (p.rating || 0) < f.rating) return false;
      if (f.flag === "pick" && p.flag !== 1) return false;
      if (f.flag === "reject" && p.flag !== -1) return false;
      if (f.flag === "none" && p.flag) return false;
      if (f.flag === "notreject" && p.flag === -1) return false;
      if (f.label === "none" ? p.label : f.label && p.label !== f.label) return false;
      if (f.kind === "raw" && p.kind !== "raw") return false;
      if (f.kind === "image" && p.kind === "raw") return false;
      if (f.kind === "edited" && !p.edited) return false;
      if (f.kind === "virtual" && !p.virtual) return false;
      return true;
    });
    const key = {
      captured: (p) => p.captured || p.added, added: (p) => p.added, name: (p) => p.name.toLowerCase() + (p.copyName || ""),
      rating: (p) => p.rating || 0, edited: (p) => p.editedAt || 0,
    }[this.lib.sort];
    const d = this.lib.sortDir;
    list.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * d || a.name.localeCompare(b.name); });
    this.list = list;
    if (this.module === "library") this.lib.render(list);
    this.paintFilm();
  }

  refreshSelection() {
    for (const c of this.lib.grid.children) {
      c.classList.toggle("sel", this.selection.has(c.dataset.id));
      c.classList.toggle("cur", c.dataset.id === this.currentId);
    }
    for (const c of this.film.children) {
      c.classList.toggle("sel", this.selection.has(c.dataset.id));
      c.classList.toggle("cur", c.dataset.id === this.currentId);
    }
    this.lib.paintSide();
    this.paintFlags();
  }

  select(id, toggle) {
    if (toggle) { if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id); }
    else this.selection = new Set([id]);
    this.currentId = id;
    this.refreshSelection();
    this.film.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.lib.grid.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }

  step(d, extend) {
    const ids = this.list.map((p) => p.id);
    if (!ids.length) return;
    let i = ids.indexOf(this.currentId);
    i = Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + d));
    if (this.module === "develop") return this.openDevelop(ids[i]);
    if (extend) { this.selection.add(ids[i]); this.currentId = ids[i]; this.refreshSelection(); }
    else this.select(ids[i]);
  }

  selected() { return this.photos.filter((p) => this.selection.has(p.id)); }

  paintFilm() {
    const cells = this.list.map((p) => {
      const url = this.thumbURL(p);
      return h("button", { type: "button", class: "ph-fcell" + (this.selection.has(p.id) ? " sel" : "") + (p.id === this.currentId ? " cur" : ""), "data-id": p.id, title: p.name },
        url ? h("img", { src: url, alt: "", loading: "lazy" }) : h("span", {}, p.kind === "raw" ? "RAW" : "…"),
        p.rating ? h("i", {}, "★".repeat(p.rating)) : null);
    });
    this.film.replaceChildren(...cells);
    this.film.querySelector(".cur")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  paintFlags() {
    const p = this.photos.find((x) => x.id === this.currentId);
    if (!p) { this.flagBtns.replaceChildren(); return; }
    const star = (n) => h("button", { type: "button", class: "ph-star" + (n <= (p.rating || 0) ? " on" : ""), onclick: () => this.setRating(n === p.rating ? 0 : n), "aria-label": `${n} star` }, "★");
    this.flagBtns.replaceChildren(
      h("button", { type: "button", class: "ph-fl" + (p.flag === 1 ? " on" : ""), title: "Pick (P)", onclick: () => this.setFlag(p.flag === 1 ? 0 : 1) }, "⚑"),
      h("button", { type: "button", class: "ph-fl rej" + (p.flag === -1 ? " on" : ""), title: "Reject (X)", onclick: () => this.setFlag(p.flag === -1 ? 0 : -1) }, "⚑"),
      ...[1, 2, 3, 4, 5].map(star));
  }

  thumbURL(p) { return this.thumbs.get(p.id) || null; }

  // ───────── Import ─────────
  pickFiles() { this.fileInput.click(); }

  showProgress(text, frac) {
    this.progress.hidden = text == null;
    if (text == null) return;
    this.progress.replaceChildren(h("span", {}, text), h("i", { style: { width: `${Math.round((frac || 0) * 100)}%` } }));
  }

  async importFiles(files) {
    files = files.filter((f) => f.type.startsWith("image/") || RAW_EXT.test(f.name));
    if (!files.length) { this.toast("No photos found in that selection"); return; }
    db.persist();
    const batch = db.uid();
    const existing = new Set(this.photos.map((p) => p.name + ":" + p.size));
    let added = 0, skipped = 0, failed = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      this.showProgress(`Importing ${i + 1} of ${files.length}`, i / files.length);
      if (existing.has(f.name + ":" + f.size)) { skipped++; continue; }
      try {
        const buf = await f.arrayBuffer();
        const meta = readMeta(buf);
        const kind = RAW_EXT.test(f.name) || /^image\/x-(canon|nikon|sony|adobe-dng|fuji|olympus|panasonic|pentax|samsung|sigma|hasselblad|kodak|leica|minolta|epson|phaseone)/.test(f.type) ? "raw" : "image";
        const fileId = db.uid();
        await db.putFile(fileId, f);
        const { app1, previews: _previews, ...exif } = meta;
        const p = {
          id: db.uid(), fileId, name: f.name, size: f.size, type: f.type, kind, batch,
          added: Date.now(), captured: meta.captured || f.lastModified || Date.now(), exif: { ...exif, hasApp1: !!app1 },
          rating: 0, flag: 0, label: "", keywords: [], collections: [], settings: null, history: [], snapshots: [],
        };
        const thumb = await this.importThumb(f, buf, meta, kind);
        if (thumb) { await db.putThumb(p.id, thumb); this.thumbs.set(p.id, URL.createObjectURL(thumb)); }
        else p.thumbStale = true;
        await db.putPhoto(p);
        this.photos.push(p);
        if (p.thumbStale) this.queueThumb(p);
        added++;
        if (added === 1 || added % 4 === 0) this.refreshList();
      } catch (err) {
        console.warn("import failed", f.name, err);
        failed++;
      }
    }
    this.lastBatch = batch;
    await db.setMeta("lastBatch", batch);
    this.showProgress(null);
    this.refreshList();
    this.toast([`Imported ${added}`, skipped && `${skipped} duplicate${skipped > 1 ? "s" : ""} skipped`, failed && `${failed} failed`].filter(Boolean).join(" · "));
  }

  /** Fast thumbnail from the file itself or a raw's embedded JPEG preview. */
  async importThumb(file, buf, meta, kind) {
    let src = kind === "raw" ? previewBlob(buf, meta) : file;
    if (!src) return null;
    try {
      const bmp = await createImageBitmap(src);
      // createImageBitmap honours a preview's own EXIF rotation; otherwise use the raw's.
      const rotate = kind === "raw" && !meta.previewOrientation ? meta.orientation || 1 : 1;
      const k = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * k), hh = Math.round(bmp.height * k);
      const swap = rotate >= 5;
      const c = document.createElement("canvas");
      c.width = swap ? hh : w; c.height = swap ? w : hh;
      const ctx = c.getContext("2d");
      const T = { 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, hh], 4: [1, 0, 0, -1, 0, hh], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, hh, 0], 7: [0, -1, -1, 0, hh, w], 8: [0, -1, 1, 0, 0, w] }[rotate];
      if (T) ctx.setTransform(...T);
      ctx.drawImage(bmp, 0, 0, w, hh);
      bmp.close?.();
      return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
    } catch { return null; }
  }

  queueThumb(p) {
    if (!this.thumbQueue.includes(p)) this.thumbQueue.push(p);
    if (!this.thumbBusy) this.pumpThumbs();
  }

  async pumpThumbs() {
    this.thumbBusy = true;
    while (this.thumbQueue.length) {
      const p = this.thumbQueue.shift();
      if (!this.photos.includes(p)) continue;
      try {
        const info = await this.ensureOpen(p);
        const s = await this.resolveSettings(p, info);
        await this.updateThumb(p, s, info, true);
        p.thumbStale = false;
        await db.putPhoto(p);
        if (this.dev.photo?.fileId !== p.fileId) this.engine.close(p.fileId);
      } catch (err) { console.warn("thumbnail failed", p.name, err); }
      await new Promise((r) => setTimeout(r, 30));
    }
    this.thumbBusy = false;
  }

  /** Render a library thumbnail from the photo's current settings. */
  async updateThumb(p, s, info, now) {
    if (!p) return;
    const rot = (s.orient | 0) & 1;
    const [wo, ho] = rot ? [info.h, info.w] : [info.w, info.h];
    const A = ((s.crop_r - s.crop_l) * wo) / ((s.crop_b - s.crop_t) * ho);
    const w = A >= 1 ? THUMB : Math.round(THUMB * A), hh = A >= 1 ? Math.round(THUMB / A) : THUMB;
    const r = await this.engine.render(p.fileId, serialize(s, { region: [0, 0, 1, 1] }), w, hh);
    const c = document.createElement("canvas");
    c.width = w; c.height = hh;
    c.getContext("2d").putImageData(new ImageData(r.rgba, w, hh), 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    if (!blob) return;
    await db.putThumb(p.id, blob);
    const old = this.thumbs.get(p.id);
    this.thumbs.set(p.id, URL.createObjectURL(blob));
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    const cell = this.lib.grid.querySelector(`[data-id="${p.id}"]`);
    if (cell) this.lib.paintCell(cell, p);
    const f = this.film.querySelector(`[data-id="${p.id}"] img`);
    if (f) f.src = this.thumbs.get(p.id);
  }

  // ───────── Engine access ─────────
  async ensureOpen(p, status) {
    if (this.engine.open.has(p.fileId) && p.info) return p.info;
    const blob = await db.getFile(p.fileId);
    if (!blob) throw new Error("The original file is missing from this browser's storage");
    const isJpegPng = /^image\/(jpeg|png)$/.test(blob.type) || /\.(jpe?g|png)$/i.test(p.name);
    let info;
    if (p.kind === "raw" || isJpegPng) {
      status?.(p.kind === "raw" ? "Decoding raw file…" : "Decoding…");
      const o = p.exif?.orientation > 1 ? p.exif.orientation : p.exif?.previewOrientation || 1;
      info = await this.engine.load(p.fileId, await blob.arrayBuffer(), o);
    } else {
      // Formats the engine doesn't parse (WebP, HEIC, AVIF, GIF, TIFF in Safari): let the browser decode.
      status?.("Decoding…");
      const bmp = await createImageBitmap(blob).catch(() => { throw new Error("This browser can't decode " + (blob.type || "this file type")); });
      const k = Math.min(1, Math.sqrt(16e6 / (bmp.width * bmp.height)));
      const w = Math.round(bmp.width * k), hh = Math.round(bmp.height * k);
      const c = document.createElement("canvas");
      c.width = w; c.height = hh;
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0, w, hh);
      const data = ctx.getImageData(0, 0, w, hh).data;
      info = await this.engine.loadRGBA(p.fileId, new Uint8Array(data.buffer), w, hh);
    }
    info = { ...info, asShotTemp: Math.round(info.asShotTemp), asShotTint: Math.round(info.asShotTint) };
    if (JSON.stringify(p.info) !== JSON.stringify(info)) {
      // A raw's embedded preview can differ from the raw itself (crop, rotation
      // baked in by camera software): replace that thumbnail with a real render.
      if (!p.info && p.kind === "raw" && !p.settings) setTimeout(() => this.queueThumb(p), 1500);
      p.info = info;
      db.putPhoto(p);
    }
    return info;
  }

  /** The photo's settings merged over defaults, with named white balances resolved. */
  async resolveSettings(p, info) {
    const s = { ...defaults(info), ...clone(p.settings || {}) };
    s.curve = { ...defaults(info).curve, ...(s.curve || {}) };
    const presets = info.isRaw ? WB_PRESETS_RAW : WB_PRESETS_IMG;
    const wb = s.wb || "As Shot";
    if (wb === "As Shot") { s.temp = info.isRaw ? info.asShotTemp : 0; s.tint = info.isRaw ? info.asShotTint : 0; }
    else if (wb === "Auto") {
      const [t, ti] = await this.engine.wbAuto(p.fileId);
      s.temp = Math.round(t); s.tint = Math.round(ti);
    } else {
      const pr = presets.find(([n]) => n === wb);
      if (pr?.[1]) [s.temp, s.tint] = pr[1];
    }
    return s;
  }

  async exifFor(p) {
    if (!p.exif?.hasApp1) return null;
    const blob = await db.getFile(p.fileId);
    const buf = await blob.arrayBuffer();
    return exifSegment(buf, readMeta(buf));
  }

  // ───────── Persistence ─────────
  savePhoto(p) {
    p.editedAt = Date.now();
    return db.putPhoto(p);
  }

  async storageEstimate() { return db.usage(); }

  // ───────── Ratings, flags, labels, metadata ─────────
  targets() {
    if (this.module === "develop") return this.photos.filter((p) => p.id === this.currentId);
    const sel = this.selected();
    return sel.length ? sel : this.photos.filter((p) => p.id === this.currentId);
  }

  async updateMany(fn) {
    const t = this.targets();
    for (const p of t) { fn(p); await db.putPhoto(p); }
    for (const p of t) {
      const cell = this.lib.grid.querySelector(`[data-id="${p.id}"]`);
      if (cell) this.lib.paintCell(cell, p);
    }
    this.lib.paintSide();
    this.paintFlags();
    return t;
  }

  setRating(n) { return this.updateMany((p) => { p.rating = n; }); }
  setFlag(f) { return this.updateMany((p) => { p.flag = f; }); }
  setLabel(l, toggle) { return this.updateMany((p) => { p.label = toggle && p.label === l ? "" : l; }); }
  updateMeta(fields) { return this.updateMany((p) => Object.assign(p, fields)); }
  editKeywords(add, remove) {
    return this.updateMany((p) => {
      const k = new Set(p.keywords || []);
      for (const a of add) k.add(a);
      for (const r of remove) k.delete(r);
      p.keywords = [...k].sort();
    });
  }

  async createCollection(name) {
    if (!name) return;
    const c = { id: db.uid(), name };
    this.collections = [...this.collections, c].sort((a, b) => a.name.localeCompare(b.name));
    await db.setMeta("collections", this.collections);
    if (this.selection.size) await this.addToCollection(c.id, [...this.selection]);
    else this.lib.paintCatalog();
  }

  async deleteCollection(id) {
    const c = this.collections.find((x) => x.id === id);
    if (!c || !confirm(`Delete the collection “${c.name}”? The photos stay in your catalog.`)) return;
    this.collections = this.collections.filter((x) => x.id !== id);
    await db.setMeta("collections", this.collections);
    for (const p of this.photos) if (p.collections?.includes(id)) { p.collections = p.collections.filter((x) => x !== id); await db.putPhoto(p); }
    if (this.lib.filter.source === "c:" + id) this.lib.filter.source = "all";
    this.refreshList();
  }

  async addToCollection(cid, ids) {
    let n = 0;
    for (const p of this.photos) {
      if (!ids.includes(p.id) || p.collections?.includes(cid)) continue;
      p.collections = [...(p.collections || []), cid];
      await db.putPhoto(p);
      n++;
    }
    this.toast(`Added ${n} photo${n === 1 ? "" : "s"} to the collection`);
    this.lib.paintCatalog();
  }

  async removeSelected() {
    const sel = this.selected();
    if (!sel.length || !confirm(`Remove ${sel.length} photo${sel.length > 1 ? "s" : ""} from the catalog? Originals stored in this browser are deleted too.`)) return;
    for (const p of sel) {
      await db.deletePhoto(p.id);
      await db.deleteThumb(p.id);
      this.photos = this.photos.filter((x) => x !== p);
      if (!this.photos.some((x) => x.fileId === p.fileId)) { await db.deleteFile(p.fileId); this.engine.close(p.fileId); }
      const u = this.thumbs.get(p.id);
      if (u) URL.revokeObjectURL(u);
      this.thumbs.delete(p.id);
    }
    this.selection.clear();
    this.currentId = null;
    this.refreshList();
  }

  async virtualCopy() {
    const src = this.photos.find((p) => p.id === this.currentId);
    if (!src) return;
    if (this.module === "develop") this.dev.flushSave();
    const n = this.photos.filter((p) => p.fileId === src.fileId).length;
    const p = { ...clone(src), id: db.uid(), virtual: true, copyName: `Copy ${n}`, added: Date.now(), snapshots: [], history: src.history?.slice(-1) || [] };
    await db.putPhoto(p);
    const thumb = await db.getThumb(src.id);
    if (thumb) { await db.putThumb(p.id, thumb); this.thumbs.set(p.id, URL.createObjectURL(thumb)); }
    this.photos.push(p);
    this.refreshList();
    this.toast("Virtual copy created");
    if (this.module === "develop") this.openDevelop(p.id); else this.select(p.id);
  }

  // ───────── Settings: copy / paste / sync / quick develop ─────────
  async groupDialog(title, withName, preselect) {
    return new Promise((resolve) => {
      const name = withName ? h("input", { class: "ph-in", type: "text", placeholder: "Preset name", required: true }) : null;
      const boxes = Object.keys(GROUPS).map((g) => {
        const on = preselect ? preselect.includes(g) : !PASTE_DEFAULT_OFF.has(g);
        return h("label", { class: "pd-check" }, h("input", { type: "checkbox", value: g, checked: on }), g);
      });
      const all = (v) => boxes.forEach((b) => { b.firstChild.checked = v; });
      const dlg = h("dialog", { class: "ph-dialog" },
        h("h3", {}, title), name,
        h("div", { class: "ph-checks" }, boxes),
        h("div", { class: "pd-row" },
          h("button", { class: "btn sm ghost", type: "button", onclick: () => all(true) }, "Check all"),
          h("button", { class: "btn sm ghost", type: "button", onclick: () => all(false) }, "Check none"),
          h("span", { class: "ph-spacer" }),
          h("button", { class: "btn", type: "button", onclick: () => { dlg.close(); resolve(null); } }, "Cancel"),
          h("button", { class: "btn primary", type: "button", onclick: () => {
            if (withName && !name.value.trim()) { name.focus(); return; }
            const groups = boxes.filter((b) => b.firstChild.checked).map((b) => b.firstChild.value);
            dlg.close();
            resolve({ name: name?.value.trim(), groups });
          } }, withName ? "Create" : "OK")));
      dlg.addEventListener("close", () => { dlg.remove(); resolve(null); });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  async copySettings() {
    const src = this.photos.find((p) => p.id === this.currentId);
    if (!src) return;
    const s = this.module === "develop" && this.dev.s ? this.dev.s : src.settings;
    if (!s) { this.toast("This photo has no edits yet"); return; }
    const r = await this.groupDialog("Copy Settings");
    if (!r) return;
    this.clipboard = pick(s, r.groups);
    this.toast("Settings copied");
  }

  async pasteSettings() {
    if (!this.clipboard) { this.toast("Copy settings first (⌘⇧C)"); return; }
    await this.applyToTargets(this.clipboard, "Paste Settings");
  }

  async previousSettings() {
    if (!this.lastSettings) { this.toast("Edit another photo first"); return; }
    const part = pick(this.lastSettings, Object.keys(GROUPS).filter((g) => !PASTE_DEFAULT_OFF.has(g) || g === "White Balance"));
    await this.applyToTargets(part, "Previous Settings");
  }

  async syncSettings() {
    const src = this.photos.find((p) => p.id === this.currentId);
    const others = this.selected().filter((p) => p !== src);
    if (!src?.settings || !others.length) { this.toast("Select an edited photo, then the photos to sync to"); return; }
    const r = await this.groupDialog(`Sync settings from ${src.name} to ${others.length} photo${others.length > 1 ? "s" : ""}`);
    if (!r) return;
    await this.applyTo(others, pick(src.settings, r.groups), "Sync Settings");
  }

  async applyToTargets(part, label) {
    if (this.module === "develop" && this.dev.s) {
      this.dev.setSettings(applyPartial(this.dev.s, part, this.dev.info), label);
      return;
    }
    await this.applyTo(this.targets(), part, label);
  }

  /** Apply a partial settings object to photos that aren't open in Develop. */
  async applyTo(photos, part, label, fn) {
    for (const p of photos) {
      const info = p.info || { isRaw: p.kind === "raw", asShotTemp: 5500, asShotTint: 0 };
      const base = { ...defaults(info), ...clone(p.settings || {}) };
      const s = fn ? fn(base, info) : applyPartial(base, part, info);
      p.settings = s;
      p.history = [...(p.history?.length ? p.history : [{ label: "Import", s: defaults(info) }]), { label, s: clone(s), t: Date.now() }].slice(-60);
      p.historyAt = p.history.length - 1;
      p.edited = true;
      p.editedAt = Date.now();
      p.thumbStale = true;
      await db.putPhoto(p);
      this.queueThumb(p);
    }
    this.toast(`${label}: ${photos.length} photo${photos.length === 1 ? "" : "s"}`);
    this.refreshList();
  }

  quickAdjust(key, delta) {
    const lim = key === "exposure" ? 5 : 100;
    return this.applyTo(this.targets(), null, `Quick Develop: ${key}`, (s) => {
      s[key] = Math.round(Math.max(-lim, Math.min(lim, (s[key] || 0) + delta)) * 100) / 100;
      return s;
    });
  }
  quickSet(part, label) { return this.applyTo(this.targets(), part, "Quick Develop: " + label); }
  quickWB(name) {
    return this.applyTo(this.targets(), null, "White Balance: " + name, (s, info) => {
      const presets = info.isRaw ? WB_PRESETS_RAW : WB_PRESETS_IMG;
      if (!presets.some(([n]) => n === name)) return s;
      s.wb = name;
      return s;
    });
  }
  resetSelection() {
    if (!confirm("Reset all develop settings on the selected photos?")) return;
    return this.applyTo(this.targets(), null, "Reset", (s, info) => defaults(info));
  }
  applyPresetToSelection(p) { return this.applyTo(this.targets(), p.s, "Preset: " + p.name); }

  // ───────── User presets ─────────
  async userPresets() { return db.getMeta("presets", []); }
  async addPreset(name, groups, s) {
    const list = (await this.userPresets()).filter((p) => p.name !== name);
    list.push({ name, s: pick(s, groups) });
    await db.setMeta("presets", list);
    this.toast(`Preset “${name}” saved`);
  }
  async deletePreset(name) {
    await db.setMeta("presets", (await this.userPresets()).filter((p) => p.name !== name));
  }

  // ───────── Export ─────────
  exportSelected() {
    if (this.module === "develop") this.dev.flushSave();
    const t = this.module === "develop" ? this.photos.filter((p) => p.id === this.currentId) : this.targets();
    if (!t.length) { this.toast("Select photos to export"); return; }
    exportDialog(this, t);
  }

  // ───────── Misc ─────────
  toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  shortcuts() {
    const rows = [
      ["G / D", "Library / Develop"], ["← →", "Previous / next photo"], ["0–5", "Rating"], ["P · X · U", "Pick · Reject · Unflag"],
      ["6–9", "Red · Yellow · Green · Blue label"], ["⌘Z / ⌘⇧Z", "Undo / redo"], ["⌘⇧C / ⌘⇧V", "Copy / paste settings"],
      ["⌘'", "Virtual copy"], ["⌘⇧E", "Export"], ["⌘⇧I", "Import"], ["\\", "Before / after"], ["Y / ⇧Y", "Split / side-by-side"],
      ["Z", "Zoom 1:1 / fit"], ["R", "Crop & straighten"], ["X (in crop)", "Swap crop orientation"], ["Q", "Healing"],
      ["M / ⇧M", "Linear / radial gradient mask"], ["K", "Brush mask"], ["O", "Show mask overlay"], ["[ ]", "Brush / spot size"],
      ["W", "White balance picker"], ["J", "Clipping warnings"], ["Tab", "Hide panels"], ["Double-click slider", "Reset it"],
      ["⇧ + double-click Whites/Blacks", "Auto set"],
    ];
    const dlg = h("dialog", { class: "ph-dialog ph-keys" }, h("h3", {}, "Keyboard shortcuts"),
      h("div", { class: "ph-keygrid" }, rows.map(([k, d]) => [h("kbd", {}, k), h("span", {}, d)])),
      h("div", { class: "pd-row" }, h("span", { class: "ph-spacer" }), h("button", { class: "btn primary", type: "button", onclick: () => dlg.close() }, "Close")));
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  key(e) {
    if (e.target.closest?.("input, textarea, select, [contenteditable], dialog")) return;
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && k.toLowerCase() === "c") { e.preventDefault(); this.copySettings(); return; }
    if (mod && e.shiftKey && k.toLowerCase() === "v") { e.preventDefault(); this.pasteSettings(); return; }
    if (mod && e.shiftKey && k.toLowerCase() === "e") { e.preventDefault(); this.exportSelected(); return; }
    if (mod && e.shiftKey && k.toLowerCase() === "i") { e.preventDefault(); this.pickFiles(); return; }
    if (mod && k === "'") { e.preventDefault(); this.virtualCopy(); return; }
    if (this.module === "develop" && this.dev.key(e)) { e.preventDefault(); return; }
    if (this.module === "library" && this.lib.key(e)) { e.preventDefault(); return; }
    if (mod) return;
    if (k === "g" || k === "G") { this.setModule("library"); e.preventDefault(); return; }
    if (k === "d" || k === "D" || k === "e" || k === "E") { this.setModule("develop"); e.preventDefault(); return; }
    if (k === "Tab") { e.preventDefault(); this.root.classList.toggle("hide-left"); this.root.classList.toggle("hide-right"); setTimeout(() => this.dev.redraw(true), 220); return; }
    if (/^[0-5]$/.test(k)) { this.setRating(+k); return; }
    if (k === "p" || k === "P") { this.setFlag(1); return; }
    if (k === "x" || k === "X") { this.setFlag(-1); return; }
    if (k === "u" || k === "U") { this.setFlag(0); return; }
    if (k === "ArrowRight" || k === "ArrowLeft") { this.step(k === "ArrowRight" ? 1 : -1); e.preventDefault(); return; }
  }
}

export async function initPhoto() {
  const root = $("#photoRoot");
  if (!root || app) return;
  app = new PhotoApp(root);
  addEventListener("keydown", (e) => { if (!$("#view-photo").hidden) app.key(e); });
  try { await app.load(); } catch (err) { app.toast("Couldn't open the photo catalog: " + err.message); }
}

export function showPhoto(visible) {
  if (!app) return;
  if (visible) { app.dev.redraw(app.module === "develop"); app.refreshList(); }
  else if (app.module === "develop") app.dev.flushSave();
}
