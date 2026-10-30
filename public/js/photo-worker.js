// Photos: hosts the Rust/WASM develop engine (public/photo/develop.wasm) off
// the main thread. Messages are { id, op, ... }; replies are { id, ok, ... }.
const version = new URL(self.location.href).search;
let x = null;           // wasm exports
let ready = null;
const handles = new Map(); // key → engine handle (LRU order)
const MAX_OPEN = 3;

async function boot() {
  const res = await fetch("/photo/develop.wasm" + version);
  if (!res.ok) throw new Error("Couldn't load the photo engine (" + res.status + ")");
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  x = instance.exports;
  handles.clear();
}
ready = boot();

const mem = () => x.memory.buffer;
const text = (p, n) => new TextDecoder().decode(new Uint8Array(mem(), p, n));
const lastError = () => text(x.error_ptr(), x.error_len()) || "engine error";

function put(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  const p = x.alloc(u8.length);
  new Uint8Array(mem(), p, u8.length).set(u8);
  return [p, u8.length];
}

function touch(key) {
  const h = handles.get(key);
  handles.delete(key);
  handles.set(key, h);
  return h;
}

function remember(key, h) {
  if (handles.has(key)) x.close(handles.get(key));
  handles.set(key, h);
  while (handles.size > MAX_OPEN) {
    const [k, old] = handles.entries().next().value;
    x.close(old);
    handles.delete(k);
  }
}

function infoOf(h) {
  const p = x.info(h);
  const f = new Float32Array(mem(), p, 5);
  const [make, model] = text(x.text_ptr(), x.text_len()).split("\n");
  return { w: f[0], h: f[1], isRaw: f[2] > 0.5, asShotTemp: f[3], asShotTint: f[4], make, model };
}

function handle(key) {
  if (!handles.has(key)) throw Object.assign(new Error("not open"), { code: "closed" });
  return touch(key);
}

function render(h, params, w, hgt) {
  const [p, n] = put(new Uint8Array(params.buffer, params.byteOffset, params.byteLength));
  const ok = x.render(h, p, params.length, w, hgt);
  x.dealloc(p, n);
  if (!ok) throw new Error(lastError());
}

const ops = {
  async open({ key, bytes, orientation }) {
    const [p, n] = put(bytes);
    const h = x.open(p, n, orientation || 1);
    x.dealloc(p, n);
    if (!h) throw new Error(lastError());
    remember(key, h);
    return infoOf(h);
  },
  async openRGBA({ key, rgba, w, h: hgt }) {
    const [p, n] = put(rgba);
    const h = x.open_rgba(p, w, hgt);
    x.dealloc(p, n);
    remember(key, h);
    return infoOf(h);
  },
  async has({ key }) { return handles.has(key); },
  async close({ key }) {
    if (handles.has(key)) { x.close(handles.get(key)); handles.delete(key); }
    return true;
  },
  async render({ key, params, w, h }) {
    render(handle(key), params, w, h);
    const rgba = new Uint8ClampedArray(mem(), x.out_ptr(), w * h * 4).slice();
    const hist = new Uint32Array(mem(), x.hist_ptr(), 1024).slice();
    return { rgba, hist, transfer: [rgba.buffer, hist.buffer] };
  },
  async wbPick({ key, x: px, y: py, r }) {
    const p = x.wb_pick(handle(key), px, py, r || 0.004);
    return [...new Float32Array(mem(), p, 2)];
  },
  async wbAuto({ key }) {
    const p = x.wb_auto(handle(key));
    return [...new Float32Array(mem(), p, 2)];
  },
  // Full-resolution export, rendered in tiles so memory stays bounded.
  async export({ key, params, w, h, format, quality, exif, watermark, raw }, id) {
    const hd = handle(key);
    if (!x.export_begin(w, h)) throw new Error(lastError());
    try {
      const T = 1024;
      const tiles = [];
      for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) tiles.push([tx, ty, Math.min(T, w - tx), Math.min(T, h - ty)]);
      let done = 0;
      for (const [tx, ty, tw, th] of tiles) {
        const pr = params.slice();
        const NP = x.param_count();
        pr[NP] = tx / w; pr[NP + 1] = ty / h; pr[NP + 2] = (tx + tw) / w; pr[NP + 3] = (ty + th) / h;
        render(hd, pr, tw, th);
        x.export_tile(tx, ty, tw, th);
        postMessage({ id, progress: ++done / (tiles.length + 1) });
      }
      if (watermark) {
        const [p, n] = put(watermark.rgba);
        x.export_blend(p, watermark.w, watermark.h, watermark.x, watermark.y, watermark.opacity);
        x.dealloc(p, n);
      }
      if (raw) {
        const rgb = new Uint8Array(mem(), x.export_rgb_ptr(), w * h * 3).slice();
        return { rgb, transfer: [rgb.buffer] };
      }
      let mp = 0, mn = 0;
      if (exif && exif.byteLength) [mp, mn] = put(exif);
      const len = x.export_encode(format, quality, mp, mn);
      if (mn) x.dealloc(mp, mn);
      if (!len) throw new Error(lastError());
      const bytes = new Uint8Array(mem(), x.export_ptr(), len).slice();
      return { bytes, transfer: [bytes.buffer] };
    } finally {
      x.export_end();
    }
  },
};

self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    await ready;
    const out = await ops[op](e.data, id);
    const transfer = out?.transfer || [];
    if (out && out.transfer) delete out.transfer;
    postMessage({ id, ok: true, result: out }, transfer);
  } catch (err) {
    // A trap leaves the instance unusable: start a fresh one; open photos are gone.
    const trapped = err instanceof WebAssembly.RuntimeError;
    if (trapped) ready = boot();
    postMessage({ id, ok: false, error: trapped ? "The photo engine ran out of memory or crashed" : err.message, lost: trapped, code: err.code });
  }
};
