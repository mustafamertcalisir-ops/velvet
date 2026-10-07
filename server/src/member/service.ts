/**
 * Member product — server-authoritative (the MemberApi port, served over HTTP).
 *
 * Every operation:
 *  1. authenticates the session (HTTP layer) and requires ACTIVE_MEMBER with
 *     a live membership (canAccessMemberProduct) — applicants never pass;
 *  2. decides with the shared domain rules (src/domain/member/*): one
 *     eligibility function, one reaction decision, one message rule;
 *  3. answers with explicit DTOs (dto.ts) — never rows.
 *
 * Concurrency and match lifecycle (DEC-060, revised):
 *  - a day's batch is created once per member (advisory lock + unique key);
 *  - a reaction locks its introduction row, then the PAIR (advisory lock on
 *    the pair key) before reading "did they like me?" — so two simultaneous
 *    mutual likes are serialised and exactly one creates the match;
 *  - at most ONE ACTIVE match per pair: a partial unique index
 *    (matches_one_active_per_pair) makes a second active match impossible at
 *    the database level regardless; ended matches (ENDED, BLOCKED) are kept
 *    as history, and only likes AFTER the pair's last ended match count;
 *  - one reaction per introduction (unique key): retries replay.
 */
import { canAccessMemberProduct } from '@/domain/admission/access';
import { PHOTO_MAX, type Intent } from '@/domain/admission/stage2';
import type { ApplicationStatus } from '@/domain/admission/status';
import { datingEligibility, type DatingParticipant } from '@/domain/member/compatibility';
import { canSendMessage, validateMessage, type ThreadMessage } from '@/domain/member/conversation';
import { isDatingCategory, validateDatingSettingsInput, type DatingGenderId, type DatingGenderPreference } from '@/domain/member/dating';
import {
  DEFAULT_INTRODUCTION_POLICY,
  exhaustedCandidates,
  selectDatingIntroductions,
  stableRank,
  type IntroductionPolicy,
  type IntroductionStatus,
} from '@/domain/member/introductions';
import { decideReaction, isReactionType, pairKey, sortedPair, type MatchStatus, type ReactionType } from '@/domain/member/matching';
import { validateMemberProfilePatch } from '@/domain/member/profileEdit';
import { isReportReason } from '@/domain/member/safety';
import type { MemberPhoto } from '@/domain/member/views';
import type { Membership } from '@/domain/models';
import type {
  BlockedMember,
  ConversationSummary,
  ConversationView,
  IntroductionDTO,
  IntroductionsState,
  IntroductionsView,
  MatchView,
  OwnDatingSettings,
  OwnMember,
  ReactionResult,
} from '@/services/api/memberTypes';
import type pg from 'pg';
import type { Config } from '../config';
import { lockKey, tx, type Db } from '../db/pool';
import { fail } from '../http/errors';
import { calendarDateIn, isoDateIn, type Clock } from '../lib/clock';
import { newId } from '../lib/crypto';
import type { MediaDelivery } from '../media/pipeline';
import type { ObjectStore } from '../media/objectStore';
import { LIMITS, type RateLimiter } from '../ratelimit';
import { PUBLIC_MEMBER_SELECT, toMemberCardDTO, toOwnProfileDTO, toPublicMemberDTO, type PublicMemberRow } from './dto';
import { provisionMember } from './provision';

export type MemberDeps = {
  pool: pg.Pool;
  clock: Clock;
  config: Config;
  store: ObjectStore;
  delivery: MediaDelivery;
  limiter: RateLimiter;
  policy?: IntroductionPolicy;
};

/** Server-only facts about a member, for eligibility. Never serialised. */
type ParticipantRow = {
  id: string;
  visibility: string;
  intents: string[];
  app_status: ApplicationStatus;
  membership_status: Membership['status'] | null;
  account_status: string;
  /** Staging QA account (DEC-076): QA and non-QA members are never introduced to each other. */
  qa_account: boolean;
  deleted_at: string | null;
  age: number;
  gender: DatingGenderId | null;
  appears_as: string[] | null;
  seeking: string[] | null;
  age_min: number | null;
  age_max: number | null;
};

export const PARTICIPANT_SELECT = `
  SELECT p.id, p.visibility, p.intents, p.deleted_at, a.status AS app_status, m.status AS membership_status,
         acc.account_status, acc.qa_account,
         date_part('year', age($2::date, d.date_of_birth))::int AS age,
         s.gender, s.appears_as, s.seeking, s.age_min, s.age_max
  FROM app.member_profiles p
  JOIN app.accounts acc ON acc.id = p.account_id
  JOIN app.membership_applications a ON a.account_id = p.account_id
  JOIN app.application_private_data d ON d.application_id = a.id
  LEFT JOIN app.memberships m ON m.account_id = p.account_id
  LEFT JOIN app.dating_settings s ON s.member_id = p.id`;

/**
 * The candidate pool's SQL prefilter (measured: test/queryplan.test.ts): the
 * mutual gender-category and age-range conditions, so that only plausible
 * candidates leave the database. It mirrors datingEligibility's preference
 * check exactly; the shared domain function still decides every candidate.
 * Parameters: $3 viewer appearsAs, $4 viewer seeking, $5 viewer age,
 * $6/$7 viewer age range ($1 viewer id, $2 the product date).
 */
export const POOL_PREFILTER = `
  s.appears_as && $4::text[] AND s.seeking && $3::text[]
  AND date_part('year', age($2::date, d.date_of_birth))::int BETWEEN $6 AND $7
  AND $5::int BETWEEN s.age_min AND s.age_max`;

type EntryRow = {
  id: string;
  batch_id: string;
  viewer_id: string;
  candidate_id: string;
  batch_date: string;
  position: number;
  context: 'DATING';
  status: IntroductionStatus;
};

type MatchRow = {
  id: string;
  member_a: string;
  member_b: string;
  pair_key: string;
  status: MatchStatus;
  created_at: string;
  ended_at: string | null;
  ended_reason: string | null;
};
type ConversationRow = { id: string; match_id: string; created_at: string; closed_at: string | null };
type MessageRow = { id: string; conversation_id: string; sender_id: string; body: string; client_message_id: string; created_at: string };

const categories = (v: string[] | null): DatingGenderPreference[] => (v ?? []).filter(isDatingCategory);
const other = (m: MatchRow, me: string) => (m.member_a === me ? m.member_b : m.member_a);

export function createMemberService(deps: MemberDeps) {
  const { pool, clock, config, store, delivery, limiter } = deps;
  const policy = deps.policy ?? DEFAULT_INTRODUCTION_POLICY;
  const today = () => isoDateIn(clock(), config.timeZone);
  const at = () => clock().toISOString();

  // --- Access ------------------------------------------------------------------------------

  type Me = { id: string; accountId: string };

  /** ACTIVE_MEMBER with a live membership, or MEMBERSHIP_REQUIRED. Provisions the profile once if needed. */
  async function access(db: Db, accountId: string): Promise<Me> {
    const { rows } = await db.query<{ status: ApplicationStatus; membership_status: Membership['status'] | null }>(
      `SELECT a.status, m.status AS membership_status FROM app.membership_applications a
       LEFT JOIN app.memberships m ON m.account_id = a.account_id WHERE a.account_id = $1`,
      [accountId],
    );
    const r = rows[0];
    if (!r || !canAccessMemberProduct(r.status, r.membership_status ? { status: r.membership_status } : null)) return fail('MEMBERSHIP_REQUIRED');
    const id =
      (await db.query<{ id: string }>('SELECT id FROM app.member_profiles WHERE account_id = $1', [accountId])).rows[0]?.id ??
      (await provisionMember(db, accountId, { at: at(), today: calendarDateIn(clock(), config.timeZone), store }));
    return id ? { id, accountId } : fail('MEMBERSHIP_REQUIRED');
  }

  /** Run a member operation: one transaction, membership checked inside it. */
  function asMember<T>(accountId: string, fn: (db: pg.PoolClient, me: Me) => Promise<T>): Promise<T> {
    return tx(pool, async (db) => fn(db, await access(db, accountId)));
  }

  // --- Reads ---------------------------------------------------------------------------------

  async function publicRows(db: Db, ids: readonly string[]): Promise<Map<string, PublicMemberRow>> {
    if (!ids.length) return new Map();
    const { rows } = await db.query<PublicMemberRow>(`${PUBLIC_MEMBER_SELECT} WHERE p.id = ANY($1)`, [ids, today()]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Profile photos as short-lived signed URLs — minted only for callers allowed to see them. */
  async function photosOf(db: Db, ids: readonly string[]): Promise<Map<string, MemberPhoto[]>> {
    const out = new Map<string, MemberPhoto[]>(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const { rows } = await db.query<{ id: string; member_id: string; storage_key: string; width: number; height: number }>(
      `SELECT id, member_id, storage_key, width, height FROM app.member_media
       WHERE member_id = ANY($1) AND type = 'photo' AND position >= 0 AND removed_at IS NULL AND purged_at IS NULL
       ORDER BY member_id, position`,
      [ids],
    );
    for (const r of rows) {
      out.get(r.member_id)?.push({ id: r.id, uri: await delivery.memberPhotoUrl(r.storage_key), width: r.width, height: r.height });
    }
    return out;
  }

  async function participants(db: Db, ids: readonly string[]): Promise<Map<string, DatingParticipant>> {
    if (!ids.length) return new Map();
    const { rows } = await db.query<ParticipantRow>(`${PARTICIPANT_SELECT} WHERE p.id = ANY($1)`, [ids, today()]);
    return new Map(rows.map((r) => [r.id, toParticipant(r)]));
  }

  function toParticipant(r: ParticipantRow): DatingParticipant {
    const usesDating = r.intents.includes('dating');
    const appearsAs = categories(r.appears_as);
    const seeking = categories(r.seeking);
    return {
      memberId: r.id,
      // A live membership AND an active account (not suspended, not being deleted).
      active:
        r.account_status === 'active' &&
        r.deleted_at === null &&
        canAccessMemberProduct(r.app_status, r.membership_status ? { status: r.membership_status } : null),
      visible: r.visibility === 'visible',
      usesDating,
      age: r.age,
      dating:
        usesDating && r.gender && r.age_min !== null && r.age_max !== null && appearsAs.length && seeking.length
          ? { appearsAs, seeking, ageRange: { min: r.age_min, max: r.age_max } }
          : null,
    };
  }

  async function blockedBetween(db: Db, a: string, b: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'SELECT 1 FROM app.blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
      [a, b],
    );
    return (rowCount ?? 0) > 0;
  }

  async function blockedSetOf(db: Db, me: string): Promise<Set<string>> {
    const { rows } = await db.query<{ id: string }>(
      'SELECT blocked_id AS id FROM app.blocks WHERE blocker_id = $1 UNION SELECT blocker_id FROM app.blocks WHERE blocked_id = $1',
      [me],
    );
    return new Set(rows.map((r) => r.id));
  }

  /** Is an introduction between `me` and `candidateId` valid right now (membership, block, preferences)? */
  async function stillEligible(db: Db, me: string, candidateId: string): Promise<boolean> {
    const ps = await participants(db, [me, candidateId]);
    const v = ps.get(me);
    const c = ps.get(candidateId);
    if (!v || !c) return false;
    return datingEligibility(v, c, { blocked: await blockedBetween(db, me, candidateId), exhausted: false }).eligible;
  }

  async function activeMatchesOf(db: Db, me: string): Promise<MatchRow[]> {
    const { rows } = await db.query<MatchRow>(
      `SELECT m.* FROM app.matches m
       WHERE (m.member_a = $1 OR m.member_b = $1) AND m.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM app.blocks b WHERE (b.blocker_id = m.member_a AND b.blocked_id = m.member_b)
                                                     OR (b.blocker_id = m.member_b AND b.blocked_id = m.member_a))
       ORDER BY m.created_at`,
      [me],
    );
    const ps = await participants(db, rows.map((m) => other(m, me)));
    return rows.filter((m) => ps.get(other(m, me))?.active);
  }

  async function datingSettingsRow(db: Db, me: string) {
    const { rows } = await db.query<{
      gender: DatingGenderId | null;
      self_description: string | null;
      appears_as: string[];
      seeking: string[];
      age_min: number | null;
      age_max: number | null;
      setup_completed_at: string | null;
    }>('SELECT gender, self_description, appears_as, seeking, age_min, age_max, setup_completed_at FROM app.dating_settings WHERE member_id = $1', [me]);
    return rows[0] ?? null;
  }

  async function own(db: Db, me: Me): Promise<OwnMember> {
    const row = (await publicRows(db, [me.id])).get(me.id)!;
    const photos = (await photosOf(db, [me.id])).get(me.id) ?? [];
    const m = (
      await db.query<{ plan_id: string; status: Membership['status']; started_at: string | null; renews_at: string | null; activation: Membership['activation'] }>(
        'SELECT plan_id, status, started_at, renews_at, activation FROM app.memberships WHERE account_id = $1',
        [me.accountId],
      )
    ).rows[0]!;
    const usesDating = row.intents.includes('dating');
    const p = (await participants(db, [me.id])).get(me.id)!;
    return {
      profile: toOwnProfileDTO(row, photos),
      membership: { planId: m.plan_id, status: m.status, startedAt: m.started_at, renewsAt: m.renews_at, activation: m.activation },
      dating: { usesDating, setupRequired: usesDating && !p.dating },
    };
  }

  async function ownDating(db: Db, me: Me): Promise<OwnDatingSettings> {
    const usesDating = ((await publicRows(db, [me.id])).get(me.id)?.intents ?? []).includes('dating');
    const s = usesDating ? await datingSettingsRow(db, me.id) : null;
    return {
      usesDating,
      identity: s?.gender ? { gender: s.gender, selfDescription: s.self_description, appearsAs: categories(s.appears_as) } : null,
      seeking: s ? categories(s.seeking) : [],
      ageRange: s && s.age_min !== null && s.age_max !== null ? { min: s.age_min, max: s.age_max } : null,
      setupCompletedAt: s?.setup_completed_at ?? null,
    };
  }

  // --- Introductions -----------------------------------------------------------------------------

  async function introductionsState(db: Db, me: string): Promise<IntroductionsState> {
    const p = (await participants(db, [me])).get(me)!;
    if (!p.usesDating) return 'NOT_USING_DATING';
    return p.dating ? 'READY' : 'DATING_SETUP_REQUIRED';
  }

  /** Today's batch — created once (locked per member and day), never refilled. */
  async function batchFor(db: Db, me: string): Promise<{ id: string; date: string; size: number }> {
    const date = today();
    await lockKey(db, `batch:${me}:${date}`);
    const existing = (
      await db.query<{ id: string; n: string }>(
        `SELECT b.id, (SELECT count(*) FROM app.introduction_entries e WHERE e.batch_id = b.id) AS n
         FROM app.introduction_batches b WHERE b.member_id = $1 AND b.batch_date = $2`,
        [me, date],
      )
    ).rows[0];
    if (existing) return { id: existing.id, date, size: Number(existing.n) };

    const viewer = (await participants(db, [me])).get(me)!;
    // Staging QA accounts and everyone else are kept apart (DEC-076; always false in production).
    const viewerQa = (
      await db.query<{ qa: boolean }>('SELECT acc.qa_account AS qa FROM app.member_profiles p JOIN app.accounts acc ON acc.id = p.account_id WHERE p.id = $1', [me])
    ).rows[0]?.qa ?? false;
    const { rows: reactions } = await db.query<{ to_member_id: string; type: ReactionType; created_at: string }>(
      'SELECT to_member_id, type, created_at FROM app.reactions WHERE from_member_id = $1',
      [me],
    );
    // Match history: ACTIVE and BLOCKED pairs are never reintroduced; ENDED ones per the rematch policy.
    const { rows: matched } = await db.query<MatchRow>('SELECT * FROM app.matches WHERE member_a = $1 OR member_b = $1', [me]);
    const { rows: earlier } = await db.query<{ candidate_id: string; batch_date: string }>(
      `SELECT candidate_id, batch_date FROM app.introduction_entries
       WHERE viewer_id = $1 AND batch_date < $2::date AND batch_date > $2::date - $3::int`,
      [me, date, policy.reintroduceAfterDays],
    );
    const exhausted = exhaustedCandidates({
      today: date,
      policy,
      reactions: reactions.map((r) => ({ toMemberId: r.to_member_id, type: r.type, date: isoDateIn(new Date(r.created_at), config.timeZone) })),
      matches: matched.map((m) => ({
        otherId: other(m, me),
        status: m.status,
        endedOn: m.ended_at ? isoDateIn(new Date(m.ended_at), config.timeZone) : null,
      })),
      earlierIntroductions: earlier.map((e) => ({ candidateId: e.candidate_id, date: e.batch_date })),
    });
    const blocked = await blockedSetOf(db, me);
    // The pool: other members with completed Dating setup. Every rule is applied by the eligibility function.
    const v = viewer.dating;
    const { rows: pool_ } = v
      ? await db.query<ParticipantRow>(
          `${PARTICIPANT_SELECT}
           WHERE p.id <> $1 AND a.status = 'ACTIVE_MEMBER' AND s.setup_completed_at IS NOT NULL
             AND p.visibility = 'visible' AND acc.account_status = 'active' AND p.deleted_at IS NULL
             AND acc.qa_account = $8
             AND ${POOL_PREFILTER}`,
          [me, date, v.appearsAs, v.seeking, viewer.age, v.ageRange.min, v.ageRange.max, viewerQa],
        )
      : { rows: [] as ParticipantRow[] };
    const ids = selectDatingIntroductions({
      viewer,
      candidates: pool_.map(toParticipant),
      pair: (id) => ({ blocked: blocked.has(id), exhausted: exhausted.has(id) }),
      size: policy.perDay,
      rank: (id) => stableRank(`${me}:${id}:${date}`),
    });
    const batchId = newId('int');
    const now = at();
    await db.query('INSERT INTO app.introduction_batches (id, member_id, batch_date, created_at) VALUES ($1, $2, $3, $4)', [batchId, me, date, now]);
    for (const [position, candidateId] of ids.entries()) {
      await db.query(
        `INSERT INTO app.introduction_entries (id, batch_id, viewer_id, candidate_id, batch_date, position, context, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'DATING', 'PENDING', $7)`,
        [newId('itr'), batchId, me, candidateId, date, position, now],
      );
    }
    return { id: batchId, date, size: ids.length };
  }

  /** Waiting entries; anyone no longer eligible (settings changed, block, membership) is withdrawn. */
  async function waitingEntries(db: Db, me: string, batchId: string): Promise<EntryRow[]> {
    const { rows } = await db.query<EntryRow>(
      `SELECT * FROM app.introduction_entries WHERE batch_id = $1 AND status = 'PENDING' ORDER BY position`,
      [batchId],
    );
    if (!rows.length) return [];
    const ps = await participants(db, [me, ...rows.map((r) => r.candidate_id)]);
    const blocked = await blockedSetOf(db, me);
    const viewer = ps.get(me)!;
    const out: EntryRow[] = [];
    for (const e of rows) {
      const c = ps.get(e.candidate_id);
      const ok = c && datingEligibility(viewer, c, { blocked: blocked.has(e.candidate_id), exhausted: false }).eligible;
      if (ok) out.push(e);
      else await db.query(`UPDATE app.introduction_entries SET status = 'WITHDRAWN' WHERE id = $1 AND status = 'PENDING'`, [e.id]);
    }
    return out;
  }

  /** May `me` see `memberId`? Introduced today (still valid) or actively matched — never across a block. */
  async function canView(db: Db, me: string, memberId: string): Promise<boolean> {
    if (memberId === me) return true;
    const target = (await participants(db, [memberId])).get(memberId);
    if (!target?.active || (await blockedBetween(db, me, memberId))) return false;
    const { rows } = await db.query<EntryRow>(
      `SELECT * FROM app.introduction_entries WHERE viewer_id = $1 AND candidate_id = $2 AND batch_date = $3 AND status <> 'WITHDRAWN'`,
      [me, memberId, today()],
    );
    const entry = rows[0];
    if (entry?.status === 'PENDING') {
      if (await stillEligible(db, me, memberId)) return true;
      await db.query(`UPDATE app.introduction_entries SET status = 'WITHDRAWN' WHERE id = $1`, [entry.id]);
    } else if (entry) return true;
    return (await activeMatchesOf(db, me)).some((m) => m.member_a === memberId || m.member_b === memberId);
  }

  async function matchView(db: Db, me: string, m: MatchRow): Promise<MatchView> {
    const otherId = other(m, me);
    const rows = await publicRows(db, [me, otherId]);
    const photos = await photosOf(db, [me, otherId]);
    const c = (await db.query<ConversationRow>('SELECT * FROM app.conversations WHERE match_id = $1', [m.id])).rows[0];
    return {
      matchId: m.id,
      createdAt: m.created_at,
      self: toMemberCardDTO(rows.get(me)!, photos.get(me) ?? []),
      other: toMemberCardDTO(rows.get(otherId)!, photos.get(otherId) ?? []),
      conversationId: c?.id ?? null,
    };
  }

  async function thread(db: Db, me: string, conversationId: string): Promise<ThreadMessage[]> {
    const { rows } = await db.query<MessageRow>('SELECT * FROM app.messages WHERE conversation_id = $1 ORDER BY created_at, seq', [conversationId]);
    return rows.map((m) => ({ id: m.id, fromSelf: m.sender_id === me, body: m.body, createdAt: m.created_at }));
  }

  // --- API ---------------------------------------------------------------------------------------

  return {
    getMe: (accountId: string) => asMember(accountId, (db, me) => own(db, me)),

    confirmProfile: (accountId: string) =>
      asMember(accountId, async (db, me) => {
        await db.query('UPDATE app.member_profiles SET confirmed_at = coalesce(confirmed_at, $2), updated_at = $2 WHERE id = $1', [me.id, at()]);
        return own(db, me);
      }),

    async updateProfile(accountId: string, body: unknown): Promise<OwnMember> {
      await limiter.consume(LIMITS.profileUpdatePerMember, accountId);
      return asMember(accountId, async (db, me) => {
        const patch = (body ?? {}) as Record<string, unknown>;
        // Type-check untrusted input before the shared validator sees it; unknown keys are ignored.
        const wrongType = (['occupation', 'cityLabel', 'knownFor'] as const).filter((k) => patch[k] !== undefined && typeof patch[k] !== 'string');
        const arrays = (['interests', 'photoOrder'] as const).filter(
          (k) => patch[k] !== undefined && !(Array.isArray(patch[k]) && (patch[k] as unknown[]).every((x) => typeof x === 'string')),
        );
        if (wrongType.length || arrays.length) return fail('VALIDATION_FAILED', { fields: [...wrongType, ...arrays] });
        // Purged photos (deleted under the retention policy) can never return to the profile.
        const { rows: photoRows } = await db.query<{ id: string }>(
          `SELECT id FROM app.member_media WHERE member_id = $1 AND type = 'photo' AND purged_at IS NULL`,
          [me.id],
        );
        const v = validateMemberProfilePatch(
          {
            occupation: patch.occupation as string | undefined,
            cityLabel: patch.cityLabel as string | undefined,
            knownFor: patch.knownFor as string | undefined,
            interests: patch.interests as string[] | undefined,
            photoOrder: patch.photoOrder as string[] | undefined,
          },
          { photoIds: photoRows.map((r) => r.id) },
        );
        if (!v.ok) return fail('VALIDATION_FAILED', { fields: v.fields });
        const p = v.value;
        // Only the member profile changes. Application records are untouched.
        await db.query(
          `UPDATE app.member_profiles SET
             occupation = coalesce($2, occupation), city_label = coalesce($3, city_label),
             known_for = coalesce($4, known_for), interests = coalesce($5, interests), updated_at = $6
           WHERE id = $1`,
          [me.id, p.occupation ?? null, p.cityLabel ?? null, p.knownFor ?? null, p.interests ?? null, at()],
        );
        if (p.photoOrder) {
          const now = at();
          for (const r of photoRows) {
            const position = p.photoOrder.indexOf(r.id);
            // -1 = removed from the profile: no longer delivered; the object is purged by the retention process (DEC-067).
            await db.query(
              `UPDATE app.member_media SET position = $2, removed_at = CASE WHEN $2 < 0 THEN coalesce(removed_at, $3::timestamptz) ELSE NULL END WHERE id = $1`,
              [r.id, position, now],
            );
          }
        }
        return own(db, me);
      });
    },

    getDatingSettings: (accountId: string) => asMember(accountId, (db, me) => ownDating(db, me)),

    async saveDatingSettings(accountId: string, body: unknown): Promise<OwnDatingSettings> {
      await limiter.consume(LIMITS.datingSettingsPerMember, accountId);
      return asMember(accountId, async (db, me) => {
        const usesDating = ((await publicRows(db, [me.id])).get(me.id)?.intents ?? []).includes('dating');
        if (!usesDating) return fail('NOT_ALLOWED');
        const v = validateDatingSettingsInput(body as never);
        if (!v.ok) return fail('VALIDATION_FAILED', { fields: v.fields });
        const now = at();
        await db.query(
          `INSERT INTO app.dating_settings (member_id, gender, self_description, appears_as, seeking, age_min, age_max, setup_completed_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)
           ON CONFLICT (member_id) DO UPDATE SET gender = EXCLUDED.gender, self_description = EXCLUDED.self_description,
             appears_as = EXCLUDED.appears_as, seeking = EXCLUDED.seeking, age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max,
             setup_completed_at = EXCLUDED.setup_completed_at, updated_at = EXCLUDED.updated_at`,
          [
            me.id,
            v.value.identity.gender,
            v.value.identity.selfDescription,
            v.value.identity.appearsAs,
            v.value.seeking,
            v.value.ageRange.min,
            v.value.ageRange.max,
            now,
          ],
        );
        // Existing matches and conversations stay; waiting introductions are re-checked on the next read.
        return ownDating(db, me);
      });
    },

    getIntroductions: (accountId: string) =>
      asMember(accountId, async (db, me): Promise<IntroductionsView> => {
        const state = await introductionsState(db, me.id);
        if (state !== 'READY') return { state, batchId: null, date: today(), waiting: [], hadIntroductions: false };
        const batch = await batchFor(db, me.id);
        const entries = await waitingEntries(db, me.id, batch.id);
        const ids = entries.map((e) => e.candidate_id);
        const rows = await publicRows(db, ids);
        const photos = await photosOf(db, ids);
        const waiting: IntroductionDTO[] = entries.map((e) => ({
          introductionId: e.id,
          context: e.context,
          member: toPublicMemberDTO(rows.get(e.candidate_id)!, photos.get(e.candidate_id) ?? []),
        }));
        return { state, batchId: batch.id, date: batch.date, waiting, hadIntroductions: batch.size > 0 };
      }),

    getMemberProfile: (accountId: string, memberId: string) =>
      asMember(accountId, async (db, me) => {
        if (!(await canView(db, me.id, memberId))) return fail('NOT_AVAILABLE');
        const row = (await publicRows(db, [memberId])).get(memberId) ?? fail('NOT_AVAILABLE');
        return toPublicMemberDTO(row, (await photosOf(db, [memberId])).get(memberId) ?? []);
      }),

    /** Pass or like one introduction — idempotent, transaction-safe, one match per pair. */
    async react(accountId: string, introductionId: string, type: unknown): Promise<ReactionResult> {
      if (!isReactionType(type)) return fail('VALIDATION_FAILED', { fields: ['type'] });
      await limiter.consume(LIMITS.reactionPerMember, accountId);
      return asMember(accountId, async (db, me) => {
        const entry = (await db.query<EntryRow>('SELECT * FROM app.introduction_entries WHERE id = $1 FOR UPDATE', [introductionId])).rows[0] ?? null;
        const mine = entry && entry.viewer_id === me.id ? entry : null;
        if (mine) await lockKey(db, `pair:${pairKey(me.id, mine.candidate_id)}`); // serialise the pair before reading it
        const candidateId = mine?.candidate_id ?? '';
        const existing = mine
          ? ((await db.query<{ type: ReactionType }>('SELECT type FROM app.reactions WHERE introduction_id = $1', [mine.id])).rows[0]?.type ?? null)
          : null;
        const key = mine ? pairKey(me.id, candidateId) : '';
        // "Did they like me?" — only likes after this pair's last ended match count (a fresh start).
        const likedBack = mine
          ? ((
              await db.query(
                `SELECT 1 FROM app.reactions r
                  WHERE r.from_member_id = $1 AND r.to_member_id = $2 AND r.type = 'LIKE'
                    AND r.created_at > coalesce((SELECT max(ended_at) FROM app.matches WHERE pair_key = $3 AND status <> 'ACTIVE'), '-infinity')`,
                [candidateId, me.id, key],
              )
            ).rowCount ?? 0) > 0
          : false;
        const active = mine
          ? ((await db.query<MatchRow>(`SELECT * FROM app.matches WHERE pair_key = $1 AND status = 'ACTIVE'`, [key])).rows[0] ?? null)
          : null;
        const decision = decideReaction({
          entry: mine ? { viewerId: mine.viewer_id, date: mine.batch_date, status: mine.status } : null,
          viewerId: me.id,
          type,
          today: today(),
          existing,
          eligible: mine ? await stillEligible(db, me.id, candidateId) : false,
          likedBack,
          activeMatch: active !== null,
        });
        if (!decision.ok) return fail(decision.error);
        if (decision.outcome === 'REPLAY') {
          return { type, match: type === 'LIKE' && active ? await matchView(db, me.id, active) : null };
        }
        const now = at();
        await db.query(
          `INSERT INTO app.reactions (id, introduction_id, from_member_id, to_member_id, type, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [newId('rct'), mine!.id, me.id, candidateId, type, now],
        );
        await db.query('UPDATE app.introduction_entries SET status = $2, responded_at = $3 WHERE id = $1', [
          mine!.id,
          type === 'LIKE' ? 'LIKED' : 'PASSED',
          now,
        ]);
        if (!decision.createsMatch) return { type, match: null };
        const [a, b] = sortedPair(me.id, candidateId);
        const created = (
          await db.query<MatchRow>(
            `INSERT INTO app.matches (id, member_a, member_b, pair_key, status, created_at) VALUES ($1, $2, $3, $4, 'ACTIVE', $5)
             ON CONFLICT (pair_key) WHERE status = 'ACTIVE' DO NOTHING RETURNING *`,
            [newId('mch'), a, b, pairKey(a, b), now],
          )
        ).rows[0];
        const match =
          created ?? (await db.query<MatchRow>(`SELECT * FROM app.matches WHERE pair_key = $1 AND status = 'ACTIVE'`, [pairKey(a, b)])).rows[0];
        return { type, match: match ? await matchView(db, me.id, match) : null };
      });
    },

    getMatch: (accountId: string, matchId: string) =>
      asMember(accountId, async (db, me) => {
        const m = (await activeMatchesOf(db, me.id)).find((x) => x.id === matchId) ?? fail('MATCH_NOT_FOUND');
        return matchView(db, me.id, m);
      }),

    listConversations: (accountId: string) =>
      asMember(accountId, async (db, me): Promise<ConversationSummary[]> => {
        const matches = await activeMatchesOf(db, me.id);
        const others = matches.map((m) => other(m, me.id));
        const rows = await publicRows(db, others);
        const photos = await photosOf(db, others);
        const out: ConversationSummary[] = [];
        for (const m of matches) {
          const o = other(m, me.id);
          const c = (await db.query<ConversationRow>('SELECT * FROM app.conversations WHERE match_id = $1', [m.id])).rows[0];
          const last = c
            ? (await db.query<MessageRow>('SELECT * FROM app.messages WHERE conversation_id = $1 ORDER BY created_at DESC, seq DESC LIMIT 1', [c.id])).rows[0]
            : undefined;
          const openedAt = c
            ? ((
                await db.query<{ last_opened_at: string | null }>(
                  'SELECT last_opened_at FROM app.conversation_participants WHERE conversation_id = $1 AND member_id = $2',
                  [c.id, me.id],
                )
              ).rows[0]?.last_opened_at ?? null)
            : null;
          const lastMessage = last ? { body: last.body, fromSelf: last.sender_id === me.id, createdAt: last.created_at } : null;
          out.push({
            matchId: m.id,
            conversationId: c?.id ?? null,
            other: toMemberCardDTO(rows.get(o)!, photos.get(o) ?? []),
            matchedAt: m.created_at,
            lastMessage,
            unread: openedAt === null ? true : Boolean(lastMessage && !lastMessage.fromSelf && lastMessage.createdAt > openedAt),
          });
        }
        out.sort((x, y) => (y.lastMessage?.createdAt ?? y.matchedAt).localeCompare(x.lastMessage?.createdAt ?? x.matchedAt));
        return out;
      }),

    /** Only for an active match: opens (creating if needed) its conversation and marks it read. */
    openConversation: (accountId: string, matchId: string) =>
      asMember(accountId, async (db, me): Promise<ConversationView> => {
        const m = (await activeMatchesOf(db, me.id)).find((x) => x.id === matchId) ?? fail('MATCH_NOT_FOUND');
        await db.query('INSERT INTO app.conversations (id, match_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (match_id) DO NOTHING', [
          newId('cnv'),
          m.id,
          at(),
        ]);
        const c = (await db.query<ConversationRow>('SELECT * FROM app.conversations WHERE match_id = $1', [m.id])).rows[0]!;
        if (c.closed_at) return fail('MATCH_NOT_FOUND');
        for (const memberId of [m.member_a, m.member_b]) {
          await db.query(
            'INSERT INTO app.conversation_participants (conversation_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [c.id, memberId],
          );
        }
        await db.query('UPDATE app.conversation_participants SET last_opened_at = $3 WHERE conversation_id = $1 AND member_id = $2', [c.id, me.id, at()]);
        const o = other(m, me.id);
        const rows = await publicRows(db, [o]);
        const photos = await photosOf(db, [o]);
        return {
          conversationId: c.id,
          matchId: m.id,
          matchedAt: m.created_at,
          other: toMemberCardDTO(rows.get(o)!, photos.get(o) ?? []),
          messages: await thread(db, me.id, c.id),
        };
      }),

    /** Text only; participants of an open conversation of an active, unblocked match. Idempotent per client message id. */
    async sendMessage(accountId: string, conversationId: string, body: unknown): Promise<ThreadMessage> {
      const b = (body ?? {}) as { body?: unknown; clientMessageId?: unknown };
      if (typeof b.clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(b.clientMessageId)) {
        return fail('VALIDATION_FAILED', { fields: ['clientMessageId'] });
      }
      if (typeof b.body !== 'string') return fail('VALIDATION_FAILED', { fields: ['empty'] });
      await limiter.consume(LIMITS.messagePerMinute, accountId);
      await limiter.consume(LIMITS.messagePerDay, accountId);
      const clientMessageId = b.clientMessageId;
      const text = b.body;
      return asMember(accountId, async (db, me) => {
        const c = (await db.query<ConversationRow>('SELECT * FROM app.conversations WHERE id = $1', [conversationId])).rows[0];
        // FOR SHARE: a block or deletion that ends the match waits for this message, or this message sees it ended.
        const m = c ? (await db.query<MatchRow>('SELECT * FROM app.matches WHERE id = $1 FOR SHARE', [c.match_id])).rows[0] : undefined;
        const isParticipant = Boolean(m && (m.member_a === me.id || m.member_b === me.id));
        const o = m && isParticipant ? other(m, me.id) : '';
        const otherActive = o ? Boolean((await participants(db, [o])).get(o)?.active) : false;
        if (
          !c ||
          !m ||
          !canSendMessage({
            isParticipant,
            matchActive: m.status === 'ACTIVE' && otherActive,
            conversationOpen: c.closed_at === null,
            blocked: o ? await blockedBetween(db, me.id, o) : true,
          })
        ) {
          return fail('CONVERSATION_FORBIDDEN');
        }
        const prior = (
          await db.query<MessageRow>(
            'SELECT * FROM app.messages WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3',
            [c.id, me.id, clientMessageId],
          )
        ).rows[0];
        if (prior) return { id: prior.id, fromSelf: true, body: prior.body, createdAt: prior.created_at };
        const v = validateMessage(text);
        if (!v.ok) return fail('VALIDATION_FAILED', { fields: [v.error] });
        const now = at();
        // The sender is a participant first (messages reference conversation_participants).
        await db.query(
          `INSERT INTO app.conversation_participants (conversation_id, member_id, last_opened_at) VALUES ($1, $2, $3)
           ON CONFLICT (conversation_id, member_id) DO UPDATE SET last_opened_at = EXCLUDED.last_opened_at`,
          [c.id, me.id, now],
        );
        const inserted = (
          await db.query<MessageRow>(
            `INSERT INTO app.messages (id, conversation_id, sender_id, body, client_message_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (conversation_id, sender_id, client_message_id) DO NOTHING RETURNING *`,
            [newId('msg'), c.id, me.id, v.value, clientMessageId, now],
          )
        ).rows[0];
        const msg =
          inserted ??
          (
            await db.query<MessageRow>('SELECT * FROM app.messages WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3', [
              c.id,
              me.id,
              clientMessageId,
            ])
          ).rows[0]!;
        return { id: msg.id, fromSelf: true, body: msg.body, createdAt: msg.created_at };
      });
    },

    /**
     * Block: silent and total. The match ends, its conversation closes, nobody
     * is notified, and every record is kept (safety evidence).
     */
    blockMember: (accountId: string, memberId: string) =>
      asMember(accountId, async (db, me): Promise<{ blocked: true }> => {
        if (memberId === me.id) return fail('NOT_AVAILABLE');
        const exists = (await db.query('SELECT 1 FROM app.member_profiles WHERE id = $1', [memberId])).rowCount ?? 0;
        if (!exists) return fail('NOT_AVAILABLE');
        const already = (await db.query('SELECT 1 FROM app.blocks WHERE blocker_id = $1 AND blocked_id = $2', [me.id, memberId])).rowCount ?? 0;
        if (already) return { blocked: true };
        // The pair lock serialises a block with a concurrent reaction (which re-checks eligibility under the same lock).
        await lockKey(db, `pair:${pairKey(me.id, memberId)}`);
        if (!(await blockedBetween(db, me.id, memberId)) && !(await canView(db, me.id, memberId))) return fail('NOT_AVAILABLE');
        const now = at();
        await db.query('INSERT INTO app.blocks (id, blocker_id, blocked_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
          newId('blk'),
          me.id,
          memberId,
          now,
        ]);
        const m = (
          await db.query<MatchRow>(
            `UPDATE app.matches SET status = 'BLOCKED', ended_at = $2, ended_reason = 'BLOCK' WHERE pair_key = $1 AND status = 'ACTIVE' RETURNING *`,
            [pairKey(me.id, memberId), now],
          )
        ).rows[0];
        if (m) await db.query('UPDATE app.conversations SET closed_at = coalesce(closed_at, $2) WHERE match_id = $1', [m.id, now]);
        // Waiting introductions between the two end now, in the same transaction — not lazily on the next read —
        // so no row anywhere still offers the pair to each other (the staging race check found the lag).
        await db.query(
          `UPDATE app.introduction_entries SET status = 'WITHDRAWN'
            WHERE status = 'PENDING' AND ((viewer_id = $1 AND candidate_id = $2) OR (viewer_id = $2 AND candidate_id = $1))`,
          [me.id, memberId],
        );
        return { blocked: true };
      }),

    async reportMember(accountId: string, memberId: string, body: unknown): Promise<{ reported: true }> {
      const r = (body ?? {}) as { reason?: unknown; context?: unknown; conversationId?: unknown };
      if (!isReportReason(r.reason) || (r.context !== 'profile' && r.context !== 'conversation')) {
        return fail('VALIDATION_FAILED', { fields: ['reason'] });
      }
      await limiter.consume(LIMITS.reportPerMember, accountId);
      return asMember(accountId, async (db, me) => {
        const iBlocked = ((await db.query('SELECT 1 FROM app.blocks WHERE blocker_id = $1 AND blocked_id = $2', [me.id, memberId])).rowCount ?? 0) > 0;
        const exists = ((await db.query('SELECT 1 FROM app.member_profiles WHERE id = $1', [memberId])).rowCount ?? 0) > 0;
        if (memberId === me.id || !exists || (!iBlocked && !(await canView(db, me.id, memberId)))) return fail('NOT_AVAILABLE');
        let conversationId: string | null = null;
        if (typeof r.conversationId === 'string') {
          // Only a conversation between these two members can be attached.
          const ok = await db.query(
            `SELECT 1 FROM app.conversations c JOIN app.matches m ON m.id = c.match_id WHERE c.id = $1 AND m.pair_key = $2`,
            [r.conversationId, pairKey(me.id, memberId)],
          );
          if (!(ok.rowCount ?? 0)) return fail('VALIDATION_FAILED', { fields: ['conversationId'] });
          conversationId = r.conversationId;
        }
        await db.query(
          `INSERT INTO app.reports (id, reporter_id, reported_id, reason, context, conversation_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newId('rpt'), me.id, memberId, r.reason, r.context, conversationId, at()],
        );
        return { reported: true };
      });
    },

    listBlocked: (accountId: string) =>
      asMember(accountId, async (db, me): Promise<BlockedMember[]> => {
        const { rows } = await db.query<{ blocked_id: string; display_name: string; created_at: string }>(
          `SELECT b.blocked_id, p.display_name, b.created_at FROM app.blocks b JOIN app.member_profiles p ON p.id = b.blocked_id
           WHERE b.blocker_id = $1 ORDER BY b.created_at`,
          [me.id],
        );
        return rows.map((r) => ({ memberId: r.blocked_id, displayName: r.display_name, blockedAt: r.created_at }));
      }),
  };
}

export type MemberService = ReturnType<typeof createMemberService>;
export type { Intent };
