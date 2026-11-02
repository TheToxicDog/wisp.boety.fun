#!/usr/bin/env bash
# One-command install / update for the Wisp gateway on Ubuntu/Debian.
#   curl -fsSL https://raw.githubusercontent.com/TheToxicDog/wisp.boety.fun/master/deploy/setup.sh | sudo bash
# Safe to re-run: it updates the code and leaves existing certs and settings alone.
# WISP_FAST=1 (used by deploy/autodeploy.sh) skips packages, git and firewall.
set -euo pipefail
FAST=${WISP_FAST:-0}

REPO=https://github.com/TheToxicDog/wisp.boety.fun
DIR=/opt/wisp.boety.fun
DOMAIN=wisp.boety.fun
CERT=/etc/ssl/cloudflare/$DOMAIN.pem
KEY=/etc/ssl/cloudflare/$DOMAIN.key
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run with sudo: curl -fsSL ... | sudo bash" >&2; exit 1; }

# Wait for a running auto-deploy (or another setup) to finish: two at once
# both run npm ci in the same folder and break each other. Auto-deploy holds
# this lock itself and runs setup in fast mode, so only lock otherwise.
if [ "$FAST" != 1 ]; then
  exec 9>/run/wisp-deploy.lock
  flock -n 9 || { echo "Waiting for a deploy in progress to finish..."; flock 9; }
fi

if [ "$FAST" != 1 ]; then
  step "Installing packages"
  apt-get update -qq
  apt-get install -y -qq curl git nginx ufw openssl ca-certificates >/dev/null
fi
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

step "Fetching gateway code"
id wisp >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin wisp
if [ -d "$DIR/.git" ]; then
  git config --global --get-all safe.directory | grep -qx "$DIR" || git config --global --add safe.directory "$DIR"
  [ "$FAST" = 1 ] || git -C "$DIR" pull --ff-only
else
  git clone -q "$REPO" "$DIR"
fi
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R wisp: "$DIR"

step "Starting gateway service"
cp deploy/wisp.service /etc/systemd/system/wisp.service
cp deploy/wisp-deploy.service deploy/wisp-deploy.timer /etc/systemd/system/
chmod +x deploy/autodeploy.sh
systemctl daemon-reload
systemctl enable wisp >/dev/null 2>&1
systemctl enable --now wisp-deploy.timer >/dev/null 2>&1
systemctl restart wisp

# Stremio streaming server, for Stremio Web in the isolated browser (README:
# "Stremio"). Optional: a failure here leaves the gateway deploy alone.
# WISP_STREMIO=0 skips it.
STREMIO_VERSION=v4.20.12
STREMIO_SHA256=a527f3dd20c6e7b35eb2077cebcf859cba8140602f26f10f8e89c3c1a08eac13
STREMIO_DIR=/opt/stremio-server
install_stremio() {
  if ! command -v ffmpeg >/dev/null; then
    # Also on auto-deploys (fast mode), once, so existing servers pick it up.
    apt-get install -y -qq ffmpeg >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null; } || return 1
  fi
  id stremio >/dev/null 2>&1 || useradd --system --home /var/lib/stremio-server --shell /usr/sbin/nologin stremio || return 1
  mkdir -p "$STREMIO_DIR"
  local changed=0
  if ! echo "$STREMIO_SHA256  $STREMIO_DIR/server.js" | sha256sum -c --quiet >/dev/null 2>&1; then
    curl -fsSL -o "$STREMIO_DIR/server.js.new" "https://dl.strem.io/server/$STREMIO_VERSION/desktop/server.js" || return 1
    echo "$STREMIO_SHA256  $STREMIO_DIR/server.js.new" | sha256sum -c --quiet || { rm -f "$STREMIO_DIR/server.js.new"; echo "checksum mismatch" >&2; return 1; }
    mv "$STREMIO_DIR/server.js.new" "$STREMIO_DIR/server.js"
    changed=1
  fi
  cmp -s deploy/stremio-server.service /etc/systemd/system/stremio-server.service || changed=1
  cp deploy/stremio-server.service /etc/systemd/system/stremio-server.service
  systemctl daemon-reload
  systemctl enable stremio-server >/dev/null 2>&1
  # Restarting cuts off anyone watching, so only when something changed.
  if [ "$changed" = 1 ] || ! systemctl is-active -q stremio-server; then systemctl restart stremio-server; fi
}
if [ "${WISP_STREMIO:-1}" != 0 ]; then
  step "Stremio streaming server"
  if install_stremio; then echo "stremio-server $STREMIO_VERSION: running"
  else echo "stremio-server: install failed (the gateway is unaffected). Check: journalctl -u stremio-server -n 50" >&2; fi
fi

step "TLS certificate"
mkdir -p /etc/ssl/cloudflare
if [ ! -s "$CERT" ] || [ ! -s "$KEY" ]; then
  # Self-signed origin cert; Cloudflare SSL mode "Full" accepts it.
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN" -keyout "$KEY" -out "$CERT" 2>/dev/null
  echo "created self-signed certificate"
else
  echo "keeping existing certificate"
fi
chmod 600 "$KEY"

step "Configuring Nginx"
cp deploy/nginx.conf /etc/nginx/sites-available/$DOMAIN
# Hosts without IPv6 can't bind [::] listeners.
[ -f /proc/net/if_inet6 ] || sed -i '/listen \[::\]/d' /etc/nginx/sites-available/$DOMAIN
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
rm -f /etc/nginx/sites-enabled/default
[ -f /etc/nginx/conf.d/cloudflare-realip.conf ] || : > /etc/nginx/conf.d/cloudflare-realip.conf
nginx -t
systemctl enable nginx >/dev/null 2>&1
if [ "$FAST" = 1 ]; then systemctl reload nginx; else systemctl restart nginx; fi

if [ "$FAST" != 1 ]; then
  step "Firewall (SSH stays open; web ports open to Cloudflare only)"
  ssh_ports=$(sshd -T 2>/dev/null | awk '/^port /{print $2}')
  for p in ${ssh_ports:-22}; do ufw allow "$p/tcp" comment ssh >/dev/null; done
  ufw --force enable >/dev/null
  chmod +x scripts/cloudflare-sync.sh
  scripts/cloudflare-sync.sh
  echo "17 4 * * 1 root $DIR/scripts/cloudflare-sync.sh" > /etc/cron.d/cloudflare-sync
fi

step "Health check"
healthy=0
for _ in $(seq 15); do
  sleep 1
  # Up, and still up a moment later (catches crash loops).
  if curl -fsS http://127.0.0.1:8080/api/auth/state >/dev/null 2>&1 && sleep 2 && systemctl is-active -q wisp; then healthy=1; break; fi
done
if [ "$healthy" = 1 ]; then
  echo "gateway: OK"
else
  echo "gateway: NOT RESPONDING — run: journalctl -u wisp -n 50 --no-pager" >&2
  journalctl -u wisp -n 20 --no-pager 2>/dev/null || true
  exit 1
fi
[ "$FAST" = 1 ] && exit 0

HEAD=$(git -C "$DIR" rev-parse HEAD)
printf '{"commit":"%s","attempted":"%s","ok":true,"at":"%s"}\n' "$HEAD" "$HEAD" "$(date -u +%FT%TZ)" > /var/lib/wisp/deploy.json
echo "auto-deploy: on (checks GitHub every 2 minutes)"

IP=$(curl -4 -fsS https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
printf '\n\033[1;32mDone.\033[0m Server IP for the Cloudflare DNS record: \033[1m%s\033[0m\n' "$IP"
if [ -s /var/lib/wisp/setup-code ]; then
  printf '\nOpen https://%s and create your master account with your access code (or this one: \033[1;33m%s\033[0m)\n' "$DOMAIN" "$(cat /var/lib/wisp/setup-code)"
fi
