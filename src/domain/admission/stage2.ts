/**
 * Stage 2 — the extended application (ADMISSION_FLOW §10, SCREEN_MAP EXT-*).
 *
 * Requested only after EXTENDED_APPLICATION_REQUIRED (DEC-012). Completing it
 * leads to FINAL_REVIEW, never to approval (DEC-013).
 *
 * Built in this pass: EXT-00 intro, EXT-01 photos, EXT-02 occupation,
 * EXT-03 work context, EXT-04 what you do, EXT-05 about you, EXT-06 interests,
 * EXT-07 intent, EXT-12 profile preview, EXT-13 extended review.
 * EXT-08 dating preferences (who you'd like to meet, age range) — asked ONLY
 * when the applicant chose Dating; skipped entirely otherwise (DEC-040).
 * Not yet: EXT-09 education, EXT-10 portfolio, EXT-11 additional verification.
 */
import { normalizeName } from '../validation/name';
import { invalid, valid, type Validation } from '../validation/result';

export const STAGE2_STEPS = [
  'intro',
  'photos',
  'occupation',
  'work-context',
  'what-you-do',
  'about-you',
  'interests',
  'intent',
  'meet',
  'age-range',
  'preview',
  'review',
] as const;

export type Stage2Step = (typeof STAGE2_STEPS)[number];

/** Asked only when the applicant chose Dating (DEC-040). */
export const DATING_STEPS = ['meet', 'age-range'] as const satisfies readonly Stage2Step[];
type DatingStep = (typeof DATING_STEPS)[number];

export function isDatingStep(step: Stage2Step): step is DatingStep {
  return (DATING_STEPS as readonly string[]).includes(step);
}

/** The questions every applicant answers (dating steps are added only when relevant). */
export const STAGE2_QUESTION_STEPS = STAGE2_STEPS.filter(
  (s) => s !== 'intro' && s !== 'preview' && s !== 'review' && !isDatingStep(s),
) as Exclude<Stage2Step, 'intro' | 'preview' | 'review' | DatingStep>[];

type IntentSource = Pick<ExtendedDraft, 'intents'>;

export function wantsDating(d: IntentSource): boolean {
  return d.intents.includes('dating');
}

/** A step applies to this applicant (dating steps only when Dating was chosen). */
export function isStage2StepApplicable(d: IntentSource, step: Stage2Step): boolean {
  return !isDatingStep(step) || wantsDating(d);
}

export function stage2StepsFor(d: IntentSource): Stage2Step[] {
  return STAGE2_STEPS.filter((s) => isStage2StepApplicable(d, s));
}

export function stage2QuestionStepsFor(d: IntentSource): Stage2Step[] {
  return stage2StepsFor(d).filter((s) => s !== 'intro' && s !== 'preview' && s !== 'review');
}

export function stage2QuestionIndex(step: Stage2Step, d: IntentSource = { intents: [] }): number | null {
  const i = stage2QuestionStepsFor(d).indexOf(step);
  return i === -1 ? null : i;
}

export function nextStage2Step(step: Stage2Step, d: IntentSource = { intents: [] }): Stage2Step | null {
  const steps = stage2StepsFor(d);
  const i = steps.indexOf(step);
  if (i !== -1) return steps[i + 1] ?? null;
  // The step is no longer applicable (e.g. Dating was just unchosen): continue after it.
  return STAGE2_STEPS.slice(STAGE2_STEPS.indexOf(step) + 1).find((s) => isStage2StepApplicable(d, s)) ?? null;
}

// --- Limits (photo min/max is a pending decision; ADMISSION_FLOW targets 3–6) ---
export const PHOTO_MIN = 3;
export const PHOTO_MAX = 6;
export const OCCUPATION_MAX = 60;
export const LONG_TEXT_MIN = 40;
export const WHAT_YOU_DO_MAX = 400;
export const ABOUT_YOU_MAX = 500;
export const INTERESTS_MIN = 3;
export const INTERESTS_MAX = 8;

// --- Answers ------------------------------------------------------------------

/** A photo already uploaded to the server. `uri` is for display on this device only. */
export type ApplicationPhoto = {
  id: string;
  uri: string;
  width: number;
  height: number;
  moderationStatus: 'pending' | 'approved' | 'rejected';
};

export type WorkContextAnswer =
  | { kind: 'organisation'; name: string }
  | { kind: 'independent' }
  | { kind: 'not_shared' };

export const INTENTS = ['dating', 'friendship', 'community'] as const;
export type Intent = (typeof INTENTS)[number];

// --- Dating preferences (private matching data — DEC-040) -------------------------

/**
 * Who the applicant would like to meet. A catalogue of option ids rather than
 * a fixed enum, so the taxonomy can grow without changing the stored shape.
 * An `exclusive` option replaces any other choice. Nothing here is inferred
 * from the applicant. The member's own dating identity is asked only after
 * activation, and only of members using Dating (DEC-058); the member record
 * stores these choices as normalised categories (src/domain/member/dating.ts).
 */
export const MEET_OPTIONS = [
  { id: 'women', exclusive: false },
  { id: 'men', exclusive: false },
  { id: 'non_binary', exclusive: false },
  { id: 'everyone', exclusive: true },
] as const satisfies readonly { id: string; exclusive: boolean }[];

export type MeetOptionId = string;

/** Platform limits for an age-range preference. Members are 18+. */
export const AGE_PREFERENCE_MIN = 18;
export const AGE_PREFERENCE_MAX = 80;
/** The range always covers at least two ages. */
export const AGE_PREFERENCE_MIN_SPAN = 1;

export type AgeRange = { min: number; max: number };

export type DatingPreferences = { meet: MeetOptionId[]; ageRange: AgeRange };

export type DatingPreferencesDraft = { meet: MeetOptionId[]; ageRange: AgeRange | null };

export const EMPTY_DATING_PREFERENCES: DatingPreferencesDraft = { meet: [], ageRange: null };

/** Toggle one option, honouring exclusive options ("Everyone" replaces the rest). */
export function toggleMeetOption(current: readonly MeetOptionId[], id: MeetOptionId): MeetOptionId[] {
  const option = MEET_OPTIONS.find((o) => o.id === id);
  if (!option) return [...current];
  if (current.includes(id)) return current.filter((c) => c !== id);
  if (option.exclusive) return [id];
  const exclusive = new Set<string>(MEET_OPTIONS.filter((o) => o.exclusive).map((o) => o.id));
  return [...current.filter((c) => !exclusive.has(c)), id];
}

export function validateMeet(selected: readonly string[]): Validation<MeetOptionId[], 'required' | 'unknown' | 'conflict'> {
  const unique = [...new Set(selected)];
  if (unique.length === 0) return invalid('required');
  if (unique.some((id) => !MEET_OPTIONS.some((o) => o.id === id))) return invalid('unknown');
  const exclusive = unique.filter((id) => MEET_OPTIONS.find((o) => o.id === id)?.exclusive);
  if (exclusive.length > 0 && unique.length > 1) return invalid('conflict');
  return valid(unique);
}

export type AgeRangeError = 'invalid' | 'out_of_bounds' | 'too_narrow';

export function validateAgeRange(range: AgeRange): Validation<AgeRange, AgeRangeError> {
  const { min, max } = range;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return invalid('invalid');
  if (min < AGE_PREFERENCE_MIN || max > AGE_PREFERENCE_MAX) return invalid('out_of_bounds');
  if (max - min < AGE_PREFERENCE_MIN_SPAN) return invalid('too_narrow');
  return valid({ min, max });
}

/** A neutral starting range around the applicant's own age, always adjustable. */
export function suggestedAgeRange(applicantAge: number | null): AgeRange {
  if (applicantAge === null) return { min: 25, max: 40 };
  const min = Math.max(AGE_PREFERENCE_MIN, Math.min(applicantAge - 6, AGE_PREFERENCE_MAX - 12));
  const max = Math.min(AGE_PREFERENCE_MAX, Math.max(applicantAge + 6, min + 12));
  return { min, max };
}

export function validateDatingPreferences(
  intents: readonly string[],
  prefs: DatingPreferences | null,
): Validation<DatingPreferences | null, 'required' | 'not_applicable' | 'invalid'> {
  const dating = intents.includes('dating');
  if (!dating) return prefs === null ? valid(null) : invalid('not_applicable');
  if (!prefs) return invalid('required');
  const meet = validateMeet(prefs.meet);
  const range = validateAgeRange(prefs.ageRange);
  if (!meet.ok || !range.ok) return invalid('invalid');
  return valid({ meet: meet.value, ageRange: range.value });
}

export type ExtendedDraft = {
  introAcknowledged: boolean;
  photos: ApplicationPhoto[];
  occupation: string | null;
  workContext: WorkContextAnswer | null;
  whatYouDo: string | null;
  aboutYou: string | null;
  interests: string[];
  intents: Intent[];
  /** Only collected when Dating is chosen; cleared if Dating is unchosen. Never public. */
  datingPreferences: DatingPreferencesDraft;
  previewSeen: boolean;
  updatedAt: string | null;
};

export const EMPTY_EXTENDED_DRAFT: ExtendedDraft = {
  introAcknowledged: false,
  photos: [],
  occupation: null,
  workContext: null,
  whatYouDo: null,
  aboutYou: null,
  interests: [],
  intents: [],
  datingPreferences: EMPTY_DATING_PREFERENCES,
  previewSeen: false,
  updatedAt: null,
};

/**
 * Curated interests (ADMISSION_FLOW: "avoid hundreds of meaningless tags").
 * Deliberately free of wealth signals. Exact taxonomy is a pending decision.
 */
export const INTEREST_CATALOGUE = [
  'Architecture', 'Art', 'Books', 'Ceramics', 'Cinema', 'Classical music', 'Cooking',
  'Dance', 'Design', 'Diving', 'Fashion', 'Gardening', 'History', 'Hiking', 'Jazz',
  'Languages', 'Live music', 'Philosophy', 'Photography', 'Poetry', 'Running', 'Sailing',
  'Science', 'Skiing', 'Swimming', 'Tennis', 'Theatre', 'Travel', 'Wine', 'Writing', 'Yoga',
] as const;

/** The catalogue presented as a few curated rooms rather than one tag cloud. */
export const INTEREST_GROUPS = [
  { id: 'culture', label: 'Culture', items: ['Architecture', 'Art', 'Ceramics', 'Cinema', 'Design', 'Fashion', 'Photography', 'Theatre'] },
  { id: 'ideas', label: 'Ideas', items: ['Books', 'History', 'Languages', 'Philosophy', 'Poetry', 'Science', 'Writing'] },
  { id: 'music', label: 'Music', items: ['Classical music', 'Dance', 'Jazz', 'Live music'] },
  { id: 'outdoors', label: 'Outdoors', items: ['Diving', 'Hiking', 'Running', 'Sailing', 'Skiing', 'Swimming', 'Tennis', 'Yoga'] },
  { id: 'living', label: 'Living', items: ['Cooking', 'Gardening', 'Travel', 'Wine'] },
] as const satisfies readonly { id: string; label: string; items: readonly (typeof INTEREST_CATALOGUE)[number][] }[];

export type InterestGroupId = (typeof INTEREST_GROUPS)[number]['id'];

// --- Validation -------------------------------------------------------------------

export type ShortTextError = 'required' | 'too_long' | 'invalid_characters';
export type LongTextError = 'required' | 'too_short' | 'too_long';

const SHORT_TEXT = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} '’\-&.,/()+]*$/u;

/** Collapse spaces on one-line answers; keep paragraph breaks on long answers. */
export function normalizeLongText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function validateShortText(raw: string, max = OCCUPATION_MAX): Validation<string, ShortTextError> {
  const v = normalizeName(raw);
  if (v.length < 2) return invalid('required');
  if (v.length > max) return invalid('too_long');
  if (!SHORT_TEXT.test(v)) return invalid('invalid_characters');
  return valid(v);
}

export function validateLongText(raw: string, max: number, min = LONG_TEXT_MIN): Validation<string, LongTextError> {
  const v = normalizeLongText(raw);
  if (v.length === 0) return invalid('required');
  if (v.length < min) return invalid('too_short');
  if (v.length > max) return invalid('too_long');
  return valid(v);
}

export function validateInterests(selected: readonly string[]): Validation<string[], 'too_few' | 'too_many' | 'unknown'> {
  const unique = [...new Set(selected)];
  if (unique.some((i) => !(INTEREST_CATALOGUE as readonly string[]).includes(i))) return invalid('unknown');
  if (unique.length < INTERESTS_MIN) return invalid('too_few');
  if (unique.length > INTERESTS_MAX) return invalid('too_many');
  return valid(unique);
}

export function validateIntents(selected: readonly string[]): Validation<Intent[], 'required' | 'unknown'> {
  const unique = [...new Set(selected)];
  if (unique.some((i) => !(INTENTS as readonly string[]).includes(i))) return invalid('unknown');
  if (unique.length === 0) return invalid('required');
  return valid(unique as Intent[]);
}

export function validateWorkContext(a: WorkContextAnswer): Validation<WorkContextAnswer, ShortTextError> {
  if (a.kind !== 'organisation') return valid(a);
  const name = validateShortText(a.name);
  return name.ok ? valid({ kind: 'organisation', name: name.value }) : name;
}

// --- Completion ---------------------------------------------------------------------

export function isStage2StepComplete(d: ExtendedDraft, step: Stage2Step): boolean {
  switch (step) {
    case 'intro':
      return d.introAcknowledged;
    case 'photos':
      return d.photos.length >= PHOTO_MIN && d.photos.length <= PHOTO_MAX;
    case 'occupation':
      return d.occupation !== null && validateShortText(d.occupation).ok;
    case 'work-context':
      return d.workContext !== null && validateWorkContext(d.workContext).ok;
    case 'what-you-do':
      return d.whatYouDo !== null && validateLongText(d.whatYouDo, WHAT_YOU_DO_MAX).ok;
    case 'about-you':
      return d.aboutYou !== null && validateLongText(d.aboutYou, ABOUT_YOU_MAX).ok;
    case 'interests':
      return validateInterests(d.interests).ok;
    case 'intent':
      return validateIntents(d.intents).ok;
    case 'meet':
      return !wantsDating(d) || validateMeet(d.datingPreferences.meet).ok;
    case 'age-range':
      return !wantsDating(d) || (d.datingPreferences.ageRange !== null && validateAgeRange(d.datingPreferences.ageRange).ok);
    case 'preview':
      return d.previewSeen;
    case 'review':
      return false;
  }
}

export function resumeStage2Step(d: ExtendedDraft): Stage2Step {
  return STAGE2_STEPS.find((s) => !isStage2StepComplete(d, s)) ?? 'review';
}

export function canOpenStage2Step(d: ExtendedDraft, step: Stage2Step): boolean {
  return STAGE2_STEPS.slice(0, STAGE2_STEPS.indexOf(step)).every((s) => isStage2StepComplete(d, s));
}

export type Stage2Submission = {
  photoIds: string[];
  occupation: string;
  workContext: WorkContextAnswer;
  whatYouDo: string;
  aboutYou: string;
  interests: string[];
  intents: Intent[];
  /** Present only when Dating is chosen. Private matching data, never public. */
  datingPreferences: DatingPreferences | null;
};

export function assembleStage2(
  d: ExtendedDraft,
): { ok: true; submission: Stage2Submission } | { ok: false; missing: Stage2Step[] } {
  const missing = STAGE2_STEPS.filter((s) => s !== 'review' && !isStage2StepComplete(d, s));
  if (missing.length || !d.occupation || !d.workContext || !d.whatYouDo || !d.aboutYou) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    submission: {
      photoIds: d.photos.map((p) => p.id),
      occupation: d.occupation,
      workContext: d.workContext,
      whatYouDo: d.whatYouDo,
      aboutYou: d.aboutYou,
      interests: [...d.interests],
      intents: [...d.intents],
      datingPreferences:
        wantsDating(d) && d.datingPreferences.ageRange
          ? { meet: [...d.datingPreferences.meet], ageRange: { ...d.datingPreferences.ageRange } }
          : null,
    },
  };
}

/** Defensive load of a persisted extended draft. */
export function sanitizeExtendedDraft(raw: Partial<ExtendedDraft> | undefined): ExtendedDraft {
  const d: ExtendedDraft = { ...EMPTY_EXTENDED_DRAFT, ...raw };
  d.photos = Array.isArray(d.photos) ? d.photos.slice(0, PHOTO_MAX) : [];
  d.interests = Array.isArray(d.interests) ? d.interests : [];
  d.intents = Array.isArray(d.intents) ? d.intents : [];
  const prefs = raw?.datingPreferences;
  d.datingPreferences = {
    meet: Array.isArray(prefs?.meet) ? prefs.meet.filter((m) => typeof m === 'string') : [],
    ageRange:
      prefs?.ageRange && validateAgeRange(prefs.ageRange).ok ? { min: prefs.ageRange.min, max: prefs.ageRange.max } : null,
  };
  return d;
}
