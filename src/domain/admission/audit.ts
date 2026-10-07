/**
 * Structured audit events for every meaningful lifecycle change
 * (ADMIN_REVIEW_MODEL "Audit", DATA_MODEL §13).
 *
 * Audit records are internal. Applicants never receive them: no reviewer
 * identity, no internal reason codes, no notes (DEC-044).
 */
import type { ApplicationStatus } from './status';

export const AUDIT_EVENT_TYPES = [
  'PHONE_VERIFIED',
  'APPLICATION_SUBMITTED',
  'APPLICATION_REVIEW_STARTED',
  'EXTENDED_APPLICATION_REQUESTED',
  'EXTENDED_APPLICATION_STARTED',
  'EXTENDED_APPLICATION_SUBMITTED',
  'FINAL_REVIEW_STARTED',
  'MORE_INFORMATION_REQUESTED',
  'MORE_INFORMATION_PROVIDED',
  'APPLICATION_WAITLISTED',
  'APPLICATION_APPROVED',
  'APPLICATION_NOT_ADMITTED',
  'APPLICATION_REOPENED',
  'MEMBERSHIP_ACTIVATION_STARTED',
  'MEMBERSHIP_ACTIVATED',
  'MEMBERSHIP_EXPIRED',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type ActorType = 'applicant' | 'reviewer' | 'system';

/**
 * Internal, structured reasons for a review decision. Never shown to the
 * applicant and never combined into a numeric score of a person (DEC-045).
 */
export const INTERNAL_DECISION_REASONS = [
  'COMMUNITY_FIT',
  'TRUST_REVIEW',
  'APPLICATION_QUALITY',
  'CAPACITY',
  'SAFETY',
  'OTHER',
] as const;

export type InternalDecisionReason = (typeof INTERNAL_DECISION_REASONS)[number];

export type AuditEvent = {
  id: string;
  applicationId: string | null;
  userId: string | null;
  eventType: AuditEventType;
  previousStatus: ApplicationStatus | null;
  newStatus: ApplicationStatus | null;
  actorType: ActorType;
  /** Internal only (e.g. a reviewer id). Never sent to applicant clients. */
  actorId: string | null;
  reasonCode: InternalDecisionReason | null;
  /** Small structured facts (request types, counts). Never free-text notes. */
  metadata: Record<string, string | number | boolean | null | string[]>;
  createdAt: string;
};
