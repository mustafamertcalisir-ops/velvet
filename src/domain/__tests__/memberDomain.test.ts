import {
  canSendMessage,
  dayLabel,
  groupMessages,
  normalizeMessage,
  validateMessage,
  MESSAGE_MAX,
} from '../member/conversation';
import type { DatingParticipant } from '../member/compatibility';
import {
  exhaustedCandidates,
  remainingIntroductions,
  selectDatingIntroductions,
  DEFAULT_INTRODUCTION_POLICY,
} from '../member/introductions';
import { decideReaction, endedStatus, likedSince, normalizeMatch, pairKey } from '../member/matching';
import { validateMemberProfilePatch } from '../member/profileEdit';
import { blockedSet, isBlockedBetween } from '../member/safety';
import {
  MEMBER_VIEW_FIELDS,
  memberPresentation,
  projectMemberProfile,
  type _NoPrivateFieldsOnMemberView,
} from '../member/views';
import type { MemberProfileMedia, PublicMemberProfile } from '../models';

/** A Dating participant who would be compatible with every other default one. */
const p = (memberId: string, over: Partial<DatingParticipant> = {}): DatingParticipant => ({
  memberId,
  active: true,
  visible: true,
  usesDating: true,
  age: 32,
  dating: { appearsAs: ['NON_BINARY'], seeking: ['NON_BINARY'], ageRange: { min: 25, max: 40 } },
  ...over,
});
const free = () => ({ blocked: false, exhausted: false });

describe('introductions', () => {
  it('selects a finite, ordered set of eligible members — no self, duplicates or ineligible members', () => {
    const viewer = p('me');
    const candidates = [p('me'), p('a'), p('b'), p('b'), p('c'), p('d', { visible: false }), p('e', { usesDating: false }), p('f'), p('g')];
    const ids = selectDatingIntroductions({
      viewer,
      candidates,
      pair: (id) => ({ blocked: id === 'c', exhausted: id === 'f' }),
      size: 2,
      rank: (id) => ({ g: 0, b: 1, a: 2 } as Record<string, number>)[id] ?? 9,
    });
    expect(ids).toEqual(['g', 'b']);
  });

  it('exhaustion: liked ever, passed within the cooldown, matched, introduced earlier within the window', () => {
    const out = exhaustedCandidates({
      today: '2026-10-20',
      policy: DEFAULT_INTRODUCTION_POLICY,
      reactions: [
        { toMemberId: 'liked-long-ago', type: 'LIKE', date: '2025-01-01' },
        { toMemberId: 'passed-recently', type: 'PASS', date: '2026-10-10' },
        { toMemberId: 'passed-long-ago', type: 'PASS', date: '2026-08-01' },
      ],
      matches: [{ otherId: 'matched', status: 'ENDED', endedOn: '2026-01-01' }],
      earlierIntroductions: [
        { candidateId: 'introduced-recently', date: '2026-10-15' },
        { candidateId: 'introduced-long-ago', date: '2026-09-01' },
        { candidateId: 'introduced-today', date: '2026-10-20' },
      ],
    });
    expect([...out].sort()).toEqual(['introduced-recently', 'liked-long-ago', 'matched', 'passed-recently']);
  });

  it('remaining introductions drop responses and unavailable members', () => {
    expect(
      remainingIntroductions({ profileIds: ['a', 'b', 'c', 'd'] }, { respondedTo: new Set(['b']), unavailable: new Set(['d']) }),
    ).toEqual(['a', 'c']);
  });

  it('selection uses the single eligibility function', () => {
    expect(selectDatingIntroductions({ viewer: p('me'), candidates: [p('x', { age: 50 })], pair: free, size: 5, rank: () => 0 })).toEqual([]);
  });
});

describe('reactions (one answer per introduction, idempotent)', () => {
  const entry = { viewerId: 'a', date: '2026-10-05', status: 'PENDING' };
  const base = {
    entry,
    viewerId: 'a',
    type: 'LIKE' as const,
    today: '2026-10-05',
    existing: null,
    eligible: true,
    likedBack: false,
    activeMatch: false,
  };

  it('a like alone does not match; a reciprocal like does; a pass never does', () => {
    expect(decideReaction(base)).toEqual({ ok: true, outcome: 'RECORD', createsMatch: false });
    expect(decideReaction({ ...base, likedBack: true })).toEqual({ ok: true, outcome: 'RECORD', createsMatch: true });
    expect(decideReaction({ ...base, type: 'PASS', likedBack: true })).toEqual({ ok: true, outcome: 'RECORD', createsMatch: false });
    expect(decideReaction({ ...base, likedBack: true, activeMatch: true })).toEqual({ ok: true, outcome: 'RECORD', createsMatch: false });
  });

  it('repeating the same answer replays; a different answer is refused', () => {
    expect(decideReaction({ ...base, existing: 'LIKE' })).toEqual({ ok: true, outcome: 'REPLAY' });
    expect(decideReaction({ ...base, existing: 'LIKE', type: 'PASS' })).toEqual({ ok: false, error: 'REACTION_ALREADY_RECORDED' });
  });

  it('refuses introductions that are not yours, expired or no longer eligible', () => {
    expect(decideReaction({ ...base, entry: null })).toEqual({ ok: false, error: 'INTRODUCTION_NOT_FOUND' });
    expect(decideReaction({ ...base, viewerId: 'b' })).toEqual({ ok: false, error: 'INTRODUCTION_NOT_FOUND' });
    expect(decideReaction({ ...base, today: '2026-10-06' })).toEqual({ ok: false, error: 'INTRODUCTION_EXPIRED' });
    expect(decideReaction({ ...base, eligible: false })).toEqual({ ok: false, error: 'NOT_ELIGIBLE' });
    expect(decideReaction({ ...base, entry: { ...entry, status: 'WITHDRAWN' } })).toEqual({ ok: false, error: 'NOT_ELIGIBLE' });
  });

  it('pair keys are order-independent, so a pair has one canonical key', () => {
    expect(pairKey('mem_b', 'mem_a')).toBe(pairKey('mem_a', 'mem_b'));
  });

  it('only likes from the pair\'s current cycle count: a new match needs two new likes', () => {
    const r = [
      { fromMemberId: 'b', toMemberId: 'a', type: 'LIKE' as const, createdAt: '2026-01-01T10:00:00.000Z' },
      { fromMemberId: 'b', toMemberId: 'a', type: 'PASS' as const, createdAt: '2026-06-01T10:00:00.000Z' },
    ];
    expect(likedSince(r, 'b', 'a', null)).toBe(true);
    expect(likedSince(r, 'b', 'a', '2026-02-01T00:00:00.000Z')).toBe(false); // that like predates the ended match
    expect(likedSince(r, 'a', 'b', null)).toBe(false);
  });

  it('match lifecycle: a block ends a match as BLOCKED, anything else as ENDED; old records gain a status', () => {
    expect(endedStatus('BLOCK')).toBe('BLOCKED');
    expect(endedStatus('UNMATCH')).toBe('ENDED');
    expect(endedStatus('ACCOUNT_DELETED')).toBe('ENDED');
    const old = { id: 'm', memberIds: ['a', 'b'] as [string, string], pairKey: 'a|b', createdAt: 'x', endedAt: null };
    expect(normalizeMatch(old).status).toBe('ACTIVE');
    expect(normalizeMatch({ ...old, endedAt: 'y' })).toMatchObject({ status: 'ENDED', endReason: null });
  });
});

describe('messages', () => {
  it('normalises and validates text', () => {
    expect(normalizeMessage('  Merhaba\r\n\r\n\r\n\r\nNasılsın?  ')).toBe('Merhaba\n\nNasılsın?');
    expect(validateMessage(' \n ')).toEqual({ ok: false, error: 'empty' });
    expect(validateMessage('x'.repeat(MESSAGE_MAX + 1))).toEqual({ ok: false, error: 'too_long' });
    expect(validateMessage('Çay mı, kahve mi?')).toEqual({ ok: true, value: 'Çay mı, kahve mi?' });
  });

  it('sending needs a participant, an active match, an open conversation and no block', () => {
    const ok = { isParticipant: true, matchActive: true, conversationOpen: true, blocked: false };
    expect(canSendMessage(ok)).toBe(true);
    for (const k of Object.keys(ok) as (keyof typeof ok)[]) {
      expect(canSendMessage({ ...ok, [k]: k === 'blocked' })).toBe(false);
    }
  });

  it('groups a thread into days and runs by sender', () => {
    const at = (h: number, m: number, d = 5) => new Date(2026, 9, d, h, m).toISOString();
    const days = groupMessages([
      { id: '1', fromSelf: true, body: 'a', createdAt: at(9, 0, 4) },
      { id: '2', fromSelf: true, body: 'b', createdAt: at(9, 0) },
      { id: '3', fromSelf: true, body: 'c', createdAt: at(9, 2) },
      { id: '4', fromSelf: false, body: 'd', createdAt: at(9, 3) },
      { id: '5', fromSelf: false, body: 'e', createdAt: at(10, 30) },
    ]);
    expect(days.map((d) => d.runs.map((r) => r.messages.map((m) => m.id)))).toEqual([[['1']], [['2', '3'], ['4'], ['5']]]);
    const now = new Date(2026, 9, 5, 12, 0);
    expect(dayLabel(days[1]!.day, now, { today: 'Today', yesterday: 'Yesterday' })).toBe('Today');
    expect(dayLabel(days[0]!.day, now, { today: 'Today', yesterday: 'Yesterday' })).toBe('Yesterday');
    expect(dayLabel('2026-09-28', now, { today: 'Today', yesterday: 'Yesterday' })).toBe('28 September');
    expect(dayLabel('2025-09-28', now, { today: 'Today', yesterday: 'Yesterday' })).toBe('28 September 2025');
  });
});

describe('member views', () => {
  const profile: PublicMemberProfile = {
    id: 'mem_1',
    userId: 'usr_secret',
    displayName: 'Deniz',
    age: 34,
    occupation: 'Architect',
    cityLabel: 'İstanbul',
    bio: null,
    knownFor: 'Libraries.',
    interests: ['Architecture', 'Jazz'],
    intents: ['dating', 'friendship'],
    visibility: 'visible',
    confirmedAt: null,
    createdAt: '',
    updatedAt: '',
  };
  const media: MemberProfileMedia[] = [
    { id: 'm2', memberProfileId: 'mem_1', type: 'photo', storageKey: 'u2', order: 1, width: null, height: null, sourceApplicationMediaId: null, createdAt: '' },
    { id: 'm1', memberProfileId: 'mem_1', type: 'photo', storageKey: 'u1', order: 0, width: null, height: null, sourceApplicationMediaId: null, createdAt: '' },
    { id: 'm3', memberProfileId: 'mem_1', type: 'photo', storageKey: 'u3', order: -1, width: null, height: null, sourceApplicationMediaId: null, createdAt: '' },
  ];

  it('projects exactly the whitelisted fields — never the account id', () => {
    const _a: _NoPrivateFieldsOnMemberView | undefined = undefined;
    expect(_a).toBeUndefined();
    const view = projectMemberProfile(profile, media, 34);
    expect(Object.keys(view).sort()).toEqual([...MEMBER_VIEW_FIELDS].sort());
    expect(JSON.stringify(view)).not.toContain('usr_secret');
    expect(view.photos.map((p) => p.id)).toEqual(['m1', 'm2']);
  });

  it('presents interests as a sentence and intent as one line', () => {
    const p = memberPresentation(projectMemberProfile(profile, media, 34));
    expect(p.interestsLine).toBe('Architecture and Jazz');
    expect(p.intentLine).toBe('Here for dating and friendship');
  });
});

describe('profile edits', () => {
  it('validates each editable field with the application rules', () => {
    const ids = ['p1', 'p2', 'p3', 'p4'];
    expect(validateMemberProfilePatch({ occupation: 'Architect', cityLabel: 'Ayvalık' }, { photoIds: ids })).toEqual({
      ok: true,
      value: { occupation: 'Architect', cityLabel: 'Ayvalık' },
    });
    expect(validateMemberProfilePatch({ knownFor: 'short' }, { photoIds: ids })).toEqual({ ok: false, fields: ['knownFor'] });
    expect(validateMemberProfilePatch({ photoOrder: ['p1', 'p2'] }, { photoIds: ids })).toEqual({ ok: false, fields: ['photoOrder'] });
    expect(validateMemberProfilePatch({ photoOrder: ['p1', 'p1', 'p2'] }, { photoIds: ids })).toEqual({ ok: false, fields: ['photoOrder'] });
    expect(validateMemberProfilePatch({ photoOrder: ['p4', 'p1', 'p2'] }, { photoIds: ids })).toEqual({ ok: true, value: { photoOrder: ['p4', 'p1', 'p2'] } });
  });
});

describe('blocks', () => {
  it('apply in both directions', () => {
    const blocks = [{ blockerId: 'a', blockedId: 'b' }];
    expect(isBlockedBetween(blocks, 'b', 'a')).toBe(true);
    expect([...blockedSet(blocks, 'b')]).toEqual(['a']);
    expect(isBlockedBetween(blocks, 'a', 'c')).toBe(false);
  });
});
