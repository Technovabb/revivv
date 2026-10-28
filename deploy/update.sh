#!/usr/bin/env bash
# On the server, as root, after new code is in /opt/revivv (deploy/push.sh does both):
# back up, install packages, restart, check it answers. Database changes run
# when the API starts.
#
# The code stays owned by root: the API (user revivv) can read it but not change it.
set -euo pipefail
APP=/opt/revivv

echo "1/4 Backing up the database"
systemctl start revivv-backup.service

echo "2/4 Installing packages"
chown -R root:root "$APP"
(cd "$APP/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

echo "3/4 Restarting the API"
systemctl restart revivv-api.service

echo "4/4 Checking it answers"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4380/health >/dev/null 2>&1; then
    echo "    The API is up."
    exit 0
  fi
  sleep 1
done
echo "The API didn't answer within 20 seconds. Look at: journalctl -u revivv-api -n 50" >&2
exit 1
