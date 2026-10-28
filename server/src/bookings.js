/*
 * The booking steps and everything that happens with them: the timeline,
 * the line in the customer's conversation, and the emails.
 *
 *   requested → confirmed → on_the_way → in_progress → completed
 *   (any open step) → cancelled | no_show
 */
import { fail, round2 } from './util.js';
import * as R from './rules.js';
import { emails } from './emails.js';
import { getSettings } from './settings.js';

// Which steps each action may start from, and the step it leads to.
export const ACTIONS = {
  confirm:    { from: ['requested'], to: 'confirmed', stamp: 'confirmed_at', label: 'Confirmed' },
  on_the_way: { from: ['requested', 'confirmed'], to: 'on_the_way', stamp: 'on_the_way_at', label: 'On the way' },
  start:      { from: ['requested', 'confirmed', 'on_the_way'], to: 'in_progress', stamp: 'started_at', label: 'Started' },
  complete:   { from: ['requested', 'confirmed', 'on_the_way', 'in_progress'], to: 'completed', stamp: 'completed_at', label: 'Done' },
  cancel:     { from: R.OPEN, to: 'cancelled', stamp: 'cancelled_at', label: 'Cancelled' },
  no_show:    { from: ['requested', 'confirmed', 'on_the_way'], to: 'no_show', stamp: 'no_show_at', label: 'No-show' }
};

export function createBookings({ pool, outbox, config }) {
  const site = config.siteOrigins[0];

  async function event(db, bookingId, kind, actor, detail = null) {
    await db.query('insert into booking_events (booking_id, kind, actor_id, actor_name, detail) values ($1, $2, $3, $4, $5)',
      [bookingId, kind, actor.id || null, actor.name, detail]);
  }

  // A short line in the customer's conversation, e.g. "Booking confirmed: Thu 29 Oct, Morning".
  async function systemLine(db, b, body) {
    await db.query("insert into messages (customer_id, booking_id, sender, sender_name, body) values ($1, $2, 'system', 'Revivv', $3)",
      [b.customer_id, b.id, body.slice(0, 2000)]);
  }

  async function emailCustomer(db, kind, b, extra) {
    if (!b.email) return;
    const s = await getSettings(db);
    const m = emails[kind](b, s, site, extra);
    await outbox.queue(db, { to: b.email, kind, subject: m.subject, body: m.body, bookingId: b.id, customerId: b.customer_id });
  }

  async function emailStaff(db, kind, b) {
    const s = await getSettings(db);
    const m = emails[kind](b, s, site);
    const staff = (await db.query('select u.email from staff s join users u on u.id = s.user_id where s.alerts')).rows;
    for (const st of staff) await outbox.queue(db, { to: st.email, kind, subject: m.subject, body: m.body, bookingId: b.id });
  }

  async function lockByRef(db, ref) {
    const b = (await db.query('select * from bookings where ref = $1 for update', [String(ref || '').trim().toUpperCase()])).rows[0];
    if (!b) fail(404, 'That booking was not found.');
    return b;
  }

  async function newRef(db, today) {
    for (;;) {
      const ref = `RV-${today.slice(2).replace(/-/g, '')}-${1000 + Math.floor(Math.random() * 9000)}`;
      const r = await db.query('select 1 from bookings where ref = $1', [ref]);
      if (!r.rowCount) return ref;
    }
  }

  /*
   * Move a booking to its next step. opts: { reason, notify (default true) }.
   * Returns the updated booking row.
   */
  async function act(db, ref, action, actor, opts = {}) {
    const a = ACTIONS[action];
    if (!a) fail(400, 'Unknown action.');
    const b = await lockByRef(db, ref);
    if (!a.from.includes(b.status)) {
      fail(400, `This booking is ${R.STATUS_LABEL[b.status].toLowerCase()}, so it can't be marked ${a.label.toLowerCase()}.`);
    }
    const s = await getSettings(db);
    const reason = opts.reason ? String(opts.reason).trim().slice(0, 300) : null;
    const u = (await db.query(
      `update bookings set status = $2, ${a.stamp} = now(), cancel_reason = coalesce($3, cancel_reason)
        where id = $1 returning *`, [b.id, a.to, action === 'cancel' ? reason : null])).rows[0];
    await event(db, b.id, action, actor, reason);
    const when = `${R.prettyDate(b.booking_date)}, ${R.slotText(s.hours, b.slot)}`;
    const notify = opts.notify !== false;

    if (action === 'confirm') {
      await systemLine(db, u, `Booking confirmed: ${when}.`);
      if (notify) await emailCustomer(db, 'confirmed', u);
    } else if (action === 'on_the_way') {
      await systemLine(db, u, 'Revivv is on the way.');
      if (notify) await emailCustomer(db, 'on_the_way', u);
    } else if (action === 'start') {
      await systemLine(db, u, 'Your detail has started.');
    } else if (action === 'complete') {
      const c = (await db.query('select * from customers where id = $1 for update', [b.customer_id])).rows[0];
      // the half-price detail uses up the card; any other detail adds a stamp
      const stamps = b.reward_applied ? 0 : Math.min(c.stamps + 1, R.MAX_STAMPS);
      await db.query('update customers set stamps = $2 where id = $1', [c.id, stamps]);
      let credit = c.credit;
      if (c.referred_by && !c.referral_paid_at) {
        await db.query('update customers set credit = credit + $2, referral_paid_at = now() where id = $1', [c.id, R.REFERRAL_CREDIT]);
        await db.query('update customers set credit = credit + $2 where id = $1', [c.referred_by, R.REFERRAL_CREDIT]);
        credit = round2(Number(credit) + R.REFERRAL_CREDIT);
        const referrer = (await db.query('select id, name from customers where id = $1', [c.referred_by])).rows[0];
        await db.query("insert into messages (customer_id, sender, sender_name, body) values ($1, 'system', 'Revivv', $2)",
          [referrer.id, `${c.name.split(' ')[0]}'s first detail is done, so $${R.REFERRAL_CREDIT} referral credit is on your account. Thank you!`]);
      }
      await systemLine(db, u, b.reward_applied
        ? 'Detail done. Your half-price reward is used and your card starts again. Thank you!'
        : `Detail done. You now have ${stamps} of ${R.MAX_STAMPS} stamps. Thank you!`);
      if (notify) await emailCustomer(db, 'completed', u, { ...c, stamps, credit });
    } else if (action === 'cancel') {
      if (Number(b.credit_used) > 0) {
        await db.query('update customers set credit = credit + $2 where id = $1', [b.customer_id, b.credit_used]);
      }
      await systemLine(db, u, `Booking cancelled: ${when}.${reason ? ` ${reason}` : ''}`);
      if (actor.customer) await emailStaff(db, 'staff_cancelled', u);
      else if (notify) await emailCustomer(db, 'cancelled', u);
    } else if (action === 'no_show') {
      if (Number(b.credit_used) > 0) {
        await db.query('update customers set credit = credit + $2 where id = $1', [b.customer_id, b.credit_used]);
      }
      await systemLine(db, u, `Marked as a no-show for ${when}. Message us to book again.`);
    }
    return u;
  }

  // A new booking just went in: timeline, conversation line and emails.
  async function announce(db, b, actor) {
    const s = await getSettings(db);
    await event(db, b.id, 'created', actor, actor.customer ? 'Booked on the website' : `Booked by ${actor.name} (${b.source.replace('_', '-')})`);
    await systemLine(db, b, `Booking ${b.status === 'confirmed' ? 'confirmed' : 'requested'}: ${R.prettyDate(b.booking_date)}, ${R.slotText(s.hours, b.slot)}, ${b.package} for ${b.vehicle_type}. Ref ${b.ref}.`);
    if (b.status === 'confirmed') await emailCustomer(db, 'confirmed', b);
    else await emailCustomer(db, 'requested', b);
    if (actor.customer) await emailStaff(db, 'staff_new_booking', b);
  }

  return { act, announce, event, systemLine, emailCustomer, emailStaff, lockByRef, newRef };
}
