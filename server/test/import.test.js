import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startTestServer, client, workday } from './helpers.js';
import { readCopyBlocks, planImport, writeImport } from '../src/import-supabase.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t?.stop(); });

// A cut-down Supabase dump in the same COPY format, with the old layout.
function oldDump(hash) {
  const row = (...v) => v.map(x => (x === null ? '\\N' : x)).join('\t');
  return [
    '-- PostgreSQL database cluster dump',
    'COPY auth.users (id, email, encrypted_password, created_at, deleted_at, is_anonymous) FROM stdin;',
    row('u1', 'Ana@Example.com', hash, '2026-07-01 10:00:00+00', null, 'f'),
    row('u2', 'boss@revivvbb.com', hash, '2026-07-01 10:00:00+00', null, 'f'),
    row('u3', 'gone@example.com', hash, '2026-07-01 10:00:00+00', '2026-08-01 10:00:00+00', 'f'),
    '\\.',
    'COPY public.staff (user_id, name) FROM stdin;',
    row('u2', null),
    '\\.',
    'COPY public.customers (id, user_id, name, email, phone, referral_code, referred_by, created_at) FROM stdin;',
    row('c1', 'u1', 'Ana Best', 'ana@example.com', '246 555 0101', 'REVIVV-ABC12', null, '2026-07-01 10:00:00+00'),
    row('c2', null, 'Ben Cole', 'ben@example.com', '246 555 0102', null, 'c1', '2026-07-02 10:00:00+00'),
    '\\.',
    'COPY public.bookings (id, customer_id, booking_date, slot, status, vehicle_type, vehicle_description, package, addons, total, service_location, parish, address, notes, created_at) FROM stdin;',
    row('b1', 'c1', '2026-07-14', 'late', 'completed', 'SUV', 'Blue RAV4', 'The Express Exterior', null, '150.00', 'Mobile — we come to them', 'St. James', null, 'Gate code\\t12\\nRing twice', '2026-07-10 10:00:00+00'),
    row('b2', 'c2', '2026-07-20', 'morning', 'completed', 'Car', null, 'The Express Exterior', null, '90.00', null, null, null, null, '2026-07-15 10:00:00+00'),
    row('b3', 'c2', workday(2), 'afternoon', 'confirmed', 'Car', null, 'The Express Exterior', null, '90.00', null, null, null, null, '2026-07-21 10:00:00+00'),
    row('b4', 'c1', '2026-07-30', 'morning', 'no_show', 'Car', null, 'The Express Exterior', null, '90.00', null, null, null, null, '2026-07-21 10:00:00+00'),
    '\\.',
    'COPY public.stamps (id, customer_id, booking_id, awarded_at, redeemed_at) FROM stdin;',
    row('s1', 'c1', 'b1', '2026-07-14 18:00:00+00', null),
    row('s2', 'c1', null, '2026-06-01 18:00:00+00', null),
    row('s3', 'c1', null, '2026-05-01 18:00:00+00', '2026-06-01 18:00:00+00'),
    row('s4', 'c2', 'b2', '2026-07-20 12:00:00+00', null),
    '\\.',
    'COPY public.credits (id, customer_id, amount, reason, booking_id, created_at) FROM stdin;',
    row('k1', 'c1', '25.00', 'Referral bonus', 'b2', '2026-07-20 12:00:00+00'),
    row('k2', 'c2', '25.00', 'Referral bonus (referred by a friend)', 'b2', '2026-07-20 12:00:00+00'),
    '\\.',
    ''
  ].join('\n');
}

test('the old Supabase data comes across with stamps, credit, referrals and passwords', async () => {
  const hash = bcrypt.hashSync('old-password-1', 4);
  const plan = planImport(readCopyBlocks(oldDump(hash)));
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.users.length, 2, 'deleted logins are left behind');
  await writeImport(t.pool, plan);

  const [ana, ben] = (await t.pool.query('select * from customers order by name')).rows;
  assert.equal(ana.stamps, 2, 'only stamps not yet redeemed');
  assert.equal(ana.credit, 25);
  assert.equal(ana.referral_code, 'REVIVV-ABC12');
  assert.equal(ben.referred_by, ana.id);
  assert.ok(ben.referral_paid_at, 'the old system already paid this referral');
  assert.match(ben.referral_code, /^REVIVV-[0-9A-F]{5}$/);

  const b = (await t.pool.query('select * from bookings order by booking_date')).rows;
  assert.deepEqual(b.map(x => x.status), ['completed', 'completed', 'cancelled', 'booked']);
  assert.equal(b[0].notes, 'Gate code\t12\nRing twice');
  assert.equal(b[0].name, 'Ana Best');
  assert.equal(b[0].total, 150);
  assert.ok(b[0].completed_at);

  const staff = (await t.pool.query('select s.name from staff s join users u on u.id = s.user_id')).rows;
  assert.deepEqual(staff, [{ name: 'boss' }], 'a staff member with no name gets one from their email');

  // Ana signs in with her old password and sees her card and history.
  const c = client(t.app);
  assert.equal((await c.post('/auth/signin', { email: 'ana@example.com', password: 'old-password-1' })).status, 200);
  const me = (await c.rpc('my_account')).body.data;
  assert.equal(me.stamps, 2);
  assert.equal(me.credit, 25);
  assert.equal(me.history.length, 1);
  assert.match((await t.pool.query("select password_hash from users where email = 'ana@example.com'")).rows[0].password_hash, /^scrypt\$/);

  // The imported booking still holds its slot.
  const taken = (await client(t.app).rpc('slots_taken', { d: workday(2) })).body.data;
  assert.ok(taken.some(s => (s.slots_taken ?? s) === 'afternoon'));

  // Staff sign in with their old password. Completing Ben's upcoming detail
  // adds a stamp but doesn't pay the referral a second time.
  const staff1 = client(t.app);
  assert.equal((await staff1.post('/auth/signin', { email: 'boss@revivvbb.com', password: 'old-password-1' })).status, 200);
  const job = (await staff1.rpc('staff_day', { d: workday(2) })).body.data[0];
  assert.equal((await staff1.rpc('complete_booking', { p_booking: job.id })).status, 200);
  const after = (await t.pool.query('select name, stamps, credit from customers order by name')).rows;
  assert.deepEqual(after, [{ name: 'Ana Best', stamps: 2, credit: 25 }, { name: 'Ben Cole', stamps: 2, credit: 25 }]);

  await assert.rejects(writeImport(t.pool, plan), /only runs once/);
});
