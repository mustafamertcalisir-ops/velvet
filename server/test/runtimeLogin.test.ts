/**
 * Platform-generated credentials (DEC-081): the runtime login is created by
 * the release step from a generated password and stored only as a SCRAM
 * verifier; the API derives its connection without anyone handling the
 * password; internal key secrets can live in their own generated variables.
 * (The rehearsal proves the verifier end to end: the API signs in over TLS
 * with SCRAM against a server whose statement log never sees the password.)
 */
import { parse } from 'pg-connection-string';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { ensureRuntimeLogin, ensureStagingPlan, runtimeDatabaseUrl, scramVerifier } from '../src/db/runtimeLogin';
import { testServer, type T } from './harness';

const generated = 'Zm9vYmFyYmF6+/=qux0123456789abcdefghiJKLMNOP'; // base64-like, with the characters URLs care about

describe('SCRAM verifier', () => {
  it('matches an independent implementation (Python hashlib/hmac) for a fixed salt', () => {
    expect(scramVerifier('pencil-0123456789-abcdefghijklmnop+/=', Buffer.from([...Array(16).keys()]))).toBe(
      'SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$nBTF6mnETjpgAnyKITvfy8Gusk37aDSbAZKgumxTHrA=:niFT0CNOLaaaT7L9zZCAOG+xvwPOj1cxeV5K6l7i+54=',
    );
  });
  it('uses a fresh salt every time and never contains the password', () => {
    const a = scramVerifier(generated);
    const b = scramVerifier(generated);
    expect(a).not.toBe(b);
    expect(a).not.toContain(generated);
  });
});

describe('the API connection derived from the owner URL', () => {
  const owner = 'postgresql://render_owner:password@dpg-abc123-a/velvet';
  it('replaces only the user and password; the password survives URL encoding exactly', () => {
    const r = runtimeDatabaseUrl({ MIGRATION_DATABASE_URL: owner, DATABASE_RUNTIME_USER: 'velvet_api', DATABASE_RUNTIME_PASSWORD: generated });
    expect(r.problems).toEqual([]);
    expect(r.derived).toBe(true);
    const p = parse(r.url);
    expect(p.user).toBe('velvet_api');
    expect(p.password).toBe(generated);
    expect(p.host).toBe('dpg-abc123-a');
    expect(p.database).toBe('velvet');
    expect(r.url).not.toContain('render_owner:password');
  });
  it('an explicit DATABASE_URL wins, but not together with a generated login', () => {
    expect(runtimeDatabaseUrl({ DATABASE_URL: 'postgres://x:y@h/d' })).toMatchObject({ url: 'postgres://x:y@h/d', derived: false, problems: [] });
    expect(runtimeDatabaseUrl({ DATABASE_URL: 'postgres://x:y@h/d', DATABASE_RUNTIME_USER: 'velvet_api', DATABASE_RUNTIME_PASSWORD: generated }).problems).toEqual([
      'Set either DATABASE_URL or DATABASE_RUNTIME_USER/DATABASE_RUNTIME_PASSWORD, not both',
    ]);
  });
  it('refuses the owner name, the group name, weak or non-ASCII passwords, and a missing owner URL', () => {
    expect(runtimeDatabaseUrl({ MIGRATION_DATABASE_URL: owner, DATABASE_RUNTIME_USER: 'render_owner', DATABASE_RUNTIME_PASSWORD: generated }).problems).toEqual([
      'DATABASE_RUNTIME_USER must differ from the schema owner',
    ]);
    expect(runtimeDatabaseUrl({ MIGRATION_DATABASE_URL: owner, DATABASE_RUNTIME_USER: 'velvet_runtime', DATABASE_RUNTIME_PASSWORD: generated }).problems[0]).toMatch(/group role/);
    expect(runtimeDatabaseUrl({ MIGRATION_DATABASE_URL: owner, DATABASE_RUNTIME_USER: 'velvet_api', DATABASE_RUNTIME_PASSWORD: 'short' }).problems[0]).toMatch(/32–256 printable ASCII/);
    expect(runtimeDatabaseUrl({ MIGRATION_DATABASE_URL: owner, DATABASE_RUNTIME_USER: 'velvet_api', DATABASE_RUNTIME_PASSWORD: `${'ş'.repeat(40)}` }).problems[0]).toMatch(/printable ASCII/);
    expect(runtimeDatabaseUrl({ DATABASE_RUNTIME_USER: 'velvet_api', DATABASE_RUNTIME_PASSWORD: generated }).problems[0]).toMatch(/MIGRATION_DATABASE_URL is required/);
    expect(runtimeDatabaseUrl({}).problems[0]).toMatch(/DATABASE_URL \(or DATABASE_RUNTIME_USER/);
  });
  it('staging accepts the derived connection and still refuses the owner credential as the API’s', () => {
    const base = {
      APP_ENV: 'staging',
      MIGRATION_DATABASE_URL: owner,
      DATABASE_TLS: 'require',
      OTP_SECRET: 'p'.repeat(48),
      MEDIA_SIGNING_SECRET: 'm'.repeat(48),
      INTERNAL_KEYS_JSON: JSON.stringify({ runner: { secretEnv: 'INTERNAL_KEY_RUNNER_SECRET', scopes: ['test:otp', 'test:review'] } }),
      INTERNAL_KEY_RUNNER_SECRET: 'r'.repeat(44),
      PUBLIC_BASE_URL: 'https://velvet-api-staging.onrender.com',
      SMS_PROVIDER: 'none',
      S3_BUCKET: 'velvet-staging-media',
      S3_VERIFICATION_BUCKET: 'velvet-staging-verification',
    };
    const config = loadConfig({ ...base, DATABASE_RUNTIME_USER: 'velvet_api', DATABASE_RUNTIME_PASSWORD: generated });
    expect(parse(config.databaseUrl).user).toBe('velvet_api');
    expect(config.internalKeys.runner).toEqual({ secret: 'r'.repeat(44), scopes: ['test:otp', 'test:review'] });
    expect(() => loadConfig({ ...base, DATABASE_URL: owner })).toThrow(ConfigError);
  });
});

describe('internal key secrets in their own variables', () => {
  const problems = (json: unknown, extra: Record<string, string> = {}) => {
    try {
      loadConfig({ APP_ENV: 'development', DATABASE_URL: 'postgres://u@h/d', INTERNAL_KEYS_JSON: JSON.stringify(json), ...extra });
      return [];
    } catch (e) {
      return (e as ConfigError).problems;
    }
  };
  it('reads the named INTERNAL_KEY_* variable; refuses both forms, other variable names and short secrets', () => {
    expect(problems({ ops: { secretEnv: 'INTERNAL_KEY_OPS_SECRET', scopes: ['retention:run'] } }, { INTERNAL_KEY_OPS_SECRET: 'o'.repeat(44) })).toEqual([]);
    expect(problems({ ops: { secretEnv: 'INTERNAL_KEY_OPS_SECRET', secret: 'o'.repeat(44), scopes: ['retention:run'] } }, { INTERNAL_KEY_OPS_SECRET: 'o'.repeat(44) })).toContain(
      'INTERNAL_KEYS_JSON: "ops" has both secret and secretEnv',
    );
    expect(problems({ ops: { secretEnv: 'DATABASE_URL', scopes: ['retention:run'] } })).toContain('INTERNAL_KEYS_JSON: "ops" secretEnv must name an INTERNAL_KEY_* variable');
    expect(problems({ ops: { secretEnv: 'INTERNAL_KEY_OPS_SECRET', scopes: ['retention:run'] } })).toContain('INTERNAL_KEYS_JSON: "ops" secret must be at least 32 characters');
  });
});

describe('the release step manages the runtime login (against PostgreSQL)', () => {
  let t: T;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(async () => {
    await t.admin.query('DROP ROLE IF EXISTS velvet_rt_check');
    await t.close();
  });

  it('creates it once, then re-asserts it; only the group’s privileges; the server stores a verifier, never the password', async () => {
    expect(await ensureRuntimeLogin(t.admin, { user: 'velvet_rt_check', password: generated })).toBe('created');
    expect(await ensureRuntimeLogin(t.admin, { user: 'velvet_rt_check', password: generated })).toBe('updated');
    const { rows } = await t.admin.query(
      `SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolconnlimit, a.rolpassword,
              pg_has_role('velvet_rt_check', 'velvet_runtime', 'MEMBER') AS in_runtime,
              has_schema_privilege('velvet_rt_check', 'public', 'CREATE') AS public_create
         FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid WHERE r.rolname = 'velvet_rt_check'`,
    );
    expect(rows[0]).toMatchObject({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 40,
      in_runtime: true,
    });
    expect(rows[0].rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(rows[0].rolpassword).not.toContain(generated);
  });

  it('refuses to finish when the login carries more than the group allows', async () => {
    await t.admin.query('ALTER ROLE velvet_rt_check CREATEDB');
    await expect(ensureRuntimeLogin(t.admin, { user: 'velvet_rt_check', password: generated })).rejects.toThrow(/more than the runtime group allows \(rolcreatedb\)/);
    await t.admin.query('ALTER ROLE velvet_rt_check NOCREATEDB');
  });

  it('creates the staging plan only in staging, once', async () => {
    expect(await ensureStagingPlan(t.admin, 'production')).toBe(false);
    expect(await ensureStagingPlan(t.admin, 'staging')).toBe(true);
    expect(await ensureStagingPlan(t.admin, 'staging')).toBe(false);
    const { rows } = await t.admin.query(`SELECT is_development_fixture FROM app.membership_plans WHERE id = 'plan_staging'`);
    expect(rows).toEqual([{ is_development_fixture: true }]);
  });
});
