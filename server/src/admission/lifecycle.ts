/**
 * The only place server code changes an application's status. Every move is
 * validated with the shared lifecycle (src/domain/admission/status.ts) and
 * every meaningful change writes a structured audit event.
 */
import type { ActorType, AuditEventType, InternalDecisionReason } from '@/domain/admission/audit';
import { transition, type ApplicationStatus } from '@/domain/admission/status';
import type { Db } from '../db/pool';
import { newId } from '../lib/crypto';
import type { ApplicationRow } from '../records';

/** Server-side account events (not part of the applicant's application history). */
export type AccountEventType =
  | 'ACCOUNT_DELETION_REQUESTED'
  | 'ACCOUNT_ANONYMIZED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_REINSTATED'
  | 'RETENTION_HOLD_PLACED'
  | 'RETENTION_HOLD_RELEASED';

type TimestampColumn =
  | 'stage1_completed_at'
  | 'submitted_at'
  | 'review_started_at'
  | 'extended_requested_at'
  | 'extended_submitted_at'
  | 'final_review_started_at'
  | 'decision_at'
  | 'more_information_requested_at'
  | 'information_provided_at'
  | 'reopened_at';

export type ApplicationChanges = Partial<Record<TimestampColumn, string>> & {
  more_information_return_to?: 'UNDER_REVIEW' | 'FINAL_REVIEW' | null;
};

const ALLOWED = new Set<string>([
  'stage1_completed_at',
  'submitted_at',
  'review_started_at',
  'extended_requested_at',
  'extended_submitted_at',
  'final_review_started_at',
  'decision_at',
  'more_information_requested_at',
  'information_provided_at',
  'reopened_at',
  'more_information_return_to',
]);

/** Move along the lifecycle (throws InvalidTransitionError for anything the lifecycle forbids). */
export async function moveApplication(
  db: Db,
  app: ApplicationRow,
  to: ApplicationStatus,
  at: string,
  changes: ApplicationChanges = {},
): Promise<ApplicationRow> {
  const next = transition(app.status, to);
  const cols = Object.keys(changes).filter((k) => ALLOWED.has(k));
  const sets = cols.map((c, i) => `${c} = $${i + 4}`);
  const { rows } = await db.query<ApplicationRow>(
    `UPDATE app.membership_applications SET status = $2, updated_at = $3${sets.length ? ', ' + sets.join(', ') : ''}
     WHERE id = $1 RETURNING *`,
    [app.id, next, at, ...cols.map((c) => (changes as Record<string, unknown>)[c])],
  );
  return rows[0]!;
}

export async function audit(
  db: Db,
  at: string,
  e: {
    eventType: AuditEventType | AccountEventType;
    actorType: ActorType | 'member';
    accountId: string | null;
    applicationId: string | null;
    previousStatus?: ApplicationStatus | null;
    newStatus?: ApplicationStatus | null;
    actorId?: string | null;
    reasonCode?: InternalDecisionReason | null;
    metadata?: Record<string, string | number | boolean | null | string[]>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO app.audit_events
       (id, application_id, account_id, event_type, previous_status, new_status, actor_type, actor_id, reason_code, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      newId('evt'),
      e.applicationId,
      e.accountId,
      e.eventType,
      e.previousStatus ?? null,
      e.newStatus ?? null,
      e.actorType,
      e.actorId ?? null,
      e.reasonCode ?? null,
      JSON.stringify(e.metadata ?? {}),
      at,
    ],
  );
}
