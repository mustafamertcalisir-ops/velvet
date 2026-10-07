/**
 * Read-only database verification for a DEPLOYED environment (DEC-082).
 *
 * The staging database has no external access, so this runs INSIDE the
 * platform — a Render one-off job on the API service (same build, same
 * environment, private network), started by CI through the Render API:
 *
 *   node dist/db-check.mjs schema                         migrations + schema facts
 *   node dist/db-check.mjs pair <memberA> <memberB> [--expect active=1,blocked=0,...]
 *   node dist/db-check.mjs account <accountId> [--expect status=deletion_requested,...]
 *   node dist/db-check.mjs counts                         row counts (backup/restore comparison)
 *   node dist/db-check.mjs account-exists <accountId> [--expect exists=false]
 *
 * It connects as the API's RUNTIME login (never the schema owner), runs only
 * SELECTs, and prints ONE line `db-check {json}` holding counts, booleans and
 * enumerations — never a phone number, name, birth date, message text or
 * token. Exit 1 when a fact or an --expect does not hold.
 *
 * DB_CHECK_DATABASE_URL points it elsewhere (the restore drill's recovery
 * instance, from CI) — still read-only.
 */
import type pg from 'pg';
import { migrationStatus } from '../src/db/migrate';
import { createPool, databaseOptionsFrom } from '../src/db/pool';
import { runtimeDatabaseUrl } from '../src/db/runtimeLogin';

const TABLES = [
  'accounts', 'sessions', 'otp_challenges', 'sms_test_outbox', 'idempotency_keys',
  'membership_applications', 'application_private_data', 'application_referrals', 'application_dating_preferences',
  'application_media', 'application_reviews', 'information_requests', 'memberships', 'membership_plans', 'billing_events',
  'member_profiles', 'member_media', 'dating_settings', 'introduction_batches', 'introduction_entries', 'reactions',
  'matches', 'conversations', 'conversation_participants', 'messages', 'blocks', 'reports',
  'audit_events', 'media_access_log', 'retention_holds', 'media_uploads', 'internal_nonces', 'rate_limit_events',
];
const CONSTRAINTS = ['sessions_revocation_consistent', 'matches_status_consistent', 'accounts_phone_lifecycle', 'accounts_lifecycle_dates', 'member_profiles_deleted_hidden'];
const TRIGGERS = ['audit_events_no_update', 'media_access_log_append_only', 'messages_keep', 'reports_keep', 'blocks_keep'];

type Facts = Record<string, string | number | boolean | null>;

async function schema(db: pg.Pool): Promise<{ facts: Facts; ok: boolean }> {
  const s = await migrationStatus(db);
  const applied = Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app_meta.schema_migrations')).rows[0]?.n ?? 0);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as Record<string, unknown>;
  const tables = await db.query<{ tablename: string; rls: boolean; policy: boolean; granted: boolean }>(
    `SELECT t.tablename, c.relrowsecurity AS rls,
            EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = t.tablename AND p.policyname = 'runtime_access') AS policy,
            has_table_privilege('velvet_runtime', format('app.%I', t.tablename), 'SELECT') AS granted
       FROM pg_tables t JOIN pg_class c ON c.relname = t.tablename JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
      WHERE t.schemaname = 'app'`,
  );
  const present = new Set(tables.rows.map((r) => r.tablename));
  const idx = await one(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND indexname = 'matches_one_active_per_pair'`).catch(() => null);
  const cons = await db.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conname = ANY($1)`, [CONSTRAINTS]);
  const trig = await db.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgname = ANY($1) AND NOT tgisinternal`, [TRIGGERS]);
  const appendOnly = await one(
    `SELECT has_table_privilege('velvet_runtime', 'app.audit_events', 'UPDATE') AS audit_update,
            has_table_privilege('velvet_runtime', 'app.media_access_log', 'UPDATE') AS access_log_update,
            has_table_privilege('velvet_runtime', 'app.membership_plans', 'INSERT') AS plans_insert`,
  );
  const me = await one(
    `SELECT r.rolsuper, r.rolbypassrls, pg_has_role(current_user, 'velvet_runtime', 'MEMBER') AS in_runtime,
            has_schema_privilege(current_user, 'app', 'CREATE') AS can_create,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const facts: Facts = {
    migrationsApplied: applied,
    migrationsPending: s.pending.length,
    migrationsChanged: s.changed.length,
    migrationsUnknown: s.unknown.length,
    tablesMissing: TABLES.filter((t) => !present.has(t)).join(',') || null,
    tablesWithoutRls: tables.rows.filter((r) => !r.rls).map((r) => r.tablename).join(',') || null,
    tablesWithoutRuntimePolicy: tables.rows.filter((r) => !r.policy).map((r) => r.tablename).join(',') || null,
    tablesWithoutRuntimeGrant: tables.rows.filter((r) => !r.granted).map((r) => r.tablename).join(',') || null,
    activeMatchPartialUnique: Boolean(idx && /UNIQUE INDEX/.test(String(idx.indexdef)) && /WHERE \(status = 'ACTIVE'::text\)/.test(String(idx.indexdef))),
    constraintsMissing: CONSTRAINTS.filter((c) => !cons.rows.some((r) => r.conname === c)).join(',') || null,
    protectiveTriggersMissing: TRIGGERS.filter((t) => !trig.rows.some((r) => r.tgname === t)).join(',') || null,
    runtimeCanUpdateAudit: Boolean(appendOnly.audit_update) || Boolean(appendOnly.access_log_update),
    runtimeCanWritePlans: Boolean(appendOnly.plans_insert),
    connectedAsRuntime: Boolean(me.in_runtime) && !me.rolsuper && !me.rolbypassrls && !me.can_create,
    tls: me.tls === true,
  };
  const ok =
    facts.migrationsPending === 0 && facts.migrationsChanged === 0 && facts.migrationsUnknown === 0 && applied > 0 &&
    !facts.tablesMissing && !facts.tablesWithoutRls && !facts.tablesWithoutRuntimePolicy && !facts.tablesWithoutRuntimeGrant &&
    facts.activeMatchPartialUnique === true && !facts.constraintsMissing && !facts.protectiveTriggersMissing &&
    facts.runtimeCanUpdateAudit === false && facts.runtimeCanWritePlans === false && facts.connectedAsRuntime === true && facts.tls === true;
  return { facts, ok };
}

async function pair(db: pg.Pool, a: string, b: string): Promise<Facts> {
  const [x, y] = [a, b].sort();
  const key = `${x}|${y}`;
  const m = (await db.query<{ status: string; ended_reason: string | null; n: number }>(
    `SELECT status, ended_reason, count(*)::int AS n FROM app.matches WHERE pair_key = $1 GROUP BY status, ended_reason`,
    [key],
  )).rows;
  const sum = (f: (r: (typeof m)[number]) => boolean) => m.filter(f).reduce((t, r) => t + r.n, 0);
  const conv = (await db.query<{ open: number; closed: number; messages: number }>(
    `SELECT count(*) FILTER (WHERE c.closed_at IS NULL)::int AS open, count(*) FILTER (WHERE c.closed_at IS NOT NULL)::int AS closed,
            coalesce(sum((SELECT count(*) FROM app.messages msg WHERE msg.conversation_id = c.id)), 0)::int AS messages
       FROM app.conversations c JOIN app.matches mt ON mt.id = c.match_id WHERE mt.pair_key = $1`,
    [key],
  )).rows[0]!;
  const blocks = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`, [a, b])).rows[0]!;
  const pending = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.introduction_entries WHERE status = 'PENDING' AND ((viewer_id = $1 AND candidate_id = $2) OR (viewer_id = $2 AND candidate_id = $1))`,
    [a, b],
  )).rows[0]!;
  return {
    active: sum((r) => r.status === 'ACTIVE'),
    ended: sum((r) => r.status === 'ENDED'),
    blocked: sum((r) => r.status === 'BLOCKED'),
    endedByBlock: sum((r) => r.ended_reason === 'BLOCK'),
    conversationsOpen: conv.open,
    conversationsClosed: conv.closed,
    messages: conv.messages,
    blocks: blocks.n,
    pendingIntroductions: pending.n,
  };
}

async function account(db: pg.Pool, id: string): Promise<Facts> {
  const acc = (await db.query<{ account_status: string; deletion_requested: boolean; qa: boolean }>(
    `SELECT account_status, deletion_requested_at IS NOT NULL AS deletion_requested, qa_account AS qa FROM app.accounts WHERE id = $1`,
    [id],
  )).rows[0];
  if (!acc) return { found: false };
  const q = async (sql: string) => (await db.query(sql, [id])).rows[0] as Record<string, unknown> | undefined;
  const sessions = await q(`SELECT count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS live FROM app.sessions WHERE account_id = $1`);
  const membership = await q(`SELECT status FROM app.memberships WHERE account_id = $1`);
  const profile = await q(`SELECT id, visibility FROM app.member_profiles WHERE account_id = $1`);
  const pid = (profile?.id as string | undefined) ?? '';
  const mt = pid
    ? (await db.query<{ active: number; ended_deleted: number; open: number; pending: number }>(
        `SELECT (SELECT count(*) FROM app.matches WHERE (member_a = $1 OR member_b = $1) AND status = 'ACTIVE')::int AS active,
                (SELECT count(*) FROM app.matches WHERE (member_a = $1 OR member_b = $1) AND ended_reason = 'ACCOUNT_DELETED')::int AS ended_deleted,
                (SELECT count(*) FROM app.conversations c JOIN app.matches m ON m.id = c.match_id
                  WHERE (m.member_a = $1 OR m.member_b = $1) AND c.closed_at IS NULL)::int AS open,
                (SELECT count(*) FROM app.introduction_entries WHERE (viewer_id = $1 OR candidate_id = $1) AND status = 'PENDING')::int AS pending`,
        [pid],
      )).rows[0]!
    : { active: 0, ended_deleted: 0, open: 0, pending: 0 };
  const holds = await q(`SELECT count(*) FILTER (WHERE released_at IS NULL)::int AS n FROM app.retention_holds WHERE account_id = $1`).catch(() => ({ n: null }));
  // Media whose bytes still exist (rows are kept with purged_at once the objects are deleted — MEDIA_ARCHITECTURE.md §5).
  const media = await q(
    `SELECT ((SELECT count(*) FROM app.application_media am JOIN app.membership_applications ma ON ma.id = am.application_id
               WHERE ma.account_id = $1 AND am.purged_at IS NULL)
           + (SELECT count(*) FROM app.member_media mm JOIN app.member_profiles mp ON mp.id = mm.member_id
               WHERE mp.account_id = $1 AND mm.purged_at IS NULL))::int AS n`,
  );
  return {
    found: true,
    qa: acc.qa,
    status: acc.account_status,
    deletionRequested: acc.deletion_requested,
    liveSessions: Number(sessions?.live ?? 0),
    membership: (membership?.status as string | undefined) ?? 'none',
    profileVisibility: (profile?.visibility as string | undefined) ?? 'none',
    activeMatches: mt.active,
    matchesEndedByDeletion: mt.ended_deleted,
    openConversations: mt.open,
    pendingIntroductions: mt.pending,
    activeHolds: (holds?.n as number | null) ?? null,
    mediaNotPurged: Number(media?.n ?? 0),
  };
}

async function counts(db: pg.Pool): Promise<Facts> {
  const r = (await db.query(
    `SELECT (SELECT count(*) FROM app.accounts)::int AS accounts, (SELECT count(*) FROM app.membership_applications)::int AS applications,
            (SELECT count(*) FROM app.member_profiles)::int AS members, (SELECT count(*) FROM app.matches)::int AS matches,
            (SELECT count(*) FROM app.messages)::int AS messages, (SELECT count(*) FROM app.audit_events)::int AS "auditEvents",
            (SELECT max(created_at) FROM app.audit_events) AS "lastAuditAt"`,
  )).rows[0] as Facts;
  return { ...r, lastAuditAt: r.lastAuditAt ? new Date(String(r.lastAuditAt)).toISOString() : null };
}

/** `--expect k=v,k=v`: every named fact must equal the value (numbers, booleans, strings). */
function expectations(argv: string[]): Record<string, string> {
  const i = argv.indexOf('--expect');
  if (i < 0) return {};
  return Object.fromEntries((argv[i + 1] ?? '').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--expect');
  const env = process.env;
  const appEnv = env.APP_ENV ?? 'development';
  const releaseLike = appEnv === 'staging' || appEnv === 'production';
  let url = env.DB_CHECK_DATABASE_URL ?? '';
  if (!url) {
    const r = runtimeDatabaseUrl(env);
    if (r.problems.length) throw new Error(r.problems.join('; '));
    url = r.url;
  }
  delete process.env.MIGRATION_DATABASE_URL; // never used to connect here
  const { options, problems } = databaseOptionsFrom(env, releaseLike || Boolean(env.DB_CHECK_DATABASE_URL));
  if (problems.length) throw new Error(problems.join('; '));
  const db = createPool(url, { ...options, max: 1, applicationName: 'velvet-db-check' });
  try {
    await db.query('SET default_transaction_read_only = on');
    let facts: Facts;
    let ok = true;
    const id = (s: string | undefined) => {
      if (!s || !/^[A-Za-z0-9_-]{4,80}$/.test(s)) throw new Error('an opaque id is required');
      return s;
    };
    if (command === 'schema') ({ facts, ok } = await schema(db));
    else if (command === 'pair') facts = await pair(db, id(args[0]), id(args[1]));
    else if (command === 'account') facts = await account(db, id(args[0]));
    else if (command === 'account-exists') facts = { exists: Boolean((await db.query('SELECT 1 FROM app.accounts WHERE id = $1', [id(args[0])])).rowCount) };
    else if (command === 'counts') facts = await counts(db);
    else throw new Error('Usage: db-check schema | pair <a> <b> | account <id> | account-exists <id> | counts  [--expect k=v,…]');
    const failed = Object.entries(expectations(rest)).filter(([k, v]) => String(facts[k]) !== v).map(([k, v]) => `${k}: expected ${v}, got ${String(facts[k])}`);
    console.log(`db-check ${JSON.stringify({ command, ok: ok && failed.length === 0, facts, failed })}`);
    if (!ok || failed.length) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

void main().catch((e: Error) => {
  const code = (e as { code?: string }).code;
  console.error(`db-check failed: ${code ? `[${code}] ` : ''}${e.message.split('\n')[0]}`);
  process.exitCode = 1;
});
