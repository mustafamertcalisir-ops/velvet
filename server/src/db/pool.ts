/**
 * PostgreSQL access. The API is the only database client.
 *
 * - Dates (`date`) come back as 'YYYY-MM-DD' strings — never shifted by a
 *   time zone; timestamps come back as ISO strings.
 * - `tx` runs a function in one transaction (READ COMMITTED) and retries on
 *   serialization failures and deadlocks. Concurrency-sensitive operations
 *   (match creation, batch creation, rate limits) take transaction-scoped
 *   advisory locks and rely on unique constraints — see member/service.ts.
 */
import pg from 'pg';

pg.types.setTypeParser(1082, (v: string) => v); // date
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString()); // timestamptz
pg.types.setTypeParser(1114, (v: string) => new Date(`${v}Z`).toISOString()); // timestamp

export type Db = Pick<pg.PoolClient, 'query'>;
export type Pool = pg.Pool;

/**
 * Transport security for the database connection (DEC-074):
 *   off      no TLS of our own — development/test only (refused in staging/production);
 *            a connection string that asks for TLS (`sslmode=require`…) is
 *            still honoured, so a local tool never downgrades a remote URL
 *   require  encrypted, server certificate NOT verified — for providers whose
 *            private-network endpoint presents a self-signed certificate
 *            (docs/INFRASTRUCTURE_DECISION.md §2)
 *   verify   encrypted and verified against DATABASE_CA_CERT (PEM) or the system CAs
 * With require/verify, `sslmode` & co. in the URL are ignored: node-postgres
 * would let them override this setting, so they are stripped and
 * DATABASE_TLS decides.
 */
export type DatabaseTls = { mode: 'off' } | { mode: 'require' } | { mode: 'verify'; ca: string | null };

export type DatabaseOptions = { tls: DatabaseTls; max: number; applicationName?: string };

const SSL_URL_PARAMS = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'sslnegotiation', 'uselibpqcompat'];

/** The connection string without TLS parameters (DATABASE_TLS is authoritative). */
export function withoutTlsParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    for (const p of SSL_URL_PARAMS) url.searchParams.delete(p);
    return url.toString();
  } catch {
    return connectionString;
  }
}

/** Parse DATABASE_TLS / DATABASE_CA_CERT / DATABASE_POOL_MAX (shared by the API and the migration CLI). */
export function databaseOptionsFrom(
  env: Record<string, string | undefined>,
  releaseLike: boolean,
): { options: DatabaseOptions; problems: string[] } {
  const problems: string[] = [];
  const mode = env.DATABASE_TLS ?? (releaseLike ? 'require' : 'off');
  let tls: DatabaseTls = { mode: 'off' };
  if (mode === 'require') tls = { mode: 'require' };
  else if (mode === 'verify') tls = { mode: 'verify', ca: env.DATABASE_CA_CERT?.replace(/\\n/g, '\n') ?? null };
  else if (mode !== 'off') problems.push(`DATABASE_TLS "${mode}" is not recognised (off | require | verify)`);
  if (releaseLike && tls.mode === 'off') problems.push('DATABASE_TLS=off is refused outside development: the database connection must be encrypted');
  const max = Number(env.DATABASE_POOL_MAX ?? 10);
  if (!Number.isInteger(max) || max < 1 || max > 50) problems.push('DATABASE_POOL_MAX must be a whole number from 1 to 50');
  return { options: { tls, max: Number.isInteger(max) && max >= 1 && max <= 50 ? max : 10 }, problems };
}

function sslOption(tls: DatabaseTls): pg.PoolConfig['ssl'] {
  if (tls.mode === 'off') return undefined; // the connection string decides
  if (tls.mode === 'require') return { rejectUnauthorized: false };
  return tls.ca ? { rejectUnauthorized: true, ca: tls.ca } : { rejectUnauthorized: true };
}

export function createPool(connectionString: string, maxOrOptions: number | DatabaseOptions = 10): pg.Pool {
  const o: DatabaseOptions = typeof maxOrOptions === 'number' ? { tls: { mode: 'off' }, max: maxOrOptions } : maxOrOptions;
  const pool = new pg.Pool({
    connectionString: o.tls.mode === 'off' ? connectionString : withoutTlsParams(connectionString),
    ...(o.tls.mode === 'off' ? {} : { ssl: sslOption(o.tls) }),
    max: o.max,
    application_name: o.applicationName ?? 'velvet-api',
  });
  // An idle client error (e.g. the database restarting) must not crash the process; logged as a structured line, without details.
  pool.on('error', (e: Error & { code?: string }) =>
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', service: 'velvet-api', event: 'db.idle_client_error', pgCode: e.code ?? null })),
  );
  return pool;
}

const RETRYABLE = new Set(['40001', '40P01']);

export async function tx<T>(pool: pg.Pool, fn: (db: pg.PoolClient) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (i < attempts && RETRYABLE.has((e as { code?: string }).code ?? '')) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}

/** A transaction-scoped lock on an arbitrary key (released at COMMIT/ROLLBACK). */
export async function lockKey(db: Db, key: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}
