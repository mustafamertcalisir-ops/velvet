/**
 * Rate limits — sliding windows stored in PostgreSQL (one shared store for
 * every API instance; never only in process memory). A Redis-backed limiter can
 * replace this behind the same interface when traffic warrants it.
 *
 * Each `consume` runs in its own short transaction, serialised per
 * (bucket, subject) with an advisory lock, so a burst cannot slip past the
 * count. Limits count attempts, including ones that later fail validation.
 */
import type pg from 'pg';
import { fail } from './http/errors';
import type { Clock } from './lib/clock';
import { lockKey, tx } from './db/pool';

export type Limit = { bucket: string; max: number; windowMs: number };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The policy (DEC-062). Generous for people, tight for scripts. */
export const LIMITS = {
  otpRequestPerPhone: { bucket: 'otp_request_phone', max: 5, windowMs: HOUR },
  otpRequestPerIp: { bucket: 'otp_request_ip', max: 30, windowMs: HOUR },
  otpVerifyPerIp: { bucket: 'otp_verify_ip', max: 60, windowMs: HOUR },
  /** Sign-in attempts against one number, across challenges. */
  otpVerifyPerPhone: { bucket: 'otp_verify_phone', max: 20, windowMs: HOUR },
  reactionPerMember: { bucket: 'reaction', max: 200, windowMs: HOUR },
  messagePerMinute: { bucket: 'message_minute', max: 30, windowMs: MIN },
  messagePerDay: { bucket: 'message_day', max: 1000, windowMs: DAY },
  reportPerMember: { bucket: 'report', max: 20, windowMs: DAY },
  profileUpdatePerMember: { bucket: 'profile_update', max: 60, windowMs: HOUR },
  /** Upload authorizations (each one is a signed upload URL). */
  mediaUploadPerAccount: { bucket: 'media_upload', max: 40, windowMs: HOUR },
  accountDeletionPerAccount: { bucket: 'account_deletion', max: 5, windowMs: HOUR },
  datingSettingsPerMember: { bucket: 'dating_settings', max: 30, windowMs: HOUR },
} as const satisfies Record<string, Limit>;

export type RateLimiter = {
  /** Count one attempt, or throw RATE_LIMITED with a retry hint. */
  consume(limit: Limit, subject: string): Promise<void>;
};

export function createRateLimiter(pool: pg.Pool, clock: Clock): RateLimiter {
  return {
    async consume(limit, subject) {
      const verdict = await tx(pool, async (db) => {
        await lockKey(db, `rl:${limit.bucket}:${subject}`);
        const now = clock();
        const since = new Date(now.getTime() - limit.windowMs).toISOString();
        await db.query('DELETE FROM app.rate_limit_events WHERE bucket = $1 AND subject = $2 AND at <= $3', [limit.bucket, subject, since]);
        const { rows } = await db.query<{ n: string; oldest: string | null }>(
          'SELECT count(*) AS n, min(at) AS oldest FROM app.rate_limit_events WHERE bucket = $1 AND subject = $2',
          [limit.bucket, subject],
        );
        const n = Number(rows[0]?.n ?? 0);
        if (n >= limit.max) {
          const oldest = rows[0]?.oldest ? new Date(rows[0].oldest).getTime() : now.getTime();
          return { ok: false as const, retryAfterMs: Math.max(1000, oldest + limit.windowMs - now.getTime()) };
        }
        await db.query('INSERT INTO app.rate_limit_events (bucket, subject, at) VALUES ($1, $2, $3)', [limit.bucket, subject, now.toISOString()]);
        return { ok: true as const };
      });
      if (!verdict.ok) fail('RATE_LIMITED', { retryAfterMs: verdict.retryAfterMs });
    },
  };
}
