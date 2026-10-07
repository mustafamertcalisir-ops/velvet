/**
 * Authentication: phone → one-time code → account + session (DEC-061, DEC-066).
 *
 * Codes
 * - Random six digits (CSPRNG), valid 10 minutes, 5 attempts, single use;
 *   only an HMAC of the code is stored. A new request consumes earlier
 *   challenges for the number.
 * - Limits: per client address, per number (5/hour), 30 s resend cooldown,
 *   verification attempts per address and per number.
 * - Enumeration resistance: requesting a code behaves identically whether or
 *   not the number has an account; a wrong code reads the same either way.
 *
 * Sessions
 * - Random bearer tokens; only SHA-256 hashes are stored.
 * - Absolute expiry (SESSION_TTL_DAYS) and idle expiry (SESSION_IDLE_DAYS).
 * - Rotation: a session token can be exchanged once for a new one; presenting
 *   a rotated token again revokes the whole session family (reuse detection).
 * - Sign out, sign out everywhere; suspension and deletion revoke every session.
 */
import { E164 } from '@/domain/admission/submissions';
import type pg from 'pg';
import type { AuthenticatedApplicant, OtpChallenge } from '@/services/api/types';
import type { Config } from '../config';
import { tx, type Db } from '../db/pool';
import { fail } from '../http/errors';
import type { Clock } from '../lib/clock';
import { hmac, newId, newOtpCode, newToken, safeEqual, sha256 } from '../lib/crypto';
import type { Logger } from '../lib/log';
import { LIMITS, type RateLimiter } from '../ratelimit';
import { applicationOf, membershipOf, toAccount, toApplication, toMembership, type AccountRow } from '../records';
import { audit } from '../admission/lifecycle';
import { isTestNumber, SmsDeliveryError, type SmsProvider } from './sms';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
/** How often last_used_at is written (avoids a write per request). */
const TOUCH_INTERVAL_MS = 15 * 60 * 1000;

type Deps = { pool: pg.Pool; clock: Clock; config: Config; sms: SmsProvider; limiter: RateLimiter; log: Logger };

type ChallengeRow = {
  id: string;
  phone_e164: string;
  code_hash: string;
  expires_at: string;
  resend_available_at: string;
  attempts: number;
  consumed_at: string | null;
};

type SessionRow = {
  token_hash: string;
  account_id: string;
  family_id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  account_status: AccountRow['account_status'];
};

export type RevocationReason = 'SIGN_OUT' | 'SIGN_OUT_ALL' | 'ROTATED' | 'REUSE_DETECTED' | 'SUSPENDED' | 'DELETION_REQUESTED' | 'EXPIRED';

const BEARER = /^Bearer ([A-Za-z0-9_-]{20,200})$/;

/** Revoke every live session of an account (used by sign-out-all, suspension, deletion). */
export async function revokeAllSessions(db: Db, accountId: string, reason: RevocationReason, at: string): Promise<number> {
  const r = await db.query(
    `UPDATE app.sessions SET revoked_at = $2, revoked_reason = $3 WHERE account_id = $1 AND revoked_at IS NULL`,
    [accountId, at, reason],
  );
  return r.rowCount ?? 0;
}

export function createAuthService({ pool, clock, config, sms, limiter, log }: Deps) {
  const codeHash = (challengeId: string, code: string) => hmac(config.otpSecret, `${challengeId}:${code}`);
  const ttlMs = config.sessionTtlDays * 86_400_000;
  const idleMs = config.sessionIdleDays * 86_400_000;

  /** A new session; a rotation keeps its family and the family's ABSOLUTE expiry (rotating never extends a session's life). */
  async function issueSession(db: Db, accountId: string, family: { id: string; expiresAt: string } | null, at: Date): Promise<string> {
    const token = newToken();
    const hash = sha256(token);
    await db.query(
      `INSERT INTO app.sessions (token_hash, account_id, family_id, created_at, expires_at, last_used_at) VALUES ($1, $2, $3, $4, $5, $4)`,
      [hash, accountId, family?.id ?? hash, at.toISOString(), family?.expiresAt ?? new Date(at.getTime() + ttlMs).toISOString()],
    );
    return token;
  }

  async function requestOtp(phoneE164: unknown, clientAddress: string): Promise<OtpChallenge> {
    if (typeof phoneE164 !== 'string' || !E164.test(phoneE164)) return fail('INVALID_PHONE');
    await limiter.consume(LIMITS.otpRequestPerIp, clientAddress);
    const now = clock();
    // Resend cooldown, from the latest challenge for this number (accounts are never consulted).
    const latest = await pool.query<{ resend_available_at: string }>(
      'SELECT resend_available_at FROM app.otp_challenges WHERE phone_e164 = $1 ORDER BY created_at DESC LIMIT 1',
      [phoneE164],
    );
    const resendAt = latest.rows[0] ? new Date(latest.rows[0].resend_available_at).getTime() : 0;
    if (resendAt > now.getTime()) return fail('RATE_LIMITED', { retryAfterMs: resendAt - now.getTime() });
    await limiter.consume(LIMITS.otpRequestPerPhone, phoneE164);

    const id = newId('otp');
    const code = newOtpCode();
    const challenge: OtpChallenge = {
      challengeId: id,
      phoneE164,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
      resendAvailableAt: new Date(now.getTime() + OTP_RESEND_COOLDOWN_MS).toISOString(),
    };
    await tx(pool, async (db) => {
      await db.query('UPDATE app.otp_challenges SET consumed_at = $2 WHERE phone_e164 = $1 AND consumed_at IS NULL', [phoneE164, now.toISOString()]);
      await db.query(
        `INSERT INTO app.otp_challenges (id, phone_e164, code_hash, expires_at, resend_available_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, phoneE164, codeHash(id, code), challenge.expiresAt, challenge.resendAvailableAt, now.toISOString()],
      );
    });
    let receipt: { providerRef?: string } | void;
    try {
      receipt = await sms.sendVerificationCode({ phoneE164, code });
    } catch (e) {
      const failure = e instanceof SmsDeliveryError ? e.failure : 'PROVIDER_UNAVAILABLE';
      // Internal classification for operators; the client hears only a safe, retryable message.
      log.warn('sms.send_failed', { provider: sms.name, failure, detail: e instanceof SmsDeliveryError ? e.detail : 'unexpected' });
      // The challenge cannot be used: nobody received it.
      await pool.query('UPDATE app.otp_challenges SET consumed_at = $2 WHERE id = $1', [id, now.toISOString()]);
      return failure === 'INVALID_PHONE' ? fail('INVALID_PHONE') : fail('CODE_NOT_SENT');
    }
    // The provider's own message reference (e.g. a Netgsm job id) lets operators trace delivery; it carries no personal data.
    log.info('otp.sent', { provider: sms.name, providerRef: receipt?.providerRef ?? null });
    return challenge;
  }

  async function verifyOtp(challengeId: unknown, code: unknown, clientAddress: string): Promise<AuthenticatedApplicant> {
    if (typeof challengeId !== 'string' || typeof code !== 'string' || challengeId.length > 100) {
      return fail('VALIDATION_FAILED', { fields: ['code'] });
    }
    await limiter.consume(LIMITS.otpVerifyPerIp, clientAddress);
    const phone = (await pool.query<{ phone_e164: string }>('SELECT phone_e164 FROM app.otp_challenges WHERE id = $1', [challengeId])).rows[0]
      ?.phone_e164;
    if (phone) await limiter.consume(LIMITS.otpVerifyPerPhone, phone);
    const now = clock();
    const at = now.toISOString();
    type Outcome =
      | { error: 'CODE_EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'NOT_ALLOWED' }
      | { error: 'INVALID_CODE'; remaining: number }
      | { result: AuthenticatedApplicant };
    // The attempt is recorded even when the code is wrong (committed before answering).
    const outcome = await tx(pool, async (db): Promise<Outcome> => {
      const { rows } = await db.query<ChallengeRow>('SELECT * FROM app.otp_challenges WHERE id = $1 FOR UPDATE', [challengeId]);
      const c = rows[0];
      if (!c || c.consumed_at) return { error: 'CODE_EXPIRED' };
      if (now.getTime() > new Date(c.expires_at).getTime()) return { error: 'CODE_EXPIRED' };
      if (c.attempts >= OTP_MAX_ATTEMPTS) return { error: 'TOO_MANY_ATTEMPTS' };
      if (!/^\d{6}$/.test(code) || !safeEqual(codeHash(c.id, code), c.code_hash)) {
        const attempts = c.attempts + 1;
        await db.query('UPDATE app.otp_challenges SET attempts = $2 WHERE id = $1', [c.id, attempts]);
        const remaining = OTP_MAX_ATTEMPTS - attempts;
        return remaining <= 0 ? { error: 'TOO_MANY_ATTEMPTS' } : { error: 'INVALID_CODE', remaining };
      }
      await db.query('UPDATE app.otp_challenges SET consumed_at = $2 WHERE id = $1', [c.id, at]);

      let account = (await db.query<AccountRow>('SELECT * FROM app.accounts WHERE phone_e164 = $1 FOR UPDATE', [c.phone_e164])).rows[0];
      if (!account) {
        account = (
          await db.query<AccountRow>(
            `INSERT INTO app.accounts (id, phone_e164, phone_verified_at, qa_account, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $3, $3)
             ON CONFLICT (phone_e164) DO UPDATE SET updated_at = app.accounts.updated_at
             RETURNING *`,
            // Staging only: a designated test number, or a listed project-owned SIM, makes an isolated QA
            // account (neither list is accepted in production).
            [newId('usr'), c.phone_e164, at, isTestNumber(config.sms.testNumbers, c.phone_e164) || config.sms.qaRealNumbers.includes(c.phone_e164)],
          )
        ).rows[0]!;
        await audit(db, at, { eventType: 'PHONE_VERIFIED', actorType: 'applicant', accountId: account.id, applicationId: null });
      }
      // Only the number's owner reaches this point (they proved possession).
      if (account.account_status !== 'active') return { error: 'NOT_ALLOWED' };

      const token = await issueSession(db, account.id, null, now);
      const application = await applicationOf(db, account.id);
      const membership = await membershipOf(db, account.id);
      return {
        result: {
          session: { token, userId: account.id },
          account: toAccount(account),
          application: application ? toApplication(application) : null,
          membership: membership ? toMembership(membership) : null,
        },
      };
    });
    if ('error' in outcome) {
      return outcome.error === 'INVALID_CODE' ? fail('INVALID_CODE', { attemptsRemaining: outcome.remaining }) : fail(outcome.error);
    }
    return outcome.result;
  }

  async function sessionFor(token: string): Promise<SessionRow | null> {
    const { rows } = await pool.query<SessionRow>(
      `SELECT s.*, a.account_status FROM app.sessions s JOIN app.accounts a ON a.id = s.account_id WHERE s.token_hash = $1`,
      [sha256(token)],
    );
    return rows[0] ?? null;
  }

  /** Bearer token → account id, or UNAUTHENTICATED (expired, idle, revoked, suspended, deleted). */
  async function authenticate(authorization: string | undefined): Promise<string> {
    const m = BEARER.exec(authorization ?? '');
    if (!m) return fail('UNAUTHENTICATED');
    const s = await sessionFor(m[1]!);
    const now = clock();
    if (!s) return fail('UNAUTHENTICATED');
    if (s.revoked_at) {
      if (s.revoked_reason === 'ROTATED') {
        // A rotated token presented again: the family may be compromised.
        const n = await pool.query(
          `UPDATE app.sessions SET revoked_at = $2, revoked_reason = 'REUSE_DETECTED' WHERE family_id = $1 AND revoked_at IS NULL`,
          [s.family_id, now.toISOString()],
        );
        log.warn('session.reuse_detected', { revoked: n.rowCount ?? 0 });
      }
      return fail('UNAUTHENTICATED');
    }
    const idle = now.getTime() - new Date(s.last_used_at).getTime() > idleMs;
    if (new Date(s.expires_at).getTime() <= now.getTime() || idle) {
      await pool.query(`UPDATE app.sessions SET revoked_at = $2, revoked_reason = 'EXPIRED' WHERE token_hash = $1 AND revoked_at IS NULL`, [
        s.token_hash,
        now.toISOString(),
      ]);
      return fail('UNAUTHENTICATED');
    }
    if (s.account_status !== 'active') return fail('UNAUTHENTICATED');
    if (now.getTime() - new Date(s.last_used_at).getTime() > TOUCH_INTERVAL_MS) {
      await pool.query('UPDATE app.sessions SET last_used_at = $2 WHERE token_hash = $1', [s.token_hash, now.toISOString()]);
    }
    return s.account_id;
  }

  async function signOut(authorization: string | undefined): Promise<void> {
    const m = BEARER.exec(authorization ?? '');
    if (!m) return;
    await pool.query(`UPDATE app.sessions SET revoked_at = $2, revoked_reason = 'SIGN_OUT' WHERE token_hash = $1 AND revoked_at IS NULL`, [
      sha256(m[1]!),
      clock().toISOString(),
    ]);
  }

  /** Sign out on every device: every live session of the account is revoked. */
  async function signOutEverywhere(accountId: string): Promise<{ signedOut: true; sessions: number }> {
    const n = await revokeAllSessions(pool, accountId, 'SIGN_OUT_ALL', clock().toISOString());
    return { signedOut: true, sessions: n };
  }

  /** Exchange a live session token for a new one (same family). The old token stops working. */
  async function rotate(authorization: string | undefined): Promise<{ token: string; userId: string }> {
    const accountId = await authenticate(authorization);
    const old = sha256(BEARER.exec(authorization!)![1]!);
    return tx(pool, async (db) => {
      const { rows } = await db.query<SessionRow>(
        'SELECT s.*, a.account_status FROM app.sessions s JOIN app.accounts a ON a.id = s.account_id WHERE token_hash = $1 FOR UPDATE OF s',
        [old],
      );
      const s = rows[0];
      if (!s || s.revoked_at) return fail('UNAUTHENTICATED'); // a concurrent rotation won
      const now = clock();
      const token = await issueSession(db, accountId, { id: s.family_id, expiresAt: s.expires_at }, now);
      await db.query(`UPDATE app.sessions SET revoked_at = $2, revoked_reason = 'ROTATED', replaced_by = $3 WHERE token_hash = $1`, [
        old,
        now.toISOString(),
        sha256(token),
      ]);
      return { token, userId: accountId };
    });
  }

  return { requestOtp, verifyOtp, authenticate, signOut, signOutEverywhere, rotate };
}

export type AuthService = ReturnType<typeof createAuthService>;
