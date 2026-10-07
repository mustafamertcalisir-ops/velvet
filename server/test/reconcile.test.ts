/**
 * Media reconciliation (docs/MEDIA_ARCHITECTURE.md §7): every category is
 * detected; dry run changes nothing; repair deletes only what is safe — never
 * verification objects without a record, never anything under a retention
 * hold, never young objects, never missing objects "fixed" by editing rows.
 */
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReconcileReport } from '../src/media/reconcile';
import { applicantInFinalReview, jpegBytesWithExif, signIn, stage1, testServer, type T } from './harness';

let t: T;
beforeAll(async () => {
  t = await testServer();
});
afterAll(async () => t.close());

const HOUR = 3_600_000;
const file = (bucket: string, key: string) => join(t.mediaDir, bucket, key);
/** Place an object directly in storage (as a crash, a race or a restore could leave it), aged relative to the API clock. */
function place(bucket: string, key: string, ageMs: number, bytes = Buffer.from('x')) {
  const p = file(bucket, key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  const when = new Date(t.clock.now().getTime() - ageMs);
  utimesSync(p, when, when);
}
const age = (bucket: string, key: string, ageMs: number) => {
  const when = new Date(t.clock.now().getTime() - ageMs);
  utimesSync(file(bucket, key), when, when);
};
const reconcile = async (mode?: 'dry-run' | 'repair') => (await t.internal<ReconcileReport>('POST', '/internal/media/reconcile', mode ? { mode } : undefined)).body;
const itemFor = (r: ReconcileReport, key: string) => r.items.find((i) => i.key === key);

describe('media reconciliation', () => {
  let ap: Awaited<ReturnType<typeof applicantInFinalReview>>;
  let held: Awaited<ReturnType<typeof applicantInFinalReview>>;
  const keys = {
    missing: '',
    live: '',
    orphanIncoming: '',
    unreferenced: '',
    young: '',
    unreferencedVerification: '',
    heldUnreferenced: '',
    unknown: '',
    failedDeletion: '',
  };

  beforeAll(async () => {
    ap = await applicantInFinalReview(t, { firstName: 'Nehir' });
    held = await applicantInFinalReview(t, { firstName: 'Defne' });
    await t.internal('POST', `/internal/safety/accounts/${held.accountId}/holds`, { actorId: 'safety.one', reason: 'SAFETY_REPORT' });

    // A live photo whose object went missing.
    const { rows } = await t.pool.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM app.application_media WHERE application_id = $1 ORDER BY position LIMIT 2`,
      [ap.applicationId],
    );
    keys.missing = rows[0]!.storage_key;
    keys.live = rows[1]!.storage_key;
    await t.store.delete('media', keys.missing);
    // Every existing object is old enough to be judged.
    for (const r of (await t.pool.query<{ storage_key: string }>(`SELECT storage_key FROM app.application_media`)).rows) {
      if (existsSync(file('media', r.storage_key))) age('media', r.storage_key, 48 * HOUR);
    }
    await t.admin.query(`UPDATE app.application_media SET created_at = created_at - interval '2 days'`);

    // A raw upload no upload row knows (e.g. its row was never committed); its url would be long dead.
    keys.orphanIncoming = 'incoming/20261004/upl_orphan_0001.bin';
    place('media', keys.orphanIncoming, 3 * HOUR);

    // Processed objects nobody references.
    keys.unreferenced = 'member/mem_ghost_0001/med_ghost_0001.jpg';
    place('media', keys.unreferenced, 30 * HOUR);
    keys.young = 'member/mem_ghost_0002/med_ghost_0002.jpg';
    place('media', keys.young, 1 * HOUR);
    keys.unreferencedVerification = `verification/${ap.applicationId}/med_ghost_0003.jpg`;
    place('verification', keys.unreferencedVerification, 30 * 24 * HOUR);
    keys.heldUnreferenced = `application/${held.applicationId}/med_ghost_0004.jpg`;
    place('media', keys.heldUnreferenced, 30 * HOUR);
    // A key outside the scheme.
    keys.unknown = 'stray/notes.txt';
    place('media', keys.unknown, 30 * HOUR);
    // A photo the database already purged, whose object survived (a failed deletion).
    const purged = (await t.pool.query<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM app.application_media WHERE application_id = $1 ORDER BY position DESC LIMIT 1`, [ap.applicationId])).rows[0]!;
    await t.admin.query(`UPDATE app.application_media SET purged_at = now() WHERE id = $1`, [purged.id]);
    keys.failedDeletion = purged.storage_key;
  });

  it('a dry run reports every category and changes nothing', async () => {
    const r = await reconcile();
    expect(r.mode).toBe('dry-run');
    expect(r.complete).toBe(true);
    expect(itemFor(r, keys.orphanIncoming)).toMatchObject({ category: 'ORPHANED_INCOMING', action: 'WOULD_DELETE' });
    expect(itemFor(r, keys.unreferenced)).toMatchObject({ category: 'UNREFERENCED', action: 'WOULD_DELETE' });
    expect(itemFor(r, keys.young)).toMatchObject({ category: 'UNREFERENCED', action: 'KEPT_YOUNG' });
    expect(itemFor(r, keys.unreferencedVerification)).toMatchObject({ category: 'UNREFERENCED_VERIFICATION', action: 'NEEDS_REVIEW', bucket: 'verification' });
    expect(itemFor(r, keys.heldUnreferenced)).toMatchObject({ category: 'UNREFERENCED', action: 'KEPT_HELD' });
    expect(itemFor(r, keys.unknown)).toMatchObject({ category: 'UNKNOWN_KEY', action: 'REPORT_ONLY' });
    expect(itemFor(r, keys.missing)).toMatchObject({ category: 'MISSING_OBJECT', action: 'REPORT_ONLY' });
    expect(itemFor(r, keys.failedDeletion)).toMatchObject({ category: 'FAILED_DELETION', action: 'WOULD_DELETE' });
    expect(itemFor(r, keys.live)).toBeUndefined();
    expect(r.actions.DELETED).toBe(0);
    for (const k of [keys.orphanIncoming, keys.unreferenced, keys.failedDeletion]) expect(existsSync(file('media', k))).toBe(true);
    // The log line carries counts only.
    const line = t.logLines.filter((l) => l.includes('"media.reconcile"')).at(-1)!;
    expect(line).not.toContain('ghost');
    expect(line).not.toContain(ap.applicationId);
  });

  it('repair deletes only the safe categories; a second repair finds nothing left to delete', async () => {
    const r = await reconcile('repair');
    expect(r.mode).toBe('repair');
    for (const k of [keys.orphanIncoming, keys.unreferenced, keys.failedDeletion]) {
      expect(itemFor(r, k)?.action, k).toBe('DELETED');
      expect(existsSync(file('media', k)), k).toBe(false);
    }
    // Kept: young, held, verification evidence without a record, unknown keys, live photos.
    expect(existsSync(file('media', keys.young))).toBe(true);
    expect(existsSync(file('media', keys.heldUnreferenced))).toBe(true);
    expect(existsSync(file('verification', keys.unreferencedVerification))).toBe(true);
    expect(existsSync(file('media', keys.unknown))).toBe(true);
    expect(existsSync(file('media', keys.live))).toBe(true);
    // The missing object is reported, never "repaired" by editing the row.
    expect((await t.pool.query(`SELECT purged_at FROM app.application_media WHERE storage_key = $1`, [keys.missing])).rows[0].purged_at).toBeNull();

    const again = await reconcile('repair');
    expect(again.actions.DELETED).toBe(0);
    expect(again.counts.ORPHANED_INCOMING + again.counts.FAILED_DELETION).toBe(0);
  });

  it('an upload still in progress is never touched', async () => {
    const s = await signIn(t);
    const a = await t.request('POST', '/v1/application', { token: s.token, headers: { 'Idempotency-Key': `p-${s.accountId}` }, body: stage1() });
    await t.internal('POST', `/internal/reviewer/applications/${a.body.id}/actions`, { reviewerId: 'r.one', action: { kind: 'START_REVIEW' } });
    await t.internal('POST', `/internal/reviewer/applications/${a.body.id}/actions`, { reviewerId: 'r.one', action: { kind: 'REQUEST_EXTENDED' } });
    await t.request('POST', '/v1/application/extended/start', { token: s.token });
    const bytes = await jpegBytesWithExif(3);
    const auth = await t.request('POST', '/v1/media/uploads', { token: s.token, body: { mediaClass: 'APPLICATION_MEDIA', contentType: 'image/jpeg', byteLength: bytes.length } });
    expect(auth.status).toBe(200);
    await t.request('PUT', auth.body.upload.url, { rawBody: new Uint8Array(bytes), headers: auth.body.upload.headers });
    const { rows } = await t.pool.query<{ incoming_key: string }>(`SELECT incoming_key FROM app.media_uploads WHERE id = $1`, [auth.body.uploadId]);
    age('media', rows[0]!.incoming_key, 3 * HOUR); // even an old file: the upload row is still PENDING and unexpired
    const r = await reconcile('repair');
    expect(itemFor(r, rows[0]!.incoming_key)).toBeUndefined();
    expect(existsSync(file('media', rows[0]!.incoming_key))).toBe(true);
    // It completes normally afterwards.
    expect((await t.request('POST', `/v1/media/uploads/${auth.body.uploadId}/complete`, { token: s.token })).status).toBe(200);
  });

  it('one run at a time: while another run holds the lock, a run is refused', async () => {
    const other = await t.admin.connect();
    try {
      await other.query('SELECT pg_advisory_lock(74120518)');
      const refused = await t.internal('POST', '/internal/media/reconcile', {});
      expect(refused.body.error.code).toBe('NOT_ALLOWED');
      await other.query('SELECT pg_advisory_unlock(74120518)');
      expect((await t.internal('POST', '/internal/media/reconcile', {})).status).toBe(200);
    } finally {
      other.release();
    }
  });

  it('refuses an unknown mode, unknown keys, and requires its own scope', async () => {
    expect((await t.internal('POST', '/internal/media/reconcile', { mode: 'delete-everything' })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await t.internal('POST', '/internal/media/reconcile', { Mode: 'repair' })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await t.internal('POST', '/internal/retention/run', { dry_run: true })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await t.internal('POST', '/internal/media/reconcile', undefined, { keyId: 'reviewer' })).status).toBe(401);
  });
});
