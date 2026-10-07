/**
 * Query plans of the introduction-generation path (PART E), measured with
 * EXPLAIN (ANALYZE, BUFFERS) on a synthetic community of 20,000 members with
 * history (≈100k batches, ≈300k introductions, ≈150k reactions, matches and
 * blocks). Per-member lookups must be index scans; the candidate pool is a
 * deliberate full pass (most members are candidates) and must stay fast.
 *
 * The measured plans are written to test/.out/query-plans.json and
 * summarised in docs/BACKEND_ARCHITECTURE.md ("Measured query plans").
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARTICIPANT_SELECT, POOL_PREFILTER } from '../src/member/service';
import { testServer, type T } from './harness';

let t: T;
const N = 20_000;
const VIEWER = 'mem_00001';
const TODAY = '2026-10-05';

beforeAll(async () => {
  t = await testServer();
  const q = (sql: string) => t.admin.query(sql); // bulk fixtures as the owner
  await q(`INSERT INTO app.accounts (id, phone_e164, phone_verified_at, account_status, suspended_at, created_at, updated_at)
           SELECT 'usr_' || lpad(i::text, 5, '0'), '+90532' || lpad(i::text, 7, '0'), now(),
                  CASE WHEN i % 97 = 0 THEN 'suspended' ELSE 'active' END, CASE WHEN i % 97 = 0 THEN now() END, now(), now()
             FROM generate_series(1, ${N}) i`);
  await q(`INSERT INTO app.membership_applications (id, account_id, status, created_at, updated_at)
           SELECT 'app_' || lpad(i::text, 5, '0'), 'usr_' || lpad(i::text, 5, '0'), CASE WHEN i % 31 = 0 THEN 'EXPIRED' ELSE 'ACTIVE_MEMBER' END, now(), now()
             FROM generate_series(1, ${N}) i`);
  await q(`INSERT INTO app.application_private_data (application_id, first_name, last_name, date_of_birth, instagram_handle, country_code, city, referral_kind, created_at, updated_at)
           SELECT 'app_' || lpad(i::text, 5, '0'), 'F', 'L', date '1975-01-01' + ((i * 7919) % 9000), 'h', 'TR', '{}'::jsonb, 'none', now(), now()
             FROM generate_series(1, ${N}) i`);
  await q(`INSERT INTO app.membership_plans (id, name, billing_period, price_minor, currency, is_development_fixture)
           VALUES ('plan_q', 'M', 'monthly', 1, 'TRY', true)`);
  await q(`INSERT INTO app.memberships (id, account_id, plan_id, status, created_at, updated_at)
           SELECT 'mbr_' || lpad(i::text, 5, '0'), 'usr_' || lpad(i::text, 5, '0'), 'plan_q', CASE WHEN i % 31 = 0 THEN 'expired' ELSE 'active' END, now(), now()
             FROM generate_series(1, ${N}) i`);
  await q(`INSERT INTO app.member_profiles (id, account_id, display_name, intents, visibility, created_at, updated_at)
           SELECT 'mem_' || lpad(i::text, 5, '0'), 'usr_' || lpad(i::text, 5, '0'), 'M' || i,
                  CASE WHEN i % 5 = 0 THEN ARRAY['friendship', 'community'] ELSE ARRAY['dating', 'community'] END,
                  CASE WHEN i % 23 = 0 THEN 'paused' ELSE 'visible' END, now(), now()
             FROM generate_series(1, ${N}) i`);
  await q(`INSERT INTO app.dating_settings (member_id, gender, appears_as, seeking, age_min, age_max, setup_completed_at, created_at, updated_at)
           SELECT 'mem_' || lpad(i::text, 5, '0'), g, ARRAY[g],
                  CASE i % 4 WHEN 0 THEN ARRAY['WOMAN'] WHEN 1 THEN ARRAY['MAN'] WHEN 2 THEN ARRAY['WOMAN', 'MAN'] ELSE ARRAY['WOMAN', 'MAN', 'NON_BINARY'] END,
                  25 + (i % 8), 38 + (i % 10), CASE WHEN i % 11 = 0 THEN NULL ELSE now() END, now(), now()
             FROM (SELECT i, (ARRAY['WOMAN', 'MAN', 'NON_BINARY'])[1 + (i % 7) % 3] AS g FROM generate_series(1, ${N}) i) x
            WHERE i % 5 <> 0`);
  // History: 5 days of batches, 3 introductions each; reactions to half of them.
  await q(`INSERT INTO app.introduction_batches (id, member_id, batch_date, created_at)
           SELECT 'int_' || i || '_' || d, 'mem_' || lpad(i::text, 5, '0'), date '${TODAY}' - d, now()
             FROM generate_series(1, ${N}) i, generate_series(1, 5) d WHERE i % 5 <> 0`);
  await q(`INSERT INTO app.introduction_entries (id, batch_id, viewer_id, candidate_id, batch_date, position, context, status, created_at)
           SELECT 'itr_' || i || '_' || d || '_' || k, 'int_' || i || '_' || d, 'mem_' || lpad(i::text, 5, '0'),
                  'mem_' || lpad((1 + (i * 31 + d * 977 + k * 7) % ${N})::text, 5, '0'), date '${TODAY}' - d, k, 'DATING',
                  CASE WHEN k = 0 THEN 'LIKED' WHEN k = 1 THEN 'PASSED' ELSE 'WITHDRAWN' END, now()
             FROM generate_series(1, ${N}) i, generate_series(1, 5) d, generate_series(0, 2) k
            WHERE i % 5 <> 0 AND (1 + (i * 31 + d * 977 + k * 7) % ${N}) <> i`);
  await q(`INSERT INTO app.reactions (id, introduction_id, from_member_id, to_member_id, type, created_at)
           SELECT 'rct_' || e.id, e.id, e.viewer_id, e.candidate_id, CASE WHEN e.status = 'LIKED' THEN 'LIKE' ELSE 'PASS' END, now() - interval '2 days'
             FROM app.introduction_entries e WHERE e.status IN ('LIKED', 'PASSED')`);
  // Matches (some ended), blocks.
  await q(`INSERT INTO app.matches (id, member_a, member_b, pair_key, status, created_at, ended_at, ended_reason)
           SELECT 'mch_' || i, least(a, b), greatest(a, b), least(a, b) || '|' || greatest(a, b),
                  CASE WHEN i % 3 = 0 THEN 'ENDED' ELSE 'ACTIVE' END, now(), CASE WHEN i % 3 = 0 THEN now() END, CASE WHEN i % 3 = 0 THEN 'UNMATCH' END
             FROM (SELECT i, 'mem_' || lpad(i::text, 5, '0') AS a, 'mem_' || lpad((1 + (i * 13) % ${N})::text, 5, '0') AS b FROM generate_series(1, ${N} / 2) i) x
            WHERE a <> b ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO app.blocks (id, blocker_id, blocked_id, created_at)
           SELECT 'blk_' || i, 'mem_' || lpad(i::text, 5, '0'), 'mem_' || lpad((1 + (i * 17) % ${N})::text, 5, '0'), now()
             FROM generate_series(1, ${N}, 3) i WHERE (1 + (i * 17) % ${N}) <> i ON CONFLICT DO NOTHING`);
  await q('ANALYZE');
}, 180_000);
afterAll(async () => t.close());

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[]; 'Actual Rows'?: number };
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];
const report: Record<string, unknown> = {};

async function explain(name: string, sql: string, params: unknown[]) {
  const { rows } = await t.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const plan = rows[0]['QUERY PLAN'][0] as { Plan: PlanNode; 'Execution Time': number; 'Planning Time': number };
  const all = nodes(plan.Plan);
  const summary = {
    executionMs: plan['Execution Time'],
    planningMs: plan['Planning Time'],
    rows: plan.Plan['Actual Rows'],
    scans: all.filter((n) => n['Node Type'].includes('Scan')).map((n) => `${n['Node Type']} ${n['Relation Name'] ?? ''}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`.trim()),
  };
  report[name] = summary;
  return summary;
}
const seqScansOn = (s: { scans: string[] }, tables: string[]) => s.scans.filter((x) => x.startsWith('Seq Scan') && tables.some((t) => x.endsWith(` ${t}`)));
const BIG = ['reactions', 'introduction_entries', 'introduction_batches', 'matches', 'blocks', 'member_profiles', 'accounts', 'application_private_data', 'dating_settings'];

describe('introduction generation: measured plans (20,000 members)', () => {
  it('per-member lookups are index scans', async () => {
    const lookups = [
      await explain('prior reactions', 'SELECT to_member_id, type, created_at FROM app.reactions WHERE from_member_id = $1', [VIEWER]),
      await explain('match history', 'SELECT * FROM app.matches WHERE member_a = $1 OR member_b = $1', [VIEWER]),
      await explain(
        'recent introductions',
        `SELECT candidate_id, batch_date FROM app.introduction_entries WHERE viewer_id = $1 AND batch_date < $2::date AND batch_date > $2::date - $3::int`,
        [VIEWER, TODAY, 14],
      ),
      await explain('blocks (both directions)', 'SELECT blocked_id AS id FROM app.blocks WHERE blocker_id = $1 UNION SELECT blocker_id FROM app.blocks WHERE blocked_id = $1', [VIEWER]),
      await explain('today’s batch', 'SELECT id FROM app.introduction_batches WHERE member_id = $1 AND batch_date = $2', [VIEWER, TODAY]),
      await explain(
        'liked back since the pair’s last ended match',
        `SELECT 1 FROM app.reactions r WHERE r.from_member_id = $1 AND r.to_member_id = $2 AND r.type = 'LIKE'
           AND r.created_at > coalesce((SELECT max(ended_at) FROM app.matches WHERE pair_key = $3 AND status <> 'ACTIVE'), '-infinity')`,
        ['mem_00002', VIEWER, `${VIEWER}|mem_00002`],
      ),
      await explain('active matches', `SELECT * FROM app.matches m WHERE (m.member_a = $1 OR m.member_b = $1) AND m.status = 'ACTIVE'`, [VIEWER]),
      await explain('participants by id', `${PARTICIPANT_SELECT} WHERE p.id = ANY($1)`, [[VIEWER, 'mem_00002', 'mem_00003'], TODAY]),
    ];
    for (const s of lookups) {
      expect(seqScansOn(s, BIG), JSON.stringify(s)).toEqual([]);
      expect(s.executionMs).toBeLessThan(50);
    }
  });

  it('the candidate pool: the SQL prefilter (mutual gender categories and age ranges) cuts what reaches the server', async () => {
    const viewer = (await t.pool.query(`${PARTICIPANT_SELECT} WHERE p.id = $1`, [VIEWER, TODAY])).rows[0];
    const unfiltered = await explain(
      'candidate pool (no prefilter)',
      `${PARTICIPANT_SELECT}
        WHERE p.id <> $1 AND a.status = 'ACTIVE_MEMBER' AND s.setup_completed_at IS NOT NULL AND p.visibility = 'visible' AND acc.account_status = 'active'`,
      [VIEWER, TODAY],
    );
    const filtered = await explain(
      'candidate pool (prefiltered)',
      `${PARTICIPANT_SELECT}
        WHERE p.id <> $1 AND a.status = 'ACTIVE_MEMBER' AND s.setup_completed_at IS NOT NULL AND p.visibility = 'visible' AND acc.account_status = 'active'
          AND ${POOL_PREFILTER}`,
      [VIEWER, TODAY, viewer.appears_as, viewer.seeking, viewer.age, viewer.age_min, viewer.age_max],
    );
    expect(filtered.rows!).toBeLessThan(unfiltered.rows! / 2);
    expect(filtered.executionMs).toBeLessThan(500);
    mkdirSync(join(__dirname, '.out'), { recursive: true });
    writeFileSync(join(__dirname, '.out', 'query-plans.json'), JSON.stringify(report, null, 2));
  });
});
