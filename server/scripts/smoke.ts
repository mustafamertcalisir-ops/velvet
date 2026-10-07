/**
 * Staging smoke flow (docs/STAGING.md §5) — black-box, over HTTP, against a
 * deployed staging API (or the local staging-shaped rehearsal). It creates
 * ISOLATED QA ACCOUNTS on designated test numbers, drives them through the
 * real endpoints, and asks for their deletion at the end. It never touches
 * real applicants: the review fixture it uses acts on QA accounts only.
 *
 * It cannot run against production: it needs the test-only scopes
 * `test:otp` and `test:review` (refused in production configuration, routes
 * absent there) and refuses to start unless STAGING_ENVIRONMENT=staging.
 * Environment: see scripts/lib/staging.ts.
 *
 * Prerequisite: an active membership plan in the staging database
 * (docs/STAGING.md §4).
 */
import { recorder, stagingClient, stagingEnv, type Person } from './lib/staging';

async function main() {
  const e = stagingEnv();
  const c = stagingClient(e);
  const r = recorder('smoke');
  const { call, internal } = c;
  const people: Person[] = [];
  await c.preflight(); // staging-only route, staging-bound signature: stops here against anything else
  try {
    // 1. Health
    const live = await call('GET', '/health/live');
    const ready = await call('GET', '/health/ready');
    r.check('health: live', live.status === 200 && live.body.status === 'ok');
    r.check('health: ready (database, migrations, storage)', ready.status === 200 && ready.body.status === 'ready', JSON.stringify(ready.body));
    r.check('health: no private data', Object.keys(ready.body ?? {}).sort().join() === 'checks,status');

    // 2–3. OTP boundary and authentication
    r.check('otp: malformed number refused', (await call('POST', '/v1/auth/otp', { body: { phoneE164: '05321234567' } })).body?.error?.code === 'INVALID_PHONE');
    const phone = c.testPhone();
    const otp = await call('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
    r.check('otp: code issued for a test number', otp.status === 200 && Object.keys(otp.body).sort().join() === 'challengeId,expiresAt,phoneE164,resendAvailableAt');
    const wrong = await call('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code: '000000' } });
    r.check('otp: wrong code refused', ['INVALID_CODE'].includes(wrong.body?.error?.code));
    const code = await internal('/internal/test/otp', { phoneE164: phone });
    r.check('otp: test outbox readable with the staging key only once', code.status === 200 && (await internal('/internal/test/otp', { phoneE164: phone })).status === 404);
    const v = await call('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code: code.body.code } });
    r.check('auth: verified → session', v.status === 200 && typeof v.body.session?.token === 'string');
    r.check('auth: no session → 401', (await call('GET', '/v1/me/application')).status === 401);
    r.check('auth: session → own application', (await call('GET', '/v1/me/application', { token: v.body.session.token })).status === 200);
    await call('POST', '/v1/me/deletion', { token: v.body.session.token, body: { confirm: true } });

    // 4–7. Applications, review transitions (QA fixture), membership guard, media
    const z = await c.applicant({ name: 'Zeynep', dob: '1993-05-02', intents: ['friendship', 'community'] });
    people.push(z);
    r.check('application: Stage 1 + Stage 2 → FINAL_REVIEW', (await call('GET', '/v1/me/application', { token: z.token })).body.application?.status === 'FINAL_REVIEW');
    r.check('membership guard: applicant refused member endpoints', (await call('GET', '/v1/introductions/today', { token: z.token })).body?.error?.code === 'MEMBERSHIP_REQUIRED');
    const wrongClass = await call('POST', '/v1/media/uploads', { token: z.token, body: { mediaClass: 'PROFILE_MEDIA', contentType: 'image/jpeg', byteLength: 1000 } });
    r.check('media: upload authorization enforces the class (applicant ≠ profile media)', wrongClass.body?.error?.code === 'MEMBERSHIP_REQUIRED');
    r.check('media: no upload without a session', (await call('POST', '/v1/media/uploads', { body: { mediaClass: 'APPLICATION_MEDIA', contentType: 'image/jpeg', byteLength: 10 } })).status === 401);

    // 8–9. Two members: Dating compatibility and introductions
    const age = 30 + Math.floor(Math.random() * 9); // QA age bands keep tools from meeting each other: smoke 30–39 (docs/STAGING.md §4)
    const range = { min: age, max: age + 1 };
    const dob = c.dobForAge(age);
    const a = await c.member({ name: 'Selin', dob, intents: ['dating', 'community'], meet: ['men'], ageRange: range, dating: { gender: 'WOMAN', seeking: ['MAN'], ageRange: range } });
    people.push(a);
    const b = await c.member({ name: 'Mert', dob: c.dobForAge(age), intents: ['dating', 'community'], meet: ['women'], ageRange: range, dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: range } });
    people.push(b);
    r.check('members: activated through the staging fixture (normal payment-confirmed path)', Boolean(a.memberId && b.memberId));
    const ia = await call('GET', '/v1/introductions/today', { token: a.token });
    const ib = await call('GET', '/v1/introductions/today', { token: b.token });
    const toB = ia.body.waiting?.find((w: { member: { memberId: string } }) => w.member.memberId === b.memberId);
    const toA = ib.body.waiting?.find((w: { member: { memberId: string } }) => w.member.memberId === a.memberId);
    r.check('dating: compatible members are introduced to each other', Boolean(toA && toB), `${ia.body.state}/${ib.body.state}`);

    // 10. Public/private DTO isolation
    const seen = JSON.stringify([toA, await call('GET', `/v1/members/${a.memberId}`, { token: b.token }).then((x) => x.body)]);
    const leaked = ['Soyadqa', dob, '+90', 'qa.selin', 'seeking', 'gender', 'ageRange', 'usr_', 'dateOfBirth'].filter((s) => seen.includes(s));
    r.check('privacy: public DTO only (no surname, birth date, phone, Instagram, Dating settings, account id)', leaked.length === 0, leaked.join(', '));
    const photoUrl = toA?.member.photos[0]?.uri as string | undefined;
    r.check('media: profile photos delivered by short-lived signed url', Boolean(photoUrl) && (await fetch(photoUrl!)).ok);

    // 11–12. Reactions and the mutual match
    await call('POST', `/v1/introductions/${toB.introductionId}/reaction`, { token: a.token, body: { type: 'LIKE' } });
    const mutual = await call('POST', `/v1/introductions/${toA.introductionId}/reaction`, { token: b.token, body: { type: 'LIKE' } });
    r.check('reactions: mutual like → one match', Boolean(mutual.body.match?.matchId));
    const replay = await call('POST', `/v1/introductions/${toA.introductionId}/reaction`, { token: b.token, body: { type: 'LIKE' } });
    r.check('reactions: replay is idempotent', replay.body.match?.matchId === mutual.body.match?.matchId);

    // 13. Conversation authorization
    const conv = await call('POST', `/v1/matches/${mutual.body.match.matchId}/conversation`, { token: a.token });
    const sent = await call('POST', `/v1/conversations/${conv.body.conversationId}/messages`, { token: b.token, body: { body: 'Merhaba (smoke)', clientMessageId: 'smoke1' } });
    r.check('conversation: participants can write', sent.status === 200);
    r.check(
      'conversation: an applicant cannot read or write it',
      (await call('POST', `/v1/conversations/${conv.body.conversationId}/messages`, { token: z.token, body: { body: 'x', clientMessageId: 'z1' } })).status === 403,
    );

    // 14. Block
    await call('POST', `/v1/members/${b.memberId}/block`, { token: a.token });
    const after = await call('POST', `/v1/conversations/${conv.body.conversationId}/messages`, { token: b.token, body: { body: 'still there?', clientMessageId: 'smoke2' } });
    r.check('block: conversation closed both ways, silently', after.body?.error?.code === 'CONVERSATION_FORBIDDEN' && (await call('GET', '/v1/conversations', { token: a.token })).body.length === 0);
  } catch (err) {
    r.check('smoke flow completed', false, (err as Error).message);
  } finally {
    // Clean up: every QA account asks for deletion (anonymized by the next retention run).
    for (const p of people) await call('POST', '/v1/me/deletion', { token: p.token, body: { confirm: true } }).catch(() => undefined);
  }
  process.exitCode = r.summary() ? 0 : 1;
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
