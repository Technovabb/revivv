// Version 2: booking steps, messages, phone bookings, money, settings, jobs, photos and staff.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, client, booking, workday } from './helpers.js';
import { buildApp } from '../src/app.js';
import { todayISO, addDays } from '../src/rules.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t?.stop(); });

async function staffLogin(email, name, role = 'owner') {
  const c = client(t.app);
  const r = await c.post('/auth/signup', { email, password: 'staff-password-1' });
  if (r.status === 422) await c.post('/auth/signin', { email, password: 'staff-password-1' });
  await t.pool.query('insert into staff (user_id, name, role) select id, $2, $3 from users where email = $1 on conflict (user_id) do update set role = excluded.role',
    [email, name, role]);
  return c;
}
const outbox = async (kind, to) => (await t.pool.query('select * from outbox where kind = $1 and ($2::text is null or to_addr = $2) order by id', [kind, to ?? null])).rows;
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data; };

test('a booking goes through its steps, with emails, timeline and conversation lines', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const made = ok(await client(t.app).rpc('create_booking', booking({ p_date: workday(1), p_slot: 'afternoon', p_email: 'kim@example.com', p_location: 'Mobile — we come to them', p_address: '2 Rock Rd' })));
  assert.match(made.ref, /^RV-\d{6}-\d{4}$/);
  assert.equal((await outbox('requested', 'kim@example.com')).length, 1);
  assert.equal((await outbox('staff_new_booking', 'nick@revivvbb.com')).length, 1);

  // the customer's link from the email
  const guest = client(t.app);
  let view = ok(await guest.rpc('booking_view', { ref: made.ref, k: made.key }));
  assert.equal(view.booking.status, 'requested');
  assert.equal(view.booking.steps.map(s => s.key).join(), 'requested,confirmed,on_the_way,in_progress,completed');
  assert.equal(view.messages.length, 1);
  assert.equal((await guest.rpc('booking_view', { ref: made.ref, k: 'x'.repeat(made.key.length) })).status, 404);

  ok(await owner.rpc('staff_act', { ref: made.ref, action: 'confirm' }));
  assert.equal((await outbox('confirmed', 'kim@example.com')).length, 1);
  assert.equal((await owner.rpc('staff_act', { ref: made.ref, action: 'confirm' })).status, 400);
  ok(await owner.rpc('staff_move', { ref: made.ref, date: workday(2), slot: 'morning' }));
  assert.equal((await outbox('moved', 'kim@example.com')).length, 1);
  ok(await owner.rpc('staff_act', { ref: made.ref, action: 'on_the_way' }));
  ok(await owner.rpc('staff_act', { ref: made.ref, action: 'start' }));
  ok(await owner.rpc('staff_act', { ref: made.ref, action: 'complete' }));
  const thanks = await outbox('completed', 'kim@example.com');
  assert.match(thanks[0].body, /1 of 6 stamps/);

  const full = ok(await owner.rpc('staff_booking', { ref: made.ref }));
  assert.deepEqual(full.events.map(e => e.kind), ['created', 'confirm', 'moved', 'on_the_way', 'start', 'complete']);
  assert.equal(full.customer.stamps, 1);
  assert.ok(full.checklist.length > 3, 'the package checklist is offered');
  view = ok(await guest.rpc('booking_view', { ref: made.ref, k: made.key }));
  assert.equal(view.booking.status, 'completed');
  assert.equal(view.messages.at(-1).sender, 'system');
  assert.equal(view.customer.stamps, 1);
});

test('customers cancel online only before the cutoff; staff must give a reason', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const far = ok(await client(t.app).rpc('create_booking', booking({ p_date: workday(8), p_email: 'can@example.com' })));
  ok(await client(t.app).rpc('booking_cancel', { ref: far.ref, k: far.key }));
  assert.equal((await outbox('staff_cancelled')).length >= 1, true);
  assert.deepEqual(ok(await client(t.app).rpc('slots_taken', { d: workday(8) })), []);

  const soon = ok(await owner.rpc('staff_create_booking', { name: 'Late Larry', phone: '246 555 0199', email: 'larry@example.com', date: todayISO(), slot: 'late', vehicle_type: 'Car', package: 'The Express Exterior' }));
  const key = (await t.pool.query('select access_key from bookings where ref = $1', [soon.ref])).rows[0].access_key;
  assert.equal((await client(t.app).rpc('booking_cancel', { ref: soon.ref, k: key })).status, 400);
  assert.equal((await owner.rpc('staff_act', { ref: soon.ref, action: 'cancel' })).status, 400);
  ok(await owner.rpc('staff_act', { ref: soon.ref, action: 'cancel', reason: 'Rain' }));
});

test('messages: one conversation per customer, unread counts and email alerts', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const made = ok(await client(t.app).rpc('create_booking', booking({ p_date: workday(5), p_email: 'chat@example.com', p_name: 'Chat Cara' })));
  const guest = client(t.app);
  ok(await guest.rpc('booking_send', { ref: made.ref, k: made.key, body: 'Can you also do the mats?' }));
  ok(await guest.rpc('booking_send', { ref: made.ref, k: made.key, body: 'And the boot please' }));
  assert.equal((await outbox('message_to_staff', 'nick@revivvbb.com')).filter(m => /Chat Cara/.test(m.subject)).length, 1, 'one alert, not two');

  const inbox = ok(await owner.rpc('staff_inbox'));
  const row = inbox.find(x => x.name === 'Chat Cara');
  assert.equal(row.unread, 2);
  const th = ok(await owner.rpc('staff_thread', { customer_id: row.customerId }));
  assert.equal(th.messages.filter(m => m.sender === 'customer').length, 2);
  assert.equal(ok(await owner.rpc('staff_inbox')).find(x => x.name === 'Chat Cara').unread, 0);
  ok(await owner.rpc('staff_send', { customer_id: row.customerId, body: 'Yes, no problem!' }));
  const toCustomer = await outbox('message_to_customer', 'chat@example.com');
  assert.match(toCustomer[0].body, /Nick wrote:\n\nYes, no problem!/);

  const view = ok(await guest.rpc('booking_view', { ref: made.ref, k: made.key }));
  assert.equal(view.unread, 1, 'the staff reply (writing marked the earlier lines read)');
  ok(await guest.rpc('booking_read', { ref: made.ref, k: made.key }));
  assert.equal(ok(await guest.rpc('booking_view', { ref: made.ref, k: made.key })).unread, 0);

  // signed in, the same conversation
  const me = client(t.app);
  await me.post('/auth/signup', { email: 'chat@example.com', password: 'chat-password-1' });
  const mine = ok(await me.rpc('my_thread'));
  assert.equal(mine.messages.filter(m => m.sender === 'staff').length, 1);
  ok(await me.rpc('my_send', { body: 'Thanks!' }));
});

test('phone bookings, price changes by hand, and what crew can and cannot do', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const crew = await staffLogin('crew@revivvbb.com', 'Cal Crew', 'crew');
  // no email: a phone-only customer, confirmed straight away
  const b = ok(await crew.rpc('staff_create_booking', { name: 'Walk In Wes', phone: '246 555 7777', date: workday(6), slot: 'morning', vehicle_type: 'SUV', vehicle_desc: 'Blue RAV4', package: 'All-Around Express', addons: 'Pet hair removal', source: 'walk_in' }));
  assert.equal(b.total, 150 + 25);
  const row = (await t.pool.query('select status, source, email, vehicle_id from bookings where ref = $1', [b.ref])).rows[0];
  assert.deepEqual({ ...row, vehicle_id: !!row.vehicle_id }, { status: 'confirmed', source: 'walk_in', email: null, vehicle_id: true });

  assert.equal((await crew.rpc('staff_edit', { ref: b.ref, total: 100, price_note: 'friend' })).status, 403);
  assert.equal((await owner.rpc('staff_edit', { ref: b.ref, total: 100 })).status, 400, 'a reason is needed');
  ok(await owner.rpc('staff_edit', { ref: b.ref, total: 100, price_note: 'Regular, agreed price' }));
  // changing the package reprices
  const e = ok(await crew.rpc('staff_edit', { ref: b.ref, package: 'The Express Exterior', addons: '' }));
  assert.equal(e.total, 110);

  for (const name of ['report', 'settings_get', 'team_list', 'payments_list', 'outbox_list']) {
    assert.equal((await crew.rpc(name)).status, 403, name);
  }
  const ov = ok(await crew.rpc('staff_overview'));
  assert.equal(ov.money, undefined);
  assert.ok(ok(await owner.rpc('staff_overview')).money);
  // Sunday is closed for website bookings but staff can book it
  let sunday = workday(0); while (new Date(sunday + 'T00:00:00Z').getUTCDay() !== 0) sunday = addDays(sunday, 1);
  assert.equal((await client(t.app).rpc('create_booking', booking({ p_date: sunday }))).status, 400);
  ok(await crew.rpc('staff_create_booking', { name: 'Sunday Sam', phone: '246 555 1212', date: sunday, slot: 'morning', vehicle_type: 'Car', package: 'The Express Exterior' }));
});

test('payments, refunds and gift vouchers', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const crew = await staffLogin('crew@revivvbb.com', 'Cal Crew', 'crew');
  const b = ok(await owner.rpc('staff_create_booking', { name: 'Pay Pat', phone: '246 555 3434', date: workday(7), slot: 'late', vehicle_type: 'Car', package: 'The Express Exterior' }));
  ok(await crew.rpc('staff_payment_add', { ref: b.ref, amount: 50, method: 'cash' }));
  assert.equal((await crew.rpc('staff_payment_add', { ref: b.ref, amount: -10, method: 'cash' })).status, 403);

  const v = ok(await owner.rpc('voucher_create', { amount: 30, paid_method: 'card', recipient: 'Pat' }));
  assert.match(v.code, /^RVG-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal((await crew.rpc('staff_payment_add', { ref: b.ref, amount: 40, method: 'voucher', voucher_code: v.code })).status, 400);
  ok(await crew.rpc('staff_payment_add', { ref: b.ref, amount: 30, method: 'voucher', voucher_code: v.code.toLowerCase() }));
  assert.equal(ok(await crew.rpc('staff_voucher_check', { code: v.code })).balance, 0);
  ok(await owner.rpc('staff_payment_add', { ref: b.ref, amount: -5, method: 'cash', note: 'change' }));
  const full = ok(await owner.rpc('staff_booking', { ref: b.ref }));
  assert.equal(full.paid, 75);
  assert.equal(full.owing, 15);

  ok(await owner.rpc('staff_act', { ref: b.ref, action: 'complete' }));
  const rep = ok(await owner.rpc('report', { from: addDays(todayISO(), -1), to: workday(30) }));
  assert.equal(rep.vouchersSold.total, 30);
  assert.ok(rep.taken >= 75, 'cash taken plus the voucher sold, not the voucher spent');
  assert.ok(rep.owing.some(x => x.ref === b.ref && x.owing === 15));
  const csv = await owner.get(`/export/payments.csv?from=${todayISO()}&to=${todayISO()}`);
  assert.equal(csv.status, 200);
});

test('prices, hours and closed days come from the settings', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const s = ok(await owner.rpc('settings_get'));
  const catalog = structuredClone({ packages: s.catalog.packages, addons: s.catalog.addons });
  catalog.packages[0].prices.Car = 95;
  catalog.addons.push({ name: 'Engine bay clean', price: 35 });
  ok(await owner.rpc('settings_save', { key: 'catalog', value: catalog }));
  const info = ok(await client(t.app).rpc('site_info'));
  assert.equal(info.packages[0].prices.Car, 95);
  assert.ok(info.addons.some(a => a.name === 'Engine bay clean'));
  const r = ok(await client(t.app).rpc('create_booking', booking({ p_date: workday(9), p_slot: 'late', p_email: 'price@example.com', p_addons: 'Engine bay clean' })));
  assert.equal(r.total, 130);
  catalog.packages[0].name = 'Something else';
  assert.equal((await owner.rpc('settings_save', { key: 'catalog', value: catalog })).status, 400);

  const day = workday(11);
  ok(await owner.rpc('closed_day_add', { day, reason: 'Kadooment' }));
  assert.equal(ok(await client(t.app).rpc('slots_taken', { d: day })).length, 4);
  const refused = await client(t.app).rpc('create_booking', booking({ p_date: day, p_email: 'closed@example.com' }));
  assert.match(refused.body.error.message, /closed.*Kadooment/);
  ok(await owner.rpc('closed_day_remove', { day }));
  assert.ok((await t.pool.query("select 1 from audit_log where action = 'closed_day.added'")).rowCount);
});

test('reminders the day before and a note when the next detail is due', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const tomorrow = addDays(todayISO(), 1);
  const b = ok(await owner.rpc('staff_create_booking', { name: 'Remi Nder', phone: '246 555 4545', email: 'remi@example.com', date: tomorrow, slot: 'priority', vehicle_type: 'Car', package: 'The Express Exterior' }));
  const at = h => new Date(`${todayISO()}T${String(h).padStart(2, '0')}:00:00-04:00`);
  assert.equal(await t.jobs.reminders(at(8)), 0, 'not before 10am');
  assert.ok(await t.jobs.reminders(at(11)) >= 1);
  assert.equal(await t.jobs.reminders(at(12)), 0, 'only once');
  assert.equal((await outbox('reminder', 'remi@example.com')).length, 1);

  // a detail done 50 days ago, nothing booked since: one nudge, then none
  const old = ok(await owner.rpc('staff_create_booking', { name: 'Old Olive', phone: '246 555 5656', email: 'olive@example.com', date: workday(12), slot: 'late', vehicle_type: 'Car', package: 'The Express Exterior' }));
  ok(await owner.rpc('staff_act', { ref: old.ref, action: 'complete' }));
  await t.pool.query("update bookings set booking_date = $2, completed_at = now() - interval '50 days' where ref = $1", [old.ref, addDays(todayISO(), -50)]);
  await t.jobs.nudges(at(11));
  assert.equal((await outbox('nudge', 'olive@example.com')).length, 1);
  await t.jobs.nudges(at(11));
  assert.equal((await outbox('nudge', 'olive@example.com')).length, 1);
  assert.equal(b.ref.length, 14);
});

test('sign in with an emailed code', async () => {
  const c = client(t.app);
  ok(await c.post('/auth/code', { email: 'Coder@Example.com' }));
  const mail = t.mail.at(-1);
  const code = mail.subject.slice(0, 6);
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.match((await c.post('/auth/verify', { email: 'coder@example.com', code: wrong })).body.error.message, /4 tries left/);
  ok(await c.post('/auth/verify', { email: 'coder@example.com', code }));
  assert.equal(ok(await c.get('/auth/session')).user.email, 'coder@example.com');
  assert.equal((await c.post('/auth/verify', { email: 'coder@example.com', code })).status, 400, 'used once');
});

test('with no mailbox on the live server, emails are held and codes are off', async () => {
  const mailer = { ready: false, async send() { throw new Error('should not send'); } };
  const app = await buildApp({ config: { ...t.config, production: true }, pool: t.pool, mailer, logger: false });
  try {
    const r = await client(app).rpc('create_booking', booking({ p_date: workday(13), p_email: 'held@example.com' }));
    assert.equal(r.status, 200);
    assert.equal((await outbox('requested', 'held@example.com'))[0].status, 'held');
    assert.equal((await client(app).post('/auth/code', { email: 'held@example.com' })).status, 400);
    assert.equal(await app.services.outbox.sendDue(), 0);
  } finally {
    await app.close();
  }
});

test('job photos: staff upload, staff and the customer can see them, nobody else', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const made = ok(await client(t.app).rpc('create_booking', booking({ p_date: workday(14), p_email: 'photo@example.com' })));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');
  assert.equal((await client(t.app).post('/photos', { ref: made.ref, kind: 'before', data: jpeg })).status, 401);
  assert.equal((await owner.post('/photos', { ref: made.ref, kind: 'before', data: Buffer.from('hello').toString('base64') })).status, 400);
  const up = ok(await owner.post('/photos', { ref: made.ref, kind: 'damage', caption: 'Scratch on the rear door', data: 'data:image/jpeg;base64,' + jpeg }));
  assert.equal((await owner.get(`/photos/${up.id}`)).status, 200);
  assert.equal((await client(t.app).get(`/photos/${up.id}`)).status, 404);
  assert.equal((await client(t.app).get(`/photos/${up.id}?k=${made.key}`)).status, 200);
  const view = ok(await client(t.app).rpc('booking_view', { ref: made.ref, k: made.key }));
  assert.equal(view.booking.photos[0].caption, 'Scratch on the rear door');
});

test('owners manage staff; there is always an owner', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const added = ok(await owner.rpc('team_save', { email: 'new.crew@example.com', name: 'New Crew', role: 'crew' }));
  const team = ok(await owner.rpc('team_list'));
  assert.ok(team.some(x => x.email === 'new.crew@example.com' && x.role === 'crew' && !x.hasPassword));
  assert.match(ok(await owner.rpc('team_link', { id: added.id })).link, /type=recovery&token=/);
  ok(await owner.rpc('team_remove', { id: added.id }));
  const me = team.find(x => x.email === 'nick@revivvbb.com');
  assert.equal((await owner.rpc('team_remove', { id: me.id })).status, 400);
  assert.ok(ok(await owner.rpc('audit_list')).some(a => a.action === 'staff.removed'));
});

test('customers and cars in the back office', async () => {
  const owner = await staffLogin('nick@revivvbb.com', 'Nick Stapleton');
  const c = ok(await owner.rpc('staff_customer_save', { name: 'Card Carl', phone: '246 555 8888', notes: 'Prefers mornings' }));
  ok(await owner.rpc('staff_vehicle_save', { customer_id: c.id, type: 'Truck', description: 'Hilux 2020', plate: 'P 1234' }));
  const found = ok(await owner.rpc('staff_customers', { q: 'P 1234' }));
  assert.equal(found[0].name, 'Card Carl');
  const full = ok(await owner.rpc('staff_customer', { id: c.id }));
  assert.equal(full.vehicles[0].description, 'Hilux 2020');
  assert.equal(full.notes, 'Prefers mornings');
  const b = ok(await owner.rpc('staff_create_booking', { customer_id: c.id, date: workday(15), slot: 'morning', vehicle_type: 'Truck', vehicle_id: full.vehicles[0].id, package: 'Supreme Auto Valet' }));
  assert.equal(b.total, 300);
  ok(await owner.rpc('owner_adjust', { customer_id: c.id, stamps: 3, credit_change: 10, reason: 'Moved from the paper card' }));
  assert.deepEqual([ok(await owner.rpc('staff_customer', { id: c.id })).stamps, ok(await owner.rpc('staff_customer', { id: c.id })).credit], [3, 10]);
});
