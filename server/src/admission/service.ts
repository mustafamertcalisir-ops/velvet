/**
 * Admission — the applicant's own application, end to end (the AdmissionApi
 * port, served over HTTP). Ported from the mock server with the same shared
 * domain rules; everything is decided here, never on the device:
 *
 *   Stage 1 submit      → APPLICATION_RECEIVED (never further)
 *   extended start      → EXTENDED_APPLICATION_DRAFT
 *   Stage 2 submit      → EXTENDED_APPLICATION_SUBMITTED → FINAL_REVIEW
 *   information update  → back to the review stage it came from
 *   begin membership    → MEMBERSHIP_PAYMENT_REQUIRED (never ACTIVE_MEMBER)
 *
 * Review decisions and activation are internal (reviewer.ts, billing.ts).
 */
import {
  isReviewReturnStage,
  validateResponse,
  type ApplicantInformationRequest,
  type InformationRequest,
  type InformationRequestTarget,
  type InformationResponse,
} from '@/domain/admission/informationRequests';
import { transition, type ApplicationStatus } from '@/domain/admission/status';
import { validateStage1Submission, validateStage2Submission } from '@/domain/admission/submissions';
import type { MembershipPlan } from '@/domain/membership/plan';
import type { ApplicationMedia, CityAnswer, MembershipApplication } from '@/domain/models';
import type { WorkContextAnswer } from '@/domain/admission/stage2';
import { ageOn, parseISODate } from '@/domain/validation/dateOfBirth';
import type { MyApplication } from '@/services/api/types';
import type pg from 'pg';
import type { Config } from '../config';
import { lockKey, tx, type Db } from '../db/pool';
import { fail } from '../http/errors';
import { calendarDateIn, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import type { MediaDelivery } from '../media/pipeline';
import type { RateLimiter } from '../ratelimit';
import { applicationOf, membershipOf, toApplication, toMembership, toPlan, type ApplicationRow, type PlanRow } from '../records';
import { audit, moveApplication } from './lifecycle';

export type AdmissionDeps = {
  pool: pg.Pool;
  clock: Clock;
  config: Config;
  delivery: MediaDelivery;
  limiter: RateLimiter;
};

export type PrivateRow = {
  application_id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  instagram_handle: string;
  country_code: string;
  city: CityAnswer;
  referral_kind: 'none' | 'requested';
  occupation: string | null;
  work_context: string | null;
  work_context_answer: WorkContextAnswer | null;
  work_description: string | null;
  personal_response: string | null;
  interests: string[];
  intents: string[];
};

export type MediaRow = {
  id: string;
  application_id: string;
  type: 'photo' | 'video';
  purpose: 'profile' | 'verification';
  storage_key: string;
  width: number;
  height: number;
  position: number;
  moderation_status: 'pending' | 'approved' | 'rejected';
  request_id: string | null;
  retired_at: string | null;
  purged_at: string | null;
  created_at: string;
};

type RequestRow = {
  id: string;
  application_id: string;
  type: InformationRequest['type'];
  explanation: string;
  target: InformationRequestTarget;
  status: InformationRequest['status'];
  response: InformationResponse | null;
  created_at: string;
  answered_at: string | null;
  resolved_at: string | null;
};

const key = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : fail('VALIDATION_FAILED', { fields: ['idempotencyKey'] }));

export function createAdmissionService(deps: AdmissionDeps) {
  const { pool, clock, config, delivery } = deps;
  const today = () => calendarDateIn(clock(), config.timeZone);

  /**
   * The applicant's own media, as a DTO: the storage key is replaced by a
   * short-lived signed URL. Verification media never gets a URL on any
   * applicant or member path (DEC-063): `storageKey` is empty for it.
   */
  const mediaDto = async (m: MediaRow): Promise<ApplicationMedia> => ({
    id: m.id,
    applicationId: m.application_id,
    type: m.type,
    purpose: m.purpose,
    storageKey: m.purpose === 'verification' || m.purged_at ? '' : await delivery.applicationPhotoUrl(m.storage_key),
    order: m.position,
    moderationStatus: m.moderation_status,
    requestId: m.request_id,
    retiredAt: m.retired_at,
    createdAt: m.created_at,
  });

  /** Signed URLs for the applicant's own (non-verification) photos referenced by requests. */
  async function photoUrls(rows: Map<string, MediaRow>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [id, m] of rows) {
      if (m.purpose !== 'verification' && !m.purged_at) out.set(id, await delivery.applicationPhotoUrl(m.storage_key));
    }
    return out;
  }

  async function requireApplication(db: Db, accountId: string, forUpdate = false): Promise<ApplicationRow> {
    return (await applicationOf(db, accountId, forUpdate)) ?? fail('NOT_ALLOWED');
  }

  async function privateOf(db: Db, applicationId: string): Promise<PrivateRow | null> {
    const { rows } = await db.query<PrivateRow>('SELECT * FROM app.application_private_data WHERE application_id = $1', [applicationId]);
    return rows[0] ?? null;
  }

  async function mediaByIds(db: Db, ids: string[]): Promise<Map<string, MediaRow>> {
    if (!ids.length) return new Map();
    const { rows } = await db.query<MediaRow>('SELECT * FROM app.application_media WHERE id = ANY($1)', [ids]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async function requestsOf(db: Db, applicationId: string): Promise<RequestRow[]> {
    const { rows } = await db.query<RequestRow>('SELECT * FROM app.information_requests WHERE application_id = $1 ORDER BY created_at, ordinal', [
      applicationId,
    ]);
    return rows;
  }

  /** The applicant's own view of one request (DEC-042): the request and their own current answer. */
  function projectRequest(
    req: RequestRow,
    priv: PrivateRow | null,
    mediaRows: Map<string, MediaRow>,
    urls: Map<string, string>,
  ): ApplicantInformationRequest {
    let current: ApplicantInformationRequest['current'] = null;
    switch (req.type) {
      case 'REPLACE_PHOTO': {
        const url = req.target?.kind === 'photo' ? urls.get(req.target.mediaId) : undefined;
        current = url ? { kind: 'photo', uri: url } : null;
        break;
      }
      case 'UPDATE_INSTAGRAM':
        current = priv ? { kind: 'instagram', handle: priv.instagram_handle } : null;
        break;
      case 'CLARIFY_WORK':
        current = priv ? { kind: 'work', occupation: priv.occupation, workContext: priv.work_context_answer } : null;
        break;
      case 'UPDATE_APPLICATION_FIELD':
        if (priv && req.target?.kind === 'field') {
          current = {
            kind: 'text',
            field: req.target.field,
            value: req.target.field === 'whatYouDo' ? priv.work_description : priv.personal_response,
          };
        }
        break;
      case 'VERIFY_IDENTITY':
        current = null;
        break;
    }
    const r = req.response;
    const answered = r && (r.type === 'REPLACE_PHOTO' || r.type === 'VERIFY_IDENTITY') ? mediaRows.get(r.mediaId) : undefined;
    const response: ApplicantInformationRequest['response'] = !r
      ? null
      : r.type === 'VERIFY_IDENTITY'
        ? // An identity photo is never shown back, not even to its owner: only that it was received.
          answered
          ? { kind: 'verification_received' }
          : null
        : r.type === 'REPLACE_PHOTO'
          ? answered && urls.get(answered.id)
            ? { kind: 'photo', uri: urls.get(answered.id)! }
            : null
        : r.type === 'UPDATE_INSTAGRAM'
          ? { kind: 'instagram', handle: r.handle }
          : r.type === 'CLARIFY_WORK'
            ? { kind: 'work', occupation: r.occupation, workContext: r.workContext }
            : { kind: 'text', value: r.value };
    return {
      id: req.id,
      type: req.type,
      explanation: req.explanation,
      target: req.target,
      status: req.status === 'withdrawn' ? 'resolved' : req.status,
      createdAt: req.created_at,
      resolvedAt: req.resolved_at,
      current,
      response,
    };
  }

  /** The applicant's own view: lifecycle record + display-only summary (never the date of birth). */
  async function mine(db: Db, accountId: string): Promise<MyApplication> {
    const app = await applicationOf(db, accountId);
    const membership = await membershipOf(db, accountId);
    const priv = app ? await privateOf(db, app.id) : null;
    const dob = priv ? parseISODate(priv.date_of_birth) : null;
    let informationRequests: ApplicantInformationRequest[] = [];
    if (app?.status === 'MORE_INFORMATION_REQUIRED') {
      const reqs = (await requestsOf(db, app.id)).filter((r) => r.status !== 'withdrawn' && r.status !== 'resolved');
      const ids = reqs.flatMap((r) => [
        ...(r.target?.kind === 'photo' ? [r.target.mediaId] : []),
        ...(r.response && 'mediaId' in r.response ? [r.response.mediaId] : []),
      ]);
      const rows = await mediaByIds(db, ids);
      const urls = await photoUrls(rows);
      informationRequests = reqs.map((r) => projectRequest(r, priv, rows, urls));
    }
    return {
      application: app ? toApplication(app) : null,
      membership: membership ? toMembership(membership) : null,
      summary: priv && dob ? { firstName: priv.first_name, age: ageOn(dob, today()), cityLabel: priv.city.label } : null,
      informationRequests,
    };
  }

  /** Same key → same resource (one application per account regardless). */
  async function rememberKey(db: Db, accountId: string, operation: string, idempotencyKey: string, resourceId: string, at: string) {
    await db.query(
      `INSERT INTO app.idempotency_keys (account_id, operation, key, resource_id, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [accountId, operation, idempotencyKey, resourceId, at],
    );
  }
  async function seenKey(db: Db, accountId: string, operation: string, idempotencyKey: string): Promise<boolean> {
    const { rowCount } = await db.query('SELECT 1 FROM app.idempotency_keys WHERE account_id = $1 AND operation = $2 AND key = $3', [
      accountId,
      operation,
      idempotencyKey,
    ]);
    return (rowCount ?? 0) > 0;
  }

  return {
    mine: (accountId: string) => mine(pool, accountId),

    async submitStage1(accountId: string, idempotencyKey: unknown, body: unknown): Promise<MembershipApplication> {
      const k = key(idempotencyKey);
      return tx(pool, async (db) => {
        await lockKey(db, `stage1:${accountId}`);
        // Idempotent: any repeat by this account returns the original application.
        const existing = await applicationOf(db, accountId);
        if (existing) return toApplication(existing);
        const checked = validateStage1Submission(body, today());
        if (!checked.ok) return fail('VALIDATION_FAILED', { fields: checked.fields });
        const s = checked.value;
        const at = clock().toISOString();
        const id = newId('app');
        // DRAFT → SUBMITTED → RECEIVED, validated by the shared lifecycle. Never further.
        const status: ApplicationStatus = transition(transition('APPLICATION_DRAFT', 'APPLICATION_SUBMITTED'), 'APPLICATION_RECEIVED');
        const { rows } = await db.query<ApplicationRow>(
          `INSERT INTO app.membership_applications (id, account_id, status, stage1_completed_at, submitted_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4, $4, $4) RETURNING *`,
          [id, accountId, status, at],
        );
        await db.query(
          `INSERT INTO app.application_private_data
             (application_id, first_name, last_name, date_of_birth, instagram_handle, country_code, city, referral_kind, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [id, s.firstName, s.lastName, s.dateOfBirth, s.instagram.handle, s.countryCode, JSON.stringify(s.city), s.referral.kind, at],
        );
        if (s.referral.kind === 'requested') {
          for (const r of s.referral.referrals) {
            // Matched against members privately later. The applicant is never told the outcome.
            await db.query(
              `INSERT INTO app.application_referrals (id, application_id, referrer_name, referrer_phone_e164, requested_at)
               VALUES ($1, $2, $3, $4, $5)`,
              [newId('ref'), id, r.name, r.phoneE164, at],
            );
          }
        }
        await rememberKey(db, accountId, 'stage1', k, id, at);
        await audit(db, at, {
          eventType: 'APPLICATION_SUBMITTED',
          actorType: 'applicant',
          accountId,
          applicationId: id,
          previousStatus: 'APPLICATION_DRAFT',
          newStatus: 'APPLICATION_RECEIVED',
        });
        return toApplication(rows[0]!);
      });
    },

    async startExtendedApplication(accountId: string): Promise<MyApplication> {
      return tx(pool, async (db) => {
        const app = await requireApplication(db, accountId, true);
        if (app.status === 'EXTENDED_APPLICATION_REQUIRED') {
          const at = clock().toISOString();
          await moveApplication(db, app, 'EXTENDED_APPLICATION_DRAFT', at);
          await audit(db, at, {
            eventType: 'EXTENDED_APPLICATION_STARTED',
            actorType: 'applicant',
            accountId,
            applicationId: app.id,
            previousStatus: 'EXTENDED_APPLICATION_REQUIRED',
            newStatus: 'EXTENDED_APPLICATION_DRAFT',
          });
        } else if (app.status !== 'EXTENDED_APPLICATION_DRAFT') {
          return fail('NOT_ALLOWED');
        }
        return mine(db, accountId);
      });
    },

    /** One of the applicant's own application media (after a completed upload). Never a verification URL. */
    async ownMedia(accountId: string, mediaId: string): Promise<ApplicationMedia> {
      const app = await requireApplication(pool, accountId);
      const { rows } = await pool.query<MediaRow>('SELECT * FROM app.application_media WHERE id = $1 AND application_id = $2', [mediaId, app.id]);
      return mediaDto(rows[0] ?? fail('NOT_FOUND'));
    },

    async submitStage2(accountId: string, idempotencyKey: unknown, body: unknown): Promise<MembershipApplication> {
      const k = key(idempotencyKey);
      return tx(pool, async (db) => {
        const app = await requireApplication(db, accountId, true);
        // Idempotent: a repeat (same key, or after acceptance) returns the application as it is.
        if ((await seenKey(db, accountId, 'stage2', k)) || app.extended_submitted_at) return toApplication(app);
        if (app.status !== 'EXTENDED_APPLICATION_DRAFT') return fail('NOT_ALLOWED');
        const { rows: own } = await db.query<{ id: string }>(
          `SELECT id FROM app.application_media WHERE application_id = $1 AND purpose = 'profile' AND request_id IS NULL AND retired_at IS NULL`,
          [app.id],
        );
        const owned = new Set(own.map((r) => r.id));
        const checked = validateStage2Submission(body, { ownsPhoto: (id) => owned.has(id) });
        if (!checked.ok) return fail('VALIDATION_FAILED', { fields: checked.fields });
        const v = checked.value;
        const at = clock().toISOString();
        let row = await moveApplication(db, app, 'EXTENDED_APPLICATION_SUBMITTED', at);
        // Server lifecycle: DRAFT → SUBMITTED → FINAL_REVIEW. Never to a decision (DEC-013).
        row = await moveApplication(db, row, 'FINAL_REVIEW', at, { extended_submitted_at: at, final_review_started_at: at });
        // Photo order as submitted; photos uploaded but removed before submitting are not part of the profile.
        await db.query(`UPDATE app.application_media SET position = -1 WHERE application_id = $1 AND request_id IS NULL`, [app.id]);
        for (const [position, id] of v.photoIds.entries()) {
          await db.query('UPDATE app.application_media SET position = $2 WHERE id = $1', [id, position]);
        }
        await db.query(
          `UPDATE app.application_private_data SET occupation = $2, work_context_answer = $3, work_context = $4,
             work_description = $5, personal_response = $6, interests = $7, intents = $8, updated_at = $9
           WHERE application_id = $1`,
          [app.id, v.occupation, JSON.stringify(v.workContext), v.workContextLabel, v.whatYouDo, v.aboutYou, v.interests, v.intents, at],
        );
        if (v.datingPreferences) {
          await db.query(
            `INSERT INTO app.application_dating_preferences (application_id, meet, age_min, age_max, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5)
             ON CONFLICT (application_id) DO UPDATE SET meet = EXCLUDED.meet, age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max, updated_at = EXCLUDED.updated_at`,
            [app.id, v.datingPreferences.meet, v.datingPreferences.ageRange.min, v.datingPreferences.ageRange.max, at],
          );
        }
        await rememberKey(db, accountId, 'stage2', k, app.id, at);
        await audit(db, at, {
          eventType: 'EXTENDED_APPLICATION_SUBMITTED',
          actorType: 'applicant',
          accountId,
          applicationId: app.id,
          previousStatus: 'EXTENDED_APPLICATION_DRAFT',
          newStatus: 'EXTENDED_APPLICATION_SUBMITTED',
        });
        await audit(db, at, {
          eventType: 'FINAL_REVIEW_STARTED',
          actorType: 'system',
          accountId,
          applicationId: app.id,
          previousStatus: 'EXTENDED_APPLICATION_SUBMITTED',
          newStatus: 'FINAL_REVIEW',
        });
        return toApplication(row);
      });
    },

    async respondToInformationRequest(accountId: string, requestId: string, body: unknown): Promise<MyApplication> {
      return tx(pool, async (db) => {
        const app = await requireApplication(db, accountId, true);
        const { rows } = await db.query<RequestRow>('SELECT * FROM app.information_requests WHERE id = $1 FOR UPDATE', [requestId]);
        const req = rows[0];
        if (app.status !== 'MORE_INFORMATION_REQUIRED' || !req || req.application_id !== app.id) return fail('NOT_ALLOWED');
        const response = (body ?? {}) as InformationResponse;
        if (typeof response !== 'object' || typeof (response as { type?: unknown }).type !== 'string') {
          return fail('VALIDATION_FAILED', { fields: [req.type] });
        }
        const { rows: uploaded } = await db.query<{ id: string }>(
          'SELECT id FROM app.application_media WHERE request_id = $1 AND retired_at IS NULL',
          [req.id],
        );
        let v: ReturnType<typeof validateResponse>;
        try {
          v = validateResponse(req, response, { uploadedForRequest: uploaded.map((r) => r.id) });
        } catch {
          return fail('VALIDATION_FAILED', { fields: [req.type] });
        }
        if (!v.ok) return v.error === 'invalid_value' ? fail('VALIDATION_FAILED', { fields: [req.type] }) : fail('NOT_ALLOWED');
        await db.query(`UPDATE app.information_requests SET response = $2, status = 'answered', answered_at = $3 WHERE id = $1`, [
          req.id,
          JSON.stringify(v.value),
          clock().toISOString(),
        ]);
        return mine(db, accountId);
      });
    },

    async submitInformationUpdate(accountId: string, idempotencyKey: unknown): Promise<MyApplication> {
      const k = key(idempotencyKey);
      return tx(pool, async (db) => {
        const app = await requireApplication(db, accountId, true);
        if (await seenKey(db, accountId, 'information_update', k)) return mine(db, accountId);
        if (app.status !== 'MORE_INFORMATION_REQUIRED') return fail('NOT_ALLOWED');
        const open = (await requestsOf(db, app.id)).filter((r) => r.status === 'open' || r.status === 'answered');
        if (open.length === 0 || open.some((r) => r.status !== 'answered' || !r.response)) {
          return fail('VALIDATION_FAILED', { fields: open.filter((r) => r.status !== 'answered').map((r) => r.id) });
        }
        const returnTo = isReviewReturnStage(app.more_information_return_to) ? app.more_information_return_to : 'UNDER_REVIEW';
        const at = clock().toISOString();
        for (const req of open) await applyResponse(db, app, req, at);
        await moveApplication(db, app, returnTo, at, {
          information_provided_at: at,
          ...(returnTo === 'FINAL_REVIEW' ? { final_review_started_at: at } : {}),
        });
        await rememberKey(db, accountId, 'information_update', k, app.id, at);
        await audit(db, at, {
          eventType: 'MORE_INFORMATION_PROVIDED',
          actorType: 'applicant',
          accountId,
          applicationId: app.id,
          previousStatus: 'MORE_INFORMATION_REQUIRED',
          newStatus: returnTo,
          metadata: { requestTypes: open.map((r) => r.type) },
        });
        return mine(db, accountId);
      });
    },

    async beginMembership(accountId: string): Promise<MyApplication> {
      return tx(pool, async (db) => {
        const app = await requireApplication(db, accountId, true);
        if (app.status === 'MEMBERSHIP_PAYMENT_REQUIRED') return mine(db, accountId);
        if (app.status !== 'APPROVED') return fail('NOT_ALLOWED');
        const plan = (await db.query<{ id: string }>('SELECT id FROM app.membership_plans WHERE active ORDER BY id LIMIT 1')).rows[0];
        if (!plan) return fail('NOT_ALLOWED'); // no plan offered yet (DEC-047)
        const at = clock().toISOString();
        await moveApplication(db, app, 'MEMBERSHIP_PAYMENT_REQUIRED', at);
        await db.query(
          `INSERT INTO app.memberships (id, account_id, plan_id, status, created_at, updated_at) VALUES ($1, $2, $3, 'pending', $4, $4)
           ON CONFLICT (account_id) DO NOTHING`,
          [newId('mbr'), accountId, plan.id, at],
        );
        await audit(db, at, {
          eventType: 'MEMBERSHIP_ACTIVATION_STARTED',
          actorType: 'applicant',
          accountId,
          applicationId: app.id,
          previousStatus: 'APPROVED',
          newStatus: 'MEMBERSHIP_PAYMENT_REQUIRED',
        });
        return mine(db, accountId);
      });
    },

    async getMembershipPlans(accountId: string): Promise<MembershipPlan[]> {
      const app = await requireApplication(pool, accountId);
      if (app.status !== 'APPROVED' && app.status !== 'MEMBERSHIP_PAYMENT_REQUIRED') return fail('NOT_ALLOWED');
      const { rows } = await pool.query<PlanRow>('SELECT * FROM app.membership_plans WHERE active ORDER BY id');
      return rows.map(toPlan);
    },
  };

  /** Apply one answered request to the private application. Only its own target changes. */
  async function applyResponse(db: Db, app: ApplicationRow, req: RequestRow, at: string) {
    const r = req.response!;
    switch (r.type) {
      case 'REPLACE_PHOTO': {
        if (req.target?.kind === 'photo') {
          const old = (await db.query<MediaRow>('SELECT * FROM app.application_media WHERE id = $1 AND application_id = $2', [req.target.mediaId, app.id]))
            .rows[0];
          if (old) {
            await db.query('UPDATE app.application_media SET position = $2 WHERE id = $1 AND application_id = $3', [r.mediaId, old.position, app.id]);
            await db.query('UPDATE app.application_media SET position = -1, retired_at = $2 WHERE id = $1', [old.id, at]);
          }
        }
        break;
      }
      case 'VERIFY_IDENTITY':
        // Stays a private verification photo; reviewed by the team, never on a profile.
        break;
      case 'UPDATE_INSTAGRAM':
        await db.query('UPDATE app.application_private_data SET instagram_handle = $2 WHERE application_id = $1', [app.id, r.handle]);
        break;
      case 'CLARIFY_WORK':
        await db.query(
          'UPDATE app.application_private_data SET occupation = $2, work_context_answer = $3, work_context = $4 WHERE application_id = $1',
          [
            app.id,
            r.occupation,
            JSON.stringify(r.workContext),
            r.workContext.kind === 'organisation' ? r.workContext.name : r.workContext.kind === 'independent' ? 'Independent' : null,
          ],
        );
        break;
      case 'UPDATE_APPLICATION_FIELD':
        await db.query(
          `UPDATE app.application_private_data SET ${r.field === 'whatYouDo' ? 'work_description' : 'personal_response'} = $2 WHERE application_id = $1`,
          [app.id, r.value],
        );
        break;
    }
    await db.query('UPDATE app.application_private_data SET updated_at = $2 WHERE application_id = $1', [app.id, at]);
    await db.query(`UPDATE app.information_requests SET status = 'resolved', resolved_at = $2 WHERE id = $1`, [req.id, at]);
  }
}

export type AdmissionService = ReturnType<typeof createAdmissionService>;
