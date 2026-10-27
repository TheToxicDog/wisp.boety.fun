// Printable recipe PDF: header with photo and timings, ingredients and
// steps in two columns that flow independently across pages, then notes.
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Inter (SIL OFL 1.1, assets/fonts/OFL.txt). TTF, not WOFF2: fontkit's
// subsetter crashes on some WOFF2 composite glyphs.
const fontDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
const FONTS = {
  regular: join(fontDir, "Inter_400Regular.ttf"),
  italic: join(fontDir, "Inter_400Regular_Italic.ttf"),
  medium: join(fontDir, "Inter_500Medium.ttf"),
  semibold: join(fontDir, "Inter_600SemiBold.ttf"),
  bold: join(fontDir, "Inter_700Bold.ttf"),
};
const glyphs = fontkit.openSync(FONTS.regular);

const C = { ink: "#1b1e24", muted: "#646b77", faint: "#9aa0aa", line: "#e4e2de", panel: "#f6f4f1", accent: "#b4532a" };
const PAGE = { size: "LETTER", margin: 54 };
const FOOTER_H = 30;

// Layout scale: 1 normally; slightly smaller when that keeps a recipe on
// one page. Set per render; building a document is synchronous.
let K = 1;
const S = (n) => n * K;

// Swap characters Inter can't draw (emoji, rare symbols) for close equivalents.
function safe(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 && ch !== "\n") continue;
    if (glyphs.hasGlyphForCodePoint(cp)) { out += ch; continue; }
    const alt = ch.normalize("NFKD").replace(/⁄/g, "/");
    out += [...alt].every((c) => glyphs.hasGlyphForCodePoint(c.codePointAt(0))) ? alt : "";
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

export function pdfFilename(recipe) {
  const slug = (recipe.title || "recipe").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60);
  return `${slug || "recipe"}.pdf`;
}

// A column that flows onto following pages, reusing pages that another
// column already created.
class Flow {
  constructor(doc, x, width, page, y) { Object.assign(this, { doc, x, width, page, y }); }
  get bottom() { return this.doc.page.height - PAGE.margin - FOOTER_H; }
  focus() { this.doc.switchToPage(this.page); }
  ensure(h) {
    this.focus();
    if (this.y + h <= this.bottom) return;
    this.page++;
    if (this.page >= this.doc.bufferedPageRange().count) this.doc.addPage();
    else this.doc.switchToPage(this.page);
    this.y = PAGE.margin;
  }
}

function heightOf(doc, font, size, text, width, opts = {}) {
  return doc.font(font).fontSize(size).heightOfString(text, { width, ...opts });
}

function sectionTitle(doc, flow, title, keepWith) {
  const h = S(26);
  flow.ensure(h + keepWith);
  doc.font("bold").fontSize(13).fillColor(C.ink).text(title, flow.x, flow.y, { width: flow.width, lineBreak: false });
  doc.moveTo(flow.x, flow.y + S(19)).lineTo(flow.x + 28, flow.y + S(19)).lineWidth(2).strokeColor(C.accent).stroke();
  flow.y += h + S(4);
}

function groupTitle(doc, flow, name, keepWith) {
  const text = safe(name).toUpperCase();
  const h = heightOf(doc, "semibold", 8.5, text, flow.width, { characterSpacing: 0.8 });
  flow.ensure(h + 6 + keepWith);
  doc.font("semibold").fontSize(8.5).fillColor(C.accent).text(text, flow.x, flow.y, { width: flow.width, characterSpacing: 0.8 });
  flow.y += h + 6;
}

function ingredients(doc, flow, groups) {
  const textX = 15, size = 10, gap = S(7);
  const itemH = (t) => heightOf(doc, "regular", size, t, flow.width - textX, { lineGap: 1.5 });
  const firstH = itemH(safe(groups[0]?.items[0] || ""));
  sectionTitle(doc, flow, "Ingredients", firstH);
  groups.forEach((g, gi) => {
    const items = g.items.map(safe).filter(Boolean);
    if (g.name) {
      if (gi) flow.y += 6;
      groupTitle(doc, flow, g.name, itemH(items[0] || ""));
    }
    for (const t of items) {
      const h = itemH(t);
      flow.ensure(h);
      doc.roundedRect(flow.x, flow.y + S(2.5), S(7.5), S(7.5), 1.5).lineWidth(0.8).strokeColor(C.faint).stroke();
      doc.font("regular").fontSize(size).fillColor(C.ink).text(t, flow.x + textX, flow.y, { width: flow.width - textX, lineGap: 1.5 });
      flow.y += h + gap;
    }
  });
}

function instructions(doc, flow, groups) {
  const textX = 26, size = 10.5, gap = S(11);
  const stepH = (t) => Math.max(S(17), heightOf(doc, "regular", size, t, flow.width - textX, { lineGap: 2.5 }));
  sectionTitle(doc, flow, "Instructions", stepH(safe(groups[0]?.steps[0] || "")));
  let n = 0;
  groups.forEach((g, gi) => {
    const steps = g.steps.map(safe).filter(Boolean);
    if (g.name) {
      if (gi) flow.y += 6;
      groupTitle(doc, flow, g.name, stepH(steps[0] || ""));
    }
    for (const t of steps) {
      const h = stepH(t);
      flow.ensure(h);
      n++;
      doc.circle(flow.x + 9, flow.y + S(7.5), S(9)).fill(C.accent);
      doc.font("semibold").fontSize(n > 9 ? 8 : 9).fillColor("#ffffff")
        .text(String(n), flow.x, flow.y + S(n > 9 ? 3.6 : 3), { width: 18, align: "center", lineBreak: false });
      doc.font("regular").fontSize(size).fillColor(C.ink).text(t, flow.x + textX, flow.y, { width: flow.width - textX, lineGap: 2.5 });
      flow.y += h + gap;
    }
  });
}

function notes(doc, flow, list) {
  const items = list.map(safe).filter(Boolean);
  if (!items.length) return;
  const noteH = (t) => heightOf(doc, "regular", 9.5, t, flow.width, { lineGap: 2 });
  flow.y += S(8);
  sectionTitle(doc, flow, "Notes", noteH(items[0]));
  for (const t of items) {
    const h = noteH(t);
    flow.ensure(h);
    doc.font("regular").fontSize(9.5).fillColor(C.muted).text(t, flow.x, flow.y, { width: flow.width, lineGap: 2 });
    flow.y += h + S(7);
  }
}

function header(doc, r, image) {
  const left = PAGE.margin, width = doc.page.width - PAGE.margin * 2;
  const imgSize = image ? S(168) : 0;
  const textW = image ? width - imgSize - 24 : width;
  let y = PAGE.margin;

  doc.font("semibold").fontSize(8.5).fillColor(C.accent)
    .text(safe(r.source.site).toUpperCase(), left, y, { width: textW, characterSpacing: 1.2, lineBreak: false, ellipsis: true });
  y += 17;
  const title = safe(r.title) || "Recipe";
  const titleSize = title.length > 60 ? 21 : 26;
  doc.font("bold").fontSize(titleSize).fillColor(C.ink).text(title, left, y, { width: textW, lineGap: 1 });
  y += doc.heightOfString(title, { width: textW, lineGap: 1 }) + 8;
  if (r.author) {
    doc.font("medium").fontSize(9.5).fillColor(C.muted).text(`By ${safe(r.author)}`, left, y, { width: textW });
    y += 16;
  }
  if (r.description) {
    const maxH = (image ? PAGE.margin + imgSize : y + 60) - y;
    if (maxH > 24) {
      doc.font("regular").fontSize(10).fillColor(C.muted)
        .text(safe(r.description), left, y, { width: textW, lineGap: 2, height: maxH, ellipsis: true });
      y += Math.min(maxH, doc.heightOfString(safe(r.description), { width: textW, lineGap: 2 })) + 4;
    }
  }

  if (image) {
    const x = left + width - imgSize;
    doc.save();
    doc.roundedRect(x, PAGE.margin, imgSize, imgSize, 10).clip();
    doc.image(image, x, PAGE.margin, { cover: [imgSize, imgSize], align: "center", valign: "center" });
    doc.restore();
    y = Math.max(y, PAGE.margin + imgSize);
  }

  // Timings / yield panel
  const facts = [["Prep", r.times?.prep], ["Cook", r.times?.cook], ["Total", r.times?.total], ["Yield", r.yield]]
    .filter(([, v]) => v).map(([k, v]) => [k, safe(v)]);
  y += S(16);
  if (facts.length) {
    const colW = width / facts.length;
    const valH = Math.max(...facts.map(([, v]) => heightOf(doc, "semibold", 11, v, colW - 24)));
    const boxH = valH + 34;
    doc.roundedRect(left, y, width, boxH, 8).fill(C.panel);
    facts.forEach(([k, v], i) => {
      const x = left + i * colW + 14;
      if (i) doc.moveTo(left + i * colW, y + 10).lineTo(left + i * colW, y + boxH - 10).lineWidth(0.6).strokeColor(C.line).stroke();
      doc.font("semibold").fontSize(7.5).fillColor(C.faint).text(k.toUpperCase(), x, y + 11, { width: colW - 24, characterSpacing: 0.8, lineBreak: false });
      doc.font("semibold").fontSize(11).fillColor(C.ink).text(v, x, y + 23, { width: colW - 24 });
    });
    y += boxH;
  }
  return y + S(24);
}

function footers(doc, r) {
  const { start, count } = doc.bufferedPageRange();
  const label = r.source.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // drawing inside the margin must not add a page
    const y = doc.page.height - PAGE.margin - 10;
    const w = doc.page.width - PAGE.margin * 2;
    doc.moveTo(PAGE.margin, y - 8).lineTo(PAGE.margin + w, y - 8).lineWidth(0.6).strokeColor(C.line).stroke();
    doc.font("regular").fontSize(8).fillColor(C.faint);
    doc.text(safe(label), PAGE.margin, y, { width: w - 80, lineBreak: false, ellipsis: true, link: r.source.url });
    doc.text(`Page ${i + 1} of ${count}`, PAGE.margin + w - 80, y, { width: 80, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
}

function build(r, image, scale) {
  K = scale;
  const doc = new PDFDocument({
    size: PAGE.size, margin: PAGE.margin, bufferPages: true,
    info: { Title: safe(r.title), Author: safe(r.author || r.source.site), Subject: r.source.url, Creator: "Wisp recipe reader" },
  });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
  const fontSize = doc.fontSize.bind(doc);
  doc.fontSize = (size) => fontSize(size * scale);

  let img = image;
  try { if (img) doc.openImage(img); } catch { img = null; }
  const top = header(doc, r, img);

  const width = doc.page.width - PAGE.margin * 2;
  const leftW = Math.round(width * 0.36), gutter = 28;
  const ing = new Flow(doc, PAGE.margin, leftW, 0, top);
  const steps = new Flow(doc, PAGE.margin + leftW + gutter, width - leftW - gutter, 0, top);
  ingredients(doc, ing, r.ingredientGroups.filter((g) => g.items.length));
  instructions(doc, steps, r.instructionGroups.filter((g) => g.steps.length));

  // Notes span the full width below whichever column ends last.
  const last = ing.page > steps.page || (ing.page === steps.page && ing.y > steps.y) ? ing : steps;
  notes(doc, new Flow(doc, PAGE.margin, width, last.page, last.y + 6), r.notes || []);

  return { doc, pages: doc.bufferedPageRange().count, recipePages: last.page + 1 };
}

// Resolves to a PDF Buffer. `image` is an optional JPEG/PNG Buffer.
export function renderRecipePdf(r, image) {
  let best = build(r, image, 1);
  // Nearly fits on one page? Tighten a little rather than spill a step (or
  // the whole thing) onto a second page. Notes may still continue overleaf.
  if (best.pages === 2) {
    const fits = best.recipePages === 2 ? (b) => b.recipePages === 1 : (b) => b.pages === 1;
    for (const scale of [0.93, 0.87]) {
      const tight = build(r, image, scale);
      if (fits(tight)) { best = tight; break; }
    }
  }
  K = 1;
  const { doc } = best;
  footers(doc, r);
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
