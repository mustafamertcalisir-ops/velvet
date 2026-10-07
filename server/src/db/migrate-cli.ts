/**
 * The release migration step (docs/STAGING.md):
 *
 *   npm run migrate              apply pending migrations, then verify
 *   npm run migrate -- --verify  only check: exit 1 if anything is pending, changed or unknown
 *
 * Connects with MIGRATION_DATABASE_URL (the schema owner) when set, otherwise
 * DATABASE_URL (development, where one role does both). The API itself uses
 * the least-privilege runtime role (DEC-074). Transport security follows
 * DATABASE_TLS / DATABASE_CA_CERT exactly as for the API.
 *
 * Staging/production deploys run this as a separate one-off step BEFORE the
 * new API version starts (MIGRATE_ON_START is off there); the API refuses to
 * start, and readiness reports not-ready, while the schema and code disagree.
 */
import { migrate, migrationStatus } from './migrate';
import { createPool, databaseOptionsFrom } from './pool';
import { ensureRuntimeLogin, ensureStagingPlan, runtimeLoginFrom } from './runtimeLogin';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL (or DATABASE_URL) is required');
  process.exit(1);
}
const appEnv = process.env.APP_ENV ?? 'development';
const { options, problems: configProblems } = databaseOptionsFrom(process.env, appEnv === 'staging' || appEnv === 'production');
if (configProblems.length) {
  console.error(`Invalid database configuration:\n- ${configProblems.join('\n- ')}`);
  process.exit(1);
}
const verifyOnly = process.argv.includes('--verify');
const runtime = runtimeLoginFrom(process.env);
if (runtime.problems.length) {
  console.error(`Invalid runtime login configuration:\n- ${runtime.problems.join('\n- ')}`);
  process.exit(1);
}
const pool = createPool(url, { ...options, max: 1, applicationName: 'velvet-migrate' });

async function run() {
  if (!verifyOnly) {
    const r = await migrate(pool);
    console.log(`Migrations: ${r.applied.length} applied (${r.applied.join(', ') || '—'}), ${r.skipped.length} already applied.`);
    // Release-step bootstrap (DEC-081): the API's runtime login from the platform-generated password, and
    // in staging only the fixture plan. Both idempotent; neither prints a secret.
    if (runtime.login) {
      const how = await ensureRuntimeLogin(pool, runtime.login);
      console.log(`Runtime login ${runtime.login.user}: ${how} (password set as a SCRAM verifier; group ${'velvet_runtime'} only).`);
    }
    if (await ensureStagingPlan(pool, appEnv)) console.log('Staging membership plan created (fixture-flagged).');
  }
  const s = await migrationStatus(pool);
  const problems = [
    ...s.pending.map((f) => `pending: ${f}`),
    ...s.changed.map((f) => `changed after apply: ${f}`),
    ...s.unknown.map((f) => `applied but unknown to this build: ${f}`),
  ];
  if (problems.length) {
    console.error(`Schema does not match this build:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('Schema verified: every migration of this build is applied, unchanged.');
  }
}

run()
  .catch((e: Error) => {
    // Driver messages can carry host names; keep the class and code only.
    const code = (e as { code?: string }).code;
    console.error(`Migration failed: ${code ? `[${code}] ` : ''}${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
