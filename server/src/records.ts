/**
 * Row → record mappers for the applicant's OWN data (account, application,
 * membership). Explicit, field by field: a row is never spread into a
 * response. Member-to-member DTOs live in member/dto.ts.
 */
import type { ApplicationStatus } from '@/domain/admission/status';
import type { MembershipPlan } from '@/domain/membership/plan';
import type { Membership, MembershipApplication, UserAccount } from '@/domain/models';
import type { Db } from './db/pool';

/** Server-side account lifecycle (DEC-066): active ⇄ suspended; active → deletion_requested → anonymized. */
export type AccountStatus = 'active' | 'suspended' | 'deletion_requested' | 'anonymized';

export type AccountRow = {
  id: string;
  phone_e164: string | null;
  phone_verified_at: string | null;
  account_status: AccountStatus;
  suspended_at: string | null;
  deletion_requested_at: string | null;
  anonymized_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The signed-in person's own account. Only ever built for an active account (sign-in refuses the others). */
export const toAccount = (r: AccountRow): UserAccount => ({
  id: r.id,
  phoneE164: r.phone_e164 ?? '',
  phoneVerifiedAt: r.phone_verified_at ?? r.created_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  accountStatus: r.account_status === 'active' ? 'active' : r.account_status === 'suspended' ? 'suspended' : 'deleted',
});

export type ApplicationRow = {
  id: string;
  account_id: string;
  status: ApplicationStatus;
  stage1_completed_at: string | null;
  submitted_at: string | null;
  review_started_at: string | null;
  extended_requested_at: string | null;
  extended_submitted_at: string | null;
  final_review_started_at: string | null;
  decision_at: string | null;
  more_information_requested_at: string | null;
  more_information_return_to: 'UNDER_REVIEW' | 'FINAL_REVIEW' | null;
  information_provided_at: string | null;
  reopened_at: string | null;
  created_at: string;
  updated_at: string;
};

export const toApplication = (r: ApplicationRow): MembershipApplication => ({
  id: r.id,
  userId: r.account_id,
  status: r.status,
  stage1CompletedAt: r.stage1_completed_at,
  submittedAt: r.submitted_at,
  reviewStartedAt: r.review_started_at,
  extendedRequestedAt: r.extended_requested_at,
  extendedSubmittedAt: r.extended_submitted_at,
  finalReviewStartedAt: r.final_review_started_at,
  decisionAt: r.decision_at,
  moreInformationRequestedAt: r.more_information_requested_at,
  moreInformationReturnTo: r.more_information_return_to,
  informationProvidedAt: r.information_provided_at,
  reopenedAt: r.reopened_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type MembershipRow = {
  id: string;
  account_id: string;
  plan_id: string;
  status: Membership['status'];
  started_at: string | null;
  renews_at: string | null;
  ends_at: string | null;
  activation: Membership['activation'];
  created_at: string;
  updated_at: string;
};

/** The member's own membership (granted_by — the reviewer — is internal and never part of it). */
export const toMembership = (r: MembershipRow): Membership => ({
  id: r.id,
  userId: r.account_id,
  planId: r.plan_id,
  status: r.status,
  startedAt: r.started_at,
  renewsAt: r.renews_at,
  endsAt: r.ends_at,
  activation: r.activation,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type PlanRow = {
  id: string;
  name: string;
  billing_period: MembershipPlan['billingPeriod'];
  price_minor: number;
  currency: string;
  is_development_fixture: boolean;
};

export const toPlan = (r: PlanRow): MembershipPlan => ({
  id: r.id,
  name: r.name,
  billingPeriod: r.billing_period,
  priceMinor: r.price_minor,
  currency: r.currency,
  isDevelopmentFixture: r.is_development_fixture,
});

export async function applicationOf(db: Db, accountId: string, forUpdate = false): Promise<ApplicationRow | null> {
  const { rows } = await db.query<ApplicationRow>(
    `SELECT * FROM app.membership_applications WHERE account_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [accountId],
  );
  return rows[0] ?? null;
}

export async function membershipOf(db: Db, accountId: string): Promise<MembershipRow | null> {
  const { rows } = await db.query<MembershipRow>('SELECT * FROM app.memberships WHERE account_id = $1', [accountId]);
  return rows[0] ?? null;
}
