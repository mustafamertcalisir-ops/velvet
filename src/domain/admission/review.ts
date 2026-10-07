/**
 * Reviewer actions — the ONLY way a review state changes (DEC-041).
 *
 * Shared by the mock server's reviewer endpoint, the development fixture and
 * (later) real review tooling: an action is planned here, validated against
 * the lifecycle (`canTransition`) and the application's facts, and produces
 * exactly one audit event type. The applicant's device never runs this.
 *
 * Approval only follows FINAL_REVIEW. NOT_ADMITTED is terminal until a
 * reapplication policy exists. A waitlisted application stays active and can
 * be reopened into review — never back to a draft.
 */
import type { AuditEventType, InternalDecisionReason } from './audit';
import type { InformationRequestDraft, ReviewReturnStage } from './informationRequests';
import { canTransition, type ApplicationStatus } from './status';

export type ReviewerAction =
  | { kind: 'START_REVIEW' }
  | { kind: 'REQUEST_EXTENDED' }
  | { kind: 'REQUEST_INFORMATION'; requests: InformationRequestDraft[] }
  | { kind: 'WAITLIST'; reason?: InternalDecisionReason }
  | { kind: 'APPROVE'; reason?: InternalDecisionReason }
  | { kind: 'NOT_ADMIT'; reason?: InternalDecisionReason }
  | { kind: 'REOPEN'; to: ReviewReturnStage };

export type ReviewerActionKind = ReviewerAction['kind'];

/** Which reviewer actions exist in which state. Everything else is refused. */
export const REVIEWER_ACTIONS: Readonly<Partial<Record<ApplicationStatus, readonly ReviewerActionKind[]>>> = {
  APPLICATION_RECEIVED: ['START_REVIEW'],
  UNDER_REVIEW: ['REQUEST_EXTENDED', 'REQUEST_INFORMATION', 'WAITLIST', 'NOT_ADMIT'],
  FINAL_REVIEW: ['APPROVE', 'WAITLIST', 'REQUEST_INFORMATION', 'NOT_ADMIT'],
  WAITLISTED: ['REOPEN', 'NOT_ADMIT'],
};

export function reviewerActionsFor(status: ApplicationStatus): readonly ReviewerActionKind[] {
  return REVIEWER_ACTIONS[status] ?? [];
}

const EVENT: Record<ReviewerActionKind, AuditEventType> = {
  START_REVIEW: 'APPLICATION_REVIEW_STARTED',
  REQUEST_EXTENDED: 'EXTENDED_APPLICATION_REQUESTED',
  REQUEST_INFORMATION: 'MORE_INFORMATION_REQUESTED',
  WAITLIST: 'APPLICATION_WAITLISTED',
  APPROVE: 'APPLICATION_APPROVED',
  NOT_ADMIT: 'APPLICATION_NOT_ADMITTED',
  REOPEN: 'APPLICATION_REOPENED',
};

export type ReviewPlan = {
  from: ApplicationStatus;
  to: ApplicationStatus;
  eventType: AuditEventType;
  reason: InternalDecisionReason | null;
  /** For REQUEST_INFORMATION: the stage review returns to once answered. */
  returnTo: ReviewReturnStage | null;
  isDecision: boolean;
};

export type ReviewPlanError = 'not_allowed' | 'invalid_transition' | 'needs_extended_application';

export function planReviewerAction(
  app: { status: ApplicationStatus; extendedSubmittedAt: string | null },
  action: ReviewerAction,
): { ok: true; plan: ReviewPlan } | { ok: false; error: ReviewPlanError } {
  const from = app.status;
  if (!reviewerActionsFor(from).includes(action.kind)) return { ok: false, error: 'not_allowed' };

  let to: ApplicationStatus;
  let returnTo: ReviewReturnStage | null = null;
  switch (action.kind) {
    case 'START_REVIEW':
      to = 'UNDER_REVIEW';
      break;
    case 'REQUEST_EXTENDED':
      to = 'EXTENDED_APPLICATION_REQUIRED';
      break;
    case 'REQUEST_INFORMATION':
      to = 'MORE_INFORMATION_REQUIRED';
      returnTo = from === 'FINAL_REVIEW' ? 'FINAL_REVIEW' : 'UNDER_REVIEW';
      break;
    case 'WAITLIST':
      to = 'WAITLISTED';
      break;
    case 'APPROVE':
      to = 'APPROVED';
      break;
    case 'NOT_ADMIT':
      to = 'NOT_ADMITTED';
      break;
    case 'REOPEN':
      // Final review needs the completed extended application to review.
      if (action.to === 'FINAL_REVIEW' && !app.extendedSubmittedAt) {
        return { ok: false, error: 'needs_extended_application' };
      }
      to = action.to;
      break;
  }
  if (!canTransition(from, to)) return { ok: false, error: 'invalid_transition' };
  const reason = 'reason' in action && action.reason ? action.reason : null;
  return {
    ok: true,
    plan: {
      from,
      to,
      eventType: EVENT[action.kind],
      reason,
      returnTo,
      isDecision: to === 'APPROVED' || to === 'WAITLISTED' || to === 'NOT_ADMITTED',
    },
  };
}
