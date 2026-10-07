/**
 * The membership team's review desk (DEC-087) and invited membership
 * (DEC-088), through the real HTTP stack with signed internal requests:
 *   - the queue shows the minimum to recognise a person, never surname,
 *     phone numbers or answers; QA accounts only on request;
 *   - the detail view carries the private application, never a phone number,
 *     and every open is written to the access log;
 *   - an invited membership activates through the normal lifecycle, is marked
 *     complimentary, records no payment and does not renew; it is staging-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import type { ReviewDetail, ReviewQueueItem } from '../src/admission/reviewDesk';
import { applicantInFinalReview, review, seedPlan, signIn, stage1, testServer, type T } from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer(undefined, { SMS_TEST_NUMBERS: '+90555000*' });
});
afterAll(async () => t.close());

const QUEUE = '/internal/reviewer/applications';
const queue = async (query = '') => {
  const r = await t.internal<{ applications: ReviewQueueItem[] }>('GET', `${QUEUE}${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.applications;
};
const detail = (id: string, reviewerId = 'owner') => t.internal<ReviewDetail>('GET', `${QUEUE}/${id}?reviewerId=${reviewerId}`);
const invite = (id: string, body: unknown = { reviewerId: 'owner' }) => t.internal('POST', `${QUEUE}/${id}/invited-membership`, body);

async function received(firstName: string, phone?: string, over: Record<string, unknown> = {}) {
  const s = await signIn(t, phone);
  const a = await t.request('POST', '/v1/application', {
    token: s.token,
    headers: { 'Idempotency-Key': `s1-${s.accountId}` },
    body: stage1({ firstName, ...over }),
  });
  if (a.status !== 200) throw new Error(`stage1 ${a.status} ${JSON.stringify(a.body)}`);
  return { ...s, applicationId: a.body.id as string };
}

describe('the queue (review:read)', () => {
  it('lists submitted applications with first name, age and city only — and the actions open', async () => {
    const a = await received('Defne');
    const list = await queue();
    const mine = list.find((x) => x.id === a.applicationId)!;
    expect(mine).toEqual({
      id: a.applicationId,
      status: 'APPLICATION_RECEIVED',
      firstName: 'Defne',
      age: 32, // born 1994-03-14, clock 2026-10-05
      city: 'İstanbul',
      countryCode: 'TR',
      submittedAt: expect.any(String),
      updatedAt: expect.any(String),
      photoCount: 0,
      actions: ['START_REVIEW'],
      canStartInvitedMembership: false,
      qa: false,
    });
    const raw = JSON.stringify(list);
    for (const secret of ['Karaosmanoğlu', 'sebnem.private', 'Gökçe', '+90', '1994-03-14', a.phone]) expect(raw).not.toContain(secret);
  });

  it('QA accounts only with includeQa=true; status filter; oldest change first; strict query', async () => {
    const qa = await received('Kuzey', '+905550001234');
    const real = await received('Lale');
    expect((await queue()).map((x) => x.id)).not.toContain(qa.applicationId);
    const withQa = await queue('?includeQa=true');
    expect(withQa.find((x) => x.id === qa.applicationId)?.qa).toBe(true);
    await review(t, real.applicationId, { kind: 'START_REVIEW' });
    const under = await queue('?status=UNDER_REVIEW');
    expect(under.map((x) => x.status)).toEqual(under.map(() => 'UNDER_REVIEW'));
    expect(under.find((x) => x.id === real.applicationId)?.actions).toEqual(['REQUEST_EXTENDED', 'REQUEST_INFORMATION', 'WAITLIST', 'NOT_ADMIT']);
    const all = await queue('?includeQa=true&limit=200');
    expect(all.map((x) => x.updatedAt)).toEqual([...all.map((x) => x.updatedAt)].sort());
    const two = await queue('?status=UNDER_REVIEW,APPLICATION_RECEIVED&includeQa=true');
    expect(new Set(two.map((x) => x.status))).toEqual(new Set(['UNDER_REVIEW', 'APPLICATION_RECEIVED']));
    for (const bad of ['?status=APPLICATION_DRAFT', '?status=NOPE', '?status=UNDER_REVIEW,', '?status=UNDER_REVIEW,APPLICATION_SUBMITTED', '?limit=0', '?limit=201', '?includeQa=yes', '?phone=1']) {
      expect((await t.internal('GET', `${QUEUE}${bad}`)).status, bad).toBe(422);
    }
  });

  it('an account being deleted leaves the queue and the detail view', async () => {
    const a = await received('Nehir');
    expect((await t.request('POST', '/v1/me/deletion', { token: a.token, body: { confirm: true } })).status).toBe(200);
    expect((await queue('?includeQa=true&limit=200')).map((x) => x.id)).not.toContain(a.applicationId);
    expect((await detail(a.applicationId)).status).toBe(404);
  });

  it('needs review:read: the reviewer key (review:write only) and member sessions are refused', async () => {
    expect((await t.internal('GET', QUEUE, undefined, { keyId: 'reviewer' })).status).toBe(401);
    const a = await received('Ozan');
    expect((await t.request('GET', QUEUE, { token: a.token })).status).toBe(401);
    expect((await t.request('GET', `${QUEUE}/${a.applicationId}?reviewerId=x1`, { token: a.token })).status).toBe(401);
  });
});

describe('the detail view (review:read)', () => {
  it('carries the private application — never a phone number — and logs every open', async () => {
    const ap = await applicantInFinalReview(t, { firstName: 'Şebnem' });
    const r = await detail(ap.applicationId);
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.status).toBe('FINAL_REVIEW');
    expect(d.applicant).toEqual({
      firstName: 'Şebnem',
      lastName: 'Karaosmanoğlu-Büyükçekmeceli',
      dateOfBirth: '1994-03-14',
      age: 32,
      instagram: 'sebnem.private',
      countryCode: 'TR',
      city: 'İstanbul',
    });
    expect(d.referral).toEqual({ kind: 'requested', referrers: [{ name: 'Gökçe Işıklar', status: 'requested' }] });
    expect(d.extended).toMatchObject({
      occupation: 'Restoration architect',
      workContext: { kind: 'organisation', name: 'Atölye Kuzguncuk' },
      interests: ['Architecture', 'Swimming', 'Jazz'],
      intents: ['dating', 'community'],
      dating: { meet: ['everyone'], ageMin: 25, ageMax: 45 },
    });
    expect(d.extended?.aboutYou).toMatch(/^PRIVATE-ABOUT-YOU/);
    expect(d.media.map((m) => [m.id, m.purpose, m.position, m.retired])).toEqual(ap.photoIds.map((id, i) => [id, 'profile', i + 1, false]));
    // (The test clock is frozen, so both reviews carry the same instant; the order is by time.)
    expect(d.reviews.map((x) => [x.action, x.to, x.reviewerId]).sort()).toEqual([
      ['REQUEST_EXTENDED', 'EXTENDED_APPLICATION_REQUIRED', 'reviewer.one'],
      ['START_REVIEW', 'UNDER_REVIEW', 'reviewer.one'],
    ]);
    expect(d.actions).toEqual(['APPROVE', 'WAITLIST', 'REQUEST_INFORMATION', 'NOT_ADMIT']);
    expect(d.canStartInvitedMembership).toBe(false);
    expect(d.membership).toBeNull();
    const raw = JSON.stringify(d);
    expect(raw).not.toMatch(/\+90|5551112233/); // neither the applicant's nor the referrer's number
    expect(raw).not.toMatch(/storage_key|incoming\/|application\//); // ids only — no storage keys or urls

    await detail(ap.applicationId, 'owner');
    const log = await t.pool.query<{ principal: string; purpose: string }>(
      'SELECT principal, purpose FROM app.application_access_log WHERE application_id = $1 ORDER BY created_at',
      [ap.applicationId],
    );
    expect(log.rows).toEqual([
      { principal: 'ops:owner', purpose: 'REVIEW' },
      { principal: 'ops:owner', purpose: 'REVIEW' },
    ]);
    await expect(t.pool.query('UPDATE app.application_access_log SET purpose = purpose')).rejects.toThrow(/permission denied|append-only/);
    await expect(t.pool.query('DELETE FROM app.application_access_log')).rejects.toThrow(/append-only/);

    // Photos open one at a time through review:media (logged there).
    const media = await t.internal('POST', `${QUEUE}/${ap.applicationId}/media/${d.media[0]!.id}/access`, { reviewerId: 'owner', purpose: 'REVIEW' });
    expect(media.status).toBe(200);
    expect(media.body.expiresInSeconds).toBe(600);
  });

  it('needs a reviewer id; unknown applications are NOT_FOUND', async () => {
    const a = await received('Pelin');
    expect((await t.internal('GET', `${QUEUE}/${a.applicationId}`)).status).toBe(422);
    expect((await t.internal('GET', `${QUEUE}/${a.applicationId}?reviewerId=a`)).status).toBe(422);
    expect((await t.internal('GET', `${QUEUE}/${a.applicationId}?reviewerId=owner&x=1`)).status).toBe(422);
    expect((await detail('app_unknown')).status).toBe(404);
  });
});

describe('invited membership (membership:complimentary)', () => {
  it('APPROVED → ACTIVE_MEMBER: normal lifecycle, marked complimentary, no payment recorded, nothing renews', async () => {
    const ap = await applicantInFinalReview(t, { firstName: 'Irmak' });
    await seedPlan(t);
    expect((await invite(ap.applicationId)).status).toBe(403); // FINAL_REVIEW: decide first
    await review(t, ap.applicationId, { kind: 'APPROVE', reason: 'COMMUNITY_FIT' });
    expect((await queue()).find((x) => x.id === ap.applicationId)?.canStartInvitedMembership).toBe(true);

    const r = await invite(ap.applicationId);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ACTIVE_MEMBER');
    const m = (await t.admin.query('SELECT status, activation, granted_by, renews_at, ends_at FROM app.memberships WHERE account_id = $1', [ap.accountId])).rows[0];
    expect(m).toEqual({ status: 'active', activation: 'complimentary', granted_by: 'owner', renews_at: null, ends_at: null });
    expect((await t.admin.query('SELECT 1 FROM app.billing_events WHERE account_id = $1', [ap.accountId])).rowCount).toBe(0);
    const events = (
      await t.admin.query(
        `SELECT event_type, actor_type, actor_id, previous_status, new_status, metadata FROM app.audit_events
          WHERE application_id = $1 AND event_type LIKE 'MEMBERSHIP_%' ORDER BY created_at, event_type DESC`,
        [ap.applicationId],
      )
    ).rows;
    expect(events).toEqual([
      { event_type: 'MEMBERSHIP_ACTIVATION_STARTED', actor_type: 'reviewer', actor_id: 'owner', previous_status: 'APPROVED', new_status: 'MEMBERSHIP_PAYMENT_REQUIRED', metadata: { activation: 'complimentary' } },
      { event_type: 'MEMBERSHIP_ACTIVATED', actor_type: 'reviewer', actor_id: 'owner', previous_status: 'MEMBERSHIP_PAYMENT_REQUIRED', new_status: 'ACTIVE_MEMBER', metadata: { activation: 'complimentary' } },
    ]);

    // The member product opens; the member sees an invited membership — never who started it.
    const me = await t.request('GET', '/v1/member/me', { token: ap.token });
    expect(me.status).toBe(200);
    expect(me.body.membership).toEqual({ planId: 'plan_test', status: 'active', startedAt: expect.any(String), renewsAt: null, activation: 'complimentary' });
    const mine = await t.request('GET', '/v1/me/application', { token: ap.token });
    expect(mine.body.membership.activation).toBe('complimentary');
    expect(JSON.stringify([me.body, mine.body])).not.toMatch(/granted|"owner"/);

    // Repeating answers the current state, without a second activation.
    const again = await invite(ap.applicationId);
    expect([again.status, again.body.status]).toEqual([200, 'ACTIVE_MEMBER']);
    expect((await t.admin.query(`SELECT 1 FROM app.audit_events WHERE application_id = $1 AND event_type = 'MEMBERSHIP_ACTIVATED'`, [ap.applicationId])).rowCount).toBe(1);
    // Once the member asks for deletion, the desk no longer answers for them — not even the idempotent repeat.
    const after = await applicantInFinalReview(t, { firstName: 'İnci' });
    await review(t, after.applicationId, { kind: 'APPROVE' });
    expect((await invite(after.applicationId)).status).toBe(200);
    expect((await t.request('POST', '/v1/me/deletion', { token: after.token, body: { confirm: true } })).status).toBe(200);
    expect((await invite(after.applicationId)).status).toBe(404);
    // A billing confirmation cannot "activate" it again.
    const pay = await t.internal('POST', '/internal/billing/payment-confirmed', { accountId: ap.accountId, providerEventId: `evt_${ap.accountId}`, provider: 'test' });
    expect(pay.status).toBe(403);
  });

  it('also from MEMBERSHIP_PAYMENT_REQUIRED (the applicant already continued), keeping the plan they were shown', async () => {
    const ap = await applicantInFinalReview(t, { firstName: 'Ege' });
    await seedPlan(t);
    await review(t, ap.applicationId, { kind: 'APPROVE' });
    expect((await t.request('POST', '/v1/membership/begin', { token: ap.token })).status).toBe(200);
    const r = await invite(ap.applicationId, { reviewerId: 'owner.mert' });
    expect(r.body.status).toBe('ACTIVE_MEMBER');
    const m = (await t.admin.query('SELECT plan_id, activation, granted_by FROM app.memberships WHERE account_id = $1', [ap.accountId])).rows[0];
    expect(m).toEqual({ plan_id: 'plan_test', activation: 'complimentary', granted_by: 'owner.mert' });
    const started = await t.admin.query(`SELECT actor_type FROM app.audit_events WHERE application_id = $1 AND event_type = 'MEMBERSHIP_ACTIVATION_STARTED'`, [ap.applicationId]);
    expect(started.rows).toEqual([{ actor_type: 'applicant' }]);
  });

  it('refuses a suspended account, a missing plan, other states, bad input; a billed member stays billed', async () => {
    // Suspended.
    const s = await applicantInFinalReview(t, { firstName: 'Su' });
    await seedPlan(t);
    await review(t, s.applicationId, { kind: 'APPROVE' });
    expect((await t.internal('POST', `/internal/safety/accounts/${s.accountId}/suspend`, { actorId: 'safety.one', reasonCode: 'SAFETY' })).status).toBe(200);
    expect((await invite(s.applicationId)).status).toBe(403);
    // Not decided / not found / bad input.
    const r = await received('Toprak');
    expect((await invite(r.applicationId)).status).toBe(403);
    expect((await invite('app_unknown')).status).toBe(404);
    expect((await invite(r.applicationId, {})).status).toBe(422);
    expect((await invite(r.applicationId, { reviewerId: 'owner', note: 'x' })).status).toBe(422);
    // Without the scope.
    expect((await t.internal('POST', `${QUEUE}/${r.applicationId}/invited-membership`, { reviewerId: 'owner' }, { keyId: 'reviewer' })).status).toBe(401);
    // A member who paid is not turned into an invited one.
    const paid = await applicantInFinalReview(t, { firstName: 'Umut' });
    await review(t, paid.applicationId, { kind: 'APPROVE' });
    await t.request('POST', '/v1/membership/begin', { token: paid.token });
    await t.internal('POST', '/internal/billing/payment-confirmed', { accountId: paid.accountId, providerEventId: `evt_${paid.accountId}`, provider: 'test' });
    expect((await invite(paid.applicationId)).status).toBe(403);
    expect((await t.admin.query('SELECT activation FROM app.memberships WHERE account_id = $1', [paid.accountId])).rows[0]).toEqual({ activation: 'billing' });
  });

  it('needs a membership plan to exist (the staging release step creates one)', async () => {
    const t2 = await testServer();
    try {
      const ap = await applicantInFinalReview(t2, { firstName: 'Yaz' });
      await review(t2, ap.applicationId, { kind: 'APPROVE' });
      const r = await t2.internal('POST', `${QUEUE}/${ap.applicationId}/invited-membership`, { reviewerId: 'owner' });
      expect(r.status).toBe(403);
      expect((await t2.admin.query('SELECT status FROM app.membership_applications WHERE id = $1', [ap.applicationId])).rows[0]).toEqual({ status: 'APPROVED' });
    } finally {
      await t2.close();
    }
  });

  it('is staging-only: the scope is refused in production configuration', () => {
    const problems = (() => {
      try {
        loadConfig({
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://u@h/d',
          DATABASE_TLS: 'require',
          OTP_SECRET: 'p'.repeat(48),
          MEDIA_SIGNING_SECRET: 'm'.repeat(48),
          INTERNAL_KEYS_JSON: JSON.stringify({ reviewer: { secret: 'r'.repeat(48), scopes: ['review:read', 'review:write', 'membership:complimentary'] } }),
          PUBLIC_BASE_URL: 'https://api.example.com',
          S3_BUCKET: 'a',
          S3_VERIFICATION_BUCKET: 'b',
          SMS_PROVIDER: 'none',
        });
        return [];
      } catch (e) {
        return (e as { problems: string[] }).problems;
      }
    })();
    expect(problems).toContain('INTERNAL_KEYS_JSON: "reviewer" has a test-only scope, refused in production');
  });
});

describe('retention', () => {
  it('access-log rows leave only with the audit window (retention process) — and never while the account is under a hold', async () => {
    const t3 = await testServer(undefined, { RETENTION_AUDIT_DAYS: '400' });
    try {
      const free = await applicantInFinalReview(t3, { firstName: 'Zeren' });
      const held = await applicantInFinalReview(t3, { firstName: 'Ada' });
      for (const ap of [free, held]) {
        expect((await t3.internal('GET', `${QUEUE}/${ap.applicationId}?reviewerId=owner`)).status).toBe(200);
        const m = await t3.internal('POST', `${QUEUE}/${ap.applicationId}/media/${ap.photoIds[0]}/access`, { reviewerId: 'owner', purpose: 'REVIEW' });
        expect(m.status).toBe(200);
      }
      expect((await t3.internal('POST', `/internal/safety/accounts/${held.accountId}/holds`, { actorId: 'safety.one', reason: 'INVESTIGATION' })).status).toBe(200);
      const logs = async (ap: { applicationId: string; photoIds: string[] }) => [
        (await t3.admin.query('SELECT 1 FROM app.application_access_log WHERE application_id = $1', [ap.applicationId])).rowCount,
        (await t3.admin.query('SELECT 1 FROM app.media_access_log WHERE media_id = $1', [ap.photoIds[0]])).rowCount,
      ];
      expect((await t3.internal('POST', '/internal/retention/run', { dryRun: true })).body.auditRecordsPurged).toBe(0);
      t3.clock.advanceDays(401);
      expect((await t3.internal('POST', '/internal/retention/run', { dryRun: true })).body.auditRecordsPurged).toBeGreaterThanOrEqual(2);
      expect(await logs(free)).toEqual([1, 1]);
      await t3.internal('POST', '/internal/retention/run');
      expect(await logs(free)).toEqual([0, 0]);
      expect(await logs(held)).toEqual([1, 1]); // under a hold: kept
    } finally {
      await t3.close();
    }
  });
});
