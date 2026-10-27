// Recipe extraction: fetch a page (public internet only) and pull out the
// recipe from schema.org JSON-LD, microdata, or common recipe-plugin markup.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import * as cheerio from "cheerio";

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ───────── Safe fetch ─────────
// Only public addresses: the parser must not become a way into the VPS's
// own network (loopback, private ranges, cloud metadata, ...).
const blocked = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2002::", 16]]) blocked.addSubnet(a, p, "ipv6");

function isPublic(ip) {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4) return !blocked.check(v4, "ipv4");
  return !blocked.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => !isPublic(a.address))) {
      return cb(Object.assign(new Error("That address isn't on the public internet"), { code: "EBLOCKED" }));
    }
    if (options?.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

export class FetchError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function decode(res) {
  const enc = (res.headers["content-encoding"] || "").toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

export function fetchPage(rawUrl, redirects = 5) {
  let url;
  try { url = new URL(rawUrl); } catch { return Promise.reject(new FetchError("That doesn't look like a web address", 400)); }
  if (!/^https?:$/.test(url.protocol)) return Promise.reject(new FetchError("Only http and https links are supported", 400));
  if (url.port && !["80", "443"].includes(url.port)) return Promise.reject(new FetchError("Only standard web ports are supported", 400));
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && !isPublic(url.hostname.replace(/^\[|\]$/g, ""))) {
    return Promise.reject(new FetchError("That address isn't on the public internet", 400));
  }

  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, {
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new FetchError("Too many redirects"));
        return resolve(fetchPage(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode === 403 || res.statusCode === 402 || res.statusCode === 429) {
        res.resume();
        return reject(new FetchError(`${url.hostname} blocked the request (${res.statusCode}). Some sites refuse automated readers.`));
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new FetchError(`${url.hostname} answered ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      const body = decode(res);
      body.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); reject(new FetchError("That page is too large")); }
        else chunks.push(c);
      });
      body.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ url: url.href, body: buf, type: res.headers["content-type"] || "", html: buf.toString("utf8") });
      });
      body.on("error", () => reject(new FetchError("Couldn't decode the page")));
    });
    req.on("timeout", () => req.destroy(new FetchError(`${url.hostname} took too long to respond`, 504)));
    req.on("error", (err) => reject(err instanceof FetchError ? err
      : new FetchError(err.code === "EBLOCKED" ? err.message : `Couldn't reach ${url.hostname}`, err.code === "EBLOCKED" ? 400 : 502)));
  });
}

// ───────── Text helpers ─────────
const $text = cheerio.load("");
function clean(s) {
  if (s == null) return "";
  let t = String(s);
  // JSON-LD strings often carry HTML and entities.
  if (/[<&]/.test(t)) t = $text(`<div>${t.replace(/<br\s*\/?>/gi, "\n")}</div>`).text();
  return t.replace(/[   ]/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/▢/g, "").trim();
}
const oneLine = (s) => clean(s).replace(/\n+/g, " ");
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const typeIs = (o, t) => asArray(o?.["@type"]).some((x) => String(x).toLowerCase() === t.toLowerCase());

export function formatDuration(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^P(?:(\d+)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+)S)?$/i);
  if (!m) return oneLine(iso) || null;
  let mins = Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) + (+m[4] || 0) / 60);
  if (!mins) return null;
  const d = Math.floor(mins / 1440); mins %= 1440;
  const h = Math.floor(mins / 60); mins %= 60;
  return [d && `${d} day${d > 1 ? "s" : ""}`, h && `${h} hr`, mins && `${mins} min`].filter(Boolean).join(" ");
}

function pickYield(v) {
  const all = asArray(v).map(oneLine).filter(Boolean);
  if (!all.length) return null;
  // Prefer the most descriptive form ("14 oz" over "14", "4 servings" over "4").
  return all.sort((a, b) => /[a-z]/i.test(b) - /[a-z]/i.test(a) || b.length - a.length)[0];
}

const imageUrls = (v) => asArray(v).map((img) => (typeof img === "string" ? img : img?.url || img?.contentUrl)).filter(Boolean);

// Prefer a large photo: skip candidates whose URL advertises a small size
// (e.g. "?fit=225,225", "-300x200.jpg").
function bestImage(candidates) {
  const small = (u) => {
    const m = decodeURIComponent(u).match(/(?:fit=|resize=|-)(\d{2,4})[x,](\d{2,4})/i);
    return m && +m[1] < 600;
  };
  return candidates.find((u) => !small(u)) || candidates[0] || null;
}

// WP Recipe Maker shows ingredient notes in parentheses via CSS only.
function wprmIngredientText($, li) {
  const el = $(li).clone();
  el.find(".wprm-checkbox-container, .sr-only").remove();
  el.find(".wprm-recipe-ingredient-notes").each((_, n) => {
    const t = oneLine($(n).text());
    $(n).text(t && !/^[(,]/.test(t) ? `(${t})` : t);
  });
  return oneLine(el.text());
}

// Authors are often {"@id": ...} references to a Person elsewhere in @graph.
function pickAuthor(v, byId = {}) {
  const names = asArray(v).map((a) => (typeof a === "string" ? a : a?.name || byId[a?.["@id"]]?.name)).filter(Boolean).map(oneLine);
  return names.join(", ") || null;
}

// ───────── JSON-LD ─────────
function findRecipeNode(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipeNode(n, depth + 1); if (r) return r; }
    return null;
  }
  if (typeIs(node, "Recipe")) return node;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipeNode(node[key], depth + 1);
    if (r) return r;
  }
  return null;
}

function instructionGroups(raw) {
  const groups = [];
  const current = () => groups.at(-1) || (groups.push({ name: "", steps: [] }), groups.at(-1));
  const addText = (t) => {
    // Some sites put every step in one string separated by newlines.
    for (const line of clean(t).split(/\n+/)) {
      const s = line.replace(/^\s*(step\s*)?\d+[.):]\s+/i, "").trim();
      if (s) current().steps.push(s);
    }
  };
  const walk = (item) => {
    if (item == null) return;
    if (typeof item === "string") return addText(item);
    if (Array.isArray(item)) return item.forEach(walk);
    if (typeIs(item, "HowToSection")) {
      groups.push({ name: oneLine(item.name), steps: [] });
      walk(item.itemListElement);
      return;
    }
    if (item.itemListElement) return walk(item.itemListElement);
    addText(item.text || item.name || item.description || "");
  };
  walk(raw);
  return groups.filter((g) => g.steps.length);
}

function fromJsonLd($) {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data;
    const raw = $(el).text().trim();
    try { data = JSON.parse(raw); }
    catch {
      // Stray control characters in otherwise-valid JSON are common.
      try { data = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; }
    }
    const r = findRecipeNode(data);
    if (!r) continue;
    const byId = {};
    for (const n of asArray(data["@graph"] || data)) if (n?.["@id"]) byId[n["@id"]] = n;
    return {
      title: oneLine(r.name),
      description: oneLine(r.description),
      images: imageUrls(r.image),
      author: pickAuthor(r.author, byId),
      yield: pickYield(r.recipeYield || r.yield),
      times: { prep: formatDuration(r.prepTime), cook: formatDuration(r.cookTime), total: formatDuration(r.totalTime) },
      ingredientGroups: [{ name: "", items: asArray(r.recipeIngredient || r.ingredients).map(oneLine).filter(Boolean) }],
      instructionGroups: instructionGroups(r.recipeInstructions),
      category: asArray(r.recipeCategory).map(oneLine).filter(Boolean).join(", ") || null,
      cuisine: asArray(r.recipeCuisine).map(oneLine).filter(Boolean).join(", ") || null,
      calories: oneLine(r.nutrition?.calories) || null,
    };
  }
  return null;
}

// ───────── HTML (plugins, microdata, headings) ─────────
const listText = ($, els) => els.toArray().map((li) => oneLine($(li).text())).filter(Boolean);

// WP Recipe Maker and Tasty Recipes mark up ingredient groups, which
// JSON-LD flattens away; prefer their grouping when present.
function pluginIngredientGroups($) {
  const wprm = $(".wprm-recipe-ingredient-group");
  if (wprm.length) {
    return wprm.toArray().map((g) => ({
      name: oneLine($(g).find(".wprm-recipe-group-name").first().text()),
      items: $(g).find("li.wprm-recipe-ingredient").toArray().map((li) => wprmIngredientText($, li)).filter(Boolean),
    })).filter((g) => g.items.length);
  }
  const tasty = $(".tasty-recipes-ingredients, .tasty-recipes-ingredients-body").first();
  if (tasty.length) {
    const groups = [];
    tasty.find("h3, h4, ul").each((_, el) => {
      if (el.tagName === "ul") {
        if (!groups.length) groups.push({ name: "", items: [] });
        groups.at(-1).items.push(...listText($, $(el).children("li")));
      } else groups.push({ name: oneLine($(el).text()), items: [] });
    });
    return groups.filter((g) => g.items.length);
  }
  return null;
}

function pluginInstructionGroups($) {
  const wprm = $(".wprm-recipe-instruction-group");
  if (wprm.length) {
    return wprm.toArray().map((g) => ({
      name: oneLine($(g).find(".wprm-recipe-group-name").first().text()),
      steps: listText($, $(g).find(".wprm-recipe-instruction-text")),
    })).filter((g) => g.steps.length);
  }
  return null;
}

function pluginNotes($) {
  const box = $(".wprm-recipe-notes, .tasty-recipes-notes-body, .tasty-recipes-notes").first();
  if (!box.length) return [];
  const items = box.find("li, p").toArray().map((el) => oneLine($(el).text())).filter(Boolean);
  return items.length ? items : clean(box.text()).split(/\n+/).filter(Boolean);
}

function fromMicrodata($) {
  const scope = $('[itemtype*="schema.org/Recipe"]').first();
  if (!scope.length) return null;
  const prop = (p) => scope.find(`[itemprop="${p}"]`);
  const items = listText($, prop("recipeIngredient").add(prop("ingredients")));
  const steps = prop("recipeInstructions").toArray().flatMap((el) => {
    const lis = $(el).find("li");
    return lis.length ? listText($, lis) : clean($(el).text()).split(/\n+/);
  }).filter(Boolean);
  if (!items.length && !steps.length) return null;
  const dur = (p) => formatDuration(prop(p).attr("content") || prop(p).attr("datetime"));
  return {
    title: oneLine(prop("name").first().text()),
    images: [prop("image").attr("src") || prop("image").attr("content")].filter(Boolean),
    yield: oneLine(prop("recipeYield").first().text()) || null,
    times: { prep: dur("prepTime"), cook: dur("cookTime"), total: dur("totalTime") },
    ingredientGroups: [{ name: "", items }],
    instructionGroups: [{ name: "", steps }],
  };
}

// Last resort: an "Ingredients" heading followed by a list, likewise for steps.
function fromHeadings($) {
  const after = (re) => {
    const h = $("h1,h2,h3,h4,h5,strong").filter((_, el) => re.test($(el).text().trim())).first();
    if (!h.length) return [];
    const block = h.closest("h1,h2,h3,h4,h5,p").length ? h.closest("h1,h2,h3,h4,h5,p") : h;
    const list = block.nextAll("ul,ol").first();
    return list.length ? listText($, list.children("li")) : [];
  };
  const items = after(/^ingredients:?$/i);
  const steps = after(/^(instructions|directions|method|preparation|steps):?$/i);
  if (!items.length || !steps.length) return null;
  return { ingredientGroups: [{ name: "", items }], instructionGroups: [{ name: "", steps }] };
}

export function parseRecipe(html, pageUrl) {
  const $ = cheerio.load(html);
  const base = fromJsonLd($) || fromMicrodata($) || fromHeadings($);
  if (!base) return null;

  const r = {
    title: "", description: "", images: [], author: null, yield: null,
    times: { prep: null, cook: null, total: null }, category: null, cuisine: null, calories: null,
    ingredientGroups: [], instructionGroups: [], notes: [], ...base,
  };
  const pIng = pluginIngredientGroups($);
  if (pIng?.length) r.ingredientGroups = pIng;
  const pSteps = pluginInstructionGroups($);
  if (pSteps?.length && pSteps.length > 1) r.instructionGroups = pSteps;
  r.notes = pluginNotes($);

  r.title ||= oneLine($('meta[property="og:title"]').attr("content") || $("title").text());
  r.description ||= oneLine($('meta[name="description"]').attr("content") || "");
  const og = $('meta[property="og:image"]').attr("content");
  const abs = [og, ...r.images].filter(Boolean).map((u) => { try { return new URL(u, pageUrl).href; } catch { return null; } }).filter(Boolean);
  r.image = bestImage(abs);
  delete r.images;
  // A lone group called "Ingredients"/"Instructions" adds nothing.
  for (const g of [...r.ingredientGroups, ...r.instructionGroups]) {
    if (/^(ingredients|instructions|directions|method)$/i.test(g.name)) g.name = "";
  }

  const count = r.ingredientGroups.reduce((n, g) => n + g.items.length, 0) + r.instructionGroups.reduce((n, g) => n + g.steps.length, 0);
  if (!count) return null;

  const host = new URL(pageUrl).hostname.replace(/^www\./, "");
  r.source = { url: pageUrl, site: oneLine($('meta[property="og:site_name"]').attr("content") || "") || host, host };
  return r;
}

// ───────── Cached entry point ─────────
const cache = new Map();
const TTL = 6 * 3600_000;

export async function getRecipe(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.recipe;
  const page = await fetchPage(url);
  const recipe = parseRecipe(page.html, page.url);
  if (!recipe) throw new FetchError("Couldn't find a recipe on that page", 422);
  cache.set(url, { at: Date.now(), recipe });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return recipe;
}
