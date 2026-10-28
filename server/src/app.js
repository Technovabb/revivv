/*
 * The Revivv API. The website calls it from revivvbb.com; answers are
 * { data } on success and { error: { message } } on failure.
 *
 * Status codes matter to the pages: 4xx is "a normal problem, show the
 * message", 5xx or no answer is "Revivv is offline, offer WhatsApp instead".
 */
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { tx } from './db.js';
import { hashPassword, verifyPassword, burnTime, newToken, tokenHash } from './passwords.js';
import * as R from './rules.js';

const COOKIE = 'rv_session';
const PHONE = '1-246-260-8228';
const STAFF_ONLY = new Set(['staff_day', 'staff_range', 'staff_find_customers', 'complete_booking', 'cancel_booking']);

function fail(status, message) {
  throw Object.assign(new Error(message), { statusCode: status });
}
const text = v => (v == null ? '' : String(v).trim());
function cleanEmail(v) {
  const e = text(v).toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}
function maxLen(value, n, what) {
  if (value && value.length > n) fail(400, `${what} is too long.`);
  return value;
}
function bookingId(v) {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Unknown booking.');
  return id;
}
const likeEscape = s => s.replace(/[\\%_]/g, m => '\\' + m);
const letters = n => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
const digits = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

export async function buildApp({ config, pool, mailer, logger = true }) {
  const app = Fastify({
    logger: logger && { level: 'info', redact: ['req.headers.cookie'] },
    trustProxy: config.trustProxy,
    bodyLimit: 32 * 1024
  });
  // per-route limits (config.rateLimit on each route); tests switch them off
  if (config.rateLimits !== false) await app.register(rateLimit, { global: false });

  /* ---------- CORS: only the Revivv site may call with a signed-in cookie ---------- */
  const origins = new Set(config.siteOrigins);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const allowed = !!origin && origins.has(origin);
    if (allowed) {
      reply.header('Access-Control-Allow-Origin', origin)
        .header('Access-Control-Allow-Credentials', 'true')
        .header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      reply.code(allowed ? 204 : 403)
        .header('Access-Control-Allow-Methods', 'GET, POST')
        .header('Access-Control-Allow-Headers', 'Content-Type')
        .header('Access-Control-Max-Age', '600')
        .send();
      return reply;
    }
    // Anything that changes data must come from the site itself, so another
    // website can't act with a customer's cookie.
    if (req.method !== 'GET' && !allowed) {
      reply.code(403).send({ error: { message: 'Not allowed from this page.' } });
      return reply;
    }
  });
  app.options('/*', async () => '');
  app.addHook('onSend', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error(err);
    const message = status === 500 ? `Something went wrong on our side. Please try again, or call ${PHONE}.`
      : status === 429 ? 'Too many tries. Please wait a few minutes and try again.'
      : err.message;
    reply.code(status).send({ error: { message } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { message: 'Not found.' } }));

  /* ---------- sessions (an HttpOnly cookie; only its hash is stored) ---------- */
  const cookieTail = `; Path=/; HttpOnly; SameSite=Lax${config.production ? '; Secure' : ''}`;
  const users = new WeakMap();

  async function startSession(reply, userId) {
    const { token, hash } = newToken();
    await pool.query('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))',
      [hash, userId, config.sessionDays]);
    reply.header('Set-Cookie', `${COOKIE}=${token}; Max-Age=${config.sessionDays * 86400}${cookieTail}`);
  }
  function cookieToken(req) {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)rv_session=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }
  async function currentUser(req) {
    if (users.has(req)) return users.get(req);
    const token = cookieToken(req);
    let user = null;
    if (token) {
      const r = await pool.query(
        'select u.id, u.email from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()',
        [tokenHash(token)]);
      user = r.rows[0] || null;
    }
    users.set(req, user);
    return user;
  }
  async function staffName(user) {
    if (!user) return null;
    const r = await pool.query('select name from staff where user_id = $1', [user.id]);
    return r.rows[0] ? r.rows[0].name : null;
  }

  /* ---------- accounts ---------- */
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  function newPassword(v) {
    const p = typeof v === 'string' ? v : '';
    if (p.length < 8) fail(400, 'Use at least 8 characters for your password.');
    if (p.length > 200) fail(400, 'That password is too long.');
    return p;
  }

  app.post('/auth/signup', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const email = cleanEmail(req.body?.email);
    if (!email) fail(400, 'Enter a valid email address.');
    const hash = await hashPassword(newPassword(req.body?.password));
    const r = await pool.query(
      'insert into users (email, password_hash) values ($1, $2) on conflict ((lower(email))) do nothing returning id', [email, hash]);
    if (!r.rows[0]) fail(422, 'User already registered');
    await startSession(reply, r.rows[0].id);
    return { data: { user: { email } } };
  });

  app.post('/auth/signin', authLimit, async (req, reply) => {
    const email = cleanEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const u = email ? (await pool.query('select id, email, password_hash from users where lower(email) = $1', [email])).rows[0] : null;
    if (!u || !u.password_hash) { await burnTime(password); fail(400, 'Invalid login credentials'); }
    const check = await verifyPassword(password, u.password_hash);
    if (!check.ok) fail(400, 'Invalid login credentials');
    if (check.rehash) await pool.query('update users set password_hash = $2 where id = $1', [u.id, await hashPassword(password)]);
    await startSession(reply, u.id);
    return { data: { user: { email: u.email } } };
  });

  app.post('/auth/signout', async (req, reply) => {
    const token = cookieToken(req);
    if (token) await pool.query('delete from sessions where token_hash = $1', [tokenHash(token)]);
    reply.header('Set-Cookie', `${COOKIE}=; Max-Age=0${cookieTail}`);
    return { data: {} };
  });

  app.get('/auth/session', async req => {
    const user = await currentUser(req);
    return { data: { user: user ? { email: user.email } : null } };
  });

  app.post('/auth/password', authLimit, async req => {
    const user = await currentUser(req);
    if (!user) fail(401, 'Please sign in again.');
    const hash = await hashPassword(newPassword(req.body?.password));
    await pool.query('update users set password_hash = $2 where id = $1', [user.id, hash]);
    // sign out every other browser
    await pool.query('delete from sessions where user_id = $1 and token_hash <> $2', [user.id, tokenHash(cookieToken(req))]);
    return { data: { user: { email: user.email } } };
  });

  // Where a reset link may send someone: only back to a page on the Revivv site.
  function safeReturn(url) {
    try {
      const u = new URL(String(url));
      if (origins.has(u.origin)) return u;
    } catch { /* fall through */ }
    return new URL('/quote.html#rewards', config.siteOrigins[0]);
  }

  app.post('/auth/reset', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async req => {
    const email = cleanEmail(req.body?.email);
    if (!email) fail(400, 'Enter a valid email address.');
    if (!mailer.ready && config.production) fail(400, `Password reset emails aren't switched on yet. WhatsApp or call ${PHONE} and we'll help.`);
    const u = (await pool.query('select id from users where lower(email) = $1', [email])).rows[0];
    if (u) {
      const { token, hash } = newToken();
      await pool.query("insert into password_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')", [hash, u.id]);
      const link = safeReturn(req.body?.redirectTo);
      link.searchParams.set('type', 'recovery');
      link.searchParams.set('token', token);
      try {
        await mailer.send({
          to: email,
          subject: 'Reset your Revivv password',
          text: `Hi,\n\nSomeone asked to reset the password for your Revivv account. To choose a new password, open this link within 1 hour:\n\n${link}\n\nIf you didn't ask for this, ignore this email. Your password stays the same.\n\nRevivv Vehicle Detailing\n${PHONE}\n`
        });
      } catch (e) {
        req.log.error({ err: e.message }, 'reset email failed');
        fail(400, `We couldn't send the email just now. Please try again later, or call ${PHONE}.`);
      }
    }
    return { data: {} };
  });

  // A reset (or staff invite) link: swap its one-time token for a signed-in session.
  app.post('/auth/recover', authLimit, async (req, reply) => {
    const r = await pool.query(
      'update password_tokens set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id',
      [tokenHash(text(req.body?.token))]);
    if (!r.rows[0]) fail(400, 'This link has expired or was already used. Ask for a new one.');
    const u = (await pool.query('select id, email from users where id = $1', [r.rows[0].user_id])).rows[0];
    await startSession(reply, u.id);
    return { data: { user: { email: u.email } } };
  });

  app.get('/staff/me', async req => {
    const name = await staffName(await currentUser(req));
    return { data: name === null ? null : { name } };
  });

  app.get('/health', async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  /* ---------- customer state used by my_account and pricing ---------- */
  async function visits12(db, customerId, today) {
    const r = await db.query(
      "select count(*)::int as n from bookings where customer_id = $1 and status = 'completed' and booking_date > $2::date - interval '12 months'",
      [customerId, today]);
    return r.rows[0].n;
  }
  async function accountState(db, c, today) {
    const { tier, discount } = R.tierFor(await visits12(db, c.id, today));
    const open = await db.query("select 1 from bookings where customer_id = $1 and status = 'booked' and reward_applied limit 1", [c.id]);
    return { tier, discount, credit: c.credit, rewardAvailable: c.stamps >= R.REWARD_AT && !open.rowCount };
  }
  async function newCustomer(db, { email, name, phone }) {
    for (let i = 0; i < 10; i++) {
      const r = await db.query(
        'insert into customers (email, name, phone, referral_code) values ($1, $2, $3, $4) on conflict do nothing returning *',
        [email, name, phone, `REVIVV-${letters(2)}${digits(3)}`]);
      if (r.rows[0]) return r.rows[0];
      const same = (await db.query('select * from customers where lower(email) = $1 for update', [email])).rows[0];
      if (same) return same;   // made by another request a moment ago
    }
    throw new Error('could not make a unique referral code');
  }

  /* ---------- the calls the pages make (POST /rpc/<name>) ---------- */
  const rpc = {
    async my_account(p, user) {
      if (!user) fail(401, 'Please sign in again.');
      const c = (await pool.query(
        "select id, name, stamps, credit, referral_code, to_char(created_at at time zone $2, 'Mon YYYY') as since from customers where lower(email) = lower($1)",
        [user.email, R.TZ])).rows[0];
      if (!c) return null;
      const { tier, discount } = R.tierFor(await visits12(pool, c.id, R.todayISO()));
      const history = (await pool.query(
        "select to_char(booking_date, 'FMDD Mon YYYY') as date, package || ' — ' || vehicle_type as job, total as paid from bookings where customer_id = $1 and status = 'completed' order by booking_date desc, id desc limit 50",
        [c.id])).rows;
      return { name: c.name, since: c.since, stamps: Math.min(c.stamps, R.MAX_STAMPS), credit: c.credit, referral: c.referral_code, tier, discount, history };
    },

    async slots_taken(p) {
      if (!R.isISODate(p.d)) fail(400, 'Pick a valid date.');
      const r = await pool.query(
        "select slot from bookings where booking_date = $1 and status <> 'cancelled' order by array_position($2::text[], slot)",
        [p.d, R.SLOTS]);
      return r.rows.map(x => x.slot);
    },

    async check_referral(p) {
      const code = text(p.p_code).toUpperCase();
      if (!code || code.length > 40) return null;
      const r = await pool.query('select name from customers where upper(referral_code) = $1', [code]);
      return r.rows[0] ? r.rows[0].name.split(' ')[0] : null;
    },

    async create_booking(p, user) {
      const name = maxLen(text(p.p_name), 100, 'Your name');
      const email = cleanEmail(p.p_email);
      const phone = maxLen(text(p.p_phone), 40, 'The phone number');
      const date = text(p.p_date), slot = text(p.p_slot), vehicle = text(p.p_vehicle_type), pkg = text(p.p_package);
      const addons = maxLen(text(p.p_addons), 300, 'The add-ons list') || null;
      const location = text(p.p_location) || null;
      const parish = maxLen(text(p.p_parish), 40, 'The parish') || null;
      const address = maxLen(text(p.p_address), 300, 'The address') || null;
      const notes = maxLen(text(p.p_notes), 1000, 'The notes') || null;
      const vehicleDesc = maxLen(text(p.p_vehicle_desc), 120, 'The vehicle description') || null;
      const referral = maxLen(text(p.p_referral).toUpperCase(), 40, 'The referral code') || null;
      const quoted = p.p_total == null || p.p_total === '' || !Number.isFinite(Number(p.p_total)) ? null : Number(p.p_total);

      if (!name) fail(400, 'Please enter your name.');
      if (!email) fail(400, 'Please enter a valid email address.');
      if (phone.replace(/\D/g, '').length < 7) fail(400, 'Please enter a phone number we can reach you on.');
      if (!R.isISODate(date)) fail(400, 'Please pick a date.');
      const today = R.todayISO();
      if (date < today) fail(400, 'That date has passed. Please pick another.');
      if (date > R.addDays(today, 366)) fail(400, 'Please pick a date within the next year.');
      if (R.isSunday(date)) fail(400, `Sundays are by appointment. Please call ${PHONE}.`);
      if (!R.SLOTS.includes(slot)) fail(400, 'Please pick a time.');
      if (!Object.hasOwn(R.VEHICLES, vehicle)) fail(400, 'Please pick your vehicle type.');
      if (!Object.hasOwn(R.PACKAGES, pkg)) fail(400, 'Please pick a package.');
      if (R.PACKAGES[pkg].long && !R.LONG_SLOTS.includes(slot)) fail(400, 'That package takes longer, so it needs a morning or afternoon slot.');
      if (location && !R.LOCATIONS.includes(location)) fail(400, 'Please choose mobile or drop-off.');
      if (location && location.startsWith('Mobile') && !address) fail(400, 'Please enter the address for a mobile detail.');
      R.addonsTotal(addons);   // refuses unknown add-ons

      return tx(pool, async db => {
        let c = (await db.query('select * from customers where lower(email) = $1 for update', [email])).rows[0];
        if (!c) c = await newCustomer(db, { email, name, phone });

        // A referral code counts only for someone who hasn't had a detail yet.
        if (referral && !c.referred_by) {
          const ref = (await db.query('select id from customers where upper(referral_code) = $1', [referral])).rows[0];
          const before = await db.query("select 1 from bookings where customer_id = $1 and status = 'completed' limit 1", [c.id]);
          if (ref && ref.id !== c.id && !before.rowCount) await db.query('update customers set referred_by = $2 where id = $1', [c.id, ref.id]);
        }

        // Rewards, tier discount and credit only for the signed-in owner of this email.
        const account = user && user.email.toLowerCase() === email ? await accountState(db, c, today) : null;
        if (slot === 'priority' && account?.tier !== 'Gold') fail(400, 'The priority slot is for Gold members.');
        const price = R.priceBooking({ pkg, vehicle, addons, account });

        let id;
        try {
          id = (await db.query(
            `insert into bookings (customer_id, booking_date, slot, name, email, phone, vehicle_type, vehicle_desc, package, addons,
               total, quoted_total, reward_applied, credit_used, location, parish, address, notes, referral_code)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`,
            [c.id, date, slot, name, email, phone, vehicle, vehicleDesc, pkg, addons,
              price.total, quoted, price.rewardApplied, price.creditUsed, location, parish, address, notes, referral])).rows[0].id;
        } catch (e) {
          if (e.code === '23505') fail(409, 'That slot was just taken. Please pick another.');
          throw e;
        }
        if (price.creditUsed > 0) await db.query('update customers set credit = credit - $2 where id = $1', [c.id, price.creditUsed]);
        return { id, total: price.total };
      });
    },

    /* ----- staff ----- */
    async staff_day(p) {
      if (!R.isISODate(p.d)) fail(400, 'Pick a valid date.');
      const r = await pool.query(
        `select id, status, total, slot, name, package, addons, phone,
                nullif(concat_ws(' · ', vehicle_type, vehicle_desc), '') as vehicle, location, parish, address, notes
           from bookings where booking_date = $1
          order by array_position($2::text[], slot), id`, [p.d, R.SLOTS]);
      return r.rows;
    },

    async staff_range(p) {
      if (!R.isISODate(p.d_from) || !R.isISODate(p.d_to) || p.d_to < p.d_from) fail(400, 'Pick a valid date range.');
      if (p.d_to > R.addDays(p.d_from, 62)) fail(400, 'Pick a shorter date range.');
      const r = await pool.query(
        `select id, booking_date, status, total, slot, name from bookings
          where booking_date between $1 and $2
          order by booking_date, array_position($3::text[], slot), id`, [p.d_from, p.d_to, R.SLOTS]);
      return r.rows;
    },

    async staff_find_customers(p) {
      const q = maxLen(text(p.q), 100, 'The search');
      const today = R.todayISO();
      const r = await pool.query(
        `with v as (
           select customer_id,
                  count(*) filter (where status = 'completed' and booking_date > $2::date - interval '12 months')::int as visits,
                  max(booking_date) filter (where status = 'completed') as last_visit
             from bookings group by customer_id
         ), n as (
           select distinct on (customer_id) customer_id, booking_date as next_date, slot as next_slot
             from bookings where status = 'booked' and booking_date >= $2
            order by customer_id, booking_date, array_position($3::text[], slot)
         )
         select c.name, coalesce(c.phone, '') as phone, c.email, c.stamps, c.credit,
                coalesce(v.visits, 0) as visits, v.last_visit, n.next_date, n.next_slot
           from customers c left join v on v.customer_id = c.id left join n on n.customer_id = c.id
          where $1 = '' or c.name ilike $4 or c.email ilike $4
             or (length($5) >= 3 and regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') like '%' || $5 || '%')
          order by lower(c.name) limit 200`,
        [q, today, R.SLOTS, `%${likeEscape(q)}%`, q.replace(/\D/g, '')]);
      return r.rows.map(c => ({ ...c, tier: R.tierFor(c.visits).tier }));
    },

    // Marking a detail complete is what earns the stamp (and any referral credit).
    async complete_booking(p) {
      const id = bookingId(p.p_booking);
      return tx(pool, async db => {
        const b = (await db.query(
          "update bookings set status = 'completed', completed_at = now() where id = $1 and status = 'booked' returning customer_id, reward_applied",
          [id])).rows[0];
        if (!b) fail(400, 'That booking is already completed or cancelled.');
        const c = (await db.query('select * from customers where id = $1 for update', [b.customer_id])).rows[0];
        // the half-price detail uses up the card; any other detail adds a stamp
        await db.query('update customers set stamps = $2 where id = $1', [c.id, b.reward_applied ? 0 : Math.min(c.stamps + 1, R.MAX_STAMPS)]);
        if (c.referred_by && !c.referral_paid_at) {
          await db.query('update customers set credit = credit + $2, referral_paid_at = now() where id = $1', [c.id, R.REFERRAL_CREDIT]);
          await db.query('update customers set credit = credit + $2 where id = $1', [c.referred_by, R.REFERRAL_CREDIT]);
        }
        return { id };
      });
    },

    // Cancelling frees the slot and gives back any credit the booking used.
    async cancel_booking(p) {
      const id = bookingId(p.p_booking);
      return tx(pool, async db => {
        const b = (await db.query(
          "update bookings set status = 'cancelled', cancelled_at = now() where id = $1 and status = 'booked' returning customer_id, credit_used",
          [id])).rows[0];
        if (!b) fail(400, 'That booking is already completed or cancelled.');
        if (b.credit_used > 0) await db.query('update customers set credit = credit + $2 where id = $1', [b.customer_id, b.credit_used]);
        return { id };
      });
    }
  };

  async function call(name, req) {
    const user = await currentUser(req);
    if (STAFF_ONLY.has(name)) {
      if (!user) fail(401, 'Please sign in.');
      if ((await staffName(user)) === null) fail(403, 'Staff only.');
    }
    return { data: await rpc[name](req.body || {}, user) };
  }
  // Bookings get a tighter limit than everything else.
  app.post('/rpc/create_booking', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, req => call('create_booking', req));
  app.post('/rpc/:name', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, req => {
    if (!Object.hasOwn(rpc, req.params.name)) fail(404, 'Unknown request.');
    return call(req.params.name, req);
  });

  return app;
}
