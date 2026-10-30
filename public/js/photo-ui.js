// Photos: small widget kit (sliders, panels, colour wheels, curve editor, histogram).

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, val] of Object.entries(v)) { if (p.startsWith("--")) el.style.setProperty(p, val); else el.style[p] = val; }
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

export const svgIcon = (d, size) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  if (size) { s.style.width = size + "px"; s.style.height = size + "px"; }
  s.innerHTML = d;
  return s;
};

const fmtNum = (v, step) => {
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const s = (+v).toFixed(dec);
  return +v > 0 && dec > 0 ? "+" + s : s;
};

/**
 * Lightroom-style slider. Double-click the label (or track) to reset; the value
 * box accepts typed numbers; arrow keys nudge.
 */
export function slider(o) {
  const step = o.step ?? 1;
  const fmt = o.fmt || ((v) => (o.signed === false ? (+v).toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2) : fmtNum(v, step)));
  const range = h("input", { type: "range", min: o.min, max: o.max, step, "aria-label": o.label });
  const num = h("input", { class: "ps-num", type: "text", inputmode: "decimal", "aria-label": o.label + " value" });
  const lab = h("label", { class: "ps-lab", title: "Double-click to reset" }, o.label);
  const row = h("div", { class: "ps-slider" + (o.class ? " " + o.class : "") }, h("div", { class: "ps-row" }, lab, num), range);
  if (o.gradient) range.style.setProperty("--track", o.gradient);
  let cur = o.def ?? 0;
  let dragging = false;
  const show = (v) => {
    cur = v;
    range.value = v;
    if (document.activeElement !== num) num.value = fmt(v);
    const z = (0 - o.min) / (o.max - o.min);
    const p = (v - o.min) / (o.max - o.min);
    range.style.setProperty("--fill-a", `${Math.min(z, p) * 100}%`);
    range.style.setProperty("--fill-b", `${Math.max(z, p) * 100}%`);
    row.classList.toggle("changed", v !== (o.def ?? 0));
  };
  const commit = (v, label) => o.onCommit?.(v, label);
  range.addEventListener("input", () => { dragging = true; show(+range.value); o.onInput?.(+range.value); });
  range.addEventListener("change", () => { dragging = false; commit(+range.value); });
  range.addEventListener("pointerup", () => { if (dragging) { dragging = false; commit(+range.value); } });
  num.addEventListener("change", () => {
    const v = Math.min(o.max, Math.max(o.min, parseFloat(num.value.replace(",", "."))));
    if (Number.isFinite(v)) { show(v); o.onInput?.(v); commit(v); } else show(cur);
  });
  num.addEventListener("keydown", (e) => {
    if (e.key === "Enter") num.blur();
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const v = Math.min(o.max, Math.max(o.min, cur + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
      show(v); o.onInput?.(v); commit(v);
    }
  });
  num.addEventListener("focus", () => num.select());
  num.addEventListener("blur", () => { num.value = fmt(cur); });
  const reset = (e) => {
    if (e.shiftKey && o.onAuto) return o.onAuto();
    const v = o.def ?? 0;
    show(v); o.onInput?.(v); commit(v, "Reset " + o.label);
  };
  lab.addEventListener("dblclick", reset);
  range.addEventListener("dblclick", reset);
  // Drag on the label to scrub, like a desktop editor.
  let sx = null, sv = 0;
  lab.addEventListener("pointerdown", (e) => { sx = e.clientX; sv = cur; lab.setPointerCapture(e.pointerId); });
  lab.addEventListener("pointermove", (e) => {
    if (sx === null || Math.abs(e.clientX - sx) < 3) return;
    dragging = true;
    const v = Math.min(o.max, Math.max(o.min, Math.round((sv + (e.clientX - sx) / 200 * (o.max - o.min)) / step) * step));
    show(v); o.onInput?.(v);
  });
  lab.addEventListener("pointerup", () => { if (dragging) commit(cur); dragging = false; sx = null; });
  show(cur);
  return { el: row, set: show, get: () => cur, key: o.key };
}

export function panel(title, { open = true, onReset, id } = {}) {
  const body = h("div", { class: "ps-panel-body" });
  const head = h("button", { class: "ps-panel-head", type: "button", "aria-expanded": open },
    h("span", {}, title),
    svgIcon('<path d="M6 9l6 6 6-6"/>', 16));
  const el = h("section", { class: "ps-panel" + (open ? " open" : ""), "data-panel": id || title }, head, body);
  head.addEventListener("click", (e) => {
    if (e.target.closest(".ps-reset")) return;
    el.classList.toggle("open");
    head.setAttribute("aria-expanded", el.classList.contains("open"));
  });
  if (onReset) {
    const r = h("span", { class: "ps-reset", title: "Reset " + title, role: "button" }, "Reset");
    r.addEventListener("click", onReset);
    head.insertBefore(r, head.lastChild);
  }
  return { el, body, head };
}

export function segmented(options, value, onChange, cls = "") {
  const el = h("div", { class: "ps-seg " + cls, role: "group" });
  const btns = options.map(([v, label, title]) => {
    const b = h("button", { type: "button", "data-v": v, title: title || label }, label);
    b.addEventListener("click", () => onChange(v));
    el.append(b);
    return b;
  });
  const set = (v) => btns.forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));
  set(value);
  return { el, set };
}

export function selectBox(options, value, onChange, attrs = {}) {
  const el = h("select", { class: "ps-select", ...attrs });
  for (const o of options) {
    if (o.group) {
      const g = h("optgroup", { label: o.group });
      for (const [v, l] of o.items) g.append(h("option", { value: v }, l));
      el.append(g);
    } else el.append(h("option", { value: o[0] }, o[1]));
  }
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return { el, set: (v) => { el.value = v; } };
}

export function hueGradient() {
  return "linear-gradient(90deg,#f33,#f93,#ee3,#3d3,#3dd,#36f,#93f,#f3c,#f33)";
}

/** Colour-grading wheel: drag to choose hue (angle) and saturation (radius). */
export function colorWheel({ size = 120, onInput, onCommit }) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const c = h("canvas", { class: "ps-wheel", width: size * dpr, height: size * dpr, style: { width: size + "px", height: size + "px" } });
  const ctx = c.getContext("2d");
  const r = size * dpr / 2;
  const img = ctx.createImageData(size * dpr, size * dpr);
  for (let y = 0; y < size * dpr; y++) {
    for (let x = 0; x < size * dpr; x++) {
      const dx = x - r, dy = y - r, d = Math.hypot(dx, dy) / r;
      const o = (y * size * dpr + x) * 4;
      if (d > 1) { img.data[o + 3] = 0; continue; }
      const hue = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
      const [R, G, B] = hsv2rgb(hue, d * 0.85, 0.82);
      img.data.set([R, G, B, 255], o);
    }
  }
  let hv = 0, sv = 0;
  const draw = () => {
    ctx.putImageData(img, 0, 0);
    const a = hv * Math.PI / 180, d = sv / 100 * r;
    const px = r + Math.cos(a) * d, py = r - Math.sin(a) * d;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = "#fff";
    ctx.beginPath(); ctx.arc(px, py, 5 * dpr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,.5)";
    ctx.beginPath(); ctx.arc(px, py, 6.5 * dpr, 0, Math.PI * 2); ctx.stroke();
  };
  const pick = (e) => {
    const b = c.getBoundingClientRect();
    const dx = e.clientX - b.left - b.width / 2, dy = e.clientY - b.top - b.height / 2;
    let d = Math.min(1, Math.hypot(dx, dy) / (b.width / 2));
    if (e.shiftKey) d = sv / 100; // shift keeps saturation, adjusts hue only
    hv = Math.round((Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360);
    sv = Math.round(d * 100);
    draw();
    onInput?.(hv, sv);
  };
  let down = false;
  c.addEventListener("pointerdown", (e) => { down = true; c.setPointerCapture(e.pointerId); pick(e); });
  c.addEventListener("pointermove", (e) => { if (down) pick(e); });
  c.addEventListener("pointerup", () => { if (down) { down = false; onCommit?.(hv, sv); } });
  c.addEventListener("dblclick", () => { hv = 0; sv = 0; draw(); onInput?.(0, 0); onCommit?.(0, 0); });
  draw();
  return { el: c, set(hh, ss) { hv = hh; sv = ss; draw(); } };
}

export function hsv2rgb(hh, s, v) {
  const f = (n) => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

/** Point-curve editor. Click to add, drag to move, drag off the side or double-click to delete. */
export function curveEditor({ size = 240, onInput, onCommit }) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const c = h("canvas", { class: "ps-curve", width: size * dpr, height: size * dpr, style: { width: "100%", aspectRatio: "1" } });
  const ctx = c.getContext("2d");
  let pts = [[0, 0], [1, 1]], lut = null, hist = null, channel = "rgb", param = null, drag = -1;
  const W = size * dpr;
  const colors = { rgb: "#e8ebf1", r: "#ff5a5a", g: "#46d160", b: "#4a8dff" };
  const draw = () => {
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = "#1a1d22"; ctx.fillRect(0, 0, W, W);
    if (hist) {
      ctx.fillStyle = "rgba(255,255,255,.07)";
      const mx = Math.max(...hist.slice(2, 254)) || 1;
      for (let i = 0; i < 256; i++) {
        const hh = Math.min(1, hist[i] / mx) * W * 0.9;
        ctx.fillRect(i / 256 * W, W - hh, W / 256 + 1, hh);
      }
    }
    ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * W / 4, 0); ctx.lineTo(i * W / 4, W); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * W / 4); ctx.lineTo(W, i * W / 4); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,.15)";
    ctx.beginPath(); ctx.moveTo(0, W); ctx.lineTo(W, 0); ctx.stroke();
    if (lut) {
      ctx.strokeStyle = colors[channel]; ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      for (let i = 0; i < lut.length; i += 4) {
        const x = i / (lut.length - 1) * W, y = (1 - lut[i]) * W;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.lineTo(W, (1 - lut[lut.length - 1]) * W);
      ctx.stroke();
    }
    if (!param) {
      for (const [x, y] of pts) {
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(x * W, (1 - y) * W, 4.5 * dpr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  };
  const pos = (e) => {
    const b = c.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, 1 - (e.clientY - b.top) / b.height)), (e.clientX - b.left) / b.width];
  };
  c.addEventListener("pointerdown", (e) => {
    if (param) return param.down?.(e, pos(e));
    const [x, y] = pos(e);
    const b = c.getBoundingClientRect();
    const tol = 14 / b.width;
    drag = pts.findIndex(([px, py]) => Math.abs(px - x) < tol && Math.abs(py - y) < tol);
    if (drag < 0) {
      pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]);
      drag = pts.findIndex((p) => p[0] === x && p[1] === y);
      onInput?.(pts.map((p) => [...p]));
    }
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener("pointermove", (e) => {
    if (param) return param.move?.(e, pos(e));
    if (drag < 0) return;
    const [x, y, rawx] = pos(e);
    const end = drag === 0 || drag === pts.length - 1;
    const lo = drag > 0 ? pts[drag - 1][0] + 0.01 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 0.01 : 1;
    if (!end && (rawx < -0.08 || rawx > 1.08)) { pts.splice(drag, 1); drag = -1; onInput?.(pts.map((p) => [...p])); return; }
    pts[drag] = [end ? (drag === 0 ? Math.min(x, hi) : Math.max(x, lo)) : Math.min(hi, Math.max(lo, x)), y];
    onInput?.(pts.map((p) => [...p]));
  });
  c.addEventListener("pointerup", (e) => {
    if (param) return param.up?.(e);
    if (drag !== -1 || true) onCommit?.(pts.map((p) => [...p]));
    drag = -1;
  });
  c.addEventListener("dblclick", (e) => {
    if (param) return;
    const [x, y] = pos(e);
    const i = pts.findIndex(([px, py]) => Math.abs(px - x) < 0.05 && Math.abs(py - y) < 0.05);
    if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); onInput?.(pts.map((p) => [...p])); onCommit?.(pts.map((p) => [...p])); }
  });
  return {
    el: c,
    set(p, l, ch, histo, paramMode) { pts = p.map((q) => [...q]); lut = l; channel = ch; hist = histo; param = paramMode || null; draw(); },
  };
}

/** Histogram with RGB overlap and clipping triangles. Returns hit-testing zone for drag-to-adjust. */
export function drawHistogram(canvas, hist, clip = {}) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth * dpr, hh = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, hh);
  ctx.fillStyle = "#15171b"; ctx.fillRect(0, 0, w, hh);
  if (!hist) return;
  let mx = 1;
  for (let c = 0; c < 3; c++) for (let i = 2; i < 254; i++) mx = Math.max(mx, hist[c * 256 + i]);
  mx = Math.sqrt(mx);
  ctx.globalCompositeOperation = "lighter";
  const col = ["rgba(230,60,60,.75)", "rgba(60,200,80,.7)", "rgba(70,110,255,.8)"];
  for (let c = 0; c < 3; c++) {
    ctx.fillStyle = col[c];
    ctx.beginPath(); ctx.moveTo(0, hh);
    for (let i = 0; i < 256; i++) ctx.lineTo(i / 255 * w, hh - Math.min(1, Math.sqrt(hist[c * 256 + i]) / mx) * hh * 0.94);
    ctx.lineTo(w, hh); ctx.closePath(); ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = "rgba(255,255,255,.07)";
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(i * w / 5, 0); ctx.lineTo(i * w / 5, hh); ctx.stroke(); }
  const tri = (x, on, color, left) => {
    ctx.fillStyle = on ? color : "rgba(255,255,255,.25)";
    ctx.beginPath();
    const s = 7 * dpr;
    if (left) { ctx.moveTo(x, 2 * dpr); ctx.lineTo(x + s, 2 * dpr); ctx.lineTo(x, 2 * dpr + s); }
    else { ctx.moveTo(x, 2 * dpr); ctx.lineTo(x - s, 2 * dpr); ctx.lineTo(x, 2 * dpr + s); }
    ctx.fill();
  };
  tri(2 * dpr, clip.shadowsOn || clip.shadows, clip.shadows ? "#4a8dff" : "#ddd", true);
  tri(w - 2 * dpr, clip.highlightsOn || clip.highlights, clip.highlights ? "#ff5a5a" : "#ddd", false);
  if (clip.zone != null) {
    const z = [[0, 0.07], [0.07, 0.3], [0.3, 0.7], [0.7, 0.93], [0.93, 1]][clip.zone];
    ctx.fillStyle = "rgba(255,255,255,.08)";
    ctx.fillRect(z[0] * w, 0, (z[1] - z[0]) * w, hh);
  }
}
