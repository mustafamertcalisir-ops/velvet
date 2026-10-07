/**
 * The production-mode app bundle against the REAL API and PostgreSQL.
 *
 *   npm run server:build && npm run build:web:prod   (API URL http://127.0.0.1:8788)
 *
 * The bundle is a release build (no mock, no fixtures, no fixed code). The API
 * runs as a test deployment: one-time codes go to a local outbox file this
 * runner reads (the API refuses that sender in production), and reviewer
 * actions use the internal endpoint with a SIGNED request from a scoped key —
 * the same path real review tooling uses. Nothing in the app is bypassed.
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startPostgres } from './pg.mjs';

export const API_PORT = Number(process.env.E2E_API_PORT ?? 8788);
const INTERNAL_KEY = { id: 'e2e', secret: 'e2e-internal-secret-0123456789abcdef0123456789', scopes: ['review:write', 'review:media', 'billing:write', 'safety:write', 'retention:run', 'test:otp'] };

/** Signed internal request headers (server/src/http/internalAuth.ts). */
function signInternal(method, pathAndQuery, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const canonical = ['test', method, pathAndQuery, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
  return {
    'x-internal-key-id': INTERNAL_KEY.id,
    'x-internal-timestamp': ts,
    'x-internal-nonce': nonce,
    'x-internal-signature': createHmac('sha256', INTERNAL_KEY.secret).update(canonical).digest('base64url'),
  };
}

export async function startApi() {
  const entry = resolve('server/dist/main.mjs');
  if (!existsSync(entry)) throw new Error('server/dist/main.mjs missing — run npm run server:build');
  const pg = await startPostgres();
  const tmp = mkdtempSync('/tmp/velvet-e2e-api-');
  const outbox = join(tmp, 'sms-outbox.jsonl');
  const proc = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      APP_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(API_PORT),
      DATABASE_URL: pg.url,
      OTP_SECRET: 'e2e-otp-secret-0123456789abcdef0123456789abcd',
      MEDIA_SIGNING_SECRET: 'e2e-media-secret-0123456789abcdef0123456789',
      INTERNAL_KEYS_JSON: JSON.stringify({ [INTERNAL_KEY.id]: { secret: INTERNAL_KEY.secret, scopes: INTERNAL_KEY.scopes } }),
      SMS_PROVIDER: 'outbox-file',
      SMS_OUTBOX_FILE: outbox,
      CORS_ORIGINS: '*',
      DEV_SEED: '1',
      STORAGE_DRIVER: 'local',
      MEDIA_DIR: join(tmp, 'media'),
      LOG_LEVEL: 'warn',
      PUBLIC_BASE_URL: `http://127.0.0.1:${API_PORT}`,
      MIGRATIONS_DIR: resolve('server/migrations'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${API_PORT}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health/ready`)).ok) break;
    } catch {
      /* not yet */
    }
    if (i > 100 || proc.exitCode !== null) throw new Error(`API did not start:\n${log.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const files = (dir) =>
    existsSync(dir) ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)])) : [];
  return {
    base,
    log,
    /** Objects in the API's private (local-driver) storage, relative to its root. */
    storedObjects: () => files(join(tmp, 'media')).map((f) => f.slice(join(tmp, 'media').length + 1)),
    lastCode(phone) {
      if (!existsSync(outbox)) return null;
      const lines = readFileSync(outbox, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      return lines.filter((l) => l.phone === phone).at(-1)?.code ?? null;
    },
    async internal(path, body) {
      const raw = JSON.stringify(body ?? {});
      const r = await fetch(`${base}/internal${path}`, {
        method: 'POST',
        headers: { ...signInternal('POST', `/internal${path}`, raw), 'content-type': 'application/json' },
        body: raw,
      });
      return { status: r.status, body: await r.json() };
    },
    stop() {
      proc.kill('SIGTERM');
      pg.stop();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Launch → phone → real OTP → Stage 1 → submit → status, then a reviewer action through the API. */
export async function productionFlow(p, api, check, shot) {
  const { page, tid, visible, fillInput } = p;
  const t = '[prod]';
  await visible('screen-launch', 20000);
  check(`${t} dev hooks not exposed`, (await page.evaluate(() => typeof globalThis.__velvetDev)) === 'undefined');
  await tid('launch-apply').click();
  await visible('screen-phone');
  await fillInput('phone-input', '5321234567');
  await tid('phone-continue').click();
  await visible('screen-code', 12000);
  check(`${t} OTP dev hint absent`, (await page.locator('[data-testid="otp-dev-hint"]').count()) === 0);
  const bodyText = await page.locator('body').innerText();
  check(`${t} no development copy on screen`, !/development/i.test(bodyText));
  const code = api.lastCode('+905321234567');
  check(`${t} the API sent a random six-digit code (not the mock code)`, /^\d{6}$/.test(code ?? '') && code !== '246810');
  const wrong = code === '000000' ? '111111' : '000000';
  await page.locator('input[data-testid="otp-input"]:visible').fill(wrong);
  await page.getByText('doesn’t look right').first().waitFor({ timeout: 8000 });
  check(`${t} wrong code refused by the API`, true);
  await page.locator('input[data-testid="otp-input"]:visible').fill('246810');
  await page.getByText('doesn’t look right').first().waitFor({ timeout: 8000 });
  check(`${t} the mock development code does not work against the API`, (await page.locator('[data-testid="screen-intro"]:visible').count()) === 0);
  await page.locator('input[data-testid="otp-input"]:visible').fill(code);
  await visible('screen-intro', 12000);
  check(`${t} verified by the API → APPLICATION_DRAFT`, (await p.local())?.status === 'APPLICATION_DRAFT');
  await shot('prod-08-intro');
  await tid('intro-begin').click();
  await visible('screen-first-name');
  await fillInput('input-first-name', 'Çağla');
  await tid('step-continue').click();
  await visible('screen-last-name');
  await fillInput('input-last-name', 'Öztürk-Ilıcak');
  await tid('step-continue').click();
  await visible('screen-date-of-birth');
  await fillInput('dob-day', '14');
  await fillInput('dob-month', '03');
  await fillInput('dob-year', '1994');
  await tid('step-continue').click();
  await visible('screen-instagram');
  await fillInput('input-instagram', '@cagla.oi');
  await tid('step-continue').click();
  await visible('screen-country');
  await fillInput('country-list-search', 'turkiye');
  await tid('option-TR').click();
  await tid('step-continue').click();
  await visible('screen-city');
  await fillInput('city-list-search', 'istanbul');
  await tid('option-TR-istanbul').click();
  await tid('step-continue').click();
  await visible('screen-referral');
  await tid('referral-none').click();
  await visible('screen-review');
  await tid('review-submit').click();
  await visible('confirm-sheet');
  await tid('confirm-submit').click();
  await visible('screen-received', 15000);
  await shot('prod-25-received');
  const state = await p.local();
  check(`${t} submitted to the API → APPLICATION_RECEIVED`, state?.status === 'APPLICATION_RECEIVED' && state?.application?.id?.startsWith('app_'));
  const keys = await page.evaluate(() => Object.keys(localStorage).sort());
  check(`${t} no mock server on the device`, !keys.includes('velvet.mockServer.v1'), keys.join(','));
  // A reviewer starts the review through the internal API; the app follows the server.
  const r = await api.internal(`/reviewer/applications/${state.application.id}/actions`, { reviewerId: 'e2e.reviewer', action: { kind: 'START_REVIEW' } });
  check(`${t} reviewer action accepted by the API`, r.status === 200 && r.body.status === 'UNDER_REVIEW');
  await tid('received-view-status').click();
  await visible('screen-status');
  await tid('status-refresh').click();
  await page.getByText('Under review').first().waitFor({ timeout: 10000 });
  check(`${t} UNDER_REVIEW rendered from the API`, (await p.local())?.status === 'UNDER_REVIEW');
  await shot('prod-27-under-review');
  // Applicants cannot reach the member product, on the client or the server.
  await page.goto(page.url().replace(/\/application\/status.*/, '/member'));
  await visible('screen-status', 12000);
  check(`${t} applicant redirected from /member`, page.url().endsWith('/application/status'));
  const denied = await page.evaluate(async ({ base, token }) => (await fetch(`${base}/v1/introductions/today`, { headers: { authorization: `Bearer ${token}` } })).status, {
    base: api.base,
    token: state.session.token,
  });
  check(`${t} the API refuses member endpoints to an applicant`, denied === 403);

  // Extended application: photos go straight to private storage (direct upload, DEC-063).
  const ext = await api.internal(`/reviewer/applications/${state.application.id}/actions`, { reviewerId: 'e2e.reviewer', action: { kind: 'REQUEST_EXTENDED' } });
  check(`${t} reviewer asks for the extended application`, ext.body.status === 'EXTENDED_APPLICATION_REQUIRED');
  await page.goto(page.url().replace(/\/member.*/, '/application/status'));
  await visible('screen-status', 12000);
  await tid('status-refresh').click();
  await page.getByText('We’d like to know you better.').first().waitFor({ timeout: 10000 });
  await tid('status-primary').click();
  await visible('screen-extended-intro', 12000);
  await tid('extended-begin').click();
  await visible('screen-photos', 10000);
  const traffic = [];
  page.on('request', (req) => {
    if (req.url().startsWith(api.base)) traffic.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() ?? '', auth: Boolean(req.headers().authorization) });
  });
  const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
  await tid('photo-add').click();
  await (await chooser).setFiles(['photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg'].map((f) => resolve('e2e/fixtures', f)));
  await visible('photo-2', 20000);
  await page.waitForTimeout(500);
  check(`${t} three photos uploaded through the API`, (await tid('photo-count').innerText()).startsWith('3 of 6'));
  const authorise = traffic.filter((x) => x.method === 'POST' && x.path === '/v1/media/uploads');
  const puts = traffic.filter((x) => x.method === 'PUT' && x.path === '/v1/storage/upload');
  const completes = traffic.filter((x) => x.method === 'POST' && /^\/v1\/media\/uploads\/upl_[^/]+\/complete$/.test(x.path));
  check(`${t} direct upload: authorise → PUT to storage → complete, three times`, authorise.length === 3 && puts.length === 3 && completes.length === 3, JSON.stringify(traffic.map((x) => `${x.method} ${x.path}`)));
  check(`${t} no image bytes or base64 in any API JSON request`, traffic.filter((x) => x.method !== 'PUT').every((x) => !/base64|data:image/.test(x.body)));
  check(`${t} the storage PUT carries no session`, puts.every((x) => !x.auth));
  const stored = api.storedObjects();
  check(`${t} stored re-encoded under final keys; nothing left in incoming/`, stored.filter((f) => /^media\/application\/app_[^/]+\/med_[^/]+\.jpg$/.test(f)).length === 3 && !stored.some((f) => f.includes('incoming/')), stored.join(','));
  await shot('prod-32-photos-direct-upload');
  check(`${t} no page errors`, p.errors.length === 0, p.errors.join(' | '));
}
