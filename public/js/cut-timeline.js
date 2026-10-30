// BoetyCut: the timeline. CapCut-style: the playhead is fixed in the middle
// and the tracks scroll under it; scrolling scrubs.
import { TRACK_KINDS, isMedia, sourceTime, clipEnd, layoutMain, findClip, trackFor, sortItems, keyframeTimes, effectById, FILTERS, fmtTime, clamp } from "./cut-model.js";
import { stripOf, peaksOf } from "./cut-media.js";
import { h, svgIcon } from "./photo-ui.js";

const ROW = { main: 58, video: 40, text: 30, sticker: 30, effect: 26, filter: 26, adjust: 26, audio: 38 };
const GAP = 6, RULER = 22, MIN = 0.1;
const sprites = new Map();
const spriteImg = (url) => {
  if (!sprites.has(url)) { const i = new Image(); i.src = url; sprites.set(url, i); }
  return sprites.get(url);
};

export class Timeline {
  constructor(ed) {
    this.ed = ed;
    this.pps = 60; // pixels per second
    this.snap = true;
    this.el = h("div", { class: "bc-tl" });
    this.scroll = h("div", { class: "bc-tl-scroll" });
    this.content = h("div", { class: "bc-tl-content" });
    this.scroll.append(this.content);
    this.playhead = h("div", { class: "bc-playhead" });
    this.snapLine = h("div", { class: "bc-snapline", hidden: true });
    this.view = h("div", { class: "bc-tl-view" }, this.scroll, this.playhead, this.snapLine);
    this.el.append(this.view);
    this.bind();
    new ResizeObserver(() => this.render()).observe(this.view);
  }

  get pad() { return this.view.clientWidth / 2; }
  x(t) { return this.pad + t * this.pps; }

  // ───────── Rendering ─────────
  render() {
    const ed = this.ed, p = ed.p;
    if (!p) return;
    const dur = ed.duration();
    const W = this.pad * 2 + Math.max(dur, 1) * this.pps;
    this.content.style.width = W + "px";
    const rows = [];
    let y = RULER + 6;
    const ruler = h("div", { class: "bc-ruler", style: { width: W + "px" } });
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * this.pps >= 70) || 600;
    for (let t = 0; t <= dur + step; t += step) {
      ruler.append(h("span", { style: { left: this.x(t) + "px" } }, fmtTime(t)));
      ruler.append(h("i", { style: { left: this.x(t + step / 2) + "px" } }));
    }
    rows.push(ruler);
    this.rowMap = [];
    for (const tr of p.tracks) {
      const rh = ROW[tr.kind] || 30;
      const row = h("div", { class: `bc-row k-${tr.kind}` + (tr.hidden ? " hidden" : "") + (tr.muted ? " muted" : ""), style: { top: y + "px", height: rh + "px", width: W + "px" }, "data-track": tr.id });
      // sticky track controls at the left edge of the viewport
      const ctrls = h("div", { class: "bc-rowctl" });
      if (tr.kind === "main" || tr.kind === "video" || tr.kind === "audio") {
        ctrls.append(h("button", { type: "button", class: "bc-mini" + (tr.muted ? " on" : ""), title: tr.muted ? "Unmute track" : "Mute track", onclick: (e) => { e.stopPropagation(); ed.change(tr.muted ? "Unmute" : "Mute", () => { tr.muted = !tr.muted; }); } }, svgIcon(tr.muted ? I.muted : I.sound, 14)));
      }
      if (tr.kind !== "audio") {
        ctrls.append(h("button", { type: "button", class: "bc-mini" + (tr.hidden ? " on" : ""), title: tr.hidden ? "Show track" : "Hide track", onclick: (e) => { e.stopPropagation(); ed.change(tr.hidden ? "Show track" : "Hide track", () => { tr.hidden = !tr.hidden; }); } }, svgIcon(tr.hidden ? I.hidden : I.eye, 14)));
      }
      row.append(ctrls);
      for (const c of tr.items) row.append(this.clipEl(tr, c, rh));
      if (tr.kind === "main") {
        // transition markers between clips + add button at the end
        tr.items.forEach((c, i) => {
          if (i === tr.items.length - 1) return;
          const b = h("button", { type: "button", class: "bc-trans" + (c.transition ? " on" : "") + (ed.sel === "t:" + c.id ? " sel" : ""), style: { left: this.x(clipEnd(c)) + "px" }, title: "Transition", "data-trans": c.id }, svgIcon(I.trans, 12));
          row.append(b);
        });
        const end = tr.items.length ? clipEnd(tr.items.at(-1)) : 0;
        row.append(h("button", { type: "button", class: "bc-add", style: { left: this.x(end) + 10 + "px" }, title: "Add media", onclick: (e) => { e.stopPropagation(); ed.importInto("main"); } }, svgIcon(I.plus, 20)));
      }
      rows.push(row);
      this.rowMap.push({ tr, top: y, h: rh });
      y += rh + GAP;
    }
    this.content.style.height = y + 30 + "px";
    this.content.replaceChildren(...rows);
    this.syncScroll();
  }

  clipEl(tr, c, rh) {
    const ed = this.ed;
    const sel = ed.sel === c.id;
    const w = Math.max(2, c.dur * this.pps);
    const label = c.type === "text" ? (c.text?.content || "Text").split("\n")[0]
      : c.type === "sticker" ? (c.emoji || "Sticker")
      : tr.kind === "effect" ? effectById(c.effect?.id)?.name || "Effect"
      : tr.kind === "filter" ? FILTERS.find((f) => f.id === c.filter?.id)?.name || "Filter"
      : tr.kind === "adjust" ? "Adjust" : ed.media.get(c.mediaId)?.name || "";
    const el = h("div", { class: `bc-clip t-${c.type}` + (sel ? " sel" : "") + (c.mute ? " mute" : ""), "data-clip": c.id, style: { left: this.x(c.start) + "px", width: w + "px", height: rh + "px", "--kc": TRACK_KINDS[tr.kind]?.color } });
    if (c.type === "video" || c.type === "image" || (c.type === "sticker" && c.mediaId)) {
      const cv = h("canvas", { class: "bc-strip", height: rh * 2, width: Math.min(8000, Math.ceil(w * 2)) });
      el.append(cv);
      this.drawStrip(cv, c, rh);
    } else if (c.type === "audio") {
      const cv = h("canvas", { class: "bc-wave", height: rh * 2, width: Math.min(8000, Math.ceil(w * 2)) });
      el.append(cv);
      this.drawWave(cv, c, rh);
    }
    el.append(h("span", { class: "bc-clabel" }, label + (c.speed !== 1 || c.curve ? `  ${c.curve ? "curve" : c.speed + "×"}` : "") + (rh > 40 ? "  " + fmtTime(c.dur, true) : "")));
    if (sel) {
      el.append(h("div", { class: "bc-handle l", "data-handle": "l" }), h("div", { class: "bc-handle r", "data-handle": "r" }));
      for (const kt of keyframeTimes(c)) el.append(h("i", { class: "bc-kf", style: { left: kt * this.pps + "px" } }));
    }
    return el;
  }

  async drawStrip(cv, c, rh) {
    const m = this.ed.media.get(c.mediaId);
    if (!m) return;
    const s = await stripOf(m).catch(() => null);
    if (!s) return;
    const img = spriteImg(s.url);
    if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    const g = cv.getContext("2d");
    const H = cv.height, tw = H * (s.tw / s.th);
    const k = cv.width / Math.max(1, c.dur * this.pps);
    for (let x = 0; x < cv.width; x += tw) {
      const lt = (x + tw / 2) / k / this.pps;
      const st = m.kind === "image" ? 0 : sourceTime(c, Math.min(lt, c.dur));
      const i = s.step ? clamp(Math.floor(st / s.step), 0, s.count - 1) : 0;
      g.drawImage(img, i * s.tw, 0, s.tw, s.th, x, 0, tw, H);
    }
  }

  async drawWave(cv, c, rh) {
    const m = this.ed.media.get(c.mediaId);
    if (!m) return;
    const pk = await peaksOf(m).catch(() => null);
    if (!pk) return;
    const g = cv.getContext("2d");
    const H = cv.height;
    g.fillStyle = "rgba(255,255,255,.75)";
    const k = cv.width / Math.max(1, c.dur * this.pps);
    for (let x = 0; x < cv.width; x += 3) {
      const st = sourceTime(c, x / k / this.pps);
      const v = pk.data[Math.floor(st * pk.perSecond)] || 0;
      const bh = Math.max(1, v * H * 0.9 * Math.min(2, c.volume));
      g.fillRect(x, (H - bh) / 2, 2, bh);
    }
  }

  // Keep the scroll position matched to the editor time.
  syncScroll() {
    this.programmatic = true;
    this.scroll.scrollLeft = this.ed.T * this.pps;
    requestAnimationFrame(() => { this.programmatic = false; });
  }

  setZoom(pps) {
    this.pps = clamp(pps, 4, 600);
    this.render();
  }

  // ───────── Interaction ─────────
  bind() {
    const sc = this.scroll;
    sc.addEventListener("scroll", () => {
      if (this.programmatic || this.drag) return;
      if (this.ed.playing) this.ed.pause();
      this.ed.seek(sc.scrollLeft / this.pps, { fromTimeline: true });
    }, { passive: true });
    sc.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) { sc.scrollLeft += e.deltaY; e.preventDefault(); }
        return;
      }
      e.preventDefault();
      this.setZoom(this.pps * Math.exp(-e.deltaY * 0.01));
    }, { passive: false });
    // two-finger pinch zoom
    let pinch = null;
    sc.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) pinch = { d: dist(e.touches), pps: this.pps };
    }, { passive: true });
    sc.addEventListener("touchmove", (e) => {
      if (pinch && e.touches.length === 2) { e.preventDefault(); this.setZoom(pinch.pps * dist(e.touches) / pinch.d); }
    }, { passive: false });
    sc.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });

    sc.addEventListener("click", (e) => {
      if (this.justDragged) { this.justDragged = false; return; }
      const tb = e.target.closest("[data-trans]");
      if (tb) { this.ed.select("t:" + tb.dataset.trans); this.ed.openTool("transition"); return; }
      const ce = e.target.closest("[data-clip]");
      if (ce) { this.ed.select(ce.dataset.clip); return; }
      if (e.target.closest(".bc-ruler")) {
        const r = this.content.getBoundingClientRect();
        this.ed.seek((e.clientX - r.left - this.pad) / this.pps);
        return;
      }
      if (!e.target.closest("button")) this.ed.select(null);
    });

    sc.addEventListener("pointerdown", (e) => {
      const ce = e.target.closest("[data-clip]");
      if (!ce || e.button > 0) return;
      const id = ce.dataset.clip;
      const f = findClip(this.ed.p, id);
      if (!f) return;
      const handle = e.target.dataset.handle;
      const isMouse = e.pointerType === "mouse";
      // touch: only the selected clip (and its handles) can be dragged; the rest scrolls
      if (!isMouse && this.ed.sel !== id) return;
      if (f.track.locked) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, clip: structuredClone(f.clip) };
      this.drag = { id, handle, start, moved: false, pointer: e.pointerId };
      // capture only once a drag starts, so plain clicks still reach the clip
      if (!isMouse) sc.setPointerCapture(e.pointerId);
    });
    sc.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointer) return;
      const dx = e.clientX - d.start.x, dy = e.clientY - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) {
        d.moved = true;
        if (!sc.hasPointerCapture(e.pointerId)) sc.setPointerCapture(e.pointerId);
        this.ed.beginChange(d.handle ? "Trim" : "Move");
        if (this.ed.sel !== d.id) this.ed.select(d.id, true);
      }
      this.autoScroll(e.clientX);
      const dt = (dx + (this.scroll.scrollLeft - (d.scroll0 ??= this.scroll.scrollLeft))) / this.pps;
      if (d.handle) this.trim(d, dt);
      else this.move(d, dt, e.clientY);
    });
    const end = (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointer) return;
      this.drag = null;
      this.snapLine.hidden = true;
      clearInterval(this.autoTimer); this.autoTimer = null;
      if (d.moved) {
        this.justDragged = true;
        if (d.target) this.dropMain(d);
        this.ed.endChange();
      }
    };
    sc.addEventListener("pointerup", end);
    sc.addEventListener("pointercancel", end);
  }

  autoScroll(cx) {
    const r = this.view.getBoundingClientRect();
    const edge = 40;
    const v = cx < r.left + edge ? -8 : cx > r.right - edge ? 8 : 0;
    if (!v) { clearInterval(this.autoTimer); this.autoTimer = null; return; }
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => { this.programmatic = true; this.scroll.scrollLeft += v; this.programmatic = false; }, 16);
  }

  snapTime(t, exceptId) {
    if (!this.snap) return t;
    const thr = 8 / this.pps;
    let best = null;
    const cands = [this.ed.T, 0];
    for (const tr of this.ed.p.tracks) for (const c of tr.items) if (c.id !== exceptId) cands.push(c.start, clipEnd(c));
    for (const s of cands) if (Math.abs(s - t) < thr && (best === null || Math.abs(s - t) < Math.abs(best - t))) best = s;
    if (best !== null) {
      this.snapLine.hidden = false;
      this.snapLine.style.left = this.pad + (best - this.scroll.scrollLeft / this.pps) * this.pps + "px";
      return best;
    }
    this.snapLine.hidden = true;
    return t;
  }

  trim(d, dt) {
    const p = this.ed.p, f = findClip(p, d.id);
    if (!f) return;
    const c = f.clip, o = d.start.clip;
    const m = this.ed.media.get(c.mediaId);
    const sp = c.curve ? 1 : c.speed;
    if (d.handle === "l") {
      let ns = f.track.kind === "main" ? o.start + dt : this.snapTime(o.start + dt, c.id);
      let delta = ns - o.start;
      if (isMedia(c)) delta = clamp(delta, -o.in / sp, o.dur - MIN);
      else delta = Math.min(delta, o.dur - MIN);
      if (f.track.kind !== "main") delta = Math.max(delta, -o.start);
      if (isMedia(c)) c.in = o.in + delta * sp;
      c.dur = o.dur - delta;
      if (f.track.kind !== "main") c.start = o.start + delta;
    } else {
      let ne = f.track.kind === "main" ? o.start + o.dur + dt : this.snapTime(o.start + o.dur + dt, c.id);
      let nd = Math.max(MIN, ne - o.start);
      if (isMedia(c) && m) nd = Math.min(nd, (m.duration - o.in) / sp);
      if (isMedia(c)) c.out = o.in + nd * sp;
      c.dur = nd;
    }
    if (f.track.kind === "main") layoutMain(p);
    this.ed.refresh({ timeline: true, quick: true });
  }

  move(d, dt, cy) {
    const p = this.ed.p, f = findClip(p, d.id);
    if (!f) return;
    const c = f.clip;
    if (f.track.kind === "main") {
      // reorder: drop position by time under the pointer
      const T = d.start.clip.start + d.start.clip.dur / 2 + dt;
      const items = f.track.items.filter((x) => x.id !== c.id);
      let idx = items.findIndex((x) => T < x.start + x.dur / 2 + (x.start > c.start ? -c.dur : 0));
      if (idx < 0) idx = items.length;
      d.target = idx;
      const el = this.content.querySelector(`[data-clip="${c.id}"]`);
      if (el) { el.style.transform = `translateX(${dt * this.pps}px)`; el.classList.add("dragging"); }
      return;
    }
    const ns = Math.max(0, this.snapTime(d.start.clip.start + dt, c.id));
    const ne = this.snapTime(ns + c.dur, c.id);
    c.start = Math.abs(ne - (ns + c.dur)) < 1e-9 ? ns : Math.max(0, ne - c.dur);
    // vertical: move to another row of the same kind (or a fresh one)
    const r = this.content.getBoundingClientRect();
    const y = cy - r.top;
    const hit = this.rowMap.find((m) => y >= m.top && y < m.top + m.h);
    let target = f.track;
    if (hit && hit.tr !== f.track && hit.tr.kind === f.track.kind) target = hit.tr;
    const free = (tr) => tr.items.every((x) => x.id === c.id || clipEnd(x) <= c.start + 1e-6 || x.start >= clipEnd(c) - 1e-6);
    if (!free(target)) target = trackFor(p, f.track.kind, c.start, c.dur, c.id);
    if (target !== f.track) {
      f.track.items.splice(f.index, 1);
      target.items.push(c);
    }
    sortItems(target);
    this.ed.refresh({ timeline: true, quick: true });
  }

  dropMain(d) {
    const p = this.ed.p, f = findClip(p, d.id);
    if (!f) return;
    f.track.items.splice(f.index, 1);
    f.track.items.splice(d.target, 0, f.clip);
    layoutMain(p);
  }
}

const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

export const I = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  trans: '<path d="M4 6l7 6-7 6zM20 6l-7 6 7 6z"/>',
  sound: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  muted: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  hidden: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.2 6.3A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 4.2-1"/>',
};
