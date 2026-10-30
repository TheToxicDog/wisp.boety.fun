// BoetyCut: project model, timing helpers and the built-in catalogs
// (filters, effects, transitions, animations, text styles, stickers).
// Parts are ported from OpenCut (MIT, github.com/OpenCut-app/opencut-classic):
// SRT parsing and bezier keyframe easing.

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const clone = (o) => structuredClone(o);

export const RATIOS = [
  ["original", "Original"], ["9:16", "9:16"], ["16:9", "16:9"], ["1:1", "1:1"], ["4:5", "4:5"],
  ["3:4", "3:4"], ["4:3", "4:3"], ["2:1", "2:1"], ["2.35:1", "2.35:1"], ["1.85:1", "1.85:1"],
];

export function ratioSize(ratio, base = 1080, orig) {
  let r;
  if (ratio === "original" && orig) r = orig.w / orig.h;
  else if (ratio === "original") r = 9 / 16;
  else { const [a, b] = ratio.split(":").map(Number); r = a / b; }
  // short edge = base (1080p), dimensions even for encoders
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return r >= 1 ? { w: even(base * r), h: base } : { w: base, h: even(base / r) };
}

export const TRACK_KINDS = {
  main: { label: "Main", color: "#2a2f3a" },
  video: { label: "Overlay", color: "#3a5f9a" },
  text: { label: "Text", color: "#a35bd6" },
  sticker: { label: "Sticker", color: "#d68a2c" },
  effect: { label: "Effect", color: "#c94f8a" },
  filter: { label: "Filter", color: "#3fa79b" },
  adjust: { label: "Adjust", color: "#5a8f3d" },
  audio: { label: "Audio", color: "#2f7d5b" },
};
// Draw order bottom → top for visual tracks; audio last.
export const KIND_ORDER = ["main", "video", "sticker", "text", "effect", "filter", "adjust", "audio"];

export function newProject(name = "Untitled") {
  return {
    id: uid(), name, created: Date.now(), updated: Date.now(), v: 1,
    ratio: "9:16", w: 1080, h: 1920, fps: 30,
    bg: { type: "blur", color: "#000000", blur: 40 },
    tracks: [{ id: uid(), kind: "main", items: [], muted: false, hidden: false, locked: false }],
    cover: null,
  };
}

export const defaultTransform = () => ({ x: 0, y: 0, scale: 1, rot: 0, flipH: false, flipV: false, opacity: 1 });
export const defaultAdjust = () => ({
  brightness: 0, contrast: 0, saturation: 0, exposure: 0, sharpen: 0, highlights: 0, shadows: 0,
  temperature: 0, tint: 0, hue: 0, fade: 0, vignette: 0, grain: 0,
});

/** A new clip. Media clips: in/out are seconds in the source. */
export function newClip(type, o = {}) {
  const base = {
    id: uid(), type, start: 0, dur: o.dur ?? 3, speed: 1, curve: null,
    transform: defaultTransform(), crop: { l: 0, t: 0, r: 1, b: 1 },
    filter: null, adjust: defaultAdjust(), effects: [], anim: { in: null, out: null, combo: null },
    mask: null, chroma: null, blend: "normal", kf: {},
    volume: 1, fadeIn: 0, fadeOut: 0, mute: false, transition: null,
  };
  return { ...base, ...o };
}

export function newTextClip(text = "Add text", o = {}) {
  return newClip("text", {
    dur: 3,
    text: {
      content: text, font: "Inter", size: 64, color: "#ffffff", bold: true, italic: false, underline: false,
      align: "center", spacing: 0, lineHeight: 1.2, stroke: { color: "#000000", width: 0 },
      shadow: { color: "#000000", blur: 0, x: 0, y: 0, opacity: 0.6 }, bg: { color: "#000000", opacity: 0, radius: 12, pad: 16 },
      gradient: null, style: null, width: 0.86,
    },
    ...o,
  });
}

// ───────── Timing ─────────
export const isMedia = (c) => c.type === "video" || c.type === "audio";
export const hasVisual = (c) => c.type !== "audio";
export const clipEnd = (c) => c.start + c.dur;

/** Speed-curve presets (CapCut "Curve"): speed multipliers at evenly spaced points. */
export const CURVES = {
  montage: { name: "Montage", pts: [1, 1, 3, 3, 0.5, 0.5, 1, 1] },
  hero: { name: "Hero", pts: [1, 1.5, 0.25, 0.25, 1.5, 1] },
  bullet: { name: "Bullet", pts: [2, 2, 0.2, 0.2, 2, 2] },
  jump: { name: "Jump cut", pts: [1, 1, 5, 1, 1, 5, 1, 1] },
  flashin: { name: "Flash in", pts: [5, 3, 1, 1, 1, 1] },
  flashout: { name: "Flash out", pts: [1, 1, 1, 1, 3, 5] },
};

function curveSpeed(pts, u) {
  const f = clamp(u, 0, 1) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  return pts[i] + (pts[i + 1] - pts[i]) * (f - i);
}
function curveMean(pts) {
  let s = 0; const n = 64;
  for (let i = 0; i < n; i++) s += curveSpeed(pts, (i + 0.5) / n);
  return s / n;
}

/** Effective average speed (for clip length). */
export const meanSpeed = (c) => c.speed * (c.curve ? curveMean(CURVES[c.curve]?.pts || [1, 1]) : 1);

/** Source seconds shown at timeline-local time `lt` (0..dur) of a media clip. */
export function sourceTime(c, lt) {
  const span = c.out - c.in;
  if (c.curve && CURVES[c.curve]) {
    const pts = CURVES[c.curve].pts, n = 32, u = clamp(lt / c.dur, 0, 1);
    // integrate speed profile to u, normalised by the full integral
    let acc = 0, tot = 0;
    for (let i = 0; i < n; i++) {
      const s = curveSpeed(pts, (i + 0.5) / n);
      tot += s;
      const a = i / n, b = (i + 1) / n;
      if (u >= b) acc += s; else if (u > a) acc += s * (u - a) * n;
    }
    return c.in + span * (acc / tot);
  }
  return c.in + lt * c.speed;
}

export function setSpeed(c, speed, curve = c.curve) {
  c.speed = clamp(speed, 0.1, 100);
  c.curve = curve;
  if (isMedia(c)) c.dur = Math.max(0.05, (c.out - c.in) / meanSpeed(c));
}

/** Lay main-track clips end to end (CapCut's magnetic main track). */
export function layoutMain(p) {
  const main = p.tracks.find((t) => t.kind === "main");
  let t = 0;
  for (const c of main.items) { c.start = t; t += c.dur; }
}

export function projectDuration(p) {
  let d = 0;
  for (const tr of p.tracks) for (const c of tr.items) d = Math.max(d, clipEnd(c));
  return d;
}

export function findClip(p, id) {
  for (const tr of p.tracks) {
    const i = tr.items.findIndex((c) => c.id === id);
    if (i >= 0) return { track: tr, clip: tr.items[i], index: i };
  }
  return null;
}

/** First track of a kind with room for [start, start+dur), creating one if needed. */
export function trackFor(p, kind, start, dur, exceptId) {
  for (const tr of p.tracks) {
    if (tr.kind !== kind) continue;
    if (tr.items.every((c) => c.id === exceptId || clipEnd(c) <= start + 1e-6 || c.start >= start + dur - 1e-6)) return tr;
  }
  const tr = { id: uid(), kind, items: [], muted: false, hidden: false, locked: false };
  p.tracks.push(tr);
  sortTracks(p);
  return tr;
}

export function sortTracks(p) {
  p.tracks.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

export function pruneTracks(p) {
  p.tracks = p.tracks.filter((t) => t.kind === "main" || t.items.length);
}

export function sortItems(tr) { tr.items.sort((a, b) => a.start - b.start); }

/** Split a clip at timeline time T; returns the new right-hand clip. */
export function splitClip(p, id, T) {
  const f = findClip(p, id);
  if (!f) return null;
  const c = f.clip;
  const lt = T - c.start;
  if (lt <= 0.04 || lt >= c.dur - 0.04) return null;
  const right = clone(c);
  right.id = uid();
  if (isMedia(c)) {
    const mid = sourceTime(c, lt);
    right.in = mid; c.out = mid;
    if (c.curve) { right.curve = null; c.curve = null; right.speed = c.speed = meanSpeed(c) || 1; }
  }
  right.start = T; right.dur = c.dur - lt; c.dur = lt;
  right.anim = { ...c.anim, in: null }; c.anim = { ...c.anim, out: null };
  right.fadeIn = 0; c.fadeOut = 0;
  c.transition = null;
  // keyframes: split their timelines
  for (const [k, list] of Object.entries(c.kf || {})) {
    c.kf[k] = list.filter((q) => q.t <= lt);
    right.kf[k] = list.filter((q) => q.t >= lt).map((q) => ({ ...q, t: q.t - lt }));
  }
  f.track.items.splice(f.index + 1, 0, right);
  if (f.track.kind === "main") layoutMain(p);
  return right;
}

// ───────── Keyframes (bezier easing ported from OpenCut animation/bezier.ts) ─────────
export const KF_PROPS = ["x", "y", "scale", "rot", "opacity", "volume"];

function bezier(t, p1, p2) {
  // cubic-bezier(p1x, p1y, p2x, p2y) solved for x = t by bisection (OpenCut: solveBezierProgressForTime)
  const B = (u, a, b) => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (B(m, p1[0], p2[0]) < t) lo = m; else hi = m; }
  return B((lo + hi) / 2, p1[1], p2[1]);
}
export const EASES = {
  linear: (t) => t,
  ease: (t) => bezier(t, [0.42, 0], [0.58, 1]),
  in: (t) => bezier(t, [0.42, 0], [1, 1]),
  out: (t) => bezier(t, [0, 0], [0.58, 1]),
  hold: () => 0,
};

export function kfValue(list, lt, fallback) {
  if (!list || !list.length) return fallback;
  if (lt <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (lt >= last.t) return last.v;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (lt >= a.t && lt <= b.t) {
      const u = (lt - a.t) / Math.max(1e-6, b.t - a.t);
      const e = (EASES[a.ease] || EASES.ease)(u);
      return a.v + (b.v - a.v) * e;
    }
  }
  return fallback;
}

/** Property value at local time, honouring keyframes. */
export function propAt(c, prop, lt) {
  const base = prop === "volume" ? c.volume : c.transform[prop];
  return kfValue(c.kf?.[prop], lt, base);
}

export function setKeyframe(c, lt, props = KF_PROPS) {
  for (const k of props) {
    const v = k === "volume" ? c.volume : c.transform[k];
    const list = (c.kf[k] ||= []);
    const i = list.findIndex((q) => Math.abs(q.t - lt) < 1 / 60);
    if (i >= 0) list[i].v = v; else list.push({ t: lt, v, ease: "ease" });
    list.sort((a, b) => a.t - b.t);
  }
}

export function removeKeyframe(c, lt) {
  for (const k of Object.keys(c.kf || {})) c.kf[k] = c.kf[k].filter((q) => Math.abs(q.t - lt) >= 1 / 60);
}

export function keyframeTimes(c) {
  const s = new Set();
  for (const list of Object.values(c.kf || {})) for (const q of list) s.add(Math.round(q.t * 600) / 600);
  return [...s].sort((a, b) => a - b);
}

/** When the user edits a property and keyframes exist, write a keyframe instead. */
export function writeProp(c, prop, v, lt) {
  const list = c.kf?.[prop];
  if (list?.length) {
    const i = list.findIndex((q) => Math.abs(q.t - lt) < 1 / 60);
    if (i >= 0) list[i].v = v; else { list.push({ t: lt, v, ease: "ease" }); list.sort((a, b) => a.t - b.t); }
    return;
  }
  if (prop === "volume") c.volume = v; else c.transform[prop] = v;
}

// ───────── Catalogs ─────────
// Filters are colour looks: adjustment deltas plus optional split toning.
const F = (id, name, cat, a, tone) => ({ id, name, cat, a, tone });
export const FILTERS = [
  F("fresh", "Fresh", "Life", { brightness: 6, saturation: 12, temperature: -6, contrast: 4 }),
  F("glow", "Glow", "Life", { brightness: 8, highlights: -8, fade: 8, saturation: 6 }),
  F("vivid", "Vivid", "Life", { saturation: 30, contrast: 10 }),
  F("clear", "Clear", "Life", { contrast: 12, sharpen: 30, saturation: 6 }),
  F("warm", "Warm", "Life", { temperature: 25, saturation: 6 }),
  F("cool", "Cool", "Life", { temperature: -25, tint: -4 }),
  F("delicious", "Delicious", "Food", { saturation: 25, temperature: 12, contrast: 8, brightness: 4 }),
  F("creamy", "Creamy", "Food", { fade: 15, temperature: 10, contrast: -8 }),
  F("film", "Film", "Movie", { contrast: 12, fade: 12, saturation: -10, grain: 20 }, { sh: [180, 0.15], hi: [35, 0.12] }),
  F("tealorange", "Teal & Orange", "Movie", { contrast: 15, saturation: 6 }, { sh: [190, 0.35], hi: [32, 0.3] }),
  F("cinema", "Cinema", "Movie", { contrast: 20, saturation: -15, vignette: 25 }, { sh: [200, 0.2], hi: [40, 0.1] }),
  F("blockbuster", "Blockbuster", "Movie", { contrast: 30, saturation: 10, shadows: -15 }, { sh: [205, 0.3], hi: [30, 0.25] }),
  F("moody", "Moody", "Movie", { exposure: -10, contrast: 20, saturation: -25, vignette: 30 }),
  F("retro", "Retro", "Retro", { fade: 22, saturation: -15, temperature: 15, grain: 25 }, { sh: [30, 0.12], hi: [50, 0.1] }),
  F("vintage", "Vintage", "Retro", { fade: 28, saturation: -30, temperature: 20, contrast: -10, vignette: 20 }),
  F("polaroid", "Polaroid", "Retro", { fade: 18, contrast: -6, temperature: 8, tint: 6 }, { sh: [170, 0.12] }),
  F("vhs", "VHS", "Retro", { saturation: 15, contrast: -10, sharpen: -20, grain: 35 }, { sh: [280, 0.15] }),
  F("sunset", "Sunset", "Mood", { temperature: 30, tint: 10, saturation: 15 }, { hi: [25, 0.3] }),
  F("pastel", "Pastel", "Mood", { fade: 20, saturation: -10, brightness: 8 }, { sh: [300, 0.12], hi: [190, 0.1] }),
  F("cyber", "Cyber", "Mood", { contrast: 20, saturation: 20 }, { sh: [260, 0.4], hi: [180, 0.3] }),
  F("dream", "Dream", "Mood", { brightness: 10, fade: 15, highlights: 15, saturation: -5 }, { hi: [320, 0.12] }),
  F("forest", "Forest", "Mood", { saturation: 10, tint: -12, contrast: 8 }, { sh: [140, 0.2] }),
  F("bw", "B&W", "B&W", { saturation: -100, contrast: 10 }),
  F("noir", "Noir", "B&W", { saturation: -100, contrast: 40, shadows: -20, vignette: 30, grain: 15 }),
  F("silver", "Silver", "B&W", { saturation: -100, fade: 18, brightness: 6 }),
  F("sepia", "Sepia", "B&W", { saturation: -100 }, { sh: [35, 0.35], hi: [40, 0.25] }),
];

// Effects: one shader, switched by id. `cat` groups them in the picker.
const E = (id, n, name, cat, def = 50) => ({ id, n, name, cat, def });
export const EFFECTS = [
  E("blur", 1, "Blur", "Basic", 40), E("shake", 2, "Shake", "Basic"), E("zoom", 3, "Zoom Pulse", "Basic"),
  E("flash", 4, "Flash", "Basic"), E("strobe", 5, "Strobe", "Basic"), E("vignette", 6, "Dark Edges", "Basic"),
  E("mosaic", 7, "Mosaic", "Basic"), E("mirror", 8, "Mirror", "Split"), E("kaleido", 9, "Kaleidoscope", "Split"),
  E("split3", 10, "Triple Split", "Split"), E("split4", 11, "Four Split", "Split"),
  E("rgb", 12, "RGB Split", "Retro"), E("glitch", 13, "Glitch", "Retro"), E("vhs", 14, "VHS", "Retro"),
  E("scanlines", 15, "Old TV", "Retro"), E("grain", 16, "Film Grain", "Retro"), E("lightleak", 17, "Light Leak", "Retro"),
  E("wave", 18, "Wave", "Dreamy"), E("fisheye", 19, "Fisheye", "Dreamy"), E("glow", 20, "Soft Glow", "Dreamy"),
  E("rainbow", 21, "Rainbow", "Dreamy"), E("sparkle", 22, "Sparkle", "Dreamy"),
  E("invert", 23, "Invert", "Color"), E("posterize", 24, "Posterize", "Color"), E("duotone", 25, "Duotone", "Color"),
  E("sketch", 26, "Sketch", "Color"), E("neon", 27, "Neon Edges", "Color"), E("bars", 28, "Cinematic Bars", "Basic"),
  E("blackfade", 29, "Fade to Black", "Basic"), E("heat", 30, "Heat Haze", "Dreamy"),
];
export const effectById = (id) => EFFECTS.find((e) => e.id === id);

const T = (id, n, name, cat) => ({ id, n, name, cat });
export const TRANSITIONS = [
  T("dissolve", 1, "Dissolve", "Basic"), T("black", 2, "Fade Black", "Basic"), T("white", 3, "Flash White", "Basic"),
  T("wipel", 4, "Wipe Left", "Wipe"), T("wiper", 5, "Wipe Right", "Wipe"), T("wipeu", 6, "Wipe Up", "Wipe"), T("wiped", 7, "Wipe Down", "Wipe"),
  T("slidel", 8, "Slide Left", "Slide"), T("slider", 9, "Slide Right", "Slide"), T("slideu", 10, "Slide Up", "Slide"), T("slided", 11, "Slide Down", "Slide"),
  T("zoomin", 12, "Zoom In", "Camera"), T("zoomout", 13, "Zoom Out", "Camera"), T("spin", 14, "Spin", "Camera"),
  T("blurx", 15, "Blur", "Camera"), T("circleopen", 16, "Circle Open", "Shape"), T("circleclose", 17, "Circle Close", "Shape"),
  T("clock", 18, "Clock Wipe", "Shape"), T("pixel", 19, "Pixelate", "Glitch"), T("glitch", 20, "Glitch", "Glitch"),
  T("doors", 21, "Doors", "Shape"), T("diamond", 22, "Diamond", "Shape"), T("rgbsplit", 23, "RGB Shift", "Glitch"),
];
export const transitionById = (id) => TRANSITIONS.find((t) => t.id === id);

// Animations: in / out / combo. Implemented in cut-render.js animState().
export const ANIMS = {
  in: [["fade", "Fade In"], ["zoomin", "Zoom In"], ["zoomout", "Zoom Out"], ["slidel", "Slide Left"], ["slider", "Slide Right"],
    ["slideu", "Slide Up"], ["slided", "Slide Down"], ["rotate", "Rotate"], ["bounce", "Bounce"], ["spin", "Spin In"], ["blur", "Blur In"], ["drop", "Drop"], ["typewriter", "Typewriter"]],
  out: [["fade", "Fade Out"], ["zoomin", "Zoom In"], ["zoomout", "Zoom Out"], ["slidel", "Slide Left"], ["slider", "Slide Right"],
    ["slideu", "Slide Up"], ["slided", "Slide Down"], ["rotate", "Rotate"], ["spin", "Spin Out"], ["blur", "Blur Out"], ["shrink", "Shrink"]],
  combo: [["rock", "Rock"], ["pulse", "Pulse"], ["swing", "Swing"], ["shake", "Shake"], ["float", "Float"], ["spin", "Spinning"], ["wobble", "Wobble"], ["heartbeat", "Heartbeat"]],
};

export const MASKS = [
  ["none", "None"], ["linear", "Linear"], ["mirror", "Mirror"], ["circle", "Circle"], ["rect", "Rectangle"],
  ["heart", "Heart"], ["star", "Star"], ["diamond", "Diamond"],
];
export const defaultMask = (type) => ({ type, x: 0, y: 0, w: 0.5, h: 0.5, rot: 0, feather: 0.05, invert: false, round: 0 });

export const BLENDS = [
  ["normal", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"], ["overlay", "Overlay"], ["darken", "Darken"],
  ["lighten", "Lighten"], ["add", "Add"], ["difference", "Difference"], ["softlight", "Soft Light"], ["colorburn", "Color Burn"],
];
export const BLEND_N = Object.fromEntries(BLENDS.map(([k], i) => [k, i]));

export const FONTS = [
  ["Inter", "Inter"], ["system-ui", "System"], ["Georgia", "Serif"], ["Courier New", "Typewriter"],
  ["Bebas Neue", "Bebas Neue"], ["Montserrat", "Montserrat"], ["Anton", "Anton"], ["Oswald", "Oswald"],
  ["Pacifico", "Pacifico"], ["Lobster", "Lobster"], ["Dancing Script", "Dancing Script"], ["Permanent Marker", "Marker"],
  ["Playfair Display", "Playfair"], ["Caveat", "Caveat"], ["Press Start 2P", "Pixel"], ["Bangers", "Bangers"],
  ["Righteous", "Righteous"], ["Poppins", "Poppins"],
];
export const WEB_FONTS = new Set(FONTS.map(([f]) => f).filter((f) => !["Inter", "system-ui", "Georgia", "Courier New"].includes(f)));

export const TEXT_STYLES = [
  { id: "plain", name: "Plain", s: { color: "#ffffff", stroke: { color: "#000000", width: 0 }, bg: { color: "#000000", opacity: 0, radius: 12, pad: 16 }, shadow: { color: "#000000", blur: 0, x: 0, y: 0, opacity: 0.6 } } },
  { id: "outline", name: "Outline", s: { color: "#ffffff", stroke: { color: "#000000", width: 8 } } },
  { id: "subtitle", name: "Subtitle", s: { color: "#ffe14d", stroke: { color: "#000000", width: 6 }, bold: true } },
  { id: "box", name: "Box", s: { color: "#ffffff", bg: { color: "#000000", opacity: 0.7, radius: 14, pad: 18 }, stroke: { color: "#000000", width: 0 } } },
  { id: "bubble", name: "Bubble", s: { color: "#111111", bg: { color: "#ffffff", opacity: 1, radius: 40, pad: 22 }, stroke: { color: "#000000", width: 0 } } },
  { id: "neon", name: "Neon", s: { color: "#ffffff", shadow: { color: "#ff3ec8", blur: 30, x: 0, y: 0, opacity: 1 }, stroke: { color: "#ff3ec8", width: 3 } } },
  { id: "glow", name: "Glow", s: { color: "#e9fbff", shadow: { color: "#2ad4ff", blur: 26, x: 0, y: 0, opacity: 1 } } },
  { id: "shadow", name: "Drop Shadow", s: { color: "#ffffff", shadow: { color: "#000000", blur: 6, x: 6, y: 6, opacity: 0.8 } } },
  { id: "red", name: "Red Label", s: { color: "#ffffff", bg: { color: "#e5484d", opacity: 1, radius: 8, pad: 14 } } },
  { id: "yellow", name: "Yellow Label", s: { color: "#111111", bg: { color: "#ffd400", opacity: 1, radius: 8, pad: 14 } } },
  { id: "gradient", name: "Gradient", s: { color: "#ffffff", gradient: ["#ff7a59", "#ffd25a"], stroke: { color: "#3a1200", width: 4 } } },
  { id: "comic", name: "Comic", s: { color: "#ffe14d", font: "Bangers", stroke: { color: "#1b1b1b", width: 10 }, shadow: { color: "#e5484d", blur: 0, x: 6, y: 6, opacity: 1 } } },
  { id: "retro", name: "Retro", s: { color: "#ffcf5a", font: "Righteous", shadow: { color: "#d6336c", blur: 0, x: 5, y: 5, opacity: 1 } } },
  { id: "handwritten", name: "Handwritten", s: { color: "#ffffff", font: "Caveat", bold: false, shadow: { color: "#000000", blur: 8, x: 0, y: 2, opacity: 0.5 } } },
  { id: "title", name: "Title", s: { color: "#ffffff", font: "Bebas Neue", bold: false, spacing: 6, shadow: { color: "#000000", blur: 12, x: 0, y: 4, opacity: 0.5 } } },
  { id: "pixel", name: "Pixel", s: { color: "#7cff6b", font: "Press Start 2P", bold: false, stroke: { color: "#002b00", width: 4 } } },
];

export const TEXT_COLORS = ["#ffffff", "#000000", "#e5484d", "#ff8a3d", "#ffd400", "#46c35a", "#2ad4ff", "#3f74e0", "#8a56d6", "#ff3ec8", "#9aa1ad", "#8b5a2b"];

export const STICKERS = {
  Popular: "😂❤️🔥😍👍🙏😭✨🥰😎💯🎉😅🤣😊👀💀🤔😱👏",
  Faces: "😀😃😄😁😆🥹😉😇🙂🙃😋😛😜🤪😝🤗🤭🫢🤫😴🤤😷🥳🥺😤😡🤯😳🥶🥵🤠",
  Love: "💖💗💓💞💕💘💝❣️💔🧡💛💚💙💜🤍🖤💋😘😻🌹",
  Hands: "👋🤚✋🖐️👌🤌🤏✌️🤞🫰🤟🤘🤙👈👉👆👇☝️👊✊🤛🤜💪",
  Fun: "🎂🎈🎁🎊🏆🥇⚽🏀🎮🎧🎤🎬📸💡💰💎🚀🛸⭐🌈☀️🌙⚡❄️",
  Nature: "🐶🐱🐼🦊🐻🐨🐯🦁🐸🐵🦄🐝🦋🌸🌻🌴🍀🍁🌊🍕🍔🍟🍩🍦☕",
  Symbols: "✅❌⚠️❓❗💬💭🔔📍➡️⬅️⬆️⬇️🔴🟢🔵⭕️💥💫🆗🆕🔝",
};

export const BG_COLORS = ["#000000", "#ffffff", "#1b1d21", "#e5484d", "#ff8a3d", "#ffd400", "#46c35a", "#2ad4ff", "#3f74e0", "#8a56d6", "#ff3ec8", "#f5e6c8"];
export const BG_GRADIENTS = [
  ["#ff7a59", "#ffd25a"], ["#5ee7df", "#b490ca"], ["#667eea", "#764ba2"], ["#f093fb", "#f5576c"],
  ["#4facfe", "#00f2fe"], ["#43e97b", "#38f9d7"], ["#fa709a", "#fee140"], ["#30cfd0", "#330867"],
];

// ───────── Subtitles (SRT parser ported from OpenCut subtitles/srt.ts) ─────────
const SRT_TS = /^(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
function srtTime(s) {
  const m = s.trim().replace(",", ".").match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000 : NaN;
}
export function parseSubtitles(input) {
  const txt = input.replace(/\r\n?/g, "\n").replace(/^WEBVTT[^\n]*\n/, "").trim();
  const cues = [];
  for (const block of txt.split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => SRT_TS.test(l));
    if (ti < 0) continue;
    const [, a, b] = lines[ti].match(SRT_TS);
    const start = srtTime(a), end = srtTime(b);
    const text = lines.slice(ti + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (text && end > start) cues.push({ start, dur: end - start, text });
  }
  return cues;
}

export function toSrt(cues) {
  const ts = (t) => {
    const ms = Math.round(t * 1000);
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.start + c.dur)}\n${c.text}\n`).join("\n");
}

export function fmtTime(t, frac = false) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  const base = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return frac ? `${base}.${String(Math.floor((t % 1) * 10))}` : base;
}
