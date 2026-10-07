/**
 * Direct-upload media pipeline (DEC-063): class authorization, signed
 * uploads, content validation, metadata stripping, delivery, verification
 * media isolation, reviewer access logging, expiry sweep — on the local
 * driver, and the same flow against an S3-compatible server (s3rver).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { s3ObjectStore } from '../src/media/objectStore';
import {
  activeMember,
  applicantInFinalReview,
  BASE_URL,
  fetchSigned,
  jpegBytesWithExif,
  review,
  signIn,
  stage1,
  testServer,
  upload,
  type T,
} from './harness';

let t: T;
beforeEach(async () => {
  t = await testServer();
});
afterEach(async () => t.close());

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

async function applicantInDraft() {
  const s = await signIn(t);
  const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': 'k' }, body: stage1() });
  await review(t, a.body.id, { kind: 'START_REVIEW' });
  await review(t, a.body.id, { kind: 'REQUEST_EXTENDED' });
  await t.request('POST', '/v1/application/extended/start', { token: s.token });
  return { ...s, applicationId: a.body.id as string };
}

describe('upload authorization by media class', () => {
  it('APPLICATION_MEDIA only while the extended draft is open; PROFILE_MEDIA only for members; VERIFICATION_MEDIA only for an identity request', async () => {
    const s = await signIn(t);
    const img = await jpegBytesWithExif();
    // No application yet.
    expect((await upload(t, s.token, img)).body.error.code).toBe('NOT_ALLOWED');
    expect((await upload(t, s.token, img, { mediaClass: 'PROFILE_MEDIA' })).body.error.code).toBe('MEMBERSHIP_REQUIRED');
    expect((await upload(t, s.token, img, { mediaClass: 'VERIFICATION_MEDIA' })).body.error.code).toBe('NOT_ALLOWED');
    const d = await applicantInDraft();
    expect((await upload(t, d.token, img)).status).toBe(200);
    expect((await upload(t, d.token, img, { mediaClass: 'PROFILE_MEDIA' })).body.error.code).toBe('MEMBERSHIP_REQUIRED');
    expect((await upload(t, d.token, img, { mediaClass: 'PROFILE_MEDIA', requestId: 'req_x' })).body.error.fields).toEqual(['requestId']);
    // Identity request: only VERIFICATION_MEDIA answers it, and APPLICATION_MEDIA cannot.
    const ap = await applicantInFinalReview(t);
    await review(t, ap.applicationId, { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'CONFIRM_IDENTITY' }] });
    const req = (await t.request('GET', '/v1/me/application', { token: ap.token })).body.informationRequests[0];
    expect(req.type).toBe('VERIFY_IDENTITY');
    expect((await upload(t, ap.token, img, { requestId: req.id })).body.error.code).toBe('NOT_ALLOWED');
    expect((await upload(t, ap.token, img, { requestId: req.id, mediaClass: 'VERIFICATION_MEDIA' })).status).toBe(200);
  });

  it('validates the request: class, type, size; nothing above 8 MiB is ever authorised', async () => {
    const d = await applicantInDraft();
    const r = await t.request('POST', '/v1/media/uploads', { token: d.token, body: { mediaClass: 'AVATAR', contentType: 'image/gif', byteLength: -1 } });
    expect(r.body.error.fields.sort()).toEqual(['byteLength', 'contentType', 'mediaClass']);
    const big = await t.request('POST', '/v1/media/uploads', { token: d.token, body: { mediaClass: 'APPLICATION_MEDIA', contentType: 'image/jpeg', byteLength: 9 * 1024 * 1024 } });
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect((await t.request('POST', '/v1/media/uploads', { body: { mediaClass: 'APPLICATION_MEDIA', contentType: 'image/jpeg', byteLength: 10 } })).status).toBe(401);
  });
});

describe('the signed upload', () => {
  it('accepts exactly the authorised object: type, length, key and expiry are signed', async () => {
    const d = await applicantInDraft();
    const img = await jpegBytesWithExif();
    const auth = await t.request('POST', '/v1/media/uploads', { token: d.token, body: { mediaClass: 'APPLICATION_MEDIA', contentType: 'image/jpeg', byteLength: img.length } });
    const url: string = auth.body.upload.url;
    expect(url.startsWith(`${BASE_URL}/v1/storage/upload?`)).toBe(true);
    expect(url).not.toContain(d.accountId);
    const put = (u: string, body: Uint8Array, type = 'image/jpeg') => t.request('PUT', u, { rawBody: body, headers: { 'content-type': type } });
    expect((await put(url, new Uint8Array(img), 'image/png')).body.error.fields).toEqual(['contentType']);
    expect((await put(url, new Uint8Array(img.subarray(0, 100)))).body.error.fields).toEqual(['contentLength']);
    expect((await put(url, new Uint8Array(Buffer.concat([img, Buffer.alloc(10)])))).status).toBe(413);
    expect((await put(url.replace(/sig=[^&]+/, 'sig=AAAA'), new Uint8Array(img))).status).toBe(404);
    expect((await put(url.replace(/k=incoming%2F/, 'k=member%2F'), new Uint8Array(img))).status).toBe(404);
    expect((await put(url.replace(/n=\d+/, `n=${img.length + 1}`), new Uint8Array(img))).status).toBe(404);
    // Completing before anything was stored: the upload stays open.
    expect((await t.request('POST', `/v1/media/uploads/${auth.body.uploadId}/complete`, { token: d.token })).body.error.fields).toEqual(['upload']);
    expect((await put(url, new Uint8Array(img))).status).toBe(200);
    // Someone else cannot complete it; the owner can, idempotently.
    const other = await applicantInDraft();
    expect((await t.request('POST', `/v1/media/uploads/${auth.body.uploadId}/complete`, { token: other.token })).body.error.code).toBe('NOT_FOUND');
    const done = await t.request('POST', `/v1/media/uploads/${auth.body.uploadId}/complete`, { token: d.token });
    const again = await t.request('POST', `/v1/media/uploads/${auth.body.uploadId}/complete`, { token: d.token });
    expect(done.status).toBe(200);
    expect(again.body.mediaId).toBe(done.body.mediaId);
    // The url cannot re-create the raw object once the upload is settled.
    expect((await put(url, new Uint8Array(img))).status).toBe(404);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.application_media WHERE application_id = $1', [d.applicationId])).rows[0].n).toBe(1);
    // After 10 minutes the url is dead.
    const late = await t.request('POST', '/v1/media/uploads', { token: d.token, body: { mediaClass: 'APPLICATION_MEDIA', contentType: 'image/jpeg', byteLength: img.length } });
    t.clock.set(new Date(t.clock.now().getTime() + 11 * 60_000).toISOString());
    expect((await put(late.body.upload.url, new Uint8Array(img))).status).toBe(404);
    expect((await t.request('POST', `/v1/media/uploads/${late.body.uploadId}/complete`, { token: d.token })).body.error.fields).toEqual(['upload']);
  });

  it('identifies by content, not by the declared type, and never keeps a rejected object', async () => {
    const d = await applicantInDraft();
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#335' } }).png().toBuffer();
    const mismatch = await upload(t, d.token, png, { contentType: 'image/jpeg' });
    expect(mismatch.body.error).toMatchObject({ code: 'VALIDATION_FAILED', fields: ['photo'] });
    const truncated = await upload(t, d.token, (await jpegBytesWithExif()).subarray(0, 200));
    expect(truncated.body.error.code).toBe('VALIDATION_FAILED');
    const ok = await upload(t, d.token, png, { contentType: 'image/png' });
    expect(ok.status).toBe(200);
    expect(filesUnder(join(t.mediaDir, 'media', 'incoming'))).toEqual([]);
    const statuses = (await t.pool.query(`SELECT status FROM app.media_uploads ORDER BY created_at`)).rows.map((r) => r.status);
    expect(statuses).toEqual(['REJECTED', 'REJECTED', 'COMPLETED']);
  });

  it('strips every metadata block and stores only re-encoded JPEG', async () => {
    await applicantInFinalReview(t);
    const stored = filesUnder(t.mediaDir);
    expect(stored.length).toBe(3);
    for (const f of stored) {
      expect(f).toMatch(/\/media\/application\/app_[^/]+\/med_[^/]+\.jpg$/);
      const bytes = readFileSync(f);
      expect(bytes.includes(Buffer.from('SECRET-EXIF-MARKER'))).toBe(false);
      expect((await sharp(bytes).metadata()).exif).toBeUndefined();
    }
  });

  it('abandoned uploads expire and their incoming objects are removed by the retention run', async () => {
    const d = await applicantInDraft();
    const img = await jpegBytesWithExif();
    const auth = await t.request('POST', '/v1/media/uploads', { token: d.token, body: { mediaClass: 'APPLICATION_MEDIA', contentType: 'image/jpeg', byteLength: img.length } });
    await t.request('PUT', auth.body.upload.url, { rawBody: new Uint8Array(img), headers: { 'content-type': 'image/jpeg' } });
    expect(filesUnder(join(t.mediaDir, 'media', 'incoming'))).toHaveLength(1);
    t.clock.set(new Date(t.clock.now().getTime() + 11 * 60_000).toISOString());
    const run = await t.internal('POST', '/internal/retention/run');
    expect(run.body.uploadsExpired).toBe(1);
    expect(filesUnder(join(t.mediaDir, 'media', 'incoming'))).toEqual([]);
    expect((await t.pool.query('SELECT status FROM app.media_uploads WHERE id = $1', [auth.body.uploadId])).rows[0].status).toBe('EXPIRED');
    // Settled uploads get one final sweep of their incoming key once their url is dead.
    const swept = await t.pool.query(`SELECT count(*)::int AS n FROM app.media_uploads WHERE incoming_swept_at IS NULL AND expires_at <= $1`, [t.clock.now().toISOString()]);
    expect(swept.rows[0].n).toBe(0);
  });

  it('concurrent completions cannot exceed the photo limit', async () => {
    const m = await activeMember(t);
    for (let i = 0; i < 2; i++) expect((await upload(t, m.token, await jpegBytesWithExif(10 + i), { mediaClass: 'PROFILE_MEDIA' })).status).toBe(200); // 5 of 6
    const img = await jpegBytesWithExif(20);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await t.request('POST', '/v1/media/uploads', { token: m.token, body: { mediaClass: 'PROFILE_MEDIA', contentType: 'image/jpeg', byteLength: img.length } });
      await t.request('PUT', a.body.upload.url, { rawBody: new Uint8Array(img), headers: { 'content-type': 'image/jpeg' } });
      ids.push(a.body.uploadId);
    }
    const results = await Promise.all(ids.map((id) => t.request('POST', `/v1/media/uploads/${id}/complete`, { token: m.token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.body.error?.fields?.[0] === 'photos')).toHaveLength(2);
    const positions = (await t.pool.query('SELECT position FROM app.member_media WHERE member_id = $1 AND position >= 0 ORDER BY position', [m.memberId])).rows.map((r) => r.position);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('verification media', () => {
  it('lives in its own bucket, is never returned to any device, and is visible to reviewers only — logged', async () => {
    const ap = await applicantInFinalReview(t);
    await review(t, ap.applicationId, { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'CONFIRM_IDENTITY' }] });
    const req = (await t.request('GET', '/v1/me/application', { token: ap.token })).body.informationRequests[0];
    const up = await upload(t, ap.token, await jpegBytesWithExif(5), { requestId: req.id, mediaClass: 'VERIFICATION_MEDIA' });
    expect(up.body.applicationMedia).toMatchObject({ purpose: 'verification', storageKey: '' });
    expect(filesUnder(join(t.mediaDir, 'verification'))).toHaveLength(1);
    expect(filesUnder(join(t.mediaDir, 'verification'))[0]).toMatch(/\/verification\/verification\/app_/);
    await t.request('PUT', `/v1/application/information-requests/${req.id}/response`, { token: ap.token, body: { type: 'VERIFY_IDENTITY', mediaId: up.body.mediaId } });
    const mine = await t.request('GET', '/v1/me/application', { token: ap.token });
    expect(mine.body.informationRequests[0].response).toEqual({ kind: 'verification_received' });
    expect(JSON.stringify(mine.body)).not.toMatch(/b=verification|verification%2F/);
    // Reviewer access: scoped key, 2-minute url, every access logged.
    const denied = await t.internal('POST', `/internal/reviewer/applications/${ap.applicationId}/media/${up.body.mediaId}/access`, { reviewerId: 'reviewer.one', purpose: 'REVIEW' }, { keyId: 'reviewer' });
    expect(denied.status).toBe(401); // the reviewer key has review:write only
    const access = await t.internal('POST', `/internal/reviewer/applications/${ap.applicationId}/media/${up.body.mediaId}/access`, { reviewerId: 'reviewer.one', purpose: 'REVIEW' });
    expect(access.body).toMatchObject({ mediaClass: 'VERIFICATION_MEDIA', expiresInSeconds: 120 });
    expect((await fetchSigned(t, access.body.url)).status).toBe(200);
    t.clock.set(new Date(t.clock.now().getTime() + 3 * 60_000).toISOString());
    expect((await fetchSigned(t, access.body.url)).status).toBe(404);
    const log = await t.pool.query('SELECT media_class, principal, purpose FROM app.media_access_log WHERE media_id = $1', [up.body.mediaId]);
    expect(log.rows).toEqual([{ media_class: 'VERIFICATION_MEDIA', principal: 'ops:reviewer.one', purpose: 'REVIEW' }]);
    await expect(t.pool.query('DELETE FROM app.media_access_log')).rejects.toThrow(/append-only/);
    // Never promoted to a member profile.
    await t.request('POST', '/v1/application/information-update', { token: ap.token, headers: { 'Idempotency-Key': 'v1' } });
  });
});

describe('profile media', () => {
  it('members add photos by direct upload; removed photos stop being delivered; purged photos never return', async () => {
    const m = await activeMember(t);
    const before = (await t.request('GET', '/v1/member/me', { token: m.token })).body.profile.photos.length;
    const up = await upload(t, m.token, await jpegBytesWithExif(7), { mediaClass: 'PROFILE_MEDIA' });
    expect(up.status).toBe(200);
    expect(up.body.member.profile.photos).toHaveLength(before + 1);
    const added = up.body.member.profile.photos.at(-1);
    expect(added.uri).toMatch(/^https:\/\/api\.test\/v1\/storage\/object\?b=media&k=member%2F/);
    expect((await fetchSigned(t, added.uri)).status).toBe(200);
    // Remove it from the profile.
    const order = up.body.member.profile.photos.slice(0, -1).map((p: { id: string }) => p.id);
    const patched = await t.request('PATCH', '/v1/member/me/profile', { token: m.token, body: { photoOrder: order } });
    expect(patched.body.profile.photos.map((p: { id: string }) => p.id)).toEqual(order);
    const row = (await t.pool.query('SELECT position, removed_at, purged_at FROM app.member_media WHERE id = $1', [added.id])).rows[0];
    expect(row.position).toBe(-1);
    expect(row.removed_at).not.toBeNull();
    expect(row.purged_at).toBeNull(); // no purge window configured: kept (policy pending)
    // A purged photo cannot be put back.
    await t.pool.query('UPDATE app.member_media SET purged_at = now() WHERE id = $1', [added.id]);
    const back = await t.request('PATCH', '/v1/member/me/profile', { token: m.token, body: { photoOrder: [...order, added.id] } });
    expect(back.status).toBe(422);
  });

  it('removed profile photos are purged by the retention process once a window is configured — unless under a hold or report', async () => {
    await t.close();
    t = await testServer(undefined, { RETENTION_REMOVED_PROFILE_MEDIA_DAYS: '30' });
    const m = await activeMember(t);
    const up = await upload(t, m.token, await jpegBytesWithExif(4), { mediaClass: 'PROFILE_MEDIA' });
    const photos = up.body.member.profile.photos as { id: string }[];
    const patched = await t.request('PATCH', '/v1/member/me/profile', { token: m.token, body: { photoOrder: photos.slice(0, -1).map((p) => p.id) } });
    expect(patched.status).toBe(200);
    const removed = photos.at(-1)!.id;
    const key = (await t.pool.query('SELECT storage_key FROM app.member_media WHERE id = $1', [removed])).rows[0].storage_key;
    expect(existsSync(join(t.mediaDir, 'media', key))).toBe(true);
    expect((await t.internal('POST', '/internal/retention/run')).body.mediaPurged).toBe(0);
    t.clock.advanceDays(31);
    const hold = await t.internal('POST', `/internal/safety/accounts/${m.accountId}/holds`, { actorId: 'safety.one', reason: 'INVESTIGATION' });
    expect((await t.internal('POST', '/internal/retention/run')).body.mediaPurged).toBe(0);
    const rel = await t.internal('POST', `/internal/safety/holds/${hold.body.holdId}/release`, { actorId: 'safety.one' });
    expect([hold.body, rel.body]).toEqual([{ holdId: expect.any(String) }, { released: true }]);
    expect((await t.internal('POST', '/internal/retention/run')).body.mediaPurged).toBe(1);
    expect(existsSync(join(t.mediaDir, 'media', key))).toBe(false);
    expect((await t.pool.query('SELECT purged_at FROM app.member_media WHERE id = $1', [removed])).rows[0].purged_at).not.toBeNull();
  });
});

// --- The same flow against an S3-compatible server ------------------------------------------------

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

describe('S3-compatible storage (s3rver emulation)', () => {
  let s3dir = '';
  let s3: { run(): Promise<unknown>; close(): Promise<void> } | null = null;
  let endpoint = '';
  afterAll(async () => {
    await s3?.close();
    if (s3dir) rmSync(s3dir, { recursive: true, force: true });
  });

  it('direct upload with provider-presigned urls; verification in its own bucket; delivery by presigned GET', async () => {
    const { default: S3rver } = await import('s3rver');
    s3dir = mkdtempSync('/tmp/velvet-s3-');
    const port = await freePort();
    endpoint = `http://127.0.0.1:${port}`;
    s3 = new S3rver({
      port,
      address: '127.0.0.1',
      directory: s3dir,
      silent: true,
      configureBuckets: [{ name: 'velvet-media' }, { name: 'velvet-verification' }],
    });
    await s3.run();
    await t.close();
    t = await testServer(undefined, {}, {
      store: () =>
        s3ObjectStore({
          driver: 's3',
          region: 'us-east-1',
          endpoint,
          bucket: 'velvet-media',
          verificationBucket: 'velvet-verification',
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
          forcePathStyle: true,
        }),
    });
    expect(t.store.driver).toBe('s3');
    expect(await t.store.ping()).toBe(true);
    const ap = await applicantInFinalReview(t);
    const keys = (await t.pool.query('SELECT storage_key FROM app.application_media WHERE application_id = $1', [ap.applicationId])).rows.map((r) => r.storage_key);
    expect(keys).toHaveLength(3);
    // Stored re-encoded under final keys; the incoming objects are gone.
    expect(filesUnder(join(s3dir, 'velvet-media')).some((f) => f.includes('/incoming/'))).toBe(false);
    await review(t, ap.applicationId, { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: ap.photoIds[0]! }, { preset: 'CONFIRM_IDENTITY' }] });
    const mine = (await t.request('GET', '/v1/me/application', { token: ap.token })).body;
    const url: string = mine.informationRequests[0].current.uri;
    expect(url.startsWith(`${endpoint}/velvet-media/application/`)).toBe(true);
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=600');
    const got = await fetch(url);
    expect(got.status).toBe(200);
    expect((await sharp(Buffer.from(await got.arrayBuffer())).metadata()).exif).toBeUndefined();
    const verify = mine.informationRequests.find((r: { type: string }) => r.type === 'VERIFY_IDENTITY');
    const v = await upload(t, ap.token, await jpegBytesWithExif(3), { requestId: verify.id, mediaClass: 'VERIFICATION_MEDIA' });
    expect(v.status).toBe(200);
    expect(v.auth!.upload.url.startsWith(`${endpoint}/velvet-verification/incoming/`)).toBe(true);
    expect(filesUnder(join(s3dir, 'velvet-verification')).some((f) => f.includes('/verification/app_'))).toBe(true);
    expect(filesUnder(join(s3dir, 'velvet-media')).some((f) => f.includes('/verification/'))).toBe(false);
    // Activation promotes application photos to member keys with a server-side copy.
    const m = await activeMember(t);
    const memberPhotos = (await t.request('GET', '/v1/member/me', { token: m.token })).body.profile.photos;
    expect(memberPhotos).toHaveLength(3);
    expect(memberPhotos[0].uri.startsWith(`${endpoint}/velvet-media/member/`)).toBe(true);
    expect((await fetch(memberPhotos[0].uri)).status).toBe(200);
  });
});
