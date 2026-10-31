# Revivv back end

Revivv's own server replaced Supabase on 28 Oct 2026. Version 2 (`docs/REBUILD-PLAN.md`) was built the same day, the H&R way.

It holds:
- customer accounts, cars, bookings and their steps;
- messages, stamps, credit and referrals;
- payments, gift vouchers, prices, hours and closed days;
- the email outbox, staff, the audit log and job photos.

## The back office (revivvbb.com/staff.html)

| Page | Who | What |
|---|---|---|
| Today `staff.html` | all staff | today's jobs with one-tap steps, bookings waiting to confirm, the week ahead; owners also see money |
| Bookings `staff-bookings.html` | all staff | every booking, with filters |
| A booking `staff-booking.html?ref=` | all staff | steps, move, edit, the job card (checklist, notes, photos), payments, timeline |
| New booking `staff-new.html` | all staff | phone, WhatsApp, Instagram and walk-in bookings |
| Customers `staff-customers.html`, `staff-customer.html?id=` | all staff | details, cars, history, rewards; owners can adjust stamps or credit |
| Messages `staff-messages.html` | all staff | one conversation per customer |
| Money `staff-money.html` | owners | payments, CSV downloads, gift vouchers |
| Reports `staff-reports.html` | owners | money, jobs, customers, busiest days, what's owed |
| Settings `staff-settings.html` | owners | prices, add-ons, checklists, slots, closed days, business details |
| Staff `staff-team.html` | owners | add or remove staff, owner or crew, password links, activity log |
| Emails `staff-outbox.html` | owners | every email the system wrote, and whether it went |

Customers have **My Revivv**:
- `portal.html`, `my-bookings.html`, `my-messages.html`, `my-cars.html` and `my-account.html`;
- `my-booking.html?ref=&k=`, the link in every email. It works without signing in.

## Emails

- Every email goes into the `outbox` table first, and a job sends it.
- **While there is no mailbox** (MAIL_MODE is not `graph`), emails are **held**:
  - they are kept on the Emails page, so staff can pass important ones on by WhatsApp;
  - they are never sent later by surprise.
- Sign-in codes and password resets need the mailbox, so until then people sign in with a password.
- What gets sent:
  - booking received;
  - confirmed;
  - moved;
  - a reminder the day before (from 10am);
  - on the way;
  - thank you, with the stamps and the review link;
  - cancelled;
  - "time for your next detail", 6 weeks after the last one;
  - new message alerts, at most one every 10 minutes per conversation;
  - new booking alerts to staff who have alerts on.

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
| `/var/lib/revivv/uploads` | job photos (private; only staff and that booking's customer can open them) |
| `revivv-backup.timer` | nightly at 3:40am in `/var/backups/revivv`: the database (kept 30 days) and the photos (kept 7 days) |

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

## The old Supabase data (done 28 Oct 2026)

The old data was copied across once, from Supabase's final backup of the paused project:
- 5 logins, 3 staff (Juwan, Nick Stapleton, Stefon Walrond), 2 customers and 2 completed bookings;
- everyone keeps their old password: the old bcrypt hashes are upgraded the first time each person signs in.

That backup is kept on the server as `/var/backups/revivv/supabase-final-2026-10-08.sql.gz` (the nightly clean-up leaves it alone). Supabase is no longer needed.

The script was `server/src/import-supabase.js`. It only writes into an empty database, so it can't run twice by mistake.

## How it behaves

- **Booking steps:**
  - Requested (from the website) → Confirmed → On the way (mobile jobs) → Started → Done.
  - A booking can also be Cancelled (with a reason) or a No-show.
  - Staff bookings start Confirmed.
  - Customers can cancel online up to 24 hours before (set in Settings).
- **Prices:**
  - The server works out every booking's price itself, from the owners' price list (Settings).
  - Until the owners change it, the list is the defaults in `server/src/settings.js`. `server/test/prices.test.js` checks those against the website's pages.
  - The quote page loads the current prices when it opens.
  - Owners can set a booking's price by hand, with a reason.
- **Stamps and the reward:**
  - Staff tapping **Done** adds a stamp.
  - With 5 stamps, the customer's next booking (while signed in) is half price on the package.
  - When that booking is completed, the card goes back to 0.
- **Tiers:** worked out from completed details in the last 12 months.
  - Silver: 3 or more, 5% off.
  - Gold: 6 or more, 10% off, plus the priority slot.
- **Credit:**
  - **Referrals:** both people get $25 when the new customer's first detail is completed.
  - **Spending:** credit is used by a signed-in booking.
  - **Refunds:** cancelling that booking gives the credit back.
- **Slots:** one booking per slot per day. Cancelling (or a no-show) frees the slot. Revivv is open Saturday and Sunday only (Monday to Friday are closed weekdays in Settings). Closed weekdays and closed days are by phone: staff can still book them.
- **Payments:**
  - Staff record what was paid (cash, card, bank transfer, mobile, voucher), so every booking shows paid or owing.
  - Refunds are owners only.
  - "Money taken" is payments plus vouchers sold; a voucher being spent is not counted twice.
- **Photos:** staff phones shrink them before upload, to at most 1600 px. Up to 40 per booking.
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
3. Sign in to the back office with the local test logins written in `server/src/dev.js` (one owner, one crew).
   - Emails and sign-in codes are printed in the API's window, not sent.
