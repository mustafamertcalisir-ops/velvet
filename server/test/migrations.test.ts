/** The migration runner: ordered, once, checksummed. */
import { mkdtempSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { MIGRATIONS_DIR, migrate, migrationStatus } from '../src/db/migrate';

let admin: pg.Client;
let pool: pg.Pool;
const name = `velvet_mig_${process.pid}_${Date.now() % 100000}`;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(inject('adminUrl'));
  url.pathname = `/${name}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  pool.on('error', () => undefined); // a connection closing while the database is dropped
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

describe('migrations', () => {
  it('apply in order once, then are a no-op; a changed applied migration is refused', async () => {
    const dir = mkdtempSync('/tmp/velvet-mig-');
    for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    const first = await migrate(pool, dir);
    expect(first.applied).toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort());
    const second = await migrate(pool, dir);
    expect(second.applied).toEqual([]);
    writeFileSync(join(dir, '0001_foundation.sql'), '-- edited\n', { flag: 'a' });
    await expect(migrate(pool, dir)).rejects.toThrow(/changed after it was applied/);
  });

  it('runs concurrently without double-applying', async () => {
    const dir = mkdtempSync('/tmp/velvet-mig-');
    for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    writeFileSync(join(dir, '0099_probe.sql'), 'CREATE TABLE app.probe (id int);');
    const [a, b] = await Promise.all([migrate(pool, dir), migrate(pool, dir)]);
    expect([...a.applied, ...b.applied]).toEqual(['0099_probe.sql']);
  });

  it('from a clean database: every migration applies and the schema verifies', async () => {
    const db = await freshDb('clean');
    try {
      const r = await migrate(db.pool);
      expect(r.applied).toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort());
      expect(await migrationStatus(db.pool)).toEqual({ pending: [], changed: [], unknown: [] });
      const idx = await db.pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'matches_one_active_per_pair'`);
      expect(idx.rows[0].indexdef).toMatch(/UNIQUE INDEX .* \(pair_key\) WHERE \(status = 'ACTIVE'::text\)/);
    } finally {
      await db.drop();
    }
  });

  it('on an existing 0001–0004 schema WITH data: rows are carried over and constraints hold', async () => {
    const db = await freshDb('existing');
    try {
      const early = mkdtempSync('/tmp/velvet-mig-');
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => /^000[1-4]_/.test(f))) copyFileSync(join(MIGRATIONS_DIR, f), join(early, f));
      await migrate(db.pool, early);
      expect((await migrationStatus(db.pool)).pending).toEqual(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !/^000[1-4]_/.test(f)).sort());
      const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
      const at = '2026-09-01T10:00:00Z';
      // Accounts: active, suspended, and the old 'deleted' status.
      for (const [id, phone, status] of [
        ['usr_a', '+905320000001', 'active'],
        ['usr_b', '+905320000002', 'active'],
        ['usr_c', '+905320000003', 'active'],
        ['usr_s', '+905320000004', 'suspended'],
        ['usr_d', '+905320000005', 'deleted'],
      ]) {
        await q(`INSERT INTO app.accounts (id, phone_e164, phone_verified_at, account_status, created_at, updated_at) VALUES ($1, $2, $3, $4, $3, $3)`, [id, phone, at, status]);
      }
      await q(`INSERT INTO app.sessions (token_hash, account_id, created_at, expires_at) VALUES ('h1', 'usr_a', $1, '2026-11-01T00:00:00Z')`, [at]);
      await q(`INSERT INTO app.sessions (token_hash, account_id, created_at, expires_at, revoked_at) VALUES ('h2', 'usr_a', $1, '2026-11-01T00:00:00Z', $1)`, [at]);
      for (const [m, a] of [
        ['mem_a', 'usr_a'],
        ['mem_b', 'usr_b'],
        ['mem_c', 'usr_c'],
      ]) {
        await q(`INSERT INTO app.member_profiles (id, account_id, display_name, created_at, updated_at) VALUES ($1, $2, 'X', $3, $3)`, [m, a, at]);
      }
      await q(`INSERT INTO app.member_media (id, member_id, type, storage_key, content_type, width, height, position, created_at) VALUES ('mmd_1', 'mem_a', 'photo', 'member/mem_a/mmd_1.jpg', 'image/jpeg', 10, 10, -1, $1)`, [at]);
      // Introductions and reactions a ↔ b.
      await q(`INSERT INTO app.introduction_batches (id, member_id, batch_date, created_at) VALUES ('int_a', 'mem_a', '2026-09-01', $1), ('int_b', 'mem_b', '2026-09-01', $1)`, [at]);
      await q(
        `INSERT INTO app.introduction_entries (id, batch_id, viewer_id, candidate_id, batch_date, position, context, status, created_at)
         VALUES ('itr_ab', 'int_a', 'mem_a', 'mem_b', '2026-09-01', 0, 'DATING', 'LIKED', $1), ('itr_ba', 'int_b', 'mem_b', 'mem_a', '2026-09-01', 0, 'DATING', 'LIKED', $1)`,
        [at],
      );
      await q(
        `INSERT INTO app.reactions (id, introduction_id, from_member_id, to_member_id, type, created_at)
         VALUES ('rct_1', 'itr_ab', 'mem_a', 'mem_b', 'LIKE', $1), ('rct_2', 'itr_ba', 'mem_b', 'mem_a', 'LIKE', $1)`,
        [at],
      );
      // One active match (a–b) with a conversation, one ended by a block (a–c).
      await q(`INSERT INTO app.matches (id, member_a, member_b, pair_key, created_at) VALUES ('mch_ab', 'mem_a', 'mem_b', 'mem_a|mem_b', $1)`, [at]);
      await q(`INSERT INTO app.matches (id, member_a, member_b, pair_key, created_at, ended_at, ended_reason) VALUES ('mch_ac', 'mem_a', 'mem_c', 'mem_a|mem_c', $1, $1, 'BLOCK')`, [at]);
      await q(`INSERT INTO app.conversations (id, match_id, created_at) VALUES ('cnv_ab', 'mch_ab', $1)`, [at]);
      await q(`INSERT INTO app.conversation_participants (conversation_id, member_id) VALUES ('cnv_ab', 'mem_a'), ('cnv_ab', 'mem_b')`);
      await q(`INSERT INTO app.messages (id, conversation_id, sender_id, body, client_message_id, created_at) VALUES ('msg_1', 'cnv_ab', 'mem_a', 'Merhaba', 'c1', $1)`, [at]);

      const rest = await migrate(db.pool);
      expect(rest.applied.length).toBeGreaterThanOrEqual(5);
      expect(await migrationStatus(db.pool)).toEqual({ pending: [], changed: [], unknown: [] });
      expect((await q(`SELECT id, status FROM app.matches ORDER BY id`)).rows).toEqual([
        { id: 'mch_ab', status: 'ACTIVE' },
        { id: 'mch_ac', status: 'BLOCKED' },
      ]);
      // The old 'deleted' status becomes a pending deletion: the retention process anonymizes it properly.
      expect((await q(`SELECT id, account_status, phone_e164 IS NULL AS released, suspended_at IS NOT NULL AS dated FROM app.accounts WHERE id IN ('usr_d', 'usr_s') ORDER BY id`)).rows).toEqual([
        { id: 'usr_d', account_status: 'deletion_requested', released: false, dated: false },
        { id: 'usr_s', account_status: 'suspended', released: false, dated: true },
      ]);
      expect((await q(`SELECT token_hash, family_id, last_used_at IS NOT NULL AS used, revoked_reason FROM app.sessions ORDER BY token_hash`)).rows).toEqual([
        { token_hash: 'h1', family_id: 'h1', used: true, revoked_reason: null },
        { token_hash: 'h2', family_id: 'h2', used: true, revoked_reason: 'SIGN_OUT' },
      ]);
      expect((await q(`SELECT removed_at IS NOT NULL AS removed FROM app.member_media WHERE id = 'mmd_1'`)).rows[0].removed).toBe(true);
      // The carried-over data now obeys the new guarantees.
      await expect(q(`INSERT INTO app.matches (id, member_a, member_b, pair_key, status, created_at) VALUES ('mch_dup', 'mem_a', 'mem_b', 'mem_a|mem_b', 'ACTIVE', now())`)).rejects.toThrow(
        /matches_one_active_per_pair/,
      );
      await expect(q(`INSERT INTO app.messages (id, conversation_id, sender_id, body, client_message_id, created_at) VALUES ('msg_x', 'cnv_ab', 'mem_c', 'x', 'c9', now())`)).rejects.toThrow(
        /messages_sender_participant_fkey/,
      );
      await expect(
        q(`INSERT INTO app.reactions (id, introduction_id, from_member_id, to_member_id, type, created_at) VALUES ('rct_x', 'itr_ab', 'mem_c', 'mem_b', 'LIKE', now())`),
      ).rejects.toThrow(/reactions_introduction_identity_fkey|duplicate key/);
    } finally {
      await db.drop();
    }
  });
});

async function freshDb(tag: string) {
  const dbName = `velvet_mig_${tag}_${process.pid}_${Date.now() % 100000}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(inject('adminUrl'));
  url.pathname = `/${dbName}`;
  const p = new pg.Pool({ connectionString: url.toString(), max: 2 });
  p.on('error', () => undefined);
  return {
    pool: p,
    async drop() {
      await p.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    },
  };
}
