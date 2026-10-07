/**
 * Deployed-staging suites (docs/STAGING.md §8): black-box checks against the
 * deployed API (or the local staging-shaped rehearsal), with QA accounts on
 * designated test numbers only. Environment and safety rails:
 * scripts/lib/staging.ts.
 *
 *   node dist/staging-suite.mjs before-restart
 *       sessions · OTP enumeration · matching · LIKE/BLOCK race · messaging ·
 *       safe typed errors · request ids · rate limits · SMS failure copy ·
 *       health. Writes the state the restart check needs to
 *       STAGING_STATE_FILE (default .staging-state.json, mode 0600 — it holds
 *       QA session tokens; never upload it as a CI artifact) and the values
 *       the log review must never find to STAGING_CANARY_FILE.
 *   (restart or redeploy the API)
 *   node dist/staging-suite.mjs after-restart
 *       sessions, messages and rate-limit counters survived the restart;
 *       then every QA account created here asks for deletion.
 *   node dist/staging-suite.mjs cleanup
 *       deletion requests for the accounts in the state file (if a run stopped early).
 *   node dist/staging-suite.mjs race
 *       LIKE/BLOCK in BOTH orders, deterministically (like committed → block;
 *       block committed → like), then STAGING_RACE_ROUNDS (default 6)
 *       simultaneous rounds; after each: no usable match, no message, no
 *       introduction either way, and nothing that tells the blocked member
 *       more than "unavailable". Its own CI job: about 16 accounts.
 *   node dist/staging-suite.mjs deletion
 *       account deletion against a live match and conversation: the profile
 *       disappears for the other member, sessions die, the match ends, the
 *       conversation closes, membership is cancelled, and the activation path
 *       cannot bring the account back.
 *
 * Every phase writes STAGING_DB_CHECKS_FILE (default .staging-db-checks.json):
 * the read-only database assertions (`db-check pair|account …`, opaque ids
 * only) that CI then runs INSIDE the platform as one-off jobs, so PostgreSQL
 * rows are verified without anyone reaching the database (DEC-082).
 *
 * OTP budget: the API allows 30 code requests per hour from one address, and
 * this suite keeps production-shaped limits. before-restart uses about 16,
 * race about 16, deletion 2, the smoke flow about 5 — so CI runs race and
 * deletion as separate jobs (separate runners).
 *
 * QA age bands keep the tools' Dating members from being introduced to each
 * other: before-restart 18–23, smoke 30–39, race 40–63, deletion 64–67, the
 * QA seed 70–79.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { signInternalRequest } from '../src/http/internalAuth';
import { maskPhone, recorder, stagingClient, stagingEnv, type Person, type Res } from './lib/staging';

const env = process.env;
const STATE = env.STAGING_STATE_FILE ?? '.staging-state.json';
const CANARIES = env.STAGING_CANARY_FILE ?? '.staging-canaries.json';
const DB_CHECKS = env.STAGING_DB_CHECKS_FILE ?? '.staging-db-checks.json';
/** Simultaneous LIKE/BLOCK rounds in the race phase (each costs a fresh pair). */
const ROUNDS = Math.max(1, Math.min(10, Number(env.STAGING_RACE_ROUNDS ?? 6)));

type State = {
  people: Person[];
  conversation: { matchId: string; conversationId: string; token: string; memberId: string; otherToken: string; otherMemberId: string; bodies: string[] } | null;
  limits: { mediaToken: string | null; reportToken: string | null; reportTarget: string | null };
};

type Canaries = { phones: string[]; codes: string[]; tokens: string[]; dobs: string[]; texts: string[]; signatures: string[] };

async function main() {
  const phase = process.argv[2] ?? 'before-restart';
  const e = stagingEnv();
  const c = stagingClient(e);
  const { call, internal } = c;
  const r = recorder(`staging suite (${phase})`);
  await c.preflight(); // staging-only route, staging-bound signature: stops here against anything else
  const canaries: Canaries = { phones: [], codes: [], tokens: [], dobs: [], texts: ['Soyadqa'], signatures: [] };
  /** Read-only database assertions for CI to run inside the platform (scripts/db-check.ts). */
  const dbChecks: { label: string; args: string[] }[] = [];
  const dbCheck = (label: string, args: string[], expect: Record<string, string | number | boolean>) =>
    dbChecks.push({ label, args: [...args, '--expect', Object.entries(expect).map(([k, v]) => `${k}=${v}`).join(',')] });
  const writeDbChecks = () => {
    writeFileSync(DB_CHECKS, JSON.stringify(dbChecks), { mode: 0o600 });
    chmodSync(DB_CHECKS, 0o600);
    console.log(`Database assertions for CI (run inside the platform): ${DB_CHECKS} (${dbChecks.length}).`);
  };
  const remember = (p: Person) => {
    canaries.phones.push(p.phone);
    canaries.tokens.push(p.token);
    return p;
  };

  if (phase === 'cleanup' || phase === 'after-restart') {
    if (!existsSync(STATE)) throw new Error(`${STATE} not found: run before-restart first.`);
    const s = JSON.parse(readFileSync(STATE, 'utf8')) as State;
    if (phase === 'after-restart') await afterRestart(s);
    for (const p of s.people) await call('POST', '/v1/me/deletion', { token: p.token, body: { confirm: true } }).catch(() => undefined);
    rmSync(STATE, { force: true });
    console.log(`Deletion requested for ${s.people.length} QA accounts; ${STATE} removed.`);
    if (phase === 'after-restart') writeDbChecks();
    process.exitCode = r.summary() ? 0 : 1;
    return;
  }
  if (phase !== 'before-restart' && phase !== 'race' && phase !== 'deletion') throw new Error('Usage: staging-suite before-restart | after-restart | cleanup | race | deletion');

  const state: State = { people: [], conversation: null, limits: { mediaToken: null, reportToken: null, reportTarget: null } };
  const keep = (p: Person) => {
    state.people.push(remember(p));
    return p;
  };
  const otp = async (phone: string) => call('POST', '/v1/auth/otp', { body: { phoneE164: phone } });
  const outbox = async (phone: string) => {
    const x = await internal('/internal/test/otp', { phoneE164: phone });
    if (x.body?.code) canaries.codes.push(x.body.code);
    return x;
  };
  const signIn = async (phone: string) => {
    const s = await c.signIn(phone);
    canaries.tokens.push(s.token);
    return s;
  };
  /** A pair introduced only to each other (a unique one-year age band inside this phase's QA band). */
  let band = phase === 'race' ? 40 : phase === 'deletion' ? 64 + Math.floor(Math.random() * 2) : 18 + Math.floor(Math.random() * 3);
  /** First names are letters only (Stage 1 validation): one per pair. */
  const NAMES = ['Lale', 'Nil', 'Mavi', 'Sena', 'Tuna', 'Yaz', 'Ece', 'Kaan', 'Oya', 'Deniz', 'Ilgaz', 'Bora'];
  async function pair(label: string): Promise<[Person, Person]> {
    const age = band;
    band += 2; // one-year ranges [age, age+1] never overlap the next pair's
    const dob = c.dobForAge(age);
    canaries.dobs.push(dob);
    const range = { min: age, max: age + 1 };
    const w = keep(await c.member({ name: `${label}a`, dob, intents: ['dating'], meet: ['men'], ageRange: range, dating: { gender: 'WOMAN', seeking: ['MAN'], ageRange: range } }));
    const m = keep(await c.member({ name: `${label}b`, dob, intents: ['dating'], meet: ['women'], ageRange: range, dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: range } }));
    return [w, m];
  }
  const introductionTo = async (viewer: Person, other: Person) => {
    const t = await call('GET', '/v1/introductions/today', { token: viewer.token });
    return (t.body.waiting ?? []).find((w: { member: { memberId: string } }) => w.member.memberId === other.memberId) as { introductionId: string } | undefined;
  };
  const like = (p: Person, introductionId: string) => call('POST', `/v1/introductions/${introductionId}/reaction`, { token: p.token, body: { type: 'LIKE' } });

  if (phase === 'race') return finish(await racePhase());
  if (phase === 'deletion') return finish(await deletionPhase());

  try {
    // --- Health -------------------------------------------------------------------------------
    const live = await call('GET', '/health/live');
    const ready = await call('GET', '/health/ready');
    r.check('health: live answers ok', live.status === 200 && live.body?.status === 'ok');
    r.check('health: ready answers ready (database, migrations, storage)', ready.status === 200 && ready.body?.status === 'ready', JSON.stringify(ready.body));
    r.check('health: no infrastructure detail in the answer', !/postgres|amazonaws|render|host|version|error/i.test(JSON.stringify(ready.body)));

    // --- The client address behind the platform proxy (TRUST_PROXY_HOPS) ---------------------------
    {
      const simulated = process.env.STAGING_SIMULATED_CLIENT_IP;
      const spoof = '203.0.113.77';
      const seen = await internal('/internal/test/client-address', {}, 'POST', { 'x-forwarded-for': simulated ? `${spoof}, ${simulated}` : spoof });
      r.check(
        'proxy: per-address limits see the real client — not the platform proxy, not a forwarded-for value the client chose',
        seen.status === 200 && seen.body.address !== spoof && seen.body.privateRange === false,
        `resolved ${seen.body?.privateRange ? 'a private (proxy) address' : seen.body?.address === spoof ? 'the spoofed value' : 'ok'} with TRUST_PROXY_HOPS=${seen.body?.hops}`,
      );
    }

    // --- Sessions -------------------------------------------------------------------------------
    {
      const phone = c.testPhone();
      const s = await signIn(phone);
      const rotated = await call('POST', '/v1/auth/session/rotate', { token: s.token });
      canaries.tokens.push(rotated.body?.token);
      r.check('session: rotation issues a new token', rotated.status === 200 && typeof rotated.body?.token === 'string' && rotated.body.token !== s.token);
      r.check('session: the rotated token authenticates', (await call('GET', '/v1/me/application', { token: rotated.body.token })).status === 200);
      await call('POST', '/v1/auth/sign-out', { token: rotated.body.token });
      r.check('session: after sign-out the token is refused', (await call('GET', '/v1/me/application', { token: rotated.body.token })).status === 401);
      r.check('session: the pre-rotation token is refused too', (await call('GET', '/v1/me/application', { token: s.token })).status === 401);
      await new Promise((res) => setTimeout(res, 31_000)); // the per-number resend cooldown
      const one = await signIn(phone);
      await new Promise((res) => setTimeout(res, 31_000));
      const two = await signIn(phone);
      const all = await call('POST', '/v1/auth/sign-out-all', { token: one.token });
      r.check(
        'session: sign out everywhere refuses every session',
        all.status === 200 && (await call('GET', '/v1/me/application', { token: one.token })).status === 401 && (await call('GET', '/v1/me/application', { token: two.token })).status === 401,
      );
      await new Promise((res) => setTimeout(res, 31_000));
      const three = await signIn(phone);
      const del = await call('POST', '/v1/me/deletion', { token: three.token, body: { confirm: true } });
      r.check('session: a deletion request refuses the session immediately', del.status === 200 && (await call('GET', '/v1/me/application', { token: three.token })).status === 401);
    }

    // --- Matching ------------------------------------------------------------------------------
    const [a, b] = await pair('Match');
    {
      const aSeesB = await introductionTo(a, b);
      r.check('matching: A sees B', Boolean(aSeesB));
      const first = await like(a, aSeesB!.introductionId);
      r.check('matching: A likes B — no match yet', first.status === 200 && first.body.match === null);
      const bSeesA = await introductionTo(b, a);
      r.check('matching: B sees A', Boolean(bSeesA));
      const second = await like(b, bSeesA!.introductionId);
      const matchId = second.body?.match?.matchId as string | undefined;
      r.check('matching: B likes A — exactly one match', Boolean(matchId));
      const convA = await call('POST', `/v1/matches/${matchId}/conversation`, { token: a.token });
      const convB = await call('POST', `/v1/matches/${matchId}/conversation`, { token: b.token });
      r.check('matching: both open the same conversation', convA.status === 200 && convA.body.conversationId === convB.body.conversationId);
      const againA = await like(a, aSeesB!.introductionId);
      const againB = await like(b, bSeesA!.introductionId);
      r.check('matching: retrying both likes keeps one match', againB.body?.match?.matchId === matchId && (againA.body?.match?.matchId ?? matchId) === matchId);
      const conversations = (await call('GET', '/v1/conversations', { token: a.token })).body as { matchId: string }[];
      r.check('matching: one conversation entry for the pair', conversations.filter((x) => x.matchId === matchId).length === 1);

      // --- Messaging ----------------------------------------------------------------------------
      const conversationId = convA.body.conversationId as string;
      const bodies = ['Merhaba — staging message one', 'İkinci mesaj: çay mı kahve mi?'];
      canaries.texts.push(...bodies);
      const m1 = await call('POST', `/v1/conversations/${conversationId}/messages`, { token: a.token, body: { body: bodies[0], clientMessageId: 'suite-1' } });
      const m1again = await call('POST', `/v1/conversations/${conversationId}/messages`, { token: a.token, body: { body: bodies[0], clientMessageId: 'suite-1' } });
      await call('POST', `/v1/conversations/${conversationId}/messages`, { token: b.token, body: { body: bodies[1], clientMessageId: 'suite-2' } });
      r.check('messaging: a matched member can send', m1.status === 200);
      const view = await call('POST', `/v1/matches/${matchId}/conversation`, { token: b.token });
      r.check('messaging: a retried send does not duplicate', m1again.status === 200 && (view.body.messages as { body: string }[]).filter((m) => m.body === bodies[0]).length === 1);
      const x = keep(await c.member({ name: 'Third', dob: c.dobForAge(52), intents: ['community'] }));
      r.check(
        'messaging: a member outside the match cannot send',
        [403, 404].includes((await call('POST', `/v1/conversations/${conversationId}/messages`, { token: x.token, body: { body: 'not mine', clientMessageId: 'x-1' } })).status),
      );
      state.conversation = { matchId: matchId!, conversationId, token: a.token, memberId: a.memberId!, otherToken: b.token, otherMemberId: b.memberId!, bodies };
      dbCheck('matching: exactly one ACTIVE match row for the pair, one open conversation', ['pair', a.memberId!, b.memberId!], { active: 1, ended: 0, blocked: 0, blocks: 0, conversationsOpen: 1 });

      // --- Safe, typed errors and request ids ---------------------------------------------------------
      const safe = (res: { body: unknown }) => !/stack|at .*\.ts|SELECT |INSERT |postgres|syntax error|ECONN|TypeError/i.test(JSON.stringify(res.body));
      const badJson = await call('POST', '/v1/auth/otp', { raw: '{"phoneE164": ' });
      r.check('errors: malformed JSON → VALIDATION_FAILED, nothing internal', badJson.body?.error?.code === 'VALIDATION_FAILED' && safe(badJson));
      const big = await call('POST', `/v1/conversations/${conversationId}/messages`, { token: a.token, raw: JSON.stringify({ body: 'x'.repeat(200_000), clientMessageId: 'big' }) });
      r.check('errors: oversized body → PAYLOAD_TOO_LARGE', big.status === 413 && big.body?.error?.code === 'PAYLOAD_TOO_LARGE' && safe(big));
      const anon = await call('GET', '/v1/member/me');
      r.check('errors: no session → UNAUTHENTICATED', anon.status === 401 && anon.body?.error?.code === 'UNAUTHENTICATED' && safe(anon));
      const revoked = await call('GET', '/v1/member/me', { token: 'not-a-real-session-token-000000000000' });
      r.check('errors: unknown/revoked session → UNAUTHENTICATED', revoked.status === 401 && safe(revoked));
      const forbidden = await call('GET', '/v1/members/mem_does_not_exist_000', { token: a.token });
      r.check('errors: someone else’s or unknown member → typed NOT_AVAILABLE', [403, 404].includes(forbidden.status) && typeof forbidden.body?.error?.code === 'string' && safe(forbidden));
      const invalidOtp = await call('POST', '/v1/auth/otp/verify', { body: { challengeId: 'otp_unknown_challenge_00', code: '123456' } });
      r.check('errors: invalid code → typed error', typeof invalidOtp.body?.error?.code === 'string' && safe(invalidOtp));
      const rid = `suite_${Date.now()}`;
      const traced = await call('GET', '/v1/member/me', { headers: { 'x-request-id': rid } });
      r.check('request id: a well-formed client id is kept end to end (header and error body)', traced.headers.get('x-request-id') === rid && traced.body?.error?.requestId === rid);
      const minted = await call('GET', '/v1/member/me', { headers: { 'x-request-id': 'bad id with spaces' } });
      r.check('request id: a malformed client id is replaced', Boolean(minted.headers.get('x-request-id')) && minted.headers.get('x-request-id') !== 'bad id with spaces');
      const unrouted = await call('POST', '/v1/auth/otp', { body: { phoneE164: '+447700900123' } });
      r.check('sms: a number with no SMS route answers the safe "couldn’t send" copy', unrouted.body?.error?.code === 'CODE_NOT_SENT' && !/netgsm|iletimerkezi|provider|route/i.test(JSON.stringify(unrouted.body)));

      // --- Internal routes on the deployment: only a fresh, staging-bound, scoped, single-use signature ---
      {
        const path = '/internal/test/client-address';
        const signed = (o: { env?: string; now?: Date; nonce?: string; path?: string; body?: string } = {}) =>
          signInternalRequest({ env: o.env ?? 'staging', keyId: e.keyId, secret: e.keySecret, method: 'POST', pathAndQuery: o.path ?? path, body: o.body ?? '{}', now: o.now, nonce: o.nonce });
        const send = (headers: Record<string, string>, p = path, body = '{}', token?: string) =>
          call('POST', p, { raw: body, token, headers: { ...headers, 'content-type': 'application/json' } });
        const refused = (x: { status: number; body: any }) => x.status === 401 && x.body?.error?.code === 'UNAUTHENTICATED'; // eslint-disable-line @typescript-eslint/no-explicit-any
        r.check('internal auth: unsigned → refused', refused(await send({})));
        r.check('internal auth: a member session token → refused', refused(await send({}, path, '{}', a.token)));
        r.check('internal auth: a signature older than the window → refused', refused(await send(signed({ now: new Date(Date.now() - 10 * 60_000) }))));
        r.check('internal auth: signed for another environment (production) → refused', refused(await send(signed({ env: 'production' }))));
        const once = signed();
        const first = await send(once);
        r.check('internal auth: a replayed request → refused (nonce single use)', first.status === 200 && refused(await send(once)));
        const tampered = signed();
        r.check('internal auth: a body other than the signed one → refused', refused(await send(tampered, path, '{"x":1}')));
        const retention = '/internal/retention/run';
        r.check(
          'internal auth: a key without the scope (runner → retention) → refused',
          refused(await send(signed({ path: retention, body: '{"dryRun":true}' }), retention, '{"dryRun":true}')),
        );
      }

      // --- Rate limits (also checked again after the restart) ---------------------------------------
      let limited = false;
      for (let i = 0; i < 32 && !limited; i++) {
        const s = await call('POST', `/v1/conversations/${conversationId}/messages`, { token: b.token, body: { body: `burst ${i}`, clientMessageId: `burst-${i}` } });
        limited = s.body?.error?.code === 'RATE_LIMITED';
      }
      r.check('rate limit: messages per minute', limited);
      let replayLimited = false;
      let replaySame = true;
      for (let i = 0; i < 205 && !replayLimited; i++) {
        const s = await like(b, bSeesA!.introductionId);
        if (s.body?.error?.code === 'RATE_LIMITED') replayLimited = true;
        else if (s.body?.match?.matchId !== matchId) replaySame = false;
      }
      r.check('rate limit: reaction replay is idempotent, then limited', replayLimited && replaySame);
      let mediaLimited = false;
      for (let i = 0; i < 42 && !mediaLimited; i++) {
        const s = await call('POST', '/v1/media/uploads', { token: x.token, body: { mediaClass: 'PROFILE_MEDIA', contentType: 'image/jpeg', byteLength: 1000 } });
        if (s.body?.upload?.url) canaries.signatures.push(new URL(s.body.upload.url).searchParams.get('X-Amz-Signature') ?? new URL(s.body.upload.url).searchParams.get('sig') ?? '');
        mediaLimited = s.body?.error?.code === 'RATE_LIMITED';
      }
      r.check('rate limit: media upload authorizations', mediaLimited);
      state.limits.mediaToken = x.token;
      const cooldownPhone = c.testPhone();
      canaries.phones.push(cooldownPhone);
      const again = await otp(cooldownPhone);
      const sooner = await otp(cooldownPhone);
      r.check('rate limit: OTP resend cooldown', again.status === 200 && sooner.body?.error?.code === 'RATE_LIMITED', JSON.stringify([again.status, sooner.body?.error?.code]));
      await outbox(cooldownPhone);
    }

    // --- Media on the deployed storage: metadata stripped; verification media never readable -------------
    {
      const v = await c.applicant({ name: 'Veri', dob: c.dobForAge(47), intents: ['community'] });
      keep(v);
      const uri = v.photoUrls?.[0];
      const stored = uri ? Buffer.from(await (await fetch(uri)).arrayBuffer()) : Buffer.alloc(0);
      r.check(
        'media: a stored photo carries no EXIF/GPS (uploaded with both)',
        stored.length > 0 && !stored.includes('STAGING-EXIF-MARKER') && !stored.includes('GPS 41.0082N') && !stored.includes(Buffer.from('Exif\0\0')),
        uri ? `${stored.length} bytes` : 'no photo url in the applicant view',
      );
      const asked = await c.fixture(v.applicationId, 'REQUEST_IDENTITY');
      const request = ((await call('GET', '/v1/me/application', { token: v.token })).body.informationRequests ?? []).find((q: { type: string }) => q.type === 'VERIFY_IDENTITY');
      const up = request ? await c.upload(v.token, 'VERIFICATION_MEDIA', await c.photo(99), request.id) : null;
      r.check('media: a verification photo uploads to the verification bucket', asked.status === 200 && up?.status === 200, JSON.stringify(up?.body ?? asked.body));
      const after = JSON.stringify([up?.body, (await call('GET', '/v1/me/application', { token: v.token })).body]);
      r.check(
        'media: no applicant or member response carries a verification url',
        !new RegExp(e.api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|X-Amz-|verification/').test(after.replace(/"photos":\[[^\]]*\]/g, '')),
        after.slice(0, 300),
      );
    }

    // --- OTP enumeration ------------------------------------------------------------------------
    {
      const existing = state.people.slice(0, 3).map((p) => p.phone);
      const fresh = [c.testPhone(), c.testPhone(), c.testPhone()];
      await new Promise((res) => setTimeout(res, 31_000)); // the existing numbers' resend cooldown (their sign-in was recent)
      const ex = await Promise.all(existing.map(otp));
      const nw = await Promise.all(fresh.map(otp));
      const shape = (x: { status: number; body: unknown }) => `${x.status}:${Object.keys((x.body as object) ?? {}).sort().join()}`;
      r.check('enumeration: existing and new numbers get the same status and fields', new Set([...ex, ...nw].map(shape)).size === 1, [...ex, ...nw].map(shape).join(' | '));
      const wrong = await Promise.all([...ex, ...nw].map((o) => call('POST', '/v1/auth/otp/verify', { body: { challengeId: o.body.challengeId, code: '000000' } })));
      r.check('enumeration: a wrong code answers the same for existing and new numbers', new Set(wrong.map((w) => JSON.stringify({ s: w.status, c: w.body?.error?.code, r: w.body?.error?.attemptsRemaining }))).size === 1);
      const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
      const gap = Math.abs(mean(ex.map((x) => x.ms)) - mean(nw.map((x) => x.ms)));
      r.check(`enumeration: no timing gap worth noting (Δ ${Math.round(gap)} ms, threshold 300 ms)`, gap < 300);
      canaries.phones.push(...fresh);
      for (const p of [...existing, ...fresh]) await outbox(p); // consume the test codes (and record them as canaries)
    }

    // --- LIKE / BLOCK (one simultaneous round here; both orders and repeated rounds: the race phase) ------
    for (let round = 1; round <= 1; round++) {
      const [w, m] = await pair(NAMES[round % NAMES.length]!);
      const wSeesM = await introductionTo(w, m);
      const mSeesW = await introductionTo(m, w);
      if (!wSeesM || !mSeesW) {
        r.check(`race ${round}: setup — the pair is introduced`, false);
        continue;
      }
      await like(m, mSeesW.introductionId); // m has liked w: w's like would create the match
      const [likeRes, blockRes] = await Promise.all([like(w, wSeesM.introductionId), call('POST', `/v1/members/${w.memberId}/block`, { token: m.token })]);
      const matchId = likeRes.body?.match?.matchId as string | undefined;
      const convs = [...((await call('GET', '/v1/conversations', { token: w.token })).body ?? []), ...((await call('GET', '/v1/conversations', { token: m.token })).body ?? [])];
      const open = matchId ? await call('POST', `/v1/matches/${matchId}/conversation`, { token: w.token }) : null;
      const usable = Boolean(open && open.status === 200);
      r.check(
        `race ${round}: block wins — no active conversation or usable match (${matchId ? 'like landed first' : 'block landed first'})`,
        blockRes.status === 200 && convs.length === 0 && !usable,
        JSON.stringify({ like: likeRes.status, block: blockRes.status, convs: convs.length, open: open?.status }),
      );
      dbCheck(`race ${round}: no ACTIVE match, a block row, no open conversation, no pending introduction`, ['pair', w.memberId!, m.memberId!], {
        active: 0,
        blocks: 1,
        conversationsOpen: 0,
        pendingIntroductions: 0,
      });
      if (round === 1) {
        state.limits.reportToken = m.token;
        state.limits.reportTarget = w.memberId!;
      }
    }

    // Reports: limited per day (and the counter must survive the restart).
    if (state.limits.reportToken && state.limits.reportTarget) {
      let reportLimited = false;
      for (let i = 0; i < 22 && !reportLimited; i++) {
        const s = await call('POST', `/v1/members/${state.limits.reportTarget}/reports`, { token: state.limits.reportToken, body: { reason: 'OTHER', context: 'profile' } });
        reportLimited = s.body?.error?.code === 'RATE_LIMITED';
      }
      r.check('rate limit: reports per day', reportLimited);
    }

  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    r.check('suite completed', false, `${(err as Error).message}${cause ? ` (${cause.code ?? ''} ${cause.message ?? ''})` : ''}`);
  } finally {
    // 0600 even when the files already existed (writeFileSync's mode applies only on creation).
    for (const [file, data] of [
      [STATE, state],
      [CANARIES, canaries],
    ] as const) {
      writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    console.log(`\nState for the restart check: ${STATE} (${state.people.length} QA accounts, e.g. ${state.people.slice(0, 2).map((p) => maskPhone(p.phone)).join(', ')}).`);
    writeDbChecks();
  }
  process.exitCode = r.summary() ? 0 : 1;

  /** Common end of the race and deletion phases: files 0600, the summary decides the exit code. */
  function finish(_completed: boolean) {
    for (const [file, data] of [[CANARIES, canaries]] as const) {
      writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    writeDbChecks();
    process.exitCode = r.summary() ? 0 : 1;
  }

  /** An id of the same shape as a real one, owned by nobody: the "unavailable" answer to compare against. */
  function unknownIdLike(id: string) {
    return `${id.split('_')[0]}_${randomBytes(15).toString('base64url')}`;
  }

  /** What the blocked member can still learn about the blocker: nothing beyond the generic "unavailable". */
  async function seesNothing(viewer: Person, other: Person) {
    const shape = (x: Res) => JSON.stringify({ s: x.status, c: x.body?.error?.code, m: x.body?.error?.message });
    const profile = await call('GET', `/v1/members/${other.memberId}`, { token: viewer.token });
    const unknown = await call('GET', `/v1/members/${unknownIdLike(other.memberId!)}`, { token: viewer.token });
    const conversations = ((await call('GET', '/v1/conversations', { token: viewer.token })).body ?? []) as unknown[];
    return {
      generic: shape(profile) === shape(unknown) && profile.status === 404 && !/block/i.test(JSON.stringify(profile.body)),
      noIntroduction: !(await introductionTo(viewer, other)),
      noConversation: conversations.length === 0,
    };
  }

  /** Both orders on purpose, then simultaneous rounds; the block must win every time. */
  async function racePhase(): Promise<boolean> {
    try {
      // 1. LIKE commits before BLOCK: a real match and a message exist, then the block lands.
      {
        const [w, m] = await pair('Lale');
        const wSeesM = await introductionTo(w, m);
        const mSeesW = await introductionTo(m, w);
        await like(m, mSeesW!.introductionId);
        const matched = await like(w, wSeesM!.introductionId);
        const matchId = matched.body?.match?.matchId as string | undefined;
        r.check('race order 1 (like committed first): the match exists before the block', Boolean(matchId), JSON.stringify(matched.body?.error ?? {}));
        const conv = await call('POST', `/v1/matches/${matchId}/conversation`, { token: w.token });
        const conversationId = conv.body?.conversationId as string;
        const text = 'Order one message before the block';
        canaries.texts.push(text);
        const before = await call('POST', `/v1/conversations/${conversationId}/messages`, { token: w.token, body: { body: text, clientMessageId: 'order1-1' } });
        const block = await call('POST', `/v1/members/${w.memberId}/block`, { token: m.token });
        r.check('race order 1: the block succeeds after the match', before.status === 200 && block.status === 200);
        const sendW = await call('POST', `/v1/conversations/${conversationId}/messages`, { token: w.token, body: { body: 'after block', clientMessageId: 'order1-2' } });
        const sendM = await call('POST', `/v1/conversations/${conversationId}/messages`, { token: m.token, body: { body: 'after block', clientMessageId: 'order1-3' } });
        r.check('race order 1: no new message either way', sendW.body?.error?.code === 'CONVERSATION_FORBIDDEN' && sendM.body?.error?.code === 'CONVERSATION_FORBIDDEN');
        const matchView = await call('GET', `/v1/matches/${matchId}`, { token: w.token });
        r.check('race order 1: the match is no longer usable', matchView.body?.error?.code === 'MATCH_NOT_FOUND');
        const seen = await seesNothing(w, m);
        r.check('race order 1: the blocked member sees only "unavailable" — no profile, introduction or conversation', seen.generic && seen.noIntroduction && seen.noConversation, JSON.stringify(seen));
        r.check('race order 1: the blocker cannot open the blocked member’s profile either', (await call('GET', `/v1/members/${w.memberId}`, { token: m.token })).status === 404);
        dbCheck('race order 1: the match row is BLOCKED (none ACTIVE), one block, conversation closed, the one message kept, no pending introduction', ['pair', w.memberId!, m.memberId!], {
          active: 0,
          blocked: 1,
          endedByBlock: 1,
          blocks: 1,
          conversationsOpen: 0,
          messages: 1,
          pendingIntroductions: 0,
        });
      }
      // 2. BLOCK commits before LIKE: the like that would have matched arrives after the block.
      {
        const [w, m] = await pair('Nil');
        const wSeesM = await introductionTo(w, m);
        const mSeesW = await introductionTo(m, w);
        await like(m, mSeesW!.introductionId);
        const block = await call('POST', `/v1/members/${w.memberId}/block`, { token: m.token });
        const late = await like(w, wSeesM!.introductionId);
        r.check('race order 2 (block committed first): the later like creates no match', block.status === 200 && !late.body?.match, JSON.stringify({ like: late.status, code: late.body?.error?.code }));
        r.check(
          'race order 2: the late like is answered generically (no block disclosure)',
          (late.status === 200 && late.body?.match === null) || ['NOT_ELIGIBLE', 'INTRODUCTION_NOT_FOUND'].includes(late.body?.error?.code),
          JSON.stringify(late.body),
        );
        const seen = await seesNothing(w, m);
        r.check('race order 2: the blocked member sees only "unavailable" — no profile, introduction or conversation', seen.generic && seen.noIntroduction && seen.noConversation, JSON.stringify(seen));
        dbCheck('race order 2: no match row at all, one block, no conversation, no pending introduction', ['pair', w.memberId!, m.memberId!], {
          active: 0,
          blocked: 0,
          ended: 0,
          blocks: 1,
          conversationsOpen: 0,
          conversationsClosed: 0,
          pendingIntroductions: 0,
        });
      }
      // 3. Simultaneous rounds: either order may win the race; the block must win the outcome.
      const orders = { likeFirst: 0, blockFirst: 0 };
      for (let round = 1; round <= ROUNDS; round++) {
        const [w, m] = await pair(NAMES[(round + 1) % NAMES.length]!);
        const wSeesM = await introductionTo(w, m);
        const mSeesW = await introductionTo(m, w);
        if (!wSeesM || !mSeesW) {
          r.check(`race round ${round}: setup — the pair is introduced`, false);
          continue;
        }
        await like(m, mSeesW.introductionId);
        const [likeRes, blockRes] = await Promise.all([like(w, wSeesM.introductionId), call('POST', `/v1/members/${w.memberId}/block`, { token: m.token })]);
        const matchId = likeRes.body?.match?.matchId as string | undefined;
        if (matchId) orders.likeFirst++;
        else orders.blockFirst++;
        const open = matchId ? await call('POST', `/v1/matches/${matchId}/conversation`, { token: w.token }) : null;
        const seen = await seesNothing(w, m);
        r.check(
          `race round ${round}: the block wins (${matchId ? 'like landed first' : 'block landed first'})`,
          blockRes.status === 200 && !(open && open.status === 200) && seen.generic && seen.noIntroduction && seen.noConversation,
          JSON.stringify({ like: likeRes.status, block: blockRes.status, open: open?.status, ...seen }),
        );
        dbCheck(`race round ${round}: no ACTIVE match, one block, no open conversation, no pending introduction`, ['pair', w.memberId!, m.memberId!], {
          active: 0,
          blocks: 1,
          conversationsOpen: 0,
          pendingIntroductions: 0,
        });
      }
      console.log(`Simultaneous rounds: like landed first ${orders.likeFirst}×, block landed first ${orders.blockFirst}× (both orders were also forced above).`);
      return true;
    } catch (err) {
      r.check('race phase completed', false, (err as Error).message);
      return false;
    } finally {
      for (const p of state.people) await call('POST', '/v1/me/deletion', { token: p.token, body: { confirm: true } }).catch(() => undefined);
    }
  }

  /** Deleting an account in the middle of a live match and conversation. */
  async function deletionPhase(): Promise<boolean> {
    try {
      const [d, o] = await pair('Deniz');
      const dSeesO = await introductionTo(d, o);
      const oSeesD = await introductionTo(o, d);
      await like(d, dSeesO!.introductionId);
      const matched = await like(o, oSeesD!.introductionId);
      const matchId = matched.body?.match?.matchId as string;
      const conv = await call('POST', `/v1/matches/${matchId}/conversation`, { token: o.token });
      const conversationId = conv.body?.conversationId as string;
      const text = 'Deletion check message';
      canaries.texts.push(text);
      await call('POST', `/v1/conversations/${conversationId}/messages`, { token: d.token, body: { body: text, clientMessageId: 'del-1' } });
      r.check('deletion: setup — a live match and conversation', Boolean(matchId) && conv.status === 200);

      const del = await call('POST', '/v1/me/deletion', { token: d.token, body: { confirm: true } });
      r.check('deletion: the request is accepted', del.status === 200 && del.body?.deletionRequested === true);
      r.check('deletion: the session is refused at once', (await call('GET', '/v1/me/application', { token: d.token })).status === 401);
      r.check('deletion: member access is refused at once', (await call('GET', '/v1/member/me', { token: d.token })).status === 401);
      const seen = await seesNothing(o, d);
      r.check('deletion: the profile disappears for the other member (generic "unavailable")', seen.generic && seen.noIntroduction, JSON.stringify(seen));
      r.check('deletion: the match ends for the other member', (await call('GET', `/v1/matches/${matchId}`, { token: o.token })).body?.error?.code === 'MATCH_NOT_FOUND');
      r.check('deletion: the conversation is gone from the other member’s list', seen.noConversation);
      const send = await call('POST', `/v1/conversations/${conversationId}/messages`, { token: o.token, body: { body: 'after deletion', clientMessageId: 'del-2' } });
      r.check('deletion: sending into the conversation is refused', send.body?.error?.code === 'CONVERSATION_FORBIDDEN');
      const reactivate = await c.fixture(d.applicationId, 'ACTIVATE');
      r.check('deletion: the activation (payment-confirmed) path cannot bring the account back', reactivate.status !== 200, `${reactivate.status} ${reactivate.body?.error?.code ?? ''}`);
      const again = await call('POST', '/v1/auth/otp', { body: { phoneE164: d.phone } });
      r.check('deletion: the number can still request a code (the answer reads the same as for anyone)', again.status === 200 || again.body?.error?.code === 'RATE_LIMITED');
      dbCheck('deletion: deletion requested, no live session, membership cancelled, profile hidden, match ended by deletion, conversation closed', ['account', d.accountId], {
        found: true,
        qa: true,
        status: 'deletion_requested',
        deletionRequested: true,
        liveSessions: 0,
        membership: 'cancelled',
        profileVisibility: 'hidden',
        activeMatches: 0,
        matchesEndedByDeletion: 1,
        openConversations: 0,
        pendingIntroductions: 0,
      });
      console.log(`Deleted QA account for the retention dry run: ${d.accountId}`);
      return true;
    } catch (err) {
      r.check('deletion phase completed', false, (err as Error).message);
      return false;
    } finally {
      for (const p of state.people) await call('POST', '/v1/me/deletion', { token: p.token, body: { confirm: true } }).catch(() => undefined);
    }
  }

  async function afterRestart(s: State) {
    const live = await call('GET', '/health/ready');
    r.check('restart: the API is ready again', live.status === 200);
    const p = s.people.find((x) => x.memberId);
    r.check('restart: sessions survive (stored in PostgreSQL)', Boolean(p) && (await call('GET', '/v1/member/me', { token: p!.token })).status === 200);
    if (s.conversation) {
      const view = await call('POST', `/v1/matches/${s.conversation.matchId}/conversation`, { token: s.conversation.otherToken });
      const bodies = ((view.body?.messages ?? []) as { body: string }[]).map((m) => m.body);
      r.check('restart: messages persist', s.conversation.bodies.every((b) => bodies.includes(b)), `${bodies.length} messages`);
      // Then: blocked members cannot write — the conversation closes for both.
      await call('POST', `/v1/members/${s.conversation.otherMemberId}/block`, { token: s.conversation.token });
      // The other member hit the per-minute message limit before the restart: let that window pass first.
      await new Promise((res) => setTimeout(res, 61_000));
      const send = await call('POST', `/v1/conversations/${s.conversation.conversationId}/messages`, { token: s.conversation.otherToken, body: { body: 'after block', clientMessageId: 'after-block' } });
      r.check('messaging: blocked → the closed conversation refuses messages', send.body?.error?.code === 'CONVERSATION_FORBIDDEN');
      const mine = await call('POST', `/v1/conversations/${s.conversation.conversationId}/messages`, { token: s.conversation.token, body: { body: 'after block', clientMessageId: 'after-block-2' } });
      r.check('messaging: the blocking member cannot write either', mine.body?.error?.code === 'CONVERSATION_FORBIDDEN');
      if (s.conversation.memberId) {
        dbCheck('messaging: after the block the match is BLOCKED and the conversation closed', ['pair', s.conversation.memberId, s.conversation.otherMemberId], {
          active: 0,
          blocked: 1,
          endedByBlock: 1,
          blocks: 1,
          conversationsOpen: 0,
        });
      }
    }
    if (s.limits.mediaToken) {
      const m = await call('POST', '/v1/media/uploads', { token: s.limits.mediaToken, body: { mediaClass: 'PROFILE_MEDIA', contentType: 'image/jpeg', byteLength: 1000 } });
      r.check('restart: the media authorization limit survives', m.body?.error?.code === 'RATE_LIMITED');
    }
    if (s.limits.reportToken && s.limits.reportTarget) {
      const rep = await call('POST', `/v1/members/${s.limits.reportTarget}/reports`, { token: s.limits.reportToken, body: { reason: 'OTHER', context: 'profile' } });
      r.check('restart: the report limit survives', rep.body?.error?.code === 'RATE_LIMITED');
    }
  }
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
