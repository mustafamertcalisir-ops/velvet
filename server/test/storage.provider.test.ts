/**
 * REAL STORAGE PROVIDER integration test (docs/MEDIA_ARCHITECTURE.md §8).
 *
 * Runs only against a real S3-compatible bucket pair — never an emulator
 * (s3rver does not validate signatures, so it would prove nothing here):
 *
 *   STORAGE_PROVIDER_TEST=1 S3_REGION=eu-central-1 \
 *   S3_BUCKET=<staging media bucket> S3_VERIFICATION_BUCKET=<staging verification bucket> \
 *   [S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, or the default AWS credential chain] \
 *   [STORAGE_TEST_ALLOWED_ORIGIN=https://app-staging.<domain>] \
 *   npx vitest run test/storage.provider.test.ts
 *
 * Without those variables every case is SKIPPED and reported as BLOCKED —
 * storage is not "verified" until this file has passed against the staging
 * buckets. It writes only under incoming/ and member/ with random ids and
 * deletes what it writes.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { listAll, s3ObjectStore, type Bucket } from '../src/media/objectStore';

const env = process.env;
const enabled = env.STORAGE_PROVIDER_TEST === '1' && Boolean(env.S3_BUCKET && env.S3_VERIFICATION_BUCKET);
const title = enabled
  ? `real storage provider (${env.S3_ENDPOINT ?? `AWS ${env.S3_REGION}`})`
  : 'real storage provider — BLOCKED: no staging bucket credentials (set STORAGE_PROVIDER_TEST=1 and S3_*)';

const store = enabled
  ? s3ObjectStore({
      driver: 's3',
      region: env.S3_REGION ?? 'eu-central-1',
      endpoint: env.S3_ENDPOINT ?? null,
      bucket: env.S3_BUCKET!,
      verificationBucket: env.S3_VERIFICATION_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? null,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === '1',
    })
  : null;

const id = () => `t${randomBytes(8).toString('hex')}`;
const written: { bucket: Bucket; key: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (n: number) => randomBytes(n);

afterAll(async () => {
  if (store) for (const o of written) await store.delete(o.bucket, o.key).catch(() => undefined);
});

describe.skipIf(!enabled)(title, () => {
  const s = store!;
  async function presignedPut(bucket: Bucket, ttl = 120, n = 2048) {
    const key = `incoming/${new Date().toISOString().slice(0, 10).replaceAll('-', '')}/${id()}.bin`;
    written.push({ bucket, key });
    const up = await s.presignUpload(bucket, key, { contentType: 'image/jpeg', bytes: n, ttlSeconds: ttl });
    return { key, up, body: bytesOf(n) };
  }

  it('a signed upload works and stores exactly the bytes (both buckets)', async () => {
    for (const bucket of ['media', 'verification'] as const) {
      const { key, up, body } = await presignedPut(bucket);
      expect(up.url).toMatch(/X-Amz-SignedHeaders=[^&]*content-length/i);
      expect(up.url).toMatch(/X-Amz-SignedHeaders=[^&]*content-type/i);
      const put = await fetch(up.url, { method: 'PUT', headers: up.headers, body });
      expect(put.status, bucket).toBe(200);
      expect(Buffer.compare((await s.get(bucket, key, 10_000)) as Buffer, body)).toBe(0);
    }
  });

  it('an expired upload signature is refused', async () => {
    const { up, body } = await presignedPut('media', 1);
    await sleep(2500);
    expect((await fetch(up.url, { method: 'PUT', headers: up.headers, body })).status).toBe(403);
  });

  it('an altered signature is refused', async () => {
    const { up, body } = await presignedPut('media');
    const u = new URL(up.url);
    const sig = u.searchParams.get('X-Amz-Signature')!;
    u.searchParams.set('X-Amz-Signature', `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`);
    expect((await fetch(u, { method: 'PUT', headers: up.headers, body })).status).toBe(403);
  });

  it('a different content type than the one signed is refused', async () => {
    const { up, body } = await presignedPut('media');
    expect((await fetch(up.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body })).status).toBe(403);
  });

  it('more (or fewer) bytes than the signed length are refused', async () => {
    const big = await presignedPut('media', 120, 2048);
    expect((await fetch(big.up.url, { method: 'PUT', headers: big.up.headers, body: bytesOf(2049) })).status).toBe(403);
    const small = await presignedPut('media', 120, 2048);
    expect((await fetch(small.up.url, { method: 'PUT', headers: small.up.headers, body: bytesOf(10) })).status).toBe(403);
  });

  it('objects are private: an unsigned read is refused in both buckets', async () => {
    for (const bucket of ['media', 'verification'] as const) {
      const key = `member/${id()}/${id()}.jpg`;
      written.push({ bucket, key });
      await s.put(bucket, key, bytesOf(100), 'image/jpeg');
      const signedUrl = new URL(await s.presignDownload(bucket, key, 60));
      const unsigned = `${signedUrl.origin}${signedUrl.pathname}`;
      expect((await fetch(unsigned)).status, bucket).toBe(403);
    }
  });

  it('a signed read works, then stops working when it expires', async () => {
    const key = `member/${id()}/${id()}.jpg`;
    written.push({ bucket: 'media', key });
    const body = bytesOf(500);
    await s.put('media', key, body, 'image/jpeg');
    const ok = await fetch(await s.presignDownload('media', key, 60));
    expect(ok.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await ok.arrayBuffer()), body)).toBe(0);
    expect(ok.headers.get('cache-control') ?? '').toMatch(/private/);
    const short = await s.presignDownload('media', key, 1);
    await sleep(2500);
    expect((await fetch(short)).status).toBe(403);
  });

  it('a signed read for one bucket cannot be bent to the other bucket or another key', async () => {
    const key = `member/${id()}/${id()}.jpg`;
    written.push({ bucket: 'verification', key });
    await s.put('verification', key, bytesOf(100), 'image/jpeg');
    const url = new URL(await s.presignDownload('verification', key, 60));
    const otherKey = new URL(url);
    otherKey.pathname = otherKey.pathname.replace(/[^/]+\.jpg$/, `${id()}.jpg`);
    expect((await fetch(otherKey)).status).toBe(403);
    const otherBucket = new URL(url.toString().replace(env.S3_VERIFICATION_BUCKET!, env.S3_BUCKET!));
    expect((await fetch(otherBucket)).status).toBe(403);
  });

  it('copy, list (ListObjectsV2) and delete behave as the pipeline and reconciliation expect', async () => {
    const from = `member/${id()}/${id()}.jpg`;
    const to = `member/${id()}/${id()}.jpg`;
    written.push({ bucket: 'media', key: from }, { bucket: 'media', key: to });
    await s.put('media', from, bytesOf(300), 'image/jpeg');
    await s.copy({ bucket: 'media', key: from }, { bucket: 'media', key: to });
    const prefix = to.split('/').slice(0, 2).join('/');
    const listed: string[] = [];
    for await (const o of listAll(s, 'media', prefix)) listed.push(o.key);
    expect(listed).toEqual([to]);
    await s.delete('media', to);
    expect(await s.get('media', to, 10_000)).toBeNull();
    expect(await s.ping()).toBe(true);
  });

  it.skipIf(!env.STORAGE_TEST_ALLOWED_ORIGIN)('CORS: the staging web origin may PUT with a content type; another origin may not', async () => {
    const { up } = await presignedPut('media');
    const pre = (origin: string) =>
      fetch(up.url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    const allowed = await pre(env.STORAGE_TEST_ALLOWED_ORIGIN!);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(env.STORAGE_TEST_ALLOWED_ORIGIN);
    const other = await pre('https://evil.example');
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const get = await fetch(up.url, { method: 'OPTIONS', headers: { Origin: env.STORAGE_TEST_ALLOWED_ORIGIN!, 'Access-Control-Request-Method': 'DELETE' } });
    expect(get.headers.get('access-control-allow-methods') ?? '').not.toMatch(/DELETE/);
  });
});
