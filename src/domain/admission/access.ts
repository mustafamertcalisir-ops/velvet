import type { Membership } from '../models';
import type { ApplicationStatus } from './status';

/**
 * Member access is DERIVED from application status + membership status
 * (docs/DATA_MODEL.md §15). It is never stored as a boolean.
 *
 * An applicant — at any stage, including APPROVED — cannot enter the member
 * product until membership is activated (DEC-002).
 */
export function canAccessMemberProduct(
  status: ApplicationStatus,
  membership: Pick<Membership, 'status'> | null,
): boolean {
  if (status !== 'ACTIVE_MEMBER') return false;
  if (!membership) return false;
  return membership.status === 'active' || membership.status === 'grace_period';
}
