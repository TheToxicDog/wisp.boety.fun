// BoetyCut: a CapCut-style video editor (a port of OpenCut's editor ideas to
// plain modules, made for touch). This file is the shell: projects home,
// editor layout, playback, preview handles, history and clip actions.
import { $ } from "./ui.js";
import { h, svgIcon, segmented } from "./photo-ui.js";
import * as store from "./cut-store.js";
import {
  uid, clamp, clone, newProject, newClip, newTextClip, ratioSize, layoutMain, projectDuration, findClip, trackFor,
  sortItems, pruneTracks, splitClip, setKeyframe, removeKeyframe, keyframeTimes, propAt, writeProp, clipEnd,
  TEXT_STYLES, parseSubtitles, toSrt, fmtTime, KF_PROPS, sourceTime,
} from "./cut-model.js";
import { importFile, addGenerated, FrameCache, blobOf, stripOf, audioOf, audioContext } from "./cut-media.js";
import { Compositor } from "./cut-gl.js";
import { buildScene, clipBox, setFontListener, ensureFont } from "./cut-render.js";
import { AudioPlayer, speechSamples } from "./cut-audio.js";
import { Timeline } from "./cut-timeline.js";
import { PANELS } from "./cut-panels.js";
import { exportVideo, exportFrame, reverseRange, RESOLUTIONS, FRAME_RATES } from "./cut-export.js";

const IC = {
  back: '<path d="M15 6l-6 6 6 6"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>', pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>', redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', kf: '<path d="M12 3l7 9-7 9-7-9z"/>',
  split: '<path d="M12 3v18"/><path d="M5 8l4 4-4 4M19 8l-4 4 4 4"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  speed: '<path d="M12 14l4-6"/><path d="M4 18a9 9 0 1 1 16 0"/>', volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  anim: '<circle cx="8" cy="12" r="4"/><path d="M14 8h2M15 12h5M14 16h2"/>', fx: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  filter: '<circle cx="9" cy="10" r="5"/><circle cx="15" cy="10" r="5"/><circle cx="12" cy="15" r="5"/>', adjust: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  mask: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="5"/>', chroma: '<path d="M4 20l6-6M14 4l6 6-8 8-6-6z"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>', mirror: '<path d="M12 3v18"/><path d="M8 7L3 12l5 5z"/><path d="M16 7l5 5-5 5z"/>',
  rotate: '<path d="M20 4v6h-6"/><path d="M19.5 10A8 8 0 1 0 18 17"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  replace: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>', freeze: '<path d="M12 2v20M4.9 6.5l14.2 11M19.1 6.5L4.9 17.5"/>', reverse: '<path d="M8 7l-4 4 4 4"/><path d="M4 11h11a5 5 0 0 1 0 10h-2"/>',
  extract: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', basic: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 4v16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>', sticker: '<path d="M14 21H8a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5v6z"/><path d="M14 21v-4a3 3 0 0 1 3-3h4"/><path d="M9 10h.01M15 10h.01M9 14s1 1.5 3 1.5"/>',
  overlay: '<rect x="3" y="7" width="13" height="13" rx="2"/><rect x="8" y="3" width="13" height="13" rx="2"/>', audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  canvas: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6"/>', captions: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 14h4M13 14h4M7 10h10"/>',
  media: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 15.5l-5-5-8.5 8.5"/>', trans: '<path d="M4 6l7 6-7 6zM20 6l-7 6 7 6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  zin: '<circle cx="11" cy="11" r="7"/><path d="M8 11h6M11 8v6M21 21l-5-5"/>', zout: '<circle cx="11" cy="11" r="7"/><path d="M8 11h6M21 21l-5-5"/>',
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>', camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
};

const LIB_TOOLS = [
  ["media", "Media", IC.media], ["audio", "Audio", IC.audio], ["text", "Text", IC.text], ["stickers", "Stickers", IC.sticker],
  ["effects", "Effects", IC.fx], ["transitions", "Transitions", IC.trans], ["filters", "Filters", IC.filter], ["adjust", "Adjust", IC.adjust],
  ["canvas", "Canvas", IC.canvas], ["captions", "Captions", IC.captions],
];
const TITLES = {
  media: "Media", audio: "Audio", text: "Text", stickers: "Stickers", effects: "Effects", transitions: "Transitions", transition: "Transition",
  filters: "Filters", adjust: "Adjust", canvas: "Canvas", captions: "Auto captions", basic: "Transform", speed: "Speed", volume: "Volume",
  animation: "Animation", clipEffects: "Effects", effectClip: "Effect", mask: "Mask", chroma: "Chroma key", crop: "Crop",
  textEdit: "Edit text", textStyle: "Text style", filterClip: "Filter", adjustClip: "Adjust",
};
const isDesktop = () => matchMedia("(min-width: 1100px) and (min-height: 620px)").matches;

let app = null;

class Editor {
  constructor(root) {
    this.root = root;
    this.p = null;
    this.media = new Map();
    this.T = 0;
    this.sel = null;
    this.undoStack = [];
    this.redoStack = [];
    this.audio = new AudioPlayer();
    this.frames = new FrameCache({ maxSize: 1280 });
    this.exportOpts = { res: 1080, fps: 30, quality: "high", format: "mp4", audio: true };
    try { Object.assign(this.exportOpts, JSON.parse(localStorage.getItem("wisp.cut.export") || "{}")); } catch { /* defaults */ }
    setFontListener(() => this.requestRender());
    this.buildHome();
    this.buildEditor();
    this.showHome();
  }

  // ───────────────────────── Home ─────────────────────────
  buildHome() {
    this.drafts = h("div", { class: "bc-drafts" });
    this.home = h("div", { class: "bc-home" },
      h("div", { class: "bc-home-head" }, h("h2", {}, "BoetyCut"), h("span", { class: "bc-home-sub" }, "Edit videos right in your browser")),
      h("button", { type: "button", class: "bc-new", onclick: () => this.newProject() },
        h("span", { class: "bc-new-ic" }, svgIcon(IC.plus, 28)), h("b", {}, "New project"), h("span", {}, "Pick videos and photos to start")),
      h("div", { class: "bc-home-row" }, h("h3", {}, "Drafts"), h("span", { class: "bc-home-sub", "data-count": "" })),
      this.drafts);
    this.fileInput = h("input", { type: "file", multiple: true, hidden: true });
    this.fileInput.addEventListener("change", () => {
      const files = [...this.fileInput.files];
      this.fileInput.value = "";
      this.onFiles?.(files);
    });
    this.root.append(this.home, this.fileInput);
  }

  async showHome() {
    this.stopEverything();
    this.root.dataset.screen = "home";
    const list = await store.listProjects();
    this.home.querySelector("[data-count]").textContent = list.length ? `${list.length} project${list.length > 1 ? "s" : ""}` : "";
    const cards = await Promise.all(list.map(async (p) => {
      const cover = await store.getThumb("cover:" + p.id);
      const img = cover ? h("img", { src: URL.createObjectURL(cover), alt: "" }) : h("span", { class: "bc-nocover" }, svgIcon(IC.media, 28));
      const more = h("button", { type: "button", class: "bc-dmore", "aria-label": "Project options" }, svgIcon(IC.more, 18));
      const card = h("div", { class: "bc-draft", role: "button", tabindex: "0" },
        h("div", { class: "bc-dcover" }, img, h("em", {}, fmtTime(projectDuration(p)))),
        h("div", { class: "bc-dname" }, h("b", {}, p.name), more),
        h("span", { class: "bc-dsub" }, new Date(p.updated).toLocaleDateString()));
      card.addEventListener("click", (e) => { if (!e.target.closest(".bc-dmore")) this.open(p.id); });
      more.addEventListener("click", () => this.draftMenu(p, more));
      return card;
    }));
    this.drafts.replaceChildren(...(cards.length ? cards : [h("p", { class: "bc-hint" }, "Your projects will appear here. They're saved in this browser.")]));
  }

  draftMenu(p, anchor) {
    this.menu([
      ["Rename", async () => { const n = prompt("Project name", p.name); if (n) { p.name = n.trim(); await store.putProject(p); this.showHome(); } }],
      ["Duplicate", async () => {
        const q = clone(p); q.id = uid(); q.name = p.name + " copy"; q.created = q.updated = Date.now();
        // media records belong to a project: copy them
        const map = new Map();
        for (const m of await store.projectMedia(p.id)) { const nid = uid(); map.set(m.id, nid); await store.putMedia({ ...m, id: nid, projectId: q.id }); }
        for (const tr of q.tracks) for (const c of tr.items) if (c.mediaId && map.has(c.mediaId)) c.mediaId = map.get(c.mediaId);
        await store.putProject(q); this.showHome();
      }],
      ["Delete", async () => { if (confirm(`Delete “${p.name}”? This can't be undone.`)) { await store.deleteProject(p.id); this.showHome(); } }, "danger"],
    ], anchor);
  }

  menu(items, anchor) {
    document.querySelector(".bc-menu")?.remove();
    const r = anchor.getBoundingClientRect();
    const m = h("div", { class: "bc-menu", style: { top: Math.min(innerHeight - 160, r.bottom + 4) + "px", left: Math.max(8, Math.min(innerWidth - 180, r.right - 170)) + "px" } },
      items.map(([label, fn, cls]) => h("button", { type: "button", class: cls || "", onclick: () => { m.remove(); fn(); } }, label)));
    document.body.append(m);
    setTimeout(() => addEventListener("pointerdown", (e) => { if (!m.contains(e.target)) m.remove(); }, { once: true }), 0);
  }

  async newProject() {
    const n = (await store.listProjects()).length + 1;
    const p = newProject(`Project ${n}`);
    p.ratio = "original";
    await store.putProject(p);
    await this.open(p.id);
    this.importInto("main", true);
  }

  // ───────────────────────── Editor layout ─────────────────────────
  buildEditor() {
    const tb = (icon, label, fn, cls = "") => h("button", { type: "button", class: "bc-ib " + cls, title: label, "aria-label": label, onclick: fn }, svgIcon(icon, 20));
    this.nameEl = h("button", { type: "button", class: "bc-pname", onclick: () => this.rename() });
    this.resChip = h("button", { type: "button", class: "bc-chip", onclick: () => this.exportSheet() });
    const top = h("header", { class: "bc-top" },
      tb(IC.close, "Close project", () => this.closeProject()),
      this.nameEl,
      h("span", { class: "bc-spacer" }),
      this.resChip,
      h("button", { type: "button", class: "bc-export", onclick: () => this.exportSheet() }, "Export"));

    // Player
    this.canvas = h("canvas", { class: "bc-canvas" });
    this.overlay = h("div", { class: "bc-overlay" });
    this.stageInner = h("div", { class: "bc-stage-in" }, this.canvas, this.overlay);
    this.stage = h("div", { class: "bc-stage" }, this.stageInner);
    this.timeEl = h("span", { class: "bc-time" });
    this.playBtn = h("button", { type: "button", class: "bc-play", "aria-label": "Play", onclick: () => this.toggle() }, svgIcon(IC.play, 22));
    this.kfBtn = tb(IC.kf, "Add/remove keyframe", () => this.toggleKeyframe(), "bc-kfbtn");
    this.undoBtn = tb(IC.undo, "Undo", () => this.undo());
    this.redoBtn = tb(IC.redo, "Redo", () => this.redo());
    const transport = h("div", { class: "bc-transport" },
      this.timeEl, h("span", { class: "bc-spacer" }), this.playBtn, h("span", { class: "bc-spacer" }),
      this.kfBtn, this.undoBtn, this.redoBtn, tb(IC.camera, "Save this frame", () => this.saveFrame()), tb(IC.full, "Full screen", () => this.fullscreen()));
    this.player = h("section", { class: "bc-player" }, this.stage, transport);

    // Desktop side panels
    this.libTabs = h("div", { class: "bc-libtabs" }, LIB_TOOLS.map(([id, label, icon]) => {
      const b = h("button", { type: "button", "data-tool": id, title: label }, svgIcon(icon, 20), h("span", {}, label));
      b.addEventListener("click", () => this.setLib(id));
      return b;
    }));
    this.libBody = h("div", { class: "bc-panelbody" });
    this.lib = h("aside", { class: "bc-lib" }, this.libTabs, this.libBody);
    this.inspTabs = h("div", { class: "bc-insptabs" });
    this.inspBody = h("div", { class: "bc-panelbody" });
    this.insp = h("aside", { class: "bc-insp" }, this.inspTabs, this.inspBody);
    this.libTool = "media";

    // Timeline + its toolbar
    this.tl = new Timeline(this);
    this.tlTools = h("div", { class: "bc-tltools" },
      tb(IC.split, "Split (S)", () => this.split()), tb(IC.trash, "Delete", () => this.remove()), tb(IC.copy, "Duplicate", () => this.duplicate()),
      tb(IC.freeze, "Freeze frame", () => this.freeze()), tb(IC.reverse, "Reverse", () => this.reverse()), tb(IC.mirror, "Mirror", () => this.mirror()),
      tb(IC.rotate, "Rotate 90°", () => this.rotate90()), tb(IC.crop, "Crop", () => this.openTool("crop")),
      h("span", { class: "bc-spacer" }),
      this.snapBtn = tb(IC.magnet, "Snapping", () => { this.tl.snap = !this.tl.snap; this.snapBtn.classList.toggle("on", this.tl.snap); }, "on"),
      tb(IC.zout, "Zoom out", () => this.tl.setZoom(this.tl.pps / 1.5)), tb(IC.zin, "Zoom in", () => this.tl.setZoom(this.tl.pps * 1.5)));
    this.tlWrap = h("section", { class: "bc-tlwrap" }, this.tlTools, this.tl.el);

    // Mobile bottom bar + sheet
    this.bar = h("nav", { class: "bc-bar" });
    this.sheetBody = h("div", { class: "bc-sheet-body" });
    this.sheetTitle = h("b", {});
    this.sheet = h("div", { class: "bc-sheet", hidden: true },
      h("div", { class: "bc-sheet-head" }, this.sheetTitle, h("button", { type: "button", class: "bc-ib", "aria-label": "Done", onclick: () => this.closeTool() }, svgIcon('<path d="M5 12l5 5L20 7"/>', 20))),
      this.sheetBody);

    this.busy = h("div", { class: "bc-busy", hidden: true });
    this.editor = h("div", { class: "bc-editor" }, top, h("div", { class: "bc-work" }, this.lib, this.player, this.insp), this.tlWrap, this.bar, this.sheet, this.busy);
    this.root.append(this.editor);

    this.bindStage();
    new ResizeObserver(() => this.layoutStage()).observe(this.stage);
    matchMedia("(min-width: 1100px) and (min-height: 620px)").addEventListener("change", () => { this.closeTool(); this.paintPanels(); });
  }

  // ───────────────────────── Projects ─────────────────────────
  async open(id) {
    const p = await store.getProject(id);
    if (!p) return;
    this.p = p;
    this.media = new Map((await store.projectMedia(id)).map((m) => { const { blob, ...rest } = m; void blob; return [m.id, rest]; }));
    this.T = 0; this.sel = null; this.undoStack = []; this.redoStack = [];
    this.root.dataset.screen = "editor";
    this.gl ??= new Compositor(this.canvas);
    this.nameEl.textContent = p.name;
    this.paintRes();
    for (const m of this.media.values()) { if (m.hasAudio || m.kind === "audio") audioOf(m).catch(() => {}); stripOf(m).catch(() => {}); }
    for (const tr of p.tracks) for (const c of tr.items) if (c.type === "text") ensureFont(c.text.font);
    this.layoutStage();
    this.refresh();
  }

  async closeProject() {
    this.flushSave();
    this.stopEverything();
    this.p = null;
    this.showHome();
  }

  stopEverything() {
    this.pause();
    this.closeTool();
    this.frames.clear();
  }

  rename() {
    const n = prompt("Project name", this.p.name);
    if (!n) return;
    this.p.name = n.trim();
    this.nameEl.textContent = this.p.name;
    this.save();
  }

  // ───────────────────────── History ─────────────────────────
  beginChange(label) {
    if (this.pending) return;
    this.pending = { label, before: JSON.stringify(this.p) };
  }

  endChange() {
    const pend = this.pending;
    this.pending = null;
    if (!pend) return;
    const after = JSON.stringify(this.p);
    if (after !== pend.before) {
      this.undoStack.push(pend.before);
      if (this.undoStack.length > 80) this.undoStack.shift();
      this.redoStack = [];
      this.save();
    }
    this.refresh();
  }

  change(label, fn) {
    this.beginChange(label);
    fn(this.p);
    this.normalise();
    this.endChange();
  }

  /** Mutate during a drag/slider: preview updates, one undo step when it ends. */
  live(label, fn) {
    this.beginChange(label);
    fn(this.p);
    this.normalise();
    this.requestRender();
    if (this.tlDirtyTimer) return;
    this.tlDirtyTimer = setTimeout(() => { this.tlDirtyTimer = null; this.tl.render(); }, 120);
  }

  normalise() {
    const p = this.p;
    for (const tr of p.tracks) sortItems(tr);
    layoutMain(p);
    pruneTracks(p);
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.p));
    this.p = JSON.parse(this.undoStack.pop());
    if (this.sel && !findClip(this.p, this.sel.replace(/^t:/, ""))) this.sel = null;
    this.save();
    this.refresh();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.p));
    this.p = JSON.parse(this.redoStack.pop());
    this.save();
    this.refresh();
  }

  save() {
    if (!this.p) return;
    this.p.updated = Date.now();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 600);
    this.needCover = true;
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    if (this.p) store.putProject(this.p);
  }

  // ───────────────────────── State helpers ─────────────────────────
  duration() { return this.p ? projectDuration(this.p) : 0; }
  mainTrack() { return this.p.tracks.find((t) => t.kind === "main"); }
  clip() { if (!this.sel || this.sel.startsWith("t:")) return null; return findClip(this.p, this.sel)?.clip || null; }
  trackOf(c) { return findClip(this.p, c.id)?.track || null; }
  propNow(c, k) { return propAt(c, k, clamp(this.T - c.start, 0, c.dur)); }
  writeProp(c, k, v) { writeProp(c, k, v, clamp(this.T - c.start, 0, c.dur)); }

  transitionTarget() {
    if (this.sel?.startsWith("t:")) return findClip(this.p, this.sel.slice(2))?.clip || null;
    // otherwise: the cut nearest the playhead
    const items = this.mainTrack().items;
    let best = null, bd = Infinity;
    for (let i = 0; i < items.length - 1; i++) { const d = Math.abs(clipEnd(items[i]) - this.T); if (d < bd) { bd = d; best = items[i]; } }
    return best;
  }

  select(id, keepTool) {
    this.sel = id;
    if (!keepTool) this.closeTool(true);
    this.refresh();
  }

  refresh(o = {}) {
    if (!this.p) return;
    this.tl.render();
    if (o.quick) { this.requestRender(); this.paintOverlay(); return; }
    this.paintBar();
    this.paintPanels();
    this.paintTransport();
    this.requestRender();
  }

  // ───────────────────────── Playback ─────────────────────────
  seek(t, o = {}) {
    this.T = clamp(t, 0, Math.max(0, this.duration()));
    if (!o.fromTimeline) this.tl.syncScroll();
    this.paintTransport();
    this.requestRender();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  async play() {
    if (!this.p) return;
    const dur = this.duration();
    if (dur <= 0) return;
    if (this.T >= dur - 0.05) this.T = 0;
    this.playing = true;
    this.playBtn.replaceChildren(svgIcon(IC.pause, 22));
    await this.audio.play(this.p, this.media, this.T);
    const loop = () => {
      if (!this.playing) return;
      const t = this.audio.now();
      if (t >= dur) { this.T = dur; this.pause(); this.seek(dur); return; }
      this.T = t;
      this.tl.syncScroll();
      this.paintTransport();
      this.requestRender();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    this.playBtn.replaceChildren(svgIcon(IC.play, 22));
    this.paintOverlay();
    this.requestRender();
  }

  paintTransport() {
    if (!this.p) return;
    this.timeEl.innerHTML = `<b>${fmtTime(this.T, true)}</b> / ${fmtTime(this.duration(), true)}`;
    const c = this.clip();
    const onKf = c && keyframeTimes(c).some((t) => Math.abs(t - (this.T - c.start)) < 1 / 30);
    this.kfBtn.hidden = !c;
    this.kfBtn.classList.toggle("on", !!onKf);
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  // ───────────────────────── Rendering ─────────────────────────
  layoutStage() {
    if (!this.p) return;
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    if (!sw || !sh) return;
    const A = this.p.w / this.p.h;
    let w = sw, hh = sw / A;
    if (hh > sh) { hh = sh; w = sh * A; }
    this.stageInner.style.width = Math.round(w) + "px";
    this.stageInner.style.height = Math.round(hh) + "px";
    const dpr = Math.min(2, devicePixelRatio || 1);
    let pw = Math.round(w * dpr), ph = Math.round(hh * dpr);
    const k = Math.min(1, 1280 / Math.max(pw, ph));
    pw = Math.max(2, Math.round(pw * k)); ph = Math.max(2, Math.round(ph * k));
    this.gl?.resize(pw, ph);
    this.requestRender();
  }

  requestRender() {
    if (!this.p || !this.gl) return;
    this.dirty = true;
    if (this.rendering) return;
    this.renderNow();
  }

  async renderNow() {
    this.rendering = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        const env = { media: this.media, frames: this.frames, W: this.gl.w, H: this.gl.h, gl: this.gl };
        const T = this.T;
        let scene;
        try { scene = await buildScene(this.p, T, env); } catch (err) { console.warn(err); continue; }
        if (!this.p) break;
        this.gl.render(scene, true);
        this.afterRender?.();
        this.afterRender = null;
        if (!this.playing) {
          this.snapshot();
          this.paintOverlay();
          if (this.needCover) this.saveCover();
        }
      }
    } finally { this.rendering = false; }
  }

  snapshot() {
    const c = this.snapCanvas ||= document.createElement("canvas");
    c.width = 96; c.height = Math.max(2, Math.round(96 * this.gl.h / this.gl.w));
    c.getContext("2d").drawImage(this.canvas, 0, 0, c.width, c.height);
    this.snap = null;
  }
  snapshotURL() {
    if (!this.snapCanvas) return null;
    return (this.snap ||= this.snapCanvas.toDataURL("image/jpeg", 0.7));
  }

  saveCover() {
    this.needCover = false;
    if (!this.p || this.duration() <= 0) return;
    const c = document.createElement("canvas");
    c.width = 240; c.height = Math.round(240 * this.gl.h / this.gl.w);
    c.getContext("2d").drawImage(this.canvas, 0, 0, c.width, c.height);
    const id = this.p.id;
    c.toBlob((b) => b && store.putThumb("cover:" + id, b), "image/jpeg", 0.75);
  }

  // ───────────────────────── Preview handles ─────────────────────────
  activeVisual() {
    const c = this.clip();
    if (!c || c.type === "audio") return null;
    const tr = this.trackOf(c);
    if (!tr || ["effect", "filter", "adjust"].includes(tr.kind)) return null;
    if (this.T < c.start || this.T >= clipEnd(c)) return null;
    return c;
  }

  paintOverlay() {
    const o = this.overlay;
    if (!this.p) return;
    const c = this.activeVisual();
    if (!c || this.playing) { o.replaceChildren(); return; }
    const W = this.stageInner.clientWidth, H = this.stageInner.clientHeight;
    if (this.tool === "crop" && (c.type === "video" || c.type === "image")) { o.replaceChildren(this.cropOverlay(c, W, H)); return; }
    const b = clipBox(c, this.T, W, H, this.media);
    const box = h("div", { class: "bc-box" + (c.type === "text" ? " text" : ""), style: { left: b.cx + "px", top: b.cy + "px", width: Math.max(12, b.w) + "px", height: Math.max(12, b.h) + "px", transform: `translate(-50%,-50%) rotate(${b.rot}deg)` } },
      h("span", { class: "bc-knob", "data-act": "rotscale", title: "Drag to rotate and resize" }, svgIcon(IC.rotate, 12)));
    if (c.type === "text" || c.type === "sticker") box.append(h("span", { class: "bc-knob del", "data-act": "delete", title: "Delete" }, svgIcon(IC.close, 12)), h("span", { class: "bc-knob edit", "data-act": "edit", title: "Edit" }, svgIcon(IC.edit, 12)));
    o.replaceChildren(box, h("i", { class: "bc-guide v", hidden: true }), h("i", { class: "bc-guide hz", hidden: true }));
  }

  cropOverlay(c, W, H) {
    const full = clipBox({ ...c, crop: { l: 0, t: 0, r: 1, b: 1 } }, this.T, W, H, this.media);
    const cr = c.crop;
    // without the crop the clip would be larger; recompute frame at the same scale as the cropped one
    const cb = clipBox(c, this.T, W, H, this.media);
    const fw = cb.w / (cr.r - cr.l), fh = cb.h / (cr.b - cr.t);
    void full;
    const frame = h("div", { class: "bc-cropframe", style: { left: cb.cx + "px", top: cb.cy + "px", width: fw + "px", height: fh + "px", transform: `translate(-50%,-50%) rotate(${cb.rot}deg) translate(${(0.5 - (cr.l + cr.r) / 2) * fw}px,${(0.5 - (cr.t + cr.b) / 2) * fh}px)` } });
    const rect = h("div", { class: "bc-croprect", style: { left: cr.l * 100 + "%", top: cr.t * 100 + "%", width: (cr.r - cr.l) * 100 + "%", height: (cr.b - cr.t) * 100 + "%" } },
      ...["tl", "tr", "bl", "br"].map((k) => h("span", { class: "bc-ch " + k, "data-crop": k })));
    frame.append(rect);
    this.cropGeom = { fw, fh, rot: cb.rot };
    return frame;
  }

  applyCropRatio(c, ratio) {
    if (ratio === "free") return;
    const m = this.media.get(c.mediaId);
    const [a, b] = ratio.split(":").map(Number);
    const sw = m?.w || 16, sh = m?.h || 9;
    const target = a / b;
    this.change("Crop " + ratio, () => {
      let w = 1, hh = 1;
      if (sw / sh > target) w = (sh * target) / sw; else hh = (sw / target) / sh;
      c.crop = { l: (1 - w) / 2, t: (1 - hh) / 2, r: (1 + w) / 2, b: (1 + hh) / 2 };
    });
  }

  bindStage() {
    const st = this.stage;
    const pts = new Map();
    let drag = null;
    const local = (e) => { const r = this.stageInner.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    st.addEventListener("pointerdown", (e) => {
      if (!this.p) return;
      if (this.pickCb) { const cb = this.pickCb; this.pickCb = null; this.stage.classList.remove("picking"); this.pickAt(local(e), cb); return; }
      pts.set(e.pointerId, local(e));
      st.setPointerCapture(e.pointerId);
      const c = this.activeVisual() || this.hitTest(local(e));
      if (!c) { drag = null; return; }
      if (this.sel !== c.id) { this.select(c.id); }
      const act = e.target.closest("[data-act]")?.dataset.act;
      const crop = e.target.closest("[data-crop]")?.dataset.crop;
      if (act === "delete") { this.remove(); return; }
      if (act === "edit") { this.openTool(c.type === "text" ? "textEdit" : "basic"); return; }
      const W = this.stageInner.clientWidth, H = this.stageInner.clientHeight;
      const b = clipBox(c, this.T, W, H, this.media);
      const lt = clamp(this.T - c.start, 0, c.dur);
      const start = { p: local(e), x: propAt(c, "x", lt), y: propAt(c, "y", lt), scale: propAt(c, "scale", lt), rot: propAt(c, "rot", lt), crop: { ...c.crop }, b };
      if (pts.size === 2) { drag = { kind: "pinch", c, start, pts0: [...pts.values()] }; return; }
      if (crop) drag = { kind: "crop", c, start, corner: crop };
      else if (act === "rotscale") drag = { kind: "rotscale", c, start };
      else drag = { kind: "move", c, start, tap: Date.now() };
      this.beginChange("Transform");
    });
    st.addEventListener("pointermove", (e) => {
      if (!drag || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, local(e));
      const { c, start } = drag;
      const W = this.stageInner.clientWidth, H = this.stageInner.clientHeight;
      const p = local(e);
      const dx = p[0] - start.p[0], dy = p[1] - start.p[1];
      if (drag.kind === "move") {
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        let nx = start.x + dx / (W / 2), ny = start.y + dy / (H / 2);
        const gv = this.overlay.querySelector(".bc-guide.v"), gh = this.overlay.querySelector(".bc-guide.hz");
        const snapX = Math.abs(nx) < 0.03, snapY = Math.abs(ny) < 0.03;
        if (snapX) nx = 0; if (snapY) ny = 0;
        if (gv) gv.hidden = !snapX; if (gh) gh.hidden = !snapY;
        this.writeProp(c, "x", nx); this.writeProp(c, "y", ny);
      } else if (drag.kind === "rotscale") {
        const cx = start.b.cx, cy = start.b.cy;
        const a0 = Math.atan2(start.p[1] - cy, start.p[0] - cx), a1 = Math.atan2(p[1] - cy, p[0] - cx);
        const d0 = Math.hypot(start.p[0] - cx, start.p[1] - cy), d1 = Math.hypot(p[0] - cx, p[1] - cy);
        let rot = start.rot + (a1 - a0) * 180 / Math.PI;
        for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(rot - s) < 3) rot = s;
        this.writeProp(c, "rot", rot);
        this.writeProp(c, "scale", clamp(start.scale * d1 / Math.max(1, d0), 0.05, 20));
      } else if (drag.kind === "pinch" && pts.size === 2) {
        const [a, b] = [...pts.values()], [a0, b0] = drag.pts0;
        const s = Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(1, Math.hypot(a0[0] - b0[0], a0[1] - b0[1]));
        const r = Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(b0[1] - a0[1], b0[0] - a0[0]);
        this.writeProp(c, "scale", clamp(start.scale * s, 0.05, 20));
        this.writeProp(c, "rot", start.rot + r * 180 / Math.PI);
      } else if (drag.kind === "crop") {
        const g = this.cropGeom;
        const ang = -g.rot * Math.PI / 180;
        const lx = (dx * Math.cos(ang) - dy * Math.sin(ang)) / g.fw, ly = (dx * Math.sin(ang) + dy * Math.cos(ang)) / g.fh;
        const cr = { ...start.crop };
        if (drag.corner.includes("l")) cr.l = clamp(start.crop.l + lx, 0, cr.r - 0.05);
        if (drag.corner.includes("r")) cr.r = clamp(start.crop.r + lx, cr.l + 0.05, 1);
        if (drag.corner.includes("t")) cr.t = clamp(start.crop.t + ly, 0, cr.b - 0.05);
        if (drag.corner.includes("b")) cr.b = clamp(start.crop.b + ly, cr.t + 0.05, 1);
        c.crop = cr;
      }
      this.requestRender();
      if (drag.kind !== "crop") this.paintOverlay();
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (!drag) return;
      if (drag.kind === "pinch" && pts.size) return;
      const d = drag;
      drag = null;
      this.endChange();
      // double tap on text opens the editor
      if (d.kind === "move" && !d.moved) {
        if (this.lastTap && Date.now() - this.lastTap < 350 && d.c.type === "text") this.openTool("textEdit");
        this.lastTap = Date.now();
      }
    };
    st.addEventListener("pointerup", end);
    st.addEventListener("pointercancel", end);
  }

  /** Top-most visual clip under a stage point at the current time. */
  hitTest([px, py]) {
    const W = this.stageInner.clientWidth, H = this.stageInner.clientHeight;
    const tracks = [...this.p.tracks].reverse();
    for (const tr of tracks) {
      if (tr.hidden || ["audio", "effect", "filter", "adjust", "main"].includes(tr.kind)) continue;
      for (const c of tr.items) {
        if (this.T < c.start || this.T >= clipEnd(c)) continue;
        const b = clipBox(c, this.T, W, H, this.media);
        const a = -b.rot * Math.PI / 180;
        const dx = px - b.cx, dy = py - b.cy;
        const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
        if (Math.abs(lx) <= b.w / 2 + 8 && Math.abs(ly) <= b.h / 2 + 8) return c;
      }
    }
    const main = this.mainTrack().items.find((c) => this.T >= c.start && this.T < clipEnd(c));
    return main && !this.mainTrack().hidden ? main : null;
  }

  pickColor(cb) {
    this.pickCb = cb;
    this.stage.classList.add("picking");
    this.toast("Tap the colour to remove");
    if (!isDesktop()) this.sheet.classList.add("peek");
  }

  pickAt([px, py], cb) {
    this.sheet.classList.remove("peek");
    const W = this.stageInner.clientWidth, H = this.stageInner.clientHeight;
    this.afterRender = () => {
      const gl = this.gl.gl;
      const x = Math.round(px / W * this.gl.w), y = Math.round((1 - py / H) * this.gl.h);
      const px1 = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
      cb("#" + [...px1.slice(0, 3)].map((v) => v.toString(16).padStart(2, "0")).join(""));
    };
    // render without the chroma key active so we sample the real colour
    const c = this.clip();
    const saved = c?.chroma;
    if (c) c.chroma = null;
    this.dirty = true;
    const done = this.afterRender;
    this.afterRender = () => { done(); if (c) c.chroma = saved; this.requestRender(); };
    if (!this.rendering) this.renderNow();
  }

  // ───────────────────────── Panels & toolbars ─────────────────────────
  setLib(id) {
    this.libTool = id;
    this.paintPanels();
  }

  clipTools(c) {
    if (!c) return [];
    const kind = this.trackOf(c)?.kind;
    const A = (id, label, icon, fn) => ({ id, label, icon, fn });
    const tool = (id) => () => this.openTool(id);
    const common = [A("split", "Split", IC.split, () => this.split()), A("dup", "Duplicate", IC.copy, () => this.duplicate()), A("del", "Delete", IC.trash, () => this.remove())];
    if (kind === "effect") return [A("effectClip", "Replace", IC.fx, tool("effectClip")), ...common];
    if (kind === "filter") return [A("filterClip", "Filter", IC.filter, tool("filterClip")), ...common];
    if (kind === "adjust") return [A("adjustClip", "Adjust", IC.adjust, tool("adjustClip")), ...common];
    if (c.type === "audio") return [A("volume", "Volume", IC.volume, tool("volume")), A("speed", "Speed", IC.speed, tool("speed")), ...common, A("replace", "Replace", IC.replace, () => this.replace())];
    if (c.type === "text") return [A("textEdit", "Edit", IC.edit, tool("textEdit")), A("textStyle", "Style", IC.text, tool("textStyle")), A("animation", "Animation", IC.anim, tool("animation")), A("basic", "Transform", IC.basic, tool("basic")), ...common];
    if (c.type === "sticker") return [A("animation", "Animation", IC.anim, tool("animation")), A("basic", "Transform", IC.basic, tool("basic")), ...common];
    const video = c.type === "video";
    return [
      A("split", "Split", IC.split, () => this.split()),
      video && A("speed", "Speed", IC.speed, tool("speed")),
      video && A("volume", "Volume", IC.volume, tool("volume")),
      A("animation", "Animation", IC.anim, tool("animation")),
      A("del", "Delete", IC.trash, () => this.remove()),
      A("clipEffects", "Effects", IC.fx, tool("clipEffects")),
      A("filters", "Filters", IC.filter, tool("filters")),
      A("adjust", "Adjust", IC.adjust, tool("adjust")),
      A("mask", "Mask", IC.mask, tool("mask")),
      A("chroma", "Chroma key", IC.chroma, tool("chroma")),
      A("basic", "Opacity & blend", IC.basic, tool("basic")),
      A("crop", "Crop", IC.crop, tool("crop")),
      A("mirror", "Mirror", IC.mirror, () => this.mirror()),
      A("rotate", "Rotate", IC.rotate, () => this.rotate90()),
      A("dup", "Duplicate", IC.copy, () => this.duplicate()),
      A("replace", "Replace", IC.replace, () => this.replace()),
      video && A("freeze", "Freeze", IC.freeze, () => this.freeze()),
      video && A("reverse", "Reverse", IC.reverse, () => this.reverse()),
      video && A("extract", "Extract audio", IC.extract, () => this.extractAudio()),
      kind === "main" && A("transition", "Transition", IC.trans, () => { const t = this.transitionFrom(c); if (t) { this.sel = "t:" + t.id; this.openTool("transition"); } }),
    ].filter(Boolean);
  }

  transitionFrom(c) {
    const items = this.mainTrack().items;
    const i = items.indexOf(c);
    return i >= 0 && i < items.length - 1 ? c : items[i - 1] || null;
  }

  paintBar() {
    const c = this.clip();
    const B = (label, icon, fn, on) => {
      const b = h("button", { type: "button", class: "bc-tool" + (on ? " on" : "") }, svgIcon(icon, 22), h("span", {}, label));
      b.addEventListener("click", fn);
      return b;
    };
    if (c) {
      this.bar.replaceChildren(B("Back", IC.back, () => this.select(null)), h("i", { class: "bc-bar-sep" }),
        ...this.clipTools(c).map((t) => B(t.label, t.icon, t.fn, this.tool === t.id)));
    } else if (this.sel?.startsWith("t:")) {
      this.bar.replaceChildren(B("Back", IC.back, () => this.select(null)), B("Transition", IC.trans, () => this.openTool("transition"), true));
    } else {
      this.bar.replaceChildren(
        B("Edit", IC.split, () => { const m = this.mainTrack().items.find((x) => this.T >= x.start && this.T < clipEnd(x)); if (m) this.select(m.id); else this.toast("Move the playhead over a clip"); }),
        B("Audio", IC.audio, () => this.openTool("audio")),
        B("Text", IC.text, () => this.openTool("text")),
        B("Stickers", IC.sticker, () => this.openTool("stickers")),
        B("Overlay", IC.overlay, () => this.importInto("video")),
        B("Captions", IC.captions, () => this.openTool("captions")),
        B("Effects", IC.fx, () => this.openTool("effects")),
        B("Filters", IC.filter, () => this.openTool("filters")),
        B("Adjust", IC.adjust, () => this.openTool("adjust")),
        B("Canvas", IC.canvas, () => this.openTool("canvas")),
        B("Media", IC.media, () => this.openTool("media")));
    }
  }

  openTool(id) {
    this.tool = id;
    if (isDesktop()) {
      if (LIB_TOOLS.some(([t]) => t === id)) this.libTool = id;
      else this.inspTool = id;
      this.paintPanels();
      this.paintOverlay();
      return;
    }
    this.sheetTitle.textContent = TITLES[id] || "";
    this.sheetBody.replaceChildren(this.panel(id));
    this.sheet.hidden = false;
    this.editor.classList.add("sheet-open");
    this.paintBar();
    this.paintOverlay();
    setTimeout(() => this.layoutStage(), 0);
  }

  reopenTool() { if (this.tool) { if (isDesktop()) this.paintPanels(); else this.sheetBody.replaceChildren(this.panel(this.tool)); } }

  closeTool(silent) {
    if (this.pending) this.endChange();
    const was = this.tool;
    this.tool = null;
    this.sheet.hidden = true;
    this.sheet.classList.remove("peek");
    this.editor.classList.remove("sheet-open");
    this.pickCb = null;
    this.stage.classList.remove("picking");
    if (!silent && was) { this.paintBar(); this.paintOverlay(); }
    setTimeout(() => this.layoutStage(), 0);
  }

  panel(id) {
    try { return PANELS[id]?.(this) || h("p", { class: "bc-hint" }, "Nothing here yet."); }
    catch (err) { console.error(err); return h("p", { class: "bc-hint" }, "This panel failed to load: " + err.message); }
  }

  paintPanels() {
    if (!this.p) return;
    if (!isDesktop()) {
      // keep an open sheet in sync after changes
      if (this.tool && !this.sheet.hidden && !this.pending) {
        const scroll = this.sheetBody.scrollTop;
        this.sheetBody.replaceChildren(this.panel(this.tool));
        this.sheetBody.scrollTop = scroll;
      }
      return;
    }
    for (const b of this.libTabs.children) b.classList.toggle("on", b.dataset.tool === this.libTool);
    const ls = this.libBody.scrollTop;
    this.libBody.replaceChildren(h("h4", { class: "bc-ptitle" }, TITLES[this.libTool]), this.panel(this.libTool));
    this.libBody.scrollTop = ls;
    // Inspector: tabs for the selection
    const c = this.clip();
    let tabs;
    if (c) {
      tabs = this.clipTools(c).filter((t) => PANELS[t.id]).map((t) => [t.id, t.label]);
      const bi = tabs.findIndex(([id]) => id === "basic");
      if (bi > 0) tabs.unshift(...tabs.splice(bi, 1));
    }
    else if (this.sel?.startsWith("t:")) tabs = [["transition", "Transition"]];
    else tabs = [["canvas", "Project"]];
    if (!tabs.some(([id]) => id === this.inspTool)) this.inspTool = tabs[0]?.[0];
    this.inspTabs.replaceChildren(...tabs.map(([id, label]) => {
      const b = h("button", { type: "button", class: id === this.inspTool ? "on" : "" }, label);
      b.addEventListener("click", () => { this.inspTool = id; this.tool = id; this.paintPanels(); this.paintOverlay(); });
      return b;
    }));
    const is = this.inspBody.scrollTop;
    this.inspBody.replaceChildren(
      c ? h("h4", { class: "bc-ptitle" }, c.type === "text" ? "Text" : this.media.get(c.mediaId)?.name || TITLES[this.inspTool]) : h("h4", { class: "bc-ptitle" }, this.sel ? "Transition" : "Project"),
      this.inspTool ? this.panel(this.inspTool) : h("p", { class: "bc-hint" }, "Select a clip to edit it."));
    this.inspBody.scrollTop = is;
  }

  thumbInto(el, m) {
    if (m.kind === "audio") return;
    stripOf(m).then((s) => {
      el.style.backgroundImage = `url(${s.url})`;
      el.style.backgroundSize = `${(s.count * 100)}% 100%`;
      el.style.backgroundPosition = "0 0";
    }).catch(() => {});
  }

  toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  showBusy(text, frac, cancel) {
    if (text == null) { this.busy.hidden = true; return; }
    this.busy.hidden = false;
    this.busy.replaceChildren(h("div", { class: "bc-busy-card" },
      h("div", { class: "bc-ring", style: { "--p": Math.round((frac || 0) * 100) } }, h("span", {}, frac != null ? Math.round(frac * 100) + "%" : "")),
      h("p", {}, text), cancel ? h("button", { type: "button", class: "btn sm", onclick: cancel }, "Cancel") : null));
  }

  // ───────────────────────── Import & add ─────────────────────────
  importInto(target, fresh) {
    const accept = { main: "video/*,image/*", video: "video/*,image/*", audio: "audio/*,video/*", sticker: "image/*" }[target] || "*/*";
    this.fileInput.accept = accept;
    this.onFiles = async (files) => {
      if (!files.length) return;
      await store.persist();
      const added = [];
      for (let i = 0; i < files.length; i++) {
        this.showBusy(`Importing ${files[i].name}`, i / files.length);
        try { const m = await importFile(files[i], this.p.id); this.media.set(m.id, m); added.push(m); }
        catch (err) { this.toast(err.message); }
      }
      this.showBusy(null);
      if (!added.length) return;
      if (fresh && this.p.ratio === "original") {
        const v = added.find((m) => m.w);
        if (v) Object.assign(this.p, this.sizeFor("original", v));
      }
      this.change("Import", () => {
        let t = this.T, mainAt = null;
        for (const m of added) {
          if (target === "sticker") { this.addStickerImage(m, false); continue; }
          const k = m.kind === "audio" ? "audio" : target;
          const c = this.clipFor(m, k);
          if (k === "main" && mainAt !== null) {
            // keep the picked order: each next file goes right after the previous one
            const items = this.mainTrack().items;
            items.splice(items.indexOf(mainAt) + 1, 0, c);
            layoutMain(this.p);
            this.sel = c.id;
          } else this.place(c, k, t);
          if (k === "main") mainAt = c; else t += c.dur;
        }
      });
      if (fresh) this.layoutStage();
      for (const m of added) { if (m.hasAudio || m.kind === "audio") audioOf(m).catch(() => {}); }
    };
    this.fileInput.click();
  }

  sizeFor(ratio, m) {
    const s = ratioSize(ratio, 1080, m ? { w: m.w, h: m.h } : null);
    return { w: s.w, h: s.h };
  }

  clipFor(m, kind) {
    if (m.kind === "image") return newClip("image", { mediaId: m.id, dur: 3, in: 0, out: 0 });
    const type = m.kind === "audio" || kind === "audio" ? "audio" : "video";
    return newClip(type, { mediaId: m.id, in: 0, out: m.duration, dur: m.duration });
  }

  /** Put a clip on a track kind at time t (main: inserted at the playhead cut). */
  place(c, kind, t) {
    const p = this.p;
    if (kind === "main") {
      const items = this.mainTrack().items;
      let i = items.findIndex((x) => t < x.start + x.dur / 2);
      if (i < 0) i = items.length;
      items.splice(i, 0, c);
      layoutMain(p);
    } else {
      c.start = Math.max(0, t);
      trackFor(p, kind, c.start, c.dur).items.push(c);
    }
    this.sel = c.id;
  }

  addMedia(m, kind) {
    this.change("Add " + m.name, () => this.place(this.clipFor(m, kind), kind, this.T));
    this.closeTool();
  }

  addText(style) {
    const c = newTextClip("Enter text");
    if (style) { c.text = { ...c.text, ...clone(style.s), style: style.id }; c.text.stroke = { color: "#000", width: 0, ...(style.s.stroke || {}) }; c.text.bg = { color: "#000", opacity: 0, radius: 12, pad: 16, ...(style.s.bg || {}) }; c.text.shadow = { color: "#000", blur: 0, x: 0, y: 0, opacity: 0, ...(style.s.shadow || {}) }; if (style.s.font) ensureFont(style.s.font); }
    this.change("Add text", () => this.place(c, "text", this.T));
    this.openTool("textEdit");
  }

  addSticker(emoji) {
    const c = newClip("sticker", { emoji, dur: 3 });
    this.change("Add sticker", () => this.place(c, "sticker", this.T));
  }

  addStickerImage(m) {
    const c = newClip("sticker", { mediaId: m.id, dur: 3 });
    this.place(c, "sticker", this.T);
  }

  addEffect(e) {
    const c = this.clip();
    if (c && (c.type === "video" || c.type === "image")) {
      this.change("Effect: " + e.name, () => { c.effects.push({ id: e.id, amount: e.def }); });
      this.toast(`${e.name} added to the clip`);
      return;
    }
    const ec = newClip("effect", { effect: { id: e.id, amount: e.def }, dur: 3 });
    this.change("Effect: " + e.name, () => this.place(ec, "effect", this.T));
  }

  addFilter(f, target) {
    if (target) { this.change("Filter: " + f.name, () => { target.filter = { id: f.id, amount: target.filter?.amount ?? 100 }; }); return; }
    const fc = newClip("filter", { filter: { id: f.id, amount: 100 }, dur: 3 });
    this.change("Filter: " + f.name, () => this.place(fc, "filter", this.T));
  }

  addAdjustLayer() {
    const ac = newClip("adjust", { dur: 3 });
    this.change("Adjustment layer", () => this.place(ac, "adjust", this.T));
    this.openTool("adjustClip");
  }

  setRatio(r) {
    const first = this.mainTrack().items.map((c) => this.media.get(c.mediaId)).find((m) => m?.w);
    this.change("Ratio " + r, () => { this.p.ratio = r; Object.assign(this.p, this.sizeFor(r, first)); });
    this.layoutStage();
  }

  // ───────────────────────── Clip actions ─────────────────────────
  need(fn, msg = "Select a clip first") {
    const c = this.clip();
    if (!c) { this.toast(msg); return null; }
    return fn(c);
  }

  split() {
    this.need((c) => {
      if (this.T <= c.start || this.T >= clipEnd(c)) { this.toast("Move the playhead inside the clip to split it"); return; }
      let right;
      this.change("Split", () => { right = splitClip(this.p, c.id, this.T); });
      if (right) this.sel = right.id, this.refresh();
    });
  }

  remove() {
    if (this.sel?.startsWith("t:")) { const c = findClip(this.p, this.sel.slice(2))?.clip; if (c) this.change("Remove transition", () => { c.transition = null; }); this.sel = null; return; }
    this.need((c) => {
      const f = findClip(this.p, c.id);
      this.change("Delete", () => { f.track.items.splice(f.index, 1); });
      this.select(null);
    });
  }

  duplicate() {
    this.need((c) => {
      const f = findClip(this.p, c.id);
      const d = clone(c);
      d.id = uid();
      this.change("Duplicate", () => {
        if (f.track.kind === "main") { f.track.items.splice(f.index + 1, 0, d); layoutMain(this.p); }
        else { d.start = clipEnd(c); trackFor(this.p, f.track.kind, d.start, d.dur).items.push(d); }
      });
      this.select(d.id);
    });
  }

  mirror() { this.need((c) => this.change("Mirror", () => { c.transform.flipH = !c.transform.flipH; })); }
  rotate90() { this.need((c) => this.change("Rotate", () => { c.transform.rot = ((c.transform.rot + 90 + 540) % 360) - 180; })); }

  async freeze() {
    const c = this.clip();
    if (!c || c.type !== "video") { this.toast("Select a video clip"); return; }
    if (this.T < c.start || this.T > clipEnd(c)) { this.toast("Move the playhead inside the clip"); return; }
    const m = this.media.get(c.mediaId);
    const frames = new FrameCache();
    try {
      const src = await frames.frameAt("freeze", m, sourceTime(c, this.T - c.start));
      const cv = document.createElement("canvas");
      cv.width = src.width; cv.height = src.height;
      cv.getContext("2d").drawImage(src, 0, 0);
      const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
      const fm = await addGenerated(blob, `Freeze ${fmtTime(this.T)}.png`, this.p.id, { kind: "image", duration: 0, w: cv.width, h: cv.height });
      this.media.set(fm.id, fm);
      const f = findClip(this.p, c.id);
      this.change("Freeze frame", () => {
        const right = splitClip(this.p, c.id, this.T);
        const still = newClip("image", { mediaId: fm.id, dur: 3, in: 0, out: 0, transform: clone(c.transform), crop: clone(c.crop), filter: clone(c.filter), adjust: clone(c.adjust) });
        if (f.track.kind === "main") {
          const idx = f.track.items.indexOf(right || c) + (right ? 0 : 1);
          f.track.items.splice(idx, 0, still);
          layoutMain(this.p);
        } else { still.start = this.T; trackFor(this.p, f.track.kind, still.start, still.dur).items.push(still); if (right) right.start += 3; }
        this.sel = still.id;
      });
    } catch (err) { this.toast("Freeze failed: " + err.message); } finally { frames.clear(); }
  }

  async reverse() {
    const c = this.clip();
    if (!c || c.type !== "video") { this.toast("Select a video clip"); return; }
    if (c.reversedFrom) {
      this.change("Un-reverse", () => { Object.assign(c, c.reversedFrom); c.reversedFrom = null; });
      return;
    }
    const m = this.media.get(c.mediaId);
    const ctl = new AbortController();
    try {
      this.showBusy("Reversing…", 0, () => ctl.abort());
      const r = await reverseRange(m, await blobOf(m), c.in, c.out, (f) => this.showBusy("Reversing…", f, () => ctl.abort()));
      const rm = await addGenerated(r.blob, m.name.replace(/\.[^.]+$/, "") + " (reversed).mp4", this.p.id, { kind: "video", duration: r.duration, w: r.w, h: r.h, hasAudio: r.hasAudio });
      rm.fps = r.fps;
      this.media.set(rm.id, rm);
      this.change("Reverse", () => { c.reversedFrom = { mediaId: c.mediaId, in: c.in, out: c.out }; c.mediaId = rm.id; c.in = 0; c.out = r.duration; });
      if (rm.hasAudio) audioOf(rm).catch(() => {});
    } catch (err) { this.toast("Reverse failed: " + err.message); } finally { this.showBusy(null); }
  }

  extractAudio() {
    const c = this.clip();
    if (!c || c.type !== "video") { this.toast("Select a video clip"); return; }
    const m = this.media.get(c.mediaId);
    if (!m?.hasAudio) { this.toast("This clip has no audio"); return; }
    const a = newClip("audio", { mediaId: c.mediaId, in: c.in, out: c.out, dur: c.dur, speed: c.speed, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
    this.change("Extract audio", () => { c.mute = true; a.start = c.start; trackFor(this.p, "audio", a.start, a.dur).items.push(a); });
    this.select(a.id);
  }

  replace() {
    const c = this.clip();
    if (!c) return;
    this.fileInput.accept = c.type === "audio" ? "audio/*,video/*" : "video/*,image/*";
    this.onFiles = async ([file]) => {
      if (!file) return;
      try {
        this.showBusy("Importing " + file.name);
        const m = await importFile(file, this.p.id);
        this.media.set(m.id, m);
        this.change("Replace", () => {
          c.mediaId = m.id;
          if (m.kind === "image") { c.type = "image"; c.in = 0; c.out = 0; }
          else { c.type = m.kind === "audio" ? "audio" : c.type === "audio" ? "audio" : "video"; c.in = 0; c.out = Math.min(m.duration, c.dur * c.speed); c.dur = (c.out - c.in) / c.speed; }
          c.reversedFrom = null;
        });
      } catch (err) { this.toast(err.message); } finally { this.showBusy(null); }
    };
    this.fileInput.click();
  }

  toggleKeyframe() {
    const c = this.clip();
    if (!c) return;
    const lt = clamp(this.T - c.start, 0, c.dur);
    const has = keyframeTimes(c).some((t) => Math.abs(t - lt) < 1 / 30);
    this.change(has ? "Remove keyframe" : "Add keyframe", () => {
      if (has) removeKeyframe(c, lt);
      else {
        // first keyframe also pins the current values at the clip start so motion has a reference
        if (!keyframeTimes(c).length && lt > 0.05) setKeyframe(c, 0, KF_PROPS);
        setKeyframe(c, lt, KF_PROPS);
      }
    });
    this.toast(has ? "Keyframe removed" : "Keyframe added — move the playhead and change the clip to animate it");
  }

  // ───────────────────────── Audio tools ─────────────────────────
  async voiceover() {
    if (!navigator.mediaDevices?.getUserMedia) { this.toast("Recording isn't available in this browser"); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { this.toast("Microphone permission was denied"); return; }
    const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const start = this.T;
    const stop = () => { if (rec.state !== "inactive") rec.stop(); };
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    this.play();
    this.showBusy("Recording… tap Stop when you're done", null, stop);
    this.busy.querySelector(".btn").textContent = "Stop";
    await done;
    this.pause();
    stream.getTracks().forEach((t) => t.stop());
    this.showBusy(null);
    const blob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" });
    try {
      const buf = await audioContext().decodeAudioData(await blob.arrayBuffer());
      const m = await addGenerated(blob, `Voiceover ${new Date().toLocaleTimeString()}`, this.p.id, { kind: "audio", duration: buf.duration, hasAudio: true });
      this.media.set(m.id, m);
      const c = newClip("audio", { mediaId: m.id, in: 0, out: buf.duration, dur: buf.duration });
      this.change("Voiceover", () => this.place(c, "audio", start));
    } catch (err) { this.toast("Couldn't save the recording: " + err.message); }
  }

  // ───────────────────────── Captions ─────────────────────────
  captionClip(text, start, dur) {
    const s = TEXT_STYLES.find((x) => x.id === "subtitle");
    const c = newTextClip(text, { start, dur });
    Object.assign(c.text, clone(s.s), { size: 50, width: 0.9 });
    c.text.stroke = { color: "#000000", width: 6 };
    c.transform.y = 0.62;
    c.caption = true;
    return c;
  }

  importCaptions() {
    this.fileInput.accept = ".srt,.vtt,text/vtt,application/x-subrip";
    this.onFiles = async ([file]) => {
      if (!file) return;
      const cues = parseSubtitles(await file.text());
      if (!cues.length) { this.toast("No captions found in that file"); return; }
      this.change("Import captions", () => {
        const tr = { id: uid(), kind: "text", items: [], muted: false, hidden: false, locked: false };
        for (const q of cues) tr.items.push(this.captionClip(q.text, q.start, q.dur));
        this.p.tracks.push(tr);
      });
      this.toast(`Added ${cues.length} captions`);
    };
    this.fileInput.click();
  }

  exportCaptions() {
    const cues = [];
    for (const tr of this.p.tracks) if (tr.kind === "text") for (const c of tr.items) cues.push({ start: c.start, dur: c.dur, text: c.text.content });
    if (!cues.length) { this.toast("There's no text on the timeline"); return; }
    cues.sort((a, b) => a.start - b.start);
    download(new Blob([toSrt(cues)], { type: "application/x-subrip" }), (this.p.name || "captions") + ".srt");
  }

  async autoCaptions(status) {
    const say = (m) => { if (status) status.textContent = m; };
    const dur = this.duration();
    if (!dur) { this.toast("Add a video with speech first"); return; }
    say("Preparing audio…");
    const samples = await speechSamples(this.p, this.media, dur);
    if (!samples) { say("There's no audio to transcribe."); return; }
    const st = this.captionState || { model: "onnx-community/whisper-tiny", language: "auto" };
    const worker = new Worker(new URL("./cut-captions-worker.js" + new URL(import.meta.url).search, import.meta.url), { type: "module" });
    this.showBusy("Loading speech model…", 0, () => worker.terminate());
    try {
      const segs = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
          const d = e.data;
          if (d.type === "download") { this.showBusy("Downloading speech model…", d.progress, () => { worker.terminate(); reject(new Error("Cancelled")); }); say(`Downloading model ${Math.round(d.progress * 100)}%`); }
          if (d.type === "transcribing") { this.showBusy("Listening…", null, () => { worker.terminate(); reject(new Error("Cancelled")); }); say("Transcribing…"); }
          if (d.type === "done") resolve(d.segments);
          if (d.type === "error") reject(new Error(d.error));
        };
        worker.onerror = (e) => reject(new Error(e.message || "Speech model failed to load"));
        worker.postMessage({ audio: samples, model: st.model, language: st.language }, [samples.buffer]);
      });
      const cues = segs.filter((s) => s.text && s.end > s.start);
      if (!cues.length) { say("No speech was found."); return; }
      this.change("Auto captions", () => {
        const tr = { id: uid(), kind: "text", items: [], muted: false, hidden: false, locked: false };
        for (const s of cues) tr.items.push(this.captionClip(s.text, s.start, Math.max(0.3, s.end - s.start)));
        this.p.tracks.push(tr);
      });
      say(`Added ${cues.length} captions.`);
      this.toast(`Added ${cues.length} captions`);
    } catch (err) { say("Captions failed: " + err.message); } finally { worker.terminate(); this.showBusy(null); }
  }

  // ───────────────────────── Export ─────────────────────────
  paintRes() { this.resChip.textContent = (RESOLUTIONS.find(([r]) => r === this.exportOpts.res)?.[1] || "1080p").toUpperCase(); }

  exportSheet() {
    this.pause();
    const o = this.exportOpts;
    const chips = (list, key, fmt) => {
      const seg = segmented(list.map((v) => [String(Array.isArray(v) ? v[0] : v), fmt(v)]), String(o[key]), (v) => { o[key] = isNaN(+v) ? v : +v; seg.set(v); this.paintRes(); });
      return seg.el;
    };
    const dur = this.duration();
    const dlg = h("dialog", { class: "bc-dialog" },
      h("h3", {}, "Export"),
      h("div", { class: "bc-exrow" }, h("span", {}, "Resolution"), chips(RESOLUTIONS, "res", (r) => r[1])),
      h("div", { class: "bc-exrow" }, h("span", {}, "Frame rate"), chips(FRAME_RATES, "fps", (f) => String(f))),
      h("div", { class: "bc-exrow" }, h("span", {}, "Quality"), chips(["low", "medium", "high", "best"], "quality", (q) => q[0].toUpperCase() + q.slice(1))),
      h("div", { class: "bc-exrow" }, h("span", {}, "Format"), chips(["mp4", "webm"], "format", (f) => f.toUpperCase())),
      h("label", { class: "pd-check" }, h("input", { type: "checkbox", checked: o.audio, onchange: (e) => { o.audio = e.target.checked; } }), "Include audio"),
      h("p", { class: "bc-hint" }, `Length ${fmtTime(dur, true)}. Rendering happens on this device; keep this tab open.`),
      h("div", { class: "pd-row bc-exact" },
        h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Cancel"),
        h("button", { type: "button", class: "btn primary", onclick: () => { dlg.close(); this.runExport(); } }, "Export")));
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  async runExport() {
    try { localStorage.setItem("wisp.cut.export", JSON.stringify(this.exportOpts)); } catch { /* private mode */ }
    this.flushSave();
    const ctl = new AbortController();
    const t0 = performance.now();
    try {
      this.showBusy("Preparing…", 0, () => ctl.abort());
      const blob = await exportVideo(this.p, this.media, this.exportOpts, (f, msg) => this.showBusy(msg, f, () => ctl.abort()), ctl.signal);
      this.showBusy(null);
      const name = `${(this.p.name || "video").replace(/[\\/:*?"<>|]+/g, "_")}.${this.exportOpts.format}`;
      this.exportDone(blob, name, (performance.now() - t0) / 1000);
    } catch (err) {
      this.showBusy(null);
      this.toast(err.message === "Export cancelled" ? "Export cancelled" : "Export failed: " + err.message);
    }
  }

  exportDone(blob, name, secs) {
    const url = URL.createObjectURL(blob);
    const file = new File([blob], name, { type: blob.type });
    const canShare = navigator.canShare?.({ files: [file] });
    const dlg = h("dialog", { class: "bc-dialog" },
      h("h3", {}, "Your video is ready"),
      h("video", { class: "bc-result", src: url, controls: true, playsinline: true }),
      h("p", { class: "bc-hint" }, `${(blob.size / 1e6).toFixed(1)} MB · made in ${Math.round(secs)}s`),
      h("div", { class: "pd-row bc-exact" },
        h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Done"),
        canShare ? h("button", { type: "button", class: "btn", onclick: () => navigator.share({ files: [file] }).catch(() => {}) }, "Share / Save to Photos") : null,
        h("button", { type: "button", class: "btn primary", onclick: () => download(blob, name) }, "Download")));
    dlg.addEventListener("close", () => { dlg.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); });
    document.body.append(dlg);
    dlg.showModal();
  }

  async saveFrame() {
    try {
      const blob = await exportFrame(this.p, this.media, this.T);
      download(blob, `${this.p.name || "frame"}-${fmtTime(this.T).replace(":", "-")}.png`);
    } catch (err) { this.toast(err.message); }
  }

  fullscreen() {
    const el = this.player;
    if (document.fullscreenElement) document.exitFullscreen();
    else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  }

  // ───────────────────────── Keyboard ─────────────────────────
  key(e) {
    if (this.root.dataset.screen !== "editor" || e.target.closest?.("input, textarea, select, dialog")) return;
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    const step = 1 / (this.p?.fps || 30);
    if (k === " ") { e.preventDefault(); this.toggle(); }
    else if (mod && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    else if (mod && k.toLowerCase() === "y") { e.preventDefault(); this.redo(); }
    else if (mod && k.toLowerCase() === "d") { e.preventDefault(); this.duplicate(); }
    else if (mod && k.toLowerCase() === "b" || (!mod && (k === "s" || k === "S"))) { e.preventDefault(); this.split(); }
    else if (k === "Delete" || k === "Backspace") { e.preventDefault(); this.remove(); }
    else if (k === "ArrowLeft") { e.preventDefault(); this.pause(); this.seek(this.T - (e.shiftKey ? 1 : step)); }
    else if (k === "ArrowRight") { e.preventDefault(); this.pause(); this.seek(this.T + (e.shiftKey ? 1 : step)); }
    else if (k === "Home") { this.seek(0); }
    else if (k === "End") { this.seek(this.duration()); }
    else if (k === "+" || k === "=") { this.tl.setZoom(this.tl.pps * 1.4); }
    else if (k === "-") { this.tl.setZoom(this.tl.pps / 1.4); }
    else if (k === "k" || k === "K") { this.toggleKeyframe(); }
    else if (k === "Escape") { if (this.tool) this.closeTool(); else this.select(null); }
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function initCut() {
  const root = $("#cutRoot");
  if (!root || app) return;
  try { app = new Editor(root); }
  catch (err) { root.textContent = "BoetyCut couldn't start: " + err.message; return; }
  addEventListener("keydown", (e) => { if (!$("#view-cut").hidden) app.key(e); });
  addEventListener("pagehide", () => app.flushSave());
}

export function showCut(visible) {
  if (!app) return;
  if (visible) { app.layoutStage(); if (app.root.dataset.screen === "home") app.showHome(); }
  else { app.pause(); app.flushSave(); }
}
