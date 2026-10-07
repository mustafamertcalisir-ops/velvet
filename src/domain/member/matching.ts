/**
 * Reactions and matches. The server owns these: a client can only ask to
 * react, and a Match exists only when both members liked each other — the
 * server decides that here, never the device (DEC-051).
 *
 * Deliberately absent: super likes, boosts, undo, counters, scores.
 */
import type { ISODateTime } from '../models';

export const REACTION_TYPES = ['PASS', 'LIKE'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export function isReactionType(v: unknown): v is ReactionType {
  return typeof v === 'string' && (REACTION_TYPES as readonly string[]).includes(v);
}

export type MemberReaction = {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  type: ReactionType;
  /** The introduction this reaction answered (one reaction per introduction). */
  introductionId: string | null;
  /** The introduction batch the reaction answered. */
  batchId: string | null;
  createdAt: ISODateTime;
};

/**
 * Match lifecycle (DEC-060, revised). A pair may have at most ONE ACTIVE match
 * at a time; ended matches stay as history and remain auditable.
 *   ACTIVE   — both liked each other; conversation possible
 *   ENDED    — closed without a block (unmatch, membership ended, account deleted)
 *   BLOCKED  — closed by a block; while a block exists no new match can form
 * Rematching after ENDED is allowed by the data model; whether introductions
 * ever bring the two people together again is introduction policy
 * (`IntroductionPolicy.rematchAfterDays`).
 */
export const MATCH_STATUSES = ['ACTIVE', 'ENDED', 'BLOCKED'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export type MatchEndReason = 'BLOCK' | 'UNMATCH' | 'MEMBERSHIP_ENDED' | 'ACCOUNT_DELETED';

export type Match = {
  id: string;
  /** Sorted pair of member profile ids. */
  memberIds: [string, string];
  /** The canonical pair. At most one ACTIVE match per pair key; history may repeat it. */
  pairKey: string;
  status: MatchStatus;
  createdAt: ISODateTime;
  /** When the match left ACTIVE. Null while ACTIVE. */
  endedAt: ISODateTime | null;
  /** Internal; never shown to members. */
  endReason: MatchEndReason | null;
};

/** The status a match moves to when it ends for `reason`. */
export function endedStatus(reason: MatchEndReason): Exclude<MatchStatus, 'ACTIVE'> {
  return reason === 'BLOCK' ? 'BLOCKED' : 'ENDED';
}

/** Match records persisted before the lifecycle existed. */
export function normalizeMatch(m: Omit<Match, 'status' | 'endReason'> & Partial<Pick<Match, 'status' | 'endReason'>>): Match {
  return { ...m, status: m.status ?? (m.endedAt ? 'ENDED' : 'ACTIVE'), endReason: m.endReason ?? null };
}

/**
 * Did `from` like `to` in the CURRENT cycle of the pair — i.e. after the
 * pair's most recent ended match? A like given before an earlier match
 * ended never counts again: a new match needs two new likes.
 */
export function likedSince(
  reactions: readonly Pick<MemberReaction, 'fromMemberId' | 'toMemberId' | 'type' | 'createdAt'>[],
  from: string,
  to: string,
  since: ISODateTime | null,
): boolean {
  return reactions.some((r) => r.fromMemberId === from && r.toMemberId === to && r.type === 'LIKE' && (since === null || r.createdAt > since));
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export type ReactionError =
  | 'INTRODUCTION_NOT_FOUND'
  | 'INTRODUCTION_EXPIRED'
  | 'NOT_ELIGIBLE'
  | 'REACTION_ALREADY_RECORDED';

export type ReactionDecision =
  /** Record the reaction; create a match only when `createsMatch`. */
  | { ok: true; outcome: 'RECORD'; createsMatch: boolean }
  /** The same reaction was already recorded (double tap, retry, replay): answer as before. */
  | { ok: true; outcome: 'REPLAY' }
  | { ok: false; error: ReactionError };

/**
 * Decide one reaction to one introduction. Idempotent by design: an
 * introduction takes exactly one answer; repeating it replays the result,
 * a different answer is refused.
 *
 * - Only the member the introduction was made for can answer it.
 * - Only today's introductions can be answered.
 * - The pair must still be eligible (the single eligibility function,
 *   evaluated by the caller): blocks, membership, preferences.
 * - A like creates a match only if the other member already liked back in
 *   the pair's current cycle and no ACTIVE match exists for the pair. No super
 *   likes, boosts, undo or scores.
 */
export function decideReaction(input: {
  entry: { viewerId: string; date: string; status: string } | null;
  viewerId: string;
  type: ReactionType;
  today: string;
  /** The answer already recorded on this introduction, if any. */
  existing: ReactionType | null;
  eligible: boolean;
  /** The other member already liked the viewer in the pair's current cycle (see `likedSince`). */
  likedBack: boolean;
  /** An ACTIVE match already exists for the pair. */
  activeMatch: boolean;
}): ReactionDecision {
  const { entry, viewerId, type, today, existing, eligible, likedBack, activeMatch } = input;
  if (!entry || entry.viewerId !== viewerId) return { ok: false, error: 'INTRODUCTION_NOT_FOUND' };
  if (existing) return existing === type ? { ok: true, outcome: 'REPLAY' } : { ok: false, error: 'REACTION_ALREADY_RECORDED' };
  if (entry.date < today) return { ok: false, error: 'INTRODUCTION_EXPIRED' };
  if (entry.status === 'WITHDRAWN' || !eligible) return { ok: false, error: 'NOT_ELIGIBLE' };
  return { ok: true, outcome: 'RECORD', createsMatch: type === 'LIKE' && likedBack && !activeMatch };
}

export function otherMember(match: Pick<Match, 'memberIds'>, self: string): string {
  return match.memberIds[0] === self ? match.memberIds[1] : match.memberIds[0];
}
