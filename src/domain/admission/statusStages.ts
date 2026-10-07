/**
 * The quiet stage sequence shown on the Application Status surface.
 *
 *   Received  Review  Decision                  (before an extended application)
 *   Received  Review  Final review  Decision    (once the extended stage begins)
 *
 * Deliberately coarse: no per-stage dates, no percentages, no queue position.
 */
import type { ApplicationStatus } from './status';

export type StageId = 'received' | 'review' | 'finalReview' | 'decision';

export type StageSequence = { stages: StageId[]; currentIndex: number };

const EXTENDED_OR_LATER: ReadonlySet<ApplicationStatus> = new Set([
  'EXTENDED_APPLICATION_REQUIRED',
  'EXTENDED_APPLICATION_DRAFT',
  'EXTENDED_APPLICATION_SUBMITTED',
  'FINAL_REVIEW',
]);

export function stagesFor(
  status: ApplicationStatus,
  meta: { extendedRequestedAt: string | null; moreInformationReturnTo?: ApplicationStatus | null } | null,
): StageSequence | null {
  const extended = EXTENDED_OR_LATER.has(status) || Boolean(meta?.extendedRequestedAt);
  const stages: StageId[] = extended
    ? ['received', 'review', 'finalReview', 'decision']
    : ['received', 'review', 'decision'];
  const at = (id: StageId) => stages.indexOf(id);

  switch (status) {
    case 'APPLICATION_RECEIVED':
      return { stages, currentIndex: at('received') };
    case 'UNDER_REVIEW':
    case 'EXTENDED_APPLICATION_REQUIRED':
    case 'EXTENDED_APPLICATION_DRAFT':
      return { stages, currentIndex: at('review') };
    case 'MORE_INFORMATION_REQUIRED':
      // Still in the stage that asked; review resumes there once answered.
      if (meta?.moreInformationReturnTo === 'UNDER_REVIEW') return { stages, currentIndex: at('review') };
      if (meta?.moreInformationReturnTo === 'FINAL_REVIEW') return { stages, currentIndex: at('finalReview') };
      return { stages, currentIndex: extended ? at('finalReview') : at('review') };
    case 'EXTENDED_APPLICATION_SUBMITTED':
    case 'FINAL_REVIEW':
      return { stages, currentIndex: at('finalReview') };
    case 'WAITLISTED':
    case 'APPROVED':
    case 'NOT_ADMITTED':
      return { stages, currentIndex: at('decision') };
    default:
      return null; // Pre-submission and membership states have no review sequence.
  }
}
