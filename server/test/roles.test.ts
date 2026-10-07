/**
 * Least-privilege database access (DEC-074): the API's runtime role can only
 * read and write rows — no DDL, no TRUNCATE, no changes to append-only logs,
 * plans or the migration ledger — and every table carries the runtime grant
 * and policy (a new table without them fails here). Transport security for
 * the database connection is explicit and fail-closed in staging/production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { ConfigError, ipInCidrs, loadConfig, parseCidr } from '../src/config';
import { createPool, databaseOptionsFrom, withoutTlsParams } from '../src/db/pool';
import { checkRuntimeRole } from '../src/db/role';
import { testServer, type T } from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer();
});
afterAll(async () => t.close());

describe('runtime role', () => {
  it('every app table has row-level security, the runtime policy and the runtime grant', async () => {
    const { rows } = await t.admin.query<{ table: string; rls: boolean; policy: boolean; can_select: boolean }>(
      `SELECT c.relname AS table, c.relrowsecurity AS rls,
              EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname
                        AND p.policyname = 'runtime_access' AND 'velvet_runtime' = ANY (p.roles)) AS policy,
              has_table_privilege('velvet_runtime', c.oid, 'SELECT') AS can_select
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(25);
    expect(rows.filter((r) => !r.rls || !r.policy || !r.can_select).map((r) => r.table)).toEqual([]);
  });

  it('the API connects as a role that is not a superuser, cannot bypass RLS and does not own the schema', async () => {
    expect(await checkRuntimeRole(t.pool)).toEqual({ role: 'velvet_api_test', problems: [] });
    // The owner (here also a superuser) is refused.
    const owner = await checkRuntimeRole(t.admin);
    expect(owner.problems).toEqual(expect.arrayContaining(['is a superuser']));
    expect(owner.problems.some((p) => p.startsWith('owns the app schema'))).toBe(true);
  });

  it('cannot change the schema, truncate, edit append-only logs, plans or the migration ledger', async () => {
    const denied = [
      `CREATE TABLE app.x (id int)`,
      `DROP TABLE app.reports`,
      `ALTER TABLE app.accounts ADD COLUMN x int`,
      `TRUNCATE app.rate_limit_events`,
      `UPDATE app.media_access_log SET purpose = 'REVIEW'`,
      `INSERT INTO app.membership_plans (id, name, billing_period, price_minor, currency, is_development_fixture) VALUES ('p', 'P', 'monthly', 1, 'TRY', false)`,
      `INSERT INTO app_meta.schema_migrations (version, checksum) VALUES ('x.sql', 'x')`,
      `CREATE ROLE intruder LOGIN`,
      `CREATE SCHEMA other`,
      `ALTER TABLE app.accounts DISABLE ROW LEVEL SECURITY`,
    ];
    for (const sql of denied) await expect(t.pool.query(sql), sql).rejects.toThrow(/permission denied|must be owner/);
    // It can read the ledger (readiness) and plans (activation).
    await expect(t.pool.query('SELECT count(*) FROM app_meta.schema_migrations')).resolves.toBeTruthy();
    await expect(t.pool.query('SELECT count(*) FROM app.membership_plans')).resolves.toBeTruthy();
  });
});

describe('database transport security', () => {
  it('is required outside development; off is refused in staging/production', () => {
    expect(databaseOptionsFrom({}, true).options.tls).toEqual({ mode: 'require' });
    expect(databaseOptionsFrom({}, false).options.tls).toEqual({ mode: 'off' });
    expect(databaseOptionsFrom({ DATABASE_TLS: 'off' }, true).problems.join()).toMatch(/refused outside development/);
    expect(databaseOptionsFrom({ DATABASE_TLS: 'verify', DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nX' }, true).options.tls).toEqual({
      mode: 'verify',
      ca: '-----BEGIN CERTIFICATE-----\nX',
    });
    expect(databaseOptionsFrom({ DATABASE_TLS: 'maybe' }, false).problems.join()).toMatch(/not recognised/);
    expect(databaseOptionsFrom({ DATABASE_POOL_MAX: '500' }, false).problems.join()).toMatch(/DATABASE_POOL_MAX/);
  });

  it('URL ssl parameters cannot override DATABASE_TLS require/verify; with TLS off, a URL asking for TLS is still honoured', async () => {
    expect(withoutTlsParams('postgres://u:p@h:5432/db?sslmode=disable&sslnegotiation=direct&application_name=x')).toBe('postgres://u:p@h:5432/db?application_name=x');
    // No downgrade: DATABASE_TLS unset (development) + sslmode=require in the URL → TLS is still requested.
    const url = new URL(inject('adminUrl'));
    url.searchParams.set('sslmode', 'require');
    const asked = createPool(url.toString(), { tls: { mode: 'off' }, max: 1 });
    await expect(asked.query('SELECT 1')).rejects.toThrow(/does not support SSL/i);
    await asked.end();
  });

  it('with TLS required, a server that offers no TLS is refused — never a silent plaintext fallback', async () => {
    const plain = createPool(inject('adminUrl'), { tls: { mode: 'require' }, max: 1 });
    await expect(plain.query('SELECT 1')).rejects.toThrow(/does not support SSL/i);
    await plain.end();
  });

  it('staging refuses the migration credential as the API credential', () => {
    const env = {
      APP_ENV: 'staging',
      DATABASE_URL: 'postgres://owner:x@db/velvet',
      MIGRATION_DATABASE_URL: 'postgres://owner:x@db/velvet',
      OTP_SECRET: 'p'.repeat(48),
      MEDIA_SIGNING_SECRET: 'm'.repeat(48),
      INTERNAL_KEYS_JSON: JSON.stringify({ ops: { secret: 'o'.repeat(48), scopes: ['retention:run'] } }),
      PUBLIC_BASE_URL: 'https://api-staging.example.com',
      CORS_ORIGINS: 'https://staging.example.com',
      S3_BUCKET: 'm',
      S3_VERIFICATION_BUCKET: 'v',
    };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, DATABASE_URL: 'postgres://velvet_api:y@db/velvet' })).not.toThrow();
  });
});

describe('internal network allow list', () => {
  it('parses IPv4 and IPv6 ranges and matches addresses (IPv4-mapped included)', () => {
    expect(parseCidr('10.0.0.0/8')).not.toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('2001:db8::/32')).not.toBeNull();
    expect(parseCidr('nonsense')).toBeNull();
    expect(ipInCidrs('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipInCidrs('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipInCidrs('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(ipInCidrs('203.0.113.7', ['203.0.113.7/32'])).toBe(true);
    expect(ipInCidrs('203.0.113.8', ['203.0.113.7/32'])).toBe(false);
    expect(ipInCidrs('2001:db8:1::5', ['2001:db8::/32'])).toBe(true);
    expect(ipInCidrs('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(ipInCidrs('not-an-ip', ['0.0.0.0/0'])).toBe(false);
    expect(ipInCidrs('192.0.2.1', ['0.0.0.0/0'])).toBe(true);
  });
});
