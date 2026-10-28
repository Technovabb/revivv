/*
 * Starts the Revivv API: brings the database up to date, then listens on
 * 127.0.0.1:4380 behind Caddy (api.revivvbb.com), and runs the timed jobs.
 */
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { createMailer } from './mail.js';
import { buildApp } from './app.js';
import { createJobs } from './jobs.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
const app = await buildApp({ config, pool, mailer: createMailer(config.mail) });
if (applied.length) app.log.info(`database migrations applied: ${applied.join(', ')}`);
if (app.services.outbox.hold) app.log.warn('No mailbox (MAIL_MODE is not graph): emails are held in the outbox, not sent');

const stopJobs = createJobs({ pool, services: app.services, config, log: app.log }).start();
await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    stopJobs();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
