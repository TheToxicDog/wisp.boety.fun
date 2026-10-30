// BoetyCut: tool panels. Each builder returns DOM for the desktop sidebars and
// the mobile bottom sheet alike.
import {
  FILTERS, EFFECTS, TRANSITIONS, ANIMS, MASKS, BLENDS, FONTS, TEXT_STYLES, TEXT_COLORS, STICKERS, RATIOS,
  BG_COLORS, BG_GRADIENTS, CURVES, defaultAdjust, defaultMask, setSpeed, fmtTime, newTextClip, isMedia,
} from "./cut-model.js";
import { h, slider, segmented, selectBox, svgIcon } from "./photo-ui.js";
import { ensureFont } from "./cut-render.js";

const ADJ = [
  ["brightness", "Brightness"], ["contrast", "Contrast"], ["saturation", "Saturation"], ["exposure", "Exposure"],
  ["sharpen", "Sharpen", 0], ["highlights", "Highlights"], ["shadows", "Shadows"], ["temperature", "Temperature"],
  ["tint", "Tint"], ["hue", "Hue"], ["fade", "Fade", 0], ["vignette", "Vignette", 0], ["grain", "Grain", 0],
];

/** Slider bound to a getter/setter on the selected clip (live preview, one undo step per drag). */
function sl(ed, label, min, max, get, set, o = {}) {
  const c = slider({
    label, min, max, step: o.step ?? 1, def: o.def ?? 0, gradient: o.gradient, fmt: o.fmt, signed: o.signed,
    onInput: (v) => ed.live(label, () => set(v)),
    onCommit: (v) => { ed.live(label, () => set(v)); ed.endChange(); },
  });
  c.set(get() ?? o.def ?? 0);
  return c.el;
}

function grid(items, active, onPick, o = {}) {
  return h("div", { class: "bc-grid" + (o.small ? " small" : "") }, items.map((it) => {
    const b = h("button", { type: "button", class: "bc-tile" + (it.id === active ? " on" : ""), title: it.name },
      h("span", { class: "bc-tile-art", style: it.style || {} }, it.art || ""), h("span", { class: "bc-tile-name" }, it.name));
    b.addEventListener("click", () => onPick(it));
    return b;
  }));
}

function cats(list) {
  const out = {};
  for (const x of list) (out[x.cat] ||= []).push(x);
  return out;
}

function tabs(groups, render, initial) {
  const keys = Object.keys(groups);
  let cur = initial && keys.includes(initial) ? initial : keys[0];
  const body = h("div", { class: "bc-tabbody" });
  const seg = segmented(keys.map((k) => [k, k]), cur, (k) => { cur = k; seg.set(k); body.replaceChildren(render(groups[k], k)); }, "bc-tabs");
  body.append(render(groups[cur], cur));
  return h("div", {}, seg.el, body);
}

const section = (title, ...kids) => h("div", { class: "bc-sec" }, title ? h("div", { class: "bc-sec-t" }, title) : null, ...kids);
const btn = (label, onclick, cls = "") => h("button", { type: "button", class: "btn sm " + cls, onclick }, label);

// CSS approximation of a filter for its tile preview.
function filterCss(f) {
  const a = f.a;
  const sat = 1 + (a.saturation || 0) / 100, con = 1 + (a.contrast || 0) / 140, bri = 1 + ((a.brightness || 0) + (a.exposure || 0)) / 140;
  const sep = f.tone ? 0.25 : 0;
  const hue = (a.temperature || 0) * -0.3 + (f.tone?.sh?.[0] > 150 && f.tone.sh[0] < 260 ? -10 : 0);
  return `saturate(${Math.max(0, sat)}) contrast(${con}) brightness(${bri}) sepia(${sep + Math.max(0, (a.temperature || 0) / 150)}) hue-rotate(${hue}deg)`;
}

export const PANELS = {
  // ───────── Library ─────────
  media(ed) {
    const list = [...ed.media.values()].filter((m) => !m.generated || m.kind !== "audio").sort((a, b) => b.added - a.added);
    const items = h("div", { class: "bc-medialist" }, list.map((m) => {
      const t = h("button", { type: "button", class: "bc-mtile", title: m.name },
        h("span", { class: "bc-mthumb", "data-media": m.id }, m.kind === "audio" ? svgIcon('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', 22) : ""),
        h("span", { class: "bc-mname" }, m.name),
        m.duration ? h("em", {}, fmtTime(m.duration)) : null);
      t.addEventListener("click", () => ed.addMedia(m, m.kind === "audio" ? "audio" : "main"));
      ed.thumbInto(t.querySelector(".bc-mthumb"), m);
      const ov = h("span", { class: "bc-mov", title: "Add as overlay", role: "button" }, "+ Overlay");
      if (m.kind !== "audio") t.append(ov);
      ov.addEventListener("click", (e) => { e.stopPropagation(); ed.addMedia(m, "video"); });
      return t;
    }));
    return h("div", {},
      h("div", { class: "pd-row" }, btn("Import media", () => ed.importInto("main"), "primary"), btn("Add as overlay", () => ed.importInto("video"))),
      list.length ? items : h("p", { class: "bc-hint" }, "Imported videos, photos and music show up here. Tap one to add it at the playhead."));
  },

  audio(ed) {
    const list = [...ed.media.values()].filter((m) => m.kind === "audio" || m.hasAudio);
    return h("div", {},
      h("div", { class: "bc-bigbtns" },
        bigBtn("Music", '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', () => ed.importInto("audio")),
        bigBtn("Extract", '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 15v-4M12 15V9M16 15v-2"/>', () => ed.extractAudio()),
        bigBtn("Voiceover", '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>', () => ed.voiceover()),
        bigBtn("Sound FX", '<path d="M3 12h3l3-7 4 14 3-7h5"/>', () => ed.importInto("audio"))),
      list.length ? section("In this project", h("div", { class: "bc-list" }, list.map((m) => {
        const b = h("button", { type: "button", class: "bc-row-item" }, svgIcon('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', 16), h("span", {}, m.name), h("em", {}, fmtTime(m.duration)));
        b.addEventListener("click", () => ed.addMedia(m, "audio"));
        return b;
      }))) : null);
  },

  text(ed) {
    return h("div", {},
      h("div", { class: "bc-bigbtns" },
        bigBtn("Add text", '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>', () => ed.addText()),
        bigBtn("Auto captions", '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 14h4M13 14h4M7 10h10"/>', () => ed.openTool("captions")),
        bigBtn("Import SRT", '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>', () => ed.importCaptions()),
        bigBtn("Export SRT", '<path d="M12 20V8M7 13l5-5 5 5"/><path d="M4 4h16"/>', () => ed.exportCaptions())),
      section("Text templates", grid(TEXT_STYLES.map((s) => ({ ...s, art: "Aa", style: tileTextStyle(s.s) })), null, (s) => ed.addText(s))));
  },

  stickers(ed) {
    const groups = Object.fromEntries(Object.entries(STICKERS).map(([k, v]) => [k, [...new Intl.Segmenter().segment(v)].map((x) => x.segment)]));
    return h("div", {},
      h("div", { class: "pd-row" }, btn("Image sticker…", () => ed.importInto("sticker"))),
      tabs(groups, (list) => h("div", { class: "bc-emoji" }, list.map((e) => {
        const b = h("button", { type: "button" }, e);
        b.addEventListener("click", () => ed.addSticker(e));
        return b;
      }))));
  },

  effects(ed) {
    const c = ed.clip();
    const onClip = c && (c.type === "video" || c.type === "image");
    return h("div", {},
      h("p", { class: "bc-hint" }, onClip ? "Tap an effect to apply it to the selected clip." : "Tap an effect to add it to the timeline at the playhead. It affects everything below it."),
      tabs(cats(EFFECTS), (list) => grid(list.map((e) => ({ ...e, art: fxArt(e) })), null, (e) => ed.addEffect(e))));
  },

  transitions(ed) {
    return PANELS.transition(ed);
  },

  transition(ed) {
    const target = ed.transitionTarget();
    if (!target) return h("p", { class: "bc-hint" }, "Put two clips next to each other on the main track, then tap the ⧓ marker between them.");
    const cur = target.transition;
    return h("div", {},
      h("div", { class: "pd-row" },
        btn("None", () => ed.change("Remove transition", () => { target.transition = null; })),
        btn("Apply to all", () => ed.change("Transition to all", () => { for (const c of ed.mainTrack().items.slice(0, -1)) c.transition = cur ? { ...cur } : null; }))),
      cur ? sl(ed, "Duration", 0.1, 2.5, () => cur.dur, (v) => { target.transition.dur = v; }, { step: 0.1, signed: false, fmt: (v) => (+v).toFixed(1) + "s", def: 0.5 }) : null,
      tabs(cats(TRANSITIONS), (list) => grid(list.map((t) => ({ ...t, art: "⧓" })), cur?.id, (t) => ed.change("Transition: " + t.name, () => { target.transition = { id: t.id, dur: cur?.dur || 0.5 }; })), null));
  },

  filters(ed) {
    const c = ed.clip();
    const onClip = c && (c.type === "video" || c.type === "image");
    const target = onClip ? c : c && ed.trackOf(c)?.kind === "filter" ? c : null;
    const cur = target?.filter;
    const snap = ed.snapshotURL();
    return h("div", {},
      h("p", { class: "bc-hint" }, target ? "" : "Tap a filter to add it at the playhead (it colours everything below it). Select a clip first to filter just that clip."),
      cur ? sl(ed, "Intensity", 0, 100, () => cur.amount, (v) => { target.filter.amount = v; }, { def: 100, signed: false }) : null,
      cur ? h("div", { class: "pd-row" }, btn("Remove filter", () => ed.change("Remove filter", () => { target.filter = null; }))) : null,
      tabs(cats(FILTERS), (list) => grid(list.map((f) => ({ ...f, art: snap ? h("img", { src: snap, style: { filter: filterCss(f) }, alt: "" }) : "" })), cur?.id, (f) => ed.addFilter(f, target))));
  },

  adjust(ed) {
    const c = ed.clip();
    const target = c && (c.type === "video" || c.type === "image" || ed.trackOf(c)?.kind === "adjust") ? c : null;
    if (!target) return h("div", {}, h("p", { class: "bc-hint" }, "Select a clip to adjust it, or add an adjustment layer that affects everything below it."), btn("Add adjustment layer", () => ed.addAdjustLayer(), "primary"));
    target.adjust ||= defaultAdjust();
    return h("div", {},
      h("div", { class: "pd-row" }, btn("Reset", () => ed.change("Reset adjust", () => { target.adjust = defaultAdjust(); }))),
      ...ADJ.map(([k, label, min = -100]) => sl(ed, label, min, 100, () => target.adjust[k], (v) => { target.adjust[k] = v; }, { signed: min < 0 })));
  },

  canvas(ed) {
    const p = ed.p;
    const ratio = grid(RATIOS.map(([id, name]) => ({ id, name, art: ratioArt(id) })), p.ratio, (r) => ed.setRatio(r.id), { small: true });
    const bg = p.bg;
    const colors = h("div", { class: "bc-swatches" }, BG_COLORS.map((c) => {
      const b = h("button", { type: "button", class: bg.type === "color" && bg.color === c ? "on" : "", style: { background: c }, "aria-label": c });
      b.addEventListener("click", () => ed.change("Background color", () => { p.bg = { type: "color", color: c }; }));
      return b;
    }), (() => {
      const i = h("input", { type: "color", value: bg.color || "#000000", title: "Custom colour" });
      i.addEventListener("change", () => ed.change("Background color", () => { p.bg = { type: "color", color: i.value }; }));
      return i;
    })());
    const grads = h("div", { class: "bc-swatches" }, BG_GRADIENTS.map(([a, b2]) => {
      const b = h("button", { type: "button", class: bg.type === "gradient" && bg.c1 === a ? "on" : "", style: { background: `linear-gradient(${a},${b2})` } });
      b.addEventListener("click", () => ed.change("Background gradient", () => { p.bg = { type: "gradient", c1: a, c2: b2 }; }));
      return b;
    }));
    const blur = h("div", { class: "bc-swatches" }, [10, 30, 60, 100].map((v) => {
      const b = h("button", { type: "button", class: "blur" + (bg.type === "blur" && bg.blur === v ? " on" : "") }, String(v));
      b.addEventListener("click", () => ed.change("Background blur", () => { p.bg = { type: "blur", blur: v }; }));
      return b;
    }));
    return h("div", {}, section("Ratio", ratio), section("Background blur", blur), section("Colour", colors), section("Gradient", grads),
      section("Frame rate", selectBox([24, 25, 30, 50, 60].map((f) => [String(f), f + " fps"]), String(p.fps), (v) => ed.change("Frame rate", () => { p.fps = +v; })).el));
  },

  captions(ed) {
    const st = ed.captionState ||= { model: "onnx-community/whisper-tiny", language: "auto" };
    const model = selectBox([["onnx-community/whisper-tiny", "Fast (tiny, ~40 MB)"], ["onnx-community/whisper-base", "Balanced (base, ~80 MB)"], ["onnx-community/whisper-small", "Accurate (small, ~250 MB)"]], st.model, (v) => { st.model = v; });
    const lang = selectBox([["auto", "Detect language"], ["english", "English"], ["spanish", "Spanish"], ["french", "French"], ["german", "German"], ["portuguese", "Portuguese"], ["italian", "Italian"], ["japanese", "Japanese"], ["chinese", "Chinese"], ["korean", "Korean"], ["hindi", "Hindi"], ["arabic", "Arabic"], ["russian", "Russian"]], st.language, (v) => { st.language = v; });
    const status = h("p", { class: "bc-hint", "data-captions-status": "" }, "Speech recognition runs on this device. The model downloads once, then it works offline.");
    return h("div", {},
      h("div", { class: "pd-field" }, h("span", {}, "Model"), model.el),
      h("div", { class: "pd-field" }, h("span", {}, "Language"), lang.el),
      h("div", { class: "pd-row" }, btn("Generate captions", () => ed.autoCaptions(status), "primary"), btn("Import SRT", () => ed.importCaptions())),
      status);
  },

  // ───────── Selected clip ─────────
  basic(ed) {
    const c = ed.clip();
    if (!c) return none();
    const tr = c.transform;
    const prop = (k) => () => ed.propNow(c, k);
    const setp = (k) => (v) => ed.writeProp(c, k, v);
    return h("div", {},
      sl(ed, "Scale", 10, 400, () => prop("scale")() * 100, (v) => setp("scale")(v / 100), { def: 100, signed: false, fmt: (v) => Math.round(v) + "%" }),
      sl(ed, "Position X", -100, 100, () => prop("x")() * 100, (v) => setp("x")(v / 100)),
      sl(ed, "Position Y", -100, 100, () => prop("y")() * 100, (v) => setp("y")(v / 100)),
      sl(ed, "Rotate", -180, 180, prop("rot"), setp("rot"), { fmt: (v) => Math.round(v) + "°" }),
      sl(ed, "Opacity", 0, 100, () => prop("opacity")() * 100, (v) => setp("opacity")(v / 100), { def: 100, signed: false, fmt: (v) => Math.round(v) + "%" }),
      h("div", { class: "pd-row" },
        btn("↺ 90°", () => ed.change("Rotate", () => { tr.rot = ((tr.rot - 90 + 540) % 360) - 180; })),
        btn("↻ 90°", () => ed.change("Rotate", () => { tr.rot = ((tr.rot + 90 + 540) % 360) - 180; })),
        btn("Mirror", () => ed.change("Mirror", () => { tr.flipH = !tr.flipH; })),
        btn("Flip", () => ed.change("Flip", () => { tr.flipV = !tr.flipV; })),
        btn("Reset", () => ed.change("Reset transform", () => { Object.assign(tr, { x: 0, y: 0, scale: 1, rot: 0, flipH: false, flipV: false, opacity: 1 }); c.kf = {}; }))),
      c.type !== "audio" && c.type !== "text" ? h("div", { class: "pd-field" }, h("span", {}, "Blend"), selectBox(BLENDS, c.blend || "normal", (v) => ed.change("Blend: " + v, () => { c.blend = v; })).el) : null,
      h("p", { class: "bc-hint" }, "Tip: drag, pinch or use the corner handle on the preview. Add a ◆ keyframe to animate these values over time."));
  },

  speed(ed) {
    const c = ed.clip();
    if (!c || !isMedia(c)) return none("Select a video or audio clip.");
    const mode = segmented([["normal", "Normal"], ["curve", "Curve"]], c.curve ? "curve" : "normal", (v) => { if (v === "normal") ed.change("Speed", () => setSpeed(c, c.speed, null)); mode.set(v); body.replaceChildren(v === "curve" ? curve() : normal()); });
    const normal = () => h("div", {},
      sl(ed, "Speed", -100, 100, () => Math.round(Math.log(c.speed) / Math.log(10) * 100), (v) => setSpeed(c, Math.round(10 ** (v / 100) * 100) / 100, null), { fmt: (v) => (Math.round(10 ** (v / 100) * 100) / 100).toFixed(2) + "×" }),
      h("div", { class: "bc-chips" }, [0.25, 0.5, 1, 1.5, 2, 3, 5, 10].map((s) => btn(s + "×", () => ed.change("Speed " + s + "×", () => setSpeed(c, s, null))))),
      h("p", { class: "bc-hint" }, `Duration ${fmtTime(c.dur, true)}. Audio pitch follows the speed.`));
    const curve = () => h("div", {}, grid(Object.entries(CURVES).map(([id, cv]) => ({ id, name: cv.name, art: curveArt(cv.pts) })), c.curve, (cv) => ed.change("Speed curve: " + cv.name, () => setSpeed(c, c.speed, cv.id))),
      h("p", { class: "bc-hint" }, "Curved speed mutes the clip's audio, like CapCut."));
    const body = h("div", {}, c.curve ? curve() : normal());
    return h("div", {}, mode.el, body);
  },

  volume(ed) {
    const c = ed.clip();
    if (!c || !isMedia(c)) return none("Select a video or audio clip.");
    return h("div", {},
      sl(ed, "Volume", 0, 200, () => ed.propNow(c, "volume") * 100, (v) => ed.writeProp(c, "volume", v / 100), { def: 100, signed: false, fmt: (v) => Math.round(v) + "%" }),
      sl(ed, "Fade in", 0, 10, () => c.fadeIn, (v) => { c.fadeIn = v; }, { step: 0.1, signed: false, fmt: (v) => (+v).toFixed(1) + "s" }),
      sl(ed, "Fade out", 0, 10, () => c.fadeOut, (v) => { c.fadeOut = v; }, { step: 0.1, signed: false, fmt: (v) => (+v).toFixed(1) + "s" }),
      h("div", { class: "pd-row" }, btn(c.mute ? "Unmute clip" : "Mute clip", () => ed.change(c.mute ? "Unmute" : "Mute", () => { c.mute = !c.mute; }))));
  },

  animation(ed) {
    const c = ed.clip();
    if (!c || c.type === "audio") return none();
    const kind = ed.animTab ||= "in";
    const cur = c.anim[kind];
    const list = ANIMS[kind].filter(([id]) => id !== "typewriter" || c.type === "text");
    const seg = segmented([["in", "In"], ["out", "Out"], ["combo", "Combo"]], kind, (v) => { ed.animTab = v; ed.reopenTool(); });
    return h("div", {}, seg.el,
      cur ? sl(ed, kind === "combo" ? "Speed" : "Duration", kind === "combo" ? 0.2 : 0.1, kind === "combo" ? 3 : Math.max(0.2, Math.min(5, c.dur)), () => kind === "combo" ? cur.speed || 1 : cur.dur, (v) => { if (kind === "combo") c.anim.combo.speed = v; else c.anim[kind].dur = v; }, { step: 0.1, signed: false, def: kind === "combo" ? 1 : 0.5, fmt: (v) => kind === "combo" ? (+v).toFixed(1) + "×" : (+v).toFixed(1) + "s" }) : null,
      grid([{ id: null, name: "None", art: "⦸" }, ...list.map(([id, name]) => ({ id, name, art: animArt(id) }))], cur?.id ?? null, (a) => ed.change("Animation: " + a.name, () => {
        c.anim[kind] = a.id ? (kind === "combo" ? { id: a.id, speed: 1 } : { id: a.id, dur: Math.min(c.dur / 2, cur?.dur || 0.6) }) : null;
        if (kind === "combo" && a.id) { c.anim.in = null; c.anim.out = null; }
        if (kind !== "combo" && a.id) c.anim.combo = null;
      })));
  },

  clipEffects(ed) {
    const c = ed.clip();
    if (!c || !(c.type === "video" || c.type === "image")) return none("Select a video or photo clip.");
    return h("div", {},
      c.effects.length ? section("On this clip", ...c.effects.map((e, i) => {
        const def = EFFECTS.find((x) => x.id === e.id);
        return h("div", { class: "bc-fxrow" },
          sl(ed, def?.name || e.id, 0, 100, () => e.amount, (v) => { c.effects[i].amount = v; }, { def: def?.def ?? 50, signed: false }),
          btn("Remove", () => ed.change("Remove effect", () => { c.effects.splice(i, 1); }), "ghost"));
      })) : null,
      tabs(cats(EFFECTS), (list) => grid(list.map((e) => ({ ...e, art: fxArt(e) })), null, (e) => ed.change("Effect: " + e.name, () => { c.effects.push({ id: e.id, amount: e.def }); }))));
  },

  effectClip(ed) {
    const c = ed.clip();
    if (!c?.effect) return none();
    const def = EFFECTS.find((x) => x.id === c.effect.id);
    return h("div", {},
      sl(ed, "Intensity", 0, 100, () => c.effect.amount ?? def?.def, (v) => { c.effect.amount = v; }, { def: def?.def ?? 50, signed: false }),
      tabs(cats(EFFECTS), (list) => grid(list.map((e) => ({ ...e, art: fxArt(e) })), c.effect.id, (e) => ed.change("Effect: " + e.name, () => { c.effect = { id: e.id, amount: e.def }; }))));
  },

  mask(ed) {
    const c = ed.clip();
    if (!c || !(c.type === "video" || c.type === "image")) return none("Select a video or photo clip.");
    const m = c.mask;
    return h("div", {},
      grid(MASKS.map(([id, name]) => ({ id, name, art: maskArt(id) })), m?.type || "none", (x) => ed.change("Mask: " + x.name, () => { c.mask = x.id === "none" ? null : { ...defaultMask(x.id), ...(m || {}), type: x.id }; }), { small: true }),
      m ? h("div", {},
        sl(ed, "Size", 1, 200, () => m.w * 100, (v) => { c.mask.w = v / 100; if (["circle", "heart", "star"].includes(m.type)) c.mask.h = v / 100; }, { def: 50, signed: false }),
        ["rect", "mirror", "diamond", "circle"].includes(m.type) ? sl(ed, "Height", 1, 200, () => m.h * 100, (v) => { c.mask.h = v / 100; }, { def: 50, signed: false }) : null,
        sl(ed, "Position X", -100, 100, () => m.x * 100, (v) => { c.mask.x = v / 100; }),
        sl(ed, "Position Y", -100, 100, () => m.y * 100, (v) => { c.mask.y = v / 100; }),
        sl(ed, "Rotate", -180, 180, () => m.rot, (v) => { c.mask.rot = v; }),
        sl(ed, "Feather", 0, 100, () => m.feather * 200, (v) => { c.mask.feather = v / 200; }, { signed: false }),
        m.type === "rect" ? sl(ed, "Round corners", 0, 100, () => m.round * 100, (v) => { c.mask.round = v / 100; }, { signed: false }) : null,
        h("div", { class: "pd-row" }, btn(m.invert ? "Un-invert" : "Invert", () => ed.change("Invert mask", () => { c.mask.invert = !m.invert; })))) : null);
  },

  chroma(ed) {
    const c = ed.clip();
    if (!c || !(c.type === "video" || c.type === "image")) return none("Select a video or photo clip.");
    const k = c.chroma || { on: false, color: "#00ff00", intensity: 0.3, shadow: 0.2 };
    const color = h("input", { type: "color", value: k.color });
    color.addEventListener("change", () => ed.change("Chroma colour", () => { c.chroma = { ...k, on: true, color: color.value }; }));
    return h("div", {},
      h("p", { class: "bc-hint" }, "Removes a background colour, like a green screen. Pick the colour, or tap the picker and then the preview."),
      h("div", { class: "pd-row" },
        btn(k.on ? "Turn off" : "Turn on", () => ed.change("Chroma key", () => { c.chroma = { ...k, on: !k.on }; })),
        h("label", { class: "bc-color" }, "Colour ", color),
        btn("Pick from preview", () => ed.pickColor((hex) => ed.change("Chroma colour", () => { c.chroma = { ...k, on: true, color: hex }; })))),
      h("div", { class: "bc-swatches" }, ["#00ff00", "#00b140", "#0047bb", "#ffffff", "#000000"].map((col) => {
        const b = h("button", { type: "button", style: { background: col }, class: k.color === col ? "on" : "" });
        b.addEventListener("click", () => ed.change("Chroma colour", () => { c.chroma = { ...k, on: true, color: col }; }));
        return b;
      })),
      sl(ed, "Intensity", 0, 100, () => k.intensity * 100, (v) => { c.chroma = { ...(c.chroma || k), on: true, intensity: v / 100 }; }, { signed: false, def: 30 }),
      sl(ed, "Shadow", 0, 100, () => k.shadow * 100, (v) => { c.chroma = { ...(c.chroma || k), on: true, shadow: v / 100 }; }, { signed: false, def: 20 }));
  },

  crop(ed) {
    const c = ed.clip();
    if (!c || !(c.type === "video" || c.type === "image")) return none("Select a video or photo clip.");
    const ratios = [["free", "Free"], ["1:1", "1:1"], ["9:16", "9:16"], ["16:9", "16:9"], ["4:5", "4:5"], ["3:4", "3:4"], ["4:3", "4:3"]];
    return h("div", {},
      h("p", { class: "bc-hint" }, "Drag the corners of the frame on the preview."),
      grid(ratios.map(([id, name]) => ({ id, name, art: ratioArt(id) })), ed.cropRatio || "free", (r) => { ed.cropRatio = r.id; ed.applyCropRatio(c, r.id); }, { small: true }),
      h("div", { class: "pd-row" }, btn("Reset", () => ed.change("Reset crop", () => { c.crop = { l: 0, t: 0, r: 1, b: 1 }; })), btn("Done", () => ed.closeTool(), "primary")));
  },

  textEdit(ed) {
    const c = ed.clip();
    if (c?.type !== "text") return none("Select a text clip.");
    const ta = h("textarea", { class: "bc-textarea", rows: 3 }, c.text.content);
    ta.addEventListener("input", () => ed.live("Edit text", () => { c.text.content = ta.value; }));
    ta.addEventListener("change", () => ed.endChange());
    setTimeout(() => ta.focus(), 50);
    return h("div", {}, ta, PANELS.textStyle(ed, true));
  },

  textStyle(ed, embedded) {
    const c = ed.clip();
    if (c?.type !== "text") return none("Select a text clip.");
    const t = c.text;
    const tab = ed.textTab ||= "style";
    const seg = segmented([["style", "Templates"], ["font", "Font"], ["color", "Colour"], ["stroke", "Stroke"], ["bg", "Background"], ["shadow", "Shadow"], ["layout", "Layout"]], tab, (v) => { ed.textTab = v; seg.set(v); body.replaceChildren(render(v)); }, "bc-tabs");
    const colorRow = (get, set, label) => h("div", { class: "bc-swatches" }, TEXT_COLORS.map((col) => {
      const b = h("button", { type: "button", style: { background: col }, class: get() === col ? "on" : "", "aria-label": label + " " + col });
      b.addEventListener("click", () => ed.change(label, () => set(col)));
      return b;
    }), (() => { const i = h("input", { type: "color", value: get() || "#ffffff" }); i.addEventListener("change", () => ed.change(label, () => set(i.value))); return i; })());
    const render = (v) => {
      if (v === "style") return grid(TEXT_STYLES.map((s) => ({ ...s, art: "Aa", style: tileTextStyle(s.s) })), t.style, (s) => ed.change("Text style", () => { c.text = { ...t, ...structuredClone(s.s), content: t.content, style: s.id, stroke: { ...t.stroke, width: 0, ...(s.s.stroke || {}) }, bg: { ...t.bg, opacity: 0, ...(s.s.bg || {}) }, shadow: { ...t.shadow, opacity: 0, blur: 0, x: 0, y: 0, ...(s.s.shadow || {}) }, gradient: s.s.gradient || null }; if (s.s.font) ensureFont(s.s.font); }));
      if (v === "font") return h("div", {}, h("div", { class: "bc-fonts" }, FONTS.map(([f, name]) => {
        ensureFont(f);
        const b = h("button", { type: "button", class: t.font === f ? "on" : "", style: { fontFamily: `"${f}", system-ui` } }, name);
        b.addEventListener("click", () => ed.change("Font", () => { t.font = f; }));
        return b;
      })), h("div", { class: "pd-row" },
        btn("B", () => ed.change("Bold", () => { t.bold = !t.bold; }), t.bold ? "on" : ""),
        btn("I", () => ed.change("Italic", () => { t.italic = !t.italic; }), t.italic ? "on" : ""),
        btn("U", () => ed.change("Underline", () => { t.underline = !t.underline; }), t.underline ? "on" : "")),
        sl(ed, "Size", 12, 300, () => t.size, (val) => { t.size = val; }, { def: 64, signed: false }));
      if (v === "color") return h("div", {}, colorRow(() => t.color, (col) => { t.color = col; t.gradient = null; }, "Text colour"),
        sl(ed, "Opacity", 0, 100, () => c.transform.opacity * 100, (val) => { c.transform.opacity = val / 100; }, { def: 100, signed: false }));
      if (v === "stroke") return h("div", {}, colorRow(() => t.stroke.color, (col) => { t.stroke.color = col; if (!t.stroke.width) t.stroke.width = 5; }, "Stroke colour"),
        sl(ed, "Thickness", 0, 30, () => t.stroke.width, (val) => { t.stroke.width = val; }, { signed: false }));
      if (v === "bg") return h("div", {}, colorRow(() => t.bg.color, (col) => { t.bg.color = col; if (!t.bg.opacity) t.bg.opacity = 1; }, "Background"),
        sl(ed, "Opacity", 0, 100, () => t.bg.opacity * 100, (val) => { t.bg.opacity = val / 100; }, { signed: false }),
        sl(ed, "Corners", 0, 60, () => t.bg.radius, (val) => { t.bg.radius = val; }, { signed: false, def: 12 }),
        sl(ed, "Padding", 0, 60, () => t.bg.pad, (val) => { t.bg.pad = val; }, { signed: false, def: 16 }));
      if (v === "shadow") return h("div", {}, colorRow(() => t.shadow.color, (col) => { t.shadow.color = col; if (!t.shadow.opacity) t.shadow.opacity = 0.7; if (!t.shadow.blur && !t.shadow.x) { t.shadow.blur = 10; t.shadow.y = 4; } }, "Shadow"),
        sl(ed, "Opacity", 0, 100, () => t.shadow.opacity * 100, (val) => { t.shadow.opacity = val / 100; }, { signed: false }),
        sl(ed, "Blur", 0, 60, () => t.shadow.blur, (val) => { t.shadow.blur = val; }, { signed: false }),
        sl(ed, "Offset X", -30, 30, () => t.shadow.x, (val) => { t.shadow.x = val; }),
        sl(ed, "Offset Y", -30, 30, () => t.shadow.y, (val) => { t.shadow.y = val; }));
      return h("div", {},
        segmented([["left", "Left"], ["center", "Centre"], ["right", "Right"]], t.align, (a) => ed.change("Align", () => { t.align = a; })).el,
        sl(ed, "Letter spacing", -10, 40, () => t.spacing, (val) => { t.spacing = val; }),
        sl(ed, "Line height", 80, 250, () => t.lineHeight * 100, (val) => { t.lineHeight = val / 100; }, { def: 120, signed: false }),
        sl(ed, "Box width", 20, 100, () => t.width * 100, (val) => { t.width = val / 100; }, { def: 86, signed: false }));
    };
    const body = h("div", {}, render(tab));
    return h("div", { class: embedded ? "" : "" }, seg.el, body);
  },

  filterClip(ed) { return PANELS.filters(ed); },
  adjustClip(ed) { return PANELS.adjust(ed); },
};

function none(msg = "Select a clip on the timeline.") { return h("p", { class: "bc-hint" }, msg); }
function bigBtn(label, icon, onclick) {
  return h("button", { type: "button", class: "bc-big", onclick }, h("span", {}, svgIcon(icon, 22)), label);
}
function tileTextStyle(s) {
  return {
    color: s.color || "#fff", fontFamily: s.font ? `"${s.font}", system-ui` : "inherit", fontWeight: 700,
    WebkitTextStroke: s.stroke?.width ? `${Math.min(2, s.stroke.width / 4)}px ${s.stroke.color}` : "",
    background: s.bg?.opacity ? s.bg.color : s.gradient ? `linear-gradient(${s.gradient[0]},${s.gradient[1]})` : "",
    textShadow: s.shadow?.opacity ? `${(s.shadow.x || 0) / 3}px ${(s.shadow.y || 0) / 3}px ${(s.shadow.blur || 0) / 3}px ${s.shadow.color}` : "",
    borderRadius: s.bg?.opacity ? "6px" : "", padding: "0 4px",
  };
}
function fxArt(e) {
  const hue = (e.n * 47) % 360;
  return h("i", { style: { background: `linear-gradient(135deg,hsl(${hue} 70% 55%),hsl(${(hue + 60) % 360} 70% 35%))` } }, "✦");
}
function animArt(id) { return { fade: "◐", zoomin: "⤢", zoomout: "⤡", slidel: "←", slider: "→", slideu: "↑", slided: "↓", rotate: "⟳", bounce: "⇡", spin: "↻", blur: "◌", drop: "⇣", shrink: "•", typewriter: "⌨", rock: "≀", pulse: "♥", swing: "∿", shake: "≋", float: "~", wobble: "≈", heartbeat: "❤" }[id] || "✦"; }
function maskArt(id) { return { none: "⦸", linear: "▬", mirror: "═", circle: "●", rect: "■", heart: "♥", star: "★", diamond: "◆" }[id]; }
function ratioArt(id) {
  if (id === "original" || id === "free") return h("i", { class: "bc-ratio", style: { width: "22px", height: "16px", borderStyle: "dashed" } });
  const [a, b] = id.split(":").map(Number);
  const k = 22 / Math.max(a, b);
  return h("i", { class: "bc-ratio", style: { width: Math.max(6, a * k) + "px", height: Math.max(6, b * k) + "px" } });
}
function curveArt(pts) {
  const mx = Math.max(...pts);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${(i / (pts.length - 1)) * 40} ${20 - (v / mx) * 18}`).join(" ");
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 40 22");
  s.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2"/>`;
  return s;
}

export const ADJ_LIST = ADJ;
export { newTextClip };
