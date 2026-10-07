/**
 * Dating compatibility — the ONE place these rules live (DEC-058).
 *
 * Used by the server (mock and production) when generating a day's
 * introductions, when re-checking an introduction that is still waiting, and
 * when a reaction arrives. Screens never evaluate compatibility: they render
 * the batch the server sends, which contains only eligible members.
 *
 * Nothing here reads names, photos, Instagram, reviewer notes or free text.
 * Self-described members are matched only through the categories they chose.
 */
import type { AgeRange } from '../admission/stage2';
import type { DatingGenderPreference } from './dating';

/** What eligibility may know about one member. Server-side only. */
export type DatingParticipant = {
  memberId: string;
  /** ACTIVE_MEMBER with a live membership. */
  active: boolean;
  /** Profile visibility allows introductions. */
  visible: boolean;
  /** The member chose Dating among their intents. */
  usesDating: boolean;
  age: number;
  /** Null until Dating setup is complete. */
  dating: {
    appearsAs: readonly DatingGenderPreference[];
    seeking: readonly DatingGenderPreference[];
    ageRange: AgeRange;
  } | null;
  /** Reserved for future safety eligibility (e.g. a member under safety review). */
  safetyHold?: boolean;
};

/** Facts about this particular pair, from the viewer's side. */
export type PairFacts = {
  /** Either member blocked the other. */
  blocked: boolean;
  /**
   * Exhausted from the introduction cycle: already liked, passed within the
   * cooldown, matched (now or before), or introduced within the window.
   */
  exhausted: boolean;
};

export type IneligibleReason =
  | 'SELF'
  | 'VIEWER_INACTIVE'
  | 'CANDIDATE_INACTIVE'
  | 'HIDDEN'
  | 'BLOCKED'
  | 'EXHAUSTED'
  | 'VIEWER_NOT_USING_DATING'
  | 'CANDIDATE_NOT_USING_DATING'
  | 'VIEWER_SETUP_INCOMPLETE'
  | 'CANDIDATE_SETUP_INCOMPLETE'
  | 'VIEWER_DOES_NOT_SEEK_CANDIDATE'
  | 'CANDIDATE_DOES_NOT_SEEK_VIEWER'
  | 'CANDIDATE_OUTSIDE_VIEWER_AGE_RANGE'
  | 'VIEWER_OUTSIDE_CANDIDATE_AGE_RANGE'
  | 'SAFETY';

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

const within = (age: number, range: AgeRange) => age >= range.min && age <= range.max;
const overlaps = (a: readonly string[], b: readonly string[]) => a.some((x) => b.includes(x));

/**
 * Reciprocal preference and age compatibility (rules 6–9). Both members must
 * have completed Dating setup.
 */
export function isDatingCompatible(viewer: DatingParticipant, candidate: DatingParticipant): boolean {
  return datingPreferenceCheck(viewer, candidate) === null;
}

function datingPreferenceCheck(viewer: DatingParticipant, candidate: DatingParticipant): IneligibleReason | null {
  const v = viewer.dating;
  const c = candidate.dating;
  if (!v) return 'VIEWER_SETUP_INCOMPLETE';
  if (!c) return 'CANDIDATE_SETUP_INCOMPLETE';
  if (!overlaps(v.seeking, c.appearsAs)) return 'VIEWER_DOES_NOT_SEEK_CANDIDATE';
  if (!overlaps(c.seeking, v.appearsAs)) return 'CANDIDATE_DOES_NOT_SEEK_VIEWER';
  if (!within(candidate.age, v.ageRange)) return 'CANDIDATE_OUTSIDE_VIEWER_AGE_RANGE';
  if (!within(viewer.age, c.ageRange)) return 'VIEWER_OUTSIDE_CANDIDATE_AGE_RANGE';
  return null;
}

/**
 * Whether `candidate` may be introduced to `viewer` for Dating, with the
 * first reason it may not. Rules, in order:
 *  1–2 both are active members        3 not the same member
 *  4   no block either way           5 not exhausted from the cycle
 *  –   both use Dating and completed setup
 *  6–7 each seeks the other's categories
 *  8–9 each is inside the other's age range
 *  10  future safety rules
 */
export function datingEligibility(viewer: DatingParticipant, candidate: DatingParticipant, pair: PairFacts): Eligibility {
  const no = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason });
  if (!viewer.active) return no('VIEWER_INACTIVE');
  if (!candidate.active) return no('CANDIDATE_INACTIVE');
  if (viewer.memberId === candidate.memberId) return no('SELF');
  if (!candidate.visible) return no('HIDDEN');
  if (pair.blocked) return no('BLOCKED');
  if (pair.exhausted) return no('EXHAUSTED');
  if (!viewer.usesDating) return no('VIEWER_NOT_USING_DATING');
  if (!candidate.usesDating) return no('CANDIDATE_NOT_USING_DATING');
  const preference = datingPreferenceCheck(viewer, candidate);
  if (preference) return no(preference);
  if (viewer.safetyHold || candidate.safetyHold) return no('SAFETY');
  return { eligible: true };
}
