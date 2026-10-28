/*
 * Settings come from the environment. On the server they live in
 * /etc/revivv-api.env (see deploy/revivv-api.env.template); nothing secret is in git.
 */
import os from 'node:os';
import path from 'node:path';
export function loadConfig(env = process.env) {
  const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
  const config = {
    production: env.NODE_ENV === 'production',
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 4380),
    trustProxy: env.TRUST_PROXY || false,
    databaseUrl: env.DATABASE_URL || '',
    // pages allowed to call the API with a signed-in cookie, and to receive reset links
    siteOrigins: list(env.SITE_ORIGINS || 'https://revivvbb.com'),
    sessionDays: Number(env.SESSION_DAYS || 60),
    // job photos; on the server systemd makes /var/lib/revivv (StateDirectory)
    uploadDir: env.UPLOAD_DIR || (env.NODE_ENV === 'production' ? '/var/lib/revivv/uploads' : path.join(os.tmpdir(), 'revivv-uploads')),
    mail: {
      mode: env.MAIL_MODE || 'log',          // 'graph' sends through Microsoft 365; 'log' only logs
      tenantId: env.GRAPH_TENANT_ID || '',
      clientId: env.GRAPH_CLIENT_ID || '',
      clientSecret: env.GRAPH_CLIENT_SECRET || '',
      sender: env.GRAPH_SENDER || ''
    }
  };
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  return config;
}
