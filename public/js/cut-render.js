// BoetyCut: turns a project + time into a compositor scene.
import { FILTERS, effectById, transitionById, sourceTime, propAt, clipEnd, BLEND_N, WEB_FONTS } from "./cut-model.js";
import { quadMatrix } from "./cut-gl.js";
import { imageOf } from "./cut-media.js";

const ADJ_KEYS = ["brightness", "contrast", "saturation", "exposure", "sharpen", "highlights", "shadows", "temperature", "tint", "hue", "fade", "vignette", "grain"];

/** Adjustment array (−1..1) from a clip's adjust settings plus its filter. */
export function adjArray(adjust, filter) {
  const out = new Float32Array(13);
  const f = filter && FILTERS.find((x) => x.id === filter.id);
  const k = filter ? (filter.amount ?? 100) / 100 : 0;
  ADJ_KEYS.forEach((key, i) => { out[i] = ((adjust?.[key] || 0) + (f?.a[key] || 0) * k) / 100; });
  return out;
}
export function toneArray(filter) {
  const f = filter && FILTERS.find((x) => x.id === filter.id);
  if (!f?.tone) return null;
  const k = (filter.amount ?? 100) / 100;
  return [(f.tone.sh?.[0] || 0) / 360, (f.tone.sh?.[1] || 0) * k, (f.tone.hi?.[0] || 0) / 360, (f.tone.hi?.[1] || 0) * k];
}

// ───────── Animations ─────────
const easeOut = (u) => 1 - (1 - u) ** 3;
const elastic = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 2 ** (-10 * u) * Math.sin((u * 10 - 0.75) * (2 * Math.PI) / 3) + 1);
const bounceOut = (u) => {
  const n = 7.5625, d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
  return n * (u -= 2.625 / d) * u + 0.984375;
};

export function animState(c, lt) {
  const s = { dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, blur: 0, reveal: 1 };
  const apply = (id, u, out) => {
    const e = easeOut(u), r = 1 - e;
    switch (id) {
      case "fade": s.opacity *= u; break;
      case "zoomin": s.scale *= 0.4 + 0.6 * e; s.opacity *= e; break;
      case "zoomout": s.scale *= 1.6 - 0.6 * e; s.opacity *= e; break;
      case "slidel": s.dx += (out ? -r : r) * 0.6; s.opacity *= Math.min(1, u * 2); break;
      case "slider": s.dx += (out ? r : -r) * 0.6; s.opacity *= Math.min(1, u * 2); break;
      case "slideu": s.dy += (out ? -r : r) * 0.6; s.opacity *= Math.min(1, u * 2); break;
      case "slided": s.dy += (out ? r : -r) * 0.6; s.opacity *= Math.min(1, u * 2); break;
      case "rotate": s.rot += r * (out ? 90 : -90); s.opacity *= e; break;
      case "bounce": s.scale *= elastic(u); break;
      case "spin": s.rot += r * 360; s.scale *= e; break;
      case "blur": s.blur = Math.max(s.blur, r * 1.5); s.opacity *= Math.min(1, u * 1.5); break;
      case "drop": s.dy -= (1 - bounceOut(u)) * 0.5; break;
      case "shrink": s.scale *= e; break;
      case "typewriter": s.reveal = u; break;
    }
  };
  const ai = c.anim?.in, ao = c.anim?.out, ac = c.anim?.combo;
  if (ai && lt < ai.dur) apply(ai.id, Math.max(0, lt / ai.dur), false);
  if (ao && c.dur - lt < ao.dur) apply(ao.id, Math.max(0, (c.dur - lt) / ao.dur), true);
  if (ac) {
    const k = ac.speed || 1, t = lt * k;
    switch (ac.id) {
      case "rock": s.rot += Math.sin(t * 4) * 8; break;
      case "pulse": s.scale *= 1 + 0.07 * Math.sin(t * 6); break;
      case "swing": s.rot += Math.sin(t * 3) * 15; break;
      case "shake": s.dx += Math.sin(t * 47) * 0.01; s.dy += Math.cos(t * 39) * 0.01; break;
      case "float": s.dy += Math.sin(t * 2) * 0.025; break;
      case "spin": s.rot += t * 120; break;
      case "wobble": s.scale *= 1 + 0.04 * Math.sin(t * 9); s.rot += Math.sin(t * 7) * 4; break;
      case "heartbeat": s.scale *= 1 + 0.14 * Math.abs(Math.sin(t * Math.PI * 1.4)) ** 8; break;
    }
  }
  return s;
}

// ───────── Fonts ─────────
const fontState = new Map();
export let onFontLoad = null;
export function setFontListener(fn) { onFontLoad = fn; }
export function ensureFont(family) {
  if (!WEB_FONTS.has(family) || fontState.has(family)) return fontState.get(family) || Promise.resolve();
  const p = (async () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;700&display=swap`;
    document.head.append(link);
    await new Promise((r) => { link.onload = r; link.onerror = r; setTimeout(r, 4000); });
    await document.fonts.load(`700 48px "${family}"`).catch(() => {});
    await document.fonts.load(`400 48px "${family}"`).catch(() => {});
    textCache.clear();
    onFontLoad?.();
  })();
  fontState.set(family, p);
  return p;
}

// ───────── Text & stickers → canvases ─────────
const textCache = new Map();
export function textCanvas(t, W, H, reveal = 1) {
  const key = JSON.stringify(t) + W + "x" + H + ":" + (reveal >= 1 ? 1 : Math.round(reveal * 200));
  if (textCache.has(key)) return textCache.get(key);
  ensureFont(t.font);
  const k = Math.min(W, H) / 1080;
  const size = t.size * k;
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  const fam = t.font === "system-ui" ? "system-ui, -apple-system, sans-serif" : `"${t.font}", system-ui, sans-serif`;
  const font = `${t.italic ? "italic " : ""}${t.bold ? "700" : "400"} ${size}px ${fam}`;
  g.font = font;
  const spacing = (t.spacing || 0) * k;
  const measure = (s) => g.measureText(s).width + Math.max(0, s.length - 1) * spacing;
  // word-wrap each paragraph to the box width
  const maxW = (t.width || 0.86) * W;
  let content = t.content || "";
  if (reveal < 1) content = [...content].slice(0, Math.ceil([...content].length * reveal)).join("");
  const lines = [];
  for (const para of content.split("\n")) {
    const words = para.split(/(\s+)/);
    let cur = "";
    for (const w of words) {
      const next = cur + w;
      if (cur && measure(next.trimEnd()) > maxW && w.trim()) { lines.push(cur.trimEnd()); cur = w.trimStart(); }
      else cur = next;
    }
    lines.push(cur.trimEnd());
  }
  const lh = size * (t.lineHeight || 1.2);
  const widths = lines.map(measure);
  const tw = Math.max(1, ...widths);
  const stroke = (t.stroke?.width || 0) * k;
  const sh = t.shadow || {};
  const shPad = (sh.blur || 0) * k + Math.max(Math.abs(sh.x || 0), Math.abs(sh.y || 0)) * k;
  const bgPad = t.bg?.opacity > 0 ? (t.bg.pad || 16) * k : 0;
  const pad = Math.ceil(stroke + shPad + bgPad + 4);
  c.width = Math.ceil(tw + pad * 2);
  c.height = Math.ceil(lh * lines.length + pad * 2);
  g.font = font;
  g.textBaseline = "middle";
  if ("letterSpacing" in g) g.letterSpacing = `${spacing}px`;
  if (t.bg?.opacity > 0) {
    g.fillStyle = t.bg.color;
    g.globalAlpha = t.bg.opacity;
    const r = (t.bg.radius || 0) * k;
    const x0 = pad - bgPad + (t.align === "right" ? tw - Math.max(...widths) : t.align === "center" ? (tw - Math.max(...widths)) / 2 : 0);
    roundRect(g, x0, pad - bgPad, Math.max(...widths) + bgPad * 2, lh * lines.length + bgPad * 2, r);
    g.fill();
    g.globalAlpha = 1;
  }
  const xFor = (w) => (t.align === "left" ? pad : t.align === "right" ? pad + tw - w : pad + (tw - w) / 2);
  const fill = () => {
    if (t.gradient) {
      const gr = g.createLinearGradient(0, pad, 0, pad + lh * lines.length);
      gr.addColorStop(0, t.gradient[0]); gr.addColorStop(1, t.gradient[1]);
      return gr;
    }
    return t.color;
  };
  lines.forEach((ln, i) => {
    const x = xFor(widths[i]), y = pad + lh * (i + 0.5);
    const draw = (fn) => {
      if ("letterSpacing" in g || !spacing) fn(ln, x, y);
      else { let xx = x; for (const ch of ln) { fn(ch, xx, y); xx += g.measureText(ch).width + spacing; } }
    };
    if (sh.opacity > 0 && (sh.blur || sh.x || sh.y)) {
      g.save();
      g.shadowColor = rgba(sh.color, sh.opacity);
      g.shadowBlur = (sh.blur || 0) * k; g.shadowOffsetX = (sh.x || 0) * k; g.shadowOffsetY = (sh.y || 0) * k;
      g.fillStyle = fill();
      draw((s, a, b) => g.fillText(s, a, b));
      g.restore();
    }
    if (stroke > 0) {
      g.strokeStyle = t.stroke.color; g.lineWidth = stroke * 2; g.lineJoin = "round";
      draw((s, a, b) => g.strokeText(s, a, b));
    }
    g.fillStyle = fill();
    draw((s, a, b) => g.fillText(s, a, b));
    if (t.underline) { g.fillRect(x, y + size * 0.42, widths[i], Math.max(2, size * 0.06)); }
  });
  textCache.set(key, c);
  if (textCache.size > 300) textCache.delete(textCache.keys().next().value);
  return c;
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function rgba(hexc, a) {
  const v = parseInt(hexc.slice(1), 16);
  return `rgba(${v >> 16 & 255},${v >> 8 & 255},${v & 255},${a})`;
}

const stickerCache = new Map();
export function stickerCanvas(emoji) {
  if (stickerCache.has(emoji)) return stickerCache.get(emoji);
  const c = document.createElement("canvas");
  c.width = c.height = 320;
  const g = c.getContext("2d");
  g.font = `256px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(emoji, 160, 176);
  stickerCache.set(emoji, c);
  return c;
}

// ───────── Scene ─────────
/**
 * Build the compositor scene at timeline time T.
 * env = { media: Map, frames: FrameCache, W, H, hiddenIds? }
 */
export async function buildScene(p, T, env) {
  const { W, H } = env;
  const layers = [], post = [];
  let mainLayer = null;
  const jobs = [];
  for (const tr of p.tracks) {
    if (tr.hidden || tr.kind === "audio") continue;
    const items = tr.items;
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      if (tr.kind === "main") {
        const next = items[i + 1];
        const d = c.transition && next ? Math.min(c.transition.dur, c.dur, next.dur) : 0;
        const end = clipEnd(c);
        if (d > 0 && T >= end - d / 2 && T < end + d / 2) {
          const t = transitionById(c.transition.id);
          const slot = { trans: null, blend: 0 };
          layers.push(slot);
          jobs.push(Promise.all([layerFor(c, T - c.start, env, true), layerFor(next, T - next.start, env, true)]).then(([a, b]) => {
            slot.trans = { a, b, p: (T - (end - d / 2)) / d, n: t?.n || 1 };
            mainLayer ??= a;
          }));
          i++; // the next clip is drawn by the transition
          continue;
        }
      }
      if (T < c.start || T >= clipEnd(c)) continue;
      const lt = T - c.start;
      if (tr.kind === "effect") {
        const e = effectById(c.effect?.id);
        if (e) post.push({ n: e.n, amt: (c.effect.amount ?? e.def) / 100, t: lt });
        continue;
      }
      if (tr.kind === "filter" || tr.kind === "adjust") {
        post.push({ adj: adjArray(c.adjust, c.filter), tone: toneArray(c.filter) });
        continue;
      }
      const slot = { blend: BLEND_N[c.blend] || 0 };
      layers.push(slot);
      jobs.push(layerFor(c, lt, env).then((L) => {
        if (!L) { slot.skip = true; return; }
        Object.assign(slot, L);
        if (tr.kind === "main") mainLayer ??= L;
      }));
    }
  }
  await Promise.all(jobs);
  const bg = p.bg?.type === "blur" ? { type: "blur", blur: p.bg.blur, layer: mainLayer } : p.bg;
  return { bg, layers: layers.filter((l) => !l.skip && (l.tex || l.trans)), post };
}

async function layerFor(c, lt, env, transitional) {
  const { W, H, media, frames, gl } = env;
  let src, sw, sh, version;
  if (c.type === "video" || c.type === "image") {
    const m = media.get(c.mediaId);
    if (!m) return null;
    if (m.kind === "image") { src = await imageOf(m); version = m.id; }
    else {
      const st = Math.max(0, sourceTime(c, transitional ? lt : Math.min(lt, c.dur - 1e-3)));
      src = await frames.frameAt(c.id, m, Math.min(st, m.duration - 1e-3)).catch(() => null);
      version = performance.now();
    }
    if (!src) return null;
    sw = src.width; sh = src.height;
  } else if (c.type === "text") {
    const a0 = animState(c, lt);
    src = textCanvas(c.text, W, H, a0.reveal);
    version = src;
    sw = src.width; sh = src.height;
  } else if (c.type === "sticker") {
    if (c.mediaId) { const m = media.get(c.mediaId); if (!m) return null; src = await imageOf(m); }
    else src = stickerCanvas(c.emoji || "⭐");
    version = src;
    sw = src.width; sh = src.height;
  } else return null;

  const a = animState(c, lt);
  const tr = c.transform;
  const x = propAt(c, "x", lt), y = propAt(c, "y", lt), scale = propAt(c, "scale", lt) * a.scale;
  const rot = propAt(c, "rot", lt) + a.rot, opacity = clamp01(propAt(c, "opacity", lt) * a.opacity);
  const cr = c.crop || { l: 0, t: 0, r: 1, b: 1 };
  const cw = sw * (cr.r - cr.l), ch = sh * (cr.b - cr.t);
  let w, h;
  if (c.type === "text" || c.type === "sticker") {
    const k = c.type === "sticker" && !c.mediaId ? Math.min(W, H) / 1080 * 0.9 : c.type === "sticker" ? Math.min(W, H) / Math.max(sw, sh) * 0.4 : 1;
    w = cw * k * scale; h = ch * k * scale;
  } else {
    const s0 = Math.min(W / cw, H / ch);
    w = cw * s0 * scale; h = ch * s0 * scale;
  }
  const cx = W / 2 + x * W / 2 + a.dx * W, cy = H / 2 + y * H / 2 + a.dy * H;
  const tex = gl.texture(c.id, src, version);
  return {
    tex: tex.tex, srcW: sw, srcH: sh,
    quad: quadMatrix(W, H, cx, cy, w, h, rot, tr.flipH, tr.flipV),
    crop: [cr.l, cr.t, cr.r, cr.b],
    adj: c.type === "text" || c.type === "sticker" ? null : adjArray(c.adjust, c.filter),
    tone: toneArray(c.filter),
    opacity, chroma: c.chroma?.on ? c.chroma : null, mask: c.mask && c.mask.type !== "none" ? c.mask : null,
    aspect: w / Math.max(1, h), blur: a.blur, time: lt,
    effects: (c.effects || []).map((e) => ({ n: effectById(e.id)?.n || 0, amt: (e.amount ?? 50) / 100, t: lt })).filter((e) => e.n),
    box: { cx, cy, w, h, rot },
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** On-canvas box of a clip at time T (for the preview's selection handles). */
export function clipBox(c, T, W, H, media) {
  const lt = T - c.start;
  const a = animState(c, lt);
  let sw = 1, sh = 1;
  if (c.type === "text") { const t = textCanvas(c.text, W, H, 1); sw = t.width; sh = t.height; }
  else if (c.type === "sticker" && !c.mediaId) { sw = sh = 320; }
  else { const m = media.get(c.mediaId); sw = m?.w || W; sh = m?.h || H; }
  const cr = c.crop || { l: 0, t: 0, r: 1, b: 1 };
  const cw = sw * (cr.r - cr.l), ch = sh * (cr.b - cr.t);
  const scale = propAt(c, "scale", lt) * a.scale;
  let w, h;
  if (c.type === "text") { w = cw * scale; h = ch * scale; }
  else if (c.type === "sticker") { const k = c.mediaId ? Math.min(W, H) / Math.max(sw, sh) * 0.4 : Math.min(W, H) / 1080 * 0.9; w = cw * k * scale; h = ch * k * scale; }
  else { const s0 = Math.min(W / cw, H / ch); w = cw * s0 * scale; h = ch * s0 * scale; }
  return { cx: W / 2 + propAt(c, "x", lt) * W / 2 + a.dx * W, cy: H / 2 + propAt(c, "y", lt) * H / 2 + a.dy * H, w, h, rot: propAt(c, "rot", lt) + a.rot };
}
