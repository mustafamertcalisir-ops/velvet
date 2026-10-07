/**
 * REAL-PROVIDER browser upload check (CORS) against the staging buckets —
 * part of the storage provider checks (docs/MEDIA_ARCHITECTURE.md §8), run in
 * CI with the GitHub-OIDC storage-test role. Not an emulator check.
 *
 * A real Chromium loads a page served AS the staging web origin (the page is
 * fulfilled locally by Playwright, so no site has to exist) and PUTs to a real
 * presigned S3 URL, exactly as the web app's direct upload does. A second page
 * on another origin tries the same. S3's own CORS answer decides both.
 *
 *   STAGING_WEB_ORIGIN=https://… (optional) S3_BUCKET=… S3_REGION=eu-central-1 node e2e/storage-cors.mjs
 *
 * With STAGING_WEB_ORIGIN: that origin uploads, any other origin is refused.
 * Without it (no staging web build): the bucket has no CORS rule and every
 * browser origin is refused — the smallest policy; native apps do not use CORS.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const env = process.env;
if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required (the staging media bucket).');
const allowed = (env.STAGING_WEB_ORIGIN ?? '').replace(/\/+$/, '');
const other = 'https://not-the-staging-web-origin.invalid';
// S3_ENDPOINT only for checking this script's own mechanics against an emulator; such a run proves nothing about S3.
const emulator = Boolean(env.S3_ENDPOINT);
if (emulator) console.log('EMULATOR RUN — checks this script only; the real result needs the staging bucket.');
const s3 = new S3Client({
  region: env.S3_REGION ?? 'eu-central-1',
  ...(emulator ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' } } : {}),
});
const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

async function presigned() {
  const key = `incoming/${day}/t${randomBytes(8).toString('hex')}.bin`;
  const bytes = 4096;
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: 'image/jpeg', ContentLength: bytes }), { expiresIn: 120 });
  return { key, bytes, url };
}
const exists = (key) =>
  s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key })).then(
    () => true,
    () => false,
  );

const browser = await chromium.launch({
  executablePath: env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  // The emulator is plain http on loopback: let a (fulfilled) page reach it. Never used against S3.
  ...(emulator ? { args: ['--no-proxy-server', '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] } : {}),
});
const written = [];
try {
  /** Upload from a page whose origin is `origin`; answers the status, or "refused" when the browser blocks it. */
  async function uploadFrom(origin) {
    const target = await presigned();
    written.push(target.key);
    const page = await browser.newPage();
    await page.route(`${origin}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>cors</title>' }));
    await page.goto(`${origin}/upload-check`, { timeout: 15_000 });
    const outcome = await page.evaluate(
      async ({ url, bytes }) => {
        try {
          const r = await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(20_000) });
          return String(r.status);
        } catch {
          return 'refused';
        }
      },
      { url: target.url, bytes: target.bytes },
    );
    await page.close();
    return { outcome, stored: await exists(target.key) };
  }

  if (allowed) {
    const ok = await uploadFrom(allowed);
    check(`the staging web origin (${allowed}) uploads directly to S3`, ok.outcome === '200' && ok.stored, JSON.stringify(ok));
  } else {
    console.log('– no STAGING_WEB_ORIGIN: the bucket should carry no CORS rule (no web client in staging)');
  }
  const no = await uploadFrom(other);
  check('another origin is refused by the browser (S3 sends no CORS permission)', no.outcome === 'refused', JSON.stringify(no));
  if (!allowed) {
    const none = await uploadFrom('https://velvet-web-staging.invalid');
    check('with no web origin configured, every browser origin is refused', none.outcome === 'refused', JSON.stringify(none));
  }
} finally {
  await browser.close();
  for (const key of written) await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key })).catch(() => undefined);
}
console.log(`\nbrowser upload (CORS) against S3: ${results.filter(Boolean).length}/${results.length} checks passed`);
process.exitCode = results.every(Boolean) ? 0 : 1;
