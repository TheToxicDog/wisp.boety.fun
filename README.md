# wisp.boety.fun

Private Remote Browser Isolation (RBI) gateway and Wisp stream multiplexer with a
touch-first control UI built for iPad.

```
iPad / browser
 └─ Isolated frame (untrusted page code)
     └─ Scramjet service worker ── rewrites & intercepts every request
         └─ bare-mux shared worker ── routes to the active transport
             └─ epoxy-tls (WebAssembly) ── TLS end-to-end, in the browser
                 └─ Wisp over WSS ── many binary streams on one socket
                     └─ Nginx (TLS, upgrade) → Node.js wisp-js server → origin
```

## Run locally

```sh
npm install
npm start            # http://127.0.0.1:8080
```

Service workers need a secure context, so use `localhost`/`127.0.0.1` locally and HTTPS in production.

| Env var             | Default                  | Purpose                              |
| ------------------- | ------------------------ | ------------------------------------ |
| `PORT`              | `8080`                   | HTTP port                            |
| `HOST`              | `127.0.0.1`              | Bind address (keep behind Nginx)     |
| `WISP_LOG`          | `WARN`                   | `DEBUG`, `INFO`, `WARN`, `ERROR`, `NONE` |
| `WISP_STREAM_LIMIT` | `256`                    | Max streams per Wisp session         |
| `WISP_MOTD`         | `wisp.boety.fun gateway` | Message sent to Wisp v2 clients      |

The relay blocks private and loopback destinations and UDP streams by default (see `server.js`).

## Deploy (Ubuntu/Debian VPS)

```sh
sudo useradd --system --home /opt/wisp.boety.fun wisp
sudo git clone https://github.com/TheToxicDog/wisp.boety.fun /opt/wisp.boety.fun
cd /opt/wisp.boety.fun && sudo npm ci --omit=dev && sudo chown -R wisp: .

sudo cp deploy/wisp.service /etc/systemd/system/
sudo systemctl enable --now wisp

sudo cp deploy/nginx.conf /etc/nginx/sites-available/wisp.boety.fun
sudo ln -s /etc/nginx/sites-available/wisp.boety.fun /etc/nginx/sites-enabled/
sudo certbot certonly --nginx -d wisp.boety.fun
sudo nginx -t && sudo systemctl reload nginx
```

Update: `cd /opt/wisp.boety.fun && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart wisp`.

Static hosting (e.g. GitHub Pages) cannot run the relay. If the UI is hosted statically, set
**Settings → Network → Wisp relay URL** to a running Wisp server.

## UI

- **Sidebar**: pinned on landscape iPad, collapses to an icon rail (chevron or Settings),
  and becomes a swipe-in drawer on portrait iPad and phones.
- **Isolated Browser**: tabs, back/forward/reload, omnibox (URL or search), focus mode,
  editable quick links. Tabs are restored on your next visit.
- **Gateway & Streams**: live health, transport details, latency probe.
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
