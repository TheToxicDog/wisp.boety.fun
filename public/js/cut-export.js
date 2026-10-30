// BoetyCut: export. Renders every frame with the same compositor as the
// preview and encodes with mediabunny (WebCodecs) — the same approach as
// OpenCut's SceneExporter (apps/web/src/services/renderer/scene-exporter.ts, MIT).
import { mediabunny, FrameCache } from "./cut-media.js";
import { Compositor } from "./cut-gl.js";
import { buildScene } from "./cut-render.js";
import { mixdown } from "./cut-audio.js";
import { projectDuration } from "./cut-model.js";

export const RESOLUTIONS = [[480, "480p"], [720, "720p"], [1080, "1080p"], [1440, "2K"], [2160, "4K"]];
export const FRAME_RATES = [24, 25, 30, 50, 60];

/** Output size for a short-edge resolution, keeping the project's aspect. */
export function outSize(p, short) {
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const r = p.w / p.h;
  return r >= 1 ? { w: even(short * r), h: even(short) } : { w: even(short), h: even(short / r) };
}

export async function exportVideo(p, media, opts, onProgress, signal) {
  const mb = await mediabunny();
  const { w, h } = outSize(p, opts.res);
  const fps = opts.fps;
  const duration = projectDuration(p);
  if (duration <= 0) throw new Error("The timeline is empty");
  const webm = opts.format === "webm";
  const vcodec = await mb.getFirstEncodableVideoCodec(webm ? ["vp9", "vp8", "av1"] : ["avc", "hevc", "vp9", "av1"], { width: w, height: h });
  if (!vcodec) throw new Error(`This browser can't encode ${webm ? "WebM" : "MP4"} video at ${w}×${h}. Try a lower resolution${webm ? "" : " or WebM"}.`);
  const quality = { low: mb.QUALITY_LOW, medium: mb.QUALITY_MEDIUM, high: mb.QUALITY_HIGH, best: mb.QUALITY_VERY_HIGH }[opts.quality] || mb.QUALITY_HIGH;

  const canvas = document.createElement("canvas");
  const gl = new Compositor(canvas, { preserve: true });
  gl.resize(w, h);
  const frames = new FrameCache();
  const output = new mb.Output({ format: webm ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
  const video = new mb.CanvasSource(canvas, { codec: vcodec, bitrate: quality, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: fps });

  let audioSrc = null, audioBuf = null;
  if (opts.audio !== false) {
    onProgress?.(0, "Mixing audio…");
    audioBuf = await mixdown(p, media, duration);
    if (audioBuf) {
      const acodec = await mb.getFirstEncodableAudioCodec(webm ? ["opus", "vorbis"] : ["aac", "opus"], { numberOfChannels: 2, sampleRate: audioBuf.sampleRate });
      if (acodec) {
        audioSrc = new mb.AudioBufferSource({ codec: acodec, bitrate: quality });
        output.addAudioTrack(audioSrc);
      }
    }
  }
  await output.start();
  if (audioSrc) { await audioSrc.add(audioBuf); audioSrc.close(); }

  const total = Math.max(1, Math.round(duration * fps));
  const env = { media, frames, W: w, H: h, gl };
  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) { await output.cancel(); throw new Error("Export cancelled"); }
      const t = i / fps;
      const scene = await buildScene(p, t, env);
      gl.render(scene, true);
      await video.add(t, 1 / fps);
      if (i % 3 === 0) onProgress?.(i / total, `Rendering ${Math.round((i / total) * 100)}%`);
    }
    video.close();
    await output.finalize();
  } finally {
    frames.clear();
    gl.destroy();
  }
  onProgress?.(1, "Done");
  const type = webm ? "video/webm" : "video/mp4";
  return new Blob([output.target.buffer], { type });
}

/** Single frame as PNG at project resolution. */
export async function exportFrame(p, media, t) {
  const canvas = document.createElement("canvas");
  const gl = new Compositor(canvas, { preserve: true });
  gl.resize(p.w, p.h);
  const frames = new FrameCache();
  try {
    gl.render(await buildScene(p, t, { media, frames, W: p.w, H: p.h, gl }), true);
    return await new Promise((r) => canvas.toBlob(r, "image/png"));
  } finally { frames.clear(); gl.destroy(); }
}

/**
 * Reverse a clip's source range into a new video file (CapCut's "Reverse").
 * Works backwards in one-second chunks so memory stays bounded.
 */
export async function reverseRange(m, blob, from, to, onProgress) {
  const mb = await mediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    const fps = Math.min(60, Math.max(10, Math.round(m.fps || 30)));
    const k = Math.min(1, 1920 / Math.max(vt.displayWidth, vt.displayHeight));
    const w = Math.round(vt.displayWidth * k / 2) * 2, h = Math.round(vt.displayHeight * k / 2) * 2;
    const sink = new mb.CanvasSink(vt, { width: w, height: h, fit: "fill" });
    const first = await vt.getFirstTimestamp().catch(() => 0);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext("2d");
    const vcodec = await mb.getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width: w, height: h });
    if (!vcodec) throw new Error("This browser can't encode video");
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
    const src = new mb.CanvasSource(canvas, { codec: vcodec, bitrate: mb.QUALITY_HIGH, keyFrameInterval: 1 });
    output.addVideoTrack(src, { frameRate: fps });
    let asrc = null, rev = null;
    const at = await input.getPrimaryAudioTrack();
    if (at && (await at.canDecode())) {
      const ab = new mb.AudioBufferSink(at);
      const sr = at.sampleRate || 48000, ch = Math.min(2, at.numberOfChannels || 2);
      const len = Math.max(1, Math.round((to - from) * sr));
      const data = [...Array(ch)].map(() => new Float32Array(len));
      for await (const { buffer, timestamp } of ab.buffers(first + from, first + to)) {
        const off = Math.round((timestamp - first - from) * sr);
        for (let c = 0; c < ch; c++) {
          const d = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
          for (let i = 0; i < d.length; i++) { const j = off + i; if (j >= 0 && j < len) data[c][len - 1 - j] = d[i]; }
        }
      }
      rev = new AudioBuffer({ length: len, numberOfChannels: ch, sampleRate: sr });
      data.forEach((d, c) => rev.copyToChannel(d, c));
      const acodec = await mb.getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: ch, sampleRate: sr });
      if (acodec) { asrc = new mb.AudioBufferSource({ codec: acodec, bitrate: mb.QUALITY_HIGH }); output.addAudioTrack(asrc); }
    }
    await output.start();
    if (asrc) { await asrc.add(rev); asrc.close(); }
    const n = Math.max(1, Math.round((to - from) * fps));
    let outIndex = 0;
    for (let chunkEnd = n; chunkEnd > 0; chunkEnd -= fps) {
      const chunkStart = Math.max(0, chunkEnd - fps);
      const times = [];
      for (let i = chunkStart; i < chunkEnd; i++) times.push(first + from + (i + 0.5) / fps);
      const got = [];
      for await (const f of sink.canvasesAtTimestamps(times)) {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        if (f) c.getContext("2d").drawImage(f.canvas, 0, 0);
        got.push(c);
      }
      for (let i = got.length - 1; i >= 0; i--) {
        g.drawImage(got[i], 0, 0);
        await src.add(outIndex / fps, 1 / fps);
        outIndex++;
      }
      onProgress?.(outIndex / n);
    }
    src.close();
    await output.finalize();
    return { blob: new Blob([output.target.buffer], { type: "video/mp4" }), duration: n / fps, w, h, hasAudio: !!asrc, fps };
  } finally { input.dispose?.(); }
}
