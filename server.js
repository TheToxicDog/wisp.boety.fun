// Wisp RBI gateway: serves the control UI, the isolation runtime (Scramjet +
// bare-mux + epoxy WASM transport), and the Wisp binary WebSocket multiplexer.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { verifyAssets } from "./scripts/assets.js";
import { DATA_DIR } from "./lib/store.js";
import { authRouter, requireUser, requirePage, authorizeUpgrade, ensureSetupCode, userFromRequest, flush } from "./lib/auth.js";
import { getRecipe, fetchPage } from "./lib/recipe.js";
import { renderRecipePdf, pdfFilename } from "./lib/recipe-pdf.js";
import { chatRouter, chatUpgrade } from "./lib/chat.js";
import { loadPages } from "./lib/pages.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const WISP_PATH = "/wisp/";
const CHAT_PATH = "/chat/";

const missing = verifyAssets();
if (missing.length) {
  console.error(`Runtime assets missing from public/ (run \`npm install\` or \`npm run postinstall\`):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

// Multiplexer policy. Private/loopback targets stay blocked so the gateway
// can't be used to reach the host's own network.
logging.set_level(logging[process.env.WISP_LOG || "WARN"]);
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_udp_streams = process.env.WISP_ALLOW_UDP !== "false";
wisp.options.stream_limit_total = Number(process.env.WISP_STREAM_LIMIT || 256);
wisp.options.wisp_motd = process.env.WISP_MOTD || "wisp.boety.fun gateway";
wisp.options.parse_real_ip_from = ["127.0.0.1", "::1"];

const stats = { started: Date.now(), sessions: 0, totalSessions: 0 };

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback"); // Nginx on localhost sets X-Forwarded-Proto
ensureSetupCode();

app.use("/api", authRouter());
app.use("/api/chat", chatRouter());

// Public: which commit is live and how the last auto-deploy went.
app.get("/api/version", (_req, res) => {
  let deploy = null;
  try { deploy = JSON.parse(readFileSync(join(DATA_DIR, "deploy.json"), "utf8")); } catch {}
  res.set("Cache-Control", "no-store").json({ deploy, started: new Date(stats.started).toISOString() });
});

app.get("/api/status", requireUser, (req, res) => {
  // Cloudflare tags proxied requests; the ray id ends with the edge colo code.
  const ray = req.get("cf-ray");
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    uptime: Math.round((Date.now() - stats.started) / 1000),
    sessions: stats.sessions,
    totalSessions: stats.totalSessions,
    wispPath: WISP_PATH,
    motd: wisp.options.wisp_motd,
    streamLimit: wisp.options.stream_limit_total,
    udp: wisp.options.allow_udp_streams,
    edge: ray
      ? { provider: "Cloudflare", colo: ray.split("-")[1] || null, ray, country: req.get("cf-ipcountry") || null }
      : { provider: null },
    node: process.version,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  });
});

// ───────── Recipe reader ─────────
const sendError = (res, err) => res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong reading that page" });

app.get("/api/recipe", requireUser, async (req, res) => {
  try { res.json(await getRecipe(String(req.query.url || ""))); }
  catch (err) { sendError(res, err); }
});

// pdfkit embeds JPEG and PNG only; anything else is left out.
async function recipePhoto(url) {
  try {
    const { body } = await fetchPage(url);
    const jpeg = body[0] === 0xff && body[1] === 0xd8;
    const png = body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return jpeg || png ? body : null;
  } catch { return null; }
}

// The recipe's photo, relayed so the browser never contacts the recipe site.
app.get("/api/recipe/image", requireUser, async (req, res) => {
  try {
    const recipe = await getRecipe(String(req.query.url || ""));
    if (!recipe.image) return res.status(404).end();
    const { body, type } = await fetchPage(recipe.image);
    if (!/^image\/(jpeg|png|webp|gif|avif)/i.test(type)) return res.status(415).end();
    res.set({ "Content-Type": type, "Cache-Control": "private, max-age=86400" }).send(body);
  } catch { res.status(404).end(); }
});

app.get("/api/recipe/pdf", requireUser, async (req, res) => {
  try {
    const recipe = await getRecipe(String(req.query.url || ""));
    const photo = req.query.photo !== "0" && recipe.image ? await recipePhoto(recipe.image) : null;
    const pdf = await renderRecipePdf(recipe, photo);
    const name = pdfFilename(recipe);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `${req.query.download ? "attachment" : "inline"}; filename="${name}"`,
      "Cache-Control": "private, no-store",
    });
    res.send(pdf);
  } catch (err) { sendError(res, err); }
});

// wisp.boety.fun/https://site/recipe (or /site.com/recipe) opens the reader.
// Proxies may collapse "//" to "/", so accept either.
const recipeTarget = (originalUrl) => {
  const full = originalUrl.match(/^\/(https?):\/+(.+)$/i);
  if (full) return `${full[1].toLowerCase()}://${full[2]}`;
  const bare = originalUrl.match(/^\/((?:[a-z0-9-]+\.)+[a-z]{2,})(\/.*)?$/i);
  if (bare && !/\.(js|mjs|css|json|map|png|jpe?g|svg|ico|html|wasm|txt|webmanifest)$/i.test(bare[1])) return `https://${originalUrl.slice(1)}`;
  return null;
};
app.get(/^\/https?:\//i, requirePage, (req, res) => {
  res.redirect(302, `/#/recipes?u=${encodeURIComponent(recipeTarget(req.originalUrl))}`);
});

const noCache = (res) => res.setHeader("Cache-Control", "no-cache");
const pages = loadPages(__dirname);
const appShell = (_req, res) => { noCache(res); res.type("html").send(pages.app); };

app.get("/login", (req, res) => {
  const auth = userFromRequest(req);
  const next = String(req.query.next || "");
  if (auth && !auth.user.mustChangePassword) return res.redirect(302, /^\/(?![\/\\])/.test(next) ? next : "/");
  noCache(res);
  res.type("html").send(pages.login);
});
app.get(["/", "/index.html"], requirePage, appShell);

// Public static files: login page assets and the open-source runtime bundles.
app.use(express.static(join(__dirname, "public"), { index: false, setHeaders: noCache }));
app.get("/{*path}", requirePage, (req, res) => {
  const target = recipeTarget(req.originalUrl);
  if (target) return res.redirect(302, `/#/recipes?u=${encodeURIComponent(target)}`);
  appShell(req, res);
});

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith(CHAT_PATH)) return chatUpgrade(req, socket, head);
  if (!req.url.startsWith(WISP_PATH)) return socket.end();
  if (!authorizeUpgrade(req, socket)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  stats.sessions++;
  stats.totalSessions++;
  socket.once("close", () => stats.sessions--);
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(`wisp gateway listening on http://${HOST}:${PORT} (wisp at ${WISP_PATH})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flush(); // persist pending user/session/chat writes before exit
    process.exit(0);
  });
}
