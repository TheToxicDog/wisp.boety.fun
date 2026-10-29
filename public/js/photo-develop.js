// Photos: the Develop module — live preview, adjustment panels, crop &
// straighten, healing, masking, white-balance picker, before/after, history,
// snapshots and presets.
import {
  BANDS, BAND_COLORS, PROFILES, BUILTIN_PRESETS, WB_PRESETS_RAW, WB_PRESETS_IMG, CURVE_PRESETS, LABELS, LOCAL,
  defaults, clone, serialize, curveLuts, geometry, constrainCrop, applyPartial, parametric,
} from "./photo-params.js";
import { h, svgIcon, slider, panel, segmented, selectBox, colorWheel, curveEditor, drawHistogram, hueGradient, hsv2rgb } from "./photo-ui.js";
import { summary } from "./photo-exif.js";

const MAX_PX = 2.2e6;
const DRAFT_PX = 0.3e6;
const ASPECTS = [
  ["free", "Custom"], ["orig", "Original"], ["1:1", "1 × 1"], ["4:5", "4 × 5 / 8 × 10"], ["5:7", "5 × 7"],
  ["2:3", "2 × 3 / 4 × 6"], ["3:4", "3 × 4"], ["16:9", "16 × 9"], ["16:10", "16 × 10"], ["65:24", "Panorama"],
];
const I = {
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
  heal: '<circle cx="9" cy="15" r="5"/><circle cx="16" cy="7" r="4" stroke-dasharray="2 2"/><path d="M12.5 11.5l1.2-1.2"/>',
  mask: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  wb: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  ba: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  rotl: '<path d="M4 4v6h6"/><path d="M4.5 10A8 8 0 1 1 6 17"/>',
  rotr: '<path d="M20 4v6h-6"/><path d="M19.5 10A8 8 0 1 0 18 17"/>',
  fliph: '<path d="M12 3v18"/><path d="M8 7L3 12l5 5z"/><path d="M16 7l5 5-5 5z"/>',
  flipv: '<path d="M3 12h18"/><path d="M7 8l5-5 5 5z"/><path d="M7 16l5 5 5-5z"/>',
  level: '<path d="M3 17L21 7"/><path d="M3 12h18" stroke-dasharray="2 3"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

export class Develop {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.photo = null;
    this.info = null;
    this.s = null; // current settings
    this.hist = { list: [], at: -1 };
    this.tool = null;
    this.zoom = "fit";
    this.center = [0.5, 0.5];
    this.compare = "off";
    this.split = 0.5;
    this.clip = { highlights: false, shadows: false };
    this.shown = null;
    this.before = null;
    this.lastHist = null;
    this.selMask = -1;
    this.selSpot = -1;
    this.brush = { size: 0.03, feather: 60, flow: 80, erase: false };
    this.spotOpts = { mode: "heal", size: 0.02, feather: 50, opacity: 100 };
    this.cropOpts = { aspect: "orig", lock: true, constrain: true };
    this.overlayMask = false;
    this.controls = [];
    this.renderGen = 0;
    this.build();
  }

  // ───────────────────────── DOM ─────────────────────────
  build() {
    this.canvas = h("canvas", { class: "pd-canvas" });
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("class", "pd-overlay");
    this.status = h("div", { class: "pd-status", hidden: true });
    this.stage = h("div", { class: "pd-stage", tabindex: "0" }, this.canvas, this.svg, this.status);
    this.zoomSel = segmented([["fit", "Fit"], ["fill", "Fill"], ["1", "1:1"], ["2", "2:1"]], "fit", (v) => this.setZoom(v === "fit" || v === "fill" ? v : +v), "pd-zoom");
    this.compareSel = segmented([["off", "Edit"], ["toggle", "Before"], ["split", "Split"], ["side", "Side by side"]], "off", (v) => this.setCompare(v), "pd-compare");
    this.infoLine = h("span", { class: "pd-info" });
    this.toolbar = h("div", { class: "pd-toolbar" }, this.compareSel.el, this.infoLine, this.zoomSel.el);
    this.center_ = h("div", { class: "pd-center" }, this.stage, this.toolbar);

    // Left panels
    this.navCanvas = h("canvas", { class: "pd-nav" });
    this.presetList = h("div", { class: "pd-list" });
    this.snapList = h("div", { class: "pd-list" });
    this.histList = h("div", { class: "pd-list pd-history" });
    const pNav = panel("Navigator", { id: "nav" });
    pNav.body.append(this.navCanvas);
    const pPre = panel("Presets", { id: "presets" });
    pPre.body.append(h("div", { class: "pd-row" },
      h("button", { class: "btn sm", type: "button", onclick: () => this.savePreset() }, "+ New preset")), this.presetList);
    const pSnap = panel("Snapshots", { id: "snapshots", open: false });
    pSnap.body.append(h("div", { class: "pd-row" }, h("button", { class: "btn sm", type: "button", onclick: () => this.snapshot() }, "+ Snapshot")), this.snapList);
    const pHist = panel("History", { id: "history" });
    pHist.body.append(h("div", { class: "pd-row" },
      h("button", { class: "btn sm", type: "button", onclick: () => this.undo() }, svgIcon(I.undo, 16), "Undo"),
      h("button", { class: "btn sm", type: "button", onclick: () => this.redo() }, svgIcon(I.redo, 16), "Redo"),
      h("button", { class: "btn sm ghost", type: "button", onclick: () => this.clearHistory() }, "Clear")), this.histList);
    this.left = h("div", { class: "pd-left ph-scroll" }, pNav.el, pPre.el, pSnap.el, pHist.el,
      h("div", { class: "pd-row pd-copy" },
        h("button", { class: "btn sm", type: "button", onclick: () => this.app.copySettings() }, "Copy…"),
        h("button", { class: "btn sm", type: "button", onclick: () => this.app.pasteSettings() }, "Paste")));

    // Right panels
    this.histCanvas = h("canvas", { class: "pd-hist" });
    this.histInfo = h("div", { class: "pd-hist-info" });
    this.toolDrawer = h("div", { class: "pd-drawer", hidden: true });
    const tools = [["crop", "Crop & Straighten (R)", I.crop], ["heal", "Healing (Q)", I.heal], ["mask", "Masking (M)", I.mask], ["wb", "White Balance Selector (W)", I.wb]];
    this.toolBtns = {};
    const strip = h("div", { class: "pd-tools" }, tools.map(([t, title, icon]) => {
      const b = h("button", { type: "button", class: "pd-tool", title, "aria-label": title }, svgIcon(icon));
      b.addEventListener("click", () => this.setTool(this.tool === t ? null : t));
      this.toolBtns[t] = b;
      return b;
    }));
    this.panels = h("div", { class: "pd-panels" });
    this.right = h("div", { class: "pd-right ph-scroll" },
      h("div", { class: "pd-histwrap" }, this.histCanvas, this.histInfo), strip, this.toolDrawer, this.panels,
      h("div", { class: "pd-row pd-bottom" },
        h("button", { class: "btn sm", type: "button", onclick: () => this.app.previousSettings() }, "Previous"),
        h("button", { class: "btn sm", type: "button", onclick: () => this.resetAll() }, "Reset")));
    this.buildPanels();
    this.bindStage();
    this.bindHistogram();
    new ResizeObserver(() => this.redraw(true)).observe(this.stage);
  }

  // Register a control so refresh() can repaint it from settings.
  reg(c, read) { this.controls.push({ c, read }); return c.el; }

  sl(key, label, min, max, o = {}) {
    const def = () => (this.defaults ? this.defaults[key] : 0);
    const c = slider({
      key, label, min, max, step: o.step ?? 1, def: o.def ?? 0, gradient: o.gradient, fmt: o.fmt, signed: o.signed,
      onInput: (v) => { this.s[key] = v; if (o.after) o.after(v); this.schedule(true); },
      onCommit: (v, lab) => { this.s[key] = v; this.commit(lab || `${LABELS[key] || label} ${fmtVal(v, o.step)}`); },
      onAuto: o.onAuto,
    });
    // defaults vary per photo (raw sharpening etc.)
    const set = c.set;
    c.set = (v) => { set(v); c.el.classList.toggle("changed", Math.abs(v - def()) > 1e-9); };
    return this.reg(c, () => this.s[key]);
  }

  buildPanels() {
    const P = this.panels;
    const add = (title, id, fill, groups) => {
      const p = panel(title, { id, open: id === "basic" || id === "curve", onReset: groups ? () => this.resetKeys(groups, title) : null });
      fill(p.body);
      P.append(p.el);
      return p;
    };

    // ── Basic
    add("Basic", "basic", (b) => {
      const treat = segmented([["0", "Color"], ["1", "Black & White"]], "0", (v) => { this.s.treatment = +v; this.commit(+v ? "Black & White" : "Color"); });
      this.reg(treat, () => String(this.s.treatment ? 1 : 0));
      const prof = selectBox(Object.entries(PROFILES).map(([k, p]) => [k, p.name]), "color", (v) => { this.s.profile = v; this.commit("Profile: " + PROFILES[v].name); });
      this.reg(prof, () => this.s.profile);
      const wbSel = h("select", { class: "ps-select" });
      wbSel.addEventListener("change", () => this.setWB(wbSel.value));
      this.wbSel = wbSel;
      const pickBtn = h("button", { class: "icon-btn sm", type: "button", title: "White Balance Selector (W)", onclick: () => this.setTool(this.tool === "wb" ? null : "wb") }, svgIcon(I.wb, 18));
      this.tempSlot = h("div");
      this.tintSlot = h("div");
      b.append(
        h("div", { class: "pd-field" }, h("span", {}, "Treatment"), treat.el),
        h("div", { class: "pd-field" }, h("span", {}, "Profile"), prof.el),
        this.sl("profile_amount", "Amount", 0, 200, { def: 100, signed: false }),
        h("div", { class: "pd-field" }, h("span", {}, "WB"), wbSel, pickBtn),
        this.tempSlot, this.tintSlot,
        h("div", { class: "pd-sub" }, h("span", {}, "Tone"), h("button", { class: "btn sm", type: "button", onclick: () => this.autoTone() }, "Auto")),
        this.sl("exposure", "Exposure", -5, 5, { step: 0.01, gradient: "linear-gradient(90deg,#222,#ddd)" }),
        this.sl("contrast", "Contrast", -100, 100, { gradient: "linear-gradient(90deg,#666,#777 50%,#222 50%,#eee)" }),
        this.sl("highlights", "Highlights", -100, 100, { gradient: "linear-gradient(90deg,#444,#eee)" }),
        this.sl("shadows", "Shadows", -100, 100, { gradient: "linear-gradient(90deg,#111,#888)" }),
        this.sl("whites", "Whites", -100, 100, { gradient: "linear-gradient(90deg,#666,#fff)", onAuto: () => this.autoPoint("whites") }),
        this.sl("blacks", "Blacks", -100, 100, { gradient: "linear-gradient(90deg,#000,#666)", onAuto: () => this.autoPoint("blacks") }),
        h("div", { class: "pd-sub" }, h("span", {}, "Presence")),
        this.sl("texture", "Texture", -100, 100),
        this.sl("clarity", "Clarity", -100, 100),
        this.sl("dehaze", "Dehaze", -100, 100),
        this.sl("vibrance", "Vibrance", -100, 100, { gradient: "linear-gradient(90deg,#8a8a8a,#d9a441,#3fa5d9)" }),
        this.sl("saturation", "Saturation", -100, 100, { gradient: "linear-gradient(90deg,#888," + "#e33 30%,#e9c63b 50%,#3c8 70%,#36f)" }),
      );
    }, ["White Balance", "Basic Tone", "Presence", "Treatment & Profile"]);

    // ── Tone Curve
    add("Tone Curve", "curve", (b) => {
      this.curveMode = "param";
      this.curveCh = "rgb";
      const modeSel = segmented([["param", "Parametric"], ["point", "Point"]], "param", (v) => { this.curveMode = v; modeSel.set(v); this.paintCurve(); });
      const chSel = segmented([["rgb", "RGB"], ["r", "R"], ["g", "G"], ["b", "B"]], "rgb", (v) => { this.curveCh = v; chSel.set(v); this.paintCurve(); }, "pd-ch");
      this.curveChSel = chSel;
      let regionDrag = null;
      this.curve = curveEditor({
        onInput: (pts) => { this.s.curve[this.curveCh] = pts; this.paintCurve(); this.schedule(true); },
        onCommit: (pts) => { this.s.curve[this.curveCh] = pts; this.commit("Point Curve"); },
      });
      // Parametric mode: drag vertically in the curve to move the region under the pointer.
      this.curveParam = {
        down: (e, [x]) => { regionDrag = { key: this.paramRegion(x), y: e.clientY }; regionDrag.v0 = this.s[regionDrag.key]; },
        move: (e) => {
          if (!regionDrag) return;
          const v = Math.max(-100, Math.min(100, Math.round(regionDrag.v0 + (regionDrag.y - e.clientY) / 1.5)));
          this.s[regionDrag.key] = v; this.refresh(); this.schedule(true);
        },
        up: () => { if (regionDrag) this.commit(LABELS[regionDrag.key]); regionDrag = null; },
      };
      const presets = selectBox([["", "Point curve…"], ...Object.keys(CURVE_PRESETS).map((k) => [k, k])], "", (v) => {
        if (!v) return;
        this.s.curve.rgb = clone(CURVE_PRESETS[v]); this.curveMode = "point"; modeSel.set("point");
        this.commit("Point Curve: " + v); presets.set("");
      });
      this.paramBox = h("div", {},
        this.sl("pc_highlights", "Highlights", -100, 100),
        this.sl("pc_lights", "Lights", -100, 100),
        this.sl("pc_darks", "Darks", -100, 100),
        this.sl("pc_shadows", "Shadows", -100, 100),
        h("div", { class: "pd-sub" }, h("span", {}, "Region splits")),
        this.sl("pc_split1", "Shadows | Darks", 10, 45, { def: 25, signed: false, after: () => this.paintCurve() }),
        this.sl("pc_split2", "Darks | Lights", 30, 70, { def: 50, signed: false, after: () => this.paintCurve() }),
        this.sl("pc_split3", "Lights | Highlights", 55, 90, { def: 75, signed: false, after: () => this.paintCurve() }));
      this.pointBox = h("div", { class: "pd-row" }, chSel.el, presets.el,
        h("button", { class: "btn sm ghost", type: "button", onclick: () => { this.s.curve[this.curveCh] = [[0, 0], [1, 1]]; this.commit("Reset Curve"); } }, "Reset"));
      this.curveModeSel = modeSel;
      b.append(h("div", { class: "pd-row" }, modeSel.el,
        h("button", { class: "icon-btn sm", type: "button", title: "Targeted adjustment: drag on the photo", onclick: () => this.setTool(this.tool === "tat-curve" ? null : "tat-curve") }, svgIcon(I.target, 18))),
        this.curve.el, this.pointBox, this.paramBox);
    }, ["Tone Curve"]);

    // ── Color Mixer / B&W
    add("Color Mixer", "hsl", (b) => {
      this.hslTab = "hue";
      const tabs = segmented([["hue", "Hue"], ["sat", "Saturation"], ["lum", "Luminance"], ["all", "All"]], "hue", (v) => { this.hslTab = v; tabs.set(v); this.paintHsl(); });
      this.hslBoxes = {};
      const hueGrad = (i) => {
        const c = BAND_COLORS[i];
        const n = BAND_COLORS[(i + 1) % 8], p = BAND_COLORS[(i + 7) % 8];
        return `linear-gradient(90deg,${p},${c},${n})`;
      };
      for (const t of ["hue", "sat", "lum", "gray"]) {
        this.hslBoxes[t] = h("div", { class: "pd-hslbox" }, h("div", { class: "pd-sub" }, h("span", {}, { hue: "Hue", sat: "Saturation", lum: "Luminance", gray: "Black & White Mix" }[t])),
          BANDS.map((band, i) => this.sl(`${t}_${band}`, band[0].toUpperCase() + band.slice(1), -100, 100, {
            gradient: t === "hue" ? hueGrad(i) : t === "sat" ? `linear-gradient(90deg,#888,${BAND_COLORS[i]})` : `linear-gradient(90deg,#111,${BAND_COLORS[i]},#fff)`,
          })));
      }
      this.hslTabs = tabs;
      this.hslHead = h("div", { class: "pd-row" }, tabs.el,
        h("button", { class: "icon-btn sm", type: "button", title: "Targeted adjustment: drag up/down on a colour in the photo", onclick: () => this.setTool(this.tool === "tat-hsl" ? null : "tat-hsl") }, svgIcon(I.target, 18)));
      b.append(this.hslHead, ...Object.values(this.hslBoxes));
    }, ["Color Mixer"]);

    // ── Color Grading
    add("Color Grading", "grading", (b) => {
      const zones = [["shadow", "Shadows"], ["mid", "Midtones"], ["high", "Highlights"], ["global", "Global"]];
      const grid = h("div", { class: "pd-wheels" });
      for (const [z, name] of zones) {
        const label = h("div", { class: "pd-wheel-val" });
        const w = colorWheel({
          size: 112,
          onInput: (hh, ss) => { this.s[`cg_${z}_hue`] = hh; this.s[`cg_${z}_sat`] = ss; label.textContent = `H ${hh}  S ${ss}`; this.schedule(true); },
          onCommit: () => this.commit(`${name} Grading`),
        });
        this.reg({ el: w.el, set: () => { w.set(this.s[`cg_${z}_hue`], this.s[`cg_${z}_sat`]); label.textContent = `H ${this.s[`cg_${z}_hue`]}  S ${this.s[`cg_${z}_sat`]}`; } }, () => 0);
        grid.append(h("div", { class: "pd-wheel" }, h("div", { class: "pd-wheel-name" }, name), w.el, label,
          this.sl(`cg_${z}_lum`, "Luminance", -100, 100, { gradient: "linear-gradient(90deg,#111,#eee)" })));
      }
      b.append(grid,
        this.sl("cg_blending", "Blending", 0, 100, { def: 50, signed: false }),
        this.sl("cg_balance", "Balance", -100, 100));
    }, ["Color Grading"]);

    // ── Detail
    add("Detail", "detail", (b) => {
      b.append(h("p", { class: "pd-hint" }, "Zoom to 1:1 or closer to judge sharpening and noise reduction."),
        h("div", { class: "pd-sub" }, h("span", {}, "Sharpening")),
        this.sl("sharp_amount", "Amount", 0, 150, { signed: false }),
        this.sl("sharp_radius", "Radius", 0.5, 3, { step: 0.1, def: 1, signed: false }),
        this.sl("sharp_detail", "Detail", 0, 100, { def: 25, signed: false }),
        this.sl("sharp_masking", "Masking", 0, 100, { signed: false }),
        h("div", { class: "pd-sub" }, h("span", {}, "Noise Reduction")),
        this.sl("nr_lum", "Luminance", 0, 100, { signed: false }),
        this.sl("nr_lum_detail", "Detail", 0, 100, { def: 50, signed: false }),
        this.sl("nr_lum_contrast", "Contrast", 0, 100, { signed: false }),
        this.sl("nr_color", "Color", 0, 100, { signed: false }),
        this.sl("nr_color_detail", "Detail", 0, 100, { def: 50, signed: false }),
        this.sl("nr_color_smooth", "Smoothness", 0, 100, { def: 50, signed: false }));
    }, ["Detail"]);

    // ── Lens Corrections
    add("Lens Corrections", "lens", (b) => {
      b.append(
        h("div", { class: "pd-sub" }, h("span", {}, "Distortion & Vignetting")),
        this.sl("lens_distortion", "Distortion", -100, 100),
        this.sl("lens_vignette", "Vignetting", -100, 100),
        this.sl("lens_vignette_mid", "Midpoint", 0, 100, { def: 50, signed: false }),
        h("div", { class: "pd-sub" }, h("span", {}, "Chromatic Aberration")),
        this.sl("ca_red", "Red / Cyan", -100, 100, { gradient: "linear-gradient(90deg,#2cc,#e33)" }),
        this.sl("ca_blue", "Blue / Yellow", -100, 100, { gradient: "linear-gradient(90deg,#ec3,#36f)" }),
        h("div", { class: "pd-sub" }, h("span", {}, "Defringe")),
        this.sl("defringe_purple", "Purple Amount", 0, 20, { signed: false, gradient: "linear-gradient(90deg,#666,#a3f)" }),
        this.sl("defringe_green", "Green Amount", 0, 20, { signed: false, gradient: "linear-gradient(90deg,#666,#3c5)" }));
    }, ["Lens Corrections"]);

    // ── Transform
    add("Transform", "transform", (b) => {
      const k = (key, label, min, max, o = {}) => this.sl(key, label, min, max, { ...o, after: () => this.constrain() });
      const levelBtn = h("button", { class: "btn sm", type: "button", onclick: () => { this.setTool("crop"); this.cropDrawStraighten = true; this.toast("Draw a line along something that should be level or upright"); } }, svgIcon(I.level, 16), "Straighten");
      b.append(h("div", { class: "pd-row" }, levelBtn,
        h("button", { class: "btn sm ghost", type: "button", onclick: () => this.resetKeys(["Transform"], "Transform") }, "Off")),
        k("tr_vertical", "Vertical", -100, 100),
        k("tr_horizontal", "Horizontal", -100, 100),
        k("tr_rotate", "Rotate", -10, 10, { step: 0.1 }),
        k("tr_aspect", "Aspect", -100, 100),
        k("tr_scale", "Scale", 50, 150, { def: 100, signed: false }),
        k("tr_x", "X Offset", -100, 100, { step: 0.1 }),
        k("tr_y", "Y Offset", -100, 100, { step: 0.1 }));
    }, ["Transform"]);

    // ── Effects
    add("Effects", "effects", (b) => {
      const style = selectBox([["0", "Highlight Priority"], ["1", "Color Priority"], ["2", "Paint Overlay"]], "0", (v) => { this.s.vig_style = +v; this.commit("Vignette Style"); });
      this.reg(style, () => String(this.s.vig_style | 0));
      b.append(h("div", { class: "pd-sub" }, h("span", {}, "Post-Crop Vignetting")),
        h("div", { class: "pd-field" }, h("span", {}, "Style"), style.el),
        this.sl("vig_amount", "Amount", -100, 100, { gradient: "linear-gradient(90deg,#000,#888,#fff)" }),
        this.sl("vig_mid", "Midpoint", 0, 100, { def: 50, signed: false }),
        this.sl("vig_round", "Roundness", -100, 100),
        this.sl("vig_feather", "Feather", 0, 100, { def: 50, signed: false }),
        this.sl("vig_highlights", "Highlights", 0, 100, { signed: false }),
        h("div", { class: "pd-sub" }, h("span", {}, "Grain")),
        this.sl("grain_amount", "Amount", 0, 100, { signed: false }),
        this.sl("grain_size", "Size", 0, 100, { def: 25, signed: false }),
        this.sl("grain_rough", "Roughness", 0, 100, { def: 50, signed: false }));
    }, ["Effects"]);

    // ── Calibration
    add("Calibration", "calibration", (b) => {
      b.append(
        this.sl("cal_shadows", "Shadows Tint", -100, 100, { gradient: "linear-gradient(90deg,#3c5,#c3c)" }),
        h("div", { class: "pd-sub" }, h("span", {}, "Red Primary")),
        this.sl("cal_red_hue", "Hue", -100, 100, { gradient: "linear-gradient(90deg,#e3a,#e33,#e93)" }),
        this.sl("cal_red_sat", "Saturation", -100, 100, { gradient: "linear-gradient(90deg,#888,#e33)" }),
        h("div", { class: "pd-sub" }, h("span", {}, "Green Primary")),
        this.sl("cal_green_hue", "Hue", -100, 100, { gradient: "linear-gradient(90deg,#cc3,#3c3,#3cc)" }),
        this.sl("cal_green_sat", "Saturation", -100, 100, { gradient: "linear-gradient(90deg,#888,#3c3)" }),
        h("div", { class: "pd-sub" }, h("span", {}, "Blue Primary")),
        this.sl("cal_blue_hue", "Hue", -100, 100, { gradient: "linear-gradient(90deg,#3cc,#36f,#a3f)" }),
        this.sl("cal_blue_sat", "Saturation", -100, 100, { gradient: "linear-gradient(90deg,#888,#36f)" }));
    }, ["Calibration"]);
  }

  // White balance sliders differ for raw (Kelvin) and rendered files (relative).
  buildWB() {
    const raw = !!this.info?.isRaw;
    if (this.wbKind === raw) return;
    this.wbKind = raw;
    this.controls = this.controls.filter((c) => c.c.key !== "temp" && c.c.key !== "tint");
    const kelvin = { to: (k) => Math.round((500 - 1e6 / k) / 0.48), from: (p) => Math.round(1e6 / (500 - p * 0.48) / 10) * 10 };
    let temp;
    if (raw) {
      const c = slider({
        key: "temp", label: "Temp", min: 0, max: 1000, step: 1, def: kelvin.to(this.info.asShotTemp || 5500),
        fmt: (p) => String(kelvin.from(p)), gradient: "linear-gradient(90deg,#3a6df0,#ddd,#f0c23a)",
        onInput: (p) => { this.s.temp = kelvin.from(p); this.s.wb = "Custom"; this.wbSel.value = "Custom"; this.schedule(true); },
        onCommit: (p) => { this.s.temp = kelvin.from(p); this.s.wb = "Custom"; this.commit("Temp " + this.s.temp); },
      });
      const set = c.set;
      c.set = (k) => set(kelvin.to(k));
      temp = c;
    } else {
      temp = slider({
        key: "temp", label: "Temp", min: -100, max: 100, def: 0, gradient: "linear-gradient(90deg,#3a6df0,#ddd,#f0c23a)",
        onInput: (v) => { this.s.temp = v; this.s.wb = "Custom"; this.wbSel.value = "Custom"; this.schedule(true); },
        onCommit: (v) => { this.s.temp = v; this.s.wb = "Custom"; this.commit("Temp " + fmtVal(v)); },
      });
    }
    const tint = slider({
      key: "tint", label: "Tint", min: raw ? -150 : -100, max: raw ? 150 : 100, def: raw ? Math.round(this.info.asShotTint || 0) : 0,
      gradient: "linear-gradient(90deg,#3c5,#ddd,#d3c)",
      onInput: (v) => { this.s.tint = v; this.s.wb = "Custom"; this.wbSel.value = "Custom"; this.schedule(true); },
      onCommit: (v) => { this.s.tint = v; this.s.wb = "Custom"; this.commit("Tint " + fmtVal(v)); },
    });
    this.tempSlot.replaceChildren(temp.el);
    this.tintSlot.replaceChildren(tint.el);
    this.reg(temp, () => this.s.temp);
    this.reg(tint, () => this.s.tint);
    this.wbSel.replaceChildren(...(raw ? WB_PRESETS_RAW : WB_PRESETS_IMG).map(([n]) => h("option", { value: n }, n)));
  }

  // ───────────────────────── Open / state ─────────────────────────
  async open(photo) {
    this.photo = photo;
    this.tool = null;
    this.selMask = -1;
    this.selSpot = -1;
    this.shown = null;
    this.before = null;
    this.zoom = "fit";
    this.zoomSel.set("fit");
    this.center = [0.5, 0.5];
    this.paintTools();
    const gen = ++this.renderGen;
    this.showStatus("Loading…");
    this.drawPlaceholder();
    let info;
    try {
      info = await this.app.ensureOpen(photo, (msg) => this.showStatus(msg));
    } catch (err) {
      this.showStatus("Couldn't open this photo: " + err.message);
      return;
    }
    if (gen !== this.renderGen || this.photo !== photo) return;
    this.info = info;
    this.defaults = defaults(info);
    this.s = await this.app.resolveSettings(photo, info);
    this.hist = { list: photo.history?.length ? photo.history : [{ label: "Import", s: clone(this.defaults) }], at: 0 };
    this.hist.at = Math.min(photo.historyAt ?? this.hist.list.length - 1, this.hist.list.length - 1);
    if (!photo.history?.length && photo.settings) this.hist.list.push({ label: "Settings", s: clone(this.s) }), this.hist.at = 1;
    this.buildWB();
    this.infoLine.textContent = [photo.name, info.isRaw && [info.make, info.model].filter(Boolean).join(" "), `${info.w}×${info.h}`].filter(Boolean).join("  ·  ");
    this.histInfo.textContent = summary(photo.exif);
    this.hideStatus();
    this.refresh();
    this.paintPresets();
    this.schedule(false);
  }

  close() {
    this.flushSave();
    this.photo = null;
  }

  refresh() {
    if (!this.s) return;
    for (const { c, read } of this.controls) c.set(read());
    this.wbSel.value = this.s.wb || "Custom";
    for (const t of ["hue", "sat", "lum", "gray"]) this.hslBoxes[t].hidden = true;
    this.paintHsl();
    this.paintCurve();
    this.paintHistory();
    this.paintSnapshots();
    if (this.tool) this.paintDrawer();
    this.paintOverlay();
  }

  paintHsl() {
    const bw = this.s?.treatment > 0 || (PROFILES[this.s?.profile]?.d.treatment);
    for (const t of ["hue", "sat", "lum"]) this.hslBoxes[t].hidden = bw || !(this.hslTab === t || this.hslTab === "all");
    this.hslBoxes.gray.hidden = !bw;
    this.hslHead.querySelector(".ps-seg").hidden = bw;
  }

  paramRegion(x) {
    const s = this.s;
    if (x < s.pc_split1 / 100) return "pc_shadows";
    if (x < s.pc_split2 / 100) return "pc_darks";
    if (x < s.pc_split3 / 100) return "pc_lights";
    return "pc_highlights";
  }

  paintCurve() {
    if (!this.s) return;
    const luts = curveLuts(this.s);
    const param = this.curveMode === "param";
    this.paramBox.hidden = !param;
    this.pointBox.hidden = param;
    const lumHist = this.lastHist ? this.lastHist.subarray(768, 1024) : null;
    if (param) {
      const l = new Float32Array(256);
      for (let i = 0; i < 256; i++) l[i] = parametric(i / 255, this.s);
      this.curve.set([], l, "rgb", lumHist, this.curveParam);
    } else {
      const ch = this.curveCh;
      const idx = { rgb: 0, r: 1, g: 2, b: 3 }[ch];
      this.curve.set(this.s.curve[ch], ch === "rgb" ? luts[0] : luts[idx], ch, lumHist, null);
    }
  }

  // ───────────────────────── History ─────────────────────────
  commit(label) {
    if (!this.s) return;
    const L = this.hist;
    L.list = L.list.slice(0, L.at + 1);
    const last = L.list[L.list.length - 1];
    // Collapse repeated tweaks of the same control into one step.
    if (last && last.label.split(" ")[0] === label.split(" ")[0] && last.label !== "Import" && label.split(" ").length > 1 && Date.now() - (last.t || 0) < 1500) L.list.pop();
    L.list.push({ label, s: clone(this.s), t: Date.now() });
    if (L.list.length > 120) L.list.splice(1, L.list.length - 120);
    L.at = L.list.length - 1;
    this.refresh();
    this.schedule(false);
    this.save();
  }

  undo() { if (this.hist.at > 0) this.goto(this.hist.at - 1); }
  redo() { if (this.hist.at < this.hist.list.length - 1) this.goto(this.hist.at + 1); }
  goto(i) {
    this.hist.at = i;
    this.s = clone(this.hist.list[i].s);
    this.refresh();
    this.schedule(false);
    this.save();
  }
  clearHistory() {
    this.hist.list = [{ label: "History cleared", s: clone(this.s) }];
    this.hist.at = 0;
    this.paintHistory();
    this.save();
  }

  paintHistory() {
    const L = this.hist;
    this.histList.replaceChildren(...L.list.map((e, i) => {
      const b = h("button", { type: "button", class: "pd-item" + (i === L.at ? " on" : "") + (i > L.at ? " future" : "") }, e.label);
      b.addEventListener("click", () => this.goto(i));
      return b;
    }).reverse());
  }

  setSettings(s, label) {
    this.s = s;
    this.commit(label);
  }

  resetKeys(groups, title) {
    const part = {};
    for (const g of groups) for (const k of (this.app.groups[g] || [])) if (k in this.defaults) part[k] = clone(this.defaults[k]);
    Object.assign(this.s, part);
    this.commit("Reset " + title);
  }

  resetAll() {
    this.s = clone(this.defaults);
    this.commit("Reset");
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 400);
    clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => this.app.updateThumb(this.photo, this.s, this.info), 1800);
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    if (!this.photo || !this.s) return;
    this.photo.settings = clone(this.s);
    this.photo.history = this.hist.list.slice(-60);
    this.photo.historyAt = Math.max(0, this.hist.at - (this.hist.list.length - this.photo.history.length));
    this.photo.edited = this.hist.list.length > 1;
    this.app.savePhoto(this.photo);
  }

  // ───────────────────────── Snapshots & presets ─────────────────────────
  snapshot() {
    const name = prompt("Snapshot name", new Date().toLocaleString());
    if (!name) return;
    this.photo.snapshots = [...(this.photo.snapshots || []), { name, s: clone(this.s), at: Date.now() }];
    this.paintSnapshots();
    this.flushSave();
  }

  paintSnapshots() {
    const snaps = this.photo?.snapshots || [];
    this.snapList.replaceChildren(...(snaps.length ? snaps.map((sn, i) => {
      const del = h("span", { class: "pd-x", role: "button", title: "Delete snapshot" }, "×");
      const b = h("button", { type: "button", class: "pd-item" }, sn.name, del);
      b.addEventListener("click", (e) => {
        if (e.target === del) { this.photo.snapshots.splice(i, 1); this.paintSnapshots(); this.flushSave(); return; }
        this.setSettings(clone(sn.s), "Snapshot: " + sn.name);
      });
      return b;
    }) : [h("p", { class: "pd-hint" }, "Save named versions of this photo's settings.")]));
  }

  async paintPresets() {
    const user = await this.app.userPresets();
    const groups = {};
    for (const p of [...user.map((p) => ({ ...p, group: "User Presets", user: true })), ...BUILTIN_PRESETS]) (groups[p.group] ||= []).push(p);
    this.presetList.replaceChildren(...Object.entries(groups).map(([g, list]) => {
      const d = h("details", { class: "pd-pgroup", open: g === "User Presets" || g === "Basic" }, h("summary", {}, g));
      for (const p of list) {
        const b = h("button", { type: "button", class: "pd-item" }, p.name);
        if (p.user) {
          const del = h("span", { class: "pd-x", role: "button", title: "Delete preset" }, "×");
          b.append(del);
          del.addEventListener("click", async (e) => { e.stopPropagation(); await this.app.deletePreset(p.name); this.paintPresets(); });
        }
        b.addEventListener("click", () => this.applyPreset(p));
        // Hover previews the preset in the Navigator.
        b.addEventListener("pointerenter", () => this.previewNav(applyPartial(this.s, p.s, this.info)));
        b.addEventListener("pointerleave", () => this.previewNav(null));
        d.append(b);
      }
      return d;
    }));
  }

  applyPreset(p) {
    this.setSettings(applyPartial(this.s, p.s, this.info), "Preset: " + p.name);
  }

  async savePreset() {
    const res = await this.app.groupDialog("New Develop Preset", true);
    if (!res) return;
    await this.app.addPreset(res.name, res.groups, this.s);
    this.paintPresets();
  }

  // ───────────────────────── White balance & auto ─────────────────────────
  async setWB(name) {
    const list = this.info.isRaw ? WB_PRESETS_RAW : WB_PRESETS_IMG;
    const preset = list.find((p) => p[0] === name);
    if (name === "As Shot") {
      this.s.temp = this.info.isRaw ? Math.round(this.info.asShotTemp) : 0;
      this.s.tint = this.info.isRaw ? Math.round(this.info.asShotTint) : 0;
    } else if (name === "Auto") {
      const [t, ti] = await this.engine.wbAuto(this.photo.fileId);
      this.s.temp = Math.round(t); this.s.tint = Math.round(ti);
    } else if (preset?.[1]) {
      [this.s.temp, this.s.tint] = preset[1];
    }
    this.s.wb = name;
    this.commit("White Balance: " + name);
  }

  async pickWB(ux, uy) {
    try {
      const [t, ti] = await this.engine.wbPick(this.photo.fileId, ux, uy, 0.004);
      this.s.temp = Math.round(t); this.s.tint = Math.round(ti); this.s.wb = "Custom";
      this.commit("White Balance: Custom");
    } catch (err) { this.toast(err.message); }
  }

  /** Measure a neutral render and set tone sliders the way an auto-tone does. */
  async autoTone() {
    const base = { ...clone(this.s), exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, saturation: 0 };
    const hist = await this.measure(base);
    if (!hist) return;
    const lum = hist.subarray(768, 1024);
    const total = lum.reduce((a, b) => a + b, 0) || 1;
    const pct = (q) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += lum[i]; if (acc >= q * total) return i / 255; } return 1; };
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const med = Math.max(0.005, lin(pct(0.5)));
    const exposure = Math.max(-3, Math.min(3, Math.log2(0.17 / med) * 0.8));
    const p02 = pct(0.02), p98 = pct(0.98), p999 = pct(0.999), p001 = pct(0.001);
    const spread = p98 - p02;
    const r = (v) => Math.round(Math.max(-100, Math.min(100, v)));
    Object.assign(this.s, {
      exposure: Math.round(exposure * 100) / 100,
      contrast: r((0.75 - spread) * 40),
      highlights: r(-Math.max(0, p98 + exposure * 0.15 - 0.85) * 300 - 10),
      shadows: r(Math.max(0, 0.15 - p02) * 250 + 5),
      whites: r((0.97 - p999 - exposure * 0.1) * 120),
      blacks: r((0.02 - p001) * 300 - 4),
      vibrance: this.s.vibrance || 8,
      saturation: this.s.saturation,
    });
    this.commit("Auto Settings");
  }

  async autoPoint(which) {
    const hist = await this.measure(this.s);
    if (!hist) return;
    const lum = hist.subarray(768, 1024);
    const total = lum.reduce((a, b) => a + b, 0) || 1;
    let acc = 0, idx = 0;
    if (which === "whites") { for (let i = 255; i >= 0; i--) { acc += lum[i]; if (acc > total * 0.001) { idx = i; break; } } this.s.whites = Math.round(Math.max(-100, Math.min(100, this.s.whites + (250 - idx) * 0.9))); }
    else { for (let i = 0; i < 256; i++) { acc += lum[i]; if (acc > total * 0.001) { idx = i; break; } } this.s.blacks = Math.round(Math.max(-100, Math.min(100, this.s.blacks - (idx - 3) * 2.2))); }
    this.commit(`Auto ${which === "whites" ? "Whites" : "Blacks"}`);
  }

  async measure(s) {
    const params = serialize(s, { region: [0, 0, 1, 1], draft: true });
    try {
      const r = await this.engine.render(this.photo.fileId, params, 256, Math.max(16, Math.round(256 / this.cropAspect(s))));
      return r.hist;
    } catch (err) { this.toast(err.message); return null; }
  }

  // ───────────────────────── View geometry ─────────────────────────
  cropOf(s = this.s) {
    if (this.tool === "crop") return { l: 0, t: 0, r: 1, b: 1 };
    return { l: s.crop_l, t: s.crop_t, r: s.crop_r, b: s.crop_b };
  }

  frameDims() {
    const rot = (this.s.orient | 0) & 1;
    return rot ? [this.info.h, this.info.w] : [this.info.w, this.info.h];
  }

  cropAspect(s = this.s) {
    const [wo, ho] = this.frameDims();
    const c = this.tool === "crop" ? { l: 0, t: 0, r: 1, b: 1 } : { l: s.crop_l, t: s.crop_t, r: s.crop_r, b: s.crop_b };
    return ((c.r - c.l) * wo) / Math.max(1e-6, (c.b - c.t) * ho);
  }

  /** Current mapping from crop-normalised coords to stage device pixels. */
  view() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const CW = this.stage.clientWidth * dpr, CH = this.stage.clientHeight * dpr;
    const pad = this.tool === "crop" ? 28 * dpr : 0;
    const side = this.compare === "side";
    const PW = side ? CW / 2 - 4 * dpr : CW;
    const A = this.cropAspect();
    const [wo] = this.frameDims();
    const c = this.cropOf();
    const srcW = (c.r - c.l) * wo / Math.max(0.05, (this.s.tr_scale || 100) / 100);
    let FW;
    if (this.zoom === "fit") FW = Math.min(PW - pad * 2, (CH - pad * 2) * A);
    else if (this.zoom === "fill") FW = Math.max(PW, CH * A);
    else FW = srcW * this.zoom;
    FW = Math.max(16, FW);
    const FH = FW / A;
    let [cx, cy] = this.center;
    if (FW <= PW) cx = 0.5; else cx = Math.min(1 - PW / (2 * FW), Math.max(PW / (2 * FW), cx));
    if (FH <= CH) cy = 0.5; else cy = Math.min(1 - CH / (2 * FH), Math.max(CH / (2 * FH), cy));
    this.center = [cx, cy];
    const region = [Math.max(0, cx - PW / (2 * FW)), Math.max(0, cy - CH / (2 * FH)), Math.min(1, cx + PW / (2 * FW)), Math.min(1, cy + CH / (2 * FH))];
    return { dpr, CW, CH, PW, FW, FH, cx, cy, region, srcW, side };
  }

  toCanvas(v, u, w, paneX = 0) { return [paneX + v.PW / 2 + (u - v.cx) * v.FW, v.CH / 2 + (w - v.cy) * v.FH]; }

  /** Stage CSS px → source units (long edge = 1). */
  toSource(px, py) {
    const v = this.view();
    const X = px * v.dpr, Y = py * v.dpr;
    const u = v.cx + (X - v.PW / 2) / v.FW, w = v.cy + (Y - v.CH / 2) / v.FH;
    const c = this.cropOf();
    const g = geometry(this.info.w, this.info.h, this.s);
    return g.toSource(c.l + u * (c.r - c.l), c.t + w * (c.b - c.t));
  }

  /** Source units → stage CSS px. */
  toStage(ux, uy, g = geometry(this.info.w, this.info.h, this.s), v = this.view()) {
    const [fx, fy] = g.toFrame(ux, uy, this._guess);
    this._guess = [fx, fy];
    const c = this.cropOf();
    const u = (fx - c.l) / (c.r - c.l), w = (fy - c.t) / (c.b - c.t);
    const [X, Y] = this.toCanvas(v, u, w);
    return [X / v.dpr, Y / v.dpr];
  }

  /** Frame-normalised → stage CSS px (crop tool works in frame space). */
  frameToStage(fx, fy, v = this.view()) {
    const c = this.cropOf();
    const [X, Y] = this.toCanvas(v, (fx - c.l) / (c.r - c.l), (fy - c.t) / (c.b - c.t));
    return [X / v.dpr, Y / v.dpr];
  }
  stageToFrame(px, py, v = this.view()) {
    const c = this.cropOf();
    const u = v.cx + (px * v.dpr - v.PW / 2) / v.FW, w = v.cy + (py * v.dpr - v.CH / 2) / v.FH;
    return [c.l + u * (c.r - c.l), c.t + w * (c.b - c.t)];
  }

  setZoom(z, focus) {
    if (!this.s) return;
    const before = this.view();
    if (focus && typeof z === "number") {
      const [px, py] = focus;
      const u = before.cx + (px * before.dpr - before.PW / 2) / before.FW;
      const w = before.cy + (py * before.dpr - before.CH / 2) / before.FH;
      this.zoom = z;
      const after = this.view();
      this.center = [u - (px * after.dpr - after.PW / 2) / after.FW, w - (py * after.dpr - after.CH / 2) / after.FH];
    } else this.zoom = z;
    this.zoomSel.set(typeof z === "number" ? String(z) : z);
    this.redraw(true);
  }

  setCompare(m) {
    this.compare = m;
    this.compareSel.set(m);
    this.before = null;
    this.redraw(true);
  }

  // ───────────────────────── Rendering ─────────────────────────
  schedule(draft) {
    if (!this.s) return;
    this.wantDraft = draft;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderNow(this.wantDraft);
      if (this.wantDraft) {
        clearTimeout(this.fullTimer);
        this.fullTimer = setTimeout(() => this.renderNow(false), 260);
      }
    });
  }

  redraw(rerender) {
    this.paint();
    if (rerender) this.schedule(false);
  }

  async renderNow(draft) {
    if (!this.s || !this.photo) return;
    const photo = this.photo;
    const v = this.view();
    const [x0, y0, x1, y1] = v.region;
    let ow = Math.max(1, Math.round((x1 - x0) * v.FW)), oh = Math.max(1, Math.round((y1 - y0) * v.FH));
    const budget = draft ? DRAFT_PX : MAX_PX * (v.side ? 0.6 : 1);
    if (ow * oh > budget) { const k = Math.sqrt(budget / (ow * oh)); ow = Math.max(1, Math.round(ow * k)); oh = Math.max(1, Math.round(oh * k)); }
    const showMask = this.tool === "mask" && this.overlayMask && this.selMask >= 0;
    const s = this.s;
    const ctl = { region: v.region, draft, overlay: showMask ? this.activeMaskIndex() : -1, noCrop: this.tool === "crop" };
    const jobs = [this.engine.renderLatest("main", { key: photo.fileId, params: serialize(s, ctl), w: ow, h: oh })];
    const needBefore = this.compare !== "off";
    if (needBefore) {
      const b = { ...clone(this.defaults), crop_l: s.crop_l, crop_t: s.crop_t, crop_r: s.crop_r, crop_b: s.crop_b, angle: s.angle, orient: s.orient };
      jobs.push(this.engine.renderLatest("before", { key: photo.fileId, params: serialize(b, { ...ctl, overlay: -1 }), w: ow, h: oh }));
    }
    let res;
    try { res = await Promise.all(jobs); } catch (err) {
      if (err.code === "closed" || err.lost) { await this.app.ensureOpen(photo).catch(() => {}); this.schedule(false); return; }
      this.showStatus(err.message);
      return;
    }
    if (photo !== this.photo || !res[0]) return;
    const toImg = (r) => {
      const c = document.createElement("canvas");
      c.width = ow; c.height = oh;
      c.getContext("2d").putImageData(new ImageData(r.rgba, ow, oh), 0, 0);
      return c;
    };
    const main = res[0];
    if (!draft) this.lastRGBA = { data: main.rgba, w: ow, h: oh, region: v.region };
    let disp = main;
    if (!draft && (this.clip.highlights || this.clip.shadows)) { disp = { rgba: main.rgba.slice() }; markClipping(disp.rgba, this.clip); }
    this.shown = { img: toImg(disp), region: v.region, crop: this.tool === "crop" };
    if (needBefore && res[1]) this.before = { img: toImg(res[1]), region: v.region };
    this.lastHist = main.hist;
    this.paintHistogram();
    if (!draft && this.curveMode) this.paintCurve();
    this.paint();
    if (!draft) this.paintNav();
  }

  paint() {
    if (!this.s || !this.info) return;
    const v = this.view();
    const c = this.canvas;
    if (c.width !== v.CW || c.height !== v.CH) { c.width = v.CW; c.height = v.CH; }
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#1e2025";
    ctx.fillRect(0, 0, v.CW, v.CH);
    if (!this.shown) return;
    const draw = (shot, paneX = 0) => {
      if (!shot) return;
      const [a, b, cc, d] = shot.region;
      const [X0, Y0] = this.toCanvas(v, a, b, paneX);
      const [X1, Y1] = this.toCanvas(v, cc, d, paneX);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(shot.img, X0, Y0, X1 - X0, Y1 - Y0);
    };
    if (this.compare === "toggle") draw(this.before || this.shown);
    else if (this.compare === "side") {
      draw(this.before);
      draw(this.shown, v.CW / 2 + 4 * v.dpr);
      ctx.fillStyle = "rgba(255,255,255,.5)";
      ctx.font = `${12 * v.dpr}px system-ui`;
      ctx.fillText("Before", 10 * v.dpr, 20 * v.dpr);
      ctx.fillText("After", v.CW / 2 + 14 * v.dpr, 20 * v.dpr);
    } else {
      draw(this.shown);
      if (this.compare === "split" && this.before) {
        const sx = v.CW * this.split;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, sx, v.CH); ctx.clip();
        draw(this.before);
        ctx.restore();
        ctx.fillStyle = "#fff";
        ctx.fillRect(sx - v.dpr, 0, 2 * v.dpr, v.CH);
      }
    }
    this.paintOverlay();
  }

  drawPlaceholder() {
    const thumb = this.app.thumbURL(this.photo);
    const ctx = this.canvas.getContext("2d");
    ctx.fillStyle = "#1e2025";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!thumb) return;
    const img = new Image();
    img.onload = () => {
      if (this.shown || !this.photo) return;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const CW = this.stage.clientWidth * dpr, CH = this.stage.clientHeight * dpr;
      this.canvas.width = CW; this.canvas.height = CH;
      const k = Math.min(CW / img.width, CH / img.height);
      ctx.fillStyle = "#1e2025"; ctx.fillRect(0, 0, CW, CH);
      ctx.filter = "blur(2px)";
      ctx.drawImage(img, (CW - img.width * k) / 2, (CH - img.height * k) / 2, img.width * k, img.height * k);
      ctx.filter = "none";
    };
    img.src = thumb;
  }

  paintHistogram() {
    drawHistogram(this.histCanvas, this.lastHist, { ...this.clipState(), highlightsOn: this.clip.highlights, shadowsOn: this.clip.shadows, zone: this.histZone });
  }

  clipState() {
    const hst = this.lastHist;
    if (!hst) return {};
    const n = hst.subarray(768).reduce((a, b) => a + b, 0) || 1;
    const hi = hst[255] + hst[511] + hst[767], lo = hst[768];
    return { highlights: hi / n > 0.002, shadows: lo / n > 0.002 };
  }

  async paintNav(alt) {
    if (!this.photo || !this.s) return;
    const nc = this.navCanvas;
    const w = nc.clientWidth || 220;
    const A = this.cropAspect(alt || this.s);
    const W = Math.round(w), H = Math.max(8, Math.round(w / A));
    const s = alt || this.s;
    let r;
    try { r = await this.engine.renderLatest("nav", { key: this.photo.fileId, params: serialize(s, { region: [0, 0, 1, 1], draft: true, noCrop: this.tool === "crop" }), w: W, h: H }); } catch { return; }
    if (!r) return;
    nc.width = W; nc.height = H;
    const ctx = nc.getContext("2d");
    ctx.putImageData(new ImageData(r.rgba, W, H), 0, 0);
    if (!alt && typeof this.zoom === "number") {
      const [a, b, c, d] = this.view().region;
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.strokeRect(a * W, b * H, (c - a) * W, (d - b) * H);
    }
  }

  previewNav(s) { this.paintNav(s || undefined); }

  showStatus(msg) { this.status.hidden = false; this.status.textContent = msg; }
  hideStatus() { this.status.hidden = true; }
  toast(m) { this.app.toast(m); }

  // ───────────────────────── Stage interaction ─────────────────────────
  bindStage() {
    const st = this.stage;
    const pointers = new Map();
    let pan = null, pinch = null, toolDrag = null;
    const local = (e) => { const b = st.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

    st.addEventListener("wheel", (e) => {
      if (!this.s) return;
      e.preventDefault();
      const v = this.view();
      const cur = v.FW / v.srcW;
      const z = Math.max(0.03, Math.min(8, cur * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025))));
      this.setZoom(z, local(e));
    }, { passive: false });

    st.addEventListener("dblclick", (e) => {
      if (!this.s || this.tool === "crop" || this.tool === "mask" || this.tool === "heal") return;
      if (typeof this.zoom === "number") this.setZoom("fit");
      else this.setZoom(1, local(e));
    });

    st.addEventListener("pointerdown", (e) => {
      if (!this.s) return;
      st.focus({ preventScroll: true });
      pointers.set(e.pointerId, local(e));
      st.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        toolDrag?.cancel?.();
        toolDrag = null;
        const [a, b] = [...pointers.values()];
        const v = this.view();
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: v.FW / v.srcW, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        pan = null;
        return;
      }
      if (this.compare === "split") {
        const [x] = local(e);
        const v = this.view();
        if (Math.abs(x * v.dpr - v.CW * this.split) < 16 * v.dpr) { toolDrag = { split: true }; return; }
      }
      toolDrag = this.toolDown(e, local(e));
      if (!toolDrag && (typeof this.zoom === "number" || this.zoom === "fill")) {
        pan = { start: local(e), center: [...this.center] };
        st.classList.add("panning");
      }
    });
    st.addEventListener("pointermove", (e) => {
      if (!this.s) return;
      const p = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.setZoom(Math.max(0.03, Math.min(8, pinch.z * d / pinch.d)), pinch.mid);
        return;
      }
      if (toolDrag?.split) { const v = this.view(); this.split = Math.min(0.98, Math.max(0.02, p[0] * v.dpr / v.CW)); this.paint(); return; }
      if (toolDrag) { toolDrag.move?.(p, e); return; }
      if (pan) {
        const v = this.view();
        this.center = [pan.center[0] - (p[0] - pan.start[0]) * v.dpr / v.FW, pan.center[1] - (p[1] - pan.start[1]) * v.dpr / v.FH];
        this.paint();
        this.schedule(false);
        return;
      }
      this.toolHover(p, e);
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pinch && pointers.size < 2) { pinch = null; return; }
      if (toolDrag) { toolDrag.up?.(local(e), e); toolDrag = null; }
      if (pan) { pan = null; st.classList.remove("panning"); this.schedule(false); }
    };
    st.addEventListener("pointerup", end);
    st.addEventListener("pointercancel", end);
    st.addEventListener("pointerleave", () => { this.hover = null; this.paintOverlay(); });
  }

  bindHistogram() {
    // Drag regions of the histogram like a desktop editor: blacks | shadows | exposure | highlights | whites.
    const c = this.histCanvas;
    const keys = ["blacks", "shadows", "exposure", "highlights", "whites"];
    const zoneAt = (e) => {
      const b = c.getBoundingClientRect();
      const x = (e.clientX - b.left) / b.width;
      if (x < 0.07) return 0; if (x < 0.3) return 1; if (x < 0.7) return 2; if (x < 0.93) return 3; return 4;
    };
    let drag = null;
    c.addEventListener("pointermove", (e) => {
      if (drag) {
        const k = keys[drag.zone];
        const dx = e.clientX - drag.x;
        this.s[k] = k === "exposure" ? Math.round(Math.max(-5, Math.min(5, drag.v + dx / 60)) * 100) / 100 : Math.round(Math.max(-100, Math.min(100, drag.v + dx / 1.2)));
        this.refresh();
        this.schedule(true);
        return;
      }
      if (!this.s) return;
      this.histZone = zoneAt(e);
      this.histInfo.textContent = LABELS[keys[this.histZone]];
      this.paintHistogram();
    });
    c.addEventListener("pointerleave", () => { if (drag) return; this.histZone = null; this.histInfo.textContent = summary(this.photo?.exif); this.paintHistogram(); });
    c.addEventListener("pointerdown", (e) => {
      if (!this.s) return;
      const b = c.getBoundingClientRect();
      // Clipping triangles
      if (e.clientY - b.top < 16) {
        if (e.clientX - b.left < 18) { this.clip.shadows = !this.clip.shadows; this.schedule(false); return; }
        if (b.right - e.clientX < 18) { this.clip.highlights = !this.clip.highlights; this.schedule(false); return; }
      }
      const zone = zoneAt(e);
      drag = { zone, x: e.clientX, v: this.s[keys[zone]] };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointerup", () => { if (drag) { this.commit(LABELS[keys[drag.zone]] + " (histogram)"); drag = null; } });
  }

  // ───────────────────────── Tools ─────────────────────────
  setTool(t) {
    if (!this.s) return;
    const was = this.tool;
    if (was === "crop" && t !== "crop") this.cropDrawStraighten = false;
    this.tool = t;
    if (t === "mask" && this.selMask < 0 && this.s.masks.length) this.selMask = 0;
    this.paintTools();
    this.paintDrawer();
    if (was === "crop" || t === "crop") { this.shown = null; this.paint(); this.paintNav(); }
    this.schedule(false);
  }

  paintTools() {
    for (const [t, b] of Object.entries(this.toolBtns)) b.classList.toggle("on", this.tool === t);
    this.stage.dataset.tool = this.tool || "";
    if (!this.tool || this.tool.startsWith("tat") || this.tool === "wb") this.toolDrawer.hidden = true;
  }

  paintDrawer() {
    const d = this.toolDrawer;
    if (this.tool === "crop") { d.hidden = false; d.replaceChildren(...this.cropDrawer()); }
    else if (this.tool === "heal") { d.hidden = false; d.replaceChildren(...this.healDrawer()); }
    else if (this.tool === "mask") { d.hidden = false; d.replaceChildren(...this.maskDrawer()); }
    else d.hidden = true;
  }

  done() { return h("button", { class: "btn sm primary", type: "button", onclick: () => this.setTool(null) }, "Done"); }

  // ── Crop
  cropDrawer() {
    const s = this.s;
    const asp = selectBox(ASPECTS, this.cropOpts.aspect, (v) => { this.cropOpts.aspect = v; this.cropOpts.lock = v !== "free"; this.applyAspect(); });
    const lock = h("label", { class: "pd-check" }, h("input", { type: "checkbox", checked: this.cropOpts.lock, onchange: (e) => { this.cropOpts.lock = e.target.checked; } }), "Lock");
    const cons = h("label", { class: "pd-check" }, h("input", { type: "checkbox", checked: this.cropOpts.constrain, onchange: (e) => { this.cropOpts.constrain = e.target.checked; this.constrain(true); } }), "Constrain to image");
    const ang = slider({
      label: "Angle", min: -45, max: 45, step: 0.01, def: 0,
      onInput: (v) => { s.angle = v; this.constrain(); this.schedule(true); },
      onCommit: (v) => { s.angle = v; this.constrain(); this.commit("Straighten " + v.toFixed(2) + "°"); },
    });
    ang.set(s.angle);
    this.angleCtl = ang;
    const btn = (icon, title, fn) => h("button", { class: "icon-btn sm", type: "button", title, "aria-label": title, onclick: fn }, svgIcon(icon, 18));
    return [
      h("div", { class: "pd-row" }, h("b", {}, "Crop & Straighten"), this.done()),
      h("div", { class: "pd-field" }, h("span", {}, "Aspect"), asp.el, lock),
      ang.el,
      h("div", { class: "pd-row" },
        btn(I.level, "Straighten tool: draw along a horizon", () => { this.cropDrawStraighten = true; this.toast("Draw a line along the horizon"); }),
        btn(I.rotl, "Rotate left", () => this.rotate(-1)),
        btn(I.rotr, "Rotate right", () => this.rotate(1)),
        btn(I.fliph, "Flip horizontal", () => this.flip()),
        h("button", { class: "btn sm ghost", type: "button", onclick: () => { Object.assign(s, { crop_l: 0, crop_t: 0, crop_r: 1, crop_b: 1, angle: 0 }); this.commit("Reset Crop"); } }, "Reset")),
      cons,
      h("p", { class: "pd-hint" }, "Drag the corners or edges; drag outside the frame to rotate. Enter or Done to apply."),
    ];
  }

  aspectValue() {
    const a = this.cropOpts.aspect;
    const [wo, ho] = this.frameDims();
    if (a === "orig") return wo / ho;
    if (a === "free") return null;
    const [x, y] = a.split(":").map(Number);
    const r = x / y;
    return wo >= ho ? Math.max(r, 1 / r) : Math.min(r, 1 / r);
  }

  applyAspect() {
    const r = this.aspectValue();
    if (!r) return;
    const s = this.s;
    const [wo, ho] = this.frameDims();
    let w = (s.crop_r - s.crop_l) * wo, hh = (s.crop_b - s.crop_t) * ho;
    const cx = (s.crop_l + s.crop_r) / 2, cy = (s.crop_t + s.crop_b) / 2;
    if (w / hh > r) w = hh * r; else hh = w / r;
    Object.assign(s, { crop_l: cx - w / wo / 2, crop_r: cx + w / wo / 2, crop_t: cy - hh / ho / 2, crop_b: cy + hh / ho / 2 });
    this.constrain(true);
    this.commit("Crop Aspect");
  }

  constrain(force) {
    if (!this.cropOpts.constrain && !force) return;
    if (!this.cropOpts.constrain) return;
    const s = this.s;
    const g = geometry(this.info.w, this.info.h, s);
    const c = constrainCrop(g, { l: s.crop_l, t: s.crop_t, r: s.crop_r, b: s.crop_b });
    Object.assign(s, { crop_l: c.l, crop_t: c.t, crop_r: c.r, crop_b: c.b });
  }

  rotate(dir) {
    const s = this.s;
    const rot = ((s.orient & 3) + (dir > 0 ? 1 : 3)) % 4;
    s.orient = (s.orient & 4) | rot;
    // rotate the crop rectangle with the frame
    const { crop_l: l, crop_t: t, crop_r: r, crop_b: b } = s;
    if (dir > 0) Object.assign(s, { crop_l: 1 - b, crop_t: l, crop_r: 1 - t, crop_b: r });
    else Object.assign(s, { crop_l: t, crop_t: 1 - r, crop_r: b, crop_b: 1 - l });
    this.shown = null;
    this.commit(dir > 0 ? "Rotate Right" : "Rotate Left");
  }

  flip() {
    const s = this.s;
    const rot = s.orient & 3;
    // A horizontal flip of the displayed frame = flip source then adjust rotation parity.
    s.orient = ((s.orient & 4) ^ 4) | (rot & 1 ? (rot + 2) % 4 : rot);
    Object.assign(s, { crop_l: 1 - s.crop_r, crop_r: 1 - s.crop_l, angle: -s.angle });
    this.commit("Flip Horizontal");
  }

  // ── Healing
  healDrawer() {
    const o = this.spotOpts;
    const sp = this.s.spots[this.selSpot];
    const mode = segmented([["heal", "Heal"], ["clone", "Clone"]], sp?.mode || o.mode, (v) => {
      o.mode = v;
      if (sp) { sp.mode = v; this.commit("Spot Mode: " + v); } else this.paintDrawer();
    });
    const mk = (key, label, min, max, scale = 1) => {
      const c = slider({
        label, min, max, step: 1, def: key === "size" ? 2 : key === "feather" ? 50 : 100, signed: false,
        onInput: (v) => { const val = v / scale; o[key] = val; if (sp) { if (key === "size") sp.r = val; else sp[key] = val; this.schedule(true); this.paintOverlay(); } },
        onCommit: () => { if (sp) this.commit("Spot " + label); },
      });
      c.set((sp ? (key === "size" ? sp.r : sp[key]) : o[key]) * scale);
      return c.el;
    };
    return [
      h("div", { class: "pd-row" }, h("b", {}, "Healing"), this.done()),
      h("div", { class: "pd-field" }, h("span", {}, "Mode"), mode.el),
      mk("size", "Size", 1, 20, 100), mk("feather", "Feather", 0, 100), mk("opacity", "Opacity", 0, 100),
      h("div", { class: "pd-row" },
        h("button", { class: "btn sm", type: "button", disabled: !sp, onclick: () => { this.s.spots.splice(this.selSpot, 1); this.selSpot = -1; this.commit("Delete Spot"); } }, "Delete spot"),
        h("button", { class: "btn sm ghost", type: "button", disabled: !this.s.spots.length, onclick: () => { this.s.spots = []; this.selSpot = -1; this.commit("Clear Spots"); } }, "Clear all")),
      h("p", { class: "pd-hint" }, "Tap a blemish to heal it; drag to paint along a line. Drag the source circle to choose where to sample from."),
    ];
  }

  autoSource(ux, uy, r) {
    // Pick the neighbourhood whose ring best matches the target's ring, using the displayed render.
    const L = this.lastRGBA;
    const g = geometry(this.info.w, this.info.h, this.s);
    const v = this.view();
    const sample = (px, py) => {
      if (!L) return null;
      const X = px * v.dpr, Y = py * v.dpr;
      const [a, b, c, d] = L.region;
      const [X0, Y0] = this.toCanvas(v, a, b), [X1, Y1] = this.toCanvas(v, c, d);
      const ix = Math.round((X - X0) / (X1 - X0) * L.w), iy = Math.round((Y - Y0) / (Y1 - Y0) * L.h);
      if (ix < 0 || iy < 0 || ix >= L.w || iy >= L.h) return null;
      const o = (iy * L.w + ix) * 4;
      return [L.data[o], L.data[o + 1], L.data[o + 2]];
    };
    const ring = (cx, cy) => {
      const out = [];
      for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2;
        const [px, py] = this.toStage(cx + Math.cos(a) * r * 1.2, cy + Math.sin(a) * r * 1.2, g, v);
        out.push(sample(px, py));
      }
      return out;
    };
    const target = ring(ux, uy);
    const W = this.info.w / Math.max(this.info.w, this.info.h), H = this.info.h / Math.max(this.info.w, this.info.h);
    let best = [ux + r * 2.5, uy], bestD = Infinity;
    for (let k = 0; k < 12; k++) {
      const a = k / 12 * Math.PI * 2;
      for (const dist of [2.4, 3.4]) {
        const sx = ux + Math.cos(a) * r * dist, sy = uy + Math.sin(a) * r * dist;
        if (sx - r < 0 || sy - r < 0 || sx + r > W || sy + r > H) continue;
        const cand = ring(sx, sy);
        let d = 0;
        for (let i = 0; i < 16; i++) {
          const p = target[i], q = cand[i];
          d += p && q ? Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) : 200;
        }
        if (d < bestD) { bestD = d; best = [sx, sy]; }
      }
    }
    return best;
  }

  // ── Masks
  activeMaskIndex() {
    const masks = this.s.masks.filter((m) => m.enabled !== false);
    return masks.indexOf(this.s.masks[this.selMask]);
  }

  newMask(type) {
    const n = this.s.masks.length + 1;
    const m = { id: Date.now().toString(36), name: `${{ linear: "Linear Gradient", radial: "Radial Gradient", brush: "Brush", range: "Range" }[type]} ${n}`, type, amount: 100, invert: false, enabled: true, adj: { exposure: 0 }, geo: {}, dabs: [] };
    if (type === "range") { m.lum = { on: true, lo: 50, hi: 100, smooth: 50 }; m.name = `Luminance Range ${n}`; }
    if (type === "color") { m.type = "range"; m.col = { on: true, hue: 0, sat: 50, amount: 50 }; m.name = `Color Range ${n}`; this.pickColorFor = n - 1; this.toast("Tap a colour in the photo to select it"); }
    m.pending = type === "linear" || type === "radial";
    this.s.masks.push(m);
    this.selMask = this.s.masks.length - 1;
    this.overlayMask = true;
    if (m.pending) this.toast(type === "linear" ? "Drag on the photo to place the gradient" : "Drag on the photo to draw the ellipse");
    this.commit("New Mask: " + m.name);
  }

  maskDrawer() {
    const s = this.s;
    const m = s.masks[this.selMask];
    const add = (type, label) => h("button", { class: "btn sm", type: "button", onclick: () => this.newMask(type) }, label);
    const list = h("div", { class: "pd-masks" }, s.masks.map((mk, i) => {
      const eye = h("span", { class: "pd-eye" + (mk.enabled === false ? " off" : ""), role: "button", title: "Show/hide effect" }, svgIcon(I.eye, 16));
      const del = h("span", { class: "pd-x", role: "button", title: "Delete mask" }, "×");
      const row = h("button", { type: "button", class: "pd-item" + (i === this.selMask ? " on" : "") }, eye, h("span", { class: "pd-mname" }, mk.name), del);
      row.addEventListener("click", (e) => {
        if (e.target.closest(".pd-eye")) { mk.enabled = mk.enabled === false; this.commit((mk.enabled ? "Show " : "Hide ") + mk.name); return; }
        if (e.target === del) { s.masks.splice(i, 1); this.selMask = Math.min(this.selMask, s.masks.length - 1); this.commit("Delete " + mk.name); return; }
        this.selMask = i; this.paintDrawer(); this.paintOverlay(); this.schedule(false);
      });
      return row;
    }));
    const out = [
      h("div", { class: "pd-row" }, h("b", {}, "Masks"), this.done()),
      h("div", { class: "pd-row pd-wrap" }, add("linear", "+ Linear"), add("radial", "+ Radial"), add("brush", "+ Brush"), add("range", "+ Luminance"), add("color", "+ Color")),
      list,
    ];
    if (!m) { out.push(h("p", { class: "pd-hint" }, "Create a mask, then adjust only that part of the photo.")); return out; }
    const ov = h("label", { class: "pd-check" }, h("input", { type: "checkbox", checked: this.overlayMask, onchange: (e) => { this.overlayMask = e.target.checked; this.schedule(false); } }), "Show overlay (O)");
    const inv = h("label", { class: "pd-check" }, h("input", { type: "checkbox", checked: !!m.invert, onchange: (e) => { m.invert = e.target.checked; this.commit("Invert " + m.name); } }), "Invert");
    const ms = (obj, key, label, min, max, o = {}) => {
      const c = slider({
        label, min, max, step: o.step || 1, def: o.def ?? 0, gradient: o.gradient, signed: o.signed,
        onInput: (v) => { obj[key] = v; this.schedule(true); if (o.paint) this.paintOverlay(); },
        onCommit: () => this.commit(`${m.name}: ${label}`),
      });
      c.set(obj[key] ?? o.def ?? 0);
      return c.el;
    };
    out.push(h("div", { class: "pd-row" }, ov, inv), ms(m, "amount", "Mask Amount", 0, 100, { def: 100, signed: false }));
    if (m.type === "radial") { m.geo.feather ??= 50; out.push(ms(m.geo, "feather", "Feather", 0, 100, { def: 50, signed: false, paint: true })); }
    if (m.type === "brush") {
      const b = this.brush;
      const er = segmented([["paint", "Paint"], ["erase", "Erase"]], b.erase ? "erase" : "paint", (v) => { b.erase = v === "erase"; er.set(v); });
      const bs = (key, label, min, max, scale = 1) => {
        const c = slider({ label, min, max, def: key === "size" ? 3 : key === "feather" ? 60 : 80, signed: false, onInput: (v) => { b[key] = v / scale; this.paintOverlay(); } });
        c.set(b[key] * scale);
        return c.el;
      };
      out.push(h("div", { class: "pd-sub" }, h("span", {}, "Brush"), er.el), bs("size", "Size", 1, 30, 100), bs("feather", "Feather", 0, 100), bs("flow", "Flow", 1, 100));
    }
    // Range refinement
    m.lum ??= { on: false, lo: 0, hi: 100, smooth: 50 };
    m.col ??= { on: false, hue: 0, sat: 50, amount: 50 };
    const lumOn = h("label", { class: "pd-check" }, h("input", { type: "checkbox", checked: m.lum.on, onchange: (e) => { m.lum.on = e.target.checked; this.commit(m.name + ": Luminance Range"); } }), "Luminance range");
    const colOn = h("label", { class: "pd-check" }, h("input", { type: "checkbox", checked: m.col.on, onchange: (e) => { m.col.on = e.target.checked; this.commit(m.name + ": Color Range"); } }), "Color range");
    const sw = h("span", { class: "pd-swatch", style: { background: `rgb(${hsv2rgb(m.col.hue, Math.min(1, m.col.sat / 100 + 0.2), 0.9).join(",")})` } });
    out.push(h("div", { class: "pd-sub" }, h("span", {}, "Refine")), lumOn);
    if (m.lum.on) out.push(ms(m.lum, "lo", "Low", 0, 100, { signed: false, gradient: "linear-gradient(90deg,#000,#fff)" }), ms(m.lum, "hi", "High", 0, 100, { def: 100, signed: false, gradient: "linear-gradient(90deg,#000,#fff)" }), ms(m.lum, "smooth", "Smoothness", 0, 100, { def: 50, signed: false }));
    out.push(colOn);
    if (m.col.on) out.push(h("div", { class: "pd-row" }, sw, h("button", { class: "btn sm", type: "button", onclick: () => { this.pickColorFor = this.selMask; this.toast("Tap a colour in the photo"); } }, "Pick colour")), ms(m.col, "amount", "Range", 0, 100, { def: 50, signed: false }));
    // Local adjustments
    m.adj ??= {};
    const L = (key, label, min, max, o = {}) => ms(m.adj, key, label, min, max, o);
    out.push(h("div", { class: "pd-sub" }, h("span", {}, "Adjust"), h("button", { class: "btn sm ghost", type: "button", onclick: () => { m.adj = {}; this.commit(m.name + ": Reset"); } }, "Reset")),
      L("temp", "Temp", -100, 100, { gradient: "linear-gradient(90deg,#3a6df0,#ddd,#f0c23a)" }),
      L("tint", "Tint", -100, 100, { gradient: "linear-gradient(90deg,#3c5,#ddd,#d3c)" }),
      L("exposure", "Exposure", -4, 4, { step: 0.01 }),
      L("contrast", "Contrast", -100, 100), L("highlights", "Highlights", -100, 100), L("shadows", "Shadows", -100, 100),
      L("whites", "Whites", -100, 100), L("blacks", "Blacks", -100, 100),
      L("texture", "Texture", -100, 100), L("clarity", "Clarity", -100, 100), L("dehaze", "Dehaze", -100, 100),
      L("hue", "Hue", -100, 100, { gradient: hueGradient() }), L("saturation", "Saturation", -100, 100),
      L("sharpness", "Sharpness", -100, 100),
      L("color_hue", "Color Hue", 0, 360, { signed: false, gradient: hueGradient() }), L("color_sat", "Color Amount", 0, 100, { signed: false }));
    return out;
  }

  // ── Pointer handling per tool
  toolDown(e, p) {
    const s = this.s;
    if (this.pickColorFor != null) {
      const m = s.masks[this.pickColorFor];
      const px = this.pixelAt(p);
      this.pickColorFor = null;
      if (m && px) {
        const [hh, ss] = rgb2hs(px);
        m.col = { ...(m.col || {}), on: true, hue: Math.round(hh), sat: Math.round(ss * 100), amount: m.col?.amount ?? 50 };
        this.commit(m.name + ": Pick Color");
      }
      return {};
    }
    if (this.tool === "wb") {
      const [ux, uy] = this.toSource(...p);
      this.pickWB(ux, uy);
      return {};
    }
    if (this.tool === "tat-hsl" || this.tool === "tat-curve") return this.tatDown(p);
    if (this.tool === "crop") return this.cropDown(p, e);
    if (this.tool === "heal") return this.healDown(p, e);
    if (this.tool === "mask") return this.maskDown(p, e);
    return null;
  }

  toolHover(p) {
    this.hover = p;
    if (this.tool === "mask" || this.tool === "heal") this.paintOverlay();
  }

  pixelAt(p) {
    const L = this.lastRGBA;
    if (!L) return null;
    const v = this.view();
    const [a, b, c, d] = L.region;
    const [X0, Y0] = this.toCanvas(v, a, b), [X1, Y1] = this.toCanvas(v, c, d);
    const ix = Math.floor((p[0] * v.dpr - X0) / (X1 - X0) * L.w), iy = Math.floor((p[1] * v.dpr - Y0) / (Y1 - Y0) * L.h);
    if (ix < 0 || iy < 0 || ix >= L.w || iy >= L.h) return null;
    const o = (iy * L.w + ix) * 4;
    return [L.data[o], L.data[o + 1], L.data[o + 2]];
  }

  tatDown(p) {
    const px = this.pixelAt(p);
    if (!px) return {};
    const s = this.s;
    if (this.tool === "tat-curve") {
      const l = (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255;
      const key = this.paramRegion(l);
      const v0 = s[key];
      return {
        move: (q) => { s[key] = Math.round(Math.max(-100, Math.min(100, v0 + (p[1] - q[1]) / 1.5))); this.refresh(); this.schedule(true); },
        up: () => this.commit(LABELS[key] + " (targeted)"),
      };
    }
    const [hue, sat] = rgb2hs(px);
    const centres = [0, 30, 60, 120, 180, 225, 270, 315, 360];
    let i = 0;
    while (i < 7 && hue >= centres[i + 1]) i++;
    const t = (hue - centres[i]) / (centres[i + 1] - centres[i]);
    const w = [[BANDS[i], 1 - t], [BANDS[(i + 1) % 8], t]];
    const bw = s.treatment > 0;
    const kind = bw ? "gray" : this.hslTab === "all" ? "sat" : this.hslTab;
    const v0 = w.map(([b]) => s[`${kind}_${b}`]);
    return {
      move: (q) => {
        const d = (p[1] - q[1]) / 1.5 * Math.max(0.3, sat);
        w.forEach(([b, k], j) => { s[`${kind}_${b}`] = Math.round(Math.max(-100, Math.min(100, v0[j] + d * k))); });
        this.refresh(); this.schedule(true);
      },
      up: () => this.commit(`${{ hue: "Hue", sat: "Saturation", lum: "Luminance", gray: "B&W Mix" }[kind]} (targeted)`),
    };
  }

  cropDown(p) {
    const s = this.s;
    const v = this.view();
    if (this.cropDrawStraighten) {
      const start = p;
      return {
        move: (q) => { this.straightenLine = [start, q]; this.paintOverlay(); },
        up: (q) => {
          this.straightenLine = null;
          this.cropDrawStraighten = false;
          const [fx0, fy0] = this.stageToFrame(...start, v), [fx1, fy1] = this.stageToFrame(...q, v);
          const [wo, ho] = this.frameDims();
          const dx = (fx1 - fx0) * wo, dy = (fy1 - fy0) * ho;
          if (Math.hypot(dx, dy) < 10) return this.paintOverlay();
          let a = Math.atan2(dy, dx) * 180 / Math.PI;
          if (Math.abs(a) > 45 && Math.abs(a) < 135) a = a > 0 ? a - 90 : a + 90; // vertical line
          else if (Math.abs(a) >= 135) a = a > 0 ? a - 180 : a + 180;
          s.angle = Math.max(-45, Math.min(45, Math.round((s.angle - a) * 100) / 100));
          this.constrain(true);
          this.commit("Straighten " + s.angle.toFixed(2) + "°");
        },
      };
    }
    const [L, T] = this.frameToStage(s.crop_l, s.crop_t, v);
    const [R, B] = this.frameToStage(s.crop_r, s.crop_b, v);
    const tol = 22;
    const nearL = Math.abs(p[0] - L) < tol, nearR = Math.abs(p[0] - R) < tol, nearT = Math.abs(p[1] - T) < tol, nearB = Math.abs(p[1] - B) < tol;
    const inX = p[0] > L - tol && p[0] < R + tol, inY = p[1] > T - tol && p[1] < B + tol;
    const start = { l: s.crop_l, t: s.crop_t, r: s.crop_r, b: s.crop_b };
    const [f0x, f0y] = this.stageToFrame(...p, v);
    const [wo, ho] = this.frameDims();
    const ratio = this.cropOpts.lock ? (this.aspectValue() || ((start.r - start.l) * wo) / ((start.b - start.t) * ho)) : null;
    this.cropActive = true;
    let mode;
    if (inX && inY && (nearL || nearR || nearT || nearB)) mode = { l: nearL, r: nearR && !nearL, t: nearT, b: nearB && !nearT };
    else if (p[0] > L && p[0] < R && p[1] > T && p[1] < B) mode = "move";
    else mode = "rotate";
    const g = geometry(this.info.w, this.info.h, s);
    const valid = (c) => !this.cropOpts.constrain || [[c.l, c.t], [c.r, c.t], [c.l, c.b], [c.r, c.b]].every(([x, y]) => g.inside(x, y));
    const cx0 = (start.l + start.r) / 2, cy0 = (start.t + start.b) / 2;
    const [scx, scy] = this.frameToStage(cx0, cy0, v);
    const a0 = Math.atan2(p[1] - scy, p[0] - scx), ang0 = s.angle;
    return {
      move: (q) => {
        const [fx, fy] = this.stageToFrame(...q, v);
        const dx = fx - f0x, dy = fy - f0y;
        let c = { ...start };
        if (mode === "rotate") {
          const a = Math.atan2(q[1] - scy, q[0] - scx);
          s.angle = Math.max(-45, Math.min(45, Math.round((ang0 + (a - a0) * 180 / Math.PI) * 100) / 100));
          this.constrain();
          this.angleCtl?.set(s.angle);
          this.schedule(true);
          this.paintOverlay();
          return;
        }
        if (mode === "move") {
          const w = start.r - start.l, hh = start.b - start.t;
          c.l = Math.min(1 - w, Math.max(0, start.l + dx)); c.r = c.l + w;
          c.t = Math.min(1 - hh, Math.max(0, start.t + dy)); c.b = c.t + hh;
          if (!valid(c)) {
            // try axis-separately so the crop slides along the edge
            const cX = { ...start, l: c.l, r: c.r }, cY = { ...start, t: c.t, b: c.b };
            c = valid(cX) ? cX : valid(cY) ? cY : start;
          }
        } else {
          if (mode.l) c.l = Math.min(start.r - 0.02, Math.max(0, start.l + dx));
          if (mode.r) c.r = Math.max(start.l + 0.02, Math.min(1, start.r + dx));
          if (mode.t) c.t = Math.min(start.b - 0.02, Math.max(0, start.t + dy));
          if (mode.b) c.b = Math.max(start.t + 0.02, Math.min(1, start.b + dy));
          if (ratio) {
            const W = (c.r - c.l) * wo, H = (c.b - c.t) * ho;
            const horiz = mode.l || mode.r, vert = mode.t || mode.b;
            if (horiz && !vert) { const nh = W / ratio / ho, mid = (start.t + start.b) / 2; c.t = mid - nh / 2; c.b = mid + nh / 2; }
            else if (vert && !horiz) { const nw = H * ratio / wo, mid = (start.l + start.r) / 2; c.l = mid - nw / 2; c.r = mid + nw / 2; }
            else if (W / H > ratio) { const nw = H * ratio / wo; if (mode.l) c.l = c.r - nw; else c.r = c.l + nw; }
            else { const nh = W / ratio / ho; if (mode.t) c.t = c.b - nh; else c.b = c.t + nh; }
          }
          if (!valid(c) || c.l < -1e-6 || c.t < -1e-6 || c.r > 1 + 1e-6 || c.b > 1 + 1e-6) return;
        }
        Object.assign(s, { crop_l: c.l, crop_t: c.t, crop_r: c.r, crop_b: c.b });
        this.paintOverlay();
      },
      up: () => {
        this.cropActive = false;
        const moved = start.l !== s.crop_l || start.t !== s.crop_t || start.r !== s.crop_r || start.b !== s.crop_b || ang0 !== s.angle;
        if (moved) this.commit(mode === "rotate" ? "Straighten " + s.angle.toFixed(2) + "°" : "Crop");
        else this.paintOverlay();
      },
    };
  }

  healDown(p) {
    const s = this.s;
    const g = geometry(this.info.w, this.info.h, s);
    const v = this.view();
    // Hit test existing spots (target or source circle)
    for (let i = s.spots.length - 1; i >= 0; i--) {
      const sp = s.spots[i];
      const [tx, ty] = this.toStage(sp.x, sp.y, g, v);
      const [sx, sy] = this.toStage(sp.sx, sp.sy, g, v);
      const [ex] = this.toStage(sp.x + sp.r, sp.y, g, v);
      const rr = Math.max(8, Math.abs(ex - tx));
      const hitT = Math.hypot(p[0] - tx, p[1] - ty) < rr, hitS = Math.hypot(p[0] - sx, p[1] - sy) < rr;
      if (hitT || hitS) {
        this.selSpot = i;
        this.paintDrawer();
        const [u0, v0] = this.toSource(...p);
        const st = { ...sp };
        return {
          move: (q) => {
            const [u, w] = this.toSource(...q);
            if (hitS && !hitT) { sp.sx = st.sx + u - u0; sp.sy = st.sy + w - v0; }
            else { sp.x = st.x + u - u0; sp.y = st.y + w - v0; sp.sx = st.sx + u - u0; sp.sy = st.sy + w - v0; }
            this.paintOverlay();
            this.schedule(true);
          },
          up: () => { if (sp.x !== st.x || sp.sx !== st.sx || sp.y !== st.y || sp.sy !== st.sy) this.commit("Move Spot"); else this.paintOverlay(); },
        };
      }
    }
    const [u, w] = this.toSource(...p);
    const r = this.spotOpts.size;
    const path = [[u, w]];
    return {
      move: (q) => {
        const [a, b] = this.toSource(...q);
        const last = path[path.length - 1];
        if (Math.hypot(a - last[0], b - last[1]) > r * 0.7) path.push([a, b]);
        this.strokePreview = path.map(([x, y]) => this.toStage(x, y, g, v));
        this.paintOverlay();
      },
      up: () => {
        this.strokePreview = null;
        const pts = path.length > 1 ? path : [[u, w]];
        let off = null;
        for (const [x, y] of pts) {
          const [sx, sy] = off ? [x + off[0], y + off[1]] : this.autoSource(x, y, r);
          off ??= [sx - x, sy - y];
          s.spots.push({ x, y, r, sx, sy, mode: this.spotOpts.mode, feather: this.spotOpts.feather, opacity: this.spotOpts.opacity });
        }
        this.selSpot = s.spots.length - 1;
        this.commit(pts.length > 1 ? "Heal Stroke" : "Add Spot");
      },
    };
  }

  maskDown(p, e) {
    const s = this.s;
    const m = s.masks[this.selMask];
    if (!m) return null;
    const g = geometry(this.info.w, this.info.h, s);
    const v = this.view();
    const [u0, w0] = this.toSource(...p);
    if (m.type === "brush") {
      const b = this.brush;
      const erase = b.erase || e.altKey;
      m.dabs ||= [];
      let last = null;
      const dab = (x, y) => {
        if (last && Math.hypot(x - last[0], y - last[1]) < b.size * 0.2) return;
        if (last) {
          const n = Math.ceil(Math.hypot(x - last[0], y - last[1]) / (b.size * 0.2));
          for (let k = 1; k < n; k++) m.dabs.push([last[0] + (x - last[0]) * k / n, last[1] + (y - last[1]) * k / n, b.size, b.feather / 100, b.flow / 100 * 0.6, erase ? 1 : 0]);
        }
        m.dabs.push([x, y, b.size, b.feather / 100, b.flow / 100 * 0.6, erase ? 1 : 0]);
        last = [x, y];
      };
      dab(u0, w0);
      this.schedule(true);
      return {
        move: (q) => { const [x, y] = this.toSource(...q); dab(x, y); this.hover = q; this.paintOverlay(); this.schedule(true); },
        up: () => this.commit(m.name + (erase ? ": Erase" : ": Paint")),
      };
    }
    if (m.type === "linear") {
      const G = m.geo;
      if (!m.pending && G.x1 != null) {
        const pts = [[G.x1, G.y1], [G.x2, G.y2], [(G.x1 + G.x2) / 2, (G.y1 + G.y2) / 2]].map(([x, y]) => this.toStage(x, y, g, v));
        const hit = pts.findIndex(([x, y]) => Math.hypot(p[0] - x, p[1] - y) < 18);
        if (hit >= 0) {
          const st = { ...G };
          return {
            move: (q) => {
              const [u, w] = this.toSource(...q);
              if (hit === 0) { G.x1 = u; G.y1 = w; } else if (hit === 1) { G.x2 = u; G.y2 = w; }
              else { G.x1 = st.x1 + u - u0; G.y1 = st.y1 + w - w0; G.x2 = st.x2 + u - u0; G.y2 = st.y2 + w - w0; }
              this.paintOverlay(); this.schedule(true);
            },
            up: () => this.commit(m.name + ": Move"),
          };
        }
        return null;
      }
      return {
        move: (q) => { const [u, w] = this.toSource(...q); Object.assign(G, { x1: u0, y1: w0, x2: u, y2: w }); m.pending = false; this.paintOverlay(); this.schedule(true); },
        up: () => { if (G.x2 == null) { Object.assign(G, { x1: u0, y1: w0 - 0.1, x2: u0, y2: w0 + 0.1 }); } m.pending = false; this.commit(m.name + ": Place"); },
      };
    }
    if (m.type === "radial") {
      const G = m.geo;
      if (!m.pending && G.cx != null) {
        const ca = Math.cos(G.angle || 0), sa = Math.sin(G.angle || 0);
        const handles = [
          [G.cx, G.cy, "c"],
          [G.cx + ca * G.rx, G.cy + sa * G.rx, "rx"], [G.cx - ca * G.rx, G.cy - sa * G.rx, "rx"],
          [G.cx - sa * G.ry, G.cy + ca * G.ry, "ry"], [G.cx + sa * G.ry, G.cy - ca * G.ry, "ry"],
          [G.cx + sa * G.ry * 1.25, G.cy - ca * G.ry * 1.25, "rot"],
        ].map(([x, y, k]) => [...this.toStage(x, y, g, v), k]);
        const hit = handles.find(([x, y]) => Math.hypot(p[0] - x, p[1] - y) < 16);
        const kind = hit ? hit[2] : null;
        if (!kind) {
          // inside the ellipse moves it
          const dx = u0 - G.cx, dy = w0 - G.cy;
          const lx = (dx * ca + dy * sa) / G.rx, ly = (-dx * sa + dy * ca) / G.ry;
          if (lx * lx + ly * ly > 1) return null;
        }
        const st = { ...G };
        return {
          move: (q) => {
            const [u, w] = this.toSource(...q);
            const dx = u - st.cx, dy = w - st.cy;
            if (!kind || kind === "c") { G.cx = st.cx + u - u0; G.cy = st.cy + w - w0; }
            else if (kind === "rx") G.rx = Math.max(0.005, Math.abs(dx * ca + dy * sa));
            else if (kind === "ry") G.ry = Math.max(0.005, Math.abs(-dx * sa + dy * ca));
            else if (kind === "rot") G.angle = Math.atan2(dy, dx) + Math.PI / 2;
            this.paintOverlay(); this.schedule(true);
          },
          up: () => this.commit(m.name + ": Adjust"),
        };
      }
      return {
        move: (q, ev) => {
          const [u, w] = this.toSource(...q);
          let rx = Math.abs(u - u0), ry = Math.abs(w - w0);
          if (ev.shiftKey) rx = ry = Math.max(rx, ry);
          Object.assign(G, { cx: u0, cy: w0, rx: Math.max(0.01, rx), ry: Math.max(0.01, ry), angle: 0, feather: G.feather ?? 50 });
          m.pending = false;
          this.paintOverlay(); this.schedule(true);
        },
        up: () => { if (G.cx == null) Object.assign(G, { cx: u0, cy: w0, rx: 0.15, ry: 0.1, angle: 0, feather: 50 }); m.pending = false; this.commit(m.name + ": Place"); },
      };
    }
    return null;
  }

  // ───────────────────────── Overlay drawing ─────────────────────────
  paintOverlay() {
    const svg = this.svg;
    if (!this.s || !this.info) { svg.replaceChildren(); return; }
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const NS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const out = [];
    const v = this.view();
    if (this.compare === "side") { svg.replaceChildren(); return; }
    const g = geometry(this.info.w, this.info.h, this.s);
    const s = this.s;

    if (this.tool === "crop") {
      const [L, T] = this.frameToStage(s.crop_l, s.crop_t, v);
      const [R, B] = this.frameToStage(s.crop_r, s.crop_b, v);
      out.push(el("path", { d: `M0 0H${W}V${H}H0Z M${L} ${T}V${B}H${R}V${T}Z`, class: "pd-dim", "fill-rule": "evenodd" }));
      out.push(el("rect", { x: L, y: T, width: R - L, height: B - T, class: "pd-crop" }));
      const n = this.cropActive ? 3 : 3;
      for (let i = 1; i < n; i++) {
        out.push(el("line", { x1: L + (R - L) * i / n, y1: T, x2: L + (R - L) * i / n, y2: B, class: "pd-grid" }));
        out.push(el("line", { x1: L, y1: T + (B - T) * i / n, x2: R, y2: T + (B - T) * i / n, class: "pd-grid" }));
      }
      for (const [x, y] of [[L, T], [R, T], [L, B], [R, B], [(L + R) / 2, T], [(L + R) / 2, B], [L, (T + B) / 2], [R, (T + B) / 2]]) {
        out.push(el("rect", { x: x - 5, y: y - 5, width: 10, height: 10, class: "pd-handle" }));
      }
      if (this.straightenLine) {
        const [[a, b], [c, d]] = this.straightenLine;
        out.push(el("line", { x1: a, y1: b, x2: c, y2: d, class: "pd-level" }));
      }
    }

    if (this.tool === "heal") {
      s.spots.forEach((sp, i) => {
        const [tx, ty] = this.toStage(sp.x, sp.y, g, v);
        const [sx, sy] = this.toStage(sp.sx, sp.sy, g, v);
        const [ex] = this.toStage(sp.x + sp.r, sp.y, g, v);
        const r = Math.max(3, Math.abs(ex - tx));
        const sel = i === this.selSpot;
        out.push(el("circle", { cx: tx, cy: ty, r, class: "pd-spot" + (sel ? " sel" : "") }));
        if (sel) {
          out.push(el("circle", { cx: sx, cy: sy, r, class: "pd-spot src" }));
          out.push(el("line", { x1: sx, y1: sy, x2: tx, y2: ty, class: "pd-spotline" }));
        }
      });
      if (this.strokePreview) out.push(el("polyline", { points: this.strokePreview.map((q) => q.join(",")).join(" "), class: "pd-stroke", "stroke-width": 6 }));
      if (this.hover) {
        const [u, w] = this.toSource(...this.hover);
        const [ex] = this.toStage(u + this.spotOpts.size, w, g, v);
        out.push(el("circle", { cx: this.hover[0], cy: this.hover[1], r: Math.max(3, Math.abs(ex - this.hover[0])), class: "pd-cursor" }));
      }
    }

    if (this.tool === "mask") {
      const m = s.masks[this.selMask];
      if (m?.type === "linear" && m.geo.x1 != null) {
        const G = m.geo;
        const dx = G.x2 - G.x1, dy = G.y2 - G.y1, len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len * 3, ny = dx / len * 3;
        for (const [t, cls] of [[0, "pd-gline a"], [0.5, "pd-gline mid"], [1, "pd-gline"]]) {
          const cx = G.x1 + dx * t, cy = G.y1 + dy * t;
          const pts = [];
          for (let k = -12; k <= 12; k++) pts.push(this.toStage(cx + nx * k / 12, cy + ny * k / 12, g, v));
          out.push(el("polyline", { points: pts.map((q) => q.join(",")).join(" "), class: cls }));
        }
        for (const [x, y] of [[G.x1, G.y1], [G.x2, G.y2], [(G.x1 + G.x2) / 2, (G.y1 + G.y2) / 2]]) {
          const [px, py] = this.toStage(x, y, g, v);
          out.push(el("circle", { cx: px, cy: py, r: 6, class: "pd-pin" }));
        }
      }
      if (m?.type === "radial" && m.geo.cx != null) {
        const G = m.geo, ca = Math.cos(G.angle || 0), sa = Math.sin(G.angle || 0);
        const ring = (k) => {
          const pts = [];
          for (let i = 0; i <= 48; i++) {
            const a = i / 48 * Math.PI * 2;
            const lx = Math.cos(a) * G.rx * k, ly = Math.sin(a) * G.ry * k;
            pts.push(this.toStage(G.cx + lx * ca - ly * sa, G.cy + lx * sa + ly * ca, g, v));
          }
          return pts.map((q) => q.join(",")).join(" ");
        };
        out.push(el("polyline", { points: ring(1), class: "pd-gline" }));
        out.push(el("polyline", { points: ring(1 - (G.feather ?? 50) / 100), class: "pd-gline mid" }));
        const hs = [[G.cx, G.cy], [G.cx + ca * G.rx, G.cy + sa * G.rx], [G.cx - ca * G.rx, G.cy - sa * G.rx], [G.cx - sa * G.ry, G.cy + ca * G.ry], [G.cx + sa * G.ry, G.cy - ca * G.ry], [G.cx + sa * G.ry * 1.25, G.cy - ca * G.ry * 1.25]];
        hs.forEach(([x, y], i) => {
          const [px, py] = this.toStage(x, y, g, v);
          out.push(el("circle", { cx: px, cy: py, r: i === 0 ? 6 : i === 5 ? 5 : 4.5, class: i === 0 ? "pd-pin" : i === 5 ? "pd-pin rot" : "pd-handle-c" }));
        });
      }
      if (m?.type === "brush" && this.hover) {
        const [u, w] = this.toSource(...this.hover);
        const [ex] = this.toStage(u + this.brush.size, w, g, v);
        const r = Math.max(3, Math.abs(ex - this.hover[0]));
        out.push(el("circle", { cx: this.hover[0], cy: this.hover[1], r, class: "pd-cursor" }));
        out.push(el("circle", { cx: this.hover[0], cy: this.hover[1], r: r * (1 - this.brush.feather / 100), class: "pd-cursor inner" }));
      }
    }
    svg.replaceChildren(...out);
  }

  // ───────────────────────── Keyboard ─────────────────────────
  key(e) {
    if (!this.s) return false;
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && k.toLowerCase() === "z") { e.shiftKey ? this.redo() : this.undo(); return true; }
    if (mod && k.toLowerCase() === "y") { this.redo(); return true; }
    if (mod) return false;
    if (k === "\\") { this.setCompare(this.compare === "toggle" ? "off" : "toggle"); return true; }
    if (k === "y" || k === "Y") { this.setCompare(this.compare === "split" ? "off" : e.shiftKey ? "side" : "split"); return true; }
    if (k === "r" || k === "R") { this.setTool(this.tool === "crop" ? null : "crop"); return true; }
    if (k === "q" || k === "Q") { this.setTool(this.tool === "heal" ? null : "heal"); return true; }
    if (k === "m" || k === "M") {
      if (this.tool !== "mask") this.setTool("mask");
      this.newMask(e.shiftKey ? "radial" : "linear");
      return true;
    }
    if (k === "k" || k === "K") { if (this.tool !== "mask") this.setTool("mask"); this.newMask("brush"); return true; }
    if (k === "w" || k === "W") { this.setTool(this.tool === "wb" ? null : "wb"); return true; }
    if (k === "o" || k === "O") { this.overlayMask = !this.overlayMask; this.paintDrawer(); this.schedule(false); return true; }
    if (k === "j" || k === "J") { const on = !(this.clip.highlights && this.clip.shadows); this.clip = { highlights: on, shadows: on }; this.schedule(false); return true; }
    if (k === "z" || k === "Z") { this.setZoom(typeof this.zoom === "number" ? "fit" : 1); return true; }
    if (k === "x" && this.tool === "crop") { this.swapCropOrientation(); return true; }
    if (k === "Enter" && this.tool) { this.setTool(null); return true; }
    if (k === "Escape" && this.tool) { this.setTool(null); return true; }
    if ((k === "Backspace" || k === "Delete") && this.tool === "heal" && this.selSpot >= 0) { this.s.spots.splice(this.selSpot, 1); this.selSpot = -1; this.commit("Delete Spot"); return true; }
    if ((k === "Backspace" || k === "Delete") && this.tool === "mask" && this.selMask >= 0) { const m = this.s.masks.splice(this.selMask, 1)[0]; this.selMask = this.s.masks.length - 1; this.commit("Delete " + m.name); return true; }
    if (k === "[" || k === "]") {
      const f = k === "]" ? 1.15 : 1 / 1.15;
      if (this.tool === "heal") this.spotOpts.size = Math.min(0.2, Math.max(0.003, this.spotOpts.size * f));
      if (this.tool === "mask") this.brush.size = Math.min(0.3, Math.max(0.003, this.brush.size * f));
      this.paintOverlay(); this.paintDrawer();
      return true;
    }
    return false;
  }

  swapCropOrientation() {
    const s = this.s;
    const [wo, ho] = this.frameDims();
    const cx = (s.crop_l + s.crop_r) / 2, cy = (s.crop_t + s.crop_b) / 2;
    const w = (s.crop_r - s.crop_l) * wo, hh = (s.crop_b - s.crop_t) * ho;
    Object.assign(s, { crop_l: cx - hh / wo / 2, crop_r: cx + hh / wo / 2, crop_t: cy - w / ho / 2, crop_b: cy + w / ho / 2 });
    const c = constrainCrop(geometry(this.info.w, this.info.h, s), { l: Math.max(0, s.crop_l), t: Math.max(0, s.crop_t), r: Math.min(1, s.crop_r), b: Math.min(1, s.crop_b) });
    Object.assign(s, { crop_l: c.l, crop_t: c.t, crop_r: c.r, crop_b: c.b });
    this.commit("Crop Orientation");
  }
}

function fmtVal(v, step = 1) {
  const d = step >= 1 ? 0 : 2;
  return (v > 0 ? "+" : "") + (+v).toFixed(d);
}

function rgb2hs([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-6) return [0, 0];
  let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hh *= 60;
  if (hh < 0) hh += 360;
  return [hh, d / mx];
}

function markClipping(px, clip) {
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (clip.highlights && (r >= 254 || g >= 254 || b >= 254)) { px[i] = 255; px[i + 1] = 0; px[i + 2] = 0; }
    else if (clip.shadows && r <= 1 && g <= 1 && b <= 1) { px[i] = 30; px[i + 1] = 90; px[i + 2] = 255; }
  }
}
