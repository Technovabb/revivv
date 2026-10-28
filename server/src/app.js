/*
 * The Revivv API. The website calls it from revivvbb.com; answers are
 * { data } on success and { error: { message } } on failure.
 *
 * Status codes matter to the pages: 4xx is "a normal problem, show the
 * message", 5xx or no answer is "Revivv is offline, offer WhatsApp instead".
 *
 * Each call (POST /rpc/<name>) has an access level: public, customer (signed
 * in), staff (owners and crew) or owner. See src/rpc/*.js.
 */
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, burnTime, newToken, tokenHash } from './passwords.js';
import { fail, text, cleanEmail } from './util.js';
import { getSettings } from './settings.js';
import { emails } from './emails.js';
import { createOutbox } from './outbox.js';
import { createBookings } from './bookings.js';
import { registerFiles } from './files.js';
import publicRpc from './rpc/public.js';
import accountRpc from './rpc/account.js';
import officeRpc from './rpc/office.js';
import ownerRpc from './rpc/owner.js';

const COOKIE = 'rv_session';
const PHONE = '1-246-260-8228';

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
    if (status === 500 && process.env.REVIVV_DEBUG) console.error(err);
    const message = status === 500 ? `Something went wrong on our side. Please try again, or call ${PHONE}.`
      : status === 429 ? 'Too many tries. Please wait a few minutes and try again.'
      : err.message;
    reply.code(status).send({ error: { message } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { message: 'Not found.' } }));

  /* ---------- sessions (an HttpOnly cookie; only its hash is stored) ---------- */
  const cookieTail = `; Path=/; HttpOnly; SameSite=Lax${config.production ? '; Secure' : ''}`;
  const actors = new WeakMap();

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
  /*
   * Who is asking: null when signed out, else
   * { id, email, name, staff, role: 'owner'|'crew'|'customer', owner }.
   */
  async function actorFor(req) {
    if (actors.has(req)) return actors.get(req);
    const token = cookieToken(req);
    let actor = null;
    if (token) {
      const r = await pool.query(
        `select u.id, u.email, s.name, s.role from sessions x join users u on u.id = x.user_id
           left join staff s on s.user_id = u.id
          where x.token_hash = $1 and x.expires_at > now()`, [tokenHash(token)]);
      const u = r.rows[0];
      if (u) {
        actor = { id: u.id, email: u.email, name: u.name || u.email, staff: !!u.role, role: u.role || 'customer', owner: u.role === 'owner' };
      }
    }
    actors.set(req, actor);
    return actor;
  }

  /* ---------- shared services ---------- */
  const outbox = createOutbox({ pool, mailer, config, log: app.log });
  const bookings = createBookings({ pool, outbox, config });
  async function audit(db, actor, action, detail = null) {
    await db.query('insert into audit_log (actor_id, actor_name, action, detail) values ($1, $2, $3, $4)',
      [actor?.id || null, actor?.name || 'Revivv', action, detail ? String(detail).slice(0, 500) : null]);
  }
  const ctx = { pool, config, mailer, outbox, bookings, audit, site: config.siteOrigins[0] };
  app.decorate('services', ctx);

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

  // Sign in with a 6-digit code sent by email (no password needed).
  const codeHash = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest();
  app.post('/auth/code', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async req => {
    const email = cleanEmail(req.body?.email);
    if (!email) fail(400, 'Enter a valid email address.');
    if (outbox.hold) fail(400, `Sign-in codes by email aren't switched on yet. Use your password, or WhatsApp ${PHONE} and we'll help.`);
    const recent = await pool.query("select count(*)::int as n from login_codes where lower(email) = $1 and created_at > now() - interval '10 minutes'", [email]);
    if (recent.rows[0].n >= 3) fail(429, 'Too many codes.');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await pool.query("insert into login_codes (email, code_hash, expires_at) values ($1, $2, now() + interval '10 minutes')", [email, codeHash(email, code)]);
    const m = emails.code(code, await getSettings(pool));
    try {
      await mailer.send({ to: email, subject: m.subject, text: m.body });
    } catch (e) {
      req.log.error({ err: e.message }, 'code email failed');
      fail(400, `We couldn't send the email just now. Please try again, or call ${PHONE}.`);
    }
    return { data: {} };
  });

  app.post('/auth/verify', authLimit, async (req, reply) => {
    const email = cleanEmail(req.body?.email);
    const code = text(req.body?.code).replace(/\D/g, '');
    const row = email ? (await pool.query(
      `select id, code_hash, tries from login_codes where lower(email) = $1 and used_at is null and expires_at > now()
        order by id desc limit 1`, [email])).rows[0] : null;
    if (!row) fail(400, 'That code has expired. Ask for a new one.');
    if (row.tries >= 5) fail(400, 'Too many wrong tries. Ask for a new code.');
    const ok = code.length === 6 && crypto.timingSafeEqual(row.code_hash, codeHash(email, code));
    if (!ok) {
      await pool.query('update login_codes set tries = tries + 1 where id = $1', [row.id]);
      const left = 4 - row.tries;
      fail(400, left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Ask for a new code.');
    }
    await pool.query('update login_codes set used_at = now() where id = $1', [row.id]);
    const u = (await pool.query(
      'insert into users (email) values ($1) on conflict ((lower(email))) do update set email = users.email returning id, email', [email])).rows[0];
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
    const actor = await actorFor(req);
    return { data: { user: actor ? { email: actor.email } : null } };
  });

  app.post('/auth/password', authLimit, async req => {
    const actor = await actorFor(req);
    if (!actor) fail(401, 'Please sign in again.');
    const hash = await hashPassword(newPassword(req.body?.password));
    await pool.query('update users set password_hash = $2 where id = $1', [actor.id, hash]);
    // sign out every other browser
    await pool.query('delete from sessions where user_id = $1 and token_hash <> $2', [actor.id, tokenHash(cookieToken(req))]);
    return { data: { user: { email: actor.email } } };
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
    if (outbox.hold) fail(400, `Password reset emails aren't switched on yet. WhatsApp or call ${PHONE} and we'll help.`);
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
    const a = await actorFor(req);
    return { data: a?.staff ? { name: a.name, role: a.role, email: a.email } : null };
  });

  app.get('/health', async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  /* ---------- the calls the pages make (POST /rpc/<name>) ---------- */
  const registry = new Map();
  const level = lv => (name, fn) => {
    if (registry.has(name)) throw new Error(`rpc ${name} registered twice`);
    registry.set(name, { level: lv, fn });
  };
  const r = { public: level('public'), customer: level('customer'), staff: level('staff'), owner: level('owner') };
  for (const mod of [publicRpc, accountRpc, officeRpc, ownerRpc]) mod(r, ctx);

  async function call(name, req) {
    const entry = registry.get(name);
    if (!entry) fail(404, 'Unknown request.');
    const actor = await actorFor(req);
    if (entry.level !== 'public' && !actor) fail(401, 'Please sign in.');
    if ((entry.level === 'staff' || entry.level === 'owner') && !actor.staff) fail(403, 'Staff only.');
    if (entry.level === 'owner' && !actor.owner) fail(403, 'Only the owners can do this.');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    return { data: await entry.fn(body, actor, req) };
  }
  // Bookings and messages get a tighter limit than everything else.
  app.post('/rpc/create_booking', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, req => call('create_booking', req));
  app.post('/rpc/booking_send', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, req => call('booking_send', req));
  app.post('/rpc/:name', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, req => call(req.params.name, req));

  await registerFiles(app, ctx, actorFor);
  return app;
}
