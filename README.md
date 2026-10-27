# wisp.boety.fun

Private Remote Browser Isolation (RBI) gateway and Wisp stream multiplexer with a
touch-first control UI built for iPad.

| # | Layer | Implementation |
| - | ----- | -------------- |
| 1 | Presentation (UI & container) | `public/` — sidebar shell, search bar, navigation, isolated `<iframe>` or `about:blank` window |
| 2 | Interception & virtualization | Scramjet service worker (`public/sw.js`, scope `/service/`) rewrites HTML/CSS/JS; `location`, `top` and cookies virtualized in IndexedDB |
| 3 | Client transport bridge | bare-mux shared worker + epoxy-tls (WASM): in-browser TLS, requests packed into Wisp frames on one WebSocket |
| 4 | Edge CDN & ingress | Cloudflare (proxied DNS): public SSL, origin IP shielding, persistent WebSockets |
| 5 | Origin gateway relay | Nginx → `server.js` (`@mercuryworkshop/wisp-js`): demultiplexes streams into outbound TCP/UDP sockets |

Key constants live in `public/js/config.js`: the transport endpoint
(`wss://wisp.boety.fun/wisp/`) and the service worker scope / Scramjet prefix (`/service/`).
On `localhost` the UI talks to the local relay instead.

## Run locally

```sh
npm install          # also copies runtime bundles into public/ (scripts/assets.js)
npm start            # http://127.0.0.1:8080
npm run verify-assets
```

`npm install` places the pre-built Scramjet, bare-mux and epoxy bundles in the static web
root (`public/scram`, `public/baremux`, `public/epoxy`). The server refuses to start if any are missing.

Service workers need a secure context, so use `localhost`/`127.0.0.1` locally and HTTPS in production.

| Env var             | Default                  | Purpose                              |
| ------------------- | ------------------------ | ------------------------------------ |
| `PORT`              | `8080`                   | HTTP port                            |
| `HOST`              | `127.0.0.1`              | Bind address (keep behind Nginx)     |
| `WISP_LOG`          | `WARN`                   | `DEBUG`, `INFO`, `WARN`, `ERROR`, `NONE` |
| `WISP_STREAM_LIMIT` | `256`                    | Max streams per Wisp session         |
| `WISP_MOTD`         | `wisp.boety.fun gateway` | Message sent to Wisp v2 clients      |
| `WISP_ALLOW_UDP`    | `true`                   | Set `false` to allow TCP streams only |

The relay always blocks private and loopback destinations (see `server.js`).

## Deploy (Ubuntu/Debian VPS behind Cloudflare)

### 1. Origin (VPS)

```sh
# Node 20+ is required; distro packages are often older.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nginx nodejs ufw
sudo useradd --system --home /opt/wisp.boety.fun wisp
sudo git clone https://github.com/TheToxicDog/wisp.boety.fun /opt/wisp.boety.fun
cd /opt/wisp.boety.fun && sudo npm ci --omit=dev && sudo chown -R wisp: .

sudo cp deploy/wisp.service /etc/systemd/system/
sudo systemctl enable --now wisp
```

### 2. Cloudflare dashboard

1. **DNS**: `A wisp → <VPS IP>`, **Proxied** (orange cloud).
2. **SSL/TLS → Overview**: **Full (strict)**.
3. **SSL/TLS → Origin Server → Create Certificate** for `wisp.boety.fun`. Save it as
   `/etc/ssl/cloudflare/wisp.boety.fun.pem` and the key as `/etc/ssl/cloudflare/wisp.boety.fun.key`
   (`chmod 600` the key).
4. **Network**: **WebSockets** on.
5. **Caching → Cache Rules**: bypass cache when the URI path starts with `/wisp/` or `/api/`.
6. **Speed → Optimization**: turn **Rocket Loader** off (it rewrites scripts and breaks the runtime).
7. Optional, stronger origin shielding: **SSL/TLS → Origin Server → Authenticated Origin Pulls** on,
   then uncomment the two `ssl_*client*` lines in `deploy/nginx.conf`.

The relay pings every 30s, so idle sockets stay under Cloudflare's 100s WebSocket idle limit.

### 3. Nginx + firewall

```sh
sudo cp deploy/nginx.conf /etc/nginx/sites-available/wisp.boety.fun
sudo ln -s /etc/nginx/sites-available/wisp.boety.fun /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

sudo ufw allow OpenSSH && sudo ufw --force enable
sudo scripts/cloudflare-sync.sh      # real-IP config + 80/443 open to Cloudflare only
echo '17 4 * * 1 root /opt/wisp.boety.fun/scripts/cloudflare-sync.sh' | sudo tee /etc/cron.d/cloudflare-sync
```

Nginx serves `public/` directly and proxies only `/wisp/` (WebSocket) and `/api/` to Node.
Check **Gateway & Streams → Edge & ingress** in the UI: it reads **Proxied** with your
Cloudflare edge location when traffic is flowing through Cloudflare.

Update: `cd /opt/wisp.boety.fun && sudo git pull && sudo npm ci --omit=dev && sudo chown -R wisp: . && sudo systemctl restart wisp`.

## UI

- **Sidebar**: pinned on landscape iPad, collapses to an icon rail (chevron or Settings),
  and becomes a swipe-in drawer on portrait iPad and phones.
- **Isolated Browser**: tabs, back/forward/reload, omnibox (URL or search), open the
  current page in an `about:blank` window, focus mode, editable quick links. Tabs are restored on your next visit.
- **Gateway & Streams**: live health, transport details, Cloudflare edge status, latency probe,
  and the five architecture layers.
- **Settings**: search engine, relay URL, theme, accent, compact sidebar, reset.

### Point & Note (requesting changes)

1. Tap **Point & Note** at the bottom of the sidebar.
2. Tap any part of the UI and type what should change.
3. Tap **Done** → **Copy for Claude**, then paste the list into your chat.

Every element has a stable `data-ui` id (e.g. `browser.toolbar.address`), so each note
points at the exact code to change.

## Pinned versions

`@mercuryworkshop/epoxy-transport` is pinned to `2.1.29`: the 3.x line expects a newer
bare-mux header format and fails with `headers is not iterable` against `bare-mux@2.1.9`.
