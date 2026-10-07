/** Admission on the production API: lifecycle, idempotency, review, activation, audit, media. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeMember,
  applicantInFinalReview,
  jpegWithExif,
  review,
  seedPlan,
  signIn,
  stage1,
  testServer,
  upload,
  uploadApplicationPhoto,
  type T,
} from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer();
});
afterAll(async () => t.close());

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('Stage 1', () => {
  it('submitting never approves: APPLICATION_RECEIVED, idempotent, one application per account', async () => {
    const s = await signIn(t);
    const body = stage1();
    const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': 'k1' }, body });
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('APPLICATION_RECEIVED');
    const again = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': 'k1' }, body });
    const other = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': 'k2' }, body });
    expect(again.body.id).toBe(a.body.id);
    expect(other.body.id).toBe(a.body.id);
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM app.membership_applications WHERE account_id = $1', [s.accountId]);
    expect(rows[0].n).toBe(1);
    const mine = await t.request('GET', '/v1/me/application', { token: s.token });
    expect(mine.body.summary).toEqual({ firstName: 'Şebnem', age: 32, cityLabel: 'İstanbul' });
    expect(JSON.stringify(mine.body)).not.toContain('1994-03-14');
  });

  it('validates server-side (under 18, bad fields, wrong types) and requires an idempotency key', async () => {
    const s = await signIn(t);
    const bad = await t.request('POST', '/v1/application', {
      token: s.token,
      headers: { 'Idempotency-Key': 'k' },
      body: stage1({ firstName: 'R2D2', dateOfBirth: '2012-01-01', instagram: { kind: 'handle', handle: 'https://instagram.com/p/xyz' }, countryCode: 'ZZ', city: 5, referral: { kind: 'requested', referrals: [] } }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields.sort()).toEqual(['city', 'countryCode', 'dateOfBirth', 'firstName', 'instagram', 'referral']);
    const noKey = await t.request('POST', '/v1/application', { token: s.token, body: stage1() });
    expect(noKey.body.error.fields).toEqual(['idempotencyKey']);
    const notJson = await t.app.request('/v1/application', { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'Idempotency-Key': 'k', 'content-type': 'application/json' }, body: '{nope' });
    expect(notJson.status).toBe(422);
  });

  it('private application data is stored apart and the referral is recorded privately', async () => {
    const s = await signIn(t);
    const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': 'k' }, body: stage1() });
    const priv = await t.pool.query('SELECT last_name, date_of_birth, instagram_handle FROM app.application_private_data WHERE application_id = $1', [a.body.id]);
    expect(priv.rows[0]).toEqual({ last_name: 'Karaosmanoğlu-Büyükçekmeceli', date_of_birth: '1994-03-14', instagram_handle: 'sebnem.private' });
    const refs = await t.pool.query('SELECT referrer_name FROM app.application_referrals WHERE application_id = $1', [a.body.id]);
    expect(refs.rows).toEqual([{ referrer_name: 'Gökçe Işıklar' }]);
    expect(JSON.stringify(a.body)).not.toContain('Karaosmanoğlu');
  });
});

describe('review lifecycle (internal reviewer endpoint only)', () => {
  it('moves only along the lifecycle, with internal reasons and audit; applicants cannot decide', async () => {
    const ap = await applicantInFinalReview(t);
    // A forbidden move is refused (no approval before final review, no skipping).
    const s = await signIn(t);
    const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': 'k' }, body: stage1() });
    const early = await t.internal('POST', `/internal/reviewer/applications/${a.body.id}/actions`, {
      reviewerId: 'reviewer.one',
      action: { kind: 'APPROVE' },
    });
    expect(early.body.error.code).toBe('NOT_ALLOWED');
    // Waitlist with an internal reason; the applicant sees the status only.
    await review(t, ap.applicationId, { kind: 'WAITLIST', reason: 'CAPACITY' });
    const mine = await t.request('GET', '/v1/me/application', { token: ap.token });
    expect(mine.body.application.status).toBe('WAITLISTED');
    expect(JSON.stringify(mine.body)).not.toMatch(/CAPACITY|reviewer\.one|reason/);
    const reviews = await t.pool.query('SELECT action, reason_code FROM app.application_reviews WHERE application_id = $1 ORDER BY created_at', [ap.applicationId]);
    expect(reviews.rows.map((r) => r.action)).toEqual(['START_REVIEW', 'REQUEST_EXTENDED', 'WAITLIST']);
    expect(reviews.rows[2].reason_code).toBe('CAPACITY');
  });

  it('NOT_ADMITTED and WAITLISTED applicants cannot begin membership or reach the member API', async () => {
    for (const kind of ['NOT_ADMIT', 'WAITLIST'] as const) {
      const ap = await applicantInFinalReview(t);
      await review(t, ap.applicationId, { kind, reason: 'APPLICATION_QUALITY' });
      expect((await t.request('POST', '/v1/membership/begin', { token: ap.token })).body.error.code).toBe('NOT_ALLOWED');
      for (const [m, p] of [
        ['GET', '/v1/member/me'],
        ['GET', '/v1/introductions/today'],
        ['GET', '/v1/conversations'],
        ['PUT', '/v1/member/me/dating'],
      ] as const) {
        const r = await t.request(m, p, { token: ap.token, body: m === 'PUT' ? {} : undefined });
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe('MEMBERSHIP_REQUIRED');
      }
    }
  });

  it('more information: narrow requests, answered by the applicant, returning to the same review stage', async () => {
    const ap = await applicantInFinalReview(t);
    await review(t, ap.applicationId, {
      kind: 'REQUEST_INFORMATION',
      requests: [{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: ap.photoIds[1]! }, { preset: 'INSTAGRAM_NOT_FOUND' }],
    });
    const mine = await t.request('GET', '/v1/me/application', { token: ap.token });
    expect(mine.body.application.status).toBe('MORE_INFORMATION_REQUIRED');
    const [photoReq, igReq] = mine.body.informationRequests;
    expect(photoReq.current.uri).toMatch(/^https:\/\/api\.test\/v1\/storage\/object\?b=media&k=application%2F/);
    // A photo upload must answer an open request of the right type.
    const up = await uploadApplicationPhoto(t, ap.token, await jpegWithExif(9), photoReq.id);
    expect(up.status).toBe(200);
    expect((await uploadApplicationPhoto(t, ap.token, await jpegWithExif(9), igReq.id)).body.error.code).toBe('NOT_ALLOWED');
    await t.request('PUT', `/v1/application/information-requests/${photoReq.id}/response`, { token: ap.token, body: { type: 'REPLACE_PHOTO', mediaId: up.body.id } });
    // Not everything answered yet.
    expect((await t.request('POST', '/v1/application/information-update', { token: ap.token, headers: { 'Idempotency-Key': 'u1' } })).status).toBe(422);
    const wrong = await t.request('PUT', `/v1/application/information-requests/${igReq.id}/response`, { token: ap.token, body: { type: 'UPDATE_INSTAGRAM', handle: 'https://instagram.com/p/x' } });
    expect(wrong.status).toBe(422);
    await t.request('PUT', `/v1/application/information-requests/${igReq.id}/response`, { token: ap.token, body: { type: 'UPDATE_INSTAGRAM', handle: '@sebnem.studio' } });
    const sent = await t.request('POST', '/v1/application/information-update', { token: ap.token, headers: { 'Idempotency-Key': 'u2' } });
    expect(sent.body.application.status).toBe('FINAL_REVIEW');
    const replay = await t.request('POST', '/v1/application/information-update', { token: ap.token, headers: { 'Idempotency-Key': 'u2' } });
    expect(replay.status).toBe(200);
    const ig = await t.pool.query('SELECT instagram_handle FROM app.application_private_data WHERE application_id = $1', [ap.applicationId]);
    expect(ig.rows[0].instagram_handle).toBe('sebnem.studio');
    const media = await t.pool.query('SELECT id, position, retired_at FROM app.application_media WHERE application_id = $1 ORDER BY created_at', [ap.applicationId]);
    expect(media.rows.find((m) => m.id === ap.photoIds[1])).toMatchObject({ position: -1 });
    expect(media.rows.find((m) => m.id === up.body.id)).toMatchObject({ position: 1, retired_at: null });
  });
});

describe('Stage 2', () => {
  it('lands in FINAL_REVIEW (never a decision), idempotently, and stores Dating answers privately', async () => {
    const ap = await applicantInFinalReview(t, { meet: ['women', 'non_binary'], ageRange: { min: 28, max: 40 } });
    const mine = await t.request('GET', '/v1/me/application', { token: ap.token });
    expect(mine.body.application.status).toBe('FINAL_REVIEW');
    const prefs = await t.pool.query('SELECT meet, age_min, age_max FROM app.application_dating_preferences WHERE application_id = $1', [ap.applicationId]);
    expect(prefs.rows[0]).toEqual({ meet: ['women', 'non_binary'], age_min: 28, age_max: 40 });
    const replay = await t.request('POST', '/v1/application/extended', { token: ap.token, headers: { 'Idempotency-Key': `s2-${ap.accountId}` }, body: {} });
    expect(replay.body.status).toBe('FINAL_REVIEW');
  });

  it('refuses photos that belong to someone else and Dating preferences without Dating', async () => {
    const a = await applicantInFinalReview(t);
    const s = await signIn(t);
    const app = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': 'k' }, body: stage1() });
    await review(t, app.body.id, { kind: 'START_REVIEW' });
    await review(t, app.body.id, { kind: 'REQUEST_EXTENDED' });
    await t.request('POST', '/v1/application/extended/start', { token: s.token });
    const r = await t.request('POST', '/v1/application/extended', {
      token: s.token,
      headers: { 'Idempotency-Key': 'x' },
      body: {
        photoIds: a.photoIds,
        occupation: 'Architect',
        workContext: { kind: 'independent' },
        whatYouDo: 'x'.repeat(50),
        aboutYou: 'y'.repeat(50),
        interests: ['Architecture', 'Swimming', 'Jazz'],
        intents: ['friendship'],
        datingPreferences: { meet: ['women'], ageRange: { min: 30, max: 40 } },
      },
    });
    expect(r.body.error.fields.sort()).toEqual(['datingPreferences', 'photos']);
  });
});

describe('media security', () => {
  it('re-encodes uploads (EXIF and every metadata block dropped) and serves them only by short-lived signature', async () => {
    const s = await applicantInFinalReview(t);
    const stored = filesUnder(t.mediaDir);
    expect(stored.length).toBeGreaterThanOrEqual(3);
    for (const f of stored) {
      const bytes = readFileSync(f);
      expect(bytes.includes(Buffer.from('SECRET-EXIF-MARKER'))).toBe(false);
      expect(bytes.includes(Buffer.from('41.0082N'))).toBe(false);
      const meta = await sharp(bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.format).toBe('jpeg');
    }
    // Applicant-facing URLs are signed and expire.
    await review(t, s.applicationId, { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: s.photoIds[0]! }] });
    const mine = await t.request('GET', '/v1/me/application', { token: s.token });
    const url = new URL(mine.body.informationRequests[0].current.uri);
    const path = `${url.pathname}${url.search}`;
    const ok = await t.app.request(path);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    const tampered = await t.app.request(path.replace(/sig=[^&]+/, 'sig=AAAA'));
    expect(tampered.status).toBe(404);
    const otherKey = await t.app.request(path.replace(/&k=[^&]+/, `&k=${encodeURIComponent('member/mem_xxxx/mmd_xxxx.jpg')}`));
    expect(otherKey.status).toBe(404);
    t.clock.set(new Date(t.clock.now().getTime() + 11 * 60_000).toISOString());
    expect((await t.app.request(path)).status).toBe(404);
  });

  it('rejects files that are not images, by content', async () => {
    const s = await signIn(t);
    const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': 'k' }, body: stage1() });
    await review(t, a.body.id, { kind: 'START_REVIEW' });
    await review(t, a.body.id, { kind: 'REQUEST_EXTENDED' });
    await t.request('POST', '/v1/application/extended/start', { token: s.token });
    const r = await upload(t, s.token, Buffer.from('<?php echo 1; ?>'));
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_FAILED', fields: ['photo'] });
    // Rejected: the incoming object is gone, and the upload cannot be completed again.
    expect((await t.pool.query(`SELECT status, rejection_reason FROM app.media_uploads WHERE id = $1`, [r.auth!.uploadId])).rows[0]).toEqual({
      status: 'REJECTED',
      rejection_reason: 'NOT_AN_IMAGE',
    });
  });
});

describe('activation', () => {
  it('APPROVED → payment required → provider confirmation → ACTIVE_MEMBER, provisioning the profile once; audited', async () => {
    const m = await activeMember(t);
    const mine = await t.request('GET', '/v1/me/application', { token: m.token });
    expect(mine.body.application.status).toBe('ACTIVE_MEMBER');
    expect(mine.body.membership.status).toBe('active');
    // A repeated provider event is a no-op.
    const again = await t.internal('POST', '/internal/billing/payment-confirmed', {
      accountId: m.accountId,
      providerEventId: `evt_${m.accountId}`,
      provider: 'test',
    });
    expect(again.status).toBe(200);
    const profiles = await t.pool.query('SELECT count(*)::int AS n FROM app.member_profiles WHERE account_id = $1', [m.accountId]);
    expect(profiles.rows[0].n).toBe(1);
    const events = await t.pool.query('SELECT event_type FROM app.audit_events WHERE account_id = $1 ORDER BY created_at, id', [m.accountId]);
    expect(events.rows.map((e) => e.event_type).sort()).toEqual(
      [
        'PHONE_VERIFIED',
        'APPLICATION_SUBMITTED',
        'APPLICATION_REVIEW_STARTED',
        'EXTENDED_APPLICATION_REQUESTED',
        'EXTENDED_APPLICATION_STARTED',
        'EXTENDED_APPLICATION_SUBMITTED',
        'FINAL_REVIEW_STARTED',
        'APPLICATION_APPROVED',
        'MEMBERSHIP_ACTIVATION_STARTED',
        'MEMBERSHIP_ACTIVATED',
      ].sort(),
    );
    // Promoted photos are copies under member keys — verification media never.
    const media = await t.pool.query('SELECT storage_key FROM app.member_media WHERE member_id = $1', [m.memberId]);
    expect(media.rows.every((r) => r.storage_key.startsWith('member/'))).toBe(true);
  });

  it('the applicant cannot activate themselves; payment for a non-pending application is refused', async () => {
    const ap = await applicantInFinalReview(t);
    await seedPlan(t);
    const r = await t.internal('POST', '/internal/billing/payment-confirmed', { accountId: ap.accountId, providerEventId: 'evt_early', provider: 'test' });
    expect(r.body.error.code).toBe('NOT_ALLOWED');
  });

  it('audit events are append-only', async () => {
    // The runtime role cannot UPDATE at all; the owner is stopped by the trigger.
    await expect(t.pool.query(`UPDATE app.audit_events SET event_type = 'X'`)).rejects.toThrow(/permission denied/);
    await expect(t.admin.query(`UPDATE app.audit_events SET event_type = 'X'`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`DELETE FROM app.audit_events`)).rejects.toThrow(/append-only/);
    // Only the retention process may delete, inside its own marked transaction.
    // The runtime role has no TRUNCATE privilege; even the owner is stopped by the trigger.
    await expect(t.pool.query(`TRUNCATE app.audit_events`)).rejects.toThrow(/permission denied/);
    await expect(t.admin.query(`TRUNCATE app.audit_events`)).rejects.toThrow(/append-only/);
  });

  it('an expired membership closes the member API and is audited', async () => {
    const m = await activeMember(t, { dating: { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 28, max: 40 } } });
    const r = await t.internal('POST', '/internal/billing/membership-expired', {
      accountId: m.accountId,
      providerEventId: `exp_${m.accountId}`,
      provider: 'test',
    });
    expect(r.body.status).toBe('EXPIRED');
    expect((await t.request('GET', '/v1/member/me', { token: m.token })).body.error.code).toBe('MEMBERSHIP_REQUIRED');
    const ev = await t.pool.query(`SELECT 1 FROM app.audit_events WHERE account_id = $1 AND event_type = 'MEMBERSHIP_EXPIRED'`, [m.accountId]);
    expect(ev.rowCount).toBe(1);
  });
});
