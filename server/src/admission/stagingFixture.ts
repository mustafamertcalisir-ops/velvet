/**
 * Staging review fixture (DEC-076): moves ISOLATED QA applications through
 * the reviewer side of admission, so the staging journey, the smoke flow and
 * the QA seed can reach every status without a reviewer dashboard and without
 * touching the database.
 *
 * - Served only outside production (`when: 'not-production'`) and only to a
 *   key with the test-only scope `test:review` (refused in production config).
 * - Acts only on QA accounts (accounts created from designated test numbers,
 *   0011). Any other application answers NOT_FOUND: the fixture can never
 *   decide about a real applicant, and does not reveal that one exists.
 * - Uses the normal reviewer path (`reviewerAction`): the same transition
 *   validation, review record and audit event as a human reviewer, with the
 *   reviewer id `staging-fixture.<key id>`. Activation uses the normal
 *   payment-confirmed path with an idempotent fixture event id.
 * - Applicant steps (submitting Stage 2) are NOT done here: the journey does
 *   them through the public API, with real uploads.
 */
import type pg from 'pg';
import type { MembershipApplication } from '@/domain/models';
import { fail } from '../http/errors';
import type { createInternalService } from './internal';

export const FIXTURE_ACTIONS = ['START_REVIEW', 'REQUEST_EXTENDED', 'REQUEST_IDENTITY', 'APPROVE', 'WAITLIST', 'NOT_ADMIT', 'ACTIVATE'] as const;
export type FixtureAction = (typeof FIXTURE_ACTIONS)[number];

export function createStagingFixture(deps: { pool: pg.Pool; internal: ReturnType<typeof createInternalService> }) {
  const { pool, internal } = deps;
  return {
    async review(applicationId: string, body: unknown, principal: string): Promise<MembershipApplication> {
      const action = (body as { action?: unknown } | undefined)?.action;
      if (typeof action !== 'string' || !(FIXTURE_ACTIONS as readonly string[]).includes(action)) return fail('VALIDATION_FAILED', { fields: ['action'] });
      const { rows } = await pool.query<{ account_id: string }>(
        `SELECT a.account_id FROM app.membership_applications a JOIN app.accounts acc ON acc.id = a.account_id
          WHERE a.id = $1 AND acc.qa_account`,
        [applicationId],
      );
      const qa = rows[0];
      if (!qa) return fail('NOT_FOUND');
      if (action === 'ACTIVATE') {
        return internal.paymentConfirmed({ accountId: qa.account_id, providerEventId: `staging_fixture_${applicationId}`, provider: 'staging-fixture' });
      }
      const reviewerId = `staging-fixture.${principal}`;
      if (action === 'REQUEST_IDENTITY') {
        // An identity check (the only way an applicant can upload verification media).
        return internal.reviewerAction(applicationId, { reviewerId, action: { kind: 'REQUEST_INFORMATION', requests: [{ preset: 'CONFIRM_IDENTITY' }] } });
      }
      return internal.reviewerAction(applicationId, { reviewerId, action: { kind: action } });
    },

    /**
     * The QA application of a QA number (DEC-083): lets the operator drive the reviewer side of a real-SIM
     * journey from CI without ever seeing an id in the app. QA accounts only; anything else is NOT_FOUND.
     */
    async lookup(body: unknown): Promise<{ applicationId: string | null; status: string | null }> {
      const phone = (body as { phoneE164?: unknown } | undefined)?.phoneE164;
      if (typeof phone !== 'string' || !/^\+\d{8,15}$/.test(phone)) return fail('VALIDATION_FAILED', { fields: ['phoneE164'] });
      const { rows } = await pool.query<{ application_id: string | null; status: string | null }>(
        `SELECT a.id AS application_id, a.status FROM app.accounts acc LEFT JOIN app.membership_applications a ON a.account_id = acc.id
          WHERE acc.phone_e164 = $1 AND acc.qa_account AND acc.account_status = 'active'`,
        [phone],
      );
      if (!rows[0]) return fail('NOT_FOUND');
      return { applicationId: rows[0].application_id, status: rows[0].status };
    },
  };
}

export type StagingFixture = ReturnType<typeof createStagingFixture>;
