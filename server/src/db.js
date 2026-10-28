import pg from 'pg';

// Keep dates as 'YYYY-MM-DD' strings and money as numbers, never JS Dates or strings.
pg.types.setTypeParser(1082, v => v);                 // date
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));  // numeric
pg.types.setTypeParser(20, v => Number(v));            // bigint ids

export function createPool(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

// Run fn(client) inside a transaction.
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
