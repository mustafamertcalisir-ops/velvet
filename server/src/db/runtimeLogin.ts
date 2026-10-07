/**
 * The API's runtime login, managed by the release step (DEC-081).
 *
 * The platform generates the password (`DATABASE_RUNTIME_PASSWORD`, e.g. Render
 * `generateValue`), so no person ever sees, types or copies it:
 *   - the release step (`node dist/migrate.mjs`, as the schema owner) creates
 *     the login `DATABASE_RUNTIME_USER` in the `velvet_runtime` group
 *     (migration 0010) or re-asserts it, and sets its password as a
 *     SCRAM-SHA-256 verifier computed HERE — the plaintext never reaches the
 *     server, so a statement log can only ever show the verifier (the same
 *     thing psql's \password does);
 *   - the API derives its DATABASE_URL from the owner's URL (host, port,
 *     database, TLS parameters) with the runtime user and password in place
 *     of the owner's, and refuses the owner credential (DEC-074).
 *
 * An explicit DATABASE_URL still wins (other hosts; the manual procedure in
 * infra/postgres/create-runtime-login.sql). Rotation: regenerate the value in
 * the platform and redeploy — the release step sets the new verifier before
 * the new version starts.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';

export const RUNTIME_GROUP = 'velvet_runtime';
const USER = /^[a-z][a-z0-9_]{2,40}$/;
/** Printable ASCII only: SASLprep is then the identity, so the verifier matches what the server computes. */
const PASSWORD = /^[\x21-\x7e]{32,256}$/;

export type RuntimeLogin = { user: string; password: string };

/** The runtime login named by the environment, or null when the manual DATABASE_URL procedure is used. */
export function runtimeLoginFrom(env: Record<string, string | undefined>): { login: RuntimeLogin | null; problems: string[] } {
  const user = env.DATABASE_RUNTIME_USER ?? '';
  const password = env.DATABASE_RUNTIME_PASSWORD ?? '';
  if (!user && !password) return { login: null, problems: [] };
  const problems: string[] = [];
  if (!USER.test(user)) problems.push('DATABASE_RUNTIME_USER must be a lower-case role name (3–41 characters, a–z, 0–9, _)');
  if (user === RUNTIME_GROUP) problems.push(`DATABASE_RUNTIME_USER cannot be the group role ${RUNTIME_GROUP}`);
  if (!PASSWORD.test(password)) problems.push('DATABASE_RUNTIME_PASSWORD must be 32–256 printable ASCII characters (let the platform generate it)');
  return { login: problems.length ? null : { user, password }, problems };
}

/**
 * The API's database URL: DATABASE_URL when given; otherwise the owner's URL
 * with the runtime login in place of the owner (same host, database and
 * parameters). Never the owner credential itself.
 */
export function runtimeDatabaseUrl(env: Record<string, string | undefined>): { url: string; derived: boolean; problems: string[] } {
  const explicit = env.DATABASE_URL ?? '';
  const { login, problems } = runtimeLoginFrom(env);
  if (explicit) {
    if (login) problems.push('Set either DATABASE_URL or DATABASE_RUNTIME_USER/DATABASE_RUNTIME_PASSWORD, not both');
    return { url: explicit, derived: false, problems };
  }
  if (!login) return { url: '', derived: false, problems: problems.length ? problems : ['DATABASE_URL (or DATABASE_RUNTIME_USER and DATABASE_RUNTIME_PASSWORD) is required'] };
  const owner = env.MIGRATION_DATABASE_URL ?? '';
  let u: URL;
  try {
    u = new URL(owner);
  } catch {
    return { url: '', derived: false, problems: ['MIGRATION_DATABASE_URL is required to derive the runtime connection (DATABASE_RUNTIME_USER)'] };
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { url: '', derived: false, problems: ['MIGRATION_DATABASE_URL must be a postgres:// URL'] };
  if (decodeURIComponent(u.username) === login.user) return { url: '', derived: false, problems: ['DATABASE_RUNTIME_USER must differ from the schema owner'] };
  u.username = encodeURIComponent(login.user);
  u.password = encodeURIComponent(login.password);
  return { url: u.toString(), derived: true, problems: [] };
}

/** SCRAM-SHA-256 verifier (RFC 5802 / 7677), in PostgreSQL's stored format. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Create or re-assert the runtime login (run by the schema owner, after the
 * migrations). Idempotent. Refuses to finish if the login ended up with any
 * privilege beyond the group's — the API would refuse it anyway (role.ts).
 */
export async function ensureRuntimeLogin(client: pg.Pool | pg.PoolClient, login: RuntimeLogin): Promise<'created' | 'updated'> {
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
  const group = await q('SELECT 1 FROM pg_roles WHERE rolname = $1', [RUNTIME_GROUP]);
  if (!group.rowCount) throw new Error(`${RUNTIME_GROUP} does not exist: migration 0010 must run first`);
  const ident = `"${login.user}"`; // validated: ^[a-z][a-z0-9_]+$ — no quoting issues
  const verifier = scramVerifier(login.password);
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error('unexpected verifier format');
  const literal = `'${verifier}'`; // base64, '$' and ':' only — checked above
  const exists = (await q('SELECT 1 FROM pg_roles WHERE rolname = $1', [login.user])).rowCount;
  if (!exists) {
    await q(
      `CREATE ROLE ${ident} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40 IN ROLE ${RUNTIME_GROUP} PASSWORD ${literal}`,
    );
  } else {
    // Only attributes a CREATEROLE owner may set on a role it administers; the rest is verified below.
    await q(`ALTER ROLE ${ident} WITH LOGIN CONNECTION LIMIT 40 PASSWORD ${literal}`);
    const member = await q('SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE g.rolname = $1 AND r.rolname = $2', [
      RUNTIME_GROUP,
      login.user,
    ]);
    if (!member.rowCount) await q(`GRANT ${RUNTIME_GROUP} TO ${ident}`);
  }
  await q(`REVOKE CREATE ON SCHEMA public FROM ${ident}`);
  const { rows } = await q(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
            EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles o ON o.oid = m.roleid
                     WHERE m.member = r.oid AND o.rolname <> $2) AS other_memberships
       FROM pg_roles r WHERE rolname = $1`,
    [login.user, RUNTIME_GROUP],
  );
  const r = rows[0] as Record<string, boolean>;
  const extra = ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'other_memberships'].filter((k) => r[k]);
  if (extra.length) throw new Error(`the runtime login ${login.user} has more than the runtime group allows (${extra.join(', ')}); fix the role, never the check`);
  return exists ? 'updated' : 'created';
}

/** Staging only: the membership plan the staging fixture activates (DEC-047 fixture flag). Never production. */
export async function ensureStagingPlan(client: pg.Pool | pg.PoolClient, appEnv: string): Promise<boolean> {
  if (appEnv !== 'staging') return false;
  const r = await client.query(
    `INSERT INTO app.membership_plans (id, name, billing_period, price_minor, currency, is_development_fixture)
     VALUES ('plan_staging', 'Membership (staging)', 'monthly', 100, 'TRY', true) ON CONFLICT (id) DO NOTHING`,
  );
  return (r.rowCount ?? 0) > 0;
}
