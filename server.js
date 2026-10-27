// Wisp RBI gateway: serves the control UI, the isolation runtime (Scramjet +
// bare-mux + epoxy WASM transport), and the Wisp binary WebSocket multiplexer.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const WISP_PATH = "/wisp/";

// Multiplexer policy. Private/loopback targets stay blocked so the gateway
// can't be used to reach the host's own network.
logging.set_level(logging[process.env.WISP_LOG || "WARN"]);
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_udp_streams = false;
wisp.options.stream_limit_total = Number(process.env.WISP_STREAM_LIMIT || 256);
wisp.options.wisp_motd = process.env.WISP_MOTD || "wisp.boety.fun gateway";
wisp.options.parse_real_ip_from = ["127.0.0.1", "::1"];

const stats = { started: Date.now(), sessions: 0, totalSessions: 0 };

const app = express();
app.disable("x-powered-by");

const noCache = { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") };
app.use("/scram/", express.static(scramjetPath, noCache));
app.use("/baremux/", express.static(baremuxPath, noCache));
app.use("/epoxy/", express.static(epoxyPath, noCache));

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round((Date.now() - stats.started) / 1000),
    sessions: stats.sessions,
    totalSessions: stats.totalSessions,
    wispPath: WISP_PATH,
    motd: wisp.options.wisp_motd,
    streamLimit: wisp.options.stream_limit_total,
    node: process.version,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  });
});

app.use(express.static(join(__dirname, "public"), noCache));
app.use((_req, res) => res.status(404).sendFile(join(__dirname, "public", "index.html")));

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith(WISP_PATH)) return socket.end();
  stats.sessions++;
  stats.totalSessions++;
  socket.once("close", () => stats.sessions--);
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(`wisp gateway listening on http://${HOST}:${PORT} (wisp at ${WISP_PATH})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
