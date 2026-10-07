/**
 * Internal operations — not part of the applicant or member API, and not
 * callable with an applicant or member session (internal bearer token only):
 *
 *  - reviewer actions: the ONLY way a review state changes (DEC-041), planned
 *    by the shared domain rules, recorded with internal reason codes, audited.
 *  - billing confirmations: the payment provider adapter reports a confirmed
 *    payment or an expiry; recorded once per provider event (idempotent).
 */
import {
  resolveRequestDrafts,
  type InformationRequestDraft,
} from '@/domain/admission/informationRequests';
import { planReviewerAction, type ReviewerAction } from '@/domain/admission/review';
import type { MembershipApplication } from '@/domain/models';
import type pg from 'pg';
import type { Config } from '../config';
import { tx, type Db } from '../db/pool';
import { fail } from '../http/errors';
import { calendarDateIn, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import type { ObjectStore } from '../media/objectStore';
import { createMediaDelivery, DELIVERY_TTL_SECONDS, type MediaClass } from '../media/pipeline';
import { provisionMember } from '../member/provision';
import { toApplication, type ApplicationRow } from '../records';
import { audit, moveApplication, type ApplicationChanges } from './lifecycle';

type Deps = { pool: pg.Pool; clock: Clock; config: Config; store: ObjectStore };

const REVIEWER_ID = /^[A-Za-z0-9_.@-]{2,80}$/;
const MEMBERSHIP_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export function createInternalService({ pool, clock, config, store }: Deps) {
  const delivery = createMediaDelivery(store);
  async function appById(db: Db, applicationId: string): Promise<ApplicationRow> {
    const { rows } = await db.query<ApplicationRow>('SELECT * FROM app.membership_applications WHERE id = $1 FOR UPDATE', [applicationId]);
    return rows[0] ?? fail('NOT_FOUND');
  }

  async function profilePhotoIds(db: Db, applicationId: string): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM app.application_media WHERE application_id = $1 AND purpose = 'profile' AND retired_at IS NULL AND position >= 0 ORDER BY position`,
      [applicationId],
    );
    return rows.map((r) => r.id);
  }

  return {
    async reviewerAction(applicationId: string, body: unknown): Promise<MembershipApplication> {
      const b = (body ?? {}) as { reviewerId?: unknown; action?: ReviewerAction };
      if (typeof b.reviewerId !== 'string' || !REVIEWER_ID.test(b.reviewerId)) return fail('VALIDATION_FAILED', { fields: ['reviewerId'] });
      const action = b.action;
      if (!action || typeof action !== 'object' || typeof action.kind !== 'string') return fail('VALIDATION_FAILED', { fields: ['action'] });
      return tx(pool, async (db) => {
        const app = await appById(db, applicationId);
        const planned = planReviewerAction({ status: app.status, extendedSubmittedAt: app.extended_submitted_at }, action);
        if (!planned.ok) return fail('NOT_ALLOWED');
        const { plan } = planned;
        let drafts: ReturnType<typeof resolveRequestDrafts> | null = null;
        if (action.kind === 'REQUEST_INFORMATION') {
          drafts = resolveRequestDrafts(Array.isArray(action.requests) ? (action.requests as InformationRequestDraft[]) : [], {
            photoIds: await profilePhotoIds(db, app.id),
            extendedSubmitted: app.extended_submitted_at !== null,
          });
          if (!drafts.ok) return fail('VALIDATION_FAILED', { fields: [`requests:${drafts.error}`] });
        }
        const at = clock().toISOString();
        const changes: ApplicationChanges = {};
        if (plan.to === 'UNDER_REVIEW' && !app.review_started_at) changes.review_started_at = at;
        if (plan.to === 'EXTENDED_APPLICATION_REQUIRED') changes.extended_requested_at = at;
        if (plan.to === 'FINAL_REVIEW') changes.final_review_started_at = at;
        if (plan.to === 'MORE_INFORMATION_REQUIRED') {
          changes.more_information_requested_at = at;
          changes.more_information_return_to = plan.returnTo;
        }
        if (action.kind === 'REOPEN') changes.reopened_at = at;
        if (plan.isDecision) changes.decision_at = at;
        const row = await moveApplication(db, app, plan.to, at, changes);
        if (drafts?.ok) {
          // A new round replaces anything still unanswered from an earlier one.
          await db.query(
            `UPDATE app.information_requests SET status = 'withdrawn' WHERE application_id = $1 AND status IN ('open', 'answered')`,
            [app.id],
          );
          for (const [ordinal, d] of drafts.value.entries()) {
            await db.query(
              `INSERT INTO app.information_requests (id, application_id, type, explanation, ordinal, target, status, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
              [newId('req'), app.id, d.type, d.explanation, ordinal, d.target ? JSON.stringify(d.target) : null, at],
            );
          }
        }
        const requestTypes = drafts?.ok ? drafts.value.map((d) => d.type) : [];
        await db.query(
          `INSERT INTO app.application_reviews (id, application_id, reviewer_id, action, from_status, to_status, reason_code, request_types, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [newId('rev'), app.id, b.reviewerId, action.kind, plan.from, plan.to, plan.reason, requestTypes, at],
        );
        await audit(db, at, {
          eventType: plan.eventType,
          actorType: 'reviewer',
          actorId: b.reviewerId as string,
          accountId: app.account_id,
          applicationId: app.id,
          previousStatus: plan.from,
          newStatus: plan.to,
          reasonCode: plan.reason,
          metadata: requestTypes.length ? { requestTypes } : {},
        });
        return toApplication(row);
      });
    },

    /**
     * A reviewer looks at one application photo or identity photo. The only
     * way verification media leaves storage: a 2-minute signed url, and every
     * access is written to the append-only media access log.
     */
    async reviewerMedia(
      applicationId: string,
      mediaId: string,
      body: unknown,
      principal: string,
    ): Promise<{ url: string; expiresInSeconds: number; mediaClass: MediaClass }> {
      const b = (body ?? {}) as { reviewerId?: unknown; purpose?: unknown };
      if (typeof b.reviewerId !== 'string' || !REVIEWER_ID.test(b.reviewerId)) return fail('VALIDATION_FAILED', { fields: ['reviewerId'] });
      if (b.purpose !== 'REVIEW' && b.purpose !== 'SAFETY') return fail('VALIDATION_FAILED', { fields: ['purpose'] });
      return tx(pool, async (db) => {
        const { rows } = await db.query<{ id: string; storage_key: string; purpose: 'profile' | 'verification'; purged_at: string | null }>(
          'SELECT id, storage_key, purpose, purged_at FROM app.application_media WHERE id = $1 AND application_id = $2',
          [mediaId, applicationId],
        );
        const m = rows[0];
        if (!m || m.purged_at) return fail('NOT_FOUND');
        const mediaClass: MediaClass = m.purpose === 'verification' ? 'VERIFICATION_MEDIA' : 'APPLICATION_MEDIA';
        await db.query(
          `INSERT INTO app.media_access_log (id, media_id, media_class, principal, purpose, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [newId('mal'), m.id, mediaClass, `${principal}:${b.reviewerId}`, b.purpose, clock().toISOString()],
        );
        const url = await delivery.reviewerUrl(mediaClass, m.storage_key);
        return { url, expiresInSeconds: DELIVERY_TTL_SECONDS[mediaClass], mediaClass };
      });
    },

    /** The payment provider confirmed payment: MEMBERSHIP_PAYMENT_REQUIRED → ACTIVE_MEMBER, profile provisioned. */
    async paymentConfirmed(body: unknown): Promise<MembershipApplication> {
      const { accountId, providerEventId, provider } = billingInput(body);
      return tx(pool, async (db) => {
        // A suspended account, or one being deleted, is never activated (the billing adapter must refund).
        const acc = (await db.query<{ account_status: string }>('SELECT account_status FROM app.accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0];
        if (!acc) return fail('NOT_FOUND');
        if (acc.account_status !== 'active') return fail('NOT_ALLOWED');
        const { rows } = await db.query<ApplicationRow>('SELECT * FROM app.membership_applications WHERE account_id = $1 FOR UPDATE', [accountId]);
        const app = rows[0] ?? fail('NOT_FOUND');
        const at = clock().toISOString();
        const fresh = await db.query(
          `INSERT INTO app.billing_events (provider_event_id, account_id, kind, provider, received_at)
           VALUES ($1, $2, 'payment_confirmed', $3, $4) ON CONFLICT DO NOTHING`,
          [providerEventId, accountId, provider, at],
        );
        if ((fresh.rowCount ?? 0) === 0) return toApplication(app); // already processed
        if (app.status !== 'MEMBERSHIP_PAYMENT_REQUIRED') return fail('NOT_ALLOWED');
        const row = await moveApplication(db, app, 'ACTIVE_MEMBER', at);
        await db.query(`UPDATE app.memberships SET status = 'active', started_at = $2, renews_at = $3, updated_at = $2 WHERE account_id = $1 AND status = 'pending'`, [
          accountId,
          at,
          new Date(clock().getTime() + MEMBERSHIP_PERIOD_MS).toISOString(),
        ]);
        await audit(db, at, {
          eventType: 'MEMBERSHIP_ACTIVATED',
          actorType: 'system',
          accountId,
          applicationId: app.id,
          previousStatus: 'MEMBERSHIP_PAYMENT_REQUIRED',
          newStatus: 'ACTIVE_MEMBER',
          metadata: { provider },
        });
        // The member profile is provisioned from the approved application, at activation.
        await provisionMember(db, accountId, { at, today: calendarDateIn(clock(), config.timeZone), store });
        return toApplication(row);
      });
    },

    /** The membership lapsed: ACTIVE_MEMBER → EXPIRED. Records (matches, messages) are kept. */
    async membershipExpired(body: unknown): Promise<MembershipApplication> {
      const { accountId, providerEventId, provider } = billingInput(body);
      return tx(pool, async (db) => {
        const { rows } = await db.query<ApplicationRow>('SELECT * FROM app.membership_applications WHERE account_id = $1 FOR UPDATE', [accountId]);
        const app = rows[0] ?? fail('NOT_FOUND');
        const at = clock().toISOString();
        const fresh = await db.query(
          `INSERT INTO app.billing_events (provider_event_id, account_id, kind, provider, received_at)
           VALUES ($1, $2, 'membership_expired', $3, $4) ON CONFLICT DO NOTHING`,
          [providerEventId, accountId, provider, at],
        );
        if ((fresh.rowCount ?? 0) === 0) return toApplication(app);
        if (app.status !== 'ACTIVE_MEMBER') return fail('NOT_ALLOWED');
        const row = await moveApplication(db, app, 'EXPIRED', at);
        await db.query(`UPDATE app.memberships SET status = 'expired', ends_at = $2, updated_at = $2 WHERE account_id = $1`, [accountId, at]);
        await audit(db, at, {
          eventType: 'MEMBERSHIP_EXPIRED',
          actorType: 'system',
          accountId,
          applicationId: app.id,
          previousStatus: 'ACTIVE_MEMBER',
          newStatus: 'EXPIRED',
          metadata: { provider },
        });
        return toApplication(row);
      });
    },
  };
}

function billingInput(body: unknown): { accountId: string; providerEventId: string; provider: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{2,120}$/.test(v);
  if (!ok(b.accountId) || !ok(b.providerEventId) || !ok(b.provider)) {
    return fail('VALIDATION_FAILED', { fields: ['accountId', 'providerEventId', 'provider'].filter((k) => !ok(b[k])) });
  }
  return { accountId: b.accountId as string, providerEventId: b.providerEventId as string, provider: b.provider as string };
}

export type InternalService = ReturnType<typeof createInternalService>;
