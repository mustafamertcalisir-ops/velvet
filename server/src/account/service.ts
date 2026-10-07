/**
 * Account lifecycle (DEC-066, docs/DATA_RETENTION.md).
 *
 *   active ──(deletion request)──▶ deletion_requested ──(retention process)──▶ anonymized
 *   active ◀──(safety tooling)──▶ suspended
 *
 * Deletion request — effective immediately, in one transaction:
 *   - every session is revoked (the device is signed out);
 *   - the member profile is hidden: out of discovery, no new introductions or
 *     matches, waiting introductions in either direction are withdrawn;
 *   - active matches end (ACCOUNT_DELETED) and their conversations close, so
 *     no new message can be sent either way;
 *   - the membership is cancelled (no further access; billing stops at the
 *     provider adapter);
 *   - the account is queued for anonymization by the retention process
 *     (retention/processor.ts), which removes private data and media unless a
 *     retention hold applies.
 *
 * Suspension — internal safety tooling only: sessions revoked, sign-in
 * refused, invisible to other members. Reinstatement restores access.
 * Retention holds — internal safety tooling only: keep an account's records
 * out of anonymization/purge while an investigation or legal request is open.
 */
import { INTERNAL_DECISION_REASONS, type InternalDecisionReason } from '@/domain/admission/audit';
import type pg from 'pg';
import { audit } from '../admission/lifecycle';
import { revokeAllSessions } from '../auth/service';
import { tx } from '../db/pool';
import { fail } from '../http/errors';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import type { Logger } from '../lib/log';
import { LIMITS, type RateLimiter } from '../ratelimit';
import type { AccountRow } from '../records';

type Deps = { pool: pg.Pool; clock: Clock; limiter: RateLimiter; log: Logger };

const ACTOR = /^[A-Za-z0-9_.@:-]{2,80}$/;
const HOLD_REASONS = ['SAFETY_REPORT', 'INVESTIGATION', 'LEGAL_REQUEST', 'OTHER'] as const;
type HoldReason = (typeof HOLD_REASONS)[number];

export type DeletionRequested = { deletionRequested: true };

export function createAccountService({ pool, clock, limiter, log }: Deps) {
  function actorOf(body: unknown): string {
    const a = (body as { actorId?: unknown } | null)?.actorId;
    return typeof a === 'string' && ACTOR.test(a) ? a : fail('VALIDATION_FAILED', { fields: ['actorId'] });
  }

  return {
    /** The signed-in person asks for their account to be deleted. Idempotent. */
    async requestDeletion(accountId: string, body: unknown): Promise<DeletionRequested> {
      if ((body as { confirm?: unknown } | null)?.confirm !== true) return fail('VALIDATION_FAILED', { fields: ['confirm'] });
      await limiter.consume(LIMITS.accountDeletionPerAccount, accountId);
      return tx(pool, async (db) => {
        const account = (await db.query<AccountRow>('SELECT * FROM app.accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0];
        if (!account) return fail('UNAUTHENTICATED');
        if (account.account_status === 'deletion_requested' || account.account_status === 'anonymized') return { deletionRequested: true };
        if (account.account_status !== 'active') return fail('UNAUTHENTICATED');
        const at = clock().toISOString();
        await db.query(
          `UPDATE app.accounts SET account_status = 'deletion_requested', deletion_requested_at = $2, updated_at = $2 WHERE id = $1`,
          [accountId, at],
        );
        const sessions = await revokeAllSessions(db, accountId, 'DELETION_REQUESTED', at);
        const member = (await db.query<{ id: string }>('SELECT id FROM app.member_profiles WHERE account_id = $1', [accountId])).rows[0]?.id;
        let matchesEnded = 0;
        if (member) {
          await db.query(`UPDATE app.member_profiles SET visibility = 'hidden', updated_at = $2 WHERE id = $1`, [member, at]);
          const ended = await db.query<{ id: string }>(
            `UPDATE app.matches SET status = 'ENDED', ended_at = $2, ended_reason = 'ACCOUNT_DELETED'
              WHERE (member_a = $1 OR member_b = $1) AND status = 'ACTIVE' RETURNING id`,
            [member, at],
          );
          matchesEnded = ended.rowCount ?? 0;
          if (matchesEnded) {
            await db.query('UPDATE app.conversations SET closed_at = coalesce(closed_at, $2) WHERE match_id = ANY($1)', [ended.rows.map((r) => r.id), at]);
          }
          await db.query(
            `UPDATE app.introduction_entries SET status = 'WITHDRAWN' WHERE status = 'PENDING' AND (viewer_id = $1 OR candidate_id = $1)`,
            [member],
          );
        }
        await db.query(
          `UPDATE app.memberships SET status = 'cancelled', ends_at = coalesce(ends_at, $2), updated_at = $2
            WHERE account_id = $1 AND status IN ('pending', 'active', 'grace_period')`,
          [accountId, at],
        );
        const app = (await db.query<{ id: string }>('SELECT id FROM app.membership_applications WHERE account_id = $1', [accountId])).rows[0];
        await audit(db, at, {
          eventType: 'ACCOUNT_DELETION_REQUESTED',
          actorType: member ? 'member' : 'applicant',
          accountId,
          applicationId: app?.id ?? null,
          metadata: { sessionsRevoked: sessions, matchesEnded },
        });
        log.info('account.deletion_requested', { sessionsRevoked: sessions, matchesEnded });
        return { deletionRequested: true };
      });
    },

    /** Safety tooling: suspend an account. Every session ends; sign-in is refused; other members no longer see them. */
    async suspend(accountId: string, body: unknown, principal: string): Promise<{ accountStatus: 'suspended'; sessionsRevoked: number }> {
      const actor = actorOf(body);
      const reason = (body as { reasonCode?: unknown } | null)?.reasonCode;
      if (!(INTERNAL_DECISION_REASONS as readonly unknown[]).includes(reason)) return fail('VALIDATION_FAILED', { fields: ['reasonCode'] });
      return tx(pool, async (db) => {
        const account = (await db.query<AccountRow>('SELECT * FROM app.accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0] ?? fail('NOT_FOUND');
        const at = clock().toISOString();
        if (account.account_status === 'suspended') return { accountStatus: 'suspended' as const, sessionsRevoked: 0 };
        if (account.account_status !== 'active') return fail('NOT_ALLOWED');
        await db.query(`UPDATE app.accounts SET account_status = 'suspended', suspended_at = $2, updated_at = $2 WHERE id = $1`, [accountId, at]);
        const n = await revokeAllSessions(db, accountId, 'SUSPENDED', at);
        await audit(db, at, {
          eventType: 'ACCOUNT_SUSPENDED',
          actorType: 'system',
          actorId: `${principal}:${actor}`,
          accountId,
          applicationId: null,
          reasonCode: reason as InternalDecisionReason,
          metadata: { sessionsRevoked: n },
        });
        return { accountStatus: 'suspended' as const, sessionsRevoked: n };
      });
    },

    async reinstate(accountId: string, body: unknown, principal: string): Promise<{ accountStatus: 'active' }> {
      const actor = actorOf(body);
      return tx(pool, async (db) => {
        const account = (await db.query<AccountRow>('SELECT * FROM app.accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0] ?? fail('NOT_FOUND');
        if (account.account_status === 'active') return { accountStatus: 'active' as const };
        if (account.account_status !== 'suspended') return fail('NOT_ALLOWED');
        const at = clock().toISOString();
        await db.query(`UPDATE app.accounts SET account_status = 'active', suspended_at = NULL, updated_at = $2 WHERE id = $1`, [accountId, at]);
        await audit(db, at, { eventType: 'ACCOUNT_REINSTATED', actorType: 'system', actorId: `${principal}:${actor}`, accountId, applicationId: null });
        return { accountStatus: 'active' as const };
      });
    },

    async placeHold(accountId: string, body: unknown, principal: string): Promise<{ holdId: string }> {
      const actor = actorOf(body);
      const reason = (body as { reason?: unknown } | null)?.reason;
      if (!(HOLD_REASONS as readonly unknown[]).includes(reason)) return fail('VALIDATION_FAILED', { fields: ['reason'] });
      return tx(pool, async (db) => {
        // Locks against a concurrent anonymization; a hold on data that is already gone would be a false assurance.
        const acc = (await db.query<{ account_status: string }>('SELECT account_status FROM app.accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0];
        if (!acc) return fail('NOT_FOUND');
        if (acc.account_status === 'anonymized') return fail('NOT_ALLOWED');
        const id = newId('hld');
        const at = clock().toISOString();
        await db.query(`INSERT INTO app.retention_holds (id, account_id, reason, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`, [
          id,
          accountId,
          reason as HoldReason,
          `${principal}:${actor}`,
          at,
        ]);
        await audit(db, at, {
          eventType: 'RETENTION_HOLD_PLACED',
          actorType: 'system',
          actorId: `${principal}:${actor}`,
          accountId,
          applicationId: null,
          metadata: { reason: reason as string },
        });
        return { holdId: id };
      });
    },

    async releaseHold(holdId: string, body: unknown, principal: string): Promise<{ released: true }> {
      const actor = actorOf(body);
      return tx(pool, async (db) => {
        const at = clock().toISOString();
        const r = await db.query<{ account_id: string }>(
          `UPDATE app.retention_holds SET released_at = $2, released_by = $3 WHERE id = $1 AND released_at IS NULL RETURNING account_id`,
          [holdId, at, `${principal}:${actor}`],
        );
        const hold = r.rows[0];
        if (!hold) {
          const exists = (await db.query('SELECT 1 FROM app.retention_holds WHERE id = $1', [holdId])).rowCount ?? 0;
          return exists ? { released: true as const } : fail('NOT_FOUND');
        }
        await audit(db, at, {
          eventType: 'RETENTION_HOLD_RELEASED',
          actorType: 'system',
          actorId: `${principal}:${actor}`,
          accountId: hold.account_id,
          applicationId: null,
        });
        return { released: true as const };
      });
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
