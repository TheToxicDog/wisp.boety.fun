// Recipe reader: paste a link (or visit wisp.boety.fun/<link>) to get a
// clean ingredients + steps view, tick things off while cooking, export a PDF.
import { api } from "./api.js";
import { $, toast, escapeHtml, hue } from "./ui.js";

const RECENT_KEY = "wisp.recipes.recent.v1";
let current = null; // { url, recipe }
let loadingUrl = null;

function readRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}
function remember(url, r) {
  const list = [{ url, title: r.title, site: r.source.site, image: !!r.image }, ...readRecent().filter((x) => x.url !== url)].slice(0, 12);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

function normalizeUrl(input) {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^(https?:\/\/)?wisp\.boety\.fun\//i, ""); // pasted the whole shortcut
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { return new URL(s).href; } catch { return null; }
}

function setState(state) {
  $("#recipeEmpty").hidden = state !== "empty";
  $("#recipeLoading").hidden = state !== "loading";
  $("#recipeError").hidden = state !== "error";
  $("#recipe").hidden = state !== "recipe";
}

function renderRecent() {
  const list = readRecent();
  $("#recentLabel").hidden = !list.length;
  $("#recentList").innerHTML = list.map((x) => `
    <a class="recent" href="#/recipes?u=${encodeURIComponent(x.url)}" data-ui="recipes.recent.item">
      ${x.image ? `<img src="${imageSrc(x.url)}" alt="" loading="lazy">` : `<span class="ph" style="background:${hue(x.site || x.url)}">${escapeHtml((x.title || "?")[0])}</span>`}
      <span><b>${escapeHtml(x.title || x.url)}</b><small class="muted">${escapeHtml(x.site || "")}</small></span>
    </a>`).join("");
}

const imageSrc = (url) => `/api/recipe/image?url=${encodeURIComponent(url)}`;

function pdfHref() {
  const photo = $("#rPdfPhoto").checked ? "" : "&photo=0";
  return `/api/recipe/pdf?url=${encodeURIComponent(current.url)}${photo}`;
}

function render(url, r) {
  current = { url, recipe: r };
  const photo = $("#rPhoto");
  photo.hidden = !r.image;
  if (r.image) photo.src = imageSrc(url);
  photo.onerror = () => (photo.hidden = true);
  $("#rSite").textContent = r.source.site;
  $("#rTitle").textContent = r.title;
  $("#rAuthor").textContent = r.author ? `By ${r.author}` : "";
  $("#rDesc").textContent = r.description || "";
  $("#rFacts").innerHTML = [["Prep", r.times.prep], ["Cook", r.times.cook], ["Total", r.times.total], ["Yield", r.yield]]
    .filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");

  $("#rIngredients").innerHTML = r.ingredientGroups.map((g) => `
    ${g.name ? `<h4>${escapeHtml(g.name)}</h4>` : ""}
    <ul>${g.items.map((t) => `<li><span class="box"></span><span>${escapeHtml(t)}</span></li>`).join("")}</ul>`).join("");

  let n = 0;
  $("#rSteps").innerHTML = r.instructionGroups.map((g) => `
    ${g.name ? `<h4>${escapeHtml(g.name)}</h4>` : ""}
    <ol>${g.steps.map((t) => `<li><span class="num">${++n}</span><span>${escapeHtml(t)}</span></li>`).join("")}</ol>`).join("");

  $("#rNotesWrap").hidden = !r.notes?.length;
  $("#rNotes").innerHTML = (r.notes || []).map((t) => `<p>${escapeHtml(t)}</p>`).join("");

  $("#rPdf").href = pdfHref();
  $("#rSource").href = r.source.url;
  setState("recipe");
  $("#main .view:not([hidden]) .scroll")?.scrollTo({ top: 0 });
}

async function load(url) {
  if (current?.url === url) return setState("recipe");
  loadingUrl = url;
  $("#recipeUrl").value = url;
  setState("loading");
  try {
    const r = await api(`/api/recipe?url=${encodeURIComponent(url)}`);
    if (loadingUrl !== url) return;
    remember(url, r);
    render(url, r);
  } catch (err) {
    if (loadingUrl !== url) return;
    $("#recipeErrorMsg").textContent = err.message;
    setState("error");
  }
}

function plainText(r) {
  const lines = [r.title, r.source.url, ""];
  const facts = [["Prep", r.times.prep], ["Cook", r.times.cook], ["Total", r.times.total], ["Yield", r.yield]].filter(([, v]) => v);
  if (facts.length) lines.push(facts.map(([k, v]) => `${k}: ${v}`).join(" · "), "");
  lines.push("INGREDIENTS");
  for (const g of r.ingredientGroups) { if (g.name) lines.push(`${g.name}:`); g.items.forEach((t) => lines.push(`• ${t}`)); }
  lines.push("", "INSTRUCTIONS");
  let n = 0;
  for (const g of r.instructionGroups) { if (g.name) lines.push(`${g.name}:`); g.steps.forEach((t) => lines.push(`${++n}. ${t}`)); }
  if (r.notes?.length) lines.push("", "NOTES", ...r.notes);
  return lines.join("\n");
}

export function initRecipes() {
  $("#recipeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = normalizeUrl($("#recipeUrl").value);
    if (!url) return toast("That doesn't look like a link");
    $("#recipeUrl").blur();
    location.hash = `#/recipes?u=${encodeURIComponent(url)}`;
  });
  // Tap to tick off ingredients and steps while cooking.
  for (const id of ["#rIngredients", "#rSteps"]) {
    $(id).addEventListener("click", (e) => e.target.closest("li")?.classList.toggle("done"));
  }
  $("#rPdfPhoto").addEventListener("change", () => { if (current) $("#rPdf").href = pdfHref(); });
  $("#rCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(plainText(current.recipe)); toast("Recipe copied"); }
    catch { toast("Couldn't copy"); }
  });
}

export function showRecipes(visible, params) {
  if (!visible) return;
  const url = params.get("u");
  if (url) load(url);
  else { loadingUrl = null; current = null; $("#recipeUrl").value = ""; renderRecent(); setState("empty"); }
}
