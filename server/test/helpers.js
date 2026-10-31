// A throwaway PostgreSQL for the tests, and a small cookie-keeping client.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { createJobs } from '../src/jobs.js';
import { todayISO, addDays, weekday } from '../src/rules.js';
import { DEFAULTS } from '../src/settings.js';

const CLOSED = DEFAULTS.hours.closedWeekdays;

export const ORIGIN = 'https://revivvbb.com';

export async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revivv-pg-'));
  const port = 54000 + Math.floor(Math.random() * 1000);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false, onLog: () => {}, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('revivv');
  const pool = createPool(`postgresql://postgres:test@127.0.0.1:${port}/revivv`);
  await migrate(pool);
  const mail = [];
  const mailer = { ready: true, async send(m) { mail.push(m); } };
  const config = {
    production: false, trustProxy: false, siteOrigins: [ORIGIN, 'http://localhost:4318'], sessionDays: 60, rateLimits: false,
    uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'revivv-up-'))
  };
  const app = await buildApp({ config, pool, mailer, logger: false });
  const jobs = createJobs({ pool, services: app.services, config, log: { error() {} } });
  // the same app with the real rate limits, for the one test that checks them
  const limited = await buildApp({ config: { ...config, rateLimits: true }, pool, mailer, logger: false });
  return {
    app, limited, pool, mail, jobs, config,
    async stop() {
      await app.close();
      await limited.close();
      await pool.end();
      await pg.stop();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(config.uploadDir, { recursive: true, force: true });
    }
  };
}

export function client(app, origin = ORIGIN) {
  let cookie = '';
  async function send(method, url, body) {
    const headers = {};
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers['set-cookie'];
    if (set) {
      const pair = String(Array.isArray(set) ? set[0] : set).split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    let json = null;
    try { json = res.json(); } catch { /* empty body */ }
    return { status: res.statusCode, body: json, headers: res.headers };
  }
  return {
    get: url => send('GET', url),
    post: (url, body = {}) => send('POST', url, body),
    rpc: (name, params = {}) => send('POST', '/rpc/' + name, params),
    get cookie() { return cookie; }
  };
}

// The n-th day from tomorrow that customers can book (skips closed weekdays).
export function workday(n = 0) {
  let d = addDays(todayISO(), 1), seen = -1;
  for (;;) {
    if (!CLOSED.includes(weekday(d)) && ++seen === n) return d;
    d = addDays(d, 1);
  }
}

// The first closed weekday from tomorrow (customers can't book it; staff can).
export function closedDay() {
  let d = addDays(todayISO(), 1);
  while (!CLOSED.includes(weekday(d))) d = addDays(d, 1);
  return d;
}

export function booking(over = {}) {
  return {
    p_name: 'Kim Best', p_email: 'kim@example.com', p_phone: '246 555 0101',
    p_date: workday(0), p_slot: 'morning', p_vehicle_type: 'Car', p_vehicle_desc: 'Grey Corolla',
    p_package: 'The Express Exterior', p_addons: null, p_total: 90,
    p_location: 'Drop off — customer comes to us', p_parish: 'St. Michael', p_address: null, p_notes: null, p_referral: null,
    ...over
  };
}
