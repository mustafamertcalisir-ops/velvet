/**
 * An ephemeral PostgreSQL for end-to-end runs (or TEST_DATABASE_URL when set).
 * Mirrors server/test/globalSetup.ts: initdb + pg_ctl with the local binaries,
 * run as the postgres system user when the runner is root.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const PG_BIN = process.env.PG_BIN ?? ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/local/bin'].find((d) => existsSync(join(d, 'initdb')));

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

/**
 * `{ realistic: true }` (the staging-shaped rehearsal): TCP connections must use
 * TLS (self-signed certificate) and a password (SCRAM); plain TCP is rejected.
 * The superuser is reachable only through the local socket (`adminUrl`), like
 * a provider's console. `stopServer` / `startServer` simulate an outage.
 */
export async function startPostgres(opts = {}) {
  if (opts.realistic) return startRealistic();
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop: () => undefined };
  if (!PG_BIN) throw new Error('PostgreSQL binaries not found (set PG_BIN or TEST_DATABASE_URL)');
  const dir = mkdtempSync('/tmp/velvet-e2e-pg-');
  const port = await freePort();
  const root = process.getuid?.() === 0;
  const run = (bin, args) =>
    root ? execFileSync('runuser', ['-u', 'postgres', '--', join(PG_BIN, bin), ...args], { stdio: 'pipe' }) : execFileSync(join(PG_BIN, bin), args, { stdio: 'pipe' });
  if (root) chownSync(dir, Number(execFileSync('id', ['-u', 'postgres']).toString()), Number(execFileSync('id', ['-g', 'postgres']).toString()));
  chmodSync(dir, 0o700);
  run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8', '--locale=C.UTF-8']);
  run('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-l', join(dir, 'log'), '-w', 'start']);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      try {
        run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function startRealistic() {
  if (!PG_BIN) throw new Error('PostgreSQL binaries not found (set PG_BIN)');
  const dir = mkdtempSync('/tmp/velvet-rehearsal-pg-');
  const port = await freePort();
  const root = process.getuid?.() === 0;
  const run = (bin, args) =>
    root ? execFileSync('runuser', ['-u', 'postgres', '--', join(PG_BIN, bin), ...args], { stdio: 'pipe' }) : execFileSync(join(PG_BIN, bin), args, { stdio: 'pipe' });
  const owner = root ? { uid: Number(execFileSync('id', ['-u', 'postgres']).toString()), gid: Number(execFileSync('id', ['-g', 'postgres']).toString()) } : null;
  if (owner) chownSync(dir, owner.uid, owner.gid);
  chmodSync(dir, 0o700);
  run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8', '--locale=C.UTF-8']);
  // A self-signed server certificate (like a provider's private endpoint).
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.crt')], { stdio: 'pipe' });
  chmodSync(join(dir, 'server.key'), 0o600);
  if (owner) for (const f of ['server.key', 'server.crt']) chownSync(join(dir, f), owner.uid, owner.gid);
  writeFileSync(
    join(dir, 'pg_hba.conf'),
    ['local all postgres trust', 'hostssl all all 127.0.0.1/32 scram-sha-256', 'host all all 127.0.0.1/32 reject', ''].join('\n'),
  );
  if (owner) chownSync(join(dir, 'pg_hba.conf'), owner.uid, owner.gid);
  const options = `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c ssl=on -c ssl_cert_file=${join(dir, 'server.crt')} -c ssl_key_file=${join(dir, 'server.key')} -c hba_file=${join(dir, 'pg_hba.conf')} -c password_encryption=scram-sha-256 -c log_statement=all`;
  const startServer = () => run('pg_ctl', ['-D', join(dir, 'data'), '-o', options, '-l', join(dir, 'log'), '-w', 'start']);
  const stopServer = () => run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'fast', '-w', 'stop']);
  startServer();
  return {
    host: '127.0.0.1',
    port,
    /** The superuser, through the local socket only. */
    adminUrl: `postgres://postgres@/postgres?host=${encodeURIComponent(dir)}&port=${port}`,
    adminConfig: (database = 'postgres') => ({ host: dir, port, user: 'postgres', database }),
    startServer,
    stopServer,
    /** The server log (every statement is logged: the rehearsal proves no plaintext password ever reaches it). */
    logFile: join(dir, 'log'),
    stop() {
      try {
        run('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']);
      } catch {
        /* already stopped */
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
