/*
 * One-time copy of the old Supabase data into this database.
 * Supabase dashboard → the paused project → Download backups → Database backup
 * gives a gzipped pg_dumpall file; this reads the rows straight out of it.
 *
 *   node --env-file=/etc/revivv-api.env src/import-supabase.js <file>           shows what it would copy
 *   node --env-file=/etc/revivv-api.env src/import-supabase.js <file> --write   copies it
 *
 * It only writes into an empty database, all in one transaction.
 * Passwords carry over: the old bcrypt hashes are upgraded at each person's next sign-in.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { tx } from './db.js';
import { MAX_STAMPS } from './rules.js';

// Every COPY block in a pg_dump text file, as { 'public.customers': [{ column: value }] }.
export function readCopyBlocks(text) {
  const tables = {};
  let rows = null, cols = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (rows) {
      if (line === '\\.') { rows = null; continue; }
      const vals = line.split('\t').map(unescapeCopy);
      rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
      continue;
    }
    const m = /^COPY ([\w.]+) \((.*)\) FROM stdin;$/.exec(line);
    if (m) {
      cols = m[2].split(', ').map(c => c.replace(/"/g, ''));
      rows = tables[m[1]] = [];
    }
  }
  return tables;
}

// COPY's text format: \N is null, and backslash escapes for tabs, newlines and so on.
function unescapeCopy(s) {
  if (s === '\\N') return null;
  const named = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  return s.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|(.))/g, (_, oct, hex, ch) =>
    oct ? String.fromCharCode(parseInt(oct, 8)) : hex ? String.fromCharCode(parseInt(hex, 16)) : (named[ch] ?? ch));
}

// The old booking statuses, in the new terms.
const STATUS = { new: 'requested', confirmed: 'confirmed', completed: 'completed', cancelled: 'cancelled', no_show: 'no_show' };

/*
 * Works out the new rows from the old tables. Nothing is written here.
 * The old system kept one row per stamp and per credit; the new one keeps totals:
 *  - stamps: the ones not yet redeemed (as the old My Rewards counted them), at most 6;
 *  - credit: the sum of the old credit rows;
 *  - referral: counted as paid once the referred customer had a completed detail,
 *    because that is when the old system paid it.
 */
export function planImport(t) {
  const rows = name => t[name] || [];
  const warnings = [];
  const users = rows('auth.users')
    .filter(u => u.email && !u.deleted_at && u.is_anonymous !== 't')
    .map(u => ({ old: u.id, email: u.email.trim().toLowerCase(), password_hash: u.encrypted_password || null, created_at: u.created_at }));
  const userByOld = new Map(users.map(u => [u.old, u]));

  const staff = [];
  for (const s of rows('public.staff')) {
    const u = userByOld.get(s.user_id);
    if (!u) { warnings.push('A staff entry has no login in the backup; skipped.'); continue; }
    staff.push({ user: s.user_id, name: (s.name || '').trim() || u.email.split('@')[0] });
  }

  const stamps = rows('public.stamps'), credits = rows('public.credits'), oldBookings = rows('public.bookings');
  const stampTime = b => stamps.find(s => s.booking_id === b.id)?.awarded_at || null;
  const codes = new Set(rows('public.customers').map(c => (c.referral_code || '').toUpperCase()).filter(Boolean));
  const customers = rows('public.customers').map(c => {
    const done = oldBookings.filter(b => b.customer_id === c.id && b.status === 'completed')
      .sort((a, b) => a.booking_date.localeCompare(b.booking_date));
    const login = c.user_id && userByOld.get(c.user_id);
    if (login && login.email !== c.email.trim().toLowerCase()) {
      warnings.push(`${mask(c.email)} signed in as ${mask(login.email)}; My Rewards now matches by email, so they should sign in as ${mask(c.email)}.`);
    }
    let code = c.referral_code;
    while (!code) {
      const next = 'REVIVV-' + crypto.randomBytes(3).toString('hex').slice(0, 5).toUpperCase();
      if (!codes.has(next)) { codes.add(next); code = next; }
    }
    const credit = credits.filter(r => r.customer_id === c.id).reduce((sum, r) => sum + Number(r.amount), 0);
    return {
      old: c.id, email: c.email.trim(), name: c.name, phone: c.phone, referral_code: code, referredBy: c.referred_by,
      referral_paid_at: c.referred_by && done.length ? (stampTime(done[0]) || done[0].created_at) : null,
      stamps: Math.min(stamps.filter(s => s.customer_id === c.id && !s.redeemed_at).length, MAX_STAMPS),
      credit: Math.max(0, Math.round(credit * 100) / 100),
      created_at: c.created_at
    };
  });
  const customerByOld = new Map(customers.map(c => [c.old, c]));

  const bookings = oldBookings.map(b => {
    const c = customerByOld.get(b.customer_id);
    const status = STATUS[b.status];
    if (!c) throw new Error(`booking ${b.id} has no customer in the backup`);
    if (!status) throw new Error(`booking ${b.id} has an unknown status "${b.status}"`);
    return {
      customer: b.customer_id, booking_date: b.booking_date, slot: b.slot, status,
      name: c.name, email: c.email, phone: c.phone || '',
      vehicle_type: b.vehicle_type, vehicle_desc: b.vehicle_description, package: b.package, addons: b.addons,
      total: Number(b.total), location: b.service_location, parish: b.parish, address: b.address, notes: b.notes,
      created_at: b.created_at, completed_at: status === 'completed' ? stampTime(b) : null
    };
  });

  return { users, staff, customers, bookings, warnings };
}

// Writes the plan in one transaction, and only into an empty database.
export async function writeImport(pool, plan) {
  return tx(pool, async db => {
    const used = (await db.query('select (select count(*) from users) + (select count(*) from customers) + (select count(*) from bookings) as n')).rows[0].n;
    if (used) throw new Error('This database already has accounts or bookings. The import only runs once, into an empty database.');

    const userId = new Map();
    for (const u of plan.users) {
      const r = await db.query('insert into users (email, password_hash, created_at) values ($1, $2, $3) returning id',
        [u.email, u.password_hash, u.created_at]);
      userId.set(u.old, r.rows[0].id);
    }
    for (const s of plan.staff) {
      await db.query('insert into staff (user_id, name) values ($1, $2)', [userId.get(s.user), s.name]);
    }
    const customerId = new Map();
    for (const c of plan.customers) {
      const r = await db.query(
        `insert into customers (email, name, phone, referral_code, referral_paid_at, stamps, credit, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [c.email, c.name, c.phone, c.referral_code, c.referral_paid_at, c.stamps, c.credit, c.created_at]);
      customerId.set(c.old, r.rows[0].id);
    }
    for (const c of plan.customers) {
      if (c.referredBy) await db.query('update customers set referred_by = $2 where id = $1', [customerId.get(c.old), customerId.get(c.referredBy)]);
    }
    let n = 0;
    for (const b of plan.bookings) {
      const ref = `RV-${b.booking_date.slice(2).replace(/-/g, '')}-${1000 + (++n)}`;
      await db.query(
        `insert into bookings (ref, customer_id, booking_date, slot, status, name, email, phone, vehicle_type, vehicle_desc,
           package, addons, total, quoted_total, location, parish, address, notes, created_at, completed_at)
         values ($19, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15, $16, $17, $18)`,
        [customerId.get(b.customer), b.booking_date, b.slot, b.status, b.name, b.email, b.phone, b.vehicle_type, b.vehicle_desc,
         b.package, b.addons, b.total, b.location, b.parish, b.address, b.notes, b.created_at, b.completed_at, ref]);
    }
  });
}

// "an•••@example.com": enough to tell people apart without printing their address.
function mask(email) {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 2)}•••@${domain}`;
}

export function describe(plan) {
  const staffOf = new Map(plan.staff.map(s => [s.user, s.name]));
  const isCustomer = new Set(plan.customers.map(c => c.email.toLowerCase()));
  const lines = [`Logins: ${plan.users.length} (${plan.users.filter(u => u.password_hash).length} with a password)`];
  for (const u of plan.users) {
    const roles = [staffOf.has(u.old) && `staff "${staffOf.get(u.old)}"`, isCustomer.has(u.email) && 'customer'].filter(Boolean);
    lines.push(`  ${mask(u.email)}  ${roles.join(', ') || 'login only'}`);
  }
  lines.push(`Staff: ${plan.staff.length}`, `Customers: ${plan.customers.length}`);
  for (const c of plan.customers) {
    const n = plan.bookings.filter(b => b.customer === c.old).length;
    lines.push(`  ${c.name.split(' ')[0]} (${mask(c.email)}): ${c.stamps} stamps, $${c.credit} credit, ${n} booking${n === 1 ? '' : 's'}${c.referredBy ? ', was referred' : ''}`);
  }
  lines.push(`Bookings: ${plan.bookings.length}`);
  for (const b of plan.bookings) lines.push(`  ${b.booking_date} ${b.slot}: ${b.package} (${b.vehicle_type}), $${b.total}, ${b.status}`);
  for (const w of plan.warnings) lines.push(`Note: ${w}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, flag] = process.argv.slice(2);
  if (!file || (flag && flag !== '--write')) {
    console.log('Usage: node src/import-supabase.js <backup.gz or .sql> [--write]');
    process.exit(1);
  }
  const buf = fs.readFileSync(file);
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
  const plan = planImport(readCopyBlocks(text));
  console.log(describe(plan));
  if (flag !== '--write') {
    console.log('\nNothing written. Add --write to copy it.');
  } else {
    const { loadConfig } = await import('./config.js');
    const { createPool } = await import('./db.js');
    const pool = createPool(loadConfig().databaseUrl);
    try {
      await writeImport(pool, plan);
      console.log('\nCopied.');
    } catch (e) {
      console.error(`\nNothing copied: ${e.message}`);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
