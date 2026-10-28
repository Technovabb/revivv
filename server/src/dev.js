/*
 * Local development: a private PostgreSQL kept in server/.dev-db and the API
 * on http://localhost:4380, for the site served on http://localhost:4318.
 *
 *   node src/dev.js            keep the data from last time
 *   node src/dev.js --fresh    start with an empty database
 *
 * Seeds one staff login for testing: staff@revivv.test / revivv-dev-staff
 * (local only; never used on the real server).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev-db');
if (process.argv.includes('--fresh')) fs.rmSync(dir, { recursive: true, force: true });
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'dev', port: 5439, persistent: true, onLog: () => {} });
if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
await pg.createDatabase('revivv').catch(() => {});   // already there

process.env.DATABASE_URL = 'postgresql://postgres:dev@127.0.0.1:5439/revivv';
process.env.SITE_ORIGINS ||= 'http://localhost:4318,http://127.0.0.1:4318';
process.env.MAIL_MODE ||= 'log';

await import('./server.js');

const { createPool } = await import('./db.js');
const { hashPassword } = await import('./passwords.js');
const pool = createPool(process.env.DATABASE_URL);
const u = await pool.query(
  'insert into users (email, password_hash) values ($1, $2) on conflict ((lower(email))) do update set email = users.email returning id',
  ['staff@revivv.test', await hashPassword('revivv-dev-staff')]);
await pool.query("insert into staff (user_id, name) values ($1, 'Dev Staff') on conflict do nothing", [u.rows[0].id]);
await pool.end();

process.once('exit', () => { pg.stop(); });
