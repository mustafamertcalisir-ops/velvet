/**
 * The retention process (DEC-067, docs/DATA_RETENTION.md). Run by operations
 * on a schedule through POST /internal/retention/run (scope retention:run).
 * Every step is idempotent; a failed step is retried by the next run.
 *
 * Always (operational housekeeping — no policy decision involved):
 *   - abandoned uploads expire and their incoming objects are deleted;
 *   - expired staging test-outbox codes, used internal nonces and stale
 *     rate-limit events are removed.
 *
 * Account deletion:
 *   - accounts in deletion_requested (past the configured grace window) and
 *     WITHOUT an active retention hold are anonymized: identity and private
 *     application data deleted, media objects deleted, the member profile
 *     reduced to a hidden "Former member" placeholder, the phone number
 *     released. Records other people's safety depends on (blocks, reports,
 *     messages in closed conversations) and the audit trail remain, pointing
 *     at the anonymized ids only.
 *   - accounts under a hold stay in deletion_requested (signed out, invisible)
 *     until the hold is released.
 *
 * Purge windows — each OFF unless configured (the durations are policy
 * decisions that have not been made; nothing is purged by default):
 *   removed profile photos, retired application photos, verification photos
 *   (after a decision), authentication records, safety records (messages of
 *   closed conversations, closed reports), audit records.
 * Safety and audit records can be deleted only inside a transaction that sets
 * app.retention_purge — the database refuses any other deletion (0008).
 */
import type pg from 'pg';
import type { Config } from '../config';
import { audit } from '../admission/lifecycle';
import { tx, type Db } from '../db/pool';
import type { Clock } from '../lib/clock';
import type { Logger } from '../lib/log';
import { INTERNAL_WINDOW_SECONDS } from '../http/internalAuth';
import type { MediaUploads } from '../media/pipeline';
import type { Bucket, ObjectStore } from '../media/objectStore';

type Deps = { pool: pg.Pool; clock: Clock; config: Config; store: ObjectStore; uploads: MediaUploads; log: Logger };

export type RetentionReport = {
  /** True: nothing was changed; every count is what a real run would do now. */
  dryRun: boolean;
  /** The configured windows in days (null = that purge is off — the policy is not decided). */
  windows: {
    deletionGraceHours: number;
    removedProfileMediaDays: number | null;
    retiredApplicationMediaDays: number | null;
    verificationMediaDays: number | null;
    authRecordsDays: number | null;
    safetyRecordsDays: number | null;
    auditRecordsDays: number | null;
  };
  uploadsExpired: number;
  accountsAnonymized: number;
  accountsHeld: number;
  mediaPurged: number;
  authRecordsPurged: number;
  safetyRecordsPurged: number;
  auditRecordsPurged: number;
};

export const FORMER_MEMBER_NAME = 'Former member';

const DAY = 86_400_000;
const BATCH = 200;

/** Accounts whose records must not be purged right now. */
const HELD = `SELECT account_id FROM app.retention_holds WHERE released_at IS NULL`;

// The rows each purge removes — one definition, used by the real run and by the dry run.
/** Messages of conversations closed before the window, unless either side is under a hold. */
const SAFETY_MESSAGES = `FROM app.messages msg JOIN app.conversations c ON c.id = msg.conversation_id JOIN app.matches mt ON mt.id = c.match_id
  WHERE c.closed_at IS NOT NULL AND c.closed_at < $1
    AND NOT EXISTS (SELECT 1 FROM app.member_profiles p WHERE p.id IN (mt.member_a, mt.member_b) AND p.account_id IN (${HELD}))`;
/** Closed reports older than the window, unless either side is under a hold. */
const SAFETY_REPORTS = `FROM app.reports rp WHERE rp.status = 'closed' AND rp.created_at < $1
    AND NOT EXISTS (SELECT 1 FROM app.member_profiles p WHERE p.id IN (rp.reporter_id, rp.reported_id) AND p.account_id IN (${HELD}))`;
const AUTH_OTP = `WHERE expires_at < $1`;
const AUTH_SESSIONS = `WHERE (revoked_at IS NOT NULL AND revoked_at < $1) OR expires_at < $1`;
const AUDIT_EVENTS = `WHERE created_at < $1 AND (account_id IS NULL OR account_id NOT IN (${HELD}))`;
/** Access logs older than the window, unless the account they concern is under a hold (like audit events). */
const MEDIA_ACCESS = `WHERE created_at < $1 AND media_id NOT IN (
    SELECT m.id FROM app.application_media m JOIN app.membership_applications a ON a.id = m.application_id WHERE a.account_id IN (${HELD}))`;
const APPLICATION_ACCESS = `WHERE created_at < $1 AND application_id NOT IN (
    SELECT a.id FROM app.membership_applications a WHERE a.account_id IN (${HELD}))`;

export function createRetentionProcessor({ pool, clock, config, store, uploads, log }: Deps) {
  const before = (days: number) => new Date(clock().getTime() - days * DAY).toISOString();

  /** Operational housekeeping (no policy decision): expired test codes, used nonces, stale rate events. */
  async function housekeeping(now: Date) {
    await pool.query('DELETE FROM app.sms_test_outbox WHERE expires_at <= $1', [now.toISOString()]);
    // Kept for longer than any timestamp the API still accepts (± the window, plus a margin).
    await pool.query('DELETE FROM app.internal_nonces WHERE seen_at < $1', [new Date(now.getTime() - (2 * INTERNAL_WINDOW_SECONDS + 60) * 1000).toISOString()]);
    await pool.query('DELETE FROM app.rate_limit_events WHERE at < $1', [before(2)]); // longer than the longest limit window
  }

  async function deleteObjects(objects: { bucket: Bucket; key: string }[]) {
    for (const o of objects) await store.delete(o.bucket, o.key);
  }

  /** Anonymize one account in deletion_requested. */
  async function anonymize(accountId: string): Promise<'anonymized' | 'held' | 'skipped'> {
    return tx(pool, async (db) => {
      const acc = (
        await db.query<{ id: string; phone_e164: string | null; account_status: string }>('SELECT * FROM app.accounts WHERE id = $1 FOR UPDATE', [accountId])
      ).rows[0];
      if (!acc || acc.account_status !== 'deletion_requested') return 'skipped';
      if (((await db.query(`${HELD} AND account_id = $1`, [accountId])).rowCount ?? 0) > 0) return 'held';
      const at = clock().toISOString();
      const app = (await db.query<{ id: string }>('SELECT id FROM app.membership_applications WHERE account_id = $1', [accountId])).rows[0];
      const member = (await db.query<{ id: string }>('SELECT id FROM app.member_profiles WHERE account_id = $1', [accountId])).rows[0];

      // Media: objects first (inside the transaction — if deletion fails, nothing is marked and the next run retries).
      const objects: { bucket: Bucket; key: string }[] = [];
      if (app) {
        const { rows } = await db.query<{ storage_key: string; purpose: string }>(
          'SELECT storage_key, purpose FROM app.application_media WHERE application_id = $1 AND purged_at IS NULL',
          [app.id],
        );
        for (const r of rows) objects.push({ bucket: r.purpose === 'verification' ? 'verification' : 'media', key: r.storage_key });
      }
      if (member) {
        const { rows } = await db.query<{ storage_key: string }>('SELECT storage_key FROM app.member_media WHERE member_id = $1 AND purged_at IS NULL', [member.id]);
        for (const r of rows) objects.push({ bucket: 'media', key: r.storage_key });
      }
      // Every upload's incoming object, whatever its status (a raw upload still carries its metadata).
      await db.query(`UPDATE app.media_uploads SET status = 'EXPIRED' WHERE account_id = $1 AND status = 'PENDING'`, [accountId]);
      const { rows: uploads } = await db.query<{ media_class: string; incoming_key: string }>(
        `UPDATE app.media_uploads SET incoming_swept_at = $2 WHERE account_id = $1 RETURNING media_class, incoming_key`,
        [accountId, at],
      );
      for (const u of uploads) objects.push({ bucket: u.media_class === 'VERIFICATION_MEDIA' ? 'verification' : 'media', key: u.incoming_key });
      await deleteObjects(objects);

      if (app) {
        await db.query('UPDATE app.application_media SET purged_at = $2 WHERE application_id = $1 AND purged_at IS NULL', [app.id, at]);
        await db.query('DELETE FROM app.application_private_data WHERE application_id = $1', [app.id]);
        await db.query('DELETE FROM app.application_referrals WHERE application_id = $1', [app.id]);
        await db.query('DELETE FROM app.application_dating_preferences WHERE application_id = $1', [app.id]);
        // Answers to information requests may carry personal text or handles.
        await db.query('UPDATE app.information_requests SET response = NULL WHERE application_id = $1 AND response IS NOT NULL', [app.id]);
      }
      if (member) {
        await db.query(
          `UPDATE app.member_media SET purged_at = $2, position = -1, removed_at = coalesce(removed_at, $2) WHERE member_id = $1 AND purged_at IS NULL`,
          [member.id, at],
        );
        await db.query('DELETE FROM app.dating_settings WHERE member_id = $1', [member.id]);
        await db.query(
          `UPDATE app.member_profiles SET display_name = $2, occupation = NULL, city_label = NULL, bio = NULL, known_for = NULL,
             interests = '{}', intents = '{}', visibility = 'hidden', deleted_at = $3, updated_at = $3 WHERE id = $1`,
          [member.id, FORMER_MEMBER_NAME, at],
        );
      }
      await db.query(
        `UPDATE app.memberships SET status = 'cancelled', ends_at = coalesce(ends_at, $2), updated_at = $2
          WHERE account_id = $1 AND status IN ('pending', 'active', 'grace_period')`,
        [accountId, at],
      );
      await db.query('DELETE FROM app.idempotency_keys WHERE account_id = $1', [accountId]);
      await db.query('DELETE FROM app.sessions WHERE account_id = $1', [accountId]);
      if (acc.phone_e164) {
        await db.query('DELETE FROM app.otp_challenges WHERE phone_e164 = $1', [acc.phone_e164]);
        await db.query('DELETE FROM app.sms_test_outbox WHERE phone_e164 = $1', [acc.phone_e164]);
        await db.query('DELETE FROM app.rate_limit_events WHERE subject = $1', [acc.phone_e164]);
      }
      await db.query('DELETE FROM app.rate_limit_events WHERE subject = $1', [accountId]);
      await db.query(
        `UPDATE app.accounts SET phone_e164 = NULL, phone_verified_at = NULL, account_status = 'anonymized', anonymized_at = $2, updated_at = $2 WHERE id = $1`,
        [accountId, at],
      );
      await audit(db, at, {
        eventType: 'ACCOUNT_ANONYMIZED',
        actorType: 'system',
        accountId,
        applicationId: app?.id ?? null,
        metadata: { mediaObjectsDeleted: objects.length },
      });
      return 'anonymized';
    });
  }

  /** Delete media objects in a purge window, then mark the rows purged (dry run: count them). */
  async function purgeMedia(select: string, params: unknown[], table: 'application_media' | 'member_media', alias: string, dryRun = false): Promise<number> {
    if (dryRun) return count(select, params);
    let total = 0;
    for (;;) {
      const n = await tx(pool, async (db) => {
        const { rows } = await db.query<{ id: string; storage_key: string; bucket: Bucket }>(`${select} LIMIT ${BATCH} FOR UPDATE OF ${alias} SKIP LOCKED`, params);
        if (!rows.length) return 0;
        await deleteObjects(rows.map((r) => ({ bucket: r.bucket, key: r.storage_key })));
        await db.query(`UPDATE app.${table} SET purged_at = $2 WHERE id = ANY($1)`, [rows.map((r) => r.id), clock().toISOString()]);
        return rows.length;
      });
      total += n;
      if (n < BATCH) return total;
    }
  }

  async function purgeSafety(db: Db, days: number): Promise<number> {
    await db.query(`SET LOCAL app.retention_purge = 'on'`);
    const cutoff = before(days);
    const m = await db.query(`DELETE FROM app.messages WHERE id IN (SELECT msg.id ${SAFETY_MESSAGES})`, [cutoff]);
    const r = await db.query(`DELETE FROM app.reports WHERE id IN (SELECT rp.id ${SAFETY_REPORTS})`, [cutoff]);
    return (m.rowCount ?? 0) + (r.rowCount ?? 0);
  }

  const count = async (sql: string, params: unknown[]) => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) x`, params)).rows[0]!.n;

  return {
    anonymize,

    /**
     * Apply the policy — or, with `dryRun`, only count what would happen: no
     * row is changed, no object deleted, no hold or account touched. Each step
     * is counted against the current state, so a row that an earlier step
     * would remove (an anonymized account's sessions) can also be counted by a
     * later window: dry-run counts are an upper bound.
     */
    async run(opts: { dryRun?: boolean } = {}): Promise<RetentionReport> {
      const dryRun = opts.dryRun === true;
      const r = config.retention;
      const report: RetentionReport = {
        dryRun,
        windows: {
          deletionGraceHours: r.deletionGraceHours,
          removedProfileMediaDays: r.removedProfileMediaDays,
          retiredApplicationMediaDays: r.retiredApplicationMediaDays,
          verificationMediaDays: r.verificationMediaDays,
          authRecordsDays: r.authRecordsDays,
          safetyRecordsDays: r.safetyRecordsDays,
          auditRecordsDays: r.auditRecordsDays,
        },
        uploadsExpired: 0,
        accountsAnonymized: 0,
        accountsHeld: 0,
        mediaPurged: 0,
        authRecordsPurged: 0,
        safetyRecordsPurged: 0,
        auditRecordsPurged: 0,
      };
      const now = clock();

      // Housekeeping.
      if (dryRun) {
        report.uploadsExpired = await count(`SELECT 1 FROM app.media_uploads WHERE status = 'PENDING' AND expires_at <= $1`, [now.toISOString()]);
      } else {
        report.uploadsExpired = await uploads.expireAbandoned();
        await housekeeping(now);
      }

      // Deletion queue.
      const { rows: queue } = await pool.query<{ id: string }>(
        `SELECT id FROM app.accounts WHERE account_status = 'deletion_requested' AND deletion_requested_at <= $1 ORDER BY deletion_requested_at LIMIT 500`,
        [new Date(now.getTime() - r.deletionGraceHours * 3_600_000).toISOString()],
      );
      for (const a of queue) {
        if (dryRun) {
          const isHeld = ((await pool.query(`${HELD} AND account_id = $1`, [a.id])).rowCount ?? 0) > 0;
          if (isHeld) report.accountsHeld++;
          else report.accountsAnonymized++;
          continue;
        }
        try {
          const outcome = await anonymize(a.id);
          if (outcome === 'anonymized') report.accountsAnonymized++;
          if (outcome === 'held') report.accountsHeld++;
        } catch (e) {
          log.error('retention.anonymize_failed', { errorName: (e as Error).name });
        }
      }

      // Purge windows (each off unless configured).
      const notHeldMember = (alias: string) => `NOT EXISTS (SELECT 1 FROM app.member_profiles hp WHERE hp.id = ${alias}.member_id AND hp.account_id IN (${HELD}))`;
      const notHeldApp = (alias: string) =>
        `NOT EXISTS (SELECT 1 FROM app.membership_applications ha WHERE ha.id = ${alias}.application_id AND ha.account_id IN (${HELD}))`;
      if (r.removedProfileMediaDays) {
        report.mediaPurged += await purgeMedia(
          `SELECT mm.id, mm.storage_key, 'media' AS bucket FROM app.member_media mm
            WHERE mm.removed_at IS NOT NULL AND mm.purged_at IS NULL AND mm.removed_at < $1 AND ${notHeldMember('mm')}
              AND NOT EXISTS (SELECT 1 FROM app.reports rp WHERE rp.reported_id = mm.member_id AND rp.status <> 'closed')`,
          [before(r.removedProfileMediaDays)],
          'member_media',
          'mm',
          dryRun,
        );
      }
      if (r.retiredApplicationMediaDays) {
        report.mediaPurged += await purgeMedia(
          `SELECT am.id, am.storage_key, 'media' AS bucket FROM app.application_media am
            WHERE am.purpose = 'profile' AND am.retired_at IS NOT NULL AND am.purged_at IS NULL AND am.retired_at < $1 AND ${notHeldApp('am')}`,
          [before(r.retiredApplicationMediaDays)],
          'application_media',
          'am',
          dryRun,
        );
      }
      if (r.verificationMediaDays) {
        // Only once the application has left review (a decision exists, or membership is active).
        report.mediaPurged += await purgeMedia(
          `SELECT am.id, am.storage_key, 'verification' AS bucket FROM app.application_media am
             JOIN app.membership_applications a ON a.id = am.application_id
            WHERE am.purpose = 'verification' AND am.purged_at IS NULL AND am.created_at < $1 AND a.decision_at IS NOT NULL
              AND a.status NOT IN ('UNDER_REVIEW', 'FINAL_REVIEW', 'MORE_INFORMATION_REQUIRED') AND ${notHeldApp('am')}`,
          [before(r.verificationMediaDays)],
          'application_media',
          'am',
          dryRun,
        );
      }
      if (r.authRecordsDays) {
        const cutoff = before(r.authRecordsDays);
        if (dryRun) {
          report.authRecordsPurged = (await count(`SELECT 1 FROM app.otp_challenges ${AUTH_OTP}`, [cutoff])) + (await count(`SELECT 1 FROM app.sessions ${AUTH_SESSIONS}`, [cutoff]));
        } else {
          const o = await pool.query(`DELETE FROM app.otp_challenges ${AUTH_OTP}`, [cutoff]);
          const s = await pool.query(`DELETE FROM app.sessions ${AUTH_SESSIONS}`, [cutoff]);
          report.authRecordsPurged = (o.rowCount ?? 0) + (s.rowCount ?? 0);
        }
      }
      if (r.safetyRecordsDays) {
        const cutoff = before(r.safetyRecordsDays);
        report.safetyRecordsPurged = dryRun
          ? (await count(`SELECT msg.id ${SAFETY_MESSAGES}`, [cutoff])) + (await count(`SELECT rp.id ${SAFETY_REPORTS}`, [cutoff]))
          : await tx(pool, (db) => purgeSafety(db, r.safetyRecordsDays!));
      }
      if (r.auditRecordsDays) {
        const cutoff = before(r.auditRecordsDays);
        report.auditRecordsPurged = dryRun
          ? (await count(`SELECT 1 FROM app.audit_events ${AUDIT_EVENTS}`, [cutoff])) +
            (await count(`SELECT 1 FROM app.media_access_log ${MEDIA_ACCESS}`, [cutoff])) +
            (await count(`SELECT 1 FROM app.application_access_log ${APPLICATION_ACCESS}`, [cutoff]))
          : await tx(pool, async (db) => {
              await db.query(`SET LOCAL app.retention_purge = 'on'`);
              const a = await db.query(`DELETE FROM app.audit_events ${AUDIT_EVENTS}`, [cutoff]);
              const l = await db.query(`DELETE FROM app.media_access_log ${MEDIA_ACCESS}`, [cutoff]);
              const v = await db.query(`DELETE FROM app.application_access_log ${APPLICATION_ACCESS}`, [cutoff]);
              return (a.rowCount ?? 0) + (l.rowCount ?? 0) + (v.rowCount ?? 0);
            });
      }
      log.info(dryRun ? 'retention.dry_run' : 'retention.run', { ...report });
      return report;
    },
  };
}

export type RetentionProcessor = ReturnType<typeof createRetentionProcessor>;
