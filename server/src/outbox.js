/*
 * Emails go into the outbox table first, in the same transaction as the change
 * they describe, and a worker sends them. With no mailbox on the live server
 * they are 'held': kept for staff to read, never sent later by surprise.
 */
export function createOutbox({ pool, mailer, config, log = console }) {
  const hold = config.production && !mailer.ready;

  async function queue(db, { to, kind, subject, body, bookingId = null, customerId = null }) {
    if (!to) return null;
    const r = await db.query(
      `insert into outbox (to_addr, subject, body, kind, booking_id, customer_id, status)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [to, subject, body, kind, bookingId, customerId, hold ? 'held' : 'pending']);
    return r.rows[0].id;
  }

  // Was an email of this kind queued for this customer in the last few minutes?
  async function recent(db, customerId, kind, minutes) {
    const r = await db.query(
      "select 1 from outbox where customer_id = $1 and kind = $2 and created_at > now() - make_interval(mins => $3) limit 1",
      [customerId, kind, minutes]);
    return r.rowCount > 0;
  }

  let running = false;
  async function sendDue() {
    if (running || hold) return 0;
    running = true;
    let sent = 0;
    try {
      for (;;) {
        const client = await pool.connect();
        let row;
        try {
          await client.query('begin');
          row = (await client.query(
            `select * from outbox where status = 'pending' and send_after <= now()
              order by id limit 1 for update skip locked`)).rows[0];
          if (!row) { await client.query('commit'); break; }
          try {
            await mailer.send({ to: row.to_addr, subject: row.subject, text: row.body });
            await client.query("update outbox set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = $1", [row.id]);
            sent++;
          } catch (e) {
            // try again after 1, 2, 4, 8, 16 minutes, then give up
            const failed = row.attempts + 1 >= 6;
            await client.query(
              `update outbox set attempts = attempts + 1, last_error = $2, status = $3,
                      send_after = now() + make_interval(mins => $4) where id = $1`,
              [row.id, String(e.message).slice(0, 300), failed ? 'failed' : 'pending', 2 ** row.attempts]);
            log.warn?.(`[outbox] email ${row.id} not sent: ${e.message}`);
          }
          await client.query('commit');
        } catch (e) {
          await client.query('rollback').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      }
    } finally {
      running = false;
    }
    return sent;
  }

  return { queue, recent, sendDue, hold };
}
