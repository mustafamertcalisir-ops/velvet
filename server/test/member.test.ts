/**
 * Member product on the production API against real PostgreSQL:
 * Dating setup, compatibility and introduction generation, idempotent
 * reactions, concurrent mutual likes, one match per pair, conversation
 * authorization, blocking, reports, membership guards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatingSettingsInput } from '@/domain/member/dating';
import { activeMember, testServer, type ApplicantOpts, type T } from './harness';

let t: T;
beforeEach(async () => {
  t = await testServer();
});
afterEach(async () => t.close());

const EVERYONE = ['WOMAN', 'MAN', 'NON_BINARY'] as const;
const DOB: Record<number, string> = { 30: '1996-01-01', 31: '1995-01-01', 32: '1994-03-14', 33: '1993-01-01', 34: '1992-02-11', 35: '1991-01-01', 45: '1981-01-01' };

type M = Awaited<ReturnType<typeof activeMember>>;
async function member(firstName: string, age: number, dating: DatingSettingsInput | false | null, o: ApplicantOpts = {}): Promise<M> {
  return activeMember(t, {
    firstName,
    dateOfBirth: DOB[age]!,
    intents: dating === false ? ['friendship', 'community'] : ['dating', 'community'],
    dating: dating ?? undefined,
    ...o,
  });
}
const d = (gender: DatingSettingsInput['gender'], seeking: readonly string[], min: number, max: number, extra: Partial<DatingSettingsInput> = {}): DatingSettingsInput => ({
  gender,
  seeking: [...seeking] as DatingSettingsInput['seeking'],
  ageRange: { min, max },
  ...extra,
});

const intros = async (m: M) => (await t.request('GET', '/v1/introductions/today', { token: m.token })).body;
const namesOf = async (m: M) => ((await intros(m)).waiting as { member: { displayName: string } }[]).map((w) => w.member.displayName).sort();
async function introTo(m: M, other: M) {
  const w = ((await intros(m)).waiting as { introductionId: string; member: { memberId: string } }[]).find((x) => x.member.memberId === other.memberId);
  if (!w) throw new Error('not introduced');
  return w.introductionId;
}
async function signInAgain(m: M) {
  const otp = await t.request('POST', '/v1/auth/otp', { body: { phoneE164: m.phone } });
  const v = await t.request('POST', '/v1/auth/otp/verify', { body: { challengeId: otp.body.challengeId, code: t.sms.last(m.phone) } });
  return { token: v.body.session.token as string };
}
const react = (m: M, introductionId: string, type: string) => t.request('POST', `/v1/introductions/${introductionId}/reaction`, { token: m.token, body: { type } });

describe('Dating setup', () => {
  it('is required before introductions; preferences are seeded from the application, identity is never inferred', async () => {
    const m = await member('Şebnem', 32, null, { meet: ['women', 'non_binary'], ageRange: { min: 28, max: 40 } });
    const me = await t.request('GET', '/v1/member/me', { token: m.token });
    expect(me.body.dating).toEqual({ usesDating: true, setupRequired: true });
    expect((await intros(m)).state).toBe('DATING_SETUP_REQUIRED');
    const s = await t.request('GET', '/v1/member/me/dating', { token: m.token });
    expect(s.body).toEqual({ usesDating: true, identity: null, seeking: ['WOMAN', 'NON_BINARY'], ageRange: { min: 28, max: 40 }, setupCompletedAt: null });
    const bad = await t.request('PUT', '/v1/member/me/dating', { token: m.token, body: { gender: 'SELF_DESCRIBED', selfDescription: '', seeking: [], ageRange: { min: 50, max: 20 } } });
    expect(bad.body.error.fields.sort()).toEqual(['ageRange', 'seeking', 'selfDescription']);
    const ok = await t.request('PUT', '/v1/member/me/dating', { token: m.token, body: d('WOMAN', ['WOMAN'], 28, 40, { appearsAs: ['MAN'] }) });
    expect(ok.body.identity).toEqual({ gender: 'WOMAN', selfDescription: null, appearsAs: ['WOMAN'] }); // a fixed answer decides its own category
    expect((await intros(m)).state).toBe('READY');
  });

  it('members not using Dating are never asked, never introduced, and get no introductions', async () => {
    const friend = await member('Elif', 32, false);
    const open = await member('Kerem', 32, d('MAN', EVERYONE, 25, 45));
    expect((await t.request('GET', '/v1/member/me', { token: friend.token })).body.dating).toEqual({ usesDating: false, setupRequired: false });
    expect((await intros(friend)).state).toBe('NOT_USING_DATING');
    expect((await t.request('PUT', '/v1/member/me/dating', { token: friend.token, body: d('WOMAN', EVERYONE, 25, 45) })).body.error.code).toBe('NOT_ALLOWED');
    expect(await namesOf(open)).toEqual([]);
  });
});

describe('compatibility and introduction generation', () => {
  it('a day’s batch holds exactly the reciprocally compatible members', async () => {
    const w1 = await member('Selin', 32, d('WOMAN', ['MAN'], 28, 40));
    await member('Mert', 34, d('MAN', ['WOMAN'], 28, 40)); // ✓ mutual
    await member('Emre', 30, d('MAN', ['MAN'], 25, 40)); // ✗ seeks men
    await member('Deniz', 31, d('NON_BINARY', EVERYONE, 25, 40)); // ✗ she does not seek non-binary people
    await member('Lara', 33, d('WOMAN', ['WOMAN', 'MAN'], 25, 45)); // ✗ she does not seek women
    await member('Can', 45, d('MAN', ['WOMAN'], 30, 50)); // ✗ outside her range
    await member('Kaan', 35, d('MAN', ['WOMAN'], 33, 40)); // ✗ she is outside his range
    await member('Ozan', 31, d('SELF_DESCRIBED', ['WOMAN'], 25, 40, { selfDescription: 'Two-spirit, PRIVATE-WORDS', appearsAs: ['MAN'] })); // ✓ included under Men
    await member('Elif', 32, false); // ✗ not using Dating
    await member('Aylin', 32, null); // ✗ setup not complete
    expect(await namesOf(w1)).toEqual(['Mert', 'Ozan']);
    // The batch is fixed for the day.
    const a = await intros(w1);
    const b = await intros(w1);
    expect(b.batchId).toBe(a.batchId);
  });

  it('“Everyone” and non-binary members: both sides must want to meet each other', async () => {
    const nb = await member('Deniz', 31, d('NON_BINARY', EVERYONE, 25, 40));
    await member('Selin', 32, d('WOMAN', ['MAN', 'NON_BINARY'], 25, 40)); // ✓
    await member('Mert', 34, d('MAN', ['WOMAN'], 25, 40)); // ✗ does not seek non-binary people
    await member('Kerem', 33, d('MAN', EVERYONE, 25, 40)); // ✓
    await member('Zeynep', 30, d('NON_BINARY', ['NON_BINARY'], 25, 40)); // ✓
    expect(await namesOf(nb)).toEqual(['Kerem', 'Selin', 'Zeynep']);
  });

  it('never yourself, never a blocked member (either direction), never an inactive one', async () => {
    const w = await member('Selin', 32, d('WOMAN', EVERYONE, 25, 45));
    const m1 = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    const m2 = await member('Kerem', 33, d('MAN', ['WOMAN'], 25, 45));
    const m3 = await member('Can', 31, d('MAN', ['WOMAN'], 25, 45));
    const first = await intros(w);
    expect(first.waiting.map((x: { member: { memberId: string } }) => x.member.memberId)).not.toContain(w.memberId);
    // m1 blocks her (from his own introduction — a block needs someone you can see); m3's membership lapses.
    expect((await t.request('POST', `/v1/members/${w.memberId}/block`, { token: m1.token })).body.error.code).toBe('NOT_AVAILABLE');
    await intros(m1);
    expect((await t.request('POST', `/v1/members/${w.memberId}/block`, { token: m1.token })).body).toEqual({ blocked: true });
    await t.internal('POST', '/internal/billing/membership-expired', { accountId: m3.accountId, providerEventId: `x_${m3.accountId}`, provider: 'test' });
    // Waiting entries are re-checked: both disappear today.
    expect(await namesOf(w)).toEqual(['Kerem']);
    t.clock.advanceDays(20);
    const later = await intros(w);
    expect(later.waiting.map((x: { member: { memberId: string } }) => x.member.memberId)).toEqual([m2.memberId]);
  });

  it('exhaustion: passed (cooldown), liked (never again), matched (never again), introduced (not repeated within the window)', async () => {
    const w = await member('Selin', 32, d('WOMAN', EVERYONE, 25, 45));
    const passed = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    const liked = await member('Kerem', 33, d('MAN', ['WOMAN'], 25, 45));
    const shown = await member('Can', 31, d('MAN', ['WOMAN'], 25, 45));
    await react(w, await introTo(w, passed), 'PASS');
    await react(w, await introTo(w, liked), 'LIKE');
    void shown;
    t.clock.advanceDays(1);
    expect(await namesOf(w)).toEqual([]); // everyone was introduced yesterday
    t.clock.advanceDays(15);
    expect(await namesOf(w)).toEqual(['Can']); // reintroduced after the window; passed still cooling down; liked never
    t.clock.advanceDays(15);
    expect(await namesOf(w)).toEqual(['Can', 'Mert']); // the pass has cooled down; Can's last introduction is outside the window
  });

  it('changing preferences affects introductions from now on and keeps matches and conversations', async () => {
    const w = await member('Selin', 32, d('WOMAN', EVERYONE, 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    const k = await member('Kerem', 33, d('MAN', ['WOMAN'], 25, 45));
    await member('Lara', 33, d('WOMAN', ['WOMAN'], 25, 45));
    await react(m, await introTo(m, w), 'LIKE');
    const res = await react(w, await introTo(w, m), 'LIKE');
    expect(res.body.match).not.toBeNull();
    const conv = await t.request('POST', `/v1/matches/${res.body.match.matchId}/conversation`, { token: w.token });
    await t.request('POST', `/v1/conversations/${conv.body.conversationId}/messages`, { token: w.token, body: { body: 'Merhaba', clientMessageId: 'cm1' } });
    const keremIntro = await introTo(w, k);
    await t.request('PUT', '/v1/member/me/dating', { token: w.token, body: d('WOMAN', ['WOMAN'], 25, 45) });
    expect(await namesOf(w)).toEqual(['Lara']);
    expect((await react(w, keremIntro, 'LIKE')).body.error.code).toBe('NOT_ELIGIBLE');
    expect((await t.request('GET', `/v1/members/${k.memberId}`, { token: w.token })).body.error.code).toBe('NOT_AVAILABLE');
    const list = await t.request('GET', '/v1/conversations', { token: w.token });
    expect(list.body.map((c: { other: { displayName: string } }) => c.other.displayName)).toEqual(['Mert']);
    const thread = await t.request('POST', `/v1/matches/${res.body.match.matchId}/conversation`, { token: w.token });
    expect(thread.body.messages.map((x: { body: string }) => x.body)).toEqual(['Merhaba']);
  });
});

describe('reactions', () => {
  it('a like alone is not a match; a reciprocal like is exactly one match', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    const first = await react(w, await introTo(w, m), 'LIKE');
    expect(first.body).toEqual({ type: 'LIKE', match: null });
    const second = await react(m, await introTo(m, w), 'LIKE');
    expect(second.body.match).toMatchObject({ self: { displayName: 'Mert' }, other: { displayName: 'Selin', age: 32 }, conversationId: null });
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM app.matches');
    expect(rows[0].n).toBe(1);
  });

  it('is idempotent: double taps and retries replay; a different answer is refused; one row per introduction', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    await react(m, await introTo(m, w), 'LIKE');
    const id = await introTo(w, m);
    const burst = await Promise.all(Array.from({ length: 6 }, () => react(w, id, 'LIKE')));
    expect(new Set(burst.map((r) => r.status))).toEqual(new Set([200]));
    const matchIds = new Set(burst.map((r) => r.body.match?.matchId));
    expect(matchIds.size).toBe(1);
    expect([...matchIds][0]).toBeTruthy();
    const change = await react(w, id, 'PASS');
    expect(change.status).toBe(409);
    expect(change.body.error.code).toBe('REACTION_ALREADY_RECORDED');
    const rows = await t.pool.query('SELECT count(*)::int AS n FROM app.reactions WHERE introduction_id = $1', [id]);
    expect(rows.rows[0].n).toBe(1);
    // After midnight the same retry still replays.
    t.clock.advanceDays(1);
    expect((await react(w, id, 'LIKE')).body.match.matchId).toBe([...matchIds][0]);
  });

  it('validates ownership, expiry and type', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    const his = await introTo(m, w);
    const hers = await introTo(w, m);
    expect((await react(w, his, 'LIKE')).body.error.code).toBe('INTRODUCTION_NOT_FOUND'); // not hers
    expect((await react(w, 'itr_invented', 'LIKE')).body.error.code).toBe('INTRODUCTION_NOT_FOUND');
    expect((await react(w, hers, 'SUPER')).body.error).toMatchObject({ code: 'VALIDATION_FAILED', fields: ['type'] });
    t.clock.advanceDays(1);
    const expired = await react(w, hers, 'LIKE');
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('INTRODUCTION_EXPIRED');
  });

  it('simultaneous mutual likes create exactly one match per pair (repeated under concurrency)', async () => {
    const pairs: [M, M][] = [];
    for (let i = 0; i < 4; i++) {
      const w = await member(['Selin', 'Lara', 'Ece', 'Nil'][i]!, 32, d('WOMAN', ['MAN'], 25, 45));
      const m = await member(['Mert', 'Kerem', 'Can', 'Ozan'][i]!, 34, d('MAN', ['WOMAN'], 25, 45));
      pairs.push([w, m]);
    }
    // Everyone is compatible with every opposite member; take each pair's introductions.
    const ids = await Promise.all(pairs.map(async ([w, m]) => [await introTo(w, m), await introTo(m, w)] as const));
    const results = await Promise.all(pairs.map(([w, m], i) => Promise.all([react(w, ids[i]![0], 'LIKE'), react(m, ids[i]![1], 'LIKE')])));
    for (const [a, b] of results) {
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Exactly one of the two simultaneous requests created (and reports) the match.
      expect([a.body.match, b.body.match].filter(Boolean)).toHaveLength(1);
    }
    const { rows } = await t.pool.query(`SELECT pair_key, count(*)::int AS n FROM app.matches WHERE status = 'ACTIVE' GROUP BY pair_key`);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.n === 1)).toBe(true);
    // Both members of each pair see the same single match.
    for (const [w, m] of pairs) {
      const a = (await t.request('GET', '/v1/conversations', { token: w.token })).body;
      const b = (await t.request('GET', '/v1/conversations', { token: m.token })).body;
      expect(a.map((c: { matchId: string }) => c.matchId)).toEqual(b.map((c: { matchId: string }) => c.matchId));
      expect(a).toHaveLength(1);
    }
  });

  it('the database allows at most ONE ACTIVE match per pair, and keeps ended matches as history', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    await react(w, await introTo(w, m), 'LIKE');
    await react(m, await introTo(m, w), 'LIKE');
    const [a, b] = [w.memberId, m.memberId].sort();
    const key = `${a}|${b}`;
    const insert = (id: string, status: string, ended: string | null, reason: string | null) =>
      t.pool.query(`INSERT INTO app.matches (id, member_a, member_b, pair_key, status, created_at, ended_at, ended_reason) VALUES ($1, $2, $3, $4, $5, now(), $6, $7)`, [
        id,
        a,
        b,
        key,
        status,
        ended,
        reason,
      ]);
    // A second ACTIVE match for the pair is impossible.
    await expect(insert('mch_dup', 'ACTIVE', null, null)).rejects.toThrow(/matches_one_active_per_pair/);
    // History rows are fine, and must be internally consistent.
    await insert('mch_old', 'ENDED', '2026-01-01T00:00:00Z', 'UNMATCH');
    await expect(insert('mch_bad1', 'ACTIVE', '2026-01-01T00:00:00Z', 'UNMATCH')).rejects.toThrow(/matches_status_consistent/);
    await expect(insert('mch_bad2', 'ENDED', '2026-01-01T00:00:00Z', 'BLOCK')).rejects.toThrow(/matches_status_consistent/);
    // Once the active match has ended, a new ACTIVE one may exist for the pair.
    await t.pool.query(`UPDATE app.matches SET status = 'ENDED', ended_at = now(), ended_reason = 'UNMATCH' WHERE pair_key = $1 AND status = 'ACTIVE'`, [key]);
    await insert('mch_new', 'ACTIVE', null, null);
    const rows = (await t.pool.query(`SELECT status, count(*)::int AS n FROM app.matches WHERE pair_key = $1 GROUP BY status ORDER BY status`, [key])).rows;
    expect(rows).toEqual([
      { status: 'ACTIVE', n: 1 },
      { status: 'ENDED', n: 2 },
    ]);
  });

  it('true concurrency: many simultaneous inserts of an ACTIVE match for one pair leave exactly one', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    const [a, b] = [w.memberId, m.memberId].sort();
    // Separate connections, no advisory lock: only the partial unique index decides.
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const c = await t.pool.connect();
        try {
          await c.query('BEGIN');
          const r = await c.query(
            `INSERT INTO app.matches (id, member_a, member_b, pair_key, status, created_at) VALUES ($1, $2, $3, $4, 'ACTIVE', now())
             ON CONFLICT (pair_key) WHERE status = 'ACTIVE' DO NOTHING RETURNING id`,
            [`mch_race_${i}`, a, b, `${a}|${b}`],
          );
          await new Promise((res) => setTimeout(res, 5));
          await c.query('COMMIT');
          return r.rowCount ?? 0;
        } finally {
          c.release();
        }
      }),
    );
    expect(outcomes.reduce((x, y) => x + y, 0)).toBe(1);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM app.matches WHERE pair_key = $1`, [`${a}|${b}`])).rows[0].n).toBe(1);
  });

  it('an ended pair is not reintroduced by default; a block makes a new match impossible', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    await react(m, await introTo(m, w), 'LIKE');
    const r = await react(w, await introTo(w, m), 'LIKE');
    // End the match as a future unmatch would (no UI for it yet).
    await t.pool.query(`UPDATE app.matches SET status = 'ENDED', ended_at = $2, ended_reason = 'UNMATCH' WHERE id = $1`, [
      r.body.match.matchId,
      t.clock.now().toISOString(),
    ]);
    expect((await t.request('GET', `/v1/matches/${r.body.match.matchId}`, { token: w.token })).body.error.code).toBe('MATCH_NOT_FOUND');
    expect((await t.request('GET', '/v1/conversations', { token: w.token })).body).toEqual([]);
    // Well past every reintroduction window: still never reintroduced (rematch is a future, explicit policy).
    t.clock.advanceDays(20);
    expect(await namesOf(w)).toEqual([]);
    expect(await namesOf(m)).toEqual([]);
  });

  it('with a rematch policy, an ended pair starts fresh: only likes after the end count', async () => {
    await t.close();
    t = await testServer(undefined, {}, { policy: { perDay: 6, passCooldownDays: 30, reintroduceAfterDays: 14, rematchAfterDays: 30 } });
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    await react(m, await introTo(m, w), 'LIKE');
    const r = await react(w, await introTo(w, m), 'LIKE');
    await t.pool.query(`UPDATE app.matches SET status = 'ENDED', ended_at = $2, ended_reason = 'UNMATCH' WHERE id = $1`, [
      r.body.match.matchId,
      t.clock.now().toISOString(),
    ]);
    t.clock.advanceDays(20);
    expect(await namesOf(w)).toEqual([]); // inside the rematch window
    // Keep the sessions alive (idle expiry), then pass the window.
    t.clock.advanceDays(12);
    const w2 = { ...w, token: (await signInAgain(w)).token };
    const m2 = { ...m, token: (await signInAgain(m)).token };
    expect(await namesOf(w2)).toEqual(['Mert']);
    // His like from BEFORE the match ended no longer counts: her like alone is not a match.
    const hers = await react(w2, await introTo(w2, m2), 'LIKE');
    expect(hers.body).toEqual({ type: 'LIKE', match: null });
    const his = await react(m2, await introTo(m2, w2), 'LIKE');
    expect(his.body.match).toBeTruthy();
    const rows = (await t.pool.query(`SELECT status FROM app.matches ORDER BY created_at`)).rows.map((x) => x.status);
    expect(rows).toEqual(['ENDED', 'ACTIVE']);
  });
});

describe('conversations', () => {
  async function matched() {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    await react(m, await introTo(m, w), 'LIKE');
    const r = await react(w, await introTo(w, m), 'LIKE');
    const conv = await t.request('POST', `/v1/matches/${r.body.match.matchId}/conversation`, { token: w.token });
    return { w, m, matchId: r.body.match.matchId as string, conversationId: conv.body.conversationId as string };
  }

  it('exist only for active matches; only participants can read or write', async () => {
    const { w, m, matchId, conversationId } = await matched();
    const outsider = await member('Kerem', 33, d('MAN', ['WOMAN'], 25, 45));
    expect((await t.request('POST', `/v1/matches/${matchId}/conversation`, { token: outsider.token })).body.error.code).toBe('MATCH_NOT_FOUND');
    expect((await t.request('GET', `/v1/matches/${matchId}`, { token: outsider.token })).body.error.code).toBe('MATCH_NOT_FOUND');
    const sneak = await t.request('POST', `/v1/conversations/${conversationId}/messages`, { token: outsider.token, body: { body: 'Hi', clientMessageId: 'x1' } });
    expect(sneak.status).toBe(403);
    expect(sneak.body.error.code).toBe('CONVERSATION_FORBIDDEN');
    expect((await t.request('POST', '/v1/matches/mch_nope/conversation', { token: w.token })).body.error.code).toBe('MATCH_NOT_FOUND');
    // The two members can talk.
    t.clock.set(new Date(t.clock.now().getTime() + 60_000).toISOString());
    const sent = await t.request('POST', `/v1/conversations/${conversationId}/messages`, { token: m.token, body: { body: '  Tophane next week?  ', clientMessageId: 'c1' } });
    expect(sent.body).toMatchObject({ fromSelf: true, body: 'Tophane next week?' });
    const list = await t.request('GET', '/v1/conversations', { token: w.token });
    expect(list.body[0]).toMatchObject({ lastMessage: { body: 'Tophane next week?', fromSelf: false }, unread: true });
  });

  it('sends are validated and idempotent per client message id', async () => {
    const { w, conversationId } = await matched();
    const send = (body: unknown, clientMessageId: unknown) =>
      t.request('POST', `/v1/conversations/${conversationId}/messages`, { token: w.token, body: { body, clientMessageId } });
    const a = await send('Merhaba', 'cm_1');
    expect((await send('Merhaba', 'cm_1')).body.id).toBe(a.body.id);
    expect((await send('   ', 'cm_2')).body.error.fields).toEqual(['empty']);
    expect((await send('x'.repeat(2001), 'cm_3')).body.error.fields).toEqual(['too_long']);
    expect((await send(42, 'cm_4')).status).toBe(422);
    expect((await send('ok', '')).body.error.fields).toEqual(['clientMessageId']);
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM app.messages');
    expect(rows[0].n).toBe(1);
  });

  it('message sending is rate-limited', async () => {
    const { w, conversationId } = await matched();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await t.request('POST', `/v1/conversations/${conversationId}/messages`, { token: w.token, body: { body: `m${i}`, clientMessageId: `r${i}` } })).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe('block and report', () => {
  async function matched() {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    await react(m, await introTo(m, w), 'LIKE');
    const r = await react(w, await introTo(w, m), 'LIKE');
    const conv = await t.request('POST', `/v1/matches/${r.body.match.matchId}/conversation`, { token: w.token });
    await t.request('POST', `/v1/conversations/${conv.body.conversationId}/messages`, { token: m.token, body: { body: 'Hello', clientMessageId: 'h1' } });
    return { w, m, matchId: r.body.match.matchId as string, conversationId: conv.body.conversationId as string };
  }

  it('a block is silent, server-authoritative and total — and keeps every record', async () => {
    const { w, m, matchId, conversationId } = await matched();
    expect((await t.request('POST', `/v1/members/${m.memberId}/block`, { token: w.token })).body).toEqual({ blocked: true });
    expect((await t.request('POST', `/v1/members/${m.memberId}/block`, { token: w.token })).body).toEqual({ blocked: true });
    for (const [x, y] of [
      [w, m],
      [m, w],
    ] as const) {
      expect((await t.request('GET', '/v1/conversations', { token: x.token })).body).toEqual([]);
      expect((await t.request('GET', `/v1/members/${y.memberId}`, { token: x.token })).body.error.code).toBe('NOT_AVAILABLE');
      expect((await t.request('POST', `/v1/matches/${matchId}/conversation`, { token: x.token })).body.error.code).toBe('MATCH_NOT_FOUND');
      expect(
        (await t.request('POST', `/v1/conversations/${conversationId}/messages`, { token: x.token, body: { body: 'Hi?', clientMessageId: `z${x.memberId}` } })).body.error.code,
      ).toBe('CONVERSATION_FORBIDDEN');
    }
    // The blocked member is not told (no BLOCKED code anywhere), and only the blocker sees the block.
    expect((await t.request('GET', '/v1/member/me/blocked', { token: w.token })).body).toEqual([expect.objectContaining({ memberId: m.memberId, displayName: 'Mert' })]);
    expect((await t.request('GET', '/v1/member/me/blocked', { token: m.token })).body).toEqual([]);
    const match = await t.pool.query('SELECT status, ended_at, ended_reason FROM app.matches WHERE id = $1', [matchId]);
    expect(match.rows[0]).toMatchObject({ status: 'BLOCKED', ended_reason: 'BLOCK' });
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.messages')).rows[0].n).toBe(1);
    await expect(t.pool.query('DELETE FROM app.blocks')).rejects.toThrow(/safety evidence/);
    await expect(t.pool.query('DELETE FROM app.messages')).rejects.toThrow(/safety evidence/);
  });

  it('a block withdraws the pair’s waiting introductions at once, both ways — not on the next read', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 33, d('MAN', ['WOMAN'], 25, 45));
    const seen = async (x: typeof w, y: typeof w) =>
      ((await t.request('GET', '/v1/introductions/today', { token: x.token })).body.waiting as { member: { memberId: string } }[]).some((e) => e.member.memberId === y.memberId);
    expect(await seen(w, m)).toBe(true);
    expect(await seen(m, w)).toBe(true);
    expect((await t.request('POST', `/v1/members/${m.memberId}/block`, { token: w.token })).body).toEqual({ blocked: true });
    // Straight from the database, before either member reads anything again.
    const rows = await t.admin.query(
      `SELECT status FROM app.introduction_entries WHERE (viewer_id = $1 AND candidate_id = $2) OR (viewer_id = $2 AND candidate_id = $1)`,
      [w.memberId, m.memberId],
    );
    expect(rows.rows.map((r) => r.status).sort()).toEqual(['WITHDRAWN', 'WITHDRAWN']);
  });

  it('cannot block or report someone you were never introduced to (no enumeration)', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const stranger = await member('Emre', 34, d('MAN', ['MAN'], 25, 45));
    expect((await t.request('POST', `/v1/members/${stranger.memberId}/block`, { token: w.token })).body.error.code).toBe('NOT_AVAILABLE');
    expect((await t.request('POST', `/v1/members/mem_nobody/reports`, { token: w.token, body: { reason: 'OTHER', context: 'profile' } })).body.error.code).toBe(
      'NOT_AVAILABLE',
    );
    expect((await t.request('GET', `/v1/members/${stranger.memberId}`, { token: w.token })).body.error.code).toBe('NOT_AVAILABLE');
  });

  it('reports are structured, persisted for the membership team, and rate-limited', async () => {
    const { w, m, conversationId } = await matched();
    expect((await t.request('POST', `/v1/members/${m.memberId}/reports`, { token: w.token, body: { reason: 'NOPE', context: 'profile' } })).body.error.fields).toEqual([
      'reason',
    ]);
    const ok = await t.request('POST', `/v1/members/${m.memberId}/reports`, { token: w.token, body: { reason: 'HARASSMENT', context: 'conversation', conversationId } });
    expect(ok.body).toEqual({ reported: true });
    const notTheirs = await t.request('POST', `/v1/members/${m.memberId}/reports`, { token: w.token, body: { reason: 'OTHER', context: 'conversation', conversationId: 'cnv_other' } });
    expect(notTheirs.body.error.fields).toEqual(['conversationId']);
    const { rows } = await t.pool.query('SELECT reporter_id, reported_id, reason, context, conversation_id, status FROM app.reports');
    expect(rows).toEqual([{ reporter_id: w.memberId, reported_id: m.memberId, reason: 'HARASSMENT', context: 'conversation', conversation_id: conversationId, status: 'open' }]);
    // Reporting after blocking is still possible (the most common sequence).
    await t.request('POST', `/v1/members/${m.memberId}/block`, { token: w.token });
    expect((await t.request('POST', `/v1/members/${m.memberId}/reports`, { token: w.token, body: { reason: 'SAFETY_CONCERN', context: 'profile' } })).status).toBe(200);
    let last = 200;
    for (let i = 0; i < 20 && last === 200; i++) {
      last = (await t.request('POST', `/v1/members/${m.memberId}/reports`, { token: w.token, body: { reason: 'OTHER', context: 'profile' } })).status;
    }
    expect(last).toBe(429);
  });
});

describe('membership guards', () => {
  it('when a matched member’s membership lapses, they leave conversations and profiles; records stay', async () => {
    const w = await member('Selin', 32, d('WOMAN', ['MAN'], 25, 45));
    const m = await member('Mert', 34, d('MAN', ['WOMAN'], 25, 45));
    await react(m, await introTo(m, w), 'LIKE');
    const r = await react(w, await introTo(w, m), 'LIKE');
    await t.internal('POST', '/internal/billing/membership-expired', { accountId: m.accountId, providerEventId: `e_${m.accountId}`, provider: 'test' });
    expect((await t.request('GET', '/v1/conversations', { token: w.token })).body).toEqual([]);
    expect((await t.request('GET', `/v1/members/${m.memberId}`, { token: w.token })).body.error.code).toBe('NOT_AVAILABLE');
    expect((await t.request('GET', `/v1/matches/${r.body.match.matchId}`, { token: w.token })).body.error.code).toBe('MATCH_NOT_FOUND');
    expect((await t.request('GET', '/v1/introductions/today', { token: m.token })).body.error.code).toBe('MEMBERSHIP_REQUIRED');
    expect((await t.pool.query('SELECT count(*)::int AS n FROM app.matches')).rows[0].n).toBe(1);
  });
});
