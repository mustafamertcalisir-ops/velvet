/**
 * Direct-upload media pipeline (DEC-063, docs/MEDIA_ARCHITECTURE.md).
 *
 *   1. client  → POST /v1/media/uploads          (class, type, size[, request])
 *   2. server  validates purpose + authorization for the media class, records a
 *              PENDING upload, answers with a short-lived signed PUT url
 *              (content type and length are part of the signature)
 *   3. client  → PUT bytes straight to private object storage (incoming/…)
 *   4. client  → POST /v1/media/uploads/{id}/complete
 *   5. server  re-checks authorization, reads the object (size-bounded),
 *              identifies it by content, re-encodes it (metadata stripped),
 *              stores the result under its final key, creates the media row,
 *              deletes the incoming object
 *   6. media is delivered only through short-lived signed urls minted for a
 *              caller allowed to see it at that moment
 *
 * Image bytes never travel through the API as JSON or base64.
 *
 * Classes
 *   APPLICATION_MEDIA   applicant's Stage 2 photos and photo replacements;
 *                       visible to the applicant themself and to reviewers
 *   VERIFICATION_MEDIA  identity confirmation photos; separate bucket, never
 *                       returned by any applicant or member endpoint, reviewer
 *                       access only (2-minute urls, every access logged)
 *   PROFILE_MEDIA       an active member's own profile photos; visible to
 *                       members allowed to see the profile (introduction or
 *                       active match), never across a block
 */
import { canAccessMemberProduct } from '@/domain/admission/access';
import { PHOTO_MAX } from '@/domain/admission/stage2';
import type pg from 'pg';
import { tx, type Db } from '../db/pool';
import { AppError, fail } from '../http/errors';
import type { Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import type { Logger } from '../lib/log';
import { LIMITS, type RateLimiter } from '../ratelimit';
import { applicationOf } from '../records';
import { isAcceptedImageType, MAX_PHOTO_BYTES, sanitizeImage, sniffImageType, type SanitizedImage } from './media';
import type { Bucket, ObjectStore } from './objectStore';

export const MEDIA_CLASSES = ['APPLICATION_MEDIA', 'VERIFICATION_MEDIA', 'PROFILE_MEDIA'] as const;
export type MediaClass = (typeof MEDIA_CLASSES)[number];
export const isMediaClass = (v: unknown): v is MediaClass => (MEDIA_CLASSES as readonly unknown[]).includes(v);

/** How long a signed upload url is valid. An upload not completed by then expires and its object is removed. */
export const UPLOAD_TTL_SECONDS = 10 * 60;
/** How long a signed delivery url is valid, per class. */
export const DELIVERY_TTL_SECONDS: Record<MediaClass, number> = {
  PROFILE_MEDIA: 15 * 60,
  APPLICATION_MEDIA: 10 * 60,
  VERIFICATION_MEDIA: 2 * 60,
};
/** Application media rows per application (Stage 2 + replacements) — a ceiling against abuse, not a product rule. */
const APPLICATION_MEDIA_CEILING = PHOTO_MAX * 4;

export const bucketOf = (c: MediaClass): Bucket => (c === 'VERIFICATION_MEDIA' ? 'verification' : 'media');

const PREFIX: Record<MediaClass, 'application' | 'verification' | 'member'> = {
  APPLICATION_MEDIA: 'application',
  VERIFICATION_MEDIA: 'verification',
  PROFILE_MEDIA: 'member',
};
export const finalKey = (c: MediaClass, owner: string, mediaId: string) => `${PREFIX[c]}/${owner}/${mediaId}.jpg`;
const incomingKey = (uploadId: string, at: Date) => `incoming/${at.toISOString().slice(0, 10).replaceAll('-', '')}/${uploadId}.bin`;

// --- Delivery -----------------------------------------------------------------------------------

/**
 * Signed delivery urls. There is deliberately no applicant- or member-facing
 * function for verification media: only `reviewerUrl` can mint one.
 */
export function createMediaDelivery(store: ObjectStore) {
  return {
    /** A member profile photo, for a caller the member service has authorised. */
    memberPhotoUrl: (key: string) => store.presignDownload('media', key, DELIVERY_TTL_SECONDS.PROFILE_MEDIA),
    /** An applicant's own application photo (or a reviewer). */
    applicationPhotoUrl: (key: string) => store.presignDownload('media', key, DELIVERY_TTL_SECONDS.APPLICATION_MEDIA),
    /** Internal reviewer access (logged by the caller). */
    reviewerUrl: (c: MediaClass, key: string) => store.presignDownload(bucketOf(c), key, DELIVERY_TTL_SECONDS[c]),
  };
}
export type MediaDelivery = ReturnType<typeof createMediaDelivery>;

// --- Uploads ---------------------------------------------------------------------------------------

type UploadRow = {
  id: string;
  account_id: string;
  media_class: MediaClass;
  request_id: string | null;
  declared_content_type: string;
  declared_bytes: number;
  incoming_key: string;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
  rejection_reason: string | null;
  media_id: string | null;
  created_at: string;
  expires_at: string;
};

export type UploadAuthorization = {
  uploadId: string;
  mediaClass: MediaClass;
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
  expiresAt: string;
};

export type CompletedUploadRef = { uploadId: string; mediaClass: MediaClass; mediaId: string };

type Owner = { owner: string; applicationId: string | null; memberId: string | null };

type Deps = { pool: pg.Pool; clock: Clock; store: ObjectStore; limiter: RateLimiter; log: Logger };

export function createMediaUploads({ pool, clock, store, limiter, log }: Deps) {
  /** May this account upload media of this class now? Answers the owner of the final object, or throws. */
  async function authorize(db: Db, accountId: string, mediaClass: MediaClass, requestId: string | null): Promise<Owner> {
    if (mediaClass === 'PROFILE_MEDIA') {
      if (requestId) return fail('VALIDATION_FAILED', { fields: ['requestId'] });
      const { rows } = await db.query<{ status: string; membership_status: string | null; member_id: string | null; account_status: string }>(
        `SELECT a.status, m.status AS membership_status, p.id AS member_id, acc.account_status
           FROM app.accounts acc
           JOIN app.membership_applications a ON a.account_id = acc.id
           LEFT JOIN app.memberships m ON m.account_id = acc.id
           LEFT JOIN app.member_profiles p ON p.account_id = acc.id AND p.deleted_at IS NULL
          WHERE acc.id = $1`,
        [accountId],
      );
      const r = rows[0];
      if (
        !r ||
        r.account_status !== 'active' ||
        !r.member_id ||
        !canAccessMemberProduct(r.status as never, r.membership_status ? { status: r.membership_status as never } : null)
      ) {
        return fail('MEMBERSHIP_REQUIRED');
      }
      return { owner: r.member_id, applicationId: null, memberId: r.member_id };
    }
    const app = (await applicationOf(db, accountId)) ?? fail('NOT_ALLOWED');
    if (!requestId) {
      // Stage 2 photos, while the extended draft is open. Verification media always answers a request.
      if (mediaClass !== 'APPLICATION_MEDIA' || app.status !== 'EXTENDED_APPLICATION_DRAFT') return fail('NOT_ALLOWED');
      return { owner: app.id, applicationId: app.id, memberId: null };
    }
    const { rows } = await db.query<{ application_id: string; status: string; type: string }>(
      'SELECT application_id, status, type FROM app.information_requests WHERE id = $1',
      [requestId],
    );
    const req = rows[0];
    const wanted = mediaClass === 'VERIFICATION_MEDIA' ? 'VERIFY_IDENTITY' : 'REPLACE_PHOTO';
    if (
      app.status !== 'MORE_INFORMATION_REQUIRED' ||
      !req ||
      req.application_id !== app.id ||
      (req.status !== 'open' && req.status !== 'answered') ||
      req.type !== wanted
    ) {
      return fail('NOT_ALLOWED');
    }
    return { owner: app.id, applicationId: app.id, memberId: null };
  }

  async function settle(id: string, status: 'REJECTED' | 'EXPIRED', reason: string | null) {
    await pool.query(`UPDATE app.media_uploads SET status = $2, rejection_reason = $3 WHERE id = $1 AND status = 'PENDING'`, [id, status, reason]);
  }

  async function removeObject(bucket: Bucket, key: string) {
    try {
      await store.delete(bucket, key);
    } catch (e) {
      log.warn('media.object_delete_failed', { bucket, errorName: (e as Error).name });
    }
  }

  async function lockUpload(db: Db, accountId: string, uploadId: string): Promise<UploadRow> {
    const { rows } = await db.query<UploadRow>('SELECT * FROM app.media_uploads WHERE id = $1 AND account_id = $2 FOR UPDATE', [uploadId, accountId]);
    return rows[0] ?? fail('NOT_FOUND');
  }

  return {
    /** Steps 1–2: validate and authorise, then hand out a signed upload url. */
    async authorizeUpload(accountId: string, body: unknown): Promise<UploadAuthorization> {
      const b = (body ?? {}) as { mediaClass?: unknown; contentType?: unknown; byteLength?: unknown; requestId?: unknown };
      const fields: string[] = [];
      if (!isMediaClass(b.mediaClass)) fields.push('mediaClass');
      if (!isAcceptedImageType(b.contentType)) fields.push('contentType');
      if (typeof b.byteLength !== 'number' || !Number.isInteger(b.byteLength) || b.byteLength <= 0) fields.push('byteLength');
      if (b.requestId !== undefined && b.requestId !== null && (typeof b.requestId !== 'string' || b.requestId.length > 100)) fields.push('requestId');
      if (fields.length) return fail('VALIDATION_FAILED', { fields });
      if ((b.byteLength as number) > MAX_PHOTO_BYTES) return fail('PAYLOAD_TOO_LARGE', { fields: ['photo'] });
      await limiter.consume(LIMITS.mediaUploadPerAccount, accountId);
      const mediaClass = b.mediaClass as MediaClass;
      const requestId = (b.requestId as string | null | undefined) ?? null;
      await authorize(pool, accountId, mediaClass, requestId);
      const now = clock();
      const id = newId('upl');
      const key = incomingKey(id, now);
      const contentType = b.contentType as string;
      const bytes = b.byteLength as number;
      const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString();
      await pool.query(
        `INSERT INTO app.media_uploads (id, account_id, media_class, request_id, declared_content_type, declared_bytes, incoming_key, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)`,
        [id, accountId, mediaClass, requestId, contentType, bytes, key, now.toISOString(), expiresAt],
      );
      const signed = await store.presignUpload(bucketOf(mediaClass), key, { contentType, bytes, ttlSeconds: UPLOAD_TTL_SECONDS });
      return { uploadId: id, mediaClass, upload: { url: signed.url, method: 'PUT', headers: signed.headers }, expiresAt };
    },

    /** Steps 4–6: confirm, process, store. Idempotent: completing twice answers the same media. */
    async completeUpload(accountId: string, uploadId: string): Promise<CompletedUploadRef> {
      if (typeof uploadId !== 'string' || !/^upl_[A-Za-z0-9_-]{10,40}$/.test(uploadId)) return fail('NOT_FOUND');
      // Phase 1 — state and authorization (short transaction, no I/O to storage).
      const pre = await tx(pool, async (db) => {
        const u = await lockUpload(db, accountId, uploadId);
        if (u.status === 'COMPLETED') return { done: { uploadId, mediaClass: u.media_class, mediaId: u.media_id! } };
        if (u.status === 'REJECTED') return fail('VALIDATION_FAILED', { fields: ['photo'] });
        if (u.status === 'EXPIRED' || new Date(u.expires_at).getTime() <= clock().getTime()) return { expired: u };
        try {
          await authorize(db, accountId, u.media_class, u.request_id);
        } catch (e) {
          return { refused: u, error: e };
        }
        return { upload: u };
      });
      if ('done' in pre) return pre.done!;
      if ('expired' in pre) {
        await settle(pre.expired!.id, 'EXPIRED', null);
        await removeObject(bucketOf(pre.expired!.media_class), pre.expired!.incoming_key);
        return fail('VALIDATION_FAILED', { fields: ['upload'] });
      }
      if ('refused' in pre) {
        await settle(pre.refused!.id, 'REJECTED', 'NOT_ALLOWED');
        await removeObject(bucketOf(pre.refused!.media_class), pre.refused!.incoming_key);
        throw pre.error;
      }
      const u = pre.upload!;
      const bucket = bucketOf(u.media_class);

      // Phase 2 — read the object (bounded by the authorised size) and process it.
      const raw = await store.get(bucket, u.incoming_key, Math.min(u.declared_bytes, MAX_PHOTO_BYTES));
      if (raw === null) return fail('VALIDATION_FAILED', { fields: ['upload'] }); // not uploaded (yet): the upload stays open until it expires
      if (raw === 'TOO_LARGE') {
        await settle(u.id, 'REJECTED', 'TOO_LARGE');
        await removeObject(bucket, u.incoming_key);
        return fail('PAYLOAD_TOO_LARGE', { fields: ['photo'] });
      }
      let image: SanitizedImage;
      try {
        // Identified by content; the content must also be what was declared.
        if (sniffImageType(raw) !== u.declared_content_type) fail('VALIDATION_FAILED', { fields: ['photo'] });
        image = await sanitizeImage(raw);
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        await settle(u.id, 'REJECTED', 'NOT_AN_IMAGE');
        await removeObject(bucket, u.incoming_key);
        throw e;
      }

      // Phase 3 — store the processed image, then record it (re-checking everything under lock).
      const mediaId = newId(u.media_class === 'PROFILE_MEDIA' ? 'mmd' : 'med');
      const owner = await authorize(pool, accountId, u.media_class, u.request_id);
      const key = finalKey(u.media_class, owner.owner, mediaId);
      await store.put(bucket, key, image.bytes, image.contentType);
      let result: CompletedUploadRef;
      try {
        result = await tx(pool, async (db) => {
          const again = await lockUpload(db, accountId, uploadId);
          if (again.status === 'COMPLETED') return { uploadId, mediaClass: again.media_class, mediaId: again.media_id!, raced: true };
          if (again.status !== 'PENDING') return fail('VALIDATION_FAILED', { fields: ['upload'] });
          const o = await authorize(db, accountId, u.media_class, u.request_id);
          // Serialise counting per owner: two completions at once cannot both take the last slot or the same position.
          if (o.memberId) await db.query('SELECT 1 FROM app.member_profiles WHERE id = $1 FOR UPDATE', [o.memberId]);
          else await db.query('SELECT 1 FROM app.membership_applications WHERE id = $1 FOR UPDATE', [o.applicationId]);
          const at = clock().toISOString();
          if (u.media_class === 'PROFILE_MEDIA') {
            const { rows } = await db.query<{ n: string }>(
              'SELECT count(*) AS n FROM app.member_media WHERE member_id = $1 AND position >= 0',
              [o.memberId],
            );
            const count = Number(rows[0]?.n ?? 0);
            if (count >= PHOTO_MAX) return fail('VALIDATION_FAILED', { fields: ['photos'] });
            await db.query(
              `INSERT INTO app.member_media (id, member_id, type, storage_key, content_type, width, height, position, created_at)
               VALUES ($1, $2, 'photo', $3, $4, $5, $6, $7, $8)`,
              [mediaId, o.memberId, key, image.contentType, image.width, image.height, count, at],
            );
            await db.query('UPDATE app.member_profiles SET updated_at = $2 WHERE id = $1', [o.memberId, at]);
          } else {
            const { rows: counts } = await db.query<{ n: string; stage2: string }>(
              `SELECT count(*) AS n, count(*) FILTER (WHERE request_id IS NULL) AS stage2 FROM app.application_media WHERE application_id = $1`,
              [o.applicationId],
            );
            if (Number(counts[0]?.n ?? 0) >= APPLICATION_MEDIA_CEILING) return fail('RATE_LIMITED', { retryAfterMs: 60_000 });
            await db.query(
              `INSERT INTO app.application_media
                 (id, application_id, type, purpose, storage_key, content_type, width, height, bytes, position, request_id, created_at)
               VALUES ($1, $2, 'photo', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                mediaId,
                o.applicationId,
                u.media_class === 'VERIFICATION_MEDIA' ? 'verification' : 'profile',
                key,
                image.contentType,
                image.width,
                image.height,
                image.bytes.length,
                // Request uploads join the profile only when the update is sent.
                u.request_id ? -1 : Number(counts[0]?.stage2 ?? 0),
                u.request_id,
                at,
              ],
            );
          }
          await db.query(`UPDATE app.media_uploads SET status = 'COMPLETED', media_id = $2, completed_at = $3 WHERE id = $1`, [uploadId, mediaId, at]);
          return { uploadId, mediaClass: u.media_class, mediaId };
        });
      } catch (e) {
        await removeObject(bucket, key);
        throw e;
      }
      if ((result as { raced?: boolean }).raced) await removeObject(bucket, key);
      await removeObject(bucket, u.incoming_key);
      return { uploadId: result.uploadId, mediaClass: result.mediaClass, mediaId: result.mediaId };
    },

    /**
     * Uploads never completed are marked EXPIRED. Then, once an upload's
     * signed url can no longer be used (expires_at passed), its incoming key
     * is deleted one final time whatever the outcome — a url could have been
     * re-used to PUT the object again after completion. Returns the number of
     * uploads newly expired.
     */
    async expireAbandoned(limit = 500): Promise<number> {
      const now = clock().toISOString();
      const { rows: expired } = await pool.query<UploadRow>(
        `UPDATE app.media_uploads SET status = 'EXPIRED'
          WHERE id IN (SELECT id FROM app.media_uploads WHERE status = 'PENDING' AND expires_at <= $1 ORDER BY expires_at LIMIT $2)
          RETURNING id`,
        [now, limit],
      );
      const { rows: settled } = await pool.query<UploadRow>(
        `UPDATE app.media_uploads SET incoming_swept_at = $1
          WHERE id IN (SELECT id FROM app.media_uploads WHERE status <> 'PENDING' AND incoming_swept_at IS NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2)
          RETURNING *`,
        [now, limit],
      );
      for (const u of settled) await removeObject(bucketOf(u.media_class), u.incoming_key);
      return expired.length;
    },
  };
}

export type MediaUploads = ReturnType<typeof createMediaUploads>;
