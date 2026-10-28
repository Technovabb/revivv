#!/usr/bin/env bash
# Nightly copy of the Revivv database, run as revivv by revivv-backup.service.
# Kept 30 days in /var/backups/revivv. DigitalOcean's daily server backup
# also covers this folder.
set -euo pipefail
DIR=/var/backups/revivv
umask 077
pg_dump --format=custom --dbname=revivv --file="$DIR/revivv-$(date -u +%Y%m%d-%H%M).dump"
find "$DIR" -name 'revivv-*.dump' -mtime +30 -delete
echo "Backup done: $(ls -1t "$DIR" | head -1)"
