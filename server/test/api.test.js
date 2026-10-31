import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startTestServer, client, booking, workday, closedDay } from './helpers.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t?.stop(); });

async function makeStaff(email = 'staff@revivvbb.com', name = 'Andre') {
  const c = client(t.app);
  const r = await c.post('/auth/signup', { email, password: 'staff-password-1' });
  if (r.status === 422) await c.post('/auth/signin', { email, password: 'staff-password-1' });
  await t.pool.query('insert into staff (user_id, name) select id, $2 from users where email = $1 on conflict do nothing', [email, name]);
  return c;
}

test('health check answers', async () => {
  const r = await client(t.app).get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('sign up, sign in, sign out, with the messages the pages look for', async () => {
  const c = client(t.app);
  let r = await c.post('/auth/signup', { email: 'Ana@Example.com', password: 'short' });
  assert.equal(r.status, 400);
  r = await c.post('/auth/signup', { email: 'Ana@Example.com', password: 'long-enough-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.email, 'ana@example.com');
  assert.match(r.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
  assert.equal((await c.get('/auth/session')).body.data.user.email, 'ana@example.com');

  r = await client(t.app).post('/auth/signup', { email: 'ana@example.com', password: 'another-pass-1' });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /already registered/i);

  r = await client(t.app).post('/auth/signin', { email: 'ana@example.com', password: 'wrong-password' });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /invalid login/i);
  r = await client(t.app).post('/auth/signin', { email: 'nobody@example.com', password: 'whatever-1' });
  assert.match(r.body.error.message, /invalid login/i);

  await c.post('/auth/signout');
  assert.equal((await c.get('/auth/session')).body.data.user, null);
  r = await c.post('/auth/signin', { email: 'ANA@example.com', password: 'long-enough-1' });
  assert.equal(r.status, 200);
});

test('only the Revivv site may send changes', async () => {
  let r = await client(t.app, null).post('/auth/signin', { email: 'a@b.co', password: 'x' });
  assert.equal(r.status, 403);
  r = await client(t.app, 'https://evil.example').rpc('slots_taken', { d: workday(0) });
  assert.equal(r.status, 403);
  const pre = await t.app.inject({ method: 'OPTIONS', url: '/rpc/slots_taken', headers: { origin: 'https://revivvbb.com', 'access-control-request-method': 'POST' } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://revivvbb.com');
  assert.equal(pre.headers['access-control-allow-credentials'], 'true');
});

test('a booking is priced by the server and takes the slot', async () => {
  const c = client(t.app);
  const d = workday(1);
  let r = await c.rpc('create_booking', booking({ p_date: d, p_vehicle_type: 'SUV', p_addons: 'Pet hair removal, Seat extraction shampoo ×2', p_total: 1 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.total, 110 + 25 + 80);
  const row = (await t.pool.query('select total, quoted_total, status from bookings where id = $1', [r.body.data.id])).rows[0];
  assert.deepEqual(row, { total: 215, quoted_total: 1, status: 'requested' });

  assert.deepEqual((await c.rpc('slots_taken', { d })).body.data, ['morning']);
  r = await c.rpc('create_booking', booking({ p_date: d, p_email: 'other@example.com' }));
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /just taken/i);
});

test('booking rules the pages also check', async () => {
  const c = client(t.app);
  const cases = [
    [{ p_date: closedDay() }, /closed that day/],
    [{ p_date: '2020-01-06' }, /passed/],
    [{ p_package: 'Supreme Auto Valet', p_slot: 'late' }, /morning or afternoon/],
    [{ p_addons: 'Gold plating' }, /Unknown add-on/],
    [{ p_slot: 'priority' }, /Gold members/],
    [{ p_location: 'Mobile — we come to them', p_address: '' }, /address/],
    [{ p_email: 'not-an-email' }, /email/],
    [{ p_package: 'Free wash' }, /package/]
  ];
  for (const [over, msg] of cases) {
    const r = await c.rpc('create_booking', booking({ p_date: workday(2), ...over }));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.body.error.message, msg);
  }
});

test('staff calls need a staff account', async () => {
  const d = workday(3);
  assert.equal((await client(t.app).rpc('staff_day', { d })).status, 401);
  const customer = client(t.app);
  await customer.post('/auth/signup', { email: 'cust3@example.com', password: 'cust-password-1' });
  assert.equal((await customer.rpc('staff_day', { d })).status, 403);
  assert.equal((await customer.get('/staff/me')).body.data, null);

  const staff = await makeStaff();
  const me = (await staff.get('/staff/me')).body.data;
  assert.deepEqual({ ...me, id: typeof me.id }, { id: 'number', name: 'Andre', role: 'owner', email: 'staff@revivvbb.com' });
  await client(t.app).rpc('create_booking', booking({ p_date: d, p_slot: 'late', p_email: 'z@example.com', p_name: 'Zed' }));
  await client(t.app).rpc('create_booking', booking({ p_date: d, p_slot: 'morning', p_email: 'y@example.com', p_name: 'Yan', p_location: 'Mobile — we come to them', p_address: '1 Bay St' }));
  const day = (await staff.rpc('staff_day', { d })).body.data;
  assert.deepEqual(day.map(j => j.slot), ['morning', 'late']);
  assert.equal(day[0].vehicle, 'Car · Grey Corolla');
  assert.equal(day[0].address, '1 Bay St');
  const range = (await staff.rpc('staff_range', { d_from: d, d_to: d })).body.data;
  assert.equal(range[0].booking_date, d);
  assert.equal(range.length, 2);
});

test('stamps, tier, the half-price 6th detail and the card reset', async () => {
  const staff = await makeStaff();
  const email = 'loyal@example.com';
  for (let i = 0; i < 5; i++) {
    const r = await client(t.app).rpc('create_booking', booking({ p_date: workday(10 + i), p_slot: 'afternoon', p_email: email, p_name: 'Lee Loyal' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await staff.rpc('complete_booking', { p_booking: String(r.body.data.id) })).status, 200);
  }
  const me = client(t.app);
  await me.post('/auth/signup', { email, password: 'loyal-password-1' });
  let acct = (await me.rpc('my_account')).body.data;
  assert.equal(acct.name, 'Lee Loyal');
  assert.equal(acct.stamps, 5);
  assert.equal(acct.tier, 'Silver');
  assert.equal(acct.discount, 0.05);
  assert.equal(acct.history.length, 5);
  assert.equal(acct.history[0].job.split(' — ')[0], 'The Express Exterior');
  assert.equal(acct.history[0].paid, 90);
  assert.match(acct.referral, /^REVIVV-[A-Z]{2}\d{3}$/);
  assert.match(acct.since, /^[A-Z][a-z]{2} \d{4}$/);

  // signed in, the 6th detail is half price (package only), not stacked with Silver
  const r = await me.rpc('create_booking', booking({ p_date: workday(20), p_slot: 'afternoon', p_email: email, p_package: 'Supreme Auto Valet', p_addons: 'Pet hair removal' }));
  assert.equal(r.body.data.total, 120 + 25);
  // typed by someone else (not signed in as the owner): no reward
  const other = await client(t.app).rpc('create_booking', booking({ p_date: workday(21), p_email: email }));
  assert.equal(other.body.data.total, 90);
  await staff.rpc('complete_booking', { p_booking: r.body.data.id });
  acct = (await me.rpc('my_account')).body.data;
  assert.equal(acct.stamps, 0);
  assert.equal((await staff.rpc('complete_booking', { p_booking: r.body.data.id })).status, 400);
});

test('referral credit for both people, spent on a booking and refunded on cancel', async () => {
  const staff = await makeStaff();
  const a = client(t.app);
  await client(t.app).rpc('create_booking', booking({ p_date: workday(30), p_email: 'amy@example.com', p_name: 'Amy Referrer' }));
  await a.post('/auth/signup', { email: 'amy@example.com', password: 'amy-password-1' });
  const code = (await a.rpc('my_account')).body.data.referral;
  assert.equal((await a.rpc('check_referral', { p_code: code.toLowerCase() })).body.data, 'Amy');
  assert.equal((await a.rpc('check_referral', { p_code: 'REVIVV-ZZ000' })).body.data, null);

  const b = await client(t.app).rpc('create_booking', booking({ p_date: workday(31), p_email: 'ben@example.com', p_name: 'Ben New', p_referral: ` ${code.toLowerCase()} ` }));
  await staff.rpc('complete_booking', { p_booking: b.body.data.id });
  assert.equal((await a.rpc('my_account')).body.data.credit, 25);
  const ben = client(t.app);
  await ben.post('/auth/signup', { email: 'ben@example.com', password: 'ben-password-1' });
  assert.equal((await ben.rpc('my_account')).body.data.credit, 25);

  // a second completed detail doesn't pay the referral again
  const b2 = await client(t.app).rpc('create_booking', booking({ p_date: workday(32), p_email: 'ben@example.com' }));
  await staff.rpc('complete_booking', { p_booking: b2.body.data.id });
  assert.equal((await a.rpc('my_account')).body.data.credit, 25);

  const spend = await ben.rpc('create_booking', booking({ p_date: workday(33), p_email: 'ben@example.com' }));
  assert.equal(spend.body.data.total, 65);
  assert.equal((await ben.rpc('my_account')).body.data.credit, 0);
  await staff.rpc('cancel_booking', { p_booking: spend.body.data.id });
  assert.equal((await ben.rpc('my_account')).body.data.credit, 25);
  assert.deepEqual((await ben.rpc('slots_taken', { d: workday(33) })).body.data, []);
});

test('customer search for the staff console', async () => {
  const staff = await makeStaff();
  await client(t.app).rpc('create_booking', booking({ p_date: workday(40), p_email: 'searchme@example.com', p_name: 'Sasha Search', p_phone: '(246) 812-3344' }));
  let found = (await staff.rpc('staff_find_customers', { q: 'sasha' })).body.data;
  assert.equal(found.length, 1);
  assert.equal(found[0].tier, 'Regular');
  assert.equal(found[0].next_date, workday(40));
  assert.equal(found[0].next_slot, 'morning');
  assert.equal(found[0].phone, '(246) 812-3344');
  found = (await staff.rpc('staff_find_customers', { q: '8123344' })).body.data;
  assert.equal(found[0].email, 'searchme@example.com');
  assert.ok((await staff.rpc('staff_find_customers', { q: '' })).body.data.length > 3);
});

test('password reset by email link, used once', async () => {
  const c = client(t.app);
  await c.post('/auth/signup', { email: 'forgot@example.com', password: 'old-password-1' });
  await c.post('/auth/signout');
  t.mail.length = 0;
  let r = await c.post('/auth/reset', { email: 'forgot@example.com', redirectTo: 'https://revivvbb.com/quote.html#rewards' });
  assert.equal(r.status, 200);
  assert.equal(t.mail.length, 1);
  const link = new URL(t.mail[0].text.match(/https:\S+/)[0]);
  assert.equal(link.pathname, '/quote.html');
  assert.equal(link.hash, '#rewards');
  assert.equal(link.searchParams.get('type'), 'recovery');

  r = await c.post('/auth/recover', { token: link.searchParams.get('token') });
  assert.equal(r.status, 200);
  assert.equal((await c.post('/auth/password', { password: 'new-password-1' })).status, 200);
  assert.equal((await client(t.app).post('/auth/signin', { email: 'forgot@example.com', password: 'new-password-1' })).status, 200);
  assert.equal((await client(t.app).post('/auth/recover', { token: link.searchParams.get('token') })).status, 400);

  // a reset can't send people to another website, and unknown emails get the same answer
  await c.post('/auth/reset', { email: 'forgot@example.com', redirectTo: 'https://evil.example/x' });
  assert.match(t.mail.at(-1).text, /https:\/\/revivvbb\.com\/quote\.html\?type=recovery/);
  r = await c.post('/auth/reset', { email: 'nobody-here@example.com' });
  assert.equal(r.status, 200);
});

test('repeated sign-in attempts are slowed down', async () => {
  const c = client(t.limited);
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await c.post('/auth/signin', { email: 'guess@example.com', password: 'guess-' + i })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(400));
  assert.equal(codes[10], 429);
});

test('a Supabase (bcrypt) password still works and is upgraded', async () => {
  const hash = await bcrypt.hash('imported-pass', 10);
  await t.pool.query('insert into users (email, password_hash) values ($1, $2)', ['old@example.com', hash]);
  const r = await client(t.app).post('/auth/signin', { email: 'old@example.com', password: 'imported-pass' });
  assert.equal(r.status, 200);
  const now = (await t.pool.query('select password_hash from users where email = $1', ['old@example.com'])).rows[0].password_hash;
  assert.match(now, /^scrypt\$/);
  assert.equal((await client(t.app).post('/auth/signin', { email: 'old@example.com', password: 'imported-pass' })).status, 200);
});
