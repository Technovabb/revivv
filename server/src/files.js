/*
 * Job photos (uploaded from the staff phone, shown to staff and to that
 * booking's customer) and CSV downloads for the accountant.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tx } from './db.js';
import { fail, text, opt } from './util.js';
import * as R from './rules.js';

const KINDS = ['before', 'after', 'damage'];
const METHOD = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', mobile: 'Mobile money', voucher: 'Voucher', other: 'Other' };
const SOURCE = { website: 'Website', phone: 'Phone', whatsapp: 'WhatsApp', walk_in: 'Walk-in', instagram: 'Instagram', other: 'Other' };
const MAX_BYTES = 4 * 1024 * 1024;

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

// A CSV cell: quoted, and never starting like a spreadsheet formula.
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = rows => rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';

export async function registerFiles(app, ctx, actorFor) {
  const { pool, config, bookings } = ctx;
  const dir = config.uploadDir;
  fs.mkdirSync(dir, { recursive: true });

  app.post('/photos', { bodyLimit: 7 * 1024 * 1024, config: { rateLimit: { max: 80, timeWindow: '10 minutes' } } }, async req => {
    const actor = await actorFor(req);
    if (!actor) fail(401, 'Please sign in.');
    if (!actor.staff) fail(403, 'Staff only.');
    const p = req.body || {};
    const kind = text(p.kind);
    if (!KINDS.includes(kind)) fail(400, 'Pick before, after or damage.');
    const b64 = text(p.data).replace(/^data:image\/[a-z]+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) fail(400, 'No photo was sent.');
    if (buf.length > MAX_BYTES) fail(400, 'That photo is too big. Try again; the page shrinks it first.');
    const type = sniff(buf);
    if (!type) fail(400, 'Only JPEG, PNG or WebP photos.');
    const file = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    return tx(pool, async db => {
      const b = await bookings.lockByRef(db, p.ref);
      const count = (await db.query('select count(*)::int as n from booking_photos where booking_id = $1', [b.id])).rows[0].n;
      if (count >= 40) fail(400, 'This booking already has 40 photos.');
      await fs.promises.writeFile(path.join(dir, file), buf, { flag: 'wx' });
      const row = (await db.query(
        'insert into booking_photos (booking_id, kind, file, mime, bytes, caption, taken_by) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [b.id, kind, file, type.mime, buf.length, opt(p.caption, 120, 'The caption'), actor.id])).rows[0];
      await bookings.event(db, b.id, 'photo', actor, `${kind} photo`);
      return { data: { id: row.id } };
    });
  });

  // Staff, the booking's signed-in customer, or anyone holding the booking's key (?k=).
  app.get('/photos/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) fail(404, 'Not found.');
    const ph = (await pool.query(
      `select ph.file, ph.mime, b.access_key, b.email, c.email as customer_email
         from booking_photos ph join bookings b on b.id = ph.booking_id join customers c on c.id = b.customer_id where ph.id = $1`, [id])).rows[0];
    if (!ph) fail(404, 'Not found.');
    const actor = await actorFor(req);
    const k = text(req.query?.k);
    const allowed = actor?.staff
      || (actor && [ph.email, ph.customer_email].filter(Boolean).some(e => e.toLowerCase() === actor.email.toLowerCase()))
      || (k && k.length === ph.access_key.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ph.access_key)));
    if (!allowed) fail(404, 'Not found.');
    const data = await fs.promises.readFile(path.join(dir, ph.file)).catch(() => null);
    if (!data) fail(404, 'Not found.');
    reply.header('Content-Type', ph.mime).header('Cross-Origin-Resource-Policy', 'same-site');
    return reply.send(data);
  });

  // GET /export/bookings.csv?from=&to=  and  /export/payments.csv  (owners)
  app.get('/export/:what', async (req, reply) => {
    const actor = await actorFor(req);
    if (!actor) fail(401, 'Please sign in.');
    if (!actor.owner) fail(403, 'Only the owners can do this.');
    const today = R.todayISO();
    const from = R.isISODate(req.query?.from) ? req.query.from : today.slice(0, 8) + '01';
    const to = R.isISODate(req.query?.to) ? req.query.to : today;
    let rows, name;
    if (req.params.what === 'bookings.csv') {
      const r = await pool.query(
        `select b.ref, b.booking_date, b.slot, b.status, b.source, b.name, b.phone, b.email, b.package, b.vehicle_type, b.vehicle_desc,
                b.addons, b.location, b.parish, b.total, coalesce((select sum(amount) from payments p where p.booking_id = b.id), 0) as paid,
                b.reward_applied, b.credit_used, b.created_at
           from bookings b where b.booking_date between $1 and $2 order by b.booking_date, b.id`, [from, to]);
      rows = [['Ref', 'Date', 'Slot', 'Status', 'Source', 'Customer', 'Phone', 'Email', 'Package', 'Vehicle', 'Vehicle details',
        'Add-ons', 'Where', 'Parish', 'Price', 'Paid', 'Half-price reward', 'Credit used', 'Booked at']]
        .concat(r.rows.map(x => [x.ref, x.booking_date, x.slot, R.STATUS_LABEL[x.status], SOURCE[x.source] || x.source, x.name, x.phone, x.email, x.package,
          x.vehicle_type, x.vehicle_desc, x.addons, x.location, x.parish, x.total, x.paid, x.reward_applied ? 'yes' : '', x.credit_used,
          new Date(x.created_at).toISOString()]));
      name = `revivv-bookings-${from}-to-${to}.csv`;
    } else if (req.params.what === 'payments.csv') {
      const r = await pool.query(
        `select to_char(p.created_at at time zone '${R.TZ}', 'YYYY-MM-DD HH24:MI') as at, b.ref, b.name, p.method, p.amount, p.note, st.name as taken_by, v.code
           from payments p join bookings b on b.id = p.booking_id left join staff st on st.user_id = p.taken_by
           left join vouchers v on v.id = p.voucher_id
          where (p.created_at at time zone '${R.TZ}')::date between $1 and $2 order by p.id`, [from, to]);
      rows = [['Date and time (Barbados)', 'Ref', 'Customer', 'Method', 'Amount', 'Note', 'Taken by', 'Voucher']]
        .concat(r.rows.map(x => [x.at, x.ref, x.name, METHOD[x.method] || x.method, x.amount, x.note, x.taken_by, x.code]));
      name = `revivv-payments-${from}-to-${to}.csv`;
    } else {
      fail(404, 'Not found.');
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.send('﻿' + csv(rows));
  });
}
