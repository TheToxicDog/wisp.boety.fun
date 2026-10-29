// Photos: EXIF/TIFF metadata reader for JPEG and TIFF-based camera raws
// (CR2, NEF, ARW, DNG, ORF, RW2, PEF, …) plus Fuji RAF. Also finds embedded
// JPEG previews so raw imports get thumbnails without a full decode.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

function tiff(view, base, out) {
  const bo = view.getUint16(base);
  const le = bo === 0x4949;
  if (!le && bo !== 0x4d4d) return;
  const u16 = (o) => view.getUint16(base + o, le);
  const u32 = (o) => view.getUint32(base + o, le);
  const len = view.byteLength - base;
  const seen = new Set();

  const value = (type, count, voff) => {
    const sz = TYPE_SIZE[type] || 1;
    const off = sz * count <= 4 ? voff : u32(voff);
    if (off + sz * count > len) return null;
    const one = (i) => {
      const o = off + i * sz;
      switch (type) {
        case 3: return u16(o);
        case 4: case 13: return u32(o);
        case 5: return u32(o) / (u32(o + 4) || 1);
        case 8: return view.getInt16(base + o, le);
        case 9: return view.getInt32(base + o, le);
        case 10: return view.getInt32(base + o, le) / (view.getInt32(base + o + 4, le) || 1);
        case 11: return view.getFloat32(base + o, le);
        case 12: return view.getFloat64(base + o, le);
        default: return view.getUint8(base + o);
      }
    };
    if (type === 2) {
      let s = "";
      for (let i = 0; i < count; i++) { const c = view.getUint8(base + off + i); if (!c) break; s += String.fromCharCode(c); }
      return s.trim();
    }
    if (count === 1) return one(0);
    const arr = [];
    for (let i = 0; i < Math.min(count, 64); i++) arr.push(one(i));
    return arr;
  };

  const ifd = (off, kind) => {
    if (!off || off + 2 > len || seen.has(off) || seen.size > 40) return 0;
    seen.add(off);
    const n = u16(off);
    if (n > 1000 || off + 2 + n * 12 > len) return 0;
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      try { tags[tag] = value(type, count, e + 8); } catch { /* malformed entry */ }
    }
    if (kind === "ifd") {
      out.make ??= tags[0x10f];
      out.model ??= tags[0x110];
      if (tags[0x112] && !out.orientation) out.orientation = tags[0x112];
      out.software ??= tags[0x131];
      out.artist ??= tags[0x13b];
      out.copyright ??= tags[0x8298];
      if (tags[0x201] && tags[0x202]) out.previews.push({ offset: base + tags[0x201], length: tags[0x202] });
      const comp = tags[0x103], photo = tags[0x106];
      const strip = tags[0x111], bytes = tags[0x117];
      if ((comp === 6 || comp === 7) && photo !== 32803 && photo !== 34892 && typeof strip === "number" && typeof bytes === "number") {
        out.previews.push({ offset: base + strip, length: bytes });
      }
      if (tags[0x8769]) ifd(tags[0x8769], "exif");
      if (tags[0x8825]) ifd(tags[0x8825], "gps");
      const subs = tags[0x14a];
      for (const s of Array.isArray(subs) ? subs : subs ? [subs] : []) ifd(s, "ifd");
      return u32(off + 2 + n * 12);
    }
    if (kind === "exif") {
      out.exposureTime ??= tags[0x829a];
      out.fNumber ??= tags[0x829d];
      out.iso ??= Array.isArray(tags[0x8827]) ? tags[0x8827][0] : tags[0x8827];
      out.dateTimeOriginal ??= tags[0x9003] || tags[0x9004];
      out.exposureBias ??= tags[0x9204];
      out.focalLength ??= tags[0x920a];
      out.focal35 ??= tags[0xa405];
      out.flash ??= tags[0x9209];
      out.lens ??= tags[0xa434];
      out.bodySerial ??= tags[0xa431];
      out.pixelWidth ??= tags[0xa002];
      out.pixelHeight ??= tags[0xa003];
    }
    if (kind === "gps" && Array.isArray(tags[2]) && Array.isArray(tags[4])) {
      const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
      out.gps = { lat: dms(tags[2]) * (tags[1] === "S" ? -1 : 1), lon: dms(tags[4]) * (tags[3] === "W" ? -1 : 1) };
    }
    return 0;
  };

  let next = u32(4);
  // ORF/RW2 use other magic numbers but the same IFD layout.
  for (let i = 0; next && i < 6; i++) next = ifd(next, "ifd");
}

function jpegExif(view, start, out) {
  let o = start + 2;
  while (o + 4 < view.byteLength && view.getUint8(o) === 0xff) {
    const marker = view.getUint8(o + 1);
    const size = view.getUint16(o + 2);
    if (marker === 0xe1 && view.getUint32(o + 4) === 0x45786966) { // "Exif"
      out.app1 = { offset: o + 4, length: size - 2 };
      tiff(view, o + 10, out);
      return;
    }
    if (marker === 0xda || marker === 0xd9) return;
    o += 2 + size;
  }
}

export function readMeta(buffer) {
  const view = new DataView(buffer);
  const out = { previews: [] };
  try {
    if (view.byteLength < 16) return out;
    const head = String.fromCharCode(...new Uint8Array(buffer, 0, 15));
    if (view.getUint16(0) === 0xffd8) jpegExif(view, 0, out);
    else if (head.startsWith("FUJIFILMCCD-RAW")) {
      const jo = view.getUint32(84), jl = view.getUint32(88);
      if (jo + jl <= view.byteLength) { out.previews.push({ offset: jo, length: jl }); jpegExif(view, jo, out); }
      out.app1 = undefined;
    } else if (view.getUint16(0) === 0x4949 || view.getUint16(0) === 0x4d4d) tiff(view, 0, out);
  } catch { /* partial metadata is fine */ }
  out.previews = out.previews.filter((p) => p.length > 1024 && p.offset + p.length <= view.byteLength && view.getUint16(p.offset) === 0xffd8);
  out.previews.sort((a, b) => b.length - a.length);
  // Converters often store the user's rotation only inside the preview JPEG.
  if (out.previews[0]) {
    const pv = { previews: [] };
    try { jpegExif(view, out.previews[0].offset, pv); } catch { /* no EXIF in preview */ }
    if (pv.orientation > 1) out.previewOrientation = pv.orientation;
  }
  if (out.dateTimeOriginal) {
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(out.dateTimeOriginal);
    if (m) out.captured = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  return out;
}

export function previewBlob(buffer, meta) {
  const p = meta.previews?.[0];
  return p ? new Blob([new Uint8Array(buffer, p.offset, p.length)], { type: "image/jpeg" }) : null;
}

/** The original EXIF APP1 payload (for carrying metadata into JPEG exports). */
export function exifSegment(buffer, meta) {
  const a = meta.app1;
  return a ? new Uint8Array(buffer, a.offset, a.length).slice() : null;
}

export const RAW_EXT = /\.(3fr|ari|arw|bay|cr2|crw|dcr|dcs|dng|erf|fff|iiq|k25|kdc|mdc|mef|mos|mrw|nef|nrw|orf|pef|raf|raw|rw2|rwl|sr2|srf|srw|x3f)$/i;

export function fmtShutter(t) {
  if (!t) return "";
  return t >= 0.5 ? `${+t.toFixed(1)}s` : `1/${Math.round(1 / t)}s`;
}

export function summary(m = {}) {
  return [
    m.iso && `ISO ${m.iso}`,
    m.focalLength && `${Math.round(m.focalLength)}mm`,
    m.fNumber && `f/${+m.fNumber.toFixed(1)}`,
    fmtShutter(m.exposureTime),
  ].filter(Boolean).join("  ");
}
