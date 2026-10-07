/**
 * Account lifecycle and session security (DEC-066, DEC-067):
 * deletion request → anonymization by the retention process, retention holds,
 * suspension, sign-out everywhere, rotation with reuse detection, idle and
 * absolute expiry.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatingSettingsInput } from '@/domain/member/dating';
import { FORMER_MEMBER_NAME } from '../src/retention/processor';
import { activeMember, applicantInFinalReview, signIn, testServer, type T } from './harness';

let t: T;
beforeEach(async () => {
  t = await testServer();
});
afterEach(async () => t.close());

const W: DatingSettingsInput = { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 25, max: 45 } };
const M: DatingSettingsInput = { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 25, max: 45 } };

/** Past the 30-second resend cooldown for a number. */
const cooldown = () => t.clock.set(new Date(t.clock.now().getTime() + 31_000).toISOString());

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

async function matchedPair() {
  const w = await activeMember(t, { firstName: 'Selin', dating: W });
  const m = await activeMember(t, { firstName: 'Mert', dateOfBirth: '1992-02-11', dating: M });
  const mi = (await t.request('GET', '/v1/introductions/today', { token: m.token })).body.waiting[0].introductionId;
  const wi = (await t.request('GET', '/v1/introductions/today', { token: w.token })).body.waiting[0].introductionId;
  await t.request('POST', `/v1/introductions/${mi}/reaction`, { token: m.token, body: { type: 'LIKE' } });
  const r = await t.request('POST', `/v1/introductions/${wi}/reaction`, { token: w.token, body: { type: 'LIKE' } });
  const conv = await t.request('POST', `/v1/matches/${r.body.match.matchId}/conversation`, { token: w.token });
  await t.request('POST', `/v1/conversations/${conv.body.conversationId}/messages`, { token: m.token, body: { body: 'Merhaba', clientMessageId: 'c1' } });
  return { w, m, matchId: r.body.match.matchId as string, conversationId: conv.body.conversationId as string };
}

describe('account deletion request', () => {
  it('takes effect at once: signed out everywhere, out of discovery, matches ended, no new messages, membership cancelled', async () => {
    const { w, m, matchId, conversationId } = await matchedPair();
    cooldown();
    const second = await signIn(t, m.phone); // a second device
    expect((await t.request('POST', '/v1/me/deletion', { token: m.token, body: {} })).body.error.fields).toEqual(['confirm']);
    const del = await t.request('POST', '/v1/me/deletion', { token: m.token, body: { confirm: true } });
    expect(del.body).toEqual({ deletionRequested: true });
    for (const token of [m.token, second.token]) expect((await t.request('GET', '/v1/me/application', { token })).status).toBe(401);
    // Signing in again is refused (after proof of possession).
    cooldown();
    const otp = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: m.phone } });
    const v = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code: t.sms.last(m.phone) } });
    expect(v.body.error.code).toBe('NOT_ALLOWED');
    // For the other member: gone from conversations, profile, match; messaging impossible.
    expect((await t.request('GET', '/v1/conversations', { token: w.token })).body).toEqual([]);
    expect((await t.request('GET', `/v1/members/${m.memberId}`, { token: w.token })).body.error.code).toBe('NOT_AVAILABLE');
    expect((await t.request('GET', `/v1/matches/${matchId}`, { token: w.token })).body.error.code).toBe('MATCH_NOT_FOUND');
    expect(
      (await t.request('POST', `/v1/conversations/${conversationId}/messages`, { token: w.token, body: { body: 'Hello?', clientMessageId: 'c2' } })).body.error.code,
    ).toBe('CONVERSATION_FORBIDDEN');
    const match = (await t.pool.query('SELECT status, ended_reason FROM app.matches WHERE id = $1', [matchId])).rows[0];
    expect(match).toEqual({ status: 'ENDED', ended_reason: 'ACCOUNT_DELETED' });
    expect((await t.pool.query('SELECT status FROM app.memberships WHERE account_id = $1', [m.accountId])).rows[0].status).toBe('cancelled');
    // Tomorrow, she is not introduced to him.
    t.clock.advanceDays(1);
    const intros = (await t.request('GET', '/v1/introductions/today', { token: w.token })).body.waiting;
    expect(intros.map((x: { member: { memberId: string } }) => x.member.memberId)).not.toContain(m.memberId);
    // Idempotent; audited.
    const ev = await t.pool.query(`SELECT event_type, actor_type FROM app.audit_events WHERE account_id = $1 AND event_type = 'ACCOUNT_DELETION_REQUESTED'`, [m.accountId]);
    expect(ev.rows).toEqual([{ event_type: 'ACCOUNT_DELETION_REQUESTED', actor_type: 'member' }]);
  });

  it('the retention process anonymizes: private data and media deleted, safety records kept without identity, the number free again', async () => {
    const { w, m, conversationId } = await matchedPair();
    await t.request('POST', `/v1/members/${w.memberId}/reports`, { token: m.token, body: { reason: 'OTHER', context: 'conversation', conversationId } });
    await t.request('POST', `/v1/members/${m.memberId}/block`, { token: w.token });
    const appId = (await t.pool.query('SELECT id FROM app.membership_applications WHERE account_id = $1', [m.accountId])).rows[0].id;
    const objectsBefore = filesUnder(t.mediaDir).length;
    await t.request('POST', '/v1/me/deletion', { token: m.token, body: { confirm: true } });
    const run = await t.internal('POST', '/internal/retention/run');
    expect(run.body).toMatchObject({ accountsAnonymized: 1, accountsHeld: 0 });
    const acc = (await t.pool.query('SELECT phone_e164, account_status, anonymized_at FROM app.accounts WHERE id = $1', [m.accountId])).rows[0];
    expect(acc).toMatchObject({ phone_e164: null, account_status: 'anonymized' });
    for (const table of ['application_private_data', 'application_referrals', 'application_dating_preferences']) {
      expect((await t.pool.query(`SELECT count(*)::int AS n FROM app.${table} WHERE application_id = $1`, [appId])).rows[0].n, table).toBe(0);
    }
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.dating_settings WHERE member_id = $1', [m.memberId])).rows[0].n).toBe(0);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.sessions WHERE account_id = $1', [m.accountId])).rows[0].n).toBe(0);
    const profile = (await t.pool.query('SELECT display_name, occupation, interests, intents, visibility, deleted_at FROM app.member_profiles WHERE id = $1', [m.memberId])).rows[0];
    expect(profile).toMatchObject({ display_name: FORMER_MEMBER_NAME, occupation: null, interests: [], intents: [], visibility: 'hidden' });
    // Media objects are gone (his 3 application + 3 member copies); hers remain.
    expect(filesUnder(t.mediaDir).length).toBe(objectsBefore - 6);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.application_media WHERE application_id = $1 AND purged_at IS NULL', [appId])).rows[0].n).toBe(0);
    // Safety records and the audit trail remain — pointing only at opaque ids.
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.messages WHERE sender_id = $1', [m.memberId])).rows[0].n).toBe(1);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.reports WHERE reporter_id = $1', [m.memberId])).rows[0].n).toBe(1);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.blocks WHERE blocked_id = $1', [m.memberId])).rows[0].n).toBe(1);
    // Her blocked list shows a placeholder, never his former name.
    expect((await t.request('GET', '/v1/member/me/blocked', { token: w.token })).body).toEqual([expect.objectContaining({ displayName: FORMER_MEMBER_NAME })]);
    const ev = await t.pool.query(`SELECT 1 FROM app.audit_events WHERE account_id = $1 AND event_type = 'ACCOUNT_ANONYMIZED'`, [m.accountId]);
    expect(ev.rowCount).toBe(1);
    // The number is free: signing in creates a NEW account with no history.
    cooldown();
    const again = await signIn(t, m.phone);
    expect(again.accountId).not.toBe(m.accountId);
    expect((await t.request('GET', '/v1/me/application', { token: again.token })).body.application).toBeNull();
    // A second run is a no-op.
    expect((await t.internal('POST', '/internal/retention/run')).body.accountsAnonymized).toBe(0);
  });

  it('a payment confirmation never activates an account being deleted; a hold on an anonymized account is refused', async () => {
    const ap = await applicantInFinalReview(t);
    await t.admin.query(
      `INSERT INTO app.membership_plans (id, name, billing_period, price_minor, currency, is_development_fixture) VALUES ('plan_t', 'M', 'monthly', 1, 'TRY', true) ON CONFLICT DO NOTHING`,
    );
    await t.internal('POST', `/internal/reviewer/applications/${ap.applicationId}/actions`, { reviewerId: 'r.one', action: { kind: 'APPROVE', reason: 'COMMUNITY_FIT' } });
    await t.request('POST', '/v1/membership/begin', { token: ap.token });
    await t.request('POST', '/v1/me/deletion', { token: ap.token, body: { confirm: true } });
    const pay = await t.internal('POST', '/internal/billing/payment-confirmed', { accountId: ap.accountId, providerEventId: `late_${ap.accountId}`, provider: 'test' });
    expect(pay.body.error.code).toBe('NOT_ALLOWED');
    expect((await t.pool.query('SELECT status FROM app.memberships WHERE account_id = $1', [ap.accountId])).rows[0].status).toBe('cancelled');
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.member_profiles WHERE account_id = $1', [ap.accountId])).rows[0].n).toBe(0);
    await t.internal('POST', '/internal/retention/run');
    const hold = await t.internal('POST', `/internal/safety/accounts/${ap.accountId}/holds`, { actorId: 'safety.one', reason: 'LEGAL_REQUEST' });
    expect(hold.body.error.code).toBe('NOT_ALLOWED');
  });

  it('an applicant can delete too; a retention hold defers anonymization until released', async () => {
    const ap = await applicantInFinalReview(t);
    const hold = await t.internal('POST', `/internal/safety/accounts/${ap.accountId}/holds`, { actorId: 'safety.one', reason: 'SAFETY_REPORT' });
    expect(hold.status).toBe(200);
    await t.request('POST', '/v1/me/deletion', { token: ap.token, body: { confirm: true } });
    expect((await t.internal('POST', '/internal/retention/run')).body).toMatchObject({ accountsAnonymized: 0, accountsHeld: 1 });
    expect((await t.pool.query('SELECT account_status FROM app.accounts WHERE id = $1', [ap.accountId])).rows[0].account_status).toBe('deletion_requested');
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.application_private_data WHERE application_id = $1', [ap.applicationId])).rows[0].n).toBe(1);
    await t.internal('POST', `/internal/safety/holds/${hold.body.holdId}/release`, { actorId: 'safety.one' });
    expect((await t.internal('POST', '/internal/retention/run')).body.accountsAnonymized).toBe(1);
  });

  it('honours a configured grace window before anonymizing', async () => {
    await t.close();
    t = await testServer(undefined, { ACCOUNT_DELETION_GRACE_HOURS: '48' });
    const s = await signIn(t);
    await t.request('POST', '/v1/me/deletion', { token: s.token, body: { confirm: true } });
    expect((await t.internal('POST', '/internal/retention/run')).body.accountsAnonymized).toBe(0);
    t.clock.advanceDays(2.1);
    expect((await t.internal('POST', '/internal/retention/run')).body.accountsAnonymized).toBe(1);
  });
});

describe('suspension', () => {
  it('revokes every session, refuses sign-in and hides the member; reinstatement restores access', async () => {
    const { w, m } = await matchedPair();
    const bad = await t.internal('POST', `/internal/safety/accounts/${m.accountId}/suspend`, { actorId: 'safety.one', reasonCode: 'NOPE' });
    expect(bad.body.error.fields).toEqual(['reasonCode']);
    const s = await t.internal('POST', `/internal/safety/accounts/${m.accountId}/suspend`, { actorId: 'safety.one', reasonCode: 'SAFETY' });
    expect(s.body).toEqual({ accountStatus: 'suspended', sessionsRevoked: 1 });
    expect((await t.request('GET', '/v1/member/me', { token: m.token })).status).toBe(401);
    cooldown();
    const otp = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: m.phone } });
    expect(otp.status).toBe(200); // no enumeration: the same answer for every number
    const v = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code: t.sms.last(m.phone) } });
    expect(v.body.error.code).toBe('NOT_ALLOWED');
    expect((await t.request('GET', '/v1/conversations', { token: w.token })).body).toEqual([]);
    expect((await t.request('GET', `/v1/members/${m.memberId}`, { token: w.token })).body.error.code).toBe('NOT_AVAILABLE');
    await t.internal('POST', `/internal/safety/accounts/${m.accountId}/reinstate`, { actorId: 'safety.one' });
    cooldown();
    const back = await signIn(t, m.phone);
    expect((await t.request('GET', '/v1/member/me', { token: back.token })).status).toBe(200);
    expect((await t.request('GET', '/v1/conversations', { token: w.token })).body).toHaveLength(1);
    const events = (await t.pool.query(`SELECT event_type, actor_id FROM app.audit_events WHERE account_id = $1 AND event_type LIKE 'ACCOUNT_%' ORDER BY created_at, event_type`, [m.accountId])).rows;
    expect(events).toEqual([
      { event_type: 'ACCOUNT_SUSPENDED', actor_id: 'ops:safety.one' },
      { event_type: 'ACCOUNT_REINSTATED', actor_id: 'ops:safety.one' },
    ]);
  });
});

describe('sessions', () => {
  it('sign out everywhere revokes every device', async () => {
    const a = await signIn(t);
    cooldown();
    const b = await signIn(t, a.phone);
    const r = await t.request('POST', '/v1/auth/sign-out-all', { token: a.token });
    expect(r.body).toEqual({ signedOut: true, sessions: 2 });
    for (const token of [a.token, b.token]) expect((await t.request('GET', '/v1/me/application', { token })).status).toBe(401);
    const reasons = (await t.pool.query('SELECT DISTINCT revoked_reason FROM app.sessions WHERE account_id = $1', [a.accountId])).rows;
    expect(reasons).toEqual([{ revoked_reason: 'SIGN_OUT_ALL' }]);
  });

  it('rotation issues a new token once; presenting the old token again revokes the whole family', async () => {
    const a = await signIn(t);
    cooldown();
    const other = await signIn(t, a.phone); // another device: a different family
    const r = await t.request('POST', '/v1/auth/session/rotate', { token: a.token });
    expect(r.status).toBe(200);
    const fresh = r.body.token as string;
    expect(fresh).not.toBe(a.token);
    // Rotation never extends a session's absolute life.
    const expiries = (await t.pool.query('SELECT DISTINCT expires_at FROM app.sessions WHERE family_id = (SELECT family_id FROM app.sessions WHERE account_id = $1 ORDER BY created_at LIMIT 1)', [a.accountId])).rows;
    expect(expiries).toHaveLength(1);
    expect((await t.request('GET', '/v1/me/application', { token: fresh })).status).toBe(200);
    expect((await t.request('GET', '/v1/me/application', { token: a.token })).status).toBe(401); // reuse!
    expect((await t.request('GET', '/v1/me/application', { token: fresh })).status).toBe(401); // the family is revoked
    expect((await t.request('GET', '/v1/me/application', { token: other.token })).status).toBe(200); // other devices are not
    const rows = (await t.pool.query('SELECT revoked_reason FROM app.sessions WHERE account_id = $1 ORDER BY created_at', [a.accountId])).rows.map((x) => x.revoked_reason);
    expect(rows.sort()).toEqual(['REUSE_DETECTED', 'ROTATED', null].sort());
  });

  it('expire when idle (30 days) and absolutely (60 days), even when used', async () => {
    const a = await signIn(t);
    t.clock.advanceDays(29);
    expect((await t.request('GET', '/v1/me/application', { token: a.token })).status).toBe(200);
    t.clock.advanceDays(29);
    expect((await t.request('GET', '/v1/me/application', { token: a.token })).status).toBe(200);
    t.clock.advanceDays(3); // 61 days old, used 3 days ago
    expect((await t.request('GET', '/v1/me/application', { token: a.token })).status).toBe(401);
    const b = await signIn(t);
    t.clock.advanceDays(31);
    expect((await t.request('GET', '/v1/me/application', { token: b.token })).status).toBe(401);
    const reasons = (await t.pool.query(`SELECT revoked_reason FROM app.sessions WHERE account_id IN ($1, $2)`, [a.accountId, b.accountId])).rows;
    expect(reasons.every((r) => r.revoked_reason === 'EXPIRED')).toBe(true);
  });

  it('only hashes are stored; tokens are never logged', async () => {
    const a = await signIn(t);
    const rows = (await t.pool.query('SELECT token_hash, family_id FROM app.sessions WHERE account_id = $1', [a.accountId])).rows;
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(a.token);
    expect(t.logLines.join('\n')).not.toContain(a.token);
  });
});
