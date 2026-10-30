// BoetyCut: media import, frame decoding, filmstrips and waveforms.
// Video frames are decoded with mediabunny (WebCodecs); FrameCache is a port
// of OpenCut's VideoCache (apps/web/src/services/video-cache/service.ts, MIT):
// one decoder iterator per clip, prefetching the next frame, re-seeking only
// on jumps.
import * as store from "./cut-store.js";
import { uid } from "./cut-model.js";

let mbp = null;
export const mediabunny = () => (mbp ??= import("/mediabunny/mediabunny.min.mjs"));

const blobs = new Map(); // mediaId → Blob
const images = new Map(); // mediaId → ImageBitmap
const audio = new Map(); // mediaId → Promise<AudioBuffer|null>

export async function blobOf(m) {
  if (blobs.has(m.id)) return blobs.get(m.id);
  const rec = m.blob ? m : await store.getMedia(m.id);
  if (!rec?.blob) throw new Error(`Media "${m.name}" is missing`);
  blobs.set(m.id, rec.blob);
  return rec.blob;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ts)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i;

export function kindOf(file) {
  if (file.type.startsWith("video/") || VIDEO_EXT.test(file.name)) return "video";
  if (file.type.startsWith("audio/") || AUDIO_EXT.test(file.name)) return "audio";
  if (file.type.startsWith("image/")) return "image";
  return null;
}

/** Probe and store an imported file; returns the media record (without blob). */
export async function importFile(file, projectId) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`${file.name}: unsupported file type`);
  const m = { id: uid(), projectId, name: file.name, kind, size: file.size, duration: 0, w: 0, h: 0, hasAudio: false, added: Date.now() };
  if (kind === "image") {
    const bmp = await createImageBitmap(file);
    m.w = bmp.width; m.h = bmp.height; m.duration = 0;
    images.set(m.id, bmp);
  } else {
    const mb = await mediabunny();
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    try {
      m.duration = await input.computeDuration();
      if (kind === "video") {
        const vt = await input.getPrimaryVideoTrack();
        if (!vt) { m.kind = "audio"; } else {
          if (!(await vt.canDecode())) throw new Error(`${file.name}: this browser can't decode its video codec (${vt.codec || "unknown"})`);
          m.w = vt.displayWidth; m.h = vt.displayHeight;
          m.fps = await vt.computePacketStats(120).then((s) => s.averagePacketRate).catch(() => 30);
        }
      }
      const at = await input.getPrimaryAudioTrack();
      m.hasAudio = !!at;
    } catch (err) {
      if (kind === "audio") {
        // Fall back to the browser's decoder for odd audio containers.
        const buf = await decodeWithContext(file);
        if (!buf) throw err;
        m.duration = buf.duration; m.hasAudio = true;
        audio.set(m.id, Promise.resolve(buf));
      } else throw err;
    } finally {
      input.dispose?.();
    }
  }
  blobs.set(m.id, file);
  await store.putMedia({ ...m, blob: file });
  return m;
}

/** Save generated media (reversed clips, voiceovers) the same way. */
export async function addGenerated(blob, name, projectId, meta) {
  const m = { id: uid(), projectId, name, kind: meta.kind, size: blob.size, duration: meta.duration, w: meta.w || 0, h: meta.h || 0, hasAudio: !!meta.hasAudio, added: Date.now(), generated: true };
  blobs.set(m.id, blob);
  await store.putMedia({ ...m, blob });
  return m;
}

export async function imageOf(m) {
  if (images.has(m.id)) return images.get(m.id);
  const bmp = await createImageBitmap(await blobOf(m));
  images.set(m.id, bmp);
  return bmp;
}

// ───────── Audio ─────────
let ctx = null;
export const audioContext = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

async function decodeWithContext(blob) {
  try { return await audioContext().decodeAudioData(await blob.arrayBuffer()); } catch { return null; }
}

/** Decoded audio for a media item (null if it has none). */
export function audioOf(m) {
  if (!m.hasAudio && m.kind !== "audio") return Promise.resolve(null);
  if (!audio.has(m.id)) audio.set(m.id, (async () => {
    const blob = await blobOf(m);
    const direct = await decodeWithContext(blob);
    if (direct) return direct;
    // mediabunny fallback (e.g. audio inside containers the browser won't decode directly)
    const mb = await mediabunny();
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return null;
      const sink = new mb.AudioBufferSink(track);
      const parts = [];
      for await (const { buffer, timestamp } of sink.buffers()) parts.push({ buffer, timestamp });
      if (!parts.length) return null;
      const sr = parts[0].buffer.sampleRate, ch = parts[0].buffer.numberOfChannels;
      const len = Math.ceil((parts.at(-1).timestamp + parts.at(-1).buffer.duration) * sr);
      const out = audioContext().createBuffer(ch, Math.max(1, len), sr);
      for (const { buffer, timestamp } of parts) {
        const off = Math.round(timestamp * sr);
        for (let c = 0; c < ch; c++) out.getChannelData(c).set(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).subarray(0, Math.max(0, len - off)), Math.max(0, off));
      }
      return out;
    } catch { return null; } finally { input.dispose?.(); }
  })());
  return audio.get(m.id);
}

/** Peak envelope (max abs per bucket) for drawing waveforms. */
export async function peaksOf(m, perSecond = 50) {
  const key = "peaks:" + m.id;
  const cached = await store.getThumb(key);
  if (cached) return cached;
  const buf = await audioOf(m);
  if (!buf) return null;
  const n = Math.max(1, Math.ceil(buf.duration * perSecond));
  const step = buf.length / n;
  const out = new Float32Array(n);
  const chans = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let mx = 0;
    const a = Math.floor(i * step), b = Math.min(buf.length, Math.floor((i + 1) * step));
    for (let j = a; j < b; j += 4) for (const d of chans) { const v = Math.abs(d[j]); if (v > mx) mx = v; }
    out[i] = mx;
  }
  const res = { perSecond, data: out };
  store.putThumb(key, res);
  return res;
}

// ───────── Filmstrips ─────────
const strips = new Map();
/** Thumbnails at regular source times, as a sprite image URL. */
export function stripOf(m) {
  if (strips.has(m.id)) return strips.get(m.id);
  const p = (async () => {
    const key = "strip:" + m.id;
    let rec = await store.getThumb(key);
    if (!rec) {
      const th = 64, tw = Math.max(16, Math.round(th * ((m.w || 16) / (m.h || 9))));
      const count = m.kind === "image" ? 1 : Math.min(120, Math.max(2, Math.ceil(m.duration / 1)));
      const c = document.createElement("canvas");
      c.width = tw * count; c.height = th;
      const g = c.getContext("2d");
      if (m.kind === "image") g.drawImage(await imageOf(m), 0, 0, tw, th);
      else {
        const mb = await mediabunny();
        const input = new mb.Input({ source: new mb.BlobSource(await blobOf(m)), formats: mb.ALL_FORMATS });
        try {
          const vt = await input.getPrimaryVideoTrack();
          const sink = new mb.CanvasSink(vt, { width: tw, height: th, fit: "cover" });
          const start = await vt.getFirstTimestamp().catch(() => 0);
          const times = [...Array(count)].map((_, i) => start + (i + 0.5) * (m.duration / count));
          let i = 0;
          for await (const f of sink.canvasesAtTimestamps(times)) { if (f) g.drawImage(f.canvas, i * tw, 0); i++; }
        } finally { input.dispose?.(); }
      }
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.7));
      rec = { blob, tw, th, count, step: m.kind === "image" ? 0 : m.duration / count };
      store.putThumb(key, rec);
    }
    return { ...rec, url: URL.createObjectURL(rec.blob) };
  })();
  p.catch((err) => { console.warn("filmstrip failed", m.name, err); strips.delete(m.id); });
  strips.set(m.id, p);
  return p;
}

// ───────── Frame cache (ported from OpenCut) ─────────
export class FrameCache {
  constructor({ maxSize = 0 } = {}) {
    this.maxSize = maxSize; // longest edge for decoded frames (0 = native)
    this.sinks = new Map();
    this.inits = new Map();
    this.chains = new Map();
    this.gens = new Map();
  }

  /** Frame (canvas) showing source time `t` for lane `key` (one lane per clip). */
  async frameAt(key, m, t) {
    await this.ensure(key, m);
    const s = this.sinks.get(key);
    if (!s) return null;
    const gen = (this.gens.get(key) ?? 0) + 1;
    this.gens.set(key, gen);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const cur = prev.then(() => (this.gens.get(key) !== gen ? s.current : this.resolve(s, t + s.offset)));
    this.chains.set(key, cur.catch(() => {}));
    const f = await cur;
    return f?.canvas || null;
  }

  valid(f, t) { return f && t >= f.timestamp - 1e-4 && t < f.timestamp + (f.duration || 1 / 30); }

  async resolve(s, t) {
    if (s.next && s.next.timestamp <= t) { s.current = s.next; s.next = null; this.prefetch(s); }
    if (this.valid(s.current, t)) { if (!s.next && !s.prefetching) this.prefetch(s); return s.current; }
    if (s.iterator && s.current && t >= s.lastTime && t < s.lastTime + 2) {
      const f = await this.iterate(s, t);
      if (f) { if (!s.next && !s.prefetching) this.prefetch(s); return f; }
    }
    const f = await this.seek(s, t);
    if (f && !s.next && !s.prefetching) this.prefetch(s);
    return f;
  }

  async iterate(s, t) {
    try {
      while (true) {
        if (s.prefetching && s.prefetchP) await s.prefetchP;
        if (s.next && s.next.timestamp <= t + 0.05) { s.current = s.next; s.next = null; }
        else {
          const { value, done } = await s.iterator.next();
          if (done || !value) break;
          s.current = value;
        }
        const f = s.current;
        if (!f) break;
        s.lastTime = f.timestamp;
        if (this.valid(f, t)) return f;
        if (f.timestamp > t + 1) break;
      }
    } catch { s.iterator = null; }
    return null;
  }

  async seek(s, t) {
    try {
      if (s.prefetching && s.prefetchP) await s.prefetchP;
      if (s.iterator) { await s.iterator.return(); s.iterator = null; }
      s.next = null;
      s.iterator = s.sink.canvases(t);
      s.lastTime = t;
      const { value } = await s.iterator.next();
      if (value) { s.current = value; return value; }
      // Past the end: keep showing the last frame we had.
      return s.current;
    } catch { return s.current; }
  }

  prefetch(s) {
    if (s.prefetching || !s.iterator || s.next) return;
    s.prefetching = true;
    s.prefetchP = (async () => {
      try {
        const { value, done } = await s.iterator.next();
        if (!done && value) s.next = value;
      } catch { s.iterator = null; }
      s.prefetching = false;
      s.prefetchP = null;
    })();
  }

  async ensure(key, m) {
    const have = this.sinks.get(key);
    if (have && have.mediaId === m.id) return;
    if (have) this.drop(key);
    if (this.inits.has(key)) return this.inits.get(key);
    const p = (async () => {
      const mb = await mediabunny();
      const input = new mb.Input({ source: new mb.BlobSource(await blobOf(m)), formats: mb.ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) { input.dispose?.(); throw new Error("No video track"); }
      const opts = { poolSize: 3, fit: "contain" };
      if (this.maxSize && Math.max(vt.displayWidth, vt.displayHeight) > this.maxSize) {
        const k = this.maxSize / Math.max(vt.displayWidth, vt.displayHeight);
        opts.width = Math.round(vt.displayWidth * k); opts.height = Math.round(vt.displayHeight * k);
      }
      const offset = await vt.getFirstTimestamp().catch(() => 0);
      this.sinks.set(key, { mediaId: m.id, input, sink: new mb.CanvasSink(vt, opts), iterator: null, current: null, next: null, lastTime: -1, prefetching: false, prefetchP: null, offset });
    })();
    this.inits.set(key, p);
    try { await p; } finally { this.inits.delete(key); }
  }

  drop(key) {
    const s = this.sinks.get(key);
    if (s) { s.iterator?.return?.(); s.input.dispose?.(); this.sinks.delete(key); }
    this.chains.delete(key);
    this.gens.delete(key);
  }

  /** Release lanes that aren't in `keep`. */
  retain(keep) { for (const k of [...this.sinks.keys()]) if (!keep.has(k)) this.drop(k); }
  clear() { for (const k of [...this.sinks.keys()]) this.drop(k); }
}

export function forget(mediaId) {
  blobs.delete(mediaId); images.delete(mediaId); audio.delete(mediaId);
  const s = strips.get(mediaId);
  if (s) { s.then((r) => URL.revokeObjectURL(r.url)).catch(() => {}); strips.delete(mediaId); }
}
