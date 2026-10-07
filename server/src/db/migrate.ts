/**
 * Migration runner — plain, ordered SQL files in server/migrations.
 *
 * - Each file runs once, in its own transaction, in filename order.
 * - A checksum is recorded; editing an applied migration is refused (write a
 *   new one instead).
 * - A session advisory lock keeps two runners from migrating at once.
 *
 * Usage: DATABASE_URL=… npm run migrate   (src/db/migrate-cli.ts)
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
/** server/migrations — from src/db (development) or dist/ (bundled); MIGRATIONS_DIR overrides. */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? [join(here, '../../migrations'), join(here, '../migrations')].find((d) => existsSync(join(d, '0001_foundation.sql'))) ?? join(here, '../../migrations');
const LOCK = 74_120_517;

export type MigrationResult = { applied: string[]; skipped: string[] };
export type MigrationStatus = { pending: string[]; changed: string[]; unknown: string[] };

const migrationFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
const checksumOf = (dir: string, file: string) => createHash('sha256').update(readFileSync(join(dir, file), 'utf8')).digest('hex');

/**
 * Read-only: does the database schema match this build's migrations?
 * pending  — files not yet applied (the release step has not run);
 * changed  — applied files whose content differs (refused by `migrate`);
 * unknown  — applied versions this build does not know (the database is AHEAD
 *            of the code: e.g. an older build deployed after a newer migration).
 */
export async function migrationStatus(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const files = migrationFiles(dir);
  const exists = await pool.query(`SELECT to_regclass('app_meta.schema_migrations') AS t`);
  const applied = new Map<string, string>();
  if (exists.rows[0]?.t) {
    for (const r of (await pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM app_meta.schema_migrations')).rows) {
      applied.set(r.version, r.checksum);
    }
  }
  return {
    pending: files.filter((f) => !applied.has(f)),
    changed: files.filter((f) => applied.has(f) && applied.get(f) !== checksumOf(dir, f)),
    unknown: [...applied.keys()].filter((v) => !files.includes(v)).sort(),
  };
}

export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = migrationFiles(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await client.query('CREATE SCHEMA IF NOT EXISTS app_meta');
    await client.query('REVOKE ALL ON SCHEMA app_meta FROM PUBLIC');
    await client.query(
      `CREATE TABLE IF NOT EXISTS app_meta.schema_migrations (
         version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Map(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM app_meta.schema_migrations')).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    const result: MigrationResult = { applied: [], skipped: [] };
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO app_meta.schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
    client.release();
  }
}
