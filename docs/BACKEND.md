# Revivv back end

Revivv's own server replaced Supabase on 28 Oct 2026. It holds customer accounts, bookings, stamps, credit, referrals and the staff console.

## What runs where

- **Website:** https://revivvbb.com, on GitHub Pages from `main`. No change there.
- **API:** https://api.revivvbb.com, on the DigitalOcean server `hr-app` (159.203.67.247, NYC3).
  - It shares that server with the H&R app; each has its own database, system user and service.
  - Revivv is capped at 300 MB of memory, so it can't starve H&R.
- **Code:**
  - `server/`: Node 24 + Fastify + PostgreSQL 18, the same stack as the H&R app.
  - `deploy/`: the server files.
  - `assets/js/api.js`: the browser side.

| On the server | What it is |
|---|---|
| `/opt/revivv` | the code (owned by root; the API can read it, not change it) |
| `revivv-api.service` | the API, on 127.0.0.1:4380 |
| `/etc/revivv-api.env` | settings, including the email secret once set (never in git) |
| database `revivv` | owned by the `revivv` system user, no password (local sign-in only) |
| `/etc/caddy/Caddyfile` | shared with H&R; the `api.revivvbb.com` block at the end gives it HTTPS. If H&R's setup ever rewrites this file, add `deploy/Caddyfile.revivv` back to the end |
| `revivv-backup.timer` | nightly database copy at 3:40am, kept 30 days in `/var/backups/revivv` |

## Updating the server

From the laptop, in Git Bash:

```bash
bash deploy/push.sh
```

The script:
1. runs the tests;
2. copies `server/` and `deploy/` to the server;
3. takes a backup;
4. installs, restarts and checks the API.

Database changes (new files in `server/db/migrations/`) apply when the API starts.

## Staff accounts

Run these on the server: `ssh root@159.203.67.247`, then `cd /opt/revivv/server`.

```bash
sudo -u revivv node --env-file=/etc/revivv-api.env src/admin.js add-staff someone@example.com "Their Name"
sudo -u revivv node --env-file=/etc/revivv-api.env src/admin.js list-staff
sudo -u revivv node --env-file=/etc/revivv-api.env src/admin.js remove-staff someone@example.com
sudo -u revivv node --env-file=/etc/revivv-api.env src/admin.js reset-link someone@example.com
```

`add-staff` prints a one-time link, valid for 7 days. Send it to that person privately:
1. The link lets them choose their own password.
2. Then they sign in at https://revivvbb.com/staff.html.

Nobody else ever needs to know their password.

## Email (password resets)

Until email is set up, "Forgot password" tells customers to WhatsApp or call. For now, staff can use `reset-link` instead.

To switch email on (the same way the H&R app sends mail):
1. 👤 **Pick a sender mailbox in Microsoft 365**, e.g. `noreply@` on a domain you own.
2. 👤 **Create the app registration** in Entra ID → App registrations: give it the **Mail.Send** application permission with admin consent, and an application access policy limiting it to that one mailbox.
3. **Fill in the settings.** Put the tenant ID, client ID, secret and sender in `/etc/revivv-api.env`, and set `MAIL_MODE=graph`.
4. **Restart the API:** `systemctl restart revivv-api`.

## Bringing the old Supabase data across

👤 In the Supabase dashboard, either restore the paused project or download its backup file. Then hand the file to Claude:
- the script copies customers, stamps, credit, referrals, bookings and staff;
- customers' passwords carry over: the old bcrypt hashes are upgraded the first time each person signs in.

## How it behaves

- **Prices:** the server works out every booking's price itself, from `server/src/rules.js`.
  - `server/test/prices.test.js` fails if those prices ever differ from the website's.
  - When the prices change, change both.
- **Stamps and the reward:**
  - Staff tapping **Mark complete** adds a stamp.
  - With 5 stamps, the customer's next booking (while signed in) is half price on the package.
  - When that booking is completed, the card goes back to 0.
- **Tiers:** worked out from completed details in the last 12 months.
  - Silver: 3 or more, 5% off.
  - Gold: 6 or more, 10% off, plus the priority slot.
- **Credit:**
  - **Referrals:** both people get $25 when the new customer's first detail is completed.
  - **Spending:** credit is used by a signed-in booking.
  - **Refunds:** cancelling that booking gives the credit back.
- **Slots:** one booking per slot per day. Cancelling frees the slot. Sundays are by phone.
- **Offline:** if the API can't be reached, the quote page still works and sends bookings by WhatsApp, as before.

## Checking on it

```bash
systemctl status revivv-api
journalctl -u revivv-api -n 50
curl -s http://127.0.0.1:4380/health
ls -lh /var/backups/revivv
```

## Local development

```bash
cd server && npm install && npm test
```

To run the whole site locally:
1. Start the API: `node server/src/dev.js --fresh` runs a private database and the API on port 4380.
2. Serve the site: `python -m http.server 4318`, from the repo root.
3. Sign in to the staff console with the local test login written in `server/src/dev.js`.
