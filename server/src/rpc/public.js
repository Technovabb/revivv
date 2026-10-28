/*
 * Calls anyone can make: the website's prices and hours, free slots, booking,
 * and a booking's own page (opened from the link in the customer's emails).
 */
import crypto from 'node:crypto';
import { tx } from '../db.js';
import { fail, text } from '../util.js';
import * as R from '../rules.js';
import { getSettings } from '../settings.js';
import {
  readBookingInput, checkBooking, customerForEmail, newCustomer, accountState, vehicleFor,
  bookingView, thread, markRead, unread, postMessage
} from '../shared.js';

export default function publicRpc(r, ctx) {
  const { pool, bookings } = ctx;

  // A booking from the link in an email: the reference plus its secret key.
  async function byKey(db, p, lock = false) {
    const ref = text(p.ref).toUpperCase(), k = text(p.k);
    const b = (await db.query(`select * from bookings where ref = $1${lock ? ' for update' : ''}`, [ref])).rows[0];
    const ok = b && k.length === b.access_key.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(b.access_key));
    if (!ok) fail(404, 'That link isn\'t valid. Check the latest email from Revivv, or message us on WhatsApp.');
    return b;
  }

  // What the website needs to show prices, times and closed days.
  r.public('site_info', async () => {
    const s = await getSettings(pool);
    const today = R.todayISO();
    const closed = await pool.query("select day, reason from closed_days where day >= $1 order by day limit 400", [today]);
    return {
      today,
      packages: s.catalog.packages.filter(p => p.active).map(p => ({ name: p.name, prices: p.prices, long: p.long })),
      addons: s.catalog.addons.filter(a => a.active).map(a => ({ name: a.name, price: a.price, perRow: !!a.perRow })),
      slots: s.hours.slots.filter(x => x.active).map(({ id, label, time, goldOnly, long }) => ({ id, label, time, goldOnly, long })),
      closedWeekdays: s.hours.closedWeekdays,
      bookAheadDays: s.hours.bookAheadDays,
      closedDays: closed.rows.map(x => ({ day: x.day, reason: x.reason })),
      business: {
        phone: s.business.phone, phone2: s.business.phone2, whatsapp: s.business.whatsapp, instagram: s.business.instagram,
        cancelHours: s.business.cancelHours, nudgeAfterDays: s.business.nudgeAfterDays
      },
      emailCodes: !ctx.outbox.hold
    };
  });

  // The slots already taken that day. A closed day shows every slot as taken.
  r.public('slots_taken', async p => {
    if (!R.isISODate(p.d)) fail(400, 'Pick a valid date.');
    const s = await getSettings(pool);
    const closed = s.hours.closedWeekdays.includes(R.weekday(p.d)) && !R.isSunday(p.d)
      || (await pool.query('select 1 from closed_days where day = $1', [p.d])).rowCount;
    if (closed) return s.hours.slots.map(x => x.id);
    const taken = await pool.query(
      'select slot from bookings where booking_date = $1 and status <> all($2) order by slot', [p.d, ['cancelled', 'no_show']]);
    const off = s.hours.slots.filter(x => !x.active).map(x => x.id);
    return [...new Set([...taken.rows.map(x => x.slot), ...off])];
  });

  r.public('check_referral', async p => {
    const code = text(p.p_code ?? p.code).toUpperCase();
    if (!code || code.length > 40) return null;
    const row = (await pool.query('select name from customers where upper(referral_code) = $1', [code])).rows[0];
    return row ? row.name.split(' ')[0] : null;
  });

  r.public('create_booking', async (p, user) => {
    const input = readBookingInput(p);
    const s = await getSettings(pool);
    const slot = await checkBooking(pool, input, s);
    const today = R.todayISO();

    return tx(pool, async db => {
      let c = await customerForEmail(db, input.email, true);
      if (!c) c = await newCustomer(db, { email: input.email, name: input.name, phone: input.phone, address: input.address, parish: input.parish });
      else if (!c.phone && input.phone) await db.query('update customers set phone = $2 where id = $1', [c.id, input.phone]);

      // A referral code counts only for someone who hasn't had a detail yet.
      if (input.referral && !c.referred_by) {
        const ref = (await db.query('select id from customers where upper(referral_code) = $1', [input.referral])).rows[0];
        const before = await db.query("select 1 from bookings where customer_id = $1 and status = 'completed' limit 1", [c.id]);
        if (ref && ref.id !== c.id && !before.rowCount) await db.query('update customers set referred_by = $2 where id = $1', [c.id, ref.id]);
      }

      // Rewards, tier discount, credit and saved cars only for the signed-in owner of this email.
      const own = user && user.email.toLowerCase() === input.email;
      const account = own ? await accountState(db, c, today) : null;
      if (slot.goldOnly && account?.tier !== 'Gold') fail(400, 'The priority slot is for Gold members.');
      const price = R.priceBooking({ catalog: s.catalog, pkg: input.pkg, vehicle: input.vehicleType, addons: input.addons, account });
      const vehicle = await vehicleFor(db, c.id, { vehicleId: own ? input.vehicleId : null, type: input.vehicleType, description: input.vehicleDesc });
      const ref = await bookings.newRef(db, today);

      let b;
      try {
        b = (await db.query(
          `insert into bookings (ref, customer_id, booking_date, slot, name, email, phone, vehicle_type, vehicle_desc, vehicle_id, package, addons,
             total, quoted_total, reward_applied, credit_used, location, parish, address, notes, referral_code, source)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'website') returning *`,
          [ref, c.id, input.date, input.slot, input.name, input.email, input.phone, input.vehicleType,
            vehicle?.description || input.vehicleDesc, vehicle?.id || null, input.pkg, input.addons,
            price.total, input.quoted, price.rewardApplied, price.creditUsed, input.location, input.parish, input.address, input.notes, input.referral])).rows[0];
      } catch (e) {
        if (e.code === '23505' && e.constraint === 'bookings_one_per_slot') fail(409, 'That slot was just taken. Please pick another.');
        throw e;
      }
      if (price.creditUsed > 0) await db.query('update customers set credit = credit - $2 where id = $1', [c.id, price.creditUsed]);
      await bookings.announce(db, b, { id: user?.id || null, name: 'Customer', customer: true });
      return { id: b.id, ref: b.ref, key: b.access_key, total: price.total };
    });
  });

  // The booking's own page, from the link in the customer's emails.
  r.public('booking_view', async p => {
    const b = await byKey(pool, p);
    const s = await getSettings(pool);
    const c = (await pool.query('select id, name, stamps, credit from customers where id = $1', [b.customer_id])).rows[0];
    return {
      booking: await bookingView(pool, b, s),
      customer: { name: c.name, stamps: Math.min(c.stamps, R.MAX_STAMPS), credit: Number(c.credit) },
      // only this booking's messages: the link may have been forwarded
      messages: await thread(pool, c.id, { bookingId: b.id }),
      unread: await unread(pool, c.id, 'customer', b.id),
      business: { phone: s.business.phone, whatsapp: s.business.whatsapp }
    };
  });

  r.public('booking_read', async p => {
    const b = await byKey(pool, p);
    await markRead(pool, b.customer_id, 'customer');
    return {};
  });

  r.public('booking_cancel', async p => tx(pool, async db => {
    const b = await byKey(db, p, true);
    const s = await getSettings(db);
    const view = await bookingView(db, b, s);
    if (!view.canCancel) {
      fail(400, b.status === 'requested' || b.status === 'confirmed'
        ? `It's less than ${s.business.cancelHours} hours to your slot, so please call or WhatsApp ${s.business.phone} to cancel.`
        : 'This booking can no longer be cancelled.');
    }
    await bookings.act(db, b.ref, 'cancel', { id: null, name: 'Customer', customer: true }, { reason: 'Cancelled by the customer online.' });
    return {};
  }));

  r.public('booking_send', async p => tx(pool, async db => {
    const b = await byKey(db, p);
    const c = (await db.query('select * from customers where id = $1', [b.customer_id])).rows[0];
    await postMessage(db, ctx, { customer: c, from: 'customer', actor: { id: null, name: c.name }, body: p.body, bookingId: b.id });
    return { messages: await thread(db, c.id, { bookingId: b.id }) };
  }));
}
