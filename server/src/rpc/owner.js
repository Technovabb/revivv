/*
 * Owner-only calls: money, vouchers, reports, prices and hours, closed days,
 * staff, the audit log and the email outbox.
 */
import crypto from 'node:crypto';
import { tx } from '../db.js';
import { fail, text, opt, maxLen, posId, money, round2, cleanEmail } from '../util.js';
import * as R from '../rules.js';
import { getSettings, saveSetting } from '../settings.js';
import { newToken } from '../passwords.js';

const METHOD_LABEL = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', mobile: 'Mobile money', voucher: 'Voucher', other: 'Other' };
const day = col => `(${col} at time zone '${R.TZ}')::date`;

function range(p, maxDays = 366) {
  const today = R.todayISO();
  const from = R.isISODate(p.from) ? p.from : today.slice(0, 8) + '01';
  const to = R.isISODate(p.to) ? p.to : today;
  if (to < from) fail(400, 'The end date is before the start date.');
  if (to > R.addDays(from, maxDays)) fail(400, 'Pick a range of a year or less.');
  return { from, to };
}

export default function ownerRpc(r, ctx) {
  const { pool, audit, mailer, outbox } = ctx;

  /* ---------- rewards by hand ---------- */
  r.owner('owner_adjust', async (p, user) => tx(pool, async db => {
    const id = posId(p.customer_id, 'customer');
    const reason = opt(p.reason, 200, 'The reason');
    if (!reason) fail(400, 'Add a short reason.');
    const c = (await db.query('select * from customers where id = $1 for update', [id])).rows[0];
    if (!c) fail(404, 'That customer was not found.');
    const changes = [];
    if (p.stamps !== undefined && p.stamps !== null && p.stamps !== '') {
      const n = Number(p.stamps);
      if (!Number.isInteger(n) || n < 0 || n > R.MAX_STAMPS) fail(400, `Stamps must be 0 to ${R.MAX_STAMPS}.`);
      if (n !== c.stamps) { await db.query('update customers set stamps = $2 where id = $1', [id, n]); changes.push(`stamps ${c.stamps} → ${n}`); }
    }
    if (p.credit_change !== undefined && p.credit_change !== null && p.credit_change !== '') {
      const d = money(p.credit_change, 'The credit change');
      if (Number(c.credit) + d < 0) fail(400, `They only have $${Number(c.credit)} credit.`);
      if (d) { await db.query('update customers set credit = credit + $2 where id = $1', [id, d]); changes.push(`credit ${d > 0 ? '+' : ''}${d}`); }
    }
    if (changes.length) {
      await audit(db, user, 'rewards.adjusted', `${c.name}: ${changes.join(', ')} (${reason})`);
      if (p.tell !== false) {
        await db.query("insert into messages (customer_id, sender, sender_name, body) values ($1, 'system', 'Revivv', $2)",
          [id, `Your rewards were updated: ${changes.join(', ')}. ${reason}`]);
      }
    }
    return {};
  }));

  /* ---------- payments and vouchers ---------- */
  r.owner('payments_list', async p => {
    const { from, to } = range(p);
    const rows = (await pool.query(
      `select p.id, p.amount, p.method, p.note, p.created_at, b.ref, b.name, st.name as taken_by, v.code as voucher
         from payments p join bookings b on b.id = p.booking_id
         left join staff st on st.user_id = p.taken_by left join vouchers v on v.id = p.voucher_id
        where ${day('p.created_at')} between $1 and $2 order by p.id desc limit 1000`, [from, to])).rows;
    return { from, to, payments: rows.map(x => ({ ...x, amount: Number(x.amount), methodLabel: METHOD_LABEL[x.method] })) };
  });

  r.owner('vouchers_list', async () => {
    const rows = (await pool.query('select * from vouchers order by id desc limit 500')).rows;
    return rows.map(v => ({
      id: v.id, code: v.code, amount: Number(v.amount), balance: Number(v.balance), buyer: v.buyer, recipient: v.recipient, note: v.note,
      expiresOn: v.expires_on, paidMethod: v.paid_method, createdAt: v.created_at, voided: !!v.voided_at,
      expired: !!(v.expires_on && v.expires_on < R.todayISO())
    }));
  });

  r.owner('voucher_create', async (p, user) => tx(pool, async db => {
    const amount = money(p.amount);
    if (amount <= 0) fail(400, 'Enter the voucher amount.');
    const paid = text(p.paid_method);
    if (!METHOD_LABEL[paid] || paid === 'voucher') fail(400, 'Pick how the voucher was paid for.');
    const expires = text(p.expires_on);
    if (expires && (!R.isISODate(expires) || expires < R.todayISO())) fail(400, 'Pick an expiry date in the future, or leave it empty.');
    let code;
    for (;;) {
      code = `RVG-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      if (!(await db.query('select 1 from vouchers where upper(code) = $1', [code])).rowCount) break;
    }
    await db.query(
      `insert into vouchers (code, amount, balance, buyer, recipient, note, expires_on, paid_method, created_by)
       values ($1, $2, $2, $3, $4, $5, $6, $7, $8)`,
      [code, amount, opt(p.buyer, 100, 'The buyer'), opt(p.recipient, 100, 'Who it is for'), opt(p.note, 300, 'The note'), expires || null, paid, user.id]);
    await audit(db, user, 'voucher.sold', `${code} $${amount}`);
    return { code };
  }));

  r.owner('voucher_void', async (p, user) => tx(pool, async db => {
    const v = (await db.query('update vouchers set voided_at = now() where id = $1 and voided_at is null returning code', [posId(p.id, 'voucher')])).rows[0];
    if (!v) fail(404, 'That voucher was not found.');
    await audit(db, user, 'voucher.voided', v.code);
    return {};
  }));

  /* ---------- reports ---------- */
  r.owner('report', async p => {
    const { from, to } = range(p);
    const q = async (sql, args = [from, to]) => (await pool.query(sql, args)).rows;
    const byMethod = await q(`select method, sum(amount) as total, count(*)::int as n from payments where method <> 'voucher' and ${day('created_at')} between $1 and $2 group by method order by total desc`);
    const vouchersSold = await q(`select coalesce(sum(amount), 0) as total, count(*)::int as n from vouchers where voided_at is null and ${day('created_at')} between $1 and $2`);
    const byDay = await q(
      `select d::date as day, coalesce((select sum(amount) from payments where method <> 'voucher' and ${day('created_at')} = d::date), 0)
              + coalesce((select sum(amount) from vouchers where voided_at is null and ${day('created_at')} = d::date), 0) as taken,
              (select count(*)::int from bookings where status = 'completed' and booking_date = d::date) as jobs
         from generate_series($1::date, $2::date, interval '1 day') d order by d`);
    const statuses = await q(`select status, count(*)::int as n, sum(total) as value from bookings where booking_date between $1 and $2 group by status`);
    const byPackage = await q(`select package, count(*)::int as n, sum(total) as value from bookings where status = 'completed' and booking_date between $1 and $2 group by package order by n desc`);
    const byWeekday = await q(`select extract(dow from booking_date)::int as dow, count(*)::int as n from bookings where status = 'completed' and booking_date between $1 and $2 group by 1 order by 1`);
    const bySlot = await q(`select slot, count(*)::int as n from bookings where status = 'completed' and booking_date between $1 and $2 group by slot`);
    const bySource = await q(`select source, count(*)::int as n from bookings where status <> 'cancelled' and booking_date between $1 and $2 group by source order by n desc`);
    const addons = await q(`select trim(regexp_replace(a, '\\s*[×x]\\s*[1-4]$', '')) as addon, count(*)::int as n
                              from bookings, unnest(string_to_array(addons, ',')) a
                             where status = 'completed' and booking_date between $1 and $2 and addons is not null group by 1 order by n desc`);
    const customers = await q(
      `with firsts as (select customer_id, min(booking_date) as first from bookings where status = 'completed' group by customer_id)
       select count(distinct b.customer_id) filter (where f.first between $1 and $2)::int as new,
              count(distinct b.customer_id) filter (where f.first < $1)::int as returning
         from bookings b join firsts f on f.customer_id = b.customer_id
        where b.status = 'completed' and b.booking_date between $1 and $2`);
    const top = await q(
      `select c.id, c.name, sum(p.amount) as spend, count(distinct b.id)::int as jobs
         from payments p join bookings b on b.id = p.booking_id join customers c on c.id = b.customer_id
        where ${day('p.created_at')} between $1 and $2 group by c.id, c.name order by spend desc limit 10`);
    const owing = await q(
      `select b.ref, b.name, b.booking_date, b.total, coalesce((select sum(amount) from payments p where p.booking_id = b.id), 0) as paid
         from bookings b where b.status = 'completed' and b.booking_date <= $1
          and b.total > coalesce((select sum(amount) from payments p where p.booking_id = b.id), 0)
        order by b.booking_date limit 200`, [to]);
    const n = x => Number(x || 0);
    const takenTotal = round2(byMethod.reduce((s, x) => s + n(x.total), 0) + n(vouchersSold[0].total));
    const completed = statuses.find(x => x.status === 'completed');
    return {
      from, to, taken: takenTotal,
      byMethod: byMethod.map(x => ({ method: x.method, label: METHOD_LABEL[x.method], total: n(x.total), n: x.n })),
      vouchersSold: { total: n(vouchersSold[0].total), n: vouchersSold[0].n },
      byDay: byDay.map(x => ({ day: x.day, taken: n(x.taken), jobs: x.jobs })),
      jobs: completed?.n || 0, jobsValue: n(completed?.value), averageJob: completed?.n ? round2(n(completed.value) / completed.n) : 0,
      statuses: Object.fromEntries(statuses.map(x => [x.status, x.n])),
      byPackage: byPackage.map(x => ({ package: x.package, n: x.n, value: n(x.value) })),
      byWeekday: byWeekday.map(x => ({ dow: x.dow, n: x.n })), bySlot, bySource, addons,
      customers: customers[0], top: top.map(x => ({ ...x, spend: n(x.spend) })),
      owing: owing.map(x => ({ ref: x.ref, name: x.name, date: x.booking_date, owing: round2(n(x.total) - n(x.paid)) }))
    };
  });

  /* ---------- prices, hours, business details, closed days ---------- */
  r.owner('settings_get', async () => {
    const s = await getSettings(pool);
    const closed = (await pool.query('select day, reason from closed_days where day >= $1 order by day', [R.todayISO()])).rows;
    return { ...s, closedDays: closed, mailReady: mailer.ready, emailsHeld: outbox.hold };
  });

  r.owner('settings_save', async (p, user) => tx(pool, async db => {
    const value = await saveSetting(db, text(p.key), p.value, user.id);
    await audit(db, user, `settings.${text(p.key)}`, 'changed');
    return value;
  }));

  r.owner('closed_day_add', async (p, user) => {
    if (!R.isISODate(p.day) || p.day < R.todayISO()) fail(400, 'Pick today or a later date.');
    const reason = opt(p.reason, 100, 'The reason');
    const clash = (await pool.query("select count(*)::int as n from bookings where booking_date = $1 and status = any($2)", [p.day, R.OPEN])).rows[0].n;
    await pool.query('insert into closed_days (day, reason, created_by) values ($1, $2, $3) on conflict (day) do update set reason = excluded.reason', [p.day, reason, user.id]);
    await audit(pool, user, 'closed_day.added', `${p.day}${reason ? ` (${reason})` : ''}`);
    return { bookingsThatDay: clash };
  });

  r.owner('closed_day_remove', async (p, user) => {
    if (!R.isISODate(p.day)) fail(400, 'Pick a date.');
    await pool.query('delete from closed_days where day = $1', [p.day]);
    await audit(pool, user, 'closed_day.removed', p.day);
    return {};
  });

  /* ---------- staff ---------- */
  r.owner('team_list', async () => (await pool.query(
    `select s.user_id as id, s.name, s.role, s.alerts, u.email, u.password_hash is not null as has_password,
            (select max(created_at) from sessions x where x.user_id = u.id) as last_sign_in
       from staff s join users u on u.id = s.user_id order by s.role desc, s.name`)).rows.map(x => ({
    id: x.id, name: x.name, role: x.role, alerts: x.alerts, email: x.email, hasPassword: x.has_password, lastSignIn: x.last_sign_in
  })));

  r.owner('team_save', async (p, user) => tx(pool, async db => {
    const email = cleanEmail(p.email);
    if (!email) fail(400, 'Enter their email address.');
    const name = maxLen(text(p.name), 60, 'The name');
    if (!name) fail(400, 'Enter their name.');
    const role = p.role === 'crew' ? 'crew' : 'owner';
    const u = (await db.query(
      'insert into users (email) values ($1) on conflict ((lower(email))) do update set email = users.email returning id', [email])).rows[0];
    const before = (await db.query('select role from staff where user_id = $1', [u.id])).rows[0];
    if (before?.role === 'owner' && role === 'crew') {
      const owners = (await db.query("select count(*)::int as n from staff where role = 'owner'")).rows[0].n;
      if (owners <= 1) fail(400, 'There must always be at least one owner.');
    }
    await db.query(
      `insert into staff (user_id, name, role, alerts) values ($1, $2, $3, $4)
       on conflict (user_id) do update set name = excluded.name, role = excluded.role, alerts = excluded.alerts`,
      [u.id, name, role, p.alerts !== false]);
    await audit(db, user, before ? 'staff.updated' : 'staff.added', `${name} <${email}> as ${role}`);
    return { id: u.id };
  }));

  r.owner('team_remove', async (p, user) => tx(pool, async db => {
    const id = posId(p.id, 'staff member');
    if (id === user.id) fail(400, 'You can\'t remove yourself.');
    const st = (await db.query('select name, role from staff where user_id = $1', [id])).rows[0];
    if (!st) fail(404, 'That person is not on the staff list.');
    if (st.role === 'owner' && (await db.query("select count(*)::int as n from staff where role = 'owner'")).rows[0].n <= 1) {
      fail(400, 'There must always be at least one owner.');
    }
    await db.query('delete from staff where user_id = $1', [id]);
    await db.query('delete from sessions where user_id = $1', [id]);
    await audit(db, user, 'staff.removed', st.name);
    return {};
  }));

  // A one-time "choose your password" link for a staff member, valid 7 days.
  r.owner('team_link', async (p, user) => {
    const id = posId(p.id, 'staff member');
    const st = (await pool.query('select name from staff where user_id = $1', [id])).rows[0];
    if (!st) fail(404, 'That person is not on the staff list.');
    const { token, hash } = newToken();
    await pool.query("insert into password_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + interval '7 days')", [hash, id]);
    await audit(pool, user, 'staff.link', st.name);
    const url = new URL('/quote.html#rewards', ctx.site);
    url.searchParams.set('type', 'recovery');
    url.searchParams.set('token', token);
    return { link: url.toString() };
  });

  r.owner('audit_list', async () => (await pool.query(
    'select actor_name, action, detail, created_at from audit_log order by id desc limit 300')).rows);

  /* ---------- the email outbox ---------- */
  r.owner('outbox_list', async p => {
    const status = ['pending', 'sent', 'failed', 'held'].includes(p.status) ? p.status : null;
    const rows = (await pool.query(
      `select o.id, o.to_addr, o.subject, o.body, o.kind, o.status, o.attempts, o.last_error, o.created_at, o.sent_at, b.ref, c.phone
         from outbox o left join bookings b on b.id = o.booking_id left join customers c on c.id = o.customer_id
        ${status ? 'where o.status = $1' : ''} order by o.id desc limit 300`, status ? [status] : [])).rows;
    return { mailReady: mailer.ready, held: outbox.hold, emails: rows };
  });

  r.owner('outbox_retry', async (p, user) => {
    if (outbox.hold) fail(400, 'There is no mailbox yet, so emails can\'t be sent. Pass the message on by WhatsApp instead.');
    const u = await pool.query("update outbox set status = 'pending', send_after = now(), attempts = 0 where id = $1 and status in ('failed', 'held')", [posId(p.id, 'email')]);
    if (!u.rowCount) fail(400, 'That email is not waiting to be retried.');
    await audit(pool, user, 'email.retried', `#${p.id}`);
    return {};
  });
}
