// Photos: export dialog — full-resolution renders encoded in WASM (JPEG, PNG,
// TIFF) or by the browser (WebP, AVIF), resizing, output sharpening,
// watermark, metadata and batch export to a ZIP.
import { h } from "./photo-ui.js";
import { serialize } from "./photo-params.js";

const SETTINGS_KEY = "wisp.photo.export";

export function exportDialog(app, photos) {
  let o = { format: "jpeg", quality: 90, size: "full", long: 2048, short: 1080, w: 1920, h: 1080, mp: 12, pct: 100, noEnlarge: true, sharpen: "none", meta: "all", naming: "{name}", custom: "Photo", wm: false, wmText: "© " + new Date().getFullYear(), wmSize: 4, wmOpacity: 70, wmPos: "br", wmColor: "#ffffff", dest: "download" };
  try { o = { ...o, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch { /* defaults */ }
  const canWebp = probe("image/webp"), canAvif = probe("image/avif");
  const canShare = !!navigator.canShare;

  const field = (label, ...kids) => h("label", { class: "pe-field" }, h("span", {}, label), ...kids);
  const sel = (key, opts, onchange) => {
    const s = h("select", { class: "ps-select" }, opts.filter(Boolean).map(([v, l]) => h("option", { value: v }, l)));
    s.value = o[key];
    s.addEventListener("change", () => { o[key] = s.value; onchange?.(); paint(); });
    return s;
  };
  const num = (key, attrs = {}) => {
    const i = h("input", { class: "ph-in", type: "number", value: o[key], ...attrs });
    i.addEventListener("change", () => { o[key] = +i.value; paint(); });
    return i;
  };
  const chk = (key, label) => h("label", { class: "pd-check" }, h("input", { type: "checkbox", checked: o[key], onchange: (e) => { o[key] = e.target.checked; paint(); } }), label);

  const qualityOut = h("output", {}, String(o.quality));
  const quality = h("input", { type: "range", min: 10, max: 100, value: o.quality, oninput: (e) => { o.quality = +e.target.value; qualityOut.textContent = e.target.value; } });
  const sizeBox = h("div", { class: "pe-size" });
  const wmBox = h("div", { class: "pe-wm" });
  const summary = h("p", { class: "muted small" });
  const progress = h("progress", { max: 1, value: 0, hidden: true });
  const status = h("p", { class: "small" });
  const go = h("button", { class: "btn primary", type: "button" }, photos.length > 1 ? `Export ${photos.length} photos` : "Export");
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");

  function paint() {
    quality.parentElement.hidden = !(o.format === "jpeg" || o.format === "webp" || o.format === "avif");
    sizeBox.replaceChildren(...({
      full: [],
      long: [field("Long edge (px)", num("long", { min: 64, max: 20000 }))],
      short: [field("Short edge (px)", num("short", { min: 64, max: 20000 }))],
      dims: [field("Fit within W × H", h("span", { class: "pe-wh" }, num("w", { min: 64 }), "×", num("h", { min: 64 })))],
      mp: [field("Megapixels", num("mp", { min: 0.1, max: 200, step: 0.1 }))],
      pct: [field("Percent", num("pct", { min: 5, max: 400 }))],
    }[o.size] || []), o.size === "full" ? null : chk("noEnlarge", "Don't enlarge"));
    wmBox.replaceChildren(chk("wm", "Add text watermark"), ...(o.wm ? [
      field("Text", (() => { const i = h("input", { class: "ph-in", type: "text", value: o.wmText }); i.addEventListener("input", () => { o.wmText = i.value; }); return i; })()),
      field("Size (% of short edge)", num("wmSize", { min: 1, max: 30, step: 0.5 })),
      field("Opacity", num("wmOpacity", { min: 5, max: 100 })),
      field("Position", sel("wmPos", [["br", "Bottom right"], ["bl", "Bottom left"], ["bc", "Bottom centre"], ["tr", "Top right"], ["tl", "Top left"], ["c", "Centre"]])),
      field("Colour", sel("wmColor", [["#ffffff", "White"], ["#000000", "Black"]])),
    ] : []));
    summary.textContent = `${photos.length} photo${photos.length > 1 ? "s" : ""} · sRGB · ${o.format.toUpperCase()}${photos.length > 1 ? " · saved as a ZIP" : ""}`;
  }

  const dlg = h("dialog", { class: "ph-dialog pe" },
    h("h3", {}, "Export"),
    h("div", { class: "pe-grid" },
      h("div", {},
        h("h4", {}, "File Settings"),
        field("Format", sel("format", [["jpeg", "JPEG"], ["png", "PNG"], ["tiff", "TIFF (8-bit)"], canWebp && ["webp", "WebP"], canAvif && ["avif", "AVIF"]])),
        field("Quality", quality, qualityOut),
        h("h4", {}, "Image Sizing"),
        field("Resize", sel("size", [["full", "Original size"], ["long", "Long edge"], ["short", "Short edge"], ["dims", "Width & height"], ["mp", "Megapixels"], ["pct", "Percentage"]])),
        sizeBox,
        h("h4", {}, "Output Sharpening"),
        field("Sharpen for", sel("sharpen", [["none", "None"], ["low", "Screen — low"], ["std", "Screen — standard"], ["high", "Screen — high"], ["print", "Print"]]))),
      h("div", {},
        h("h4", {}, "File Naming"),
        field("Name", sel("naming", [["{name}", "Original name"], ["{name}-edit", "Name-edit"], ["{custom}-{seq}", "Custom text + sequence"], ["{date}-{name}", "Date-name"]])),
        field("Custom text", (() => { const i = h("input", { class: "ph-in", type: "text", value: o.custom }); i.addEventListener("input", () => { o.custom = i.value; }); return i; })()),
        h("h4", {}, "Metadata"),
        field("Include", sel("meta", [["all", "All (camera EXIF, JPEG only)"], ["none", "None"]])),
        h("h4", {}, "Watermark"),
        wmBox,
        h("h4", {}, "Destination"),
        field("Send to", sel("dest", [["download", "Download"], canShare && ["share", "Share sheet (save to Photos, Files…)"]])))),
    summary, progress, status,
    h("div", { class: "pd-row pe-actions" }, cancel, go));
  paint();
  document.body.append(dlg);
  dlg.showModal();
  let running = false, aborted = false;
  cancel.addEventListener("click", () => { if (running) aborted = true; else dlg.close(); });
  dlg.addEventListener("close", () => dlg.remove());
  go.addEventListener("click", async () => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(o)); } catch { /* private mode */ }
    running = true; go.disabled = true; progress.hidden = false;
    const files = [];
    try {
      for (let i = 0; i < photos.length; i++) {
        if (aborted) throw new Error("Export cancelled");
        const p = photos[i];
        status.textContent = `Rendering ${p.name} (${i + 1}/${photos.length})…`;
        const blob = await renderOne(app, p, o, (f) => { progress.value = (i + f) / photos.length; });
        files.push({ name: fileName(p, o, i, files), blob });
      }
      progress.value = 1;
      status.textContent = "Saving…";
      if (files.length === 1) await deliver(files[0].blob, files[0].name, o.dest);
      else await deliver(await zip(files), `photos-${new Date().toISOString().slice(0, 10)}.zip`, o.dest);
      app.toast(`Exported ${files.length} photo${files.length > 1 ? "s" : ""}`);
      dlg.close();
    } catch (err) {
      status.textContent = err.message;
      go.disabled = false; running = false; aborted = false;
    }
  });
}

function probe(type) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    return c.toDataURL(type).startsWith("data:" + type);
  } catch { return false; }
}

const EXT = { jpeg: "jpg", png: "png", tiff: "tif", webp: "webp", avif: "avif" };

function fileName(p, o, i, taken) {
  const base = p.name.replace(/\.[^.]+$/, "") + (p.copyName ? "-" + p.copyName.replace(/\s+/g, "") : "");
  const date = p.captured ? new Date(p.captured).toISOString().slice(0, 10) : "";
  let n = o.naming.replace("{name}", base).replace("{custom}", o.custom || "Photo").replace("{seq}", String(i + 1).padStart(3, "0")).replace("{date}", date);
  n = n.replace(/[\\/:*?"<>|]+/g, "_");
  let name = `${n}.${EXT[o.format]}`, k = 2;
  while (taken.some((f) => f.name === name)) name = `${n}-${k++}.${EXT[o.format]}`;
  return name;
}

function targetSize(w, h, o) {
  let k = 1;
  if (o.size === "long") k = o.long / Math.max(w, h);
  else if (o.size === "short") k = o.short / Math.min(w, h);
  else if (o.size === "dims") k = Math.min(o.w / w, o.h / h);
  else if (o.size === "mp") k = Math.sqrt(o.mp * 1e6 / (w * h));
  else if (o.size === "pct") k = o.pct / 100;
  if (o.noEnlarge && o.size !== "full") k = Math.min(1, k);
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

async function renderOne(app, photo, o, onProgress) {
  const info = await app.ensureOpen(photo);
  const s = await app.resolveSettings(photo, info);
  const rot = (s.orient | 0) & 1;
  const [wo, ho] = rot ? [info.h, info.w] : [info.w, info.h];
  const scale = Math.max(0.05, (s.tr_scale || 100) / 100);
  const fullW = (s.crop_r - s.crop_l) * wo / scale, fullH = (s.crop_b - s.crop_t) * ho / scale;
  const [w, hgt] = targetSize(fullW, fullH, o);
  const extra = { none: 0, low: 10, std: 20, high: 35, print: 25 }[o.sharpen] || 0;
  const params = serialize(s, { region: [0, 0, 1, 1], extraSharpen: extra });
  const watermark = o.wm && o.wmText ? makeWatermark(o, w, hgt) : null;
  const encoded = { jpeg: 0, png: 1, tiff: 2 }[o.format];
  const exif = o.meta === "all" && o.format === "jpeg" ? await app.exifFor(photo) : null;
  const res = await app.engine.export({
    key: photo.fileId, params, w, h: hgt, format: encoded ?? 0, quality: o.quality, exif: exif?.buffer || null, watermark, raw: encoded === undefined,
  }, onProgress);
  if (encoded !== undefined) return new Blob([res.bytes], { type: { 0: "image/jpeg", 1: "image/png", 2: "image/tiff" }[encoded] });
  // WebP / AVIF: let the browser encode the RGB we rendered.
  const c = document.createElement("canvas");
  c.width = w; c.height = hgt;
  const id = new ImageData(w, hgt);
  for (let i = 0, j = 0; i < w * hgt; i++, j += 3) { id.data[i * 4] = res.rgb[j]; id.data[i * 4 + 1] = res.rgb[j + 1]; id.data[i * 4 + 2] = res.rgb[j + 2]; id.data[i * 4 + 3] = 255; }
  c.getContext("2d").putImageData(id, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/" + o.format, o.quality / 100));
  if (!blob) throw new Error(`This browser can't encode ${o.format.toUpperCase()} at this size`);
  return blob;
}

function makeWatermark(o, w, hgt) {
  const px = Math.max(8, Math.round(Math.min(w, hgt) * o.wmSize / 100));
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = `600 ${px}px -apple-system, system-ui, sans-serif`;
  const tw = Math.ceil(ctx.measureText(o.wmText).width) + px, th = Math.ceil(px * 1.5);
  c.width = tw; c.height = th;
  ctx.font = `600 ${px}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.shadowColor = o.wmColor === "#ffffff" ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.4)";
  ctx.shadowBlur = px / 6;
  ctx.fillStyle = o.wmColor;
  ctx.fillText(o.wmText, px / 2, th / 2);
  const m = Math.round(Math.min(w, hgt) * 0.02);
  const pos = {
    br: [w - tw - m, hgt - th - m], bl: [m, hgt - th - m], bc: [(w - tw) / 2, hgt - th - m],
    tr: [w - tw - m, m], tl: [m, m], c: [(w - tw) / 2, (hgt - th) / 2],
  }[o.wmPos];
  const data = ctx.getImageData(0, 0, tw, th).data;
  return { rgba: new Uint8Array(data.buffer), w: tw, h: th, x: Math.round(pos[0]), y: Math.round(pos[1]), opacity: o.wmOpacity / 100 };
}

async function deliver(blob, name, dest) {
  if (dest === "share" && navigator.canShare) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (err) { if (err.name === "AbortError") return; }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ───────── Minimal ZIP (store, no compression — photos are already compressed) ─────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((a, b) => a + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
