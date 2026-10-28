#!/usr/bin/env bash
# From the laptop (Git Bash): run the tests, copy server/ and deploy/ to the
# DigitalOcean server, then run deploy/install.sh and deploy/update.sh there.
# Needs SSH access as root.
#
#   bash deploy/push.sh                 # the usual server
#   bash deploy/push.sh root@<address>  # another one
set -euo pipefail
HOST="${1:-root@159.203.67.247}"
cd "$(dirname "$0")/.."
(cd server && npm test)
tar czf - --exclude=node_modules --exclude=.dev-db --exclude=.test-db server deploy \
  | ssh "$HOST" 'set -e; mkdir -p /opt/revivv; tar xzf - --no-same-owner -C /opt/revivv; bash /opt/revivv/deploy/install.sh; bash /opt/revivv/deploy/update.sh'
