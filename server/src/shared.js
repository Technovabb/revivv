// Pieces used by more than one group of calls: customers, booking checks, conversations.
import { fail, text, cleanEmail, maxLen, opt, letters, digits, round2 } from './util.js';
import * as R from './rules.js';
import { emails } from './emails.js';
import { getSettings, VEHICLE_TYPES } from './settings.js';

/* ---------- customers and their reward state ---------- */
export async function visits12(db, customerId, today = R.todayISO()) {
  const r = await db.query(
    "select count(*)::int as n from bookings where customer_id = $1 and status = 'completed' and booking_date > $2::date - interval '12 months'",
    [customerId, today]);
  return r.rows[0].n;
}

export async function accountState(db, c, today = R.todayISO()) {
  const { tier, discount } = R.tierFor(await visits12(db, c.id, today));
  const open = await db.query('select 1 from bookings where customer_id = $1 and status = any($2) and reward_applied limit 1', [c.id, R.OPEN]);
  return { tier, discount, credit: Number(c.credit), rewardAvailable: c.stamps >= R.REWARD_AT && !open.rowCount };
}

export async function newCustomer(db, { email, name, phone, address = null, parish = null }) {
  for (let i = 0; i < 10; i++) {
    const r = await db.query(
      `insert into customers (email, name, phone, referral_code, address, parish) values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing returning *`,
      [email || null, name, phone || null, `REVIVV-${letters(2)}${digits(3)}`, address, parish]);
    if (r.rows[0]) return r.rows[0];
    if (email) {
      const same = (await db.query('select * from customers where lower(email) = $1 for update', [email])).rows[0];
      if (same) return same;   // made by another request a moment ago
    }
  }
  throw new Error('could not make a unique referral code');
}

export async function customerForEmail(db, email, lock = false) {
  if (!email) return null;
  return (await db.query(`select * from customers where lower(email) = lower($1)${lock ? ' for update' : ''}`, [email])).rows[0] || null;
}

// The car on a booking: an existing one by id, or found/added by its description.
export async function vehicleFor(db, customerId, { vehicleId, type, description }) {
  if (vehicleId) {
    const v = (await db.query('select * from vehicles where id = $1 and customer_id = $2 and archived_at is null', [vehicleId, customerId])).rows[0];
    if (!v) fail(400, 'That car is not on this customer\'s list.');
    return v;
  }
  if (!description) return null;
  const same = (await db.query(
    'select * from vehicles where customer_id = $1 and type = $2 and lower(description) = lower($3) and archived_at is null limit 1',
    [customerId, type, description])).rows[0];
  if (same) return same;
  return (await db.query('insert into vehicles (customer_id, type, description) values ($1, $2, $3) returning *',
    [customerId, type, description])).rows[0];
}

/* ---------- checking a booking before it goes in ---------- */
// Website bookings send p_* names; the back office sends plain names.
export function readBookingInput(p) {
  const pick = k => (p[k] !== undefined ? p[k] : p['p_' + k]);
  return {
    name: maxLen(text(pick('name')), 100, 'The name'),
    email: cleanEmail(pick('email')),
    rawEmail: text(pick('email')),
    phone: maxLen(text(pick('phone')), 40, 'The phone number'),
    date: text(pick('date')),
    slot: text(pick('slot')),
    vehicleType: text(pick('vehicle_type')),
    vehicleDesc: opt(pick('vehicle_desc'), 120, 'The vehicle description'),
    vehicleId: pick('vehicle_id') ? Number(pick('vehicle_id')) : null,
    pkg: text(pick('package')),
    addons: opt(pick('addons'), 300, 'The add-ons list'),
    location: text(pick('location')) || null,
    parish: opt(pick('parish'), 40, 'The parish'),
    address: opt(pick('address'), 300, 'The address'),
    notes: opt(pick('notes'), 1000, 'The notes'),
    referral: opt(text(pick('referral')).toUpperCase(), 40, 'The referral code'),
    quoted: p.p_total == null || p.p_total === '' || !Number.isFinite(Number(p.p_total)) ? null : Number(p.p_total)
  };
}

// staff: may book closed days and leave out the email. Throws a 400 with a plain message.
export async function checkBooking(db, b, s, { staff = false } = {}) {
  const phone = s.business.phone;
  if (!b.name) fail(400, 'Please enter the name.');
  if (b.rawEmail && !b.email) fail(400, 'Please enter a valid email address.');
  if (!staff && !b.email) fail(400, 'Please enter a valid email address.');
  if (b.phone.replace(/\D/g, '').length < 7 && !(staff && b.email)) fail(400, 'Please enter a phone number we can reach you on.');
  if (!R.isISODate(b.date)) fail(400, 'Please pick a date.');
  const today = R.todayISO();
  if (b.date < today) fail(400, 'That date has passed. Please pick another.');
  if (b.date > R.addDays(today, s.hours.bookAheadDays)) fail(400, 'Please pick a date closer to today.');
  if (!staff) {
    if (s.hours.closedWeekdays.includes(R.weekday(b.date))) {
      fail(400, R.isSunday(b.date) ? `Sundays are by appointment. Please call ${phone}.` : `We're closed that day. Please pick another, or call ${phone}.`);
    }
    const closed = (await db.query('select reason from closed_days where day = $1', [b.date])).rows[0];
    if (closed) fail(400, `We're closed on that day${closed.reason ? ` (${closed.reason})` : ''}. Please pick another.`);
  }
  const slot = s.hours.slots.find(x => x.id === b.slot && (x.active || staff));
  if (!slot) fail(400, 'Please pick a time.');
  if (!VEHICLE_TYPES.includes(b.vehicleType)) fail(400, 'Please pick your vehicle type.');
  const pkg = R.findPackage(s.catalog, b.pkg, { activeOnly: !staff });
  if (!pkg) fail(400, 'Please pick a package.');
  if (pkg.long && !slot.long) fail(400, 'That package takes longer, so it needs a morning or afternoon slot.');
  if (b.location && !R.LOCATIONS.includes(b.location)) fail(400, 'Please choose mobile or drop-off.');
  if (b.location && b.location.startsWith('Mobile') && !b.address) fail(400, 'Please enter the address for a mobile detail.');
  R.addonsTotal(s.catalog, b.addons, { activeOnly: !staff });   // refuses unknown add-ons
  return slot;
}

/* ---------- the customer's view of one booking ---------- */
export async function bookingView(db, b, s, { forStaff = false } = {}) {
  const payments = (await db.query(
    'select p.id, p.amount, p.method, p.note, p.created_at, s.name as taken_by from payments p left join staff s on s.user_id = p.taken_by where booking_id = $1 order by p.id',
    [b.id])).rows;
  const paid = round2(payments.reduce((sum, p) => sum + Number(p.amount), 0));
  const photos = (await db.query('select id, kind, caption, created_at, taken_by from booking_photos where booking_id = $1 order by id', [b.id])).rows
    .map(({ taken_by, ...ph }) => (forStaff ? { ...ph, takenBy: taken_by } : ph));
  const mobile = !!(b.location && b.location.startsWith('Mobile'));
  const steps = [
    { key: 'requested', label: 'Requested', at: b.created_at },
    { key: 'confirmed', label: 'Confirmed', at: b.confirmed_at }
  ];
  if (mobile || b.on_the_way_at) steps.push({ key: 'on_the_way', label: 'On the way', at: b.on_the_way_at });
  steps.push({ key: 'in_progress', label: 'Started', at: b.started_at }, { key: 'completed', label: 'Done', at: b.completed_at });
  if (b.status === 'cancelled') steps.push({ key: 'cancelled', label: 'Cancelled', at: b.cancelled_at });
  if (b.status === 'no_show') steps.push({ key: 'no_show', label: 'No-show', at: b.no_show_at });
  const start = R.slotStart(s.hours, b.booking_date, b.slot);
  const cancelBy = new Date(start.getTime() - s.business.cancelHours * 3600_000);
  const view = {
    ref: b.ref, status: b.status, statusLabel: R.STATUS_LABEL[b.status],
    date: b.booking_date, dateText: R.prettyDate(b.booking_date), slot: b.slot, slotText: R.slotText(s.hours, b.slot),
    name: b.name, phone: b.phone, email: b.email,
    package: b.package, vehicleType: b.vehicle_type, vehicleDesc: b.vehicle_desc, addons: b.addons,
    location: b.location, mobile, parish: b.parish, address: b.address, notes: b.notes,
    total: Number(b.total), paid, owing: round2(Number(b.total) - paid),
    rewardApplied: b.reward_applied, creditUsed: Number(b.credit_used), cancelReason: b.cancel_reason,
    steps, payments: payments.map(p => ({ id: p.id, amount: Number(p.amount), method: p.method, at: p.created_at, note: forStaff ? p.note : undefined, takenBy: forStaff ? p.taken_by : undefined })),
    photos, createdAt: b.created_at,
    canCancel: (b.status === 'requested' || b.status === 'confirmed') && Date.now() < cancelBy.getTime(),
    cancelBy: cancelBy.toISOString(), cancelHours: s.business.cancelHours
  };
  return view;
}

/* ---------- conversations ---------- */
/*
 * A customer's conversation. With bookingId, only that booking's messages: what
 * someone holding just that booking's email link may read.
 */
export async function thread(db, customerId, { bookingId = null, limit = 300 } = {}) {
  const r = await db.query(
    `select m.id, m.sender, m.sender_name, m.body, m.created_at, b.ref
       from messages m left join bookings b on b.id = m.booking_id
      where m.customer_id = $1 and ($3::bigint is null or m.booking_id = $3) order by m.id desc limit $2`, [customerId, limit, bookingId]);
  return r.rows.reverse().map(m => ({ id: m.id, sender: m.sender, name: m.sender_name, body: m.body, at: m.created_at, ref: m.ref }));
}

// The booking a message without one belongs with: the next open booking, else the latest.
export async function defaultBooking(db, customerId) {
  const r = await db.query(
    `select id from bookings where customer_id = $1
      order by (status = any($2)) desc, case when status = any($2) then booking_date end, id desc limit 1`, [customerId, R.OPEN]);
  return r.rows[0]?.id || null;
}

export async function markRead(db, customerId, side) {
  await db.query(
    `insert into message_reads (customer_id, side, last_read_id)
     values ($1, $2, coalesce((select max(id) from messages where customer_id = $1), 0))
     on conflict (customer_id, side) do update set last_read_id = excluded.last_read_id`, [customerId, side]);
}

// Messages the other side wrote that this side hasn't opened yet (optionally for one booking).
export async function unread(db, customerId, side, bookingId = null) {
  const other = side === 'staff' ? ['customer'] : ['staff', 'system'];
  const r = await db.query(
    `select count(*)::int as n from messages m
      where m.customer_id = $1 and m.sender = any($3) and ($4::bigint is null or m.booking_id = $4)
        and m.id > coalesce((select last_read_id from message_reads where customer_id = $1 and side = $2), 0)`,
    [customerId, side, other, bookingId]);
  return r.rows[0].n;
}

// Where a customer's email should send them to read a message: My Revivv, or the booking's own page.
async function customerLink(db, c, site, bookingId) {
  const hasAccount = c.email && (await db.query('select 1 from users where lower(email) = lower($1)', [c.email])).rowCount;
  if (hasAccount) return `${site}/my-messages.html`;
  const b = bookingId ? (await db.query('select ref, access_key from bookings where id = $1', [bookingId])).rows[0] : null;
  return b ? `${site}/my-booking.html?ref=${b.ref}&k=${b.access_key}` : `${site}/my-messages.html`;
}

/*
 * A new message in a customer's conversation, from the customer or from staff.
 * The other side gets an email, at most one every 10 minutes per conversation.
 */
export async function postMessage(db, ctx, { customer, from, actor, body, bookingId = null }) {
  const clean = text(body);
  if (!clean) fail(400, 'Write a message first.');
  if (clean.length > 2000) fail(400, 'That message is too long. Keep it under 2,000 characters.');
  const name = from === 'staff' ? (actor.name || 'Revivv').split(' ')[0] : customer.name;
  if (!bookingId) bookingId = await defaultBooking(db, customer.id);
  const m = (await db.query(
    'insert into messages (customer_id, booking_id, sender, sender_id, sender_name, body) values ($1, $2, $3, $4, $5, $6) returning id, created_at',
    [customer.id, bookingId, from, actor?.id || null, name, clean])).rows[0];
  await markRead(db, customer.id, from === 'staff' ? 'staff' : 'customer');
  const s = await getSettings(db);
  if (from === 'staff' && customer.email && !(await ctx.outbox.recent(db, customer.id, 'message_to_customer', 10))) {
    const e = emails.message_to_customer(customer, s, ctx.site, { sender_name: name, body: clean, link: await customerLink(db, customer, ctx.site, bookingId) });
    await ctx.outbox.queue(db, { to: customer.email, kind: 'message_to_customer', subject: e.subject, body: e.body, customerId: customer.id });
  }
  if (from === 'customer' && !(await ctx.outbox.recent(db, customer.id, 'message_to_staff', 10))) {
    const e = emails.message_to_staff(customer, s, ctx.site, { body: clean });
    const staff = (await db.query('select u.email from staff st join users u on u.id = st.user_id where st.alerts')).rows;
    for (const st of staff) await ctx.outbox.queue(db, { to: st.email, kind: 'message_to_staff', subject: e.subject, body: e.body, customerId: customer.id });
  }
  return { id: m.id, at: m.created_at };
}
