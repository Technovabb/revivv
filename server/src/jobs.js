/*
 * Work done on a timer: send waiting emails, day-before reminders, "time for
 * your next detail" notes, and nightly tidying. Each step is safe to run again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tx } from './db.js';
import * as R from './rules.js';
import { getSettings } from './settings.js';
import { emails } from './emails.js';

export function createJobs({ pool, services, config, log = console }) {
  const { outbox, bookings, site } = services;

  // The day before a confirmed booking, from the reminder hour on.
  async function reminders(now = new Date()) {
    const s = await getSettings(pool);
    if (R.hourNow(now) < s.business.reminderHour) return 0;
    const tomorrow = R.addDays(R.todayISO(now), 1);
    return tx(pool, async db => {
      const due = (await db.query(
        `select * from bookings where booking_date = $1 and status = 'confirmed' and reminder_sent_at is null
          for update skip locked`, [tomorrow])).rows;
      for (const b of due) {
        await db.query('update bookings set reminder_sent_at = now() where id = $1', [b.id]);
        await bookings.emailCustomer(db, 'reminder', b);
      }
      return due.length;
    });
  }

  // Once per finished detail, some weeks later, unless the customer has another booked or switched these off.
  async function nudges(now = new Date()) {
    const s = await getSettings(pool);
    const days = s.business.nudgeAfterDays;
    if (!days || R.hourNow(now) < s.business.reminderHour) return 0;
    const today = R.todayISO(now);
    return tx(pool, async db => {
      const due = (await db.query(
        `with last as (
           select customer_id, max(booking_date) as day, max(coalesce(completed_at, booking_date::timestamptz)) as at
             from bookings where status = 'completed' group by customer_id
         )
         select c.* from customers c join last l on l.customer_id = c.id
          where c.reminders and c.email is not null and l.day <= $1
            and (c.last_nudge_at is null or c.last_nudge_at < l.at)
            and not exists (select 1 from bookings b where b.customer_id = c.id and b.status = any($2) and b.booking_date >= $3)
          order by c.id limit 50 for update of c skip locked`,
        [R.addDays(today, -days), R.OPEN, today])).rows;
      for (const c of due) {
        await db.query('update customers set last_nudge_at = now() where id = $1', [c.id]);
        const m = emails.nudge(c, s, site);
        await outbox.queue(db, { to: c.email, kind: 'nudge', subject: m.subject, body: m.body, customerId: c.id });
      }
      return due.length;
    });
  }

  async function tidy() {
    await pool.query('delete from sessions where expires_at < now()');
    await pool.query("delete from password_tokens where expires_at < now() - interval '7 days'");
    await pool.query("delete from login_codes where created_at < now() - interval '1 day'");
    // photo files no booking points at any more (deleted photos, failed uploads)
    const keep = new Set((await pool.query('select file from booking_photos')).rows.map(r => r.file));
    const dir = config.uploadDir;
    for (const f of await fs.promises.readdir(dir).catch(() => [])) {
      if (keep.has(f)) continue;
      const full = path.join(dir, f);
      const st = await fs.promises.stat(full).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 24 * 3600_000) await fs.promises.unlink(full).catch(() => {});
    }
  }

  function start() {
    const safe = (name, fn) => () => fn().catch(e => log.error?.(`[jobs] ${name}: ${e.message}`));
    const timers = [
      setInterval(safe('outbox', () => outbox.sendDue()), 15_000),
      setInterval(safe('reminders', () => reminders()), 10 * 60_000),
      setInterval(safe('nudges', () => nudges()), 60 * 60_000),
      setInterval(safe('tidy', tidy), 24 * 3600_000)
    ];
    timers.forEach(t => t.unref());
    safe('tidy', tidy)();
    safe('reminders', () => reminders())();
    return () => timers.forEach(clearInterval);
  }

  return { reminders, nudges, tidy, start };
}
