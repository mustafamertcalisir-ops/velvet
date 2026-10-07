/**
 * The Dating compatibility matrix (DEC-058) — one eligibility function, every
 * rule exercised in both directions.
 */
import { datingEligibility, isDatingCompatible, type DatingParticipant, type PairFacts } from '../member/compatibility';
import {
  DATING_CATEGORIES,
  seekingFromMeet,
  validateDatingIdentity,
  validateDatingSettingsInput,
  type DatingGenderId,
  type DatingGenderPreference,
} from '../member/dating';
import { DEFAULT_INTRODUCTION_POLICY, exhaustedCandidates, selectDatingIntroductions } from '../member/introductions';

const EVERYONE = [...DATING_CATEGORIES];
const free: PairFacts = { blocked: false, exhausted: false };

/** A member who completed Dating setup with a fixed answer (appears under their own category). */
function m(
  memberId: string,
  gender: Exclude<DatingGenderId, 'SELF_DESCRIBED'>,
  seeking: DatingGenderPreference[],
  over: Partial<DatingParticipant> & { range?: [number, number] } = {},
): DatingParticipant {
  const { range = [25, 45], ...rest } = over;
  return {
    memberId,
    active: true,
    visible: true,
    usesDating: true,
    age: 32,
    dating: { appearsAs: [gender], seeking, ageRange: { min: range[0], max: range[1] } },
    ...rest,
  };
}

/** A self-described member: only the chosen categories matter, never the words. */
function selfDescribed(memberId: string, appearsAs: DatingGenderPreference[], seeking: DatingGenderPreference[]): DatingParticipant {
  return { memberId, active: true, visible: true, usesDating: true, age: 32, dating: { appearsAs, seeking, ageRange: { min: 25, max: 45 } } };
}

const both = (a: DatingParticipant, b: DatingParticipant) => [isDatingCompatible(a, b), isDatingCompatible(b, a)];
const reason = (a: DatingParticipant, b: DatingParticipant, pair: PairFacts = free) => {
  const e = datingEligibility(a, b, pair);
  return e.eligible ? 'ELIGIBLE' : e.reason;
};

describe('gender preference reciprocity', () => {
  it('a woman seeking men and a man seeking women: compatible both ways', () => {
    const woman = m('w', 'WOMAN', ['MAN']);
    const man = m('m', 'MAN', ['WOMAN']);
    expect(both(woman, man)).toEqual([true, true]);
    expect(reason(woman, man)).toBe('ELIGIBLE');
  });

  it('a man seeking women is never introduced to a man seeking women', () => {
    expect(both(m('a', 'MAN', ['WOMAN']), m('b', 'MAN', ['WOMAN']))).toEqual([false, false]);
  });

  it('a woman seeking women and a man seeking women: one-sided interest is not enough', () => {
    const woman = m('w', 'WOMAN', ['WOMAN']);
    const man = m('m', 'MAN', ['WOMAN']);
    expect(reason(man, woman)).toBe('CANDIDATE_DOES_NOT_SEEK_VIEWER');
    expect(reason(woman, man)).toBe('VIEWER_DOES_NOT_SEEK_CANDIDATE');
  });

  it('two women seeking women: mutual', () => {
    expect(both(m('a', 'WOMAN', ['WOMAN']), m('b', 'WOMAN', ['WOMAN']))).toEqual([true, true]);
  });

  it('two men seeking men: mutual', () => {
    expect(both(m('a', 'MAN', ['MAN']), m('b', 'MAN', ['MAN']))).toEqual([true, true]);
  });

  it('non-binary members appear only to people looking to meet non-binary people', () => {
    const nb = m('nb', 'NON_BINARY', EVERYONE);
    expect(both(nb, m('w1', 'WOMAN', ['MAN']))).toEqual([false, false]);
    expect(both(nb, m('w2', 'WOMAN', ['MAN', 'NON_BINARY']))).toEqual([true, true]);
    expect(both(nb, m('nb2', 'NON_BINARY', ['NON_BINARY']))).toEqual([true, true]);
    expect(reason(m('m', 'MAN', ['WOMAN']), nb)).toBe('VIEWER_DOES_NOT_SEEK_CANDIDATE');
  });

  it('a non-binary member seeking only women is not introduced to men', () => {
    expect(reason(m('nb', 'NON_BINARY', ['WOMAN']), m('m', 'MAN', EVERYONE))).toBe('VIEWER_DOES_NOT_SEEK_CANDIDATE');
  });

  it('"Everyone" is every category — and still needs the other side to want to meet them', () => {
    const open = m('o', 'WOMAN', EVERYONE);
    expect(both(open, m('a', 'MAN', ['WOMAN']))).toEqual([true, true]);
    expect(both(open, m('b', 'NON_BINARY', ['WOMAN']))).toEqual([true, true]);
    expect(both(open, m('c', 'WOMAN', ['WOMAN']))).toEqual([true, true]);
    expect(both(open, m('d', 'MAN', ['MAN']))).toEqual([false, false]);
    expect(seekingFromMeet(['everyone'])).toEqual(EVERYONE);
    expect(seekingFromMeet(['women', 'non_binary'])).toEqual(['WOMAN', 'NON_BINARY']);
  });
});

describe('self-described members', () => {
  it('are included under the categories they chose — the free text is never classified', () => {
    const identity = validateDatingIdentity({ gender: 'SELF_DESCRIBED', selfDescription: '  Two-spirit,   mostly  ', appearsAs: ['NON_BINARY', 'WOMAN'] });
    expect(identity).toEqual({ ok: true, value: { gender: 'SELF_DESCRIBED', selfDescription: 'Two-spirit, mostly', appearsAs: ['WOMAN', 'NON_BINARY'] } });
    // The same words with a different choice of categories match differently: only the choice counts.
    const asWoman = selfDescribed('s1', ['WOMAN'], EVERYONE);
    const asNonBinary = selfDescribed('s2', ['NON_BINARY'], EVERYONE);
    const seeksWomen = m('m', 'MAN', ['WOMAN']);
    expect(isDatingCompatible(seeksWomen, asWoman)).toBe(true);
    expect(isDatingCompatible(seeksWomen, asNonBinary)).toBe(false);
  });

  it('appearing under several categories reaches people looking for any of them', () => {
    const s = selfDescribed('s', ['WOMAN', 'NON_BINARY'], ['MAN']);
    expect(isDatingCompatible(m('a', 'MAN', ['NON_BINARY']), s)).toBe(true);
    expect(isDatingCompatible(m('b', 'MAN', ['WOMAN']), s)).toBe(true);
    expect(isDatingCompatible(m('c', 'MAN', ['MAN']), s)).toBe(false);
  });

  it('must choose at least one category; a fixed answer cannot claim extra categories', () => {
    expect(validateDatingIdentity({ gender: 'SELF_DESCRIBED', selfDescription: 'Fluid', appearsAs: [] })).toEqual({ ok: false, error: 'categories_required' });
    expect(validateDatingIdentity({ gender: 'MAN', appearsAs: ['WOMAN'] })).toEqual({ ok: true, value: { gender: 'MAN', selfDescription: null, appearsAs: ['MAN'] } });
  });
});

describe('age ranges', () => {
  const woman = (age: number, range: [number, number]) => m('w', 'WOMAN', ['MAN'], { age, range });
  const man = (age: number, range: [number, number]) => m('m', 'MAN', ['WOMAN'], { age, range });

  it('compatible when each is inside the other’s range (bounds inclusive)', () => {
    expect(both(woman(30, [30, 40]), man(40, [30, 40]))).toEqual([true, true]);
  });

  it('mismatch when the candidate is outside the viewer’s range', () => {
    expect(reason(woman(30, [30, 35]), man(36, [25, 40]))).toBe('CANDIDATE_OUTSIDE_VIEWER_AGE_RANGE');
  });

  it('mismatch when the viewer is outside the candidate’s range — so neither sees the other', () => {
    expect(reason(woman(30, [25, 40]), man(36, [31, 40]))).toBe('VIEWER_OUTSIDE_CANDIDATE_AGE_RANGE');
    expect(reason(man(36, [31, 40]), woman(30, [25, 40]))).toBe('CANDIDATE_OUTSIDE_VIEWER_AGE_RANGE');
  });

  it('ranges are validated: adults only, ordered, a minimum span', () => {
    const base = { gender: 'WOMAN' as const, seeking: ['MAN' as const] };
    expect(validateDatingSettingsInput({ ...base, ageRange: { min: 17, max: 30 } })).toEqual({ ok: false, fields: ['ageRange'] });
    expect(validateDatingSettingsInput({ ...base, ageRange: { min: 35, max: 30 } })).toEqual({ ok: false, fields: ['ageRange'] });
    expect(validateDatingSettingsInput({ ...base, ageRange: { min: 28, max: 36 } }).ok).toBe(true);
  });
});

describe('membership, self, visibility, block, cycle and safety', () => {
  const a = m('a', 'WOMAN', ['MAN']);
  const b = m('b', 'MAN', ['WOMAN']);

  it('never yourself', () => {
    expect(reason(a, { ...a })).toBe('SELF');
  });

  it('both must be active members', () => {
    expect(reason({ ...a, active: false }, b)).toBe('VIEWER_INACTIVE');
    expect(reason(a, { ...b, active: false })).toBe('CANDIDATE_INACTIVE');
  });

  it('hidden profiles are not introduced', () => {
    expect(reason(a, { ...b, visible: false })).toBe('HIDDEN');
  });

  it('a block in either direction excludes the pair', () => {
    expect(reason(a, b, { blocked: true, exhausted: false })).toBe('BLOCKED');
    expect(reason(b, a, { blocked: true, exhausted: false })).toBe('BLOCKED');
  });

  it('members exhausted from the cycle are excluded', () => {
    expect(reason(a, b, { blocked: false, exhausted: true })).toBe('EXHAUSTED');
  });

  it('members not using Dating are never included — on either side', () => {
    expect(reason({ ...a, usesDating: false, dating: null }, b)).toBe('VIEWER_NOT_USING_DATING');
    expect(reason(a, { ...b, usesDating: false, dating: null })).toBe('CANDIDATE_NOT_USING_DATING');
  });

  it('Dating setup must be complete on both sides', () => {
    expect(reason({ ...a, dating: null }, b)).toBe('VIEWER_SETUP_INCOMPLETE');
    expect(reason(a, { ...b, dating: null })).toBe('CANDIDATE_SETUP_INCOMPLETE');
  });

  it('a future safety hold excludes the member (hook in place)', () => {
    expect(reason(a, { ...b, safetyHold: true })).toBe('SAFETY');
    expect(reason({ ...a, safetyHold: true }, b)).toBe('SAFETY');
  });
});

describe('exhaustion from the introduction cycle', () => {
  const today = '2026-10-20';
  const ex = (input: Partial<Parameters<typeof exhaustedCandidates>[0]>) =>
    exhaustedCandidates({ today, policy: DEFAULT_INTRODUCTION_POLICY, reactions: [], matches: [], earlierIntroductions: [], ...input });

  it('already passed: within the cooldown only', () => {
    expect(ex({ reactions: [{ toMemberId: 'x', type: 'PASS', date: '2026-09-21' }] }).has('x')).toBe(true); // 29 days
    expect(ex({ reactions: [{ toMemberId: 'x', type: 'PASS', date: '2026-09-20' }] }).has('x')).toBe(false); // 30 days
  });

  it('already liked: never again', () => {
    expect(ex({ reactions: [{ toMemberId: 'x', type: 'LIKE', date: '2020-01-01' }] }).has('x')).toBe(true);
  });

  it('an active or blocked match is always exhausted; an ended match is never reintroduced by default', () => {
    expect(ex({ matches: [{ otherId: 'x', status: 'ACTIVE', endedOn: null }] }).has('x')).toBe(true);
    expect(ex({ matches: [{ otherId: 'x', status: 'BLOCKED', endedOn: '2020-01-01' }] }).has('x')).toBe(true);
    expect(ex({ matches: [{ otherId: 'x', status: 'ENDED', endedOn: '2020-01-01' }] }).has('x')).toBe(true);
  });

  it('with a rematch policy, an ended match allows a fresh start — earlier reactions no longer count', () => {
    const policy = { ...DEFAULT_INTRODUCTION_POLICY, rematchAfterDays: 90 };
    const matches = [{ otherId: 'x', status: 'ENDED' as const, endedOn: '2026-05-01' }];
    const oldLike = [{ toMemberId: 'x', type: 'LIKE' as const, date: '2026-04-01' }];
    expect(ex({ policy, matches, reactions: oldLike }).has('x')).toBe(false); // 172 days later: a fresh start
    expect(ex({ policy, matches: [{ ...matches[0]!, endedOn: '2026-09-01' }], reactions: oldLike }).has('x')).toBe(true); // too soon
    expect(ex({ policy, matches, reactions: [...oldLike, { toMemberId: 'x', type: 'LIKE', date: '2026-10-01' }] }).has('x')).toBe(true); // liked again since
    // A block is never a fresh start, whatever the policy.
    expect(ex({ policy, matches: [{ otherId: 'x', status: 'BLOCKED', endedOn: '2020-01-01' }] }).has('x')).toBe(true);
  });

  it('already introduced: not within the window; today’s own batch does not count', () => {
    expect(ex({ earlierIntroductions: [{ candidateId: 'x', date: '2026-10-07' }] }).has('x')).toBe(true); // 13 days
    expect(ex({ earlierIntroductions: [{ candidateId: 'x', date: '2026-10-06' }] }).has('x')).toBe(false); // 14 days
    expect(ex({ earlierIntroductions: [{ candidateId: 'x', date: today }] }).has('x')).toBe(false);
  });
});

describe('batch generation uses only the eligibility function', () => {
  it('returns exactly the eligible members, ranked, capped', () => {
    const viewer = m('me', 'WOMAN', ['MAN', 'NON_BINARY'], { age: 31, range: [28, 38] });
    const candidates = [
      m('ok-1', 'MAN', ['WOMAN']),
      m('ok-2', 'NON_BINARY', EVERYONE),
      m('ok-3', 'MAN', EVERYONE),
      m('wrong-gender', 'WOMAN', ['WOMAN']),
      m('one-sided', 'MAN', ['MAN']),
      m('too-old', 'MAN', ['WOMAN'], { age: 39 }),
      m('she-too-young', 'MAN', ['WOMAN'], { range: [32, 40] }),
      m('blocked', 'MAN', ['WOMAN']),
      m('passed', 'MAN', ['WOMAN']),
      m('inactive', 'MAN', ['WOMAN'], { active: false }),
      { ...m('friends-only', 'MAN', ['WOMAN']), usesDating: false, dating: null },
      m('no-setup', 'MAN', ['WOMAN'], { dating: null }),
      viewer,
    ];
    const pair = (id: string): PairFacts => ({ blocked: id === 'blocked', exhausted: id === 'passed' });
    const rank = (id: string) => ({ 'ok-3': 0, 'ok-1': 1, 'ok-2': 2 } as Record<string, number>)[id] ?? 9;
    expect(selectDatingIntroductions({ viewer, candidates, pair, size: 6, rank })).toEqual(['ok-3', 'ok-1', 'ok-2']);
    expect(selectDatingIntroductions({ viewer, candidates, pair, size: 2, rank })).toEqual(['ok-3', 'ok-1']);
  });

  it('a viewer without Dating (or without setup) gets nobody', () => {
    const others = [m('a', 'MAN', EVERYONE), m('b', 'WOMAN', EVERYONE)];
    const args = { candidates: others, pair: () => free, size: 6, rank: () => 0 };
    expect(selectDatingIntroductions({ ...args, viewer: { ...m('me', 'WOMAN', EVERYONE), usesDating: false, dating: null } })).toEqual([]);
    expect(selectDatingIntroductions({ ...args, viewer: m('me', 'WOMAN', EVERYONE, { dating: null }) })).toEqual([]);
  });
});
