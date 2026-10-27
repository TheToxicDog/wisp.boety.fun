#!/usr/bin/env bash
# One-command install / update for the Wisp gateway on Ubuntu/Debian.
#   curl -fsSL https://raw.githubusercontent.com/TheToxicDog/wisp.boety.fun/master/deploy/setup.sh | sudo bash
# Safe to re-run: it updates the code and leaves existing certs and settings alone.
set -euo pipefail

REPO=https://github.com/TheToxicDog/wisp.boety.fun
DIR=/opt/wisp.boety.fun
DOMAIN=wisp.boety.fun
CERT=/etc/ssl/cloudflare/$DOMAIN.pem
KEY=/etc/ssl/cloudflare/$DOMAIN.key
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run with sudo: curl -fsSL ... | sudo bash" >&2; exit 1; }

step "Installing packages"
apt-get update -qq
apt-get install -y -qq curl git nginx ufw openssl ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

step "Fetching gateway code"
id wisp >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin wisp
if [ -d "$DIR/.git" ]; then
  git config --global --add safe.directory "$DIR"
  git -C "$DIR" pull --ff-only
else
  git clone -q "$REPO" "$DIR"
fi
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R wisp: "$DIR"

step "Starting gateway service"
cp deploy/wisp.service /etc/systemd/system/wisp.service
systemctl daemon-reload
systemctl enable wisp >/dev/null 2>&1
systemctl restart wisp

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
systemctl restart nginx

step "Firewall (SSH stays open; web ports open to Cloudflare only)"
ssh_ports=$(sshd -T 2>/dev/null | awk '/^port /{print $2}')
for p in ${ssh_ports:-22}; do ufw allow "$p/tcp" comment ssh >/dev/null; done
ufw --force enable >/dev/null
chmod +x scripts/cloudflare-sync.sh
scripts/cloudflare-sync.sh
echo "17 4 * * 1 root $DIR/scripts/cloudflare-sync.sh" > /etc/cron.d/cloudflare-sync

step "Health check"
sleep 2
if curl -fsS http://127.0.0.1:8080/api/auth/state >/dev/null; then
  echo "gateway: OK"
else
  echo "gateway: NOT RESPONDING — run: journalctl -u wisp -n 50 --no-pager" >&2
  exit 1
fi

IP=$(curl -4 -fsS https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
printf '\n\033[1;32mDone.\033[0m Server IP for the Cloudflare DNS record: \033[1m%s\033[0m\n' "$IP"
if [ -s /var/lib/wisp/setup-code ]; then
  printf '\nOpen https://%s and create your master account with setup code: \033[1;33m%s\033[0m\n' "$DOMAIN" "$(cat /var/lib/wisp/setup-code)"
fi
