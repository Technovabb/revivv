// Calls for a signed-in customer: My Revivv (bookings, rewards, messages, cars, settings).
import { tx } from '../db.js';
import { fail, text, opt, maxLen, posId } from '../util.js';
import * as R from '../rules.js';
import { getSettings, VEHICLE_TYPES } from '../settings.js';
import { visits12, customerForEmail, newCustomer, bookingView, thread, markRead, unread, postMessage } from '../shared.js';

export default function accountRpc(r, ctx) {
  const { pool, bookings } = ctx;

  async function mine(db, user, { create = false, lock = false } = {}) {
    let c = await customerForEmail(db, user.email, lock);
    if (!c && create) c = await newCustomer(db, { email: user.email.toLowerCase(), name: user.email.split('@')[0] });
    return c;
  }
  async function myBooking(db, user, ref, lock = false) {
    const c = await mine(db, user);
    const b = c && (await db.query(`select * from bookings where ref = $1 and customer_id = $2${lock ? ' for update' : ''}`,
      [text(ref).toUpperCase(), c.id])).rows[0];
    if (!b) fail(404, 'That booking was not found on your account.');
    return b;
  }
  const short = (b, s) => ({
    ref: b.ref, key: b.access_key, status: b.status, statusLabel: R.STATUS_LABEL[b.status], date: b.booking_date,
    dateText: R.prettyDate(b.booking_date), slotText: R.slotText(s.hours, b.slot), package: b.package,
    vehicleType: b.vehicle_type, vehicleDesc: b.vehicle_desc, total: Number(b.total)
  });

  // Kept in the shape the rewards card and quote page already read, plus more.
  r.customer('my_account', async (p, user) => {
    await mine(pool, user, { create: true });   // signed up before booking: start their card (and referral code) now
    const c = (await pool.query(
      "select *, to_char(created_at at time zone $2, 'Mon YYYY') as since from customers where lower(email) = lower($1)",
      [user.email, R.TZ])).rows[0];
    if (!c) return null;
    const s = await getSettings(pool);
    const { tier, discount } = R.tierFor(await visits12(pool, c.id));
    const history = (await pool.query(
      "select to_char(booking_date, 'FMDD Mon YYYY') as date, package || ' — ' || vehicle_type as job, total as paid from bookings where customer_id = $1 and status = 'completed' order by booking_date desc, id desc limit 50",
      [c.id])).rows;
    const next = (await pool.query(
      'select * from bookings where customer_id = $1 and status = any($2) and booking_date >= $3 order by booking_date, slot limit 1',
      [c.id, R.OPEN, R.todayISO()])).rows[0];
    const vehicles = (await pool.query(
      'select id, type, description, colour, plate from vehicles where customer_id = $1 and archived_at is null order by id', [c.id])).rows;
    return {
      name: c.name, since: c.since, stamps: Math.min(c.stamps, R.MAX_STAMPS), credit: Number(c.credit), referral: c.referral_code,
      tier, discount, history, email: c.email, phone: c.phone, address: c.address, parish: c.parish, reminders: c.reminders,
      unread: await unread(pool, c.id, 'customer'), next: next ? short(next, s) : null, vehicles
    };
  });

  r.customer('my_bookings', async (p, user) => {
    const c = await mine(pool, user);
    if (!c) return { upcoming: [], past: [] };
    const s = await getSettings(pool);
    const rows = (await pool.query('select * from bookings where customer_id = $1 order by booking_date desc, id desc limit 200', [c.id])).rows;
    const today = R.todayISO();
    const upcoming = rows.filter(b => R.OPEN.includes(b.status) && b.booking_date >= today).reverse().map(b => short(b, s));
    const past = rows.filter(b => !(R.OPEN.includes(b.status) && b.booking_date >= today)).map(b => short(b, s));
    return { upcoming, past };
  });

  r.customer('my_booking', async (p, user) => {
    const b = await myBooking(pool, user, p.ref);
    return bookingView(pool, b, await getSettings(pool));
  });

  r.customer('my_cancel', async (p, user) => tx(pool, async db => {
    const b = await myBooking(db, user, p.ref, true);
    const s = await getSettings(db);
    if (!(await bookingView(db, b, s)).canCancel) {
      fail(400, `This booking can't be cancelled online any more. Please call or WhatsApp ${s.business.phone}.`);
    }
    await bookings.act(db, b.ref, 'cancel', { id: user.id, name: 'Customer', customer: true }, { reason: 'Cancelled by the customer online.' });
    return {};
  }));

  r.customer('my_thread', async (p, user) => {
    const c = await mine(pool, user);
    if (!c) return { messages: [] };
    await markRead(pool, c.id, 'customer');
    return { messages: await thread(pool, c.id) };
  });

  r.customer('my_send', async (p, user) => tx(pool, async db => {
    const c = await mine(db, user, { create: true });
    let bookingId = null;
    if (p.ref) bookingId = (await myBooking(db, user, p.ref)).id;
    await postMessage(db, ctx, { customer: c, from: 'customer', actor: { id: user.id, name: c.name }, body: p.body, bookingId });
    return { messages: await thread(db, c.id) };
  }));

  r.customer('my_vehicles', async (p, user) => {
    const c = await mine(pool, user);
    if (!c) return [];
    return (await pool.query(
      `select v.id, v.type, v.description, v.colour, v.plate, v.notes,
              (select count(*)::int from bookings b where b.vehicle_id = v.id and b.status = 'completed') as details
         from vehicles v where v.customer_id = $1 and v.archived_at is null order by v.id`, [c.id])).rows;
  });

  r.customer('my_vehicle_save', async (p, user) => tx(pool, async db => {
    const c = await mine(db, user, { create: true });
    const type = text(p.type);
    if (!VEHICLE_TYPES.includes(type)) fail(400, 'Pick car, SUV or truck.');
    const fields = [type, opt(p.description, 120, 'The make and model'), opt(p.colour, 40, 'The colour'), opt(p.plate, 20, 'The plate'), opt(p.notes, 300, 'The notes')];
    if (!fields[1]) fail(400, 'Add the make and model, e.g. Toyota Corolla.');
    if (p.id) {
      const u = await db.query('update vehicles set type = $3, description = $4, colour = $5, plate = $6, notes = $7 where id = $1 and customer_id = $2 and archived_at is null',
        [posId(p.id, 'car'), c.id, ...fields]);
      if (!u.rowCount) fail(404, 'That car was not found.');
    } else {
      const n = (await db.query('select count(*)::int as n from vehicles where customer_id = $1 and archived_at is null', [c.id])).rows[0].n;
      if (n >= 20) fail(400, 'That is a lot of cars! Message us and we\'ll help.');
      await db.query('insert into vehicles (customer_id, type, description, colour, plate, notes) values ($1, $2, $3, $4, $5, $6)', [c.id, ...fields]);
    }
    return {};
  }));

  r.customer('my_vehicle_remove', async (p, user) => {
    const c = await mine(pool, user);
    if (!c) fail(404, 'That car was not found.');
    const u = await pool.query('update vehicles set archived_at = now() where id = $1 and customer_id = $2 and archived_at is null', [posId(p.id, 'car'), c.id]);
    if (!u.rowCount) fail(404, 'That car was not found.');
    return {};
  });

  r.customer('my_settings_save', async (p, user) => tx(pool, async db => {
    const c = await mine(db, user, { create: true, lock: true });
    const name = maxLen(text(p.name), 100, 'Your name');
    if (!name) fail(400, 'Please enter your name.');
    const phone = maxLen(text(p.phone), 40, 'The phone number');
    if (phone && phone.replace(/\D/g, '').length < 7) fail(400, 'That phone number looks too short.');
    await db.query('update customers set name = $2, phone = $3, address = $4, parish = $5, reminders = $6 where id = $1',
      [c.id, name, phone || null, opt(p.address, 300, 'The address'), opt(p.parish, 40, 'The parish'), p.reminders !== false]);
    return {};
  }));
}
