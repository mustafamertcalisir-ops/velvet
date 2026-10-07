/**
 * Render operations for the STAGING checks that must happen inside or against
 * the platform (DEC-082). Runs in CI (GitHub Environment "staging") with the
 * Render API key from the environment's secrets; prints statuses, never a
 * secret. Render API: https://api-docs.render.com (checked 2026-10-07).
 *
 *   node server/scripts/render-ops.mjs job "<start command>"     one-off job on the API service; prints its result lines
 *   node server/scripts/render-ops.mjs db-checks <file>…          every assertion in the suites' db-check files, as jobs
 *   node server/scripts/render-ops.mjs logs --since <iso> --out <file>   the API's application logs (for log-scan)
 *   node server/scripts/render-ops.mjs fault-drill               suspend the STAGING database, watch readiness fail
 *                                                                and liveness hold, resume, watch readiness recover
 *   node server/scripts/render-ops.mjs restore-drill             point-in-time recovery into a NEW instance, verify it
 *                                                                from this runner, then delete that instance
 *   node server/scripts/render-ops.mjs sms-outage-drill          point the SMS adapter at an unreachable host, request a
 *                                                                code for the project SIM (nothing can be sent), expect
 *                                                                the safe product error, then restore and redeploy
 *
 * Environment: RENDER_API_KEY (secret), RENDER_SERVICE_ID (srv-…), RENDER_OWNER_ID (tea-…),
 * RENDER_POSTGRES_ID (dpg-…), STAGING_API_URL (https, "staging" in the host).
 *
 * Safety rails: refuses a non-staging API URL; the fault drill always resumes
 * (finally); the restore drill never touches the live instance's data or
 * network settings and deletes ONLY the instance it created (id ≠ the live
 * id, name prefix checked).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const API = 'https://api.render.com/v1';
const key = env.RENDER_API_KEY ?? '';
const service = env.RENDER_SERVICE_ID ?? '';
const owner = env.RENDER_OWNER_ID ?? '';
const postgres = env.RENDER_POSTGRES_ID ?? '';
const staging = (env.STAGING_API_URL ?? '').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function need(...names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} (GitHub Environment "staging").`);
  if (names.includes('STAGING_API_URL') && !/^https:\/\/[^/]*staging[^/]*$/i.test(staging)) throw new Error('Refusing: STAGING_API_URL must be the https staging API.');
}
/** GitHub masks the value in every later log line. */
const mask = (v) => {
  if (v && env.GITHUB_ACTIONS) console.log(`::add-mask::${v}`);
};

async function render(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && attempt < 6) {
      await sleep(Number(r.headers.get('retry-after') ?? 5) * 1000);
      continue;
    }
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (!r.ok) throw new Error(`Render API ${method} ${path.split('?')[0]} → ${r.status} ${String(json?.message ?? '').slice(0, 160)}`);
    return json;
  }
}

/** Application log lines of a resource in [since, until] (the logs API pages by time). */
async function logsOf(resource, since, until = new Date()) {
  const lines = [];
  let start = since.toISOString();
  let end = until.toISOString();
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ ownerId: owner, startTime: start, endTime: end, direction: 'forward', limit: '100' });
    q.append('resource', resource);
    const res = await render('GET', `/logs?${q}`);
    for (const entry of res?.logs ?? []) lines.push(String(entry.message ?? entry.text ?? ''));
    if (!res?.hasMore) break;
    start = res.nextStartTime;
    end = res.nextEndTime;
  }
  return lines;
}

async function runJob(command) {
  need('RENDER_API_KEY', 'RENDER_SERVICE_ID', 'RENDER_OWNER_ID');
  const started = new Date(Date.now() - 5_000);
  const job = await render('POST', `/services/${service}/jobs`, { startCommand: command });
  const id = job?.id;
  if (!id) throw new Error('Render did not return a job id.');
  const deadline = Date.now() + 15 * 60_000;
  let status = job.status;
  while (!['succeeded', 'failed', 'canceled'].includes(status)) {
    if (Date.now() > deadline) throw new Error(`job ${id} did not finish in 15 minutes (last status ${status})`);
    await sleep(5_000);
    status = (await render('GET', `/services/${service}/jobs/${id}`))?.status;
  }
  await sleep(5_000); // logs arrive a moment after the job ends
  const lines = await logsOf(id, started).catch((e) => [`(logs unavailable: ${e.message})`]);
  const result = lines.filter((l) => /^(db-check |db-check failed|\{"command")/.test(l.trim()) || /Migrations:|Schema (verified|does not match)/.test(l));
  return { id, status, result: result.length ? result : lines.slice(-5) };
}

/** A deploy of the current commit through the API, followed to "live". */
async function deployAndWait() {
  const d = await render('POST', `/services/${service}/deploys`, { clearCache: 'do_not_clear' });
  const id = d?.id;
  if (!id) throw new Error('Render did not return a deploy id.');
  const FAILED = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated']);
  for (let i = 0; i < 120; i++) {
    await sleep(15_000);
    const status = (await render('GET', `/services/${service}/deploys/${id}`))?.status;
    if (status === 'live') return;
    if (FAILED.has(status)) throw new Error(`deploy ${id} ${status}`);
  }
  throw new Error(`deploy ${id} not live after 30 minutes`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'job') {
    const r = await runJob(args.join(' '));
    console.log(`job ${r.id}: ${r.status}`);
    for (const l of r.result) console.log(`  ${l}`);
    if (r.status !== 'succeeded') process.exitCode = 1;
    return;
  }

  if (command === 'db-checks') {
    let failed = 0;
    let n = 0;
    for (const file of args) {
      const checks = JSON.parse(readFileSync(file, 'utf8'));
      for (const c of checks) {
        n++;
        if (!c.args.every((a) => /^[A-Za-z0-9_=,.:-]+$/.test(a) || a === '--expect')) throw new Error(`unexpected characters in a db-check argument (${c.label})`);
        const r = await runJob(`node dist/db-check.mjs ${c.args.join(' ')}`);
        const ok = r.status === 'succeeded';
        if (!ok) failed++;
        console.log(`${ok ? '✓' : '✗'} db: ${c.label}${ok ? '' : `\n    ${r.result.join('\n    ')}`}`);
      }
    }
    console.log(`\ndatabase assertions (inside Render): ${n - failed}/${n} held`);
    if (failed) process.exitCode = 1;
    return;
  }

  if (command === 'logs') {
    need('RENDER_API_KEY', 'RENDER_SERVICE_ID', 'RENDER_OWNER_ID');
    const since = new Date(args[args.indexOf('--since') + 1] ?? Date.now() - 3600_000);
    const out = args[args.indexOf('--out') + 1];
    if (!out) throw new Error('--out <file> is required');
    const lines = await logsOf(service, since);
    writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
    console.log(`${lines.length} API log lines since ${since.toISOString()} → ${out}`);
    return;
  }

  if (command === 'fault-drill') {
    need('RENDER_API_KEY', 'RENDER_POSTGRES_ID', 'STAGING_API_URL');
    const probe = async () => {
      const ready = await fetch(`${staging}/health/ready`).catch(() => null);
      const live = await fetch(`${staging}/health/live`).catch(() => null);
      return { ready: ready?.status ?? 0, readyBody: ready ? await ready.text() : '', live: live?.status ?? 0 };
    };
    const before = await probe();
    if (before.ready !== 200) throw new Error(`Refusing: staging is not ready before the drill (${before.ready}).`);
    const results = [];
    const check = (name, ok, detail = '') => {
      results.push(ok);
      console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
    };
    try {
      await render('POST', `/postgres/${postgres}/suspend`);
      console.log('Database suspended; watching the API…');
      let down = null;
      for (let i = 0; i < 60 && !down; i++) {
        await sleep(5_000);
        const p = await probe();
        if (p.ready === 503) down = p;
      }
      check('database unavailable: readiness answers 503', Boolean(down), 'readiness never failed within 5 minutes');
      if (down) {
        check('readiness reveals no infrastructure detail', !/postgres|render|dpg-|amazonaws|ECONN|host/i.test(down.readyBody), down.readyBody.slice(0, 200));
        check('liveness stays 200 (no restart loop)', down.live === 200, String(down.live));
        const typed = await fetch(`${staging}/v1/member/me`, { headers: { authorization: 'Bearer drill-not-a-real-token-000000000000' } }).catch(() => null);
        const body = typed ? await typed.text() : '';
        check('requests answer a typed, safe error', Boolean(typed) && /"code":"[A-Z_]+"/.test(body) && !/ECONN|postgres|stack|dpg-/.test(body), body.slice(0, 200));
      }
    } finally {
      await render('POST', `/postgres/${postgres}/resume`);
      console.log('Database resume requested.');
    }
    let back = false;
    for (let i = 0; i < 120 && !back; i++) {
      await sleep(5_000);
      back = (await probe()).ready === 200;
    }
    check('database back: readiness recovers without redeploying the API', back, 'not ready 10 minutes after resume');
    if (results.some((ok) => !ok)) process.exitCode = 1;
    return;
  }

  if (command === 'restore-drill') {
    need('RENDER_API_KEY', 'RENDER_POSTGRES_ID', 'RENDER_SERVICE_ID', 'RENDER_OWNER_ID');
    const live = await render('GET', `/postgres/${postgres}`);
    // 1. A point in time at least 10 minutes back, the live counts at that time, and a QA write after it.
    const counts = await runJob('node dist/db-check.mjs counts');
    const at = new Date(Date.now() - 11 * 60_000);
    console.log(`Recovery target: ${at.toISOString()} (live counts now: ${counts.result.join(' ')})`);
    // 2. Recovery into a NEW instance (never over the live one).
    const name = `velvet-db-staging-restore-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 1e4)}`;
    const t0 = Date.now();
    const created = await render('POST', `/postgres/${postgres}/recovery`, { restoreName: name, restoreTime: at.toISOString(), ...(live?.environmentId ? { environmentId: live.environmentId } : {}) });
    const restoredId = created?.id ?? created?.postgres?.id;
    if (!restoredId || restoredId === postgres) throw new Error('Refusing: recovery did not return a NEW instance id.');
    console.log(`Recovery instance ${restoredId} (${name}) requested.`);
    let ok = false;
    try {
      let status = '';
      for (let i = 0; i < 240 && status !== 'available'; i++) {
        await sleep(15_000);
        status = (await render('GET', `/postgres/${restoredId}`))?.status ?? '';
      }
      if (status !== 'available') throw new Error(`recovery instance not available after an hour (last status ${status})`);
      const rto = Math.round((Date.now() - t0) / 60_000);
      console.log(`Recovery instance available after ~${rto} min.`);
      // 3. Verify it from this runner: allow ONLY this runner's address, on the recovery instance only.
      const ip = (await (await fetch('https://api.ipify.org')).text()).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('could not determine this runner\'s address');
      await render('PATCH', `/postgres/${restoredId}`, { ipAllowList: [{ cidrBlock: `${ip}/32`, description: 'restore drill (temporary)' }] });
      const info = await render('GET', `/postgres/${restoredId}/connection-info`);
      const url = info?.externalConnectionString;
      if (!url) throw new Error('no external connection string for the recovery instance');
      mask(url);
      mask(new URL(url).password);
      await sleep(20_000); // the allow list takes a moment
      const verifyEnv = { ...env, APP_ENV: 'staging', MIGRATION_DATABASE_URL: url, DATABASE_URL: '', DATABASE_TLS: 'require' };
      const migrate = spawnSync(process.execPath, ['server/dist/migrate.mjs', '--verify'], { env: verifyEnv, encoding: 'utf8' });
      console.log(`  migrate --verify: ${migrate.stdout.trim() || migrate.stderr.trim()}`);
      const restored = spawnSync(process.execPath, ['server/dist/db-check.mjs', 'counts'], { env: { ...verifyEnv, DB_CHECK_DATABASE_URL: url }, encoding: 'utf8' });
      console.log(`  restored counts: ${restored.stdout.trim() || restored.stderr.trim()}`);
      // Point in time: nothing audited after the target exists in the copy (the suites wrote plenty since).
      const facts = JSON.parse(restored.stdout.trim().replace(/^db-check /, '') || '{}').facts ?? {};
      const inTime = typeof facts.lastAuditAt === 'string' && new Date(facts.lastAuditAt) <= at;
      console.log(`${inTime ? '✓' : '✗'} the copy ends at the target time (last audit event ${facts.lastAuditAt ?? 'none'} ≤ ${at.toISOString()})`);
      ok = migrate.status === 0 && restored.status === 0 && inTime;
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Restore drill: ${ok ? 'verified' : 'FAILED'}; ~${rto} min to available; target ${at.toISOString()}\n`);
    } finally {
      // 4. Delete ONLY the recovery instance (billed while it exists).
      const again = await render('GET', `/postgres/${restoredId}`).catch(() => null);
      if (restoredId !== postgres && String(again?.name ?? name).startsWith('velvet-db-staging-restore-')) {
        await render('DELETE', `/postgres/${restoredId}`);
        console.log(`Recovery instance ${restoredId} deleted.`);
      } else {
        console.log(`NOT deleting ${restoredId}: it does not look like the drill's instance — delete it by hand if it is.`);
      }
    }
    if (!ok) process.exitCode = 1;
    return;
  }

  if (command === 'sms-outage-drill') {
    need('RENDER_API_KEY', 'RENDER_SERVICE_ID', 'STAGING_API_URL', 'STAGING_REAL_PHONE');
    const phone = env.STAGING_REAL_PHONE;
    if (!/^\+905\d{9}$/.test(phone)) throw new Error('STAGING_REAL_PHONE must be a project-owned Turkish mobile number.');
    mask(phone);
    const vars = (await render('GET', `/services/${service}/env-vars?limit=100`)) ?? [];
    const valueOf = (k) => vars.map((v) => v.envVar ?? v).find((v) => v.key === k)?.value;
    const provider = valueOf('SMS_PROVIDER');
    const OVERRIDE = { netgsm: 'NETGSM_BASE_URL', iletimerkezi: 'ILETIMERKEZI_BASE_URL' }[provider];
    if (!OVERRIDE) throw new Error(`Refusing: SMS_PROVIDER is ${provider ?? 'unset'}; the drill needs a real provider (netgsm or iletimerkezi).`);
    if (valueOf(OVERRIDE) !== undefined) throw new Error(`Refusing: ${OVERRIDE} is already set on the service; the drill would overwrite it.`);
    const results = [];
    const check = (name, ok, detail = '') => {
      results.push(ok);
      console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
    };
    try {
      await render('PUT', `/services/${service}/env-vars/${OVERRIDE}`, { value: 'https://sms-outage.invalid' });
      console.log('SMS provider pointed at an unreachable host; deploying…');
      await deployAndWait();
      const r = await fetch(`${staging}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phoneE164: phone }) });
      const body = await r.json().catch(() => null);
      check('provider unreachable: the applicant gets the safe "couldn’t send a code" error', r.status === 503 && body?.error?.code === 'CODE_NOT_SENT', `${r.status} ${body?.error?.code}`);
      check('no provider, host or vendor detail reaches the client', !/netgsm|iletimerkezi|invalid|provider|ENOTFOUND|fetch failed/i.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 200));
    } finally {
      await render('DELETE', `/services/${service}/env-vars/${OVERRIDE}`).catch((e) => console.log(`!! could not remove ${OVERRIDE} — remove it by hand: ${e.message}`));
      console.log('Override removed; deploying the normal configuration…');
      await deployAndWait();
      const ready = await fetch(`${staging}/health/ready`).catch(() => null);
      check('restored: staging is ready again with the normal SMS configuration', ready?.status === 200);
    }
    if (results.some((ok) => !ok)) process.exitCode = 1;
    return;
  }

  throw new Error('Usage: render-ops job "<cmd>" | db-checks <file>… | logs --since <iso> --out <file> | fault-drill | restore-drill | sms-outage-drill');
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
