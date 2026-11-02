// Scramjet service worker: rewrites and relays every request made inside
// isolated frames; everything else passes straight through.
importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Stremio Web looks for its streaming server at http://127.0.0.1:11470 (its
// default). Inside an isolated frame that address would go to the Wisp relay,
// which refuses loopback, so send it to the streaming server on this gateway
// instead (/stremio-server/, signed-in users only, see lib/stremio.js). Its
// root has to stay the root: Stremio builds paths like /hlsv2/… from it.
const PREFIX = "/service/";
const STREMIO_ORIGINS = new Set(["http://127.0.0.1:11470", "http://localhost:11470"]);
const STREMIO_PATH = "/stremio-server";

function stremioTarget(requestUrl) {
  const url = new URL(requestUrl);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return null;
  let target;
  try { target = new URL(decodeURIComponent(url.pathname.slice(PREFIX.length)) + url.search); }
  catch { return null; }
  if (!STREMIO_ORIGINS.has(target.origin)) return null;
  return STREMIO_PATH + target.pathname + target.search;
}

async function toStremio(request, path) {
  const hasBody = !["GET", "HEAD"].includes(request.method);
  // Headers pass through as sent, so Range requests get the server's 206
  // replies untouched (Safari won't play video without them).
  return fetch(path, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "follow",
    signal: request.signal,
  });
}

async function handle(event) {
  const stremio = stremioTarget(event.request.url);
  if (stremio) return toStremio(event.request, stremio);
  await scramjet.loadConfig();
  if (scramjet.route(event)) return scramjet.fetch(event);
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => event.respondWith(handle(event)));
