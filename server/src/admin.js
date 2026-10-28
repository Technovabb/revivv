/*
 * Staff accounts, run on the server:
 *
 *   npm run admin -- add-staff <email> "<name>"   add someone to the staff console
 *   npm run admin -- reset-link <email>           a one-time "choose a password" link
 *   npm run admin -- list-staff
 *   npm run admin -- remove-staff <email>
 *
 * add-staff and reset-link print a one-time link (valid 7 days) for that person
 * to choose their own password. Send it to them privately; nobody else needs
 * to know their password.
 */
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { newToken } from './passwords.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const [cmd, emailArg, ...rest] = process.argv.slice(2);
const email = (emailArg || '').trim().toLowerCase();

async function linkFor(userId) {
  const { token, hash } = newToken();
  await pool.query("insert into password_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + interval '7 days')", [hash, userId]);
  // staff choose their password in the back office; customers on the rewards page
  const staff = (await pool.query('select 1 from staff where user_id = $1', [userId])).rowCount > 0;
  const url = new URL(staff ? '/staff.html' : '/quote.html#rewards', config.siteOrigins[0]);
  url.searchParams.set('type', 'recovery');
  url.searchParams.set('token', token);
  return url.toString();
}

async function userId(email) {
  const r = await pool.query(
    'insert into users (email) values ($1) on conflict ((lower(email))) do update set email = users.email returning id', [email]);
  return r.rows[0].id;
}

try {
  if (cmd === 'add-staff' && email && rest.length) {
    const id = await userId(email);
    await pool.query('insert into staff (user_id, name) values ($1, $2) on conflict (user_id) do update set name = excluded.name', [id, rest.join(' ')]);
    const hasPassword = (await pool.query('select password_hash is not null as yes from users where id = $1', [id])).rows[0].yes;
    console.log(`${email} is now staff.`);
    if (hasPassword) console.log('They already have a password: they sign in at /staff.html.');
    else console.log(`Send them this link to choose a password (valid 7 days), then they sign in at /staff.html:\n${await linkFor(id)}`);
  } else if (cmd === 'reset-link' && email) {
    const u = (await pool.query('select id from users where lower(email) = $1', [email])).rows[0];
    if (!u) throw new Error(`no account for ${email}`);
    console.log(`One-time link for ${email} (valid 7 days):\n${await linkFor(u.id)}`);
  } else if (cmd === 'list-staff') {
    const r = await pool.query('select u.email, s.name, u.password_hash is not null as ready from staff s join users u on u.id = s.user_id order by s.name');
    if (!r.rows.length) console.log('No staff yet.');
    for (const s of r.rows) console.log(`${s.name} <${s.email}>${s.ready ? '' : '  (has not set a password yet)'}`);
  } else if (cmd === 'remove-staff' && email) {
    const r = await pool.query('delete from staff where user_id = (select id from users where lower(email) = $1)', [email]);
    console.log(r.rowCount ? `${email} is no longer staff.` : `${email} was not staff.`);
    await pool.query('delete from sessions where user_id = (select id from users where lower(email) = $1)', [email]);
  } else {
    console.log('Usage: npm run admin -- add-staff <email> "<name>" | reset-link <email> | list-staff | remove-staff <email>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
