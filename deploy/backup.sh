#!/usr/bin/env bash
# Nightly copy of the Revivv database and job photos, run as revivv by
# revivv-backup.service, in /var/backups/revivv: the database kept 30 days,
# the photos 7 days (they are much bigger). DigitalOcean's daily server backup
# also covers this folder.
set -euo pipefail
DIR=/var/backups/revivv
STAMP=$(date -u +%Y%m%d-%H%M)
umask 077
pg_dump --format=custom --dbname=revivv --file="$DIR/revivv-$STAMP.dump"
find "$DIR" -name 'revivv-*.dump' -mtime +30 -delete
if [ -d /var/lib/revivv/uploads ]; then
  tar -czf "$DIR/photos-$STAMP.tgz" -C /var/lib/revivv uploads
  find "$DIR" -name 'photos-*.tgz' -mtime +7 -delete
fi
echo "Backup done: revivv-$STAMP.dump"
