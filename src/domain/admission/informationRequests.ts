/**
 * MORE_INFORMATION_REQUIRED — narrow, structured requests (ADMIN_REVIEW_MODEL
 * "More Information Required", DEC-042).
 *
 * A reviewer asks for one or more specific things from a fixed set of types.
 * There is no free-form question to the applicant: the applicant-facing
 * explanation comes from a curated preset, and each request can only change
 * the one thing it names. Everything else in the application stays locked.
 *
 * Lifecycle of a request:
 *   open → answered (applicant saved a response; can still change it)
 *        → resolved (applicant sent the update; changes applied server-side)
 *   open | answered → withdrawn (reviewer cancelled it)
 */
import { normalizeInstagram } from '../validation/instagram';
import { invalid, valid, type Validation } from '../validation/result';
import {
  ABOUT_YOU_MAX,
  validateLongText,
  validateShortText,
  validateWorkContext,
  WHAT_YOU_DO_MAX,
  type WorkContextAnswer,
} from './stage2';
import type { ApplicationStatus } from './status';

export const INFORMATION_REQUEST_TYPES = [
  'REPLACE_PHOTO',
  'VERIFY_IDENTITY',
  'UPDATE_INSTAGRAM',
  'CLARIFY_WORK',
  'UPDATE_APPLICATION_FIELD',
] as const;

export type InformationRequestType = (typeof INFORMATION_REQUEST_TYPES)[number];

/** Written answers a reviewer may ask the applicant to revisit. */
export const UPDATABLE_FIELDS = ['whatYouDo', 'aboutYou'] as const;
export type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

export const UPDATABLE_FIELD_MAX: Record<UpdatableField, number> = {
  whatYouDo: WHAT_YOU_DO_MAX,
  aboutYou: ABOUT_YOU_MAX,
};

export type InformationRequestTarget =
  | { kind: 'photo'; mediaId: string }
  | { kind: 'field'; field: UpdatableField }
  | null;

export type InformationRequestStatus = 'open' | 'answered' | 'resolved' | 'withdrawn';

export type InformationResponse =
  | { type: 'REPLACE_PHOTO'; mediaId: string }
  | { type: 'VERIFY_IDENTITY'; mediaId: string }
  | { type: 'UPDATE_INSTAGRAM'; handle: string }
  | { type: 'CLARIFY_WORK'; occupation: string; workContext: WorkContextAnswer }
  | { type: 'UPDATE_APPLICATION_FIELD'; field: UpdatableField; value: string };

/** Server record. */
export type InformationRequest = {
  id: string;
  applicationId: string;
  type: InformationRequestType;
  /** Short, applicant-facing, from a curated preset. */
  explanation: string;
  target: InformationRequestTarget;
  status: InformationRequestStatus;
  response: InformationResponse | null;
  createdAt: string;
  answeredAt: string | null;
  resolvedAt: string | null;
};

/**
 * Curated presets — the only way a reviewer phrases a request. Keeps requests
 * narrow and the tone consistent; prevents an interrogation channel.
 */
export const INFORMATION_REQUEST_PRESETS = {
  PHOTO_NEEDS_UPDATE: {
    type: 'REPLACE_PHOTO',
    explanation: 'One of your photos needs to be updated before we can continue.',
  },
  PHOTO_FACE_NOT_CLEAR: {
    type: 'REPLACE_PHOTO',
    explanation: 'We need a recent photo in which your face is clearly visible.',
  },
  CONFIRM_IDENTITY: {
    type: 'VERIFY_IDENTITY',
    explanation: 'We need to confirm that the photos in your application are of you.',
  },
  INSTAGRAM_NOT_FOUND: {
    type: 'UPDATE_INSTAGRAM',
    explanation: 'We couldn’t find the Instagram account in your application.',
  },
  WORK_UNCLEAR: {
    type: 'CLARIFY_WORK',
    explanation: 'Tell us a little more precisely what you do, and where.',
  },
  KNOWN_FOR_MORE: {
    type: 'UPDATE_APPLICATION_FIELD',
    field: 'whatYouDo',
    explanation: 'Tell us a little more about the work you’re known for.',
  },
  ABOUT_YOU_MORE: {
    type: 'UPDATE_APPLICATION_FIELD',
    field: 'aboutYou',
    explanation: 'We’d like to hear a little more about you.',
  },
} as const satisfies Record<
  string,
  { type: InformationRequestType; explanation: string; field?: UpdatableField }
>;

export type InformationRequestPreset = keyof typeof INFORMATION_REQUEST_PRESETS;

/** What a reviewer submits: a preset, plus the photo it concerns when relevant. */
export type InformationRequestDraft = { preset: InformationRequestPreset; mediaId?: string };

export const MAX_REQUESTS_PER_ROUND = 3;

export type RequestDraftContext = {
  /** Profile photo ids of this application, in order. */
  photoIds: readonly string[];
  /** Stage 2 answers exist (work and written answers can be clarified). */
  extendedSubmitted: boolean;
};

export type ResolvedRequestDraft = {
  type: InformationRequestType;
  explanation: string;
  target: InformationRequestTarget;
};

/** Validate a reviewer's request round against what the application actually contains. */
export function resolveRequestDrafts(
  drafts: readonly InformationRequestDraft[],
  ctx: RequestDraftContext,
): Validation<ResolvedRequestDraft[], 'empty' | 'too_many' | 'unknown_preset' | 'invalid_target' | 'duplicate'> {
  if (drafts.length === 0) return invalid('empty');
  if (drafts.length > MAX_REQUESTS_PER_ROUND) return invalid('too_many');
  const out: ResolvedRequestDraft[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const preset = (INFORMATION_REQUEST_PRESETS as Record<string, { type: InformationRequestType; explanation: string; field?: UpdatableField }>)[d.preset];
    if (!preset) return invalid('unknown_preset');
    let target: InformationRequestTarget = null;
    switch (preset.type) {
      case 'REPLACE_PHOTO':
        if (!d.mediaId || !ctx.photoIds.includes(d.mediaId)) return invalid('invalid_target');
        target = { kind: 'photo', mediaId: d.mediaId };
        break;
      case 'CLARIFY_WORK':
        if (!ctx.extendedSubmitted) return invalid('invalid_target');
        break;
      case 'UPDATE_APPLICATION_FIELD':
        if (!ctx.extendedSubmitted || !preset.field) return invalid('invalid_target');
        target = { kind: 'field', field: preset.field };
        break;
      case 'VERIFY_IDENTITY':
        if (ctx.photoIds.length === 0) return invalid('invalid_target');
        break;
      case 'UPDATE_INSTAGRAM':
        break;
    }
    const key = `${preset.type}:${target?.kind === 'photo' ? target.mediaId : target?.kind === 'field' ? target.field : ''}`;
    if (seen.has(key)) return invalid('duplicate');
    seen.add(key);
    out.push({ type: preset.type, explanation: preset.explanation, target });
  }
  return valid(out);
}

export type ResponseContext = {
  /** Ids of photos the applicant uploaded for THIS request (and nothing else). */
  uploadedForRequest: readonly string[];
};

export type ResponseError = 'type_mismatch' | 'target_mismatch' | 'invalid_value' | 'not_open';

/**
 * Validate an applicant's response against the request it answers. A response
 * can only touch the request's own target — this is what keeps every other
 * part of the application locked.
 */
export function validateResponse(
  request: Pick<InformationRequest, 'type' | 'target' | 'status'>,
  response: InformationResponse,
  ctx: ResponseContext,
): Validation<InformationResponse, ResponseError> {
  if (request.status !== 'open' && request.status !== 'answered') return invalid('not_open');
  if (response.type !== request.type) return invalid('type_mismatch');
  switch (response.type) {
    case 'REPLACE_PHOTO':
    case 'VERIFY_IDENTITY':
      return ctx.uploadedForRequest.includes(response.mediaId) ? valid(response) : invalid('target_mismatch');
    case 'UPDATE_INSTAGRAM': {
      const h = normalizeInstagram(response.handle);
      return h.ok ? valid({ type: 'UPDATE_INSTAGRAM', handle: h.value }) : invalid('invalid_value');
    }
    case 'CLARIFY_WORK': {
      const occupation = validateShortText(response.occupation);
      const work = validateWorkContext(response.workContext);
      return occupation.ok && work.ok
        ? valid({ type: 'CLARIFY_WORK', occupation: occupation.value, workContext: work.value })
        : invalid('invalid_value');
    }
    case 'UPDATE_APPLICATION_FIELD': {
      if (request.target?.kind !== 'field' || request.target.field !== response.field) return invalid('target_mismatch');
      const v = validateLongText(response.value, UPDATABLE_FIELD_MAX[response.field]);
      return v.ok ? valid({ ...response, value: v.value }) : invalid('invalid_value');
    }
  }
}

/** Where review continues once the applicant has sent the update (DEC-042). */
export type ReviewReturnStage = Extract<ApplicationStatus, 'UNDER_REVIEW' | 'FINAL_REVIEW'>;

export function isReviewReturnStage(s: ApplicationStatus | null | undefined): s is ReviewReturnStage {
  return s === 'UNDER_REVIEW' || s === 'FINAL_REVIEW';
}

// --- Applicant projection ----------------------------------------------------

/**
 * What the applicant receives about a request: the request itself, plus the
 * applicant's OWN current answer for the one thing it concerns (the device no
 * longer holds Stage 2 answers after submission — DEC-031).
 */
export type ApplicantInformationRequest = {
  id: string;
  type: InformationRequestType;
  explanation: string;
  target: InformationRequestTarget;
  status: Exclude<InformationRequestStatus, 'withdrawn'>;
  createdAt: string;
  resolvedAt: string | null;
  current:
    | { kind: 'photo'; uri: string }
    | { kind: 'instagram'; handle: string }
    | { kind: 'work'; occupation: string | null; workContext: WorkContextAnswer | null }
    | { kind: 'text'; field: UpdatableField; value: string | null }
    | null;
  /**
   * The applicant's saved, not-yet-sent response (for display / change). An
   * identity photo is never sent back to any device — not even its owner's —
   * so it appears only as `verification_received` (DEC-063).
   */
  response:
    | { kind: 'photo'; uri: string }
    | { kind: 'verification_received' }
    | { kind: 'instagram'; handle: string }
    | { kind: 'work'; occupation: string; workContext: WorkContextAnswer }
    | { kind: 'text'; value: string }
    | null;
};

export function allAnswered(requests: readonly Pick<ApplicantInformationRequest, 'status'>[]): boolean {
  return requests.length > 0 && requests.every((r) => r.status === 'answered' || r.status === 'resolved');
}
