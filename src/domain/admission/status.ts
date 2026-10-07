/**
 * Admission lifecycle — the single authoritative state of an applicant.
 *
 * Every screen in the admission experience renders FROM this value.
 * Do not add parallel booleans (isSubmitted, isApproved, needsPhotos…) —
 * derive them from the status with the helpers below.
 *
 * Source of truth: docs/DATA_MODEL.md §2, docs/DECISIONS.md DEC-019.
 */

export const APPLICATION_STATUSES = [
  'UNAUTHENTICATED',
  'PHONE_VERIFICATION',
  'APPLICATION_DRAFT',
  'APPLICATION_SUBMITTED',
  'APPLICATION_RECEIVED',
  'UNDER_REVIEW',
  'EXTENDED_APPLICATION_REQUIRED',
  'EXTENDED_APPLICATION_DRAFT',
  'EXTENDED_APPLICATION_SUBMITTED',
  'FINAL_REVIEW',
  'MORE_INFORMATION_REQUIRED',
  'WAITLISTED',
  'APPROVED',
  'NOT_ADMITTED',
  'MEMBERSHIP_PAYMENT_REQUIRED',
  'ACTIVE_MEMBER',
  'SUSPENDED',
  'EXPIRED',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return typeof value === 'string' && (APPLICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Allowed lifecycle transitions.
 *
 * Notes on intent:
 * - APPLICATION_SUBMITTED is the "sent, awaiting acknowledgement" state. It is
 *   persisted so that a restart mid-submit resumes the SAME submission
 *   (idempotency) instead of creating a duplicate. A definitive failure may
 *   return the applicant to APPLICATION_DRAFT.
 * - There is deliberately NO path from any applicant state straight to
 *   APPROVED or ACTIVE_MEMBER. Approval only follows a review state (DEC-008).
 * - NOT_ADMITTED is terminal until a reapplication policy exists (pending decision).
 * - Sign-out is a session reset, not a lifecycle transition.
 */
export const TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  UNAUTHENTICATED: ['PHONE_VERIFICATION'],
  PHONE_VERIFICATION: ['UNAUTHENTICATED', 'APPLICATION_DRAFT'],
  APPLICATION_DRAFT: ['APPLICATION_SUBMITTED'],
  APPLICATION_SUBMITTED: ['APPLICATION_RECEIVED', 'APPLICATION_DRAFT'],
  APPLICATION_RECEIVED: ['UNDER_REVIEW'],
  UNDER_REVIEW: [
    'EXTENDED_APPLICATION_REQUIRED',
    'MORE_INFORMATION_REQUIRED',
    'WAITLISTED',
    'NOT_ADMITTED',
  ],
  EXTENDED_APPLICATION_REQUIRED: ['EXTENDED_APPLICATION_DRAFT'],
  EXTENDED_APPLICATION_DRAFT: ['EXTENDED_APPLICATION_SUBMITTED'],
  EXTENDED_APPLICATION_SUBMITTED: ['FINAL_REVIEW', 'EXTENDED_APPLICATION_DRAFT'],
  FINAL_REVIEW: ['APPROVED', 'WAITLISTED', 'MORE_INFORMATION_REQUIRED', 'NOT_ADMITTED'],
  MORE_INFORMATION_REQUIRED: ['UNDER_REVIEW', 'FINAL_REVIEW'],
  WAITLISTED: ['UNDER_REVIEW', 'FINAL_REVIEW', 'NOT_ADMITTED'],
  APPROVED: ['MEMBERSHIP_PAYMENT_REQUIRED'],
  NOT_ADMITTED: [],
  MEMBERSHIP_PAYMENT_REQUIRED: ['ACTIVE_MEMBER'],
  ACTIVE_MEMBER: ['SUSPENDED', 'EXPIRED'],
  SUSPENDED: ['ACTIVE_MEMBER'],
  EXPIRED: ['MEMBERSHIP_PAYMENT_REQUIRED'],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ApplicationStatus,
    readonly to: ApplicationStatus,
  ) {
    super(`Invalid admission transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/** Returns the next status or throws. Use for every client-initiated change. */
export function transition(from: ApplicationStatus, to: ApplicationStatus): ApplicationStatus {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

// ---------------------------------------------------------------------------
// Derived values — never stored.
// ---------------------------------------------------------------------------

/** States in which an application exists on the server and the applicant waits or acts. */
const STATUS_SURFACE_STATES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'APPLICATION_RECEIVED',
  'UNDER_REVIEW',
  'EXTENDED_APPLICATION_REQUIRED',
  'EXTENDED_APPLICATION_DRAFT',
  'EXTENDED_APPLICATION_SUBMITTED',
  'FINAL_REVIEW',
  'MORE_INFORMATION_REQUIRED',
  'WAITLISTED',
  'APPROVED',
  'NOT_ADMITTED',
  'MEMBERSHIP_PAYMENT_REQUIRED',
  'SUSPENDED',
  'EXPIRED',
]);

/** True once the Stage 1 application has been acknowledged by the server. */
export function hasSubmittedStage1(status: ApplicationStatus): boolean {
  return STATUS_SURFACE_STATES.has(status) || status === 'ACTIVE_MEMBER';
}

/** Stage 1 fields may only be edited while the draft is open. */
export function canEditStage1(status: ApplicationStatus): boolean {
  return status === 'APPLICATION_DRAFT';
}

/** Stage 2 fields may only be edited while the extended draft is open. */
export function canEditStage2(status: ApplicationStatus): boolean {
  return status === 'EXTENDED_APPLICATION_DRAFT';
}

/** Statuses for which the client should poll/refresh from the server. */
export function isServerTracked(status: ApplicationStatus): boolean {
  return hasSubmittedStage1(status);
}

// ---------------------------------------------------------------------------
// Route zones — the UI renders from the lifecycle, not the other way round.
// ---------------------------------------------------------------------------

export type RouteZone = 'auth' | 'apply' | 'extended' | 'status' | 'membership' | 'member';

export function zoneForStatus(status: ApplicationStatus): RouteZone {
  switch (status) {
    case 'UNAUTHENTICATED':
    case 'PHONE_VERIFICATION':
      return 'auth';
    case 'APPLICATION_DRAFT':
    case 'APPLICATION_SUBMITTED':
      return 'apply';
    case 'EXTENDED_APPLICATION_DRAFT':
    case 'EXTENDED_APPLICATION_SUBMITTED':
      return 'extended';
    case 'MEMBERSHIP_PAYMENT_REQUIRED':
      // Approved and continued: the membership activation shell (not the member product).
      return 'membership';
    case 'ACTIVE_MEMBER':
      return 'member';
    default:
      return 'status';
  }
}
