#!/usr/bin/env bash
# Auto-deploy (run by wisp-deploy.timer every 2 minutes): when master has new
# commits, update and re-run setup; if the new version fails its health
# check, roll back to the previous commit. Status: /var/lib/wisp/deploy.json,
# also served at https://wisp.boety.fun/api/version. Log: /var/log/wisp-deploy.log
set -uo pipefail
DIR=${WISP_DIR:-/opt/wisp.boety.fun}
STATE=${WISP_STATE:-/var/lib/wisp/deploy.json}
LOG=${WISP_LOG:-/var/log/wisp-deploy.log}

exec 9>"${WISP_LOCK:-/run/wisp-deploy.lock}"
flock -n 9 || exit 0
cd "$DIR" || exit 1
git config --global --get-all safe.directory | grep -qx "$DIR" || git config --global --add safe.directory "$DIR"
git fetch -q origin master || exit 0

OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/master)
[ "$OLD" = "$NEW" ] && exit 0
# Already tried this commit and rolled back: wait for a newer one.
grep -q "\"attempted\":\"$NEW\",\"ok\":false" "$STATE" 2>/dev/null && exit 0

[ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ] && tail -c 262144 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
status() { # running-commit attempted-commit ok
  printf '{"commit":"%s","attempted":"%s","ok":%s,"at":"%s"}\n' "$1" "$2" "$3" "$(date -u +%FT%TZ)" > "$STATE"
}

echo "=== $(date -u +%FT%TZ) deploying ${NEW:0:7} (was ${OLD:0:7})" >> "$LOG"
if git reset -q --hard "$NEW" && WISP_FAST=1 bash deploy/setup.sh >> "$LOG" 2>&1; then
  status "$NEW" "$NEW" true
  echo "=== deployed ${NEW:0:7}" >> "$LOG"
else
  echo "=== ${NEW:0:7} failed; rolling back to ${OLD:0:7}" >> "$LOG"
  git reset -q --hard "$OLD" && WISP_FAST=1 bash deploy/setup.sh >> "$LOG" 2>&1
  status "$OLD" "$NEW" false
fi
