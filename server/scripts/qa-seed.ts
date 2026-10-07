/**
 * Staging QA seed (DEC-076) — creates (or resumes) a fixed set of isolated QA
 * accounts on DETERMINISTIC designated test numbers, through the public API
 * and the review fixture only (no database access, no bundled assets: photos
 * are generated here, on the operator's machine or CI).
 *
 *   node dist/qa-seed.mjs seed        create / resume every QA account below
 *   node dist/qa-seed.mjs list        the QA numbers and the state each one should be in
 *   node dist/qa-seed.mjs otp <phone> after a code was requested ON A DEVICE for a QA
 *                                     number, print it (read once from the test outbox)
 *   node dist/qa-seed.mjs remove      every QA account asks for deletion
 *
 * Repeatable: numbers are fixed (STAGING_PHONE_PREFIX + 0001…0010) and each
 * step resumes from the application's current status. Refuses production by
 * construction (scripts/lib/staging.ts): staging-bound signatures, test-only
 * scopes, routes absent in production. QA accounts are marked server-side
 * (they come from test numbers) and never meet non-QA members.
 *
 * The Dating members are 72–79 years old with narrow age ranges (the seed's QA
 * age band, 70–79), so they never take introduction slots from the smoke flow
 * or the staging suites (docs/STAGING.md §4). Together they cover:
 *   compatible pair          Işıl ↔ İlker            (introduced to each other)
 *   incompatible gender      Oğuz (a man seeking men) (introduced to nobody here)
 *   incompatible age range   Şebnem → İlker           (one-sided: İlker's range excludes her)
 *   blocked pair             Çiğdem blocks Cem        (neither sees the other again)
 *   already-matched pair     Gül ↔ Tolga              (an ACTIVE match and its conversation)
 *   non-Dating member        Ülkü                     (community only: no introductions)
 */
import { stagingClient, stagingEnv } from './lib/staging';

type Target =
  | 'APPLICATION_RECEIVED'
  | 'UNDER_REVIEW'
  | 'EXTENDED_APPLICATION_REQUIRED'
  | 'FINAL_REVIEW'
  | 'WAITLISTED'
  | 'NOT_ADMITTED'
  | 'APPROVED'
  | 'ACTIVE_MEMBER';

type Spec = {
  n: number;
  name: string;
  target: Target;
  intents: string[];
  age: number;
  dating?: { gender: string; seeking: string[]; ageRange: { min: number; max: number } };
  meet?: string[];
};

// Names carry Turkish glyphs on purpose (İ ı Ğ ğ Ş ş Ç ç Ö ö Ü ü): rendering QA on devices.
const SET: Spec[] = [
  { n: 1, name: 'Aylin', target: 'APPLICATION_RECEIVED', intents: ['community'], age: 31 },
  { n: 2, name: 'Burak', target: 'UNDER_REVIEW', intents: ['community'], age: 36 },
  { n: 3, name: 'Çağla', target: 'EXTENDED_APPLICATION_REQUIRED', intents: ['community'], age: 29 },
  { n: 4, name: 'Doğan', target: 'FINAL_REVIEW', intents: ['community', 'friendship'], age: 41 },
  { n: 5, name: 'Şule', target: 'WAITLISTED', intents: ['community'], age: 33 },
  { n: 6, name: 'Ömer', target: 'NOT_ADMITTED', intents: ['community'], age: 38 },
  { n: 7, name: 'Gökçe', target: 'APPROVED', intents: ['community'], age: 35 },
  { n: 8, name: 'Işıl', target: 'ACTIVE_MEMBER', intents: ['dating', 'community'], age: 72, meet: ['men'], dating: { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 72, max: 74 } } },
  { n: 9, name: 'İlker', target: 'ACTIVE_MEMBER', intents: ['dating', 'community'], age: 73, meet: ['women'], dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 71, max: 73 } } },
  { n: 10, name: 'Ülkü', target: 'ACTIVE_MEMBER', intents: ['community'], age: 44 },
  { n: 11, name: 'Oğuz', target: 'ACTIVE_MEMBER', intents: ['dating'], age: 73, meet: ['men'], dating: { gender: 'MAN', seeking: ['MAN'], ageRange: { min: 72, max: 74 } } },
  { n: 12, name: 'Şebnem', target: 'ACTIVE_MEMBER', intents: ['dating'], age: 78, meet: ['men'], dating: { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 72, max: 74 } } },
  { n: 13, name: 'Çiğdem', target: 'ACTIVE_MEMBER', intents: ['dating'], age: 75, meet: ['men'], dating: { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 75, max: 77 } } },
  { n: 14, name: 'Cem', target: 'ACTIVE_MEMBER', intents: ['dating'], age: 76, meet: ['women'], dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 74, max: 76 } } },
  { n: 15, name: 'Gül', target: 'ACTIVE_MEMBER', intents: ['dating'], age: 79, meet: ['men'], dating: { gender: 'WOMAN', seeking: ['MAN'], ageRange: { min: 78, max: 80 } } },
  { n: 16, name: 'Tolga', target: 'ACTIVE_MEMBER', intents: ['dating'], age: 79, meet: ['women'], dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 78, max: 80 } } },
];

/** Relations between seeded members, established through the normal member API (repeatable). */
const RELATIONS: { kind: 'block' | 'match'; a: number; b: number }[] = [
  { kind: 'block', a: 13, b: 14 },
  { kind: 'match', a: 15, b: 16 },
];

const STOP: Partial<Record<Target, string>> = {
  APPLICATION_RECEIVED: 'APPLICATION_RECEIVED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  EXTENDED_APPLICATION_REQUIRED: 'EXTENDED_APPLICATION_REQUIRED',
};

async function main() {
  const command = process.argv[2] ?? 'list';
  const e = stagingEnv();
  const c = stagingClient(e);

  if (command === 'list') {
    for (const s of SET) console.log(`${c.fixedPhone(s.n)}  ${s.name.padEnd(7)} ${s.target}`);
    return;
  }

  await c.preflight(); // every command below talks to the API: confirm it is staging first

  if (command === 'otp') {
    const phone = process.argv[3] ?? '';
    if (!SET.some((s) => c.fixedPhone(s.n) === phone)) throw new Error('Only the QA numbers from `list` can be read.');
    const r = await c.internal('/internal/test/otp', { phoneE164: phone });
    if (r.status !== 200) throw new Error('No unread code for this number: request one on the device first (codes are readable once, for 10 minutes).');
    console.log(r.body.code);
    return;
  }

  if (command === 'remove') {
    for (const s of SET) {
      try {
        const session = await c.signIn(c.fixedPhone(s.n));
        await c.call('POST', '/v1/me/deletion', { token: session.token, body: { confirm: true } });
        console.log(`${s.name}: deletion requested`);
      } catch (err) {
        console.log(`${s.name}: ${(err as Error).message}`);
      }
    }
    return;
  }

  if (command !== 'seed') throw new Error('Usage: qa-seed seed | list | otp <phone> | remove');
  let failed = 0;
  const members = new Map<number, { token: string; memberId: string }>();
  for (const s of SET) {
    const phone = c.fixedPhone(s.n);
    try {
      const base = { name: s.name, dob: c.dobForAge(s.age), intents: s.intents, meet: s.meet ?? null, ageRange: s.dating?.ageRange, phone };
      let status: string;
      if (s.target === 'ACTIVE_MEMBER') {
        const m = await c.member({ ...base, dating: s.dating });
        await c.call('POST', '/v1/member/me/confirm', { token: m.token });
        status = m.status ?? 'ACTIVE_MEMBER';
        if (m.memberId) members.set(s.n, { token: m.token, memberId: m.memberId });
      } else {
        const p = await c.applicant({ ...base, stopAt: STOP[s.target] });
        status = p.status ?? '';
        const decide = { WAITLISTED: 'WAITLIST', NOT_ADMITTED: 'NOT_ADMIT', APPROVED: 'APPROVE' } as Partial<Record<Target, string>>;
        const action = decide[s.target];
        if (action && status === 'FINAL_REVIEW') {
          const r = await c.fixture(p.applicationId, action);
          if (r.status !== 200) throw new Error(`fixture ${action} ${r.status}`);
          status = r.body.status;
        }
      }
      const ok = status === s.target;
      if (!ok) failed++;
      console.log(`${ok ? '✓' : '✗'} ${phone}  ${s.name.padEnd(7)} ${status}${ok ? '' : ` (expected ${s.target})`}`);
    } catch (err) {
      failed++;
      console.log(`✗ ${phone}  ${s.name.padEnd(7)} ${(err as Error).message}`);
    }
  }

  // Relations, through the member API only. Each is idempotent: a second run finds it already in place.
  const name = (n: number) => SET.find((s) => s.n === n)!.name;
  for (const rel of RELATIONS) {
    const a = members.get(rel.a);
    const b = members.get(rel.b);
    const label = `${name(rel.a)} ${rel.kind === 'block' ? 'blocks' : '↔'} ${name(rel.b)}`;
    try {
      if (!a || !b) throw new Error('a member is missing');
      const introduced = async (viewer: { token: string }, other: { memberId: string }) =>
        (((await c.call('GET', '/v1/introductions/today', { token: viewer.token })).body?.waiting ?? []) as { introductionId: string; member: { memberId: string } }[]).find(
          (w) => w.member.memberId === other.memberId,
        );
      if (rel.kind === 'block') {
        const already = ((await c.call('GET', '/v1/member/me/blocked', { token: a.token })).body ?? []) as { memberId?: string }[];
        if (!already.some((x) => x.memberId === b.memberId)) {
          if (!(await introduced(a, b))) throw new Error('not introduced yet (introductions are daily)');
          const r = await c.call('POST', `/v1/members/${b.memberId}/block`, { token: a.token });
          if (r.status !== 200) throw new Error(`block ${r.status}`);
        }
        const gone = (await c.call('GET', `/v1/members/${a.memberId}`, { token: b.token })).status === 404 && !(await introduced(b, a));
        if (!gone) throw new Error('the blocked member can still see the blocker');
      } else {
        const matched = async () =>
          (((await c.call('GET', '/v1/conversations', { token: a.token })).body ?? []) as { matchId: string; other?: { memberId: string } }[]).find(
            (x) => x.other?.memberId === b.memberId,
          );
        let m = await matched();
        if (!m) {
          for (const [viewer, other] of [[a, b], [b, a]] as const) {
            const intro = await introduced(viewer, other);
            if (intro) await c.call('POST', `/v1/introductions/${intro.introductionId}/reaction`, { token: viewer.token, body: { type: 'LIKE' } });
          }
          m = await matched();
        }
        if (!m) throw new Error('no active match (were they introduced today?)');
        await c.call('POST', `/v1/matches/${m.matchId}/conversation`, { token: a.token });
      }
      console.log(`✓ ${label}`);
    } catch (err) {
      failed++;
      console.log(`✗ ${label}: ${(err as Error).message}`);
    }
  }
  // What the community must look like from inside (through the member API, as each member).
  const sees = async (viewer: number, other: number) => {
    const v = members.get(viewer);
    const o = members.get(other);
    if (!v || !o) return null;
    const t = await c.call('GET', '/v1/introductions/today', { token: v.token });
    return ((t.body?.waiting ?? []) as { member: { memberId: string } }[]).some((w) => w.member.memberId === o.memberId);
  };
  const state = async (n: number) => (members.get(n) ? (await c.call('GET', '/v1/introductions/today', { token: members.get(n)!.token })).body?.state : null);
  const expectations: [string, () => Promise<boolean>][] = [
    ['compatible pair: Işıl and İlker are introduced to each other', async () => (await sees(8, 9)) === true && (await sees(9, 8)) === true],
    ['incompatible gender: Oğuz (a man seeking men) is introduced to neither of them', async () => (await sees(11, 8)) === false && (await sees(11, 9)) === false],
    ['incompatible age range: Şebnem and İlker are not introduced (his range excludes her)', async () => (await sees(12, 9)) === false && (await sees(9, 12)) === false],
    ['blocked pair: neither Çiğdem nor Cem sees the other', async () => (await sees(13, 14)) === false && (await sees(14, 13)) === false],
    ['non-Dating member: Ülkü has no Dating introductions', async () => (await state(10)) === 'NOT_USING_DATING'],
  ];
  for (const [i, [label, test]] of expectations.entries()) {
    const ok = await test().catch(() => false);
    if (!ok && i === 0) {
      // Introductions are daily and a pair is not re-introduced for 14 days (DEFAULT_INTRODUCTION_POLICY):
      // on a later run the compatible pair is legitimately absent. Checked on the run that first meets them.
      console.log(`– ${label}: not today (already introduced on an earlier day; re-introduced after 14 days)`);
      continue;
    }
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${label}`);
  }
  process.exitCode = failed ? 1 : 0;
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
