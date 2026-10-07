/**
 * API entry point. Validates configuration (fail-closed in staging and
 * production), checks the schema, then serves.
 *
 * Development/test apply pending migrations at start. Staging/production run
 * migrations as a separate release step (`npm run migrate`) BEFORE the new
 * version starts; here the API only refuses to start while the schema does
 * not match this build (docs/STAGING.md).
 */
import { serve } from '@hono/node-server';
import type pg from 'pg';
import { smsFor, storeFor } from './compose';
import { ConfigError, loadConfig, type Config } from './config';
import { migrate, migrationStatus } from './db/migrate';
import { createPool } from './db/pool';
import { checkRuntimeRole } from './db/role';
import { createApp } from './http/app';
import { systemClock } from './lib/clock';
import { createLogger, type Logger } from './lib/log';
import { createServices } from './services';

async function prepareSchema(pool: pg.Pool, config: Config, log: Logger) {
  if (config.migrateOnStart) {
    const result = await migrate(pool);
    if (result.applied.length) log.info('db.migrated', { applied: result.applied });
  }
  const s = await migrationStatus(pool);
  if (s.pending.length || s.changed.length || s.unknown.length) {
    log.error('db.schema_mismatch', { pending: s.pending, changed: s.changed, unknown: s.unknown });
    throw new Error('Schema does not match this build. Run the release migration step (npm run migrate).');
  }
}

async function main() {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : 'Invalid configuration');
    process.exit(1);
  }
  // The schema-owner credential is for the release step only: the API never uses it (DEC-074).
  delete process.env.MIGRATION_DATABASE_URL;
  const log = createLogger({ level: config.logLevel });
  const pool = createPool(config.databaseUrl, config.database);
  // A database that is briefly unreachable (a restart, a failover) must not crash-loop the API: wait up to a minute.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'unreachable';
      if (attempt >= 12) {
        console.error(`Database unavailable at start [${code}]`);
        await pool.end();
        process.exit(1);
      }
      log.warn('db.unavailable_at_start', { attempt, pgCode: code });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  try {
    if (config.appEnv === 'staging' || config.appEnv === 'production') {
      const role = await checkRuntimeRole(pool);
      if (role.problems.length) {
        log.error('db.role_refused', { problems: role.problems });
        throw new Error(`The API's database role ${role.problems.join('; ')}. Connect DATABASE_URL as the runtime role (infra/postgres/create-runtime-login.sql).`);
      }
    }
    await prepareSchema(pool, config, log);
  } catch (e) {
    const code = (e as { code?: string }).code;
    console.error(code ? `Database unavailable at start [${code}]` : (e as Error).message);
    await pool.end();
    process.exit(1);
  }
  if (config.devSeed) {
    // Development only (refused by loadConfig elsewhere): the development fixture plan, flagged as such (DEC-047).
    await pool.query(
      `INSERT INTO app.membership_plans (id, name, billing_period, price_minor, currency, is_development_fixture)
       VALUES ('plan_membership_monthly_dev', 'Membership', 'monthly', 250000, 'TRY', true) ON CONFLICT DO NOTHING`,
    );
  }
  const store = storeFor(config);
  // Staging/production: an instance that cannot reach storage never starts serving (the platform probes
  // liveness only, so readiness is proven here, like the database role and schema above).
  if (config.appEnv === 'staging' || config.appEnv === 'production') {
    let reachable = false;
    for (let attempt = 1; attempt <= 6 && !reachable; attempt++) {
      reachable = await store.ping().catch(() => false);
      if (!reachable && attempt < 6) {
        log.warn('storage.unavailable_at_start', { attempt });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!reachable) {
      console.error('Object storage unavailable at start');
      await pool.end();
      process.exit(1);
    }
  }
  const sms = smsFor(config, pool);
  const services = createServices({ pool, config, clock: systemClock, log, sms, store });
  const app = createApp(services);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
    log.info('api.listening', { appEnv: config.appEnv, address: info.address, port: info.port, sms: sms.name, storage: store.driver }),
  ) as import('node:http').Server;
  // Keep idle connections open longer than a platform proxy's idle timeout, so the proxy (not the API)
  // closes them: Node's 5-second default makes the API close sockets a proxy may be about to reuse.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const stop = () => {
    server.close();
    void pool.end();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
