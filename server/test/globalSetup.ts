/**
 * Integration tests run against a REAL PostgreSQL.
 *
 * With TEST_DATABASE_URL (a server where the user may create databases), that
 * server is used. Otherwise an ephemeral cluster is created with the local
 * PostgreSQL binaries (initdb + pg_ctl, fsync off) and removed afterwards.
 * Migrations run once into a template database; every test file clones it.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import pg from 'pg';
import { migrate } from '../src/db/migrate';

/** The login role every test server's API connects as (a member of velvet_runtime). */
export const RUNTIME_TEST_ROLE = 'velvet_api_test';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    templateDb: string;
  }
}

const PG_BIN = process.env.PG_BIN ?? ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/local/bin'].find((d) => existsSync(join(d, 'initdb')));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export default async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let stop: (() => void) | null = null;

  if (!adminUrl) {
    if (!PG_BIN) throw new Error('No PostgreSQL binaries found: install PostgreSQL 16+ or set TEST_DATABASE_URL.');
    const dir = mkdtempSync('/tmp/velvet-pg-');
    const port = await freePort();
    const asRoot = process.getuid?.() === 0;
    // initdb refuses to run as root: run the cluster as the postgres system user.
    const run = (bin: string, args: string[]) =>
      asRoot ? execFileSync('runuser', ['-u', 'postgres', '--', join(PG_BIN, bin), ...args], { stdio: 'pipe' }) : execFileSync(join(PG_BIN, bin), args, { stdio: 'pipe' });
    if (asRoot) {
      const uid = Number(execFileSync('id', ['-u', 'postgres']).toString().trim());
      const gid = Number(execFileSync('id', ['-g', 'postgres']).toString().trim());
      chownSync(dir, uid, gid);
    }
    chmodSync(dir, 0o700);
    run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8', '--locale=C.UTF-8']);
    run('pg_ctl', [
      '-D',
      join(dir, 'data'),
      '-o',
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300`,
      '-l',
      join(dir, 'log'),
      '-w',
      'start',
    ]);
    adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    stop = () => {
      try {
        run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  const templateDb = `velvet_tpl_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${templateDb}`);
  await admin.query(`CREATE DATABASE ${templateDb}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${templateDb}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  await migrate(pool);
  // The API runs as a least-privilege login role in the runtime group (DEC-074): so do the tests.
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_TEST_ROLE}') THEN
      CREATE ROLE ${RUNTIME_TEST_ROLE} LOGIN IN ROLE velvet_runtime;
    END IF; END $$`);
  await pool.end();

  project.provide('adminUrl', adminUrl);
  project.provide('templateDb', templateDb);

  return async () => {
    if (stop) stop();
    else {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${templateDb}`).catch(() => undefined);
      await c.end();
    }
  };
}
