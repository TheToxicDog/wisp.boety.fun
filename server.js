// Wisp RBI gateway: serves the control UI, the isolation runtime (Scramjet +
// bare-mux + epoxy WASM transport), and the Wisp binary WebSocket multiplexer.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { verifyAssets } from "./scripts/assets.js";
import { authRouter, requireUser, requirePage, authorizeUpgrade, ensureSetupCode, userFromRequest, flush } from "./lib/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const WISP_PATH = "/wisp/";

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

const noCache = (res) => res.setHeader("Cache-Control", "no-cache");
const appShell = (_req, res) => { noCache(res); res.sendFile(join(__dirname, "views", "app.html")); };

app.get("/login", (req, res) => {
  const auth = userFromRequest(req);
  if (auth && !auth.user.mustChangePassword) return res.redirect(302, "/");
  noCache(res);
  res.sendFile(join(__dirname, "public", "login.html"));
});
app.get(["/", "/index.html"], requirePage, appShell);

// Public static files: login page assets and the open-source runtime bundles.
app.use(express.static(join(__dirname, "public"), { index: false, setHeaders: noCache }));
app.get("/{*path}", requirePage, appShell);

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
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
    flush(); // persist pending user/session writes before exit
    process.exit(0);
  });
}
