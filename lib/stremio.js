// Relay to the Stremio streaming server on this host (deploy/stremio-server.service),
// for signed-in users only. The isolated browser's service worker sends
// Stremio Web's default server address (http://127.0.0.1:11470) here, so
// torrents and debrid links get transcoded to HLS that iPad Safari can play.
import { request } from "node:http";

export const STREMIO_PATH = "/stremio-server";
const HOST = process.env.STREMIO_HOST || "127.0.0.1";
const PORT = Number(process.env.STREMIO_PORT || 11470);

// Hop-by-hop headers, plus the session cookie, which the streaming server has no use for.
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "upgrade", "proxy-connection", "te", "trailer", "cookie", "authorization"]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "trailer", "set-cookie", "cache-control"]);

const pick = (headers, drop) => Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())));

export function stremioProxy(req, res) {
  const upstream = request({
    host: HOST,
    port: PORT,
    method: req.method,
    path: req.url, // already relative to STREMIO_PATH
    headers: { ...pick(req.headers, DROP_REQUEST), host: `${HOST}:${PORT}` },
  }, (up) => {
    // Streams are per-user and huge: keep them out of Cloudflare's cache.
    res.writeHead(up.statusCode, { ...pick(up.headers, DROP_RESPONSE), "cache-control": "private, no-store" });
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    if (res.headersSent) return res.destroy(err);
    res.status(502).json({ error: "The Stremio streaming server isn't running on the gateway" });
  });
  // The player cancels requests constantly while seeking; stop the upstream too.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}
