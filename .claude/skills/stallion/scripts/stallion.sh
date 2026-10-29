#!/usr/bin/env bash
# Thin wrapper around the Stallion (BuyVM) client API.
# Usage: stallion.sh <action> [key=value ...]
# Credentials come from the API_KEY and API_HASH environment variables.
set -euo pipefail

ENDPOINT="https://manage.buyvm.net/api/client/command.php"

usage() {
  echo "Usage: $0 <boot|reboot|shutdown|info|rdns> [key=value ...]" >&2
  echo "  rdns requires ip=<address> rdns=<hostname>" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
action="$1"
shift

case "$action" in
  boot|reboot|shutdown|info|rdns) ;;
  *) echo "Unknown action: $action" >&2; usage ;;
esac

: "${API_KEY:?API_KEY is not set}"
: "${API_HASH:?API_HASH is not set}"

args=(--data-urlencode "key=${API_KEY}" --data-urlencode "hash=${API_HASH}" --data-urlencode "action=${action}")

for pair in "$@"; do
  [[ "$pair" == *=* ]] || { echo "Expected key=value, got: $pair" >&2; usage; }
  args+=(--data-urlencode "$pair")
done

if [[ "$action" == "rdns" ]]; then
  has_ip=0; has_rdns=0
  for pair in "$@"; do
    [[ "$pair" == ip=* ]] && has_ip=1
    [[ "$pair" == rdns=* ]] && has_rdns=1
  done
  if [[ $has_ip -eq 0 || $has_rdns -eq 0 ]]; then
    echo "rdns requires ip=<address> and rdns=<hostname>" >&2
    exit 2
  fi
fi

response="$(curl -sS --max-time 60 -X POST "$ENDPOINT" \
  -H 'Expect:' \
  "${args[@]}")"

# Redact credentials from anything we print.
redacted="$(printf '%s' "$response" | sed -e "s|${API_KEY}|[KEY]|g" -e "s|${API_HASH}|[HASH]|g")"
printf '%s\n' "$redacted"

# info responses carry no <status> tag, so only an explicit error or failure counts.
if printf '%s' "$response" | grep -q -E '<status>(error|failed)</status>'; then
  exit 1
fi
exit 0
