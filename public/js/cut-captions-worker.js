// BoetyCut auto captions: Whisper in the browser via transformers.js, loaded
// on demand. Ported from OpenCut's transcription worker
// (apps/web/src/services/transcription/worker.ts, MIT).
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

let transcriber = null;
let modelId = null;

self.onmessage = async (e) => {
  const { audio, model, language } = e.data;
  try {
    if (!transcriber || modelId !== model) {
      const files = new Map();
      transcriber = await pipeline("automatic-speech-recognition", model, {
        dtype: "q4",
        device: "auto",
        progress_callback: (p) => {
          if (!p.file) return;
          if (p.status === "progress" && p.total > 0) files.set(p.file, [p.loaded, p.total]);
          else if (p.status === "done" && files.has(p.file)) files.set(p.file, [files.get(p.file)[1], files.get(p.file)[1]]);
          let a = 0, b = 0;
          for (const [l, t] of files.values()) { a += l; b += t; }
          if (b) self.postMessage({ type: "download", progress: a / b });
        },
      });
      modelId = model;
    }
    self.postMessage({ type: "transcribing" });
    const raw = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: language === "auto" ? undefined : language,
      return_timestamps: true,
    });
    const r = Array.isArray(raw) ? raw[0] : raw;
    const segments = (r.chunks || [])
      .filter((c) => c.timestamp?.length >= 2)
      .map((c) => ({ text: c.text.trim(), start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 2 }));
    self.postMessage({ type: "done", segments });
  } catch (err) {
    self.postMessage({ type: "error", error: err.message || String(err) });
  }
};
