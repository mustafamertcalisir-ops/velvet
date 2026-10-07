/**
 * LOCAL STAGING-SHAPED REHEARSAL — not a deployment.
 *
 * Runs the built API exactly as staging would (APP_ENV=staging, fail-closed
 * configuration, S3-compatible private storage, signed internal keys, no
 * migrations at start, TLS to the database, least-privilege runtime role) on
 * this machine, then runs every deployed-staging tool against it:
 *
 *   PostgreSQL     ephemeral local cluster: TLS required (self-signed), SCRAM
 *                  passwords, plain TCP rejected; a non-superuser schema owner
 *                  (CREATEROLE) like a managed provider's default user
 *   object store   s3rver (an S3 emulator — it does NOT validate signatures;
 *                  the real-provider storage test does, BLOCKED until a bucket exists)
 *   SMS            SMS_PROVIDER=none (closed) + SMS_TEST_NUMBERS for QA accounts
 *
 *   npm run build && node scripts/rehearse-staging.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import S3rver from 's3rver';
import { startPostgres } from '../../e2e/pg.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..');
const dist = (f) => join(root, 'dist', f);
for (const f of ['main.mjs', 'migrate.mjs', 'smoke.mjs', 'staging-suite.mjs', 'qa-seed.mjs', 'log-scan.mjs', 'ops.mjs', 'db-check.mjs', 'velvet-review.mjs']) {
  if (!existsSync(dist(f))) throw new Error(`dist/${f} missing — run npm run build`);
}
const PG_BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/local/bin'].find((d) => existsSync(join(d, 'psql')));

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });

const secret = () => randomBytes(32).toString('base64url');
const work = mkdtempSync('/tmp/velvet-rehearsal-');
const runner = { id: 'runner', secret: secret() };
const ops = { id: 'ops', secret: secret() };
const reviewerKey = { id: 'reviewer', secret: secret() };
const ownerPassword = secret();
const apiPassword = secret();

const pgSrv = await startPostgres({ realistic: true });
const s3dir = mkdtempSync('/tmp/velvet-staging-s3-');
const s3port = await freePort();
const buckets = [{ name: 'velvet-staging-media' }, { name: 'velvet-staging-verification' }];
let s3 = new S3rver({ port: s3port, address: '127.0.0.1', directory: s3dir, silent: true, configureBuckets: buckets });
await s3.run();
const apiPort = await freePort();
const base = `http://127.0.0.1:${apiPort}`;

// The provider's default user: owns the database, can create roles, is NOT a superuser.
const admin = new pg.Client(pgSrv.adminConfig());
await admin.connect();
await admin.query(`CREATE ROLE velvet_owner LOGIN CREATEROLE PASSWORD '${ownerPassword}'`);
await admin.query('CREATE DATABASE velvet OWNER velvet_owner');
await admin.end();
const ownerUrl = `postgres://velvet_owner:${ownerPassword}@127.0.0.1:${pgSrv.port}/velvet`;

const stagingEnv = {
  PATH: process.env.PATH,
  APP_ENV: 'staging',
  HOST: '127.0.0.1',
  PORT: String(apiPort),
  // As on Render (DEC-081): the platform generates the runtime password; the release step creates the login
  // from it and the API derives its connection from the owner's host — no person handles a database password.
  DATABASE_RUNTIME_USER: 'velvet_api',
  DATABASE_RUNTIME_PASSWORD: apiPassword,
  MIGRATION_DATABASE_URL: ownerUrl,
  DATABASE_TLS: 'require',
  OTP_SECRET: secret(),
  MEDIA_SIGNING_SECRET: secret(),
  // The Blueprint's shape: the key list is plain configuration, the secrets are platform-generated variables.
  INTERNAL_KEYS_JSON: JSON.stringify({
    [runner.id]: { secretEnv: 'INTERNAL_KEY_RUNNER_SECRET', scopes: ['test:otp', 'test:review'] },
    [ops.id]: { secretEnv: 'INTERNAL_KEY_OPS_SECRET', scopes: ['retention:run', 'media:reconcile'] },
    [reviewerKey.id]: { secretEnv: 'INTERNAL_KEY_REVIEWER_SECRET', scopes: ['review:read', 'review:write', 'review:media', 'membership:complimentary'] },
  }),
  INTERNAL_KEY_RUNNER_SECRET: runner.secret,
  INTERNAL_KEY_OPS_SECRET: ops.secret,
  INTERNAL_KEY_REVIEWER_SECRET: reviewerKey.secret,
  PUBLIC_BASE_URL: 'https://api-staging.invalid',
  CORS_ORIGINS: 'https://app-staging.invalid',
  TRUST_PROXY_HOPS: '1',
  SMS_PROVIDER: 'none',
  SMS_TEST_NUMBERS: '+90555000*',
  STORAGE_DRIVER: 's3',
  S3_REGION: 'us-east-1',
  S3_ENDPOINT: `http://127.0.0.1:${s3port}`,
  S3_BUCKET: 'velvet-staging-media',
  S3_VERIFICATION_BUCKET: 'velvet-staging-verification',
  S3_ACCESS_KEY_ID: 'S3RVER',
  S3_SECRET_ACCESS_KEY: 'S3RVER',
  S3_FORCE_PATH_STYLE: '1',
  LOG_LEVEL: 'info',
  MIGRATIONS_DIR: join(root, 'migrations'),
};
const toolEnv = (ip) => ({
  PATH: process.env.PATH,
  STAGING_ENVIRONMENT: 'staging',
  STAGING_API_URL: base,
  STAGING_KEY_ID: runner.id,
  STAGING_KEY_SECRET: runner.secret,
  STAGING_PHONE_PREFIX: '+90555000',
  STAGING_SIMULATED_CLIENT_IP: ip,
  STAGING_STATE_FILE: join(work, 'state.json'),
  STAGING_CANARY_FILE: join(work, `canaries-${ip}.json`),
  STAGING_DB_CHECKS_FILE: join(work, `db-checks-${ip}.json`),
});
const noRuntime = { DATABASE_RUNTIME_USER: '', DATABASE_RUNTIME_PASSWORD: '' };
/** Run a tool's database assertions the way CI does on Render: db-check as a one-off job with the API's environment. */
const runDbChecks = (ip) => {
  const file = join(work, `db-checks-${ip}.json`);
  const checks = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const out = checks.map((c) => ({ label: c.label, r: runSync('db-check.mjs', c.args, stagingEnv) }));
  for (const o of out) console.log(`    ${o.r.status === 0 ? '✓' : '✗'} db: ${o.label}${o.r.status === 0 ? '' : ` — ${o.r.stdout}${o.r.stderr}`}`);
  return { n: out.length, ok: out.every((o) => o.r.status === 0) };
};

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} [rehearsal] ${name}${ok || !detail ? '' : ` — ${String(detail).slice(-600)}`}`);
  return ok;
};
/** A child process that must keep this process's event loop free (s3rver lives here). */
const runTool = (file, args, env, timeoutMs = 600_000) =>
  new Promise((done) => {
    const out = [];
    const child = spawn(process.execPath, [dist(file), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      out.push(String(d));
      process.stdout.write(String(d).replace(/^/gm, '    '));
    });
    child.stderr.on('data', (d) => {
      out.push(String(d));
      process.stdout.write(String(d).replace(/^/gm, '    '));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ code, out: out.join('') });
    });
  });
const signed = async (path, body, key = ops) => {
  const raw = JSON.stringify(body ?? {});
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const sig = createHmac('sha256', key.secret).update(['staging', 'POST', path, ts, nonce, createHash('sha256').update(raw).digest('hex')].join('\n')).digest('base64url');
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key-id': key.id, 'x-internal-timestamp': ts, 'x-internal-nonce': nonce, 'x-internal-signature': sig },
    body: raw,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let api = null;
const apiLog = [];
async function startApi() {
  api = spawn(process.execPath, [dist('main.mjs')], { env: stagingEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (d) => apiLog.push(String(d)));
  api.stderr.on('data', (d) => apiLog.push(String(d)));
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/health/ready`)).ok) return true;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function stopApi() {
  if (!api) return;
  const exited = new Promise((r) => api.once('exit', r));
  api.kill('SIGTERM');
  await exited;
  api = null;
}
const runSync = (file, args, env) => spawnSync(process.execPath, [dist(file), ...args], { env, encoding: 'utf8', timeout: 30_000 });

try {
  // --- Configuration and release step ---------------------------------------------------------------
  const early = runSync('main.mjs', [], { ...stagingEnv, ...noRuntime, DATABASE_URL: ownerUrl, MIGRATION_DATABASE_URL: '' });
  step('API refuses to start before the release migration step', early.status === 1 && /Schema does not match/.test(early.stderr + early.stdout), early.stderr);
  const devish = runSync('main.mjs', [], { ...stagingEnv, SMS_PROVIDER: 'console', STORAGE_DRIVER: 'local', DATABASE_TLS: 'off' });
  step(
    'staging refuses development senders, local storage and an unencrypted database connection',
    devish.status === 1 && /development sender/.test(devish.stderr) && /development store/.test(devish.stderr) && /DATABASE_TLS=off is refused/.test(devish.stderr),
    devish.stderr,
  );
  const plain = runSync('migrate.mjs', ['--verify'], { ...stagingEnv, DATABASE_TLS: 'off', APP_ENV: 'development' });
  step('the database refuses a connection without TLS', plain.status === 1 && /no encryption|SSL|pg_hba/i.test(plain.stderr), plain.stderr);

  const mig = runSync('migrate.mjs', [], stagingEnv);
  step('release migration step (as the non-superuser owner, over TLS) applies 0001→latest', mig.status === 0 && /Schema verified/.test(mig.stdout), mig.stdout + mig.stderr);
  step(
    'release step creates the runtime login from the platform-generated password, and the staging plan',
    /Runtime login velvet_api: created/.test(mig.stdout) && /Staging membership plan created/.test(mig.stdout) && !mig.stdout.includes(apiPassword) && !mig.stderr.includes(apiPassword),
    mig.stdout + mig.stderr,
  );
  const migFiles = spawnSync('ls', [join(root, 'migrations')], { encoding: 'utf8' }).stdout.trim().split('\n').filter((f) => f.endsWith('.sql'));
  step(`every migration file applied (${migFiles.length}: ${migFiles[0]} … ${migFiles.at(-1)})`, mig.stdout.includes(`${migFiles.length} applied`), mig.stdout);
  const ver = runSync('migrate.mjs', ['--verify'], stagingEnv);
  step('schema verification passes (checksums, nothing pending or unknown)', ver.status === 0 && /Schema verified/.test(ver.stdout));
  const again = runSync('migrate.mjs', [], stagingEnv);
  step(
    'existing-schema release step (the next deploy): nothing applied, login re-asserted, schema verified',
    again.status === 0 && new RegExp(`0 applied .*${migFiles.length} already applied`).test(again.stdout) && /Runtime login velvet_api: updated/.test(again.stdout) && /Schema verified/.test(again.stdout),
    again.stdout + again.stderr,
  );
  const pgLog = existsSync(pgSrv.logFile) ? readFileSync(pgSrv.logFile, 'utf8') : '';
  step(
    'the database server never received the runtime password in plaintext (statement log on: only the SCRAM verifier)',
    pgLog.includes('ALTER ROLE "velvet_api"') && /PASSWORD 'SCRAM-SHA-256\$4096:/.test(pgLog) && !pgLog.includes(apiPassword),
    pgLog.slice(-400),
  );

  // Schema facts the release must carry.
  let owner = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
  owner.on('error', () => undefined);
  await owner.connect();
  const facts = (
    await owner.query(`SELECT
      (SELECT count(*)::int FROM app_meta.schema_migrations) AS migrations,
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'app' AND indexname = 'matches_one_active_per_pair') AS active_match_index,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'app' AND tablename IN ('audit_events','media_access_log','retention_holds','sessions','media_uploads','internal_nonces')) AS key_tables,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind = 'r' AND NOT c.relrowsecurity) AS tables_without_rls,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('audit_events_no_update','media_access_log_append_only','messages_keep','reports_keep','blocks_keep')) AS protective_triggers,
      (SELECT count(*)::int FROM pg_constraint WHERE conname = 'sessions_revocation_consistent') AS session_constraint`)
  ).rows[0];
  step(
    'schema: version ledger, active-match index, audit/retention/session/media tables, RLS everywhere, protective triggers, session constraint',
    facts.migrations === migFiles.length && facts.active_match_index === 1 && facts.key_tables === 6 && facts.tables_without_rls === 0 && facts.protective_triggers === 5 && facts.session_constraint === 1,
    JSON.stringify(facts),
  );

  // The manual alternative still works (infra/postgres/create-runtime-login.sql with psql, for hosts without generated values).
  if (PG_BIN) {
    const psql = spawnSync(join(PG_BIN, 'psql'), [`${ownerUrl}?sslmode=require`, '-v', 'login=velvet_api_manual', '-f', join(repo, 'infra/postgres/create-runtime-login.sql')], {
      encoding: 'utf8',
    });
    step('manual alternative: the documented psql script creates a password-less runtime login', psql.status === 0 && /Created the runtime login/.test(psql.stdout), psql.stdout + psql.stderr);
    await owner.query('DROP ROLE velvet_api_manual');
  }

  const sameCredential = runSync('main.mjs', [], { ...stagingEnv, ...noRuntime, DATABASE_URL: ownerUrl });
  step('API refuses the migration credential as its own (configuration)', sameCredential.status === 1 && /must be the runtime role/.test(sameCredential.stderr), sameCredential.stderr);
  const ownerName = runSync('main.mjs', [], { ...stagingEnv, DATABASE_RUNTIME_USER: 'velvet_owner' });
  step('API refuses a runtime login named like the schema owner (configuration)', ownerName.status === 1 && /must differ from the schema owner/.test(ownerName.stderr), ownerName.stderr);
  const asOwner = runSync('main.mjs', [], { ...stagingEnv, ...noRuntime, DATABASE_URL: ownerUrl, MIGRATION_DATABASE_URL: '' });
  step('API refuses to run as the schema owner (database role check)', asOwner.status === 1 && /owns the app schema/.test(asOwner.stderr + asOwner.stdout), asOwner.stderr + asOwner.stdout);

  // --- The API -------------------------------------------------------------------------------------------------
  step('API ready as the runtime role over TLS (database, migrations, storage)', await startApi(), apiLog.join(''));
  const superuser = new pg.Client(pgSrv.adminConfig('velvet'));
  await superuser.connect();
  const role = (await superuser.query(`SELECT usename, ssl FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE application_name = 'velvet-api'`)).rows;
  await superuser.end();
  step('every API connection uses the runtime login and TLS', role.length > 0 && role.every((r) => r.usename === 'velvet_api' && r.ssl === true), JSON.stringify(role));
  step('local-storage routes are not served with S3', (await fetch(`${base}/v1/storage/object?b=media&k=x`)).status === 404);
  const schemaCheck = runSync('db-check.mjs', ['schema'], stagingEnv);
  step(
    'db-check schema (as a platform one-off job would run it: runtime login, TLS, read-only) — tables, RLS + runtime policy + grants, partial unique active-match index, constraints, triggers',
    schemaCheck.status === 0 && /"ok":true/.test(schemaCheck.stdout),
    schemaCheck.stdout + schemaCheck.stderr,
  );

  // --- Tools against the running API ---------------------------------------------------------------------------
  const smoke = await runTool('smoke.mjs', [], toolEnv('198.51.100.10'));
  step('smoke flow', smoke.code === 0, smoke.out.slice(-400));
  const before = await runTool('staging-suite.mjs', ['before-restart'], toolEnv('198.51.100.11'));
  step('staging suites (before restart)', before.code === 0, `${before.out.slice(-500)}\n--- API log tail ---\n${apiLog.join('').slice(-1500)}`);
  const dbBefore = runDbChecks('198.51.100.11');
  step(`database assertions after the suite hold (${dbBefore.n}, db-check inside the "platform")`, dbBefore.ok && dbBefore.n > 0);
  await stopApi();
  step('API restarted', await startApi());
  const after = await runTool('staging-suite.mjs', ['after-restart'], toolEnv('198.51.100.11'));
  step('staging suites (after restart: sessions, messages, rate limits persisted)', after.code === 0, after.out.slice(-600));
  const dbAfter = runDbChecks('198.51.100.11');
  step(`database assertions after the restart hold (${dbAfter.n})`, dbAfter.ok && dbAfter.n > 0);
  const race = await runTool('staging-suite.mjs', ['race'], { ...toolEnv('198.51.100.15'), STAGING_RACE_ROUNDS: '6' });
  step('LIKE/BLOCK: both orders forced, then 6 simultaneous rounds — the block always wins, nothing disclosed', race.code === 0, race.out.slice(-600));
  const dbRace = runDbChecks('198.51.100.15');
  step(`database assertions after the race phase hold (${dbRace.n})`, dbRace.ok && dbRace.n >= 8);
  const deletion = await runTool('staging-suite.mjs', ['deletion'], toolEnv('198.51.100.16'));
  step('account deletion against a live match and conversation', deletion.code === 0, deletion.out.slice(-600));
  const dbDeletion = runDbChecks('198.51.100.16');
  step(`database assertions after the deletion phase hold (${dbDeletion.n})`, dbDeletion.ok && dbDeletion.n === 1);
  const seed1 = await runTool('qa-seed.mjs', ['seed'], toolEnv('198.51.100.12'));
  step('QA seed creates the QA set', seed1.code === 0, seed1.out.slice(-600));
  const seed2 = await runTool('qa-seed.mjs', ['seed'], toolEnv('198.51.100.13'));
  step('QA seed is repeatable (second run resumes, same states)', seed2.code === 0, seed2.out.slice(-600));
  const qa = (await owner.query(`SELECT count(*) FILTER (WHERE qa_account)::int AS qa, count(*) FILTER (WHERE NOT qa_account)::int AS other FROM app.accounts`)).rows[0];
  step('every account created by the tools is a QA account', qa.qa > 0 && qa.other === 0, JSON.stringify(qa));
  const refused = await runTool('qa-seed.mjs', ['seed'], { ...toolEnv('198.51.100.14'), STAGING_ENVIRONMENT: 'production' });
  step('QA seed refuses anything but STAGING_ENVIRONMENT=staging', refused.code === 1 && /Refusing to run/.test(refused.out), refused.out);

  // --- The owner's review tool (DEC-087/088): the bundled file, as a separate process, over HTTP -----------------
  // Its own settings file and HOME (as on the owner's computer); the reviewer key, never the runner's.
  const reviewEnv = {
    PATH: process.env.PATH,
    HOME: work,
    VELVET_REVIEW_CONFIG: join(work, 'velvet-review.json'),
    VELVET_REVIEW_API_URL: base,
    VELVET_REVIEW_KEY_SECRET: reviewerKey.secret,
    VELVET_REVIEW_ID: 'owner',
  };
  const tool = (args, env = reviewEnv) => runTool('velvet-review.mjs', args, env, 60_000);
  const open = await tool(['liste']);
  step('review tool: without --qa the QA set stays out of the owner’s queue', open.code === 0 && /Şu an bekleyen başvuru yok/.test(open.out), open.out);
  const listed = await tool(['liste', '--qa']);
  const numberOf = (name) => new RegExp(`^\\s+(\\d+)\\s+${name},`, 'm').exec(listed.out)?.[1];
  step(
    'review tool: the queue groups open applications (first name, age, city — no surname, no phone)',
    listed.code === 0 && ['Aylin', 'Burak', 'Doğan', 'Gökçe'].every((n) => numberOf(n)) && !numberOf('Işıl') && !/\+90/.test(listed.out),
    listed.out,
  );
  const dogan = numberOf('Doğan');
  const shown = await tool(['goster', dogan]);
  step('review tool: the application view (surname, birth date, Instagram, answers; never a phone number)', shown.code === 0 && /Doğan .+ · 41 \(doğum: /.test(shown.out) && /Instagram: @/.test(shown.out) && /Son değerlendirme/.test(shown.out) && !/\+90/.test(shown.out), shown.out);
  const photos = await tool(['foto', dogan, '--baglanti']);
  const links = [...photos.out.matchAll(/^\s+(http\S+)$/gm)].map((m) => m[1]);
  const fetched = await Promise.all(links.map((u) => fetch(u).then(async (r) => ({ ok: r.ok, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength }))));
  step(
    `review tool: photos as short-lived signed links (${links.length}, printed with --baglanti) — each serves the image`,
    photos.code === 0 && links.length >= 3 && fetched.every((f) => f.ok && /^image\//.test(f.type ?? '') && f.bytes > 1000),
    photos.out + JSON.stringify(fetched),
  );
  const unconfirmed = await tool(['karar', dogan, 'APPROVE']);
  const decided = await tool(['karar', dogan, 'APPROVE', '--neden', 'COMMUNITY_FIT', '--evet']);
  step('review tool: a decision needs --evet; then FINAL_REVIEW → APPROVED through the reviewer path', unconfirmed.code === 2 && decided.code === 0 && /Son değerlendirme → Onaylandı/.test(decided.out), unconfirmed.out + decided.out);
  const invited = await tool(['uyelik', dogan, '--evet']);
  step('review tool: invited membership → ACTIVE_MEMBER', invited.code === 0 && /davetli üyelik başladı \(Üye\)/.test(invited.out), invited.out);
  const doganRow = (
    await owner.query(
      `SELECT m.activation, m.granted_by, m.renews_at, a.status,
              (SELECT count(*)::int FROM app.billing_events b WHERE b.account_id = a.account_id) AS billing,
              (SELECT count(*)::int FROM app.application_access_log l WHERE l.application_id = a.id AND l.principal = 'reviewer:owner') AS opened,
              (SELECT count(*)::int FROM app.media_access_log l JOIN app.application_media x ON x.id = l.media_id WHERE x.application_id = a.id AND l.principal = 'reviewer:owner') AS photosOpened,
              (SELECT count(*)::int FROM app.member_profiles p WHERE p.account_id = a.account_id) AS profiles
         FROM app.membership_applications a JOIN app.memberships m ON m.account_id = a.account_id
         JOIN app.application_private_data d ON d.application_id = a.id WHERE d.first_name = 'Doğan'`,
    )
  ).rows[0];
  step(
    'database: complimentary membership by "owner", no billing event, no renewal, member profile provisioned; every open logged',
    doganRow?.status === 'ACTIVE_MEMBER' && doganRow.activation === 'complimentary' && doganRow.granted_by === 'owner' && doganRow.renews_at === null && doganRow.billing === 0 && doganRow.profiles === 1 && doganRow.opened >= 4 && doganRow.photosopened >= 3,
    JSON.stringify(doganRow),
  );
  const wrongKey = await tool(['liste'], { ...reviewEnv, VELVET_REVIEW_KEY_SECRET: secret() });
  const runnerKey = await tool(['liste'], { ...reviewEnv, VELVET_REVIEW_KEY_ID: runner.id, VELVET_REVIEW_KEY_SECRET: runner.secret });
  step('review tool: a wrong key, or the CI runner’s key (no review scopes), is refused in plain words', wrongKey.code === 1 && runnerKey.code === 1 && /Anahtar kabul edilmedi/.test(wrongKey.out + runnerKey.out), wrongKey.out + runnerKey.out);
  const notStaging = await tool(['liste'], { ...reviewEnv, VELVET_REVIEW_API_URL: 'https://velvet-api.onrender.com' });
  step('review tool: refuses an API that is not staging, before any request', notStaging.code === 1 && /yalnızca staging API/.test(notStaging.out), notStaging.out);

  // --- Operations jobs ---------------------------------------------------------------------------------------
  // As a one-off job on the API service: the API's own environment (INTERNAL_KEY_OPS_SECRET, APP_ENV) — only the URL differs here.
  const opsEnv = { ...stagingEnv, OPS_API_URL: base };
  const dryRun = await runTool('ops.mjs', ['retention', '--dry-run'], opsEnv);
  const dry = { status: JSON.parse(dryRun.out).status, body: JSON.parse(dryRun.out).report };
  step('scheduled-operations tool (dist/ops.mjs) runs the retention dry run with the ops key', dryRun.code === 0, dryRun.out);
  step(
    'retention dry run: structured, windows unset (no purge configured), nothing changed',
    dry.status === 200 && dry.body.dryRun === true && Object.entries(dry.body.windows).every(([k, v]) => k === 'deletionGraceHours' || v === null),
    JSON.stringify(dry.body),
  );
  const requested = (await owner.query(`SELECT count(*)::int AS n FROM app.accounts WHERE account_status = 'deletion_requested'`)).rows[0].n;
  step(`retention dry run counts the ${requested} QA accounts awaiting deletion without touching them`, dry.body.accountsAnonymized === requested && requested > 0, `${dry.body.accountsAnonymized} vs ${requested}`);
  const run1 = await signed('/internal/retention/run', {});
  const run2 = await signed('/internal/retention/run', {});
  const anonymized = (await owner.query(`SELECT count(*)::int AS n FROM app.accounts WHERE account_status = 'anonymized'`)).rows[0].n;
  step('retention run anonymizes them (objects deleted); a repeat run is a no-op', run1.body.accountsAnonymized === requested && run2.body.accountsAnonymized === 0 && anonymized === requested, JSON.stringify([run1.body, run2.body]));
  const recRun = await runTool('ops.mjs', ['reconcile'], opsEnv);
  const rec = { status: JSON.parse(recRun.out).status, body: JSON.parse(recRun.out).report };
  step('media reconciliation dry run over both buckets', rec.status === 200 && rec.body.mode === 'dry-run' && rec.body.complete === true && rec.body.actions.DELETED === 0, JSON.stringify(rec.body?.counts));
  step('reconciliation finds no missing or failed-deletion objects after the runs', rec.body.counts.MISSING_OBJECT === 0 && rec.body.counts.FAILED_DELETION === 0, JSON.stringify(rec.body?.counts));

  // --- Faults: database, storage ------------------------------------------------------------------------------
  const seedToken = await (async () => {
    const phone = `+905550009${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    const r = await fetch(`${base}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20' }, body: JSON.stringify({ phoneE164: phone }) });
    const challenge = await r.json();
    const code = await signed('/internal/test/otp', { phoneE164: phone }, runner);
    const v = await fetch(`${base}/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code: code.body.code }) });
    return (await v.json()).session.token;
  })();
  await owner.end();
  pgSrv.stopServer();
  const readyDbDown = await fetch(`${base}/health/ready`);
  const readyBody = await readyDbDown.json();
  const reqDbDown = await fetch(`${base}/v1/member/me`, { headers: { authorization: `Bearer ${seedToken}` } });
  const reqBody = await reqDbDown.text();
  step('database down: ready answers 503 without infrastructure detail', readyDbDown.status === 503 && readyBody.checks.database !== 'ok' && !/127\.0\.0\.1|ECONN|postgres/i.test(JSON.stringify(readyBody)), JSON.stringify(readyBody));
  step('database down: requests answer a typed, safe error', reqDbDown.status >= 500 && /"code":"[A-Z_]+"/.test(reqBody) && !/ECONN|postgres|stack|at /.test(reqBody), reqBody);
  step('liveness stays up while the database is down (no restart loop)', (await fetch(`${base}/health/live`)).status === 200);
  pgSrv.startServer();
  let back = false;
  for (let i = 0; i < 40 && !back; i++) {
    back = (await fetch(`${base}/health/ready`)).ok;
    if (!back) await new Promise((r) => setTimeout(r, 250));
  }
  step('database back: ready again without restarting the API', back);
  owner = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
  owner.on('error', () => undefined);
  await owner.connect();
  await s3.close();
  const readyS3Down = await fetch(`${base}/health/ready`);
  const s3Body = await readyS3Down.json();
  step('storage down: ready answers 503 (storage counts for readiness)', readyS3Down.status === 503 && s3Body.checks.storage !== 'ok', JSON.stringify(s3Body));
  s3 = new S3rver({ port: s3port, address: '127.0.0.1', directory: s3dir, silent: true, configureBuckets: buckets });
  await s3.run();
  step('storage back: ready again', (await fetch(`${base}/health/ready`)).ok);

  // --- Backup and restore (logical), into an ISOLATED database ---------------------------------------------------
  if (PG_BIN) {
    const dump = join(work, 'velvet.dump');
    const d = spawnSync(join(PG_BIN, 'pg_dump'), [`${ownerUrl}?sslmode=require`, '-n', 'app', '-n', 'app_meta', '--format=custom', '--no-owner', '-f', dump], { encoding: 'utf8' });
    const a2 = new pg.Client(pgSrv.adminConfig());
    await a2.connect();
    await a2.query('CREATE DATABASE velvet_restore_test OWNER velvet_owner');
    await a2.end();
    const restoreUrl = `postgres://velvet_owner:${ownerPassword}@127.0.0.1:${pgSrv.port}/velvet_restore_test`;
    const rr = spawnSync(join(PG_BIN, 'pg_restore'), ['--dbname', `${restoreUrl}?sslmode=require`, '--no-owner', '--exit-on-error', dump], { encoding: 'utf8' });
    const verifyRestore = runSync('migrate.mjs', ['--verify'], { ...stagingEnv, MIGRATION_DATABASE_URL: restoreUrl });
    const count = async (url) => {
      const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
      await c.connect();
      const r = (await c.query(`SELECT (SELECT count(*) FROM app.accounts)::int a, (SELECT count(*) FROM app.messages)::int m, (SELECT count(*) FROM app.audit_events)::int e`)).rows[0];
      await c.end();
      return JSON.stringify(r);
    };
    const [live, restored] = [await count(ownerUrl), await count(restoreUrl)];
    step(
      'logical backup (pg_dump -n app -n app_meta) restores into an isolated database; schema verifies; row counts match',
      d.status === 0 && rr.status === 0 && verifyRestore.status === 0 && live === restored,
      `${d.stderr}${rr.stderr}${verifyRestore.stderr} ${live} vs ${restored}`,
    );
  }

  // --- Log review --------------------------------------------------------------------------------------------
  await stopApi();
  const logFile = join(work, 'api.log');
  writeFileSync(logFile, apiLog.join(''));
  const canaryFiles = ['198.51.100.10', '198.51.100.11', '198.51.100.12', '198.51.100.13', '198.51.100.15', '198.51.100.16'].flatMap((ip) => ['--canaries', join(work, `canaries-${ip}.json`)]);
  const scan = await runTool('log-scan.mjs', [logFile, ...canaryFiles], { PATH: process.env.PATH });
  step('log review: no OTP, token, full phone, birth date, message text, signed URL or credential in the API log', scan.code === 0, scan.out);
  const lines = apiLog.join('').split('\n').filter(Boolean);
  step(`API log is structured JSON (${lines.length} lines)`, lines.length > 50 && lines.every((l) => l.startsWith('{')), lines.find((l) => !l.startsWith('{')));
  const ids = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'http.request' || l.requestId);
  step('log lines carry request ids', ids.length > 0 && ids.every((l) => typeof l.requestId === 'string' || l.requestId === null));
  await owner.end();
} finally {
  await stopApi().catch(() => undefined);
  await s3.close().catch(() => undefined);
  pgSrv.stop();
  rmSync(s3dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[rehearsal] ${results.length - failed}/${results.length} steps passed — LOCAL staging-shaped rehearsal, not a deployment.`);
process.exitCode = failed ? 1 : 0;
void readFileSync;
