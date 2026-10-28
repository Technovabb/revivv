/*
 * Email (password-reset links) through Microsoft Graph, the same way the H&R
 * app sends mail: an app registration limited to one sender mailbox, with its
 * three values in the server's settings file. MAIL_MODE=log sends nothing.
 */
export function createMailer(cfg, log = console) {
  if (cfg.mode !== 'graph') {
    return {
      ready: false,
      async send({ to, subject, text }) {
        // Links carry a secret token, so only print them on a developer's machine.
        if (process.env.NODE_ENV === 'production') log.warn(`[mail] not configured: "${subject}" to ${to} was not sent`);
        else log.info(`[mail] to=${to} subject="${subject}"\n${text}`);
      }
    };
  }
  const { tenantId, clientId, clientSecret, sender } = cfg;
  if (!(tenantId && clientId && clientSecret && sender)) throw new Error('MAIL_MODE=graph needs GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_SENDER');
  let token = null, tokenUntil = 0;

  async function accessToken() {
    if (token && Date.now() < tokenUntil - 60_000) return token;
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
      })
    });
    if (!res.ok) throw new Error(`Microsoft sign-in failed (${res.status})`);
    const json = await res.json();
    token = json.access_token;
    tokenUntil = Date.now() + Number(json.expires_in || 3600) * 1000;
    return token;
  }

  return {
    ready: true,
    async send({ to, subject, text }) {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: { subject, body: { contentType: 'Text', content: text }, toRecipients: [{ emailAddress: { address: to } }] },
          saveToSentItems: false
        })
      });
      if (res.status !== 202) throw new Error(`Email not accepted by Microsoft (${res.status})`);
    }
  };
}
