#!/usr/bin/env bash
# Sets up Revivv on the shared DigitalOcean server, as root. Safe to run again:
# it never overwrites /etc/revivv-api.env or the database. deploy/push.sh runs it.
set -euo pipefail
APP=/opt/revivv

# a system user with no login, and its own database (signed in by peer auth, no password)
id revivv >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin revivv
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = 'revivv'" | grep -q 1 || sudo -u postgres createuser revivv
sudo -u postgres psql -tAc "select 1 from pg_database where datname = 'revivv'" | grep -q 1 || sudo -u postgres createdb -O revivv revivv

[ -f /etc/revivv-api.env ] || install -m 640 -o root -g revivv "$APP/deploy/revivv-api.env.template" /etc/revivv-api.env
install -d -m 700 -o revivv -g revivv /var/backups/revivv

install -m 644 "$APP/deploy/revivv-api.service" "$APP/deploy/revivv-backup.service" "$APP/deploy/revivv-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet revivv-api.service revivv-backup.timer
systemctl start revivv-backup.timer
