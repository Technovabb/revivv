/*
 * Starts the Revivv API: brings the database up to date, then listens on
 * 127.0.0.1:4380 behind Caddy (api.revivvbb.com).
 */
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { createMailer } from './mail.js';
import { buildApp } from './app.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
const app = await buildApp({ config, pool, mailer: createMailer(config.mail) });
if (applied.length) app.log.info(`database migrations applied: ${applied.join(', ')}`);
if (config.mail.mode !== 'graph') app.log.warn('MAIL_MODE is not graph: password reset emails are not sent');

// Clear out expired sessions and old one-time links once a day.
async function tidy() {
  await pool.query('delete from sessions where expires_at < now()');
  await pool.query("delete from password_tokens where expires_at < now() - interval '7 days'");
}
tidy().catch(e => app.log.error(e));
setInterval(() => tidy().catch(e => app.log.error(e)), 24 * 3600 * 1000).unref();

await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
