/**
 * The membership team's review desk (DEC-087): what a reviewer needs to READ
 * in order to decide, and the invited (complimentary) membership start
 * (DEC-088). Internal only — signed requests with scoped keys, never an
 * applicant or member session. Decisions themselves still go through the one
 * reviewer path (internal.ts → reviewerAction); nothing here changes a review
 * state.
 *
 *  - queue    (review:read)  submitted applications of active accounts, with
 *                            the minimum to recognise a person (first name,
 *                            age, city) and the actions open to the reviewer.
 *                            No surname, no phone number, no answers.
 *  - detail   (review:read)  the private application as the membership team
 *                            may see it. Every open is written to
 *                            application_access_log (ids only). Phone
 *                            numbers — the applicant's and the referrers' —
 *                            are never part of it. Photo bytes are not
 *                            either: each photo is opened separately through
 *                            review:media (2/10-minute signed url, logged).
 *  - invited membership (membership:complimentary, staging only)
 *                            APPROVED / MEMBERSHIP_PAYMENT_REQUIRED →
 *                            ACTIVE_MEMBER through the normal lifecycle, the
 *                            membership marked 'complimentary' with the
 *                            reviewer who started it. Never a payment: no
 *                            billing event is recorded and nothing renews.
 */
import type { ReviewerActionKind } from '@/domain/admission/review';
import { reviewerActionsFor } from '@/domain/admission/review';
import { APPLICATION_STATUSES, isApplicationStatus, type ApplicationStatus } from '@/domain/admission/status';
import type { WorkContextAnswer } from '@/domain/admission/stage2';
import type { CityAnswer, MembershipApplication } from '@/domain/models';
import { ageOn, parseISODate } from '@/domain/validation/dateOfBirth';
import type pg from 'pg';
import type { Config } from '../config';
import { tx } from '../db/pool';
import { fail } from '../http/errors';
import { calendarDateIn, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import type { ObjectStore } from '../media/objectStore';
import { provisionMember } from '../member/provision';
import { toApplication, type ApplicationRow } from '../records';
import { audit, moveApplication } from './lifecycle';

export const REVIEWER_ID = /^[A-Za-z0-9_.@-]{2,80}$/;
/** Statuses an application passes through only inside one request — never worth listing. */
const TRANSIENT: readonly ApplicationStatus[] = ['APPLICATION_DRAFT', 'APPLICATION_SUBMITTED'];
const INVITABLE: readonly ApplicationStatus[] = ['APPROVED', 'MEMBERSHIP_PAYMENT_REQUIRED'];
const QUEUE_DEFAULT = 100;
const QUEUE_MAX = 200;

export type ReviewQueueItem = {
  id: string;
  status: ApplicationStatus;
  firstName: string;
  age: number | null;
  city: string;
  countryCode: string;
  submittedAt: string | null;
  /** When the application last changed (≈ how long it has waited in this status). */
  updatedAt: string;
  /** Current profile photos (Stage 2). */
  photoCount: number;
  /** Reviewer actions open in this status (the shared lifecycle rules). */
  actions: readonly ReviewerActionKind[];
  /** The membership team can start an invited membership now (staging only). */
  canStartInvitedMembership: boolean;
  qa: boolean;
};

export type ReviewMedia = {
  id: string;
  /** profile: a Stage 2 photo; verification: an identity photo (reviewers only, never on a profile). */
  purpose: 'profile' | 'verification';
  type: 'photo' | 'video';
  /** Profile order (1-based) for current photos; null for retired or verification media. */
  position: number | null;
  /** Replaced by the applicant (kept for review history until retention). */
  retired: boolean;
  createdAt: string;
};

export type ReviewDetail = {
  id: string;
  status: ApplicationStatus;
  qa: boolean;
  timeline: {
    createdAt: string;
    submittedAt: string | null;
    reviewStartedAt: string | null;
    extendedRequestedAt: string | null;
    extendedSubmittedAt: string | null;
    finalReviewStartedAt: string | null;
    moreInformationRequestedAt: string | null;
    informationProvidedAt: string | null;
    decisionAt: string | null;
    reopenedAt: string | null;
    updatedAt: string;
  };
  applicant: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    age: number | null;
    instagram: string;
    countryCode: string;
    city: string;
  };
  /** Referrer names and whether the team has matched them — never their phone numbers. */
  referral: { kind: 'none' | 'requested'; referrers: { name: string; status: string }[] };
  extended: null | {
    occupation: string | null;
    workContext: WorkContextAnswer | null;
    whatYouDo: string | null;
    aboutYou: string | null;
    interests: string[];
    intents: string[];
    education: string | null;
    websiteUrl: string | null;
    portfolioUrl: string | null;
    dating: { meet: string[]; ageMin: number; ageMax: number } | null;
  };
  media: ReviewMedia[];
  informationRequests: { type: string; status: string; explanation: string; createdAt: string; answeredAt: string | null; resolvedAt: string | null }[];
  reviews: { action: string; from: string; to: string; reviewerId: string; reasonCode: string | null; at: string }[];
  actions: readonly ReviewerActionKind[];
  canStartInvitedMembership: boolean;
  membership: { status: string; activation: 'billing' | 'complimentary'; startedAt: string | null } | null;
};

type Deps = { pool: pg.Pool; clock: Clock; config: Config; store: ObjectStore };

export function createReviewDesk({ pool, clock, config, store }: Deps) {
  const invitedMembershipOpen = config.appEnv !== 'production';
  const today = () => calendarDateIn(clock(), config.timeZone);
  const ageFrom = (dob: string | null) => {
    const d = dob ? parseISODate(dob) : null;
    return d ? ageOn(d, today()) : null;
  };
  const canInvite = (status: ApplicationStatus) => invitedMembershipOpen && INVITABLE.includes(status);
  const reviewer = (v: unknown): string => (typeof v === 'string' && REVIEWER_ID.test(v) ? v : fail('VALIDATION_FAILED', { fields: ['reviewerId'] }));

  return {
    async queue(query: Record<string, string | undefined>): Promise<{ applications: ReviewQueueItem[] }> {
      const unknown = Object.keys(query).filter((k) => !['status', 'includeQa', 'limit'].includes(k));
      if (unknown.length) return fail('VALIDATION_FAILED', { fields: unknown });
      const asked = query.status === undefined ? null : query.status.split(',');
      if (asked && (asked.length > APPLICATION_STATUSES.length || !asked.every((s) => isApplicationStatus(s) && !TRANSIENT.includes(s)))) {
        return fail('VALIDATION_FAILED', { fields: ['status'] });
      }
      if (query.includeQa !== undefined && query.includeQa !== 'true' && query.includeQa !== 'false') return fail('VALIDATION_FAILED', { fields: ['includeQa'] });
      const limit = query.limit === undefined ? QUEUE_DEFAULT : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > QUEUE_MAX) return fail('VALIDATION_FAILED', { fields: ['limit'] });
      const statuses = asked ?? APPLICATION_STATUSES.filter((s) => !TRANSIENT.includes(s));
      const { rows } = await pool.query<{
        id: string;
        status: ApplicationStatus;
        first_name: string;
        date_of_birth: string;
        city: CityAnswer;
        country_code: string;
        submitted_at: string | null;
        updated_at: string;
        qa_account: boolean;
        photos: number;
      }>(
        `SELECT a.id, a.status, d.first_name, d.date_of_birth, d.city, d.country_code, a.submitted_at, a.updated_at, acc.qa_account,
                (SELECT count(*)::int FROM app.application_media m
                  WHERE m.application_id = a.id AND m.purpose = 'profile' AND m.position >= 0 AND m.retired_at IS NULL AND m.purged_at IS NULL) AS photos
           FROM app.membership_applications a
           JOIN app.accounts acc ON acc.id = a.account_id
           JOIN app.application_private_data d ON d.application_id = a.id
          WHERE acc.account_status = 'active' AND a.status = ANY ($1::text[]) AND ($2::boolean OR NOT acc.qa_account)
          ORDER BY a.updated_at ASC, a.id
          LIMIT $3`,
        [statuses, query.includeQa === 'true', limit],
      );
      return {
        applications: rows.map((r) => ({
          id: r.id,
          status: r.status,
          firstName: r.first_name,
          age: ageFrom(r.date_of_birth),
          city: r.city.label,
          countryCode: r.country_code,
          submittedAt: r.submitted_at,
          updatedAt: r.updated_at,
          photoCount: r.photos,
          actions: reviewerActionsFor(r.status),
          canStartInvitedMembership: canInvite(r.status),
          qa: r.qa_account,
        })),
      };
    },

    async detail(applicationId: string, query: Record<string, string | undefined>, principal: string): Promise<ReviewDetail> {
      const unknown = Object.keys(query).filter((k) => k !== 'reviewerId');
      if (unknown.length) return fail('VALIDATION_FAILED', { fields: unknown });
      const reviewerId = reviewer(query.reviewerId);
      return tx(pool, async (db) => {
        const app = (
          await db.query<ApplicationRow & { qa_account: boolean; account_status: string }>(
            `SELECT a.*, acc.qa_account, acc.account_status FROM app.membership_applications a JOIN app.accounts acc ON acc.id = a.account_id WHERE a.id = $1`,
            [applicationId],
          )
        ).rows[0];
        // A deleted (or deletion-requested) account is not reviewed any more; it does not exist for the desk.
        if (!app || app.account_status === 'deletion_requested' || app.account_status === 'anonymized' || TRANSIENT.includes(app.status)) {
          return fail('NOT_FOUND');
        }
        await db.query(`INSERT INTO app.application_access_log (id, application_id, principal, purpose, created_at) VALUES ($1, $2, $3, 'REVIEW', $4)`, [
          newId('aal'),
          app.id,
          `${principal}:${reviewerId}`,
          clock().toISOString(),
        ]);
        const p = (
          await db.query<{
            first_name: string;
            last_name: string;
            date_of_birth: string;
            instagram_handle: string;
            country_code: string;
            city: CityAnswer;
            referral_kind: 'none' | 'requested';
            occupation: string | null;
            work_context_answer: WorkContextAnswer | null;
            work_description: string | null;
            personal_response: string | null;
            interests: string[];
            intents: string[];
            education: string | null;
            website_url: string | null;
            portfolio_url: string | null;
          }>('SELECT * FROM app.application_private_data WHERE application_id = $1', [app.id])
        ).rows[0];
        if (!p) return fail('NOT_FOUND');
        const referrers = (
          await db.query<{ referrer_name: string; status: string }>(
            'SELECT referrer_name, status FROM app.application_referrals WHERE application_id = $1 ORDER BY requested_at, id',
            [app.id],
          )
        ).rows.map((r) => ({ name: r.referrer_name, status: r.status }));
        const dating = (
          await db.query<{ meet: string[]; age_min: number; age_max: number }>(
            'SELECT meet, age_min, age_max FROM app.application_dating_preferences WHERE application_id = $1',
            [app.id],
          )
        ).rows[0];
        const media = (
          await db.query<{ id: string; purpose: 'profile' | 'verification'; type: 'photo' | 'video'; position: number; retired_at: string | null; created_at: string }>(
            `SELECT id, purpose, type, position, retired_at, created_at FROM app.application_media
              WHERE application_id = $1 AND purged_at IS NULL
              ORDER BY (purpose = 'profile' AND position >= 0 AND retired_at IS NULL) DESC, purpose, position, created_at`,
            [app.id],
          )
        ).rows.map(
          (m): ReviewMedia => ({
            id: m.id,
            purpose: m.purpose,
            type: m.type,
            position: m.purpose === 'profile' && m.position >= 0 && !m.retired_at ? m.position + 1 : null,
            retired: m.retired_at !== null,
            createdAt: m.created_at,
          }),
        );
        const requests = (
          await db.query<{ type: string; status: string; explanation: string; created_at: string; answered_at: string | null; resolved_at: string | null }>(
            `SELECT type, status, explanation, created_at, answered_at, resolved_at FROM app.information_requests
              WHERE application_id = $1 ORDER BY created_at, ordinal`,
            [app.id],
          )
        ).rows.map((r) => ({ type: r.type, status: r.status, explanation: r.explanation, createdAt: r.created_at, answeredAt: r.answered_at, resolvedAt: r.resolved_at }));
        const reviews = (
          await db.query<{ action: string; from_status: string; to_status: string; reviewer_id: string; reason_code: string | null; created_at: string }>(
            `SELECT action, from_status, to_status, reviewer_id, reason_code, created_at FROM app.application_reviews
              WHERE application_id = $1 ORDER BY created_at, id`,
            [app.id],
          )
        ).rows.map((r) => ({ action: r.action, from: r.from_status, to: r.to_status, reviewerId: r.reviewer_id, reasonCode: r.reason_code, at: r.created_at }));
        const m = (
          await db.query<{ status: string; activation: 'billing' | 'complimentary'; started_at: string | null }>(
            'SELECT status, activation, started_at FROM app.memberships WHERE account_id = $1',
            [app.account_id],
          )
        ).rows[0];
        const hasExtended = app.extended_submitted_at !== null || p.occupation !== null || p.intents.length > 0;
        return {
          id: app.id,
          status: app.status,
          qa: app.qa_account,
          timeline: {
            createdAt: app.created_at,
            submittedAt: app.submitted_at,
            reviewStartedAt: app.review_started_at,
            extendedRequestedAt: app.extended_requested_at,
            extendedSubmittedAt: app.extended_submitted_at,
            finalReviewStartedAt: app.final_review_started_at,
            moreInformationRequestedAt: app.more_information_requested_at,
            informationProvidedAt: app.information_provided_at,
            decisionAt: app.decision_at,
            reopenedAt: app.reopened_at,
            updatedAt: app.updated_at,
          },
          applicant: {
            firstName: p.first_name,
            lastName: p.last_name,
            dateOfBirth: p.date_of_birth,
            age: ageFrom(p.date_of_birth),
            instagram: p.instagram_handle,
            countryCode: p.country_code,
            city: p.city.label,
          },
          referral: { kind: p.referral_kind, referrers },
          extended: hasExtended
            ? {
                occupation: p.occupation,
                workContext: p.work_context_answer,
                whatYouDo: p.work_description,
                aboutYou: p.personal_response,
                interests: p.interests,
                intents: p.intents,
                education: p.education,
                websiteUrl: p.website_url,
                portfolioUrl: p.portfolio_url,
                dating: dating ? { meet: dating.meet, ageMin: dating.age_min, ageMax: dating.age_max } : null,
              }
            : null,
          media,
          informationRequests: requests,
          reviews,
          actions: app.account_status === 'active' ? reviewerActionsFor(app.status) : [],
          canStartInvitedMembership: app.account_status === 'active' && canInvite(app.status),
          membership: m ? { status: m.status, activation: m.activation, startedAt: m.started_at } : null,
        };
      });
    },

    /**
     * Start an invited membership (DEC-088). The lifecycle is the normal one —
     * APPROVED → MEMBERSHIP_PAYMENT_REQUIRED → ACTIVE_MEMBER, each move validated
     * and audited (actor: the reviewer) — but no payment is claimed: no billing
     * event, activation 'complimentary', granted_by = the reviewer, no renewal.
     * Repeating it for an invited member answers the current state.
     */
    async startInvitedMembership(applicationId: string, body: unknown): Promise<MembershipApplication> {
      if (!invitedMembershipOpen) return fail('NOT_FOUND');
      const b = (body ?? {}) as Record<string, unknown>;
      const extra = Object.keys(b).filter((k) => k !== 'reviewerId');
      if (extra.length) return fail('VALIDATION_FAILED', { fields: extra });
      const reviewerId = reviewer(b.reviewerId);
      return tx(pool, async (db) => {
        const found = (await db.query<{ account_id: string }>('SELECT account_id FROM app.membership_applications WHERE id = $1', [applicationId])).rows[0];
        if (!found) return fail('NOT_FOUND');
        // Same lock order as payment confirmation: account, then application.
        const acc = (await db.query<{ account_status: string }>('SELECT account_status FROM app.accounts WHERE id = $1 FOR UPDATE', [found.account_id])).rows[0];
        if (!acc) return fail('NOT_FOUND');
        let app = (await db.query<ApplicationRow>('SELECT * FROM app.membership_applications WHERE id = $1 FOR UPDATE', [applicationId])).rows[0]!;
        const existing = (
          await db.query<{ status: string; activation: string }>('SELECT status, activation FROM app.memberships WHERE account_id = $1 FOR UPDATE', [app.account_id])
        ).rows[0];
        // A deleted (or deletion-requested) account does not exist for the desk; a suspended one is never activated.
        if (acc.account_status === 'deletion_requested' || acc.account_status === 'anonymized') return fail('NOT_FOUND');
        if (acc.account_status !== 'active') return fail('NOT_ALLOWED');
        if (app.status === 'ACTIVE_MEMBER' && existing?.activation === 'complimentary') return toApplication(app);
        if (!INVITABLE.includes(app.status)) return fail('NOT_ALLOWED');
        const at = clock().toISOString();
        if (app.status === 'APPROVED') {
          const plan = (await db.query<{ id: string }>('SELECT id FROM app.membership_plans WHERE active ORDER BY id LIMIT 1')).rows[0];
          if (!plan) return fail('NOT_ALLOWED'); // no plan configured (the staging release step creates one)
          app = await moveApplication(db, app, 'MEMBERSHIP_PAYMENT_REQUIRED', at);
          await db.query(
            `INSERT INTO app.memberships (id, account_id, plan_id, status, created_at, updated_at) VALUES ($1, $2, $3, 'pending', $4, $4)
             ON CONFLICT (account_id) DO NOTHING`,
            [newId('mbr'), app.account_id, plan.id, at],
          );
          await audit(db, at, {
            eventType: 'MEMBERSHIP_ACTIVATION_STARTED',
            actorType: 'reviewer',
            actorId: reviewerId,
            accountId: app.account_id,
            applicationId: app.id,
            previousStatus: 'APPROVED',
            newStatus: 'MEMBERSHIP_PAYMENT_REQUIRED',
            metadata: { activation: 'complimentary' },
          });
        }
        const granted = await db.query(
          `UPDATE app.memberships SET status = 'active', activation = 'complimentary', granted_by = $2, started_at = $3, renews_at = NULL, ends_at = NULL, updated_at = $3
            WHERE account_id = $1 AND status = 'pending'`,
          [app.account_id, reviewerId, at],
        );
        if ((granted.rowCount ?? 0) !== 1) return fail('NOT_ALLOWED');
        const row = await moveApplication(db, app, 'ACTIVE_MEMBER', at);
        await audit(db, at, {
          eventType: 'MEMBERSHIP_ACTIVATED',
          actorType: 'reviewer',
          actorId: reviewerId,
          accountId: app.account_id,
          applicationId: app.id,
          previousStatus: 'MEMBERSHIP_PAYMENT_REQUIRED',
          newStatus: 'ACTIVE_MEMBER',
          metadata: { activation: 'complimentary' },
        });
        await provisionMember(db, app.account_id, { at, today: today(), store });
        return toApplication(row);
      });
    },
  };
}

export type ReviewDesk = ReturnType<typeof createReviewDesk>;
