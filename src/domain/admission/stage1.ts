/**
 * Stage 1 — the short initial application (DEC-003).
 * Step order is defined once here; screens and progress read from it.
 */
import type {
  CityAnswer,
  CountryCode,
  InstagramAnswer,
  ReferralAnswer,
  Stage1Submission,
} from '../models';
import { validateName } from '../validation/name';
import { parseISODate, validateDateOfBirth, type CalendarDate } from '../validation/dateOfBirth';

export const STAGE1_STEPS = [
  'intro',
  'first-name',
  'last-name',
  'date-of-birth',
  'instagram',
  'country',
  'city',
  'referral',
  'review',
] as const;

export type Stage1Step = (typeof STAGE1_STEPS)[number];

/** Steps that count toward the visible progress folio (intro and review excluded). */
export const STAGE1_QUESTION_STEPS = STAGE1_STEPS.filter(
  (s) => s !== 'intro' && s !== 'review',
) as Exclude<Stage1Step, 'intro' | 'review'>[];

export function questionIndex(step: Stage1Step): number | null {
  const i = (STAGE1_QUESTION_STEPS as readonly string[]).indexOf(step);
  return i === -1 ? null : i;
}

export function nextStep(step: Stage1Step): Stage1Step | null {
  const i = STAGE1_STEPS.indexOf(step);
  return STAGE1_STEPS[i + 1] ?? null;
}

/** Private draft. Persisted on device until submission. */
export type ApplicationDraft = {
  introAcknowledged: boolean;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null; // ISO calendar date
  instagram: InstagramAnswer | null;
  countryCode: CountryCode | null;
  city: CityAnswer | null;
  referral: ReferralAnswer | null;
  updatedAt: string | null;
};

export const EMPTY_DRAFT: ApplicationDraft = {
  introAcknowledged: false,
  firstName: null,
  lastName: null,
  dateOfBirth: null,
  instagram: null,
  countryCode: null,
  city: null,
  referral: null,
  updatedAt: null,
};

/** Is the committed answer for a step present and still valid? */
export function isStepComplete(draft: ApplicationDraft, step: Stage1Step, today: CalendarDate): boolean {
  switch (step) {
    case 'intro':
      return draft.introAcknowledged;
    case 'first-name':
      return draft.firstName !== null && validateName(draft.firstName).ok;
    case 'last-name':
      return draft.lastName !== null && validateName(draft.lastName).ok;
    case 'date-of-birth': {
      const d = draft.dateOfBirth ? parseISODate(draft.dateOfBirth) : null;
      if (!d) return false;
      // Re-validated against "today" so a stale draft can never bypass 18+.
      return validateDateOfBirth(
        { day: String(d.day), month: String(d.month), year: String(d.year) },
        today,
      ).ok;
    }
    case 'instagram':
      return draft.instagram?.kind === 'handle' && draft.instagram.handle.length > 0;
    case 'country':
      return draft.countryCode !== null;
    case 'city':
      return draft.city !== null && draft.countryCode !== null;
    case 'referral':
      return (
        draft.referral !== null &&
        (draft.referral.kind === 'none' || draft.referral.referrals.length > 0)
      );
    case 'review':
      return false;
  }
}

/** Where to resume a draft: the first step whose answer is missing. */
export function resumeStep(draft: ApplicationDraft, today: CalendarDate): Stage1Step {
  return STAGE1_STEPS.find((s) => !isStepComplete(draft, s, today)) ?? 'review';
}

/** A step may be opened only if every step before it is complete. */
export function canOpenStep(draft: ApplicationDraft, step: Stage1Step, today: CalendarDate): boolean {
  const i = STAGE1_STEPS.indexOf(step);
  return STAGE1_STEPS.slice(0, i).every((s) => isStepComplete(draft, s, today));
}

export type AssembleResult =
  | { ok: true; submission: Stage1Submission }
  | { ok: false; missing: Stage1Step[] };

export function assembleStage1(draft: ApplicationDraft, today: CalendarDate): AssembleResult {
  const missing = STAGE1_STEPS.filter((s) => s !== 'review' && !isStepComplete(draft, s, today));
  if (
    missing.length > 0 ||
    !draft.firstName ||
    !draft.lastName ||
    !draft.dateOfBirth ||
    !draft.instagram ||
    !draft.countryCode ||
    !draft.city ||
    !draft.referral
  ) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    submission: {
      firstName: draft.firstName,
      lastName: draft.lastName,
      dateOfBirth: draft.dateOfBirth,
      instagram: draft.instagram,
      countryCode: draft.countryCode,
      city: draft.city,
      referral: draft.referral,
    },
  };
}

export const MAX_REFERRALS = 2;

/**
 * Normalise a persisted draft from an older build. Answers that are no longer
 * valid under current decisions (e.g. the removed Instagram opt-out, DEC-023)
 * are dropped so the applicant is asked again rather than blocked.
 */
export function sanitizeDraft(raw: Partial<ApplicationDraft> | undefined): ApplicationDraft {
  const draft: ApplicationDraft = { ...EMPTY_DRAFT, ...raw };
  const ig = draft.instagram as { kind?: unknown; handle?: unknown } | null;
  if (ig && (ig.kind !== 'handle' || typeof ig.handle !== 'string')) draft.instagram = null;
  return draft;
}

/**
 * After the server acknowledges the application, the device keeps only what
 * the status screen shows the applicant (name and place). Date of birth,
 * Instagram and referral details live server-side only — data minimisation.
 */
export function retainAfterSubmission(draft: ApplicationDraft): ApplicationDraft {
  return {
    ...EMPTY_DRAFT,
    introAcknowledged: draft.introAcknowledged,
    firstName: draft.firstName,
    lastName: draft.lastName,
    countryCode: draft.countryCode,
    city: draft.city,
    updatedAt: draft.updatedAt,
  };
}
