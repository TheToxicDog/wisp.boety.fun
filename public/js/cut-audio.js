// BoetyCut: audio playback and mixdown with Web Audio. The audio clock is
// the master clock while playing; video frames follow it.
import { audioContext, audioOf } from "./cut-media.js";
import { propAt, clipEnd, sourceTime } from "./cut-model.js";

/** Clips that produce sound, with their decoded buffers (skips those not ready). */
async function soundClips(p, media, wait) {
  const out = [];
  for (const tr of p.tracks) {
    if (tr.muted || !["main", "video", "audio"].includes(tr.kind)) continue;
    for (const c of tr.items) {
      if (c.mute || c.curve || !(c.type === "video" || c.type === "audio")) continue;
      const m = media.get(c.mediaId);
      if (!m || !(m.hasAudio || m.kind === "audio")) continue;
      const pending = audioOf(m);
      const buf = wait ? await pending : await Promise.race([pending, Promise.resolve(undefined)]);
      if (buf) out.push({ c, buf });
    }
  }
  return out;
}

/** Schedule one clip on a context; `from` is timeline time at context time `at`. */
function schedule(ctx, dest, { c, buf }, from, at) {
  const end = clipEnd(c);
  if (end <= from) return null;
  const t0 = Math.max(from, c.start);
  const lt0 = t0 - c.start;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = c.speed;
  const g = ctx.createGain();
  src.connect(g).connect(dest);
  const when = at + (t0 - from);
  // volume envelope: keyframes × fades, sampled
  const env = (lt) => {
    let v = propAt(c, "volume", lt);
    if (c.fadeIn > 0 && lt < c.fadeIn) v *= lt / c.fadeIn;
    if (c.fadeOut > 0 && c.dur - lt < c.fadeOut) v *= Math.max(0, (c.dur - lt) / c.fadeOut);
    return Math.max(0, v);
  };
  g.gain.setValueAtTime(env(lt0), when);
  const step = 0.05;
  for (let lt = lt0 + step; lt < c.dur; lt += step) g.gain.linearRampToValueAtTime(env(lt), when + (lt - lt0));
  const offset = sourceTime(c, lt0);
  if (offset >= buf.duration) return null;
  src.start(when, Math.max(0, offset), (end - t0) * c.speed);
  return src;
}

export class AudioPlayer {
  constructor() { this.sources = []; this.playing = false; }

  get ctx() { return audioContext(); }

  /** Current timeline time while playing. */
  now() { return this.playing ? this.from + (this.ctx.currentTime - this.at) : this.from; }

  async play(p, media, from, volume = 1) {
    this.stop();
    const ctx = this.ctx;
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    this.master = ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(ctx.destination);
    this.from = from;
    this.at = ctx.currentTime + 0.05;
    this.playing = true;
    const clips = await soundClips(p, media, false);
    if (!this.playing) return;
    const lag = Math.max(0, ctx.currentTime - this.at);
    for (const sc of clips) {
      const s = schedule(ctx, this.master, sc, this.from + lag, this.at + lag);
      if (s) this.sources.push(s);
    }
  }

  stop() {
    if (this.playing) this.from = this.now();
    this.playing = false;
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources = [];
    this.master?.disconnect();
    this.master = null;
  }

  seek(t) { this.from = t; }
}

/** Mix the whole project to an AudioBuffer (for export). */
export async function mixdown(p, media, duration, sampleRate = 48000) {
  const clips = await soundClips(p, media, true);
  if (!clips.length) return null;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  for (const sc of clips) schedule(ctx, ctx.destination, sc, 0, 0);
  return ctx.startRendering();
}

/** Mono 16 kHz samples of the project's audio (for speech recognition). */
export async function speechSamples(p, media, duration) {
  const buf = await mixdown(p, media, duration, 16000);
  if (!buf) return null;
  const a = buf.getChannelData(0), b = buf.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}
