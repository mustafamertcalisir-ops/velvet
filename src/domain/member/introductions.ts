/**
 * Today's introductions — a finite, curated set per member per day (DEC-050),
 * made only of members who are eligible for each other (DEC-058).
 *
 * In this phase every introduction is a Dating introduction. The entry
 * carries its context so Friendship / Community introductions can be added
 * later without reshaping the data.
 *
 * Not a feed: a batch is chosen once for the day and never refilled. Its size
 * is server policy and never shown as a number.
 */
import type { ISODate, ISODateTime } from '../models';
import { datingEligibility, type DatingParticipant, type PairFacts } from './compatibility';

/** Server policy. Configurable; the UI never states these numbers. */
export type IntroductionPolicy = {
  /** Introductions chosen for one member per day. */
  perDay: number;
  /** A pass hides someone for the rest of the cycle and this many days after it. */
  passCooldownDays: number;
  /** Someone introduced on an earlier day is not introduced again for this many days. */
  reintroduceAfterDays: number;
  /**
   * Days after a match ENDED (not blocked) before the two may be introduced
   * again, as a fresh start. `null`: an ended match is never reintroduced —
   * the current product policy until a rematch rule is decided (DEC-060).
   */
  rematchAfterDays: number | null;
};

export const DEFAULT_INTRODUCTION_POLICY: IntroductionPolicy = {
  perDay: 6,
  passCooldownDays: 30,
  reintroduceAfterDays: 14,
  rematchAfterDays: null,
};

/** The viewer's match history with one other member, as exhaustion needs it. */
export type MatchHistoryItem = { otherId: string; status: 'ACTIVE' | 'ENDED' | 'BLOCKED'; endedOn: ISODate | null };

export const INTRODUCTION_CONTEXTS = ['DATING'] as const;
export type IntroductionContext = (typeof INTRODUCTION_CONTEXTS)[number];

export type IntroductionBatch = {
  id: string;
  /** The member these introductions are for (member profile id). */
  memberId: string;
  /** Calendar day of the cycle. */
  date: ISODate;
  /** Member profile ids, in curated order. Fixed once created. */
  profileIds: string[];
  createdAt: ISODateTime;
};

export type IntroductionStatus = 'PENDING' | 'PASSED' | 'LIKED' | 'WITHDRAWN';

/** One introduction: the unit a reaction answers. */
export type IntroductionEntry = {
  id: string;
  batchId: string;
  /** Batch day, denormalised for expiry checks. */
  date: ISODate;
  viewerId: string;
  candidateId: string;
  position: number;
  context: IntroductionContext;
  status: IntroductionStatus;
  respondedAt: ISODateTime | null;
  createdAt: ISODateTime;
};

/** Whole days between two calendar dates (b − a). */
export function daysBetween(a: ISODate, b: ISODate): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * Who is exhausted from the viewer's introduction cycle:
 * - an ACTIVE or BLOCKED match; an ENDED match until the rematch policy allows
 *   a fresh start (never, by default);
 * - liked — ever, within the pair's current cycle;
 * - passed within the cooldown;
 * - introduced on an earlier day within the window.
 * A fresh start after an ended match ignores reactions from before it ended.
 */
export function exhaustedCandidates(input: {
  today: ISODate;
  policy: IntroductionPolicy;
  reactions: readonly { toMemberId: string; type: 'PASS' | 'LIKE'; date: ISODate }[];
  matches: readonly MatchHistoryItem[];
  earlierIntroductions: readonly { candidateId: string; date: ISODate }[];
}): Set<string> {
  const { today, policy } = input;
  const out = new Set<string>();
  /** Candidates whose ended match is old enough for a fresh start → reactions up to that day no longer count. */
  const freshSince = new Map<string, ISODate>();
  for (const m of input.matches) {
    if (m.status !== 'ENDED') {
      out.add(m.otherId);
      continue;
    }
    const after = policy.rematchAfterDays;
    if (after === null || !m.endedOn || daysBetween(m.endedOn, today) < after) out.add(m.otherId);
    else if (!freshSince.has(m.otherId) || freshSince.get(m.otherId)! < m.endedOn) freshSince.set(m.otherId, m.endedOn);
  }
  for (const r of input.reactions) {
    const since = freshSince.get(r.toMemberId);
    if (since && r.date <= since) continue;
    if (r.type === 'LIKE') out.add(r.toMemberId);
    else if (daysBetween(r.date, today) < policy.passCooldownDays) out.add(r.toMemberId);
  }
  for (const e of input.earlierIntroductions) {
    const age = daysBetween(e.date, today);
    if (age > 0 && age < policy.reintroduceAfterDays) out.add(e.candidateId);
  }
  return out;
}

/**
 * Choose a day's Dating introductions: only candidates that pass the single
 * eligibility function, each at most once, at most `size`, ordered by the
 * server's curation `rank` (lower first, ties by id).
 */
export function selectDatingIntroductions(input: {
  viewer: DatingParticipant;
  candidates: readonly DatingParticipant[];
  pair: (candidateId: string) => PairFacts;
  size: number;
  rank: (memberId: string) => number;
}): string[] {
  const { viewer, candidates, pair, size, rank } = input;
  const seen = new Set<string>();
  const eligible: DatingParticipant[] = [];
  for (const c of candidates) {
    if (seen.has(c.memberId)) continue;
    seen.add(c.memberId);
    if (datingEligibility(viewer, c, pair(c.memberId)).eligible) eligible.push(c);
  }
  return eligible
    .sort((a, b) => rank(a.memberId) - rank(b.memberId) || a.memberId.localeCompare(b.memberId))
    .slice(0, Math.max(0, size))
    .map((c) => c.memberId);
}

/**
 * What is still waiting in today's batch: entries not yet answered, minus
 * anyone who became unavailable.
 */
export function remainingIntroductions(
  batch: Pick<IntroductionBatch, 'profileIds'>,
  state: { respondedTo: ReadonlySet<string>; unavailable: ReadonlySet<string> },
): string[] {
  return batch.profileIds.filter((id) => !state.respondedTo.has(id) && !state.unavailable.has(id));
}

/** Deterministic 32-bit hash — a stable stand-in for curation order in the mock. */
export function stableRank(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
