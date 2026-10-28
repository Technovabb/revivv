/*
 * Applies db/migrations/*.sql in order, once each. Runs at every start, and on
 * its own with `npm run migrate`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export async function migrate(pool) {
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map(r => r.name));
  const applied = [];
  for (const name of fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(fs.readFileSync(path.join(DIR, name), 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [name]);
      await client.query('commit');
      applied.push(name);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw new Error(`migration ${name} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(process.env.DATABASE_URL);
  migrate(pool)
    .then(a => console.log(a.length ? `applied: ${a.join(', ')}` : 'database is up to date'))
    .catch(e => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
