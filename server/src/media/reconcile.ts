/**
 * Media reconciliation (docs/MEDIA_ARCHITECTURE.md §7). Compares what private
 * storage holds with what the database says it should hold, and reports
 * the differences.
 *
 * Run through POST /internal/media/reconcile (scope media:reconcile).
 * DRY-RUN BY DEFAULT: nothing is deleted unless `mode: 'repair'` is asked for,
 * and even then only these actions are taken:
 *
 *   ORPHANED_INCOMING   raw uploads under incoming/ that no live upload can still
 *                       use (no upload row, upload finished/expired, or its
 *                       url has died) → deleted. They are unprocessed copies
 *                       that still carry metadata; never evidence.
 *   FAILED_DELETION     objects whose database record says they were already
 *                       deleted (purged media, swept uploads) → deleted again
 *                       — the database decision is authoritative.
 *   UNREFERENCED        processed objects in the MEDIA bucket that no database
 *                       row references, older than a day → deleted.
 *
 * Never deleted, only reported:
 *   UNREFERENCED_VERIFICATION  verification-bucket objects with no row: may be
 *                              identity evidence whose record is missing —
 *                              a person decides (NEEDS_REVIEW).
 *   MISSING_OBJECT             live rows whose object is absent: data loss to
 *                              investigate (restore from elsewhere or retire
 *                              the row through the product), never "fixed"
 *                              by editing rows.
 *   UNKNOWN_KEY                keys outside the application's key scheme.
 *
 * Retention holds always win: nothing tied to an account under an active
 * hold is deleted (KEPT_HELD). Young objects are left alone (an upload or a
 * completion may be in flight). Reports contain opaque keys and ids only —
 * no personal data — and the log line carries counts only.
 */
import type pg from 'pg';
import { fail } from '../http/errors';
import type { Clock } from '../lib/clock';
import type { Logger } from '../lib/log';
import { isObjectKey, listAll, type Bucket, type ObjectStore } from './objectStore';
import { UPLOAD_TTL_SECONDS } from './pipeline';

export type ReconcileMode = 'dry-run' | 'repair';

export type ReconcileCategory =
  | 'ORPHANED_INCOMING'
  | 'FAILED_DELETION'
  | 'UNREFERENCED'
  | 'UNREFERENCED_VERIFICATION'
  | 'MISSING_OBJECT'
  | 'UNKNOWN_KEY';

export type ReconcileAction = 'DELETED' | 'WOULD_DELETE' | 'KEPT_HELD' | 'KEPT_YOUNG' | 'NEEDS_REVIEW' | 'REPORT_ONLY' | 'DELETE_FAILED';

export type ReconcileItem = {
  category: ReconcileCategory;
  bucket: Bucket;
  key: string;
  /** The row involved (media id or upload id), when there is one. */
  ref: string | null;
  ageHours: number | null;
  action: ReconcileAction;
};

export type ReconcileReport = {
  mode: ReconcileMode;
  startedAt: string;
  finishedAt: string;
  /** False when a listing hit the object cap: MISSING_OBJECT is then not evaluated. */
  complete: boolean;
  scanned: Record<Bucket, number>;
  counts: Record<ReconcileCategory, number>;
  actions: Record<ReconcileAction, number>;
  /** At most ITEM_CAP items, most actionable first. */
  items: ReconcileItem[];
  itemsTruncated: boolean;
};

const HOUR = 3_600_000;
/** An incoming object is left alone until its upload url is dead, plus a margin. */
export const INCOMING_GRACE_MS = UPLOAD_TTL_SECONDS * 1000 + 15 * 60_000;
/** A processed object with no row is left alone this long (a completion may be committing). */
export const UNREFERENCED_GRACE_MS = 24 * HOUR;
/** Rows newer than this (relative to the start of the listing) are not checked for a missing object. */
const MISSING_MARGIN_MS = 15 * 60_000;
const ITEM_CAP = 200;
const DEFAULT_MAX_OBJECTS = 200_000;

const HELD_ACCOUNTS = `SELECT account_id FROM app.retention_holds WHERE released_at IS NULL`;
/** One reconciliation at a time (a session advisory lock held for the run). */
const RUN_LOCK = 74_120_518;

export function createMediaReconciler(deps: { pool: pg.Pool; store: ObjectStore; clock: Clock; log: Logger }) {
  const { pool, store, clock, log } = deps;

  return {
    async run(opts: { mode?: ReconcileMode; maxObjectsPerBucket?: number } = {}): Promise<ReconcileReport> {
      const lock = await pool.connect();
      try {
        const got = (await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [RUN_LOCK])).rows[0]?.ok;
        if (!got) return fail('NOT_ALLOWED'); // another run is in progress
        try {
          return await runLocked(opts);
        } finally {
          await lock.query('SELECT pg_advisory_unlock($1)', [RUN_LOCK]).catch(() => undefined);
        }
      } finally {
        lock.release();
      }
    },
  };

  async function runLocked(opts: { mode?: ReconcileMode; maxObjectsPerBucket?: number }): Promise<ReconcileReport> {
    const mode: ReconcileMode = opts.mode ?? 'dry-run';
    const max = opts.maxObjectsPerBucket ?? DEFAULT_MAX_OBJECTS;
    const started = clock();
    const now = started.getTime();
    const items: ReconcileItem[] = [];
    const counts = { ORPHANED_INCOMING: 0, FAILED_DELETION: 0, UNREFERENCED: 0, UNREFERENCED_VERIFICATION: 0, MISSING_OBJECT: 0, UNKNOWN_KEY: 0 };
    const actions = { DELETED: 0, WOULD_DELETE: 0, KEPT_HELD: 0, KEPT_YOUNG: 0, NEEDS_REVIEW: 0, REPORT_ONLY: 0, DELETE_FAILED: 0 };
    const scanned: Record<Bucket, number> = { media: 0, verification: 0 };
    let complete = true;

    // Holds are re-read for every page: a hold placed during a long run is honoured from the next page on.
    let held = new Set<string>();
    const age = (lastModified: string) => now - new Date(lastModified).getTime();
    const hours = (ms: number | null) => (ms === null ? null : Math.round((ms / HOUR) * 10) / 10);

    async function record(item: Omit<ReconcileItem, 'action'>, decision: 'delete' | 'held' | 'young' | 'review' | 'report', bucket: Bucket) {
      counts[item.category]++;
      let action: ReconcileAction;
      if (decision === 'held') action = 'KEPT_HELD';
      else if (decision === 'young') action = 'KEPT_YOUNG';
      else if (decision === 'review') action = 'NEEDS_REVIEW';
      else if (decision === 'report') action = 'REPORT_ONLY';
      else if (mode === 'dry-run') action = 'WOULD_DELETE';
      else {
        try {
          await store.delete(bucket, item.key);
          action = 'DELETED';
        } catch {
          action = 'DELETE_FAILED';
        }
      }
      actions[action]++;
      items.push({ ...item, action });
    }

    // Final objects listed, per bucket (for the MISSING_OBJECT pass).
    const present: Record<Bucket, Set<string>> = { media: new Set(), verification: new Set() };

    for (const bucket of ['media', 'verification'] as const) {
      let page: { key: string; bytes: number; lastModified: string }[] = [];
      const flush = async () => {
        if (page.length) await classify(bucket, page);
        page = [];
      };
      for await (const o of listAll(store, bucket, '')) {
        if (scanned[bucket] >= max) {
          complete = false;
          break;
        }
        scanned[bucket]++;
        page.push(o);
        if (page.length >= 500) await flush();
      }
      await flush();
    }

    async function classify(bucket: Bucket, objects: { key: string; bytes: number; lastModified: string }[]) {
      held = new Set((await pool.query<{ account_id: string }>(HELD_ACCOUNTS)).rows.map((r) => r.account_id));
      const incoming = objects.filter((o) => isObjectKey(o.key) && o.key.startsWith('incoming/'));
      const finals = objects.filter((o) => isObjectKey(o.key) && !o.key.startsWith('incoming/'));
      for (const o of objects.filter((x) => !isObjectKey(x.key))) {
        await record({ category: 'UNKNOWN_KEY', bucket, key: o.key, ref: null, ageHours: hours(age(o.lastModified)) }, 'report', bucket);
      }

      // Raw uploads.
      if (incoming.length) {
        const { rows } = await pool.query<{ id: string; account_id: string; status: string; expires_at: string; incoming_swept_at: string | null; incoming_key: string }>(
          `SELECT id, account_id, status, expires_at, incoming_swept_at, incoming_key FROM app.media_uploads WHERE incoming_key = ANY($1)`,
          [incoming.map((o) => o.key)],
        );
        const byKey = new Map(rows.map((r) => [r.incoming_key, r]));
        for (const o of incoming) {
          const u = byKey.get(o.key);
          const a = age(o.lastModified);
          const base = { bucket, key: o.key, ref: u?.id ?? null, ageHours: hours(a) };
          if (u?.incoming_swept_at) {
            await record({ ...base, category: 'FAILED_DELETION' }, held.has(u.account_id) ? 'held' : 'delete', bucket);
            continue;
          }
          const live = u && u.status === 'PENDING' && new Date(u.expires_at).getTime() > now;
          if (live) continue; // an upload still in progress
          const decision = a < INCOMING_GRACE_MS ? 'young' : u && held.has(u.account_id) ? 'held' : 'delete';
          await record({ ...base, category: 'ORPHANED_INCOMING' }, decision, bucket);
        }
      }

      // Processed objects.
      if (finals.length) {
        const keys = finals.map((o) => o.key);
        const { rows } = await pool.query<{ storage_key: string; id: string; purged: boolean; account_id: string | null }>(
          `SELECT am.storage_key, am.id, am.purged_at IS NOT NULL AS purged, a.account_id
             FROM app.application_media am JOIN app.membership_applications a ON a.id = am.application_id
            WHERE am.storage_key = ANY($1)
           UNION ALL
           SELECT mm.storage_key, mm.id, mm.purged_at IS NOT NULL AS purged, p.account_id
             FROM app.member_media mm JOIN app.member_profiles p ON p.id = mm.member_id
            WHERE mm.storage_key = ANY($1)`,
          [keys],
        );
        const byKey = new Map(rows.map((r) => [r.storage_key, r]));
        // Owners of unreferenced keys (from the key path), to honour holds.
        const owners = await ownersOf(finals.filter((o) => !byKey.has(o.key)).map((o) => o.key));
        for (const o of finals) {
          const row = byKey.get(o.key);
          const a = age(o.lastModified);
          const base = { bucket, key: o.key, ref: row?.id ?? null, ageHours: hours(a) };
          if (row && !row.purged) {
            present[bucket].add(o.key);
            continue;
          }
          if (row?.purged) {
            await record({ ...base, category: 'FAILED_DELETION' }, row.account_id && held.has(row.account_id) ? 'held' : 'delete', bucket);
            continue;
          }
          if (bucket === 'verification' || o.key.startsWith('verification/')) {
            // Possibly identity evidence whose record is missing: a person decides.
            await record({ ...base, category: 'UNREFERENCED_VERIFICATION' }, 'review', bucket);
            continue;
          }
          const owner = owners.get(o.key);
          const decision = a < UNREFERENCED_GRACE_MS ? 'young' : owner && held.has(owner) ? 'held' : 'delete';
          await record({ ...base, category: 'UNREFERENCED' }, decision, bucket);
        }
      }
    }

    /** application/{applicationId}/… and member/{memberId}/… → the owning account (when it still exists). */
    async function ownersOf(keys: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (!keys.length) return out;
      const parts = keys.map((k) => ({ key: k, kind: k.split('/')[0]!, owner: k.split('/')[1]! }));
      const apps = parts.filter((p) => p.kind === 'application' || p.kind === 'verification').map((p) => p.owner);
      const members = parts.filter((p) => p.kind === 'member').map((p) => p.owner);
      const { rows } = await pool.query<{ owner: string; account_id: string }>(
        `SELECT id AS owner, account_id FROM app.membership_applications WHERE id = ANY($1)
         UNION ALL SELECT id AS owner, account_id FROM app.member_profiles WHERE id = ANY($2)`,
        [apps, members],
      );
      const accountOf = new Map(rows.map((r) => [r.owner, r.account_id]));
      for (const p of parts) {
        const a = accountOf.get(p.owner);
        if (a) out.set(p.key, a);
      }
      return out;
    }

    // Live rows whose object is absent (only with a complete listing).
    if (complete) {
      const cutoff = new Date(now - MISSING_MARGIN_MS).toISOString();
      const { rows } = await pool.query<{ id: string; storage_key: string; bucket: Bucket }>(
        `SELECT id, storage_key, CASE WHEN purpose = 'verification' THEN 'verification' ELSE 'media' END AS bucket
           FROM app.application_media WHERE purged_at IS NULL AND created_at < $1
         UNION ALL
         SELECT id, storage_key, 'media' AS bucket FROM app.member_media WHERE purged_at IS NULL AND created_at < $1`,
        [cutoff],
      );
      for (const r of rows) {
        if (!present[r.bucket].has(r.storage_key)) {
          await record({ category: 'MISSING_OBJECT', bucket: r.bucket, key: r.storage_key, ref: r.id, ageHours: null }, 'report', r.bucket);
        }
      }
    }

    const order: ReconcileAction[] = ['DELETE_FAILED', 'NEEDS_REVIEW', 'REPORT_ONLY', 'DELETED', 'WOULD_DELETE', 'KEPT_HELD', 'KEPT_YOUNG'];
    items.sort((x, y) => order.indexOf(x.action) - order.indexOf(y.action));
    const report: ReconcileReport = {
      mode,
      startedAt: started.toISOString(),
      finishedAt: clock().toISOString(),
      complete,
      scanned,
      counts,
      actions,
      items: items.slice(0, ITEM_CAP),
      itemsTruncated: items.length > ITEM_CAP,
    };
    log.info('media.reconcile', { mode, complete, scanned, counts, actions });
    return report;
  }
}

export type MediaReconciler = ReturnType<typeof createMediaReconciler>;
