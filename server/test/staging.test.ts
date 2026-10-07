/**
 * Staging tooling (DEC-076): the review fixture moves only QA applications,
 * through the normal transitions and audit; QA accounts and other members
 * never meet in introductions; the retention dry run changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatingSettingsInput } from '@/domain/member/dating';
import { activeMember, jpegBytesWithExif, seedPlan, signIn, stage1, testServer, upload, type T } from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer(undefined, { SMS_TEST_NUMBERS: '+90555000*' });
});
afterAll(async () => t.close());

let qaSeq = 0;
const qaPhone = () => `+90555000${String(1000 + qaSeq++).padStart(4, '0')}`;
const fixture = (applicationId: string, action: string, keyId?: string) =>
  t.internal('POST', `/internal/test/applications/${applicationId}/review`, { action }, keyId ? { keyId } : {});

describe('staging review fixture', () => {
  it('moves a QA application RECEIVED → UNDER_REVIEW → EXTENDED → (applicant Stage 2) FINAL_REVIEW → APPROVED → ACTIVE_MEMBER, audited like a reviewer', async () => {
    const s = await signIn(t, qaPhone());
    expect((await t.pool.query('SELECT qa_account FROM app.accounts WHERE id = $1', [s.accountId])).rows[0].qa_account).toBe(true);
    const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': `q-${s.accountId}` }, body: stage1() });
    expect(a.body.status).toBe('APPLICATION_RECEIVED');
    expect((await fixture(a.body.id, 'START_REVIEW')).body.status).toBe('UNDER_REVIEW');
    // Normal transition validation: no approval straight from review.
    expect((await fixture(a.body.id, 'APPROVE')).body.error.code).toBe('NOT_ALLOWED');
    expect((await fixture(a.body.id, 'REQUEST_EXTENDED')).body.status).toBe('EXTENDED_APPLICATION_REQUIRED');

    // The applicant's own step, through the public API with real uploads.
    await t.request('POST', '/v1/application/extended/start', { token: s.token });
    const photoIds: string[] = [];
    for (let i = 0; i < 3; i++) photoIds.push((await upload(t, s.token, await jpegBytesWithExif(i))).body.mediaId);
    const s2 = await t.request('POST', '/v1/application/extended', {
      token: s.token,
      headers: { 'Idempotency-Key': `q2-${s.accountId}` },
      body: {
        photoIds,
        occupation: 'Ceramicist',
        workContext: { kind: 'independent' },
        whatYouDo: 'Wood-fired stoneware from a small studio in Kuzguncuk.',
        aboutYou: 'Morning swims, late dinners, long walks along the water.',
        interests: ['Ceramics', 'Swimming', 'Jazz'],
        intents: ['community'],
        datingPreferences: null,
      },
    });
    expect(s2.body).toMatchObject({ status: 'FINAL_REVIEW' });
    expect((await fixture(a.body.id, 'APPROVE')).body.status).toBe('APPROVED');
    await seedPlan(t);
    expect((await t.request('POST', '/v1/membership/begin', { token: s.token })).body.application.status).toBe('MEMBERSHIP_PAYMENT_REQUIRED');
    expect((await fixture(a.body.id, 'ACTIVATE')).body.status).toBe('ACTIVE_MEMBER');
    expect((await fixture(a.body.id, 'ACTIVATE')).body.status).toBe('ACTIVE_MEMBER'); // idempotent
    expect((await t.request('GET', '/v1/member/me', { token: s.token })).status).toBe(200);

    const { rows: reviews } = await t.pool.query(`SELECT reviewer_id, action FROM app.application_reviews WHERE application_id = $1 ORDER BY created_at`, [a.body.id]);
    expect(reviews.map((r) => r.action)).toEqual(['START_REVIEW', 'REQUEST_EXTENDED', 'APPROVE']);
    expect(new Set(reviews.map((r) => r.reviewer_id))).toEqual(new Set(['staging-fixture.ops']));
    const { rows: events } = await t.pool.query(`SELECT event_type, actor_type, actor_id FROM app.audit_events WHERE application_id = $1 ORDER BY created_at`, [a.body.id]);
    expect(events.filter((e) => e.actor_type === 'reviewer').every((e) => e.actor_id === 'staging-fixture.ops')).toBe(true);
    expect(events.map((e) => e.event_type)).toContain('MEMBERSHIP_ACTIVATED');
  });

  it('never acts on a real (non-QA) application, and does not reveal that it exists', async () => {
    const real = await signIn(t); // not a test number
    const a = await t.request('POST', '/v1/application', { token: real.token, headers: { 'Idempotency-Key': `r-${real.accountId}` }, body: stage1() });
    const r = await fixture(a.body.id, 'START_REVIEW');
    expect(r.status).toBe(404);
    expect((await fixture('app_does_not_exist', 'START_REVIEW')).status).toBe(404);
    expect((await t.request('GET', '/v1/me/application', { token: real.token })).body.application.status).toBe('APPLICATION_RECEIVED');
  });

  it('requires the test:review scope and a known action', async () => {
    const s = await signIn(t, qaPhone());
    const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': `k-${s.accountId}` }, body: stage1() });
    expect((await fixture(a.body.id, 'START_REVIEW', 'reviewer')).status).toBe(401);
    expect((await fixture(a.body.id, 'REOPEN')).body.error.code).toBe('VALIDATION_FAILED');
    expect((await t.request('POST', `/internal/test/applications/${a.body.id}/review`, { token: s.token, body: { action: 'START_REVIEW' } })).status).toBe(401);
  });

  it('the QA flag never appears in any applicant or member response', async () => {
    const s = await signIn(t, qaPhone());
    const app = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': `f-${s.accountId}` }, body: stage1() });
    const me = await t.request('GET', '/v1/me/application', { token: s.token });
    expect(JSON.stringify([app.body, me.body])).not.toMatch(/qa_account|qaAccount|"qa"/i);
  });
});

describe('QA accounts and other members never meet', () => {
  const W: DatingSettingsInput = { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 25, max: 45 } };
  const M: DatingSettingsInput = { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 25, max: 45 } };

  it('a QA member is introduced only to QA members; a human tester only to non-QA members', async () => {
    const qaWoman = await activeMember(t, { phone: qaPhone(), firstName: 'Ece', dating: W });
    const qaMan = await activeMember(t, { phone: qaPhone(), firstName: 'Baran', dateOfBirth: '1991-05-02', dating: M });
    const human = await activeMember(t, { firstName: 'Kerem', dateOfBirth: '1990-07-12', dating: M });
    const humanWoman = await activeMember(t, { firstName: 'Lale', dating: W });
    const seen = async (token: string) =>
      ((await t.request('GET', '/v1/introductions/today', { token })).body.waiting as { member: { memberId: string } }[]).map((w) => w.member.memberId);
    const qaSees = await seen(qaWoman.token);
    expect(qaSees).toContain(qaMan.memberId);
    expect(qaSees).not.toContain(human.memberId);
    const humanSees = await seen(humanWoman.token);
    expect(humanSees).toContain(human.memberId);
    expect(humanSees).not.toContain(qaMan.memberId);
  });
});

describe('retention dry run', () => {
  it('reports the configured windows and what a run would do, and changes nothing', async () => {
    const n = await testServer(undefined, { RETENTION_AUTH_RECORDS_DAYS: '1' });
    try {
      const a = await signIn(n);
      const b = await signIn(n);
      await n.request('POST', '/v1/me/deletion', { token: b.token, body: { confirm: true } });
      await n.request('POST', '/v1/auth/sign-out', { token: a.token });
      n.clock.advanceDays(3);
      const before = await n.admin.query(`SELECT (SELECT count(*) FROM app.sessions)::int AS s, (SELECT count(*) FROM app.otp_challenges)::int AS o`);
      const dry = await n.internal('POST', '/internal/retention/run', { dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ dryRun: true, accountsAnonymized: 1, accountsHeld: 0 });
      expect(dry.body.windows).toMatchObject({ authRecordsDays: 1, removedProfileMediaDays: null, safetyRecordsDays: null, auditRecordsDays: null });
      expect(dry.body.authRecordsPurged).toBeGreaterThan(0);
      const after = await n.admin.query(`SELECT (SELECT count(*) FROM app.sessions)::int AS s, (SELECT count(*) FROM app.otp_challenges)::int AS o`);
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect((await n.admin.query(`SELECT account_status FROM app.accounts WHERE id = $1`, [b.accountId])).rows[0].account_status).toBe('deletion_requested');
      // The real run does what the dry run said.
      const real = await n.internal('POST', '/internal/retention/run', {});
      expect(real.body).toMatchObject({ dryRun: false, accountsAnonymized: 1 });
      // Each step is counted against today's state: rows an earlier step removes (the anonymized account's
      // sessions) may also be counted by a later window, so the dry run is an upper bound.
      expect(real.body.authRecordsPurged).toBeGreaterThan(0);
      expect(real.body.authRecordsPurged).toBeLessThanOrEqual(dry.body.authRecordsPurged);
      expect((await n.internal('POST', '/internal/retention/run', { dryRun: 'yes' })).body.error.code).toBe('VALIDATION_FAILED');
    } finally {
      await n.close();
    }
  });
});

describe('project-owned SIMs as QA accounts (DEC-083)', () => {
  it('a listed SIM receives its code by the real provider, and its account is an isolated QA account the fixture may move', async () => {
    const sim = '+905321110000';
    const s2 = await testServer(undefined, { SMS_TEST_NUMBERS: '+90555000*', SMS_QA_REAL_NUMBERS: sim });
    try {
      const s = await signIn(s2, sim); // the code came through the provider (captured here), not the test outbox
      const outbox = await s2.admin.query('SELECT count(*)::int AS n FROM app.sms_test_outbox WHERE phone_e164 = $1', [sim]);
      expect(outbox.rows[0].n).toBe(0);
      expect((await s2.pool.query('SELECT qa_account FROM app.accounts WHERE id = $1', [s.accountId])).rows[0].qa_account).toBe(true);
      const before = await s2.internal('POST', '/internal/test/applications/lookup', { phoneE164: sim });
      expect(before.body).toEqual({ applicationId: null, status: null });
      const a = await s2.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': `sim-${s.accountId}` }, body: stage1() });
      expect((await s2.internal('POST', '/internal/test/applications/lookup', { phoneE164: sim })).body).toEqual({ applicationId: a.body.id, status: 'APPLICATION_RECEIVED' });
      const moved = await s2.internal('POST', `/internal/test/applications/${a.body.id}/review`, { action: 'START_REVIEW' });
      expect(moved.body.status).toBe('UNDER_REVIEW');
      // Any other real number stays a normal account the fixture cannot see.
      const other = await signIn(s2, '+905321110001');
      const b = await s2.request('POST', '/v1/application', { token: other.token, headers: { 'Idempotency-Key': `o-${other.accountId}` }, body: stage1() });
      expect((await s2.internal('POST', `/internal/test/applications/${b.body.id}/review`, { action: 'START_REVIEW' })).status).toBe(404);
      expect((await s2.internal('POST', '/internal/test/applications/lookup', { phoneE164: '+905321110001' })).status).toBe(404);
      expect((await s2.internal('POST', '/internal/test/applications/lookup', { phoneE164: 'not a number' })).status).toBe(422);
    } finally {
      await s2.close();
    }
  });

  it('the list is refused in production, must be exact numbers, and must not overlap the test numbers', async () => {
    const { ConfigError, loadConfig } = await import('../src/config');
    const problems = (env: Record<string, string>) => {
      try {
        loadConfig({ APP_ENV: 'development', DATABASE_URL: 'postgres://u@h/d', ...env });
        return [];
      } catch (e) {
        return (e as InstanceType<typeof ConfigError>).problems;
      }
    };
    expect(problems({ SMS_QA_REAL_NUMBERS: '+90532*' })).toContain('SMS_QA_REAL_NUMBERS entries must be exact E.164 numbers (no prefixes)');
    expect(problems({ SMS_TEST_NUMBERS: '+90532*', SMS_QA_REAL_NUMBERS: '+905321110000' })).toContain(
      'SMS_QA_REAL_NUMBERS must not overlap SMS_TEST_NUMBERS (those never reach a phone)',
    );
    expect(problems({ APP_ENV: 'production', SMS_QA_REAL_NUMBERS: '+905321110000' })).toContain('SMS_QA_REAL_NUMBERS is a staging QA hook and is refused in production');
  });
});
