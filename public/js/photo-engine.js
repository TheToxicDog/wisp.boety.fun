// Photos: main-thread client for the develop engine worker.
const workerUrl = new URL("./photo-worker.js" + new URL(import.meta.url).search, import.meta.url);

export class Engine {
  constructor() {
    this.worker = new Worker(workerUrl);
    this.seq = 0;
    this.pending = new Map();
    this.open = new Set(); // keys the worker currently holds
    this.lanes = new Map(); // latest-wins render lanes
    this.worker.onmessage = (e) => {
      const { id, ok, result, error, progress, lost, code } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (progress !== undefined) { p.onProgress?.(progress); return; }
      this.pending.delete(id);
      if (lost) this.open.clear();
      if (ok) p.resolve(result);
      else p.reject(Object.assign(new Error(error), { code, lost }));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "Photo engine failed to start"));
      this.pending.clear();
    };
  }

  call(op, data = {}, transfer = [], onProgress) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, op, ...data }, transfer);
    });
  }

  async load(key, bytes, orientation) {
    const info = await this.call("open", { key, bytes, orientation }, [bytes]);
    this.open.add(key);
    return info;
  }

  async loadRGBA(key, rgba, w, h) {
    const info = await this.call("openRGBA", { key, rgba, w, h }, [rgba.buffer]);
    this.open.add(key);
    return info;
  }

  close(key) { this.open.delete(key); return this.call("close", { key }); }

  /** Render; if another render on the same lane is queued, only the newest runs. */
  renderLatest(lane, args) {
    let L = this.lanes.get(lane);
    if (!L) this.lanes.set(lane, (L = { busy: false, next: null }));
    return new Promise((resolve, reject) => {
      if (L.next) L.next.resolve(null); // superseded
      L.next = { args, resolve, reject };
      this.#pump(L);
    });
  }

  async #pump(L) {
    if (L.busy || !L.next) return;
    const job = L.next;
    L.next = null;
    L.busy = true;
    try {
      const { params } = job.args;
      job.resolve(await this.call("render", job.args, [params.buffer]));
    } catch (err) { job.reject(err); }
    L.busy = false;
    this.#pump(L);
  }

  render(key, params, w, h) { return this.call("render", { key, params, w, h }, [params.buffer]); }
  wbPick(key, x, y, r) { return this.call("wbPick", { key, x, y, r }); }
  wbAuto(key) { return this.call("wbAuto", { key }); }
  export(opts, onProgress) { return this.call("export", opts, [opts.params.buffer], onProgress); }
}
