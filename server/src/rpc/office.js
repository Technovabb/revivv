/*
 * Back-office calls for all staff (owners and crew): the day's jobs, bookings
 * and their steps, phone bookings, customers and cars, messages, payments and
 * the job card. Money totals are left out for crew.
 */
import { tx } from '../db.js';
import { fail, text, opt, maxLen, posId, money, round2, likeEscape, cleanEmail } from '../util.js';
import * as R from '../rules.js';
import { getSettings, VEHICLE_TYPES } from '../settings.js';
import {
  readBookingInput, checkBooking, customerForEmail, newCustomer, accountState, vehicleFor, visits12,
  bookingView, thread, markRead, postMessage
} from '../shared.js';

const SOURCES = ['phone', 'whatsapp', 'walk_in', 'instagram', 'other'];
const METHODS = ['cash', 'card', 'bank_transfer', 'mobile', 'voucher', 'other'];
const LIVE = ['cancelled', 'no_show'];

export default function officeRpc(r, ctx) {
  const { pool, bookings, audit } = ctx;

  const jobSql = `
    select b.*, c.stamps, c.notes as customer_notes, st.name as assigned_name,
           coalesce((select sum(amount) from payments p where p.booking_id = b.id), 0) as paid,
           (select count(*)::int from booking_photos ph where ph.booking_id = b.id) as photos
      from bookings b join customers c on c.id = b.customer_id
      left join staff st on st.user_id = b.assigned_to`;
  const job = (b, s) => ({
    id: b.id, ref: b.ref, status: b.status, statusLabel: R.STATUS_LABEL[b.status],
    date: b.booking_date, dateText: R.prettyDate(b.booking_date), slot: b.slot, slotText: R.slotText(s.hours, b.slot),
    name: b.name, phone: b.phone, email: b.email, customerId: b.customer_id, stamps: Math.min(b.stamps, R.MAX_STAMPS),
    package: b.package, addons: b.addons, vehicle: [b.vehicle_type, b.vehicle_desc].filter(Boolean).join(' · '),
    location: b.location, parish: b.parish, address: b.address, notes: b.notes, staffNotes: b.staff_notes,
    total: Number(b.total), paid: Number(b.paid), owing: round2(Number(b.total) - Number(b.paid)),
    assignedTo: b.assigned_to, assignedName: b.assigned_name, source: b.source, photos: b.photos, rewardApplied: b.reward_applied
  });
  const bySlot = (s, a, b) => s.hours.slots.findIndex(x => x.id === a.slot) - s.hours.slots.findIndex(x => x.id === b.slot);

  // Money taken (payments, plus vouchers sold) between two Barbados dates.
  async function taken(db, from, to) {
    const r1 = await db.query(
      `select coalesce(sum(amount), 0) as n from payments
        where method <> 'voucher' and (created_at at time zone '${R.TZ}')::date between $1 and $2`, [from, to]);
    const r2 = await db.query(
      `select coalesce(sum(amount), 0) as n from vouchers
        where voided_at is null and (created_at at time zone '${R.TZ}')::date between $1 and $2`, [from, to]);
    return round2(Number(r1.rows[0].n) + Number(r2.rows[0].n));
  }

  /* ---------- today and the calendar ---------- */
  r.staff('staff_overview', async (p, user) => {
    const s = await getSettings(pool);
    const today = R.todayISO();
    const jobs = (await pool.query(`${jobSql} where b.booking_date = $1 order by b.id`, [today])).rows.sort((a, b) => bySlot(s, a, b));
    const waiting = (await pool.query(`${jobSql} where b.status = 'requested' and b.booking_date >= $1 order by b.booking_date, b.id limit 20`, [today])).rows;
    const tomorrow = R.addDays(today, 1);
    const unconfirmed = (await pool.query("select count(*)::int as n from bookings where status = 'requested' and booking_date = $1", [tomorrow])).rows[0].n;
    const unreadThreads = (await pool.query(
      `select count(distinct m.customer_id)::int as n from messages m
        where m.sender = 'customer' and m.id > coalesce((select last_read_id from message_reads r where r.customer_id = m.customer_id and r.side = 'staff'), 0)`)).rows[0].n;
    const week = (await pool.query(
      `select booking_date as day, count(*)::int as n from bookings
        where booking_date between $1 and $2 and status <> all($3) group by booking_date order by booking_date`,
      [today, R.addDays(today, 6), LIVE])).rows;
    const out = {
      today, todayText: R.prettyDate(today), jobs: jobs.map(b => job(b, s)), waiting: waiting.map(b => job(b, s)),
      unconfirmedTomorrow: unconfirmed, unreadThreads, week, closed: (await pool.query('select reason from closed_days where day = $1', [today])).rows[0] || null
    };
    if (user.owner) {
      const monday = R.addDays(today, -((R.weekday(today) + 6) % 7));
      out.money = {
        today: await taken(pool, today, today), week: await taken(pool, monday, today), month: await taken(pool, today.slice(0, 8) + '01', today),
        owing: Number((await pool.query(
          `select coalesce(sum(b.total - coalesce((select sum(amount) from payments p where p.booking_id = b.id), 0)), 0) as n
             from bookings b where b.status = 'completed'`)).rows[0].n)
      };
      out.heldEmails = (await pool.query("select count(*)::int as n from outbox where status in ('held', 'failed')")).rows[0].n;
    }
    return out;
  });

  r.staff('staff_day', async p => {
    if (!R.isISODate(p.d)) fail(400, 'Pick a valid date.');
    const s = await getSettings(pool);
    const rows = (await pool.query(`${jobSql} where b.booking_date = $1 order by b.id`, [p.d])).rows.sort((a, b) => bySlot(s, a, b));
    return rows.map(b => ({ ...job(b, s), vehicle: job(b, s).vehicle }));
  });

  r.staff('staff_range', async p => {
    const from = p.d_from ?? p.from, to = p.d_to ?? p.to;
    if (!R.isISODate(from) || !R.isISODate(to) || to < from) fail(400, 'Pick a valid date range.');
    if (to > R.addDays(from, 62)) fail(400, 'Pick a shorter date range.');
    const s = await getSettings(pool);
    const rows = (await pool.query(`${jobSql} where b.booking_date between $1 and $2 order by b.booking_date, b.id`, [from, to])).rows;
    return rows.sort((a, b) => a.booking_date.localeCompare(b.booking_date) || bySlot(s, a, b))
      .map(b => ({ ...job(b, s), booking_date: b.booking_date }));
  });

  // The bookings list, with filters.
  r.staff('staff_bookings', async p => {
    const s = await getSettings(pool);
    const where = [], args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('$?', '$' + args.length)); };
    if (R.isISODate(p.from)) add('b.booking_date >= $?', p.from);
    if (R.isISODate(p.to)) add('b.booking_date <= $?', p.to);
    if (p.status === 'open') add('b.status = any($?)', R.OPEN);
    else if (p.status && R.STATUS_LABEL[p.status]) add('b.status = $?', p.status);
    if (p.owing) where.push("b.status = 'completed' and b.total > coalesce((select sum(amount) from payments p where p.booking_id = b.id), 0)");
    const q = maxLen(text(p.q), 100, 'The search');
    if (q) {
      args.push(`%${likeEscape(q)}%`);
      where.push(`(b.name ilike $${args.length} or b.ref ilike $${args.length} or b.email ilike $${args.length} or b.phone ilike $${args.length} or b.vehicle_desc ilike $${args.length})`);
    }
    const order = p.status === 'open' || (R.isISODate(p.from) && !p.to) ? 'b.booking_date, b.id' : 'b.booking_date desc, b.id desc';
    const rows = (await pool.query(`${jobSql} ${where.length ? 'where ' + where.join(' and ') : ''} order by ${order} limit 300`, args)).rows;
    return rows.map(b => job(b, s));
  });

  /* ---------- one booking ---------- */
  r.staff('staff_booking', async (p, user) => {
    const s = await getSettings(pool);
    const b = (await pool.query(`${jobSql} where b.ref = $1`, [text(p.ref).toUpperCase()])).rows[0];
    if (!b) fail(404, 'That booking was not found.');
    const c = (await pool.query('select * from customers where id = $1', [b.customer_id])).rows[0];
    const events = (await pool.query('select kind, actor_name, detail, created_at from booking_events where booking_id = $1 order by id', [b.id])).rows;
    const staff = (await pool.query('select user_id, name, role from staff order by name')).rows;
    const pkg = R.findPackage(s.catalog, b.package, { activeOnly: false });
    let checklist = b.checklist;
    if (!checklist.length && pkg) checklist = pkg.checklist.map(item => ({ item, done: false }));
    const view = await bookingView(pool, b, s, { forStaff: true });
    return {
      ...view, job: job(b, s), source: b.source, quotedTotal: b.quoted_total == null ? null : Number(b.quoted_total), priceNote: b.price_note,
      referralCode: b.referral_code, staffNotes: b.staff_notes, conditionNotes: b.condition_notes, checklist,
      assignedTo: b.assigned_to, vehicleId: b.vehicle_id, events, staff,
      customer: {
        id: c.id, name: c.name, phone: c.phone, email: c.email, notes: c.notes, stamps: Math.min(c.stamps, R.MAX_STAMPS),
        credit: Number(c.credit), ...R.tierFor(await visits12(pool, c.id))
      },
      canEditPrice: user.owner
    };
  });

  r.staff('staff_act', async (p, user) => tx(pool, async db => {
    const action = text(p.action);
    if (action === 'cancel' && !text(p.reason)) fail(400, 'Add a short reason for cancelling.');
    const u = await bookings.act(db, p.ref, action, user, { reason: opt(p.reason, 300, 'The reason'), notify: p.notify !== false });
    return { status: u.status };
  }));

  r.staff('staff_move', async (p, user) => tx(pool, async db => {
    const b = await bookings.lockByRef(db, p.ref);
    if (!['requested', 'confirmed'].includes(b.status)) fail(400, 'Only a requested or confirmed booking can be moved.');
    const s = await getSettings(db);
    if (!R.isISODate(p.date) || p.date < R.todayISO()) fail(400, 'Pick today or a later date.');
    const slot = s.hours.slots.find(x => x.id === p.slot);
    if (!slot) fail(400, 'Pick a time.');
    const pkg = R.findPackage(s.catalog, b.package, { activeOnly: false });
    if (pkg?.long && !slot.long) fail(400, 'That package needs a morning or afternoon slot.');
    if (p.date === b.booking_date && p.slot === b.slot) fail(400, 'That is the same time as now.');
    let u;
    try {
      u = (await db.query('update bookings set booking_date = $2, slot = $3, reminder_sent_at = null where id = $1 returning *', [b.id, p.date, p.slot])).rows[0];
    } catch (e) {
      if (e.code === '23505') fail(409, 'That slot is already booked. Pick another.');
      throw e;
    }
    const was = `${R.prettyDate(b.booking_date)}, ${R.slotText(s.hours, b.slot)}`;
    const now = `${R.prettyDate(u.booking_date)}, ${R.slotText(s.hours, u.slot)}`;
    await bookings.event(db, b.id, 'moved', user, `${was} → ${now}`);
    await bookings.systemLine(db, u, `Booking moved to ${now}.`);
    if (p.notify !== false) await bookings.emailCustomer(db, 'moved', u);
    return {};
  }));

  // Change what's being done, the car, the address or the notes. Pricing changes reprice the booking.
  r.staff('staff_edit', async (p, user) => tx(pool, async db => {
    const b = await bookings.lockByRef(db, p.ref);
    if (LIVE.includes(b.status)) fail(400, 'A cancelled booking can\'t be changed.');
    const s = await getSettings(db);
    const next = {
      vehicle_type: p.vehicle_type !== undefined ? text(p.vehicle_type) : b.vehicle_type,
      vehicle_desc: p.vehicle_desc !== undefined ? opt(p.vehicle_desc, 120, 'The vehicle description') : b.vehicle_desc,
      package: p.package !== undefined ? text(p.package) : b.package,
      addons: p.addons !== undefined ? opt(p.addons, 300, 'The add-ons') : b.addons,
      location: p.location !== undefined ? (text(p.location) || null) : b.location,
      parish: p.parish !== undefined ? opt(p.parish, 40, 'The parish') : b.parish,
      address: p.address !== undefined ? opt(p.address, 300, 'The address') : b.address,
      notes: p.notes !== undefined ? opt(p.notes, 1000, 'The notes') : b.notes,
      name: p.name !== undefined ? maxLen(text(p.name), 100, 'The name') : b.name,
      phone: p.phone !== undefined ? maxLen(text(p.phone), 40, 'The phone') : b.phone
    };
    if (!next.name) fail(400, 'The name can\'t be empty.');
    if (!VEHICLE_TYPES.includes(next.vehicle_type)) fail(400, 'Pick car, SUV or truck.');
    if (next.location && !R.LOCATIONS.includes(next.location)) fail(400, 'Choose mobile or drop-off.');
    const slot = s.hours.slots.find(x => x.id === b.slot);
    const pkg = R.findPackage(s.catalog, next.package, { activeOnly: false });
    if (!pkg) fail(400, 'Pick a package.');
    if (pkg.long && slot && !slot.long) fail(400, 'That package needs a morning or afternoon slot. Move the booking first.');

    let total = Number(b.total), creditUsed = Number(b.credit_used), changes = [];
    const priced = next.vehicle_type !== b.vehicle_type || next.package !== b.package || (next.addons || '') !== (b.addons || '');
    if (priced) {
      const c = (await db.query('select * from customers where id = $1 for update', [b.customer_id])).rows[0];
      const base = pkg.prices[next.vehicle_type];
      let t = base + R.addonsTotal(s.catalog, next.addons, { activeOnly: false });
      if (b.reward_applied) t -= base * R.REWARD_OFF;
      else t -= base * (await accountState(db, c)).discount;
      t = Math.max(0, Math.round(t));
      if (creditUsed > t) {   // give back credit the cheaper booking no longer needs
        await db.query('update customers set credit = credit + $2 where id = $1', [c.id, round2(creditUsed - t)]);
        creditUsed = t;
      }
      total = Math.max(0, round2(t - creditUsed));
      changes.push(`price $${Number(b.total)} → $${total}`);
    }
    let priceNote = b.price_note;
    if (p.total !== undefined && p.total !== null && p.total !== '') {
      if (!user.owner) fail(403, 'Only the owners can change a price by hand.');
      const t = money(p.total, 'The price');
      if (t < 0) fail(400, 'The price can\'t be below zero.');
      priceNote = opt(p.price_note, 200, 'The reason');
      if (!priceNote) fail(400, 'Add a short reason for the new price.');
      if (t !== total) changes.push(`price set by hand to $${t} (${priceNote})`);
      total = t;
    }
    const vehicle = await vehicleFor(db, b.customer_id, { vehicleId: p.vehicle_id ? posId(p.vehicle_id, 'car') : null, type: next.vehicle_type, description: next.vehicle_desc });
    await db.query(
      `update bookings set vehicle_type = $2, vehicle_desc = $3, package = $4, addons = $5, location = $6, parish = $7, address = $8,
              notes = $9, name = $10, phone = $11, total = $12, credit_used = $13, price_note = $14, vehicle_id = $15 where id = $1`,
      [b.id, next.vehicle_type, vehicle?.description || next.vehicle_desc, next.package, next.addons, next.location, next.parish,
        next.address, next.notes, next.name, next.phone, total, creditUsed, priceNote, vehicle?.id || b.vehicle_id]);
    for (const k of ['package', 'vehicle_type', 'addons', 'address']) {
      if ((next[k] || '') !== (b[k] || '')) changes.push(`${k.replace('_', ' ')}: ${b[k] || '—'} → ${next[k] || '—'}`);
    }
    if (changes.length) await bookings.event(db, b.id, 'edited', user, changes.join('; ').slice(0, 500));
    return { total };
  }));

  r.staff('staff_job', async (p, user) => tx(pool, async db => {
    const b = await bookings.lockByRef(db, p.ref);
    const sets = [], args = [b.id];
    const set = (col, v) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    if (p.checklist !== undefined) {
      if (!Array.isArray(p.checklist) || p.checklist.length > 30) fail(400, 'The checklist is not valid.');
      set('checklist', JSON.stringify(p.checklist.map(x => ({ item: maxLen(text(x?.item), 80, 'A checklist line'), done: !!x?.done })).filter(x => x.item)));
    }
    if (p.condition_notes !== undefined) set('condition_notes', opt(p.condition_notes, 2000, 'The condition notes'));
    if (p.staff_notes !== undefined) set('staff_notes', opt(p.staff_notes, 2000, 'The staff notes'));
    if (p.assigned_to !== undefined) {
      const id = p.assigned_to ? posId(p.assigned_to, 'staff member') : null;
      if (id && !(await db.query('select 1 from staff where user_id = $1', [id])).rowCount) fail(400, 'That person is not on the staff list.');
      set('assigned_to', id);
      const who = id ? (await db.query('select name from staff where user_id = $1', [id])).rows[0].name : null;
      await bookings.event(db, b.id, 'assigned', user, who ? `Assigned to ${who}` : 'Unassigned');
    }
    if (!sets.length) return {};
    await db.query(`update bookings set ${sets.join(', ')} where id = $1`, args);
    return {};
  }));

  /* ---------- phone, WhatsApp and walk-in bookings ---------- */
  r.staff('staff_create_booking', async (p, user) => {
    const s = await getSettings(pool);
    let c0 = null;
    if (p.customer_id) {
      c0 = (await pool.query('select * from customers where id = $1', [posId(p.customer_id, 'customer')])).rows[0];
      if (!c0) fail(404, 'That customer was not found.');
    }
    const input = readBookingInput({ ...p, name: p.name || c0?.name, email: p.email ?? c0?.email ?? '', phone: p.phone || c0?.phone || '' });
    const slot = await checkBooking(pool, input, s, { staff: true });
    const source = SOURCES.includes(p.source) ? p.source : 'phone';
    const status = p.status === 'requested' ? 'requested' : 'confirmed';
    if (p.total != null && p.total !== '' && !user.owner) fail(403, 'Only the owners can set a price by hand.');

    return tx(pool, async db => {
      let c = c0 ? (await db.query('select * from customers where id = $1 for update', [c0.id])).rows[0]
        : await customerForEmail(db, input.email, true);
      if (!c) c = await newCustomer(db, { email: input.email, name: input.name, phone: input.phone, address: input.address, parish: input.parish });
      const account = p.use_rewards === false ? null : await accountState(db, c);
      if (slot.goldOnly && account?.tier !== 'Gold' && !user.owner) fail(400, 'The priority slot is for Gold members.');
      const price = R.priceBooking({ catalog: s.catalog, pkg: input.pkg, vehicle: input.vehicleType, addons: input.addons, account, activeOnly: false });
      let total = price.total, priceNote = null;
      if (p.total != null && p.total !== '') {
        total = money(p.total, 'The price');
        priceNote = opt(p.price_note, 200, 'The reason');
        if (!priceNote) fail(400, 'Add a short reason for the price.');
      }
      const vehicle = await vehicleFor(db, c.id, { vehicleId: input.vehicleId, type: input.vehicleType, description: input.vehicleDesc });
      const ref = await bookings.newRef(db, R.todayISO());
      let b;
      try {
        b = (await db.query(
          `insert into bookings (ref, customer_id, booking_date, slot, status, confirmed_at, name, email, phone, vehicle_type, vehicle_desc, vehicle_id,
             package, addons, total, quoted_total, reward_applied, credit_used, location, parish, address, notes, source, price_note, staff_notes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24) returning *`,
          [ref, c.id, input.date, input.slot, status, status === 'confirmed' ? new Date() : null, input.name, input.email || c.email || null,
            input.phone || c.phone || '', input.vehicleType, vehicle?.description || input.vehicleDesc, vehicle?.id || null, input.pkg, input.addons,
            total, price.rewardApplied, price.creditUsed, input.location, input.parish, input.address, input.notes, source, priceNote,
            opt(p.staff_notes, 2000, 'The staff notes')])).rows[0];
      } catch (e) {
        if (e.code === '23505' && e.constraint === 'bookings_one_per_slot') fail(409, 'That slot is already booked. Pick another.');
        throw e;
      }
      if (price.creditUsed > 0) await db.query('update customers set credit = credit - $2 where id = $1', [c.id, price.creditUsed]);
      if (p.notify === false) b = { ...b, email: null };   // nothing to the customer
      await bookings.announce(db, b, user);
      return { ref: b.ref, total: Number(b.total) };
    });
  });

  /* ---------- customers ---------- */
  const customerSql = `
    with v as (
      select customer_id,
             count(*) filter (where status = 'completed' and booking_date > $1::date - interval '12 months')::int as visits,
             count(*) filter (where status = 'completed')::int as details,
             max(booking_date) filter (where status = 'completed') as last_visit,
             min(booking_date) filter (where status = any($2) and booking_date >= $1) as next_date
        from bookings group by customer_id
    ), m as (
      select b.customer_id, sum(p.amount) as spend from payments p join bookings b on b.id = p.booking_id group by b.customer_id
    ), o as (
      select b.customer_id, sum(b.total - coalesce((select sum(amount) from payments p where p.booking_id = b.id), 0)) as owing
        from bookings b where b.status = 'completed' group by b.customer_id
    )
    select c.id, c.name, c.phone, c.email, c.stamps, c.credit, c.created_at, c.reminders,
           coalesce(v.visits, 0) as visits, coalesce(v.details, 0) as details, v.last_visit, v.next_date,
           (select slot from bookings x where x.customer_id = c.id and x.status = any($2) and x.booking_date = v.next_date order by x.id limit 1) as next_slot,
           coalesce(m.spend, 0) as spend, greatest(coalesce(o.owing, 0), 0) as owing
      from customers c left join v on v.customer_id = c.id left join m on m.customer_id = c.id left join o on o.customer_id = c.id`;
  const custRow = c => ({
    id: c.id, name: c.name, phone: c.phone || '', email: c.email || '', stamps: Math.min(c.stamps, R.MAX_STAMPS), credit: Number(c.credit),
    visits: c.visits, details: c.details, tier: R.tierFor(c.visits).tier, lastVisit: c.last_visit, nextDate: c.next_date, nextSlot: c.next_slot,
    spend: Number(c.spend), owing: Number(c.owing), reminders: c.reminders
  });

  async function listCustomers(p) {
    const s = await getSettings(pool);
    const today = R.todayISO();
    const q = maxLen(text(p.q ?? ''), 100, 'The search');
    const args = [today, R.OPEN], where = [];
    if (q) {
      args.push(`%${likeEscape(q)}%`, q.replace(/\D/g, ''));
      where.push(`(c.name ilike $3 or c.email ilike $3 or (length($4) >= 3 and regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') like '%' || $4 || '%')
                  or exists (select 1 from vehicles x where x.customer_id = c.id and (x.description ilike $3 or x.plate ilike $3)))`);
    }
    if (p.filter === 'upcoming') where.push('v.next_date is not null');
    if (p.filter === 'owing') where.push('coalesce(o.owing, 0) > 0');
    if (p.filter === 'due') {
      args.push(R.addDays(today, -(s.business.nudgeAfterDays || 42)));
      where.push(`v.next_date is null and v.last_visit <= $${args.length}`);
    }
    if (p.filter === 'top') where.push('coalesce(m.spend, 0) > 0');
    const order = p.filter === 'top' ? 'spend desc' : p.filter === 'due' ? 'v.last_visit' : 'lower(c.name)';
    const rows = (await pool.query(`${customerSql} ${where.length ? 'where ' + where.join(' and ') : ''} order by ${order} limit 300`, args)).rows;
    return rows.map(custRow);
  }
  r.staff('staff_customers', listCustomers);
  // Kept for the first staff console's search box.
  r.staff('staff_find_customers', async p => (await listCustomers({ q: p.q }))
    .map(c => ({ ...c, last_visit: c.lastVisit, next_date: c.nextDate, next_slot: c.nextSlot })));

  r.staff('staff_customer', async p => {
    const id = posId(p.id, 'customer');
    const s = await getSettings(pool);
    const c = (await pool.query(`${customerSql} where c.id = $3`, [R.todayISO(), R.OPEN, id])).rows[0];
    if (!c) fail(404, 'That customer was not found.');
    const full = (await pool.query('select * from customers where id = $1', [id])).rows[0];
    const list = (await pool.query(`${jobSql} where b.customer_id = $1 order by b.booking_date desc, b.id desc limit 200`, [id])).rows;
    const vehicles = (await pool.query(
      `select v.*, (select count(*)::int from bookings b where b.vehicle_id = v.id and b.status = 'completed') as details
         from vehicles v where v.customer_id = $1 and v.archived_at is null order by v.id`, [id])).rows;
    const referredBy = full.referred_by ? (await pool.query('select id, name from customers where id = $1', [full.referred_by])).rows[0] : null;
    const referred = (await pool.query('select id, name, referral_paid_at from customers where referred_by = $1 order by id', [id])).rows;
    const account = (await pool.query('select 1 from users where lower(email) = lower($1)', [full.email || ''])).rowCount > 0;
    return {
      ...custRow(c), address: full.address, parish: full.parish, notes: full.notes, referralCode: full.referral_code, since: full.created_at,
      hasAccount: account, referredBy, referred, vehicles, bookings: list.map(b => job(b, s))
    };
  });

  r.staff('staff_customer_save', async (p, user) => tx(pool, async db => {
    const name = maxLen(text(p.name), 100, 'The name');
    if (!name) fail(400, 'Enter the customer\'s name.');
    const rawEmail = text(p.email), email = cleanEmail(rawEmail);
    if (rawEmail && !email) fail(400, 'That email address doesn\'t look right.');
    const phone = maxLen(text(p.phone), 40, 'The phone');
    const fields = [name, email || null, phone || null, opt(p.address, 300, 'The address'), opt(p.parish, 40, 'The parish'), opt(p.notes, 2000, 'The notes'), p.reminders !== false];
    if (email) {
      const other = (await db.query('select id, name from customers where lower(email) = $1 and id <> $2', [email, p.id ? Number(p.id) : 0])).rows[0];
      if (other) fail(409, `${other.name} already uses that email.`);
    }
    if (p.id) {
      const id = posId(p.id, 'customer');
      const u = await db.query('update customers set name = $2, email = $3, phone = $4, address = $5, parish = $6, notes = $7, reminders = $8 where id = $1', [id, ...fields]);
      if (!u.rowCount) fail(404, 'That customer was not found.');
      await audit(db, user, 'customer.updated', `${name} (#${id})`);
      return { id };
    }
    if (!email && !phone) fail(400, 'Add a phone number or an email.');
    const c = await newCustomer(db, { email, name, phone });
    await db.query('update customers set address = $2, parish = $3, notes = $4, reminders = $5 where id = $1', [c.id, fields[3], fields[4], fields[5], fields[6]]);
    await audit(db, user, 'customer.added', `${name} (#${c.id})`);
    return { id: c.id };
  }));

  r.staff('staff_vehicle_save', async p => {
    const customerId = posId(p.customer_id, 'customer');
    const type = text(p.type);
    if (!VEHICLE_TYPES.includes(type)) fail(400, 'Pick car, SUV or truck.');
    const fields = [type, opt(p.description, 120, 'The make and model'), opt(p.colour, 40, 'The colour'), opt(p.plate, 20, 'The plate'), opt(p.notes, 300, 'The notes')];
    if (!fields[1]) fail(400, 'Add the make and model.');
    if (p.id) {
      const u = await pool.query('update vehicles set type = $3, description = $4, colour = $5, plate = $6, notes = $7 where id = $1 and customer_id = $2',
        [posId(p.id, 'car'), customerId, ...fields]);
      if (!u.rowCount) fail(404, 'That car was not found.');
      return {};
    }
    await pool.query('insert into vehicles (customer_id, type, description, colour, plate, notes) values ($1, $2, $3, $4, $5, $6)', [customerId, ...fields]);
    return {};
  });

  r.staff('staff_vehicle_archive', async p => {
    await pool.query('update vehicles set archived_at = now() where id = $1', [posId(p.id, 'car')]);
    return {};
  });

  /* ---------- messages ---------- */
  r.staff('staff_inbox', async p => {
    const rows = (await pool.query(
      `with last as (
         select distinct on (customer_id) customer_id, sender, body, created_at
           from messages where sender <> 'system' or $1 order by customer_id, id desc
       )
       select c.id, c.name, c.phone, l.sender, l.body, l.created_at,
              (select count(*)::int from messages m where m.customer_id = c.id and m.sender = 'customer'
                  and m.id > coalesce((select last_read_id from message_reads r where r.customer_id = c.id and r.side = 'staff'), 0)) as unread
         from last l join customers c on c.id = l.customer_id
        order by l.created_at desc limit 300`, [!!p.all])).rows;
    return rows.map(x => ({ customerId: x.id, name: x.name, phone: x.phone, lastFrom: x.sender, last: x.body.slice(0, 140), at: x.created_at, unread: x.unread }));
  });

  r.staff('staff_thread', async p => {
    const id = posId(p.customer_id, 'customer');
    const c = (await pool.query('select id, name, phone, email from customers where id = $1', [id])).rows[0];
    if (!c) fail(404, 'That customer was not found.');
    await markRead(pool, id, 'staff');
    const s = await getSettings(pool);
    const open = (await pool.query('select ref, booking_date, slot, status from bookings where customer_id = $1 and status = any($2) order by booking_date', [id, R.OPEN])).rows;
    return {
      customer: c, messages: await thread(pool, id),
      open: open.map(b => ({ ref: b.ref, text: `${R.prettyDate(b.booking_date)}, ${R.slotText(s.hours, b.slot)} (${R.STATUS_LABEL[b.status]})` }))
    };
  });

  r.staff('staff_send', async (p, user) => tx(pool, async db => {
    const c = (await db.query('select * from customers where id = $1', [posId(p.customer_id, 'customer')])).rows[0];
    if (!c) fail(404, 'That customer was not found.');
    let bookingId = null;
    if (p.ref) bookingId = (await db.query('select id from bookings where ref = $1 and customer_id = $2', [text(p.ref).toUpperCase(), c.id])).rows[0]?.id || null;
    await postMessage(db, ctx, { customer: c, from: 'staff', actor: user, body: p.body, bookingId });
    return { messages: await thread(db, c.id) };
  }));

  /* ---------- payments ---------- */
  r.staff('staff_payment_add', async (p, user) => tx(pool, async db => {
    const b = await bookings.lockByRef(db, p.ref);
    const amount = money(p.amount);
    if (amount === 0) fail(400, 'Enter an amount.');
    if (amount < 0 && !user.owner) fail(403, 'Only the owners can record a refund.');
    const method = text(p.method);
    if (!METHODS.includes(method)) fail(400, 'Pick how it was paid.');
    let voucherId = null;
    if (method === 'voucher') {
      if (amount < 0) fail(400, 'A voucher payment can\'t be a refund.');
      const v = (await db.query('select * from vouchers where upper(code) = upper($1) for update', [text(p.voucher_code)])).rows[0];
      if (!v || v.voided_at) fail(400, 'That voucher code was not found.');
      if (v.expires_on && v.expires_on < R.todayISO()) fail(400, `That voucher expired on ${R.prettyDate(v.expires_on)}.`);
      if (Number(v.balance) < amount) fail(400, `That voucher only has $${Number(v.balance)} left.`);
      await db.query('update vouchers set balance = balance - $2 where id = $1', [v.id, amount]);
      voucherId = v.id;
    }
    await db.query('insert into payments (booking_id, amount, method, voucher_id, note, taken_by) values ($1, $2, $3, $4, $5, $6)',
      [b.id, amount, method, voucherId, opt(p.note, 200, 'The note'), user.id]);
    await bookings.event(db, b.id, amount > 0 ? 'payment' : 'refund', user, `$${Math.abs(amount)} ${method.replace('_', ' ')}`);
    return {};
  }));

  r.staff('staff_voucher_check', async p => {
    const v = (await pool.query('select code, balance, expires_on, voided_at, recipient from vouchers where upper(code) = upper($1)', [text(p.code)])).rows[0];
    if (!v || v.voided_at) fail(404, 'That voucher code was not found.');
    return { code: v.code, balance: Number(v.balance), expiresOn: v.expires_on, recipient: v.recipient, expired: !!(v.expires_on && v.expires_on < R.todayISO()) };
  });

  r.staff('staff_photo_delete', async (p, user) => {
    const ph = (await pool.query('select id, taken_by from booking_photos where id = $1', [posId(p.id, 'photo')])).rows[0];
    if (!ph) fail(404, 'That photo was not found.');
    if (!user.owner && ph.taken_by !== user.id) fail(403, 'Only the owners, or whoever took it, can delete a photo.');
    await pool.query('delete from booking_photos where id = $1', [ph.id]);
    return {};   // the file itself is removed by the nightly tidy
  });

  r.staff('staff_names', async () => (await pool.query('select user_id as id, name, role from staff order by name')).rows);

  /* ---------- kept for the first staff console ---------- */
  const legacy = action => async (p, user) => tx(pool, async db => {
    const b = (await db.query('select ref from bookings where id = $1', [posId(p.p_booking, 'booking')])).rows[0];
    if (!b) fail(400, 'That booking is already completed or cancelled.');
    try {
      await bookings.act(db, b.ref, action, user, { reason: action === 'cancel' ? 'Cancelled by staff.' : null });
    } catch (e) {
      if (e.statusCode === 400) fail(400, 'That booking is already completed or cancelled.');
      throw e;
    }
    return { id: Number(p.p_booking) };
  });
  r.staff('complete_booking', legacy('complete'));
  r.staff('cancel_booking', legacy('cancel'));
}
