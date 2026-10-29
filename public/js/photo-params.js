// Photos: develop settings model. PARAMS mirrors the index layout in
// photo/src/render.rs; serialize() packs settings into the engine's f32 buffer.

export const BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
export const BAND_COLORS = ["#e5484d", "#f08c2e", "#e9c63b", "#46b04a", "#2fb5b5", "#3f74e0", "#8a56d6", "#d14cb5"];

export const PARAMS = [
  "temp", "tint", "exposure", "contrast", "highlights", "shadows", "whites", "blacks",
  "texture", "clarity", "dehaze", "vibrance", "saturation",
  ...BANDS.map((b) => "hue_" + b), ...BANDS.map((b) => "sat_" + b), ...BANDS.map((b) => "lum_" + b), ...BANDS.map((b) => "gray_" + b),
  "treatment",
  "cg_shadow_hue", "cg_shadow_sat", "cg_shadow_lum", "cg_mid_hue", "cg_mid_sat", "cg_mid_lum",
  "cg_high_hue", "cg_high_sat", "cg_high_lum", "cg_global_hue", "cg_global_sat", "cg_global_lum", "cg_blending", "cg_balance",
  "sharp_amount", "sharp_radius", "sharp_detail", "sharp_masking",
  "nr_lum", "nr_lum_detail", "nr_lum_contrast", "nr_color", "nr_color_detail", "nr_color_smooth",
  "lens_distortion", "lens_vignette", "lens_vignette_mid", "defringe_purple", "defringe_green", "ca_red", "ca_blue",
  "tr_vertical", "tr_horizontal", "tr_rotate", "tr_aspect", "tr_scale", "tr_x", "tr_y",
  "vig_amount", "vig_mid", "vig_round", "vig_feather", "vig_highlights", "vig_style", "grain_amount", "grain_size", "grain_rough",
  "cal_shadows", "cal_red_hue", "cal_red_sat", "cal_green_hue", "cal_green_sat", "cal_blue_hue", "cal_blue_sat",
  "crop_l", "crop_t", "crop_r", "crop_b", "angle", "orient",
];
export const NP = PARAMS.length; // 106
export const NCTL = 8;
export const LUT_N = 1024;
export const IDX = Object.fromEntries(PARAMS.map((n, i) => [n, i]));

// Local (mask) adjustments, in engine slot order.
export const LOCAL = [
  "temp", "tint", "exposure", "contrast", "highlights", "shadows", "whites", "blacks",
  "texture", "clarity", "dehaze", "hue", "saturation", "sharpness", "color_hue", "color_sat",
];

// Settings that aren't engine scalars but still belong to a photo's develop state.
const EXTRA = {
  pc_highlights: 0, pc_lights: 0, pc_darks: 0, pc_shadows: 0, pc_split1: 25, pc_split2: 50, pc_split3: 75,
  profile: "color", profile_amount: 100,
};

const ZERO = Object.fromEntries(PARAMS.map((n) => [n, 0]));

export function defaults(info = {}) {
  const raw = !!info.isRaw;
  return {
    ...ZERO,
    ...EXTRA,
    temp: raw ? Math.round(info.asShotTemp || 5500) : 0,
    tint: raw ? Math.round(info.asShotTint || 0) : 0,
    wb: "As Shot",
    cg_blending: 50,
    sharp_amount: raw ? 40 : 0, sharp_radius: 1, sharp_detail: 25,
    nr_lum_detail: 50, nr_color: raw ? 25 : 0, nr_color_detail: 50, nr_color_smooth: 50,
    lens_vignette_mid: 50,
    tr_scale: 100,
    vig_mid: 50, vig_feather: 50, grain_size: 25, grain_rough: 50,
    crop_r: 1, crop_b: 1,
    curve: { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
    masks: [],
    spots: [],
  };
}

export const clone = (s) => structuredClone(s);

// ───────── Profiles: looks applied underneath the sliders ─────────
export const PROFILES = {
  color: { name: "Color", d: {} },
  neutral: { name: "Neutral", d: { contrast: -18, saturation: -6, highlights: 8, shadows: 6 } },
  vivid: { name: "Vivid", d: { contrast: 14, saturation: 14, vibrance: 12, blacks: -6 } },
  landscape: { name: "Landscape", d: { contrast: 10, vibrance: 18, sat_green: 10, sat_blue: 12, lum_blue: -8, clarity: 6 } },
  portrait: { name: "Portrait", d: { contrast: -6, sat_red: -6, sat_orange: -8, lum_orange: 8, texture: -6 } },
  standard: { name: "Standard", d: { contrast: 6, saturation: 4 } },
  monochrome: { name: "Monochrome", d: { treatment: 1, contrast: 8 } },
  mono_hc: { name: "B&W High Contrast", d: { treatment: 1, contrast: 35, blacks: -10, whites: 10, clarity: 10 } },
  mono_soft: { name: "B&W Soft", d: { treatment: 1, contrast: -15, highlights: -10, shadows: 10 } },
  film_warm: { name: "Warm Film", d: { temp: 8, saturation: -8, contrast: -6, cg_shadow_hue: 30, cg_shadow_sat: 12, cg_high_hue: 45, cg_high_sat: 10 } },
  film_cool: { name: "Cool Fade", d: { temp: -6, saturation: -12, cg_shadow_hue: 210, cg_shadow_sat: 14, blacks: 12 } },
};

// ───────── Presets ─────────
const P = (name, group, s) => ({ name, group, s });
export const BUILTIN_PRESETS = [
  P("Auto Pop", "Basic", { contrast: 12, vibrance: 18, clarity: 10, dehaze: 4 }),
  P("Bright & Airy", "Basic", { exposure: 0.35, contrast: -12, highlights: -30, shadows: 30, whites: 12, vibrance: 8, saturation: -6 }),
  P("Punchy", "Basic", { contrast: 30, clarity: 18, vibrance: 22, blacks: -10 }),
  P("Soft Matte", "Basic", { contrast: -20, blacks: 18, highlights: -15, saturation: -10, pc_shadows: 20, pc_darks: 6 }),
  P("Clean Landscape", "Landscape", { contrast: 10, highlights: -40, shadows: 30, clarity: 15, dehaze: 12, vibrance: 20, sat_blue: 10, lum_blue: -10 }),
  P("Golden Hour", "Landscape", { temp: 12, highlights: -20, shadows: 15, vibrance: 15, cg_high_hue: 45, cg_high_sat: 18, cg_shadow_hue: 25, cg_shadow_sat: 8 }),
  P("Moody Forest", "Landscape", { exposure: -0.3, contrast: 15, highlights: -30, shadows: -10, sat_green: -30, hue_green: -20, lum_green: -15, vig_amount: -20 }),
  P("Skin Smooth", "Portrait", { texture: -25, clarity: -10, sat_orange: -8, lum_orange: 10, highlights: -10 }),
  P("Warm Portrait", "Portrait", { temp: 10, tint: 3, contrast: 6, lum_orange: 8, vig_amount: -12 }),
  P("Classic B&W", "Black & White", { treatment: 1, contrast: 20, highlights: -10, shadows: 10, clarity: 12 }),
  P("Noir", "Black & White", { treatment: 1, contrast: 50, blacks: -25, whites: 20, clarity: 25, vig_amount: -30, grain_amount: 25 }),
  P("Silver Fade", "Black & White", { treatment: 1, contrast: -15, blacks: 25, pc_shadows: 15, grain_amount: 15 }),
  P("Selenium Tone", "Black & White", { treatment: 1, contrast: 15, cg_shadow_hue: 280, cg_shadow_sat: 18, cg_high_hue: 40, cg_high_sat: 6 }),
  P("Faded Film", "Film", { contrast: -15, blacks: 20, saturation: -15, grain_amount: 20, grain_size: 30, cg_shadow_hue: 200, cg_shadow_sat: 10, pc_shadows: 18 }),
  P("Kodachrome-ish", "Film", { contrast: 18, saturation: 10, sat_red: 12, hue_green: -10, sat_blue: -8, cg_high_hue: 50, cg_high_sat: 8 }),
  P("Cross Process", "Film", { contrast: 20, cg_shadow_hue: 180, cg_shadow_sat: 25, cg_high_hue: 60, cg_high_sat: 25, saturation: 10 }),
  P("Teal & Orange", "Film", { hue_aqua: -20, sat_aqua: 15, hue_blue: -15, sat_orange: 15, cg_shadow_hue: 195, cg_shadow_sat: 20, cg_high_hue: 35, cg_high_sat: 15 }),
  P("Lomo", "Film", { contrast: 30, saturation: 18, vig_amount: -45, vig_mid: 35, grain_amount: 20 }),
  P("Night City", "Creative", { temp: -10, contrast: 20, highlights: -40, clarity: 20, dehaze: 15, vibrance: 15, sat_orange: 20 }),
  P("Haze Cut", "Creative", { dehaze: 35, contrast: 6, vibrance: 10 }),
  P("Sharpen: Landscape", "Detail", { sharp_amount: 70, sharp_radius: 0.8, sharp_detail: 50, sharp_masking: 10 }),
  P("Sharpen: Portrait", "Detail", { sharp_amount: 35, sharp_radius: 1.4, sharp_detail: 15, sharp_masking: 60 }),
  P("Noise: High ISO", "Detail", { nr_lum: 45, nr_lum_detail: 45, nr_color: 40, sharp_masking: 40 }),
];

export const WB_PRESETS_RAW = [
  ["As Shot", null], ["Auto", null], ["Daylight", [5500, 0]], ["Cloudy", [6500, 3]], ["Shade", [7500, 5]],
  ["Tungsten", [2850, -6]], ["Fluorescent", [3800, 18]], ["Flash", [5500, 0]], ["Custom", null],
];
export const WB_PRESETS_IMG = [["As Shot", null], ["Auto", null], ["Custom", null]];

// Groups the copy / paste / sync dialog offers.
export const GROUPS = {
  "White Balance": ["temp", "tint", "wb"],
  "Basic Tone": ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"],
  "Presence": ["texture", "clarity", "dehaze", "vibrance", "saturation"],
  "Tone Curve": ["curve", "pc_highlights", "pc_lights", "pc_darks", "pc_shadows", "pc_split1", "pc_split2", "pc_split3"],
  "Color Mixer": PARAMS.filter((n) => /^(hue|sat|lum|gray)_/.test(n)),
  "Treatment & Profile": ["treatment", "profile", "profile_amount"],
  "Color Grading": PARAMS.filter((n) => n.startsWith("cg_")),
  "Detail": PARAMS.filter((n) => /^(sharp|nr)_/.test(n)),
  "Lens Corrections": ["lens_distortion", "lens_vignette", "lens_vignette_mid", "defringe_purple", "defringe_green", "ca_red", "ca_blue"],
  "Transform": PARAMS.filter((n) => n.startsWith("tr_")),
  "Effects": PARAMS.filter((n) => /^(vig|grain)_/.test(n)),
  "Calibration": PARAMS.filter((n) => n.startsWith("cal_")),
  "Crop & Rotate": ["crop_l", "crop_t", "crop_r", "crop_b", "angle", "orient"],
  "Masks": ["masks"],
  "Spot Removal": ["spots"],
};
export const PASTE_DEFAULT_OFF = new Set(["Crop & Rotate", "Masks", "Spot Removal", "White Balance"]);

export function pick(s, groups) {
  const out = {};
  for (const g of groups) for (const k of GROUPS[g] || []) if (k in s) out[k] = structuredClone(s[k]);
  return out;
}

// Apply a partial settings object (preset/paste). Raw-only Kelvin temp is
// treated as relative when the preset was saved from a different kind of file.
export function applyPartial(s, part, info = {}) {
  const out = clone(s);
  for (const [k, v] of Object.entries(part)) {
    if (k === "temp" && info.isRaw && Math.abs(v) <= 100) out.temp = Math.round(s.temp * (1 + v / 150));
    else if (k === "temp" && !info.isRaw && Math.abs(v) > 100) continue;
    else if (k === "tint" && !info.isRaw && Math.abs(v) > 100) continue;
    else out[k] = structuredClone(v);
  }
  return out;
}

// ───────── Curves ─────────

/** Monotone cubic (Fritsch–Carlson) through sorted points → LUT. */
export function pointCurve(points, n = LUT_N) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(n);
  if (p.length < 2) { for (let i = 0; i < n; i++) out[i] = i / (n - 1); return out; }
  const k = p.length;
  const d = [], m = new Array(k);
  for (let i = 0; i < k - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]));
  m[0] = d[0]; m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    if (x <= p[0][0]) { out[i] = p[0][1]; continue; }
    if (x >= p[k - 1][0]) { out[i] = p[k - 1][1]; continue; }
    while (seg < k - 2 && x > p[seg + 1][0]) seg++;
    const [x0, y0] = p[seg], [x1, y1] = p[seg + 1];
    const h = x1 - x0, t = (x - x0) / h;
    const t2 = t * t, t3 = t2 * t;
    out[i] = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[seg + 1];
    out[i] = Math.min(1, Math.max(0, out[i]));
  }
  return out;
}

const bump = (x, a, peak, b) => {
  if (x <= a || x >= b) return 0;
  const t = x < peak ? (x - a) / (peak - a) : (b - x) / (b - peak);
  return Math.sin(t * Math.PI / 2) ** 2;
};

/** Parametric curve value at x (Highlights / Lights / Darks / Shadows with three split points). */
export function parametric(x, s) {
  const s1 = s.pc_split1 / 100, s2 = s.pc_split2 / 100, s3 = s.pc_split3 / 100;
  const y = x
    + (s.pc_shadows / 100) * 0.14 * bump(x, 0, s1 * 0.6, s2)
    + (s.pc_darks / 100) * 0.14 * bump(x, 0, (s1 + s2) / 2, s3)
    + (s.pc_lights / 100) * 0.14 * bump(x, s1, (s2 + s3) / 2, 1)
    + (s.pc_highlights / 100) * 0.14 * bump(x, s2, s3 + (1 - s3) * 0.4, 1);
  return Math.min(1, Math.max(0, y));
}

export function curveLuts(s) {
  const n = LUT_N;
  const pts = s.curve || {};
  const master = pointCurve(pts.rgb || [[0, 0], [1, 1]], n);
  const flat = !s.pc_highlights && !s.pc_lights && !s.pc_darks && !s.pc_shadows;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = flat ? i / (n - 1) : parametric(i / (n - 1), s);
    const f = x * (n - 1), j = Math.min(n - 2, f | 0), t = f - j;
    m[i] = master[j] + (master[j + 1] - master[j]) * t;
  }
  return [m, pointCurve(pts.r || [[0, 0], [1, 1]], n), pointCurve(pts.g || [[0, 0], [1, 1]], n), pointCurve(pts.b || [[0, 0], [1, 1]], n)];
}

export const CURVE_PRESETS = {
  Linear: [[0, 0], [1, 1]],
  "Medium Contrast": [[0, 0], [0.25, 0.21], [0.5, 0.5], [0.75, 0.79], [1, 1]],
  "Strong Contrast": [[0, 0], [0.25, 0.17], [0.5, 0.5], [0.75, 0.84], [1, 1]],
  "Faded": [[0, 0.08], [0.3, 0.3], [0.7, 0.72], [1, 0.96]],
};

// ───────── Serialize ─────────

/** Effective scalar values: the photo's settings plus its profile look. */
export function effective(s) {
  const prof = PROFILES[s.profile] || PROFILES.color;
  const amt = (s.profile_amount ?? 100) / 100;
  const e = {};
  for (const n of PARAMS) e[n] = +s[n] || 0;
  for (const [k, v] of Object.entries(prof.d)) {
    if (k === "treatment") e.treatment = Math.max(e.treatment, v);
    else if (k === "temp") continue; // looks don't move Kelvin
    else e[k] = (e[k] || 0) + v * amt;
  }
  return e;
}

/**
 * Pack settings for the engine.
 * ctl: { region:[x0,y0,x1,y1], draft, overlay (mask index or -1), fill, noCrop, noMasks }
 */
export function serialize(s, ctl = {}) {
  const e = effective(s);
  if (ctl.noCrop) { e.crop_l = 0; e.crop_t = 0; e.crop_r = 1; e.crop_b = 1; }
  if (ctl.extraSharpen) e.sharp_amount = Math.min(150, e.sharp_amount + ctl.extraSharpen);
  const masks = ctl.noMasks ? [] : (s.masks || []).filter((m) => m.enabled !== false);
  const spots = ctl.noSpots ? [] : (s.spots || []);
  let n = NP + NCTL + 4 * LUT_N + 1 + 1 + spots.length * 8;
  for (const m of masks) n += 24 + 16 + 1 + (m.type === "brush" ? (m.dabs?.length || 0) * 6 : 0);
  const buf = new Float32Array(n);
  for (let i = 0; i < NP; i++) buf[i] = e[PARAMS[i]];
  const r = ctl.region || [0, 0, 1, 1];
  buf.set([r[0], r[1], r[2], r[3], ctl.draft ? 1 : 0, ctl.overlay ?? -1, ctl.fill ?? 0.86, 0], NP);
  const luts = ctl.luts || curveLuts(s);
  let o = NP + NCTL;
  for (const l of luts) { buf.set(l, o); o += LUT_N; }
  buf[o++] = masks.length;
  for (const m of masks) {
    const kind = { linear: 0, radial: 1, brush: 2, range: 3 }[m.type] ?? 3;
    const g = m.geo || {};
    const hdr = new Float32Array(24);
    hdr.set([
      kind, m.invert ? 1 : 0, (m.amount ?? 100) / 100,
      g.x1 ?? g.cx ?? 0, g.y1 ?? g.cy ?? 0, g.x2 ?? 0, g.y2 ?? 0, g.rx ?? 0, g.ry ?? 0, g.angle ?? 0, (g.feather ?? 50) / 100,
      m.lum?.on ? 1 : 0, (m.lum?.lo ?? 0) / 100, (m.lum?.hi ?? 100) / 100, (m.lum?.smooth ?? 50) / 100,
      m.col?.on ? 1 : 0, m.col?.hue ?? 0, (m.col?.sat ?? 50) / 100, (m.col?.amount ?? 50) / 100,
    ]);
    buf.set(hdr, o); o += 24;
    for (let k = 0; k < LOCAL.length; k++) buf[o + k] = +(m.adj?.[LOCAL[k]] || 0);
    o += 16;
    const dabs = m.type === "brush" ? (m.dabs || []) : [];
    buf[o++] = dabs.length;
    for (const d of dabs) { buf.set(d, o); o += 6; }
  }
  buf[o++] = spots.length;
  for (const sp of spots) {
    buf.set([sp.x, sp.y, sp.r, sp.sx, sp.sy, (sp.feather ?? 50) / 100, (sp.opacity ?? 100) / 100, sp.mode === "clone" ? 1 : 0], o);
    o += 8;
  }
  return buf;
}

// ───────── Geometry (mirror of render.rs Geo) ─────────

export function geometry(w, h, s) {
  const e = effective(s);
  const orient = e.orient | 0, rot = orient & 3, flip = (orient & 4) !== 0;
  const [wo, ho] = rot & 1 ? [h, w] : [w, h];
  const ang = (e.angle + e.tr_rotate) * Math.PI / 180;
  const scale = Math.max(0.05, e.tr_scale / 100);
  const ak = 2 ** (e.tr_aspect / 100 * 0.5);
  const lh = Math.max(wo, ho) / 2, ls = Math.max(w, h);
  const g = {
    w, h, wo, ho, ls, rot, flip, cos: Math.cos(ang), sin: Math.sin(ang), scale, ak, lh,
    tx: e.tr_x / 100 * wo * 0.5, ty: e.tr_y / 100 * ho * 0.5,
    pv: e.tr_vertical / 100 * 0.35, ph: e.tr_horizontal / 100 * 0.35, dist: e.lens_distortion / 100 * 0.12,
  };
  /** frame-normalised (0..1 of oriented dims) → source units (long edge = 1) */
  g.toSource = (fx, fy) => {
    const px = fx * wo - wo / 2, py = fy * ho - ho / 2;
    let x = (px * g.cos + py * g.sin) / scale - g.tx;
    let y = (-px * g.sin + py * g.cos) / scale - g.ty;
    let qx = x / ak / lh, qy = y * ak / lh;
    const wgt = Math.max(0.05, 1 + g.pv * qy + g.ph * qx);
    qx /= wgt; qy /= wgt;
    const f = 1 - g.dist * (qx * qx + qy * qy);
    qx *= f; qy *= f;
    const cx = qx * lh + wo / 2, cy = qy * lh + ho / 2;
    let sx, sy;
    switch (rot) {
      case 1: sx = cy; sy = h - cx; break;
      case 2: sx = w - cx; sy = h - cy; break;
      case 3: sx = w - cy; sy = cx; break;
      default: sx = cx; sy = cy;
    }
    if (flip) sx = w - sx;
    return [sx / ls, sy / ls];
  };
  /** source units → frame-normalised, by Newton iteration on toSource */
  g.toFrame = (ux, uy, guess) => {
    let [fx, fy] = guess || [0.5, 0.5];
    for (let it = 0; it < 12; it++) {
      const [ax, ay] = g.toSource(fx, fy);
      const ex = ax - ux, ey = ay - uy;
      if (Math.abs(ex) + Math.abs(ey) < 1e-7) break;
      const d = 1e-4;
      const [bx, by] = g.toSource(fx + d, fy);
      const [cx, cy] = g.toSource(fx, fy + d);
      const j11 = (bx - ax) / d, j21 = (by - ay) / d, j12 = (cx - ax) / d, j22 = (cy - ay) / d;
      const det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-12) break;
      fx -= (j22 * ex - j12 * ey) / det;
      fy -= (-j21 * ex + j11 * ey) / det;
    }
    return [fx, fy];
  };
  g.inside = (fx, fy) => {
    const [ux, uy] = g.toSource(fx, fy);
    return ux >= -1e-6 && uy >= -1e-6 && ux <= w / ls + 1e-6 && uy <= h / ls + 1e-6;
  };
  return g;
}

/** Largest crop with the same centre/aspect that keeps every edge inside the image. */
export function constrainCrop(g, c) {
  const ok = (k) => {
    const cx = (c.l + c.r) / 2, cy = (c.t + c.b) / 2, hw = (c.r - c.l) / 2 * k, hh = (c.b - c.t) / 2 * k;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      for (const [x, y] of [[cx - hw + 2 * hw * t, cy - hh], [cx - hw + 2 * hw * t, cy + hh], [cx - hw, cy - hh + 2 * hh * t], [cx + hw, cy - hh + 2 * hh * t]]) {
        if (!g.inside(x, y)) return false;
      }
    }
    return true;
  };
  if (ok(1)) return c;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  const cx = (c.l + c.r) / 2, cy = (c.t + c.b) / 2, hw = (c.r - c.l) / 2 * lo, hh = (c.b - c.t) / 2 * lo;
  return { l: cx - hw, t: cy - hh, r: cx + hw, b: cy + hh };
}

/** Human summary for history entries. */
export const LABELS = {
  temp: "Temp", tint: "Tint", exposure: "Exposure", contrast: "Contrast", highlights: "Highlights", shadows: "Shadows",
  whites: "Whites", blacks: "Blacks", texture: "Texture", clarity: "Clarity", dehaze: "Dehaze", vibrance: "Vibrance",
  saturation: "Saturation", treatment: "Treatment", cg_blending: "Blending", cg_balance: "Balance",
  sharp_amount: "Sharpening", sharp_radius: "Radius", sharp_detail: "Detail", sharp_masking: "Masking",
  nr_lum: "Noise Reduction", nr_lum_detail: "NR Detail", nr_lum_contrast: "NR Contrast", nr_color: "Color NR",
  nr_color_detail: "Color Detail", nr_color_smooth: "Color Smoothness",
  lens_distortion: "Distortion", lens_vignette: "Lens Vignetting", lens_vignette_mid: "Vignette Midpoint",
  defringe_purple: "Purple Amount", defringe_green: "Green Amount", ca_red: "Red/Cyan CA", ca_blue: "Blue/Yellow CA",
  tr_vertical: "Vertical", tr_horizontal: "Horizontal", tr_rotate: "Rotate", tr_aspect: "Aspect", tr_scale: "Scale",
  tr_x: "X Offset", tr_y: "Y Offset", vig_amount: "Vignette", vig_mid: "Midpoint", vig_round: "Roundness",
  vig_feather: "Feather", vig_highlights: "Vignette Highlights", vig_style: "Vignette Style",
  grain_amount: "Grain", grain_size: "Grain Size", grain_rough: "Roughness", cal_shadows: "Shadows Tint",
  cal_red_hue: "Red Primary Hue", cal_red_sat: "Red Primary Sat", cal_green_hue: "Green Primary Hue",
  cal_green_sat: "Green Primary Sat", cal_blue_hue: "Blue Primary Hue", cal_blue_sat: "Blue Primary Sat",
  angle: "Straighten", pc_highlights: "Curve Highlights", pc_lights: "Curve Lights", pc_darks: "Curve Darks",
  pc_shadows: "Curve Shadows", profile_amount: "Profile Amount",
};
for (const b of BANDS) {
  const B = b[0].toUpperCase() + b.slice(1);
  LABELS["hue_" + b] = `${B} Hue`; LABELS["sat_" + b] = `${B} Saturation`; LABELS["lum_" + b] = `${B} Luminance`; LABELS["gray_" + b] = `${B} B&W Mix`;
}
for (const [z, Z] of [["shadow", "Shadows"], ["mid", "Midtones"], ["high", "Highlights"], ["global", "Global"]]) {
  LABELS[`cg_${z}_hue`] = `${Z} Hue`; LABELS[`cg_${z}_sat`] = `${Z} Saturation`; LABELS[`cg_${z}_lum`] = `${Z} Luminance`;
}
