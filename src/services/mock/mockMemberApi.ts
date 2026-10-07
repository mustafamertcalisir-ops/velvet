/**
 * Mock member backend — local development and deterministic E2E only.
 * Implements the same MemberApi contract as the production backend
 * (server/src/member/), with the same domain rules, on an in-memory store
 * shared with the admission mock (member profiles are provisioned from
 * approved application records).
 *
 * Server rules enforced here, never on the device:
 * - Every member call requires ACTIVE_MEMBER with a live membership.
 * - A member profile is provisioned once, at activation, through the
 *   sanctioned whitelist; application photos are promoted explicitly.
 * - Dating settings are private and member-owned; Dating setup is required
 *   before a Dating member gets introductions (DEC-058).
 * - Today's introductions contain only members passing the single
 *   eligibility function (src/domain/member/compatibility.ts).
 * - Reactions answer one introduction, idempotently; a match exists only
 *   when both members liked each other, one per pair.
 * - Conversations exist only for active matches; a block ends the match,
 *   closes the conversation and is never revealed.
 */
import { canAccessMemberProduct } from '@/domain/admission/access';
import { PHOTO_MAX, type AgeRange, type Intent } from '@/domain/admission/stage2';
import { datingEligibility, type DatingParticipant } from '@/domain/member/compatibility';
import {
  canSendMessage,
  validateMessage,
  type Conversation,
  type Message,
  type ThreadMessage,
} from '@/domain/member/conversation';
import {
  seekingFromMeet,
  validateDatingSettingsInput,
  type DatingGenderId,
  type DatingGenderPreference,
} from '@/domain/member/dating';
import {
  DEFAULT_INTRODUCTION_POLICY,
  exhaustedCandidates,
  selectDatingIntroductions,
  stableRank,
  type IntroductionBatch,
  type IntroductionEntry,
  type IntroductionPolicy,
} from '@/domain/member/introductions';
import {
  decideReaction,
  endedStatus,
  isReactionType,
  likedSince,
  otherMember,
  pairKey,
  sortedPair,
  type Match,
  type MemberReaction,
  type ReactionType,
} from '@/domain/member/matching';
import { validateMemberProfilePatch } from '@/domain/member/profileEdit';
import { blockedSet, isBlockedBetween, isReportReason, type Block, type Report } from '@/domain/member/safety';
import {
  projectMemberCard,
  projectMemberProfile,
  projectOwnProfile,
  type MemberCard,
  type MemberProfileView,
} from '@/domain/member/views';
import type {
  ApplicationMedia,
  DatingPreferencesRecord,
  Membership,
  MembershipApplication,
  MemberProfileMedia,
  PrivateApplicationData,
  PublicMemberProfile,
  UserAccount,
} from '@/domain/models';
import { createPublicProfile, derivePublicProfileSource } from '@/domain/profile/publicProfile';
import { ageOn, parseISODate, todayInLocalCalendar, toISODate } from '@/domain/validation/dateOfBirth';
import { createId } from '@/lib/id';
import type { ApiError, ApiResult, Session } from '../api/types';
import type {
  ConversationSummary,
  ConversationView,
  IntroductionDTO,
  IntroductionsState,
  IntroductionsView,
  MatchView,
  MemberApi,
  OwnDatingSettings,
  OwnMember,
} from '../api/memberTypes';

/** The member's private matching record (DEC-058). */
export type DatingSettingsRecord = {
  memberId: string;
  gender: DatingGenderId | null;
  selfDescription: string | null;
  appearsAs: DatingGenderPreference[];
  seeking: DatingGenderPreference[];
  ageRange: AgeRange | null;
  setupCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemberTables = {
  memberProfiles: Record<string, PublicMemberProfile>; // by member profile id
  memberIdByUser: Record<string, string>;
  memberMedia: Record<string, MemberProfileMedia>;
  datingSettings: Record<string, DatingSettingsRecord>; // by member profile id — private
  introductionBatches: Record<string, IntroductionBatch>; // `${memberId}:${date}`
  introductionEntries: Record<string, IntroductionEntry>; // by introduction id
  reactions: Record<string, MemberReaction>;
  matches: Record<string, Match>;
  conversations: Record<string, Conversation>;
  messages: Record<string, Message>;
  blocks: Record<string, Block>;
  reports: Record<string, Report>;
  /** Curated order hints (stand-in for human curation; set by fixtures). */
  curation: Record<string, number>;
};

export const emptyMemberTables = (): MemberTables => ({
  memberProfiles: {},
  memberIdByUser: {},
  memberMedia: {},
  datingSettings: {},
  introductionBatches: {},
  introductionEntries: {},
  reactions: {},
  matches: {},
  conversations: {},
  messages: {},
  blocks: {},
  reports: {},
  curation: {},
});

/** The admission tables the member server reads (shapes owned by the admission mock). */
export type MemberServerDb = MemberTables & {
  accounts: Record<string, UserAccount>;
  userIdByPhone: Record<string, string>;
  applications: Record<string, MembershipApplication>;
  privateData: Record<string, PrivateApplicationData>;
  memberships: Record<string, Membership>;
  media: Record<string, ApplicationMedia>;
  datingPreferences: Record<string, DatingPreferencesRecord>;
};

export type MemberOperation =
  | 'getMe'
  | 'confirmProfile'
  | 'updateProfile'
  | 'addProfilePhoto'
  | 'getDatingSettings'
  | 'saveDatingSettings'
  | 'getIntroductions'
  | 'getMemberProfile'
  | 'react'
  | 'getMatch'
  | 'listConversations'
  | 'openConversation'
  | 'sendMessage'
  | 'blockMember'
  | 'reportMember'
  | 'listBlocked';

type Op = <T>(name: MemberOperation, fn: (db: MemberServerDb) => ApiResult<T>) => Promise<ApiResult<T>>;

export type MockMemberContext = {
  op: Op;
  /** Run against the store outside the request path (fixtures, provisioning). */
  transact: <T>(fn: (db: MemberServerDb) => T) => Promise<T>;
  now: () => Date;
  random: () => number;
  userFor: (db: MemberServerDb, session: Session) => string | null;
  policy?: IntroductionPolicy;
};

const MAX_UPLOAD_CHARS = 1_500_000;

export function createMockMemberApi(ctx: MockMemberContext) {
  const { op, now, random } = ctx;
  const policy = ctx.policy ?? DEFAULT_INTRODUCTION_POLICY;
  const iso = () => now().toISOString();
  const today = () => toISODate(todayInLocalCalendar(now()));
  const dayOf = (isoTime: string) => toISODate(todayInLocalCalendar(new Date(isoTime)));
  const fail = (error: ApiError) => ({ ok: false as const, error });
  const ok = <T>(value: T) => ({ ok: true as const, value });

  // --- Provisioning ------------------------------------------------------------------

  function hasMemberAccess(db: MemberServerDb, userId: string): boolean {
    const app = db.applications[userId];
    if (db.accounts[userId] && db.accounts[userId]!.accountStatus !== 'active') return false;
    return Boolean(app && canAccessMemberProduct(app.status, db.memberships[userId] ?? null));
  }

  /**
   * Create the member profile from the approved application — once. Uses the
   * sanctioned whitelist constructor; promotes only profile photos that are
   * current and not rejected (verification photos never). A Dating member
   * also gets a private Dating settings record seeded from the application's
   * answers; their own identity is asked in Dating setup.
   */
  function provision(db: MemberServerDb, userId: string): PublicMemberProfile | null {
    const existing = db.memberIdByUser[userId];
    if (existing && db.memberProfiles[existing]) return db.memberProfiles[existing]!;
    const app = db.applications[userId];
    if (!app || !hasMemberAccess(db, userId)) return null;
    const priv = db.privateData[app.id];
    if (!priv) return null;
    const at = iso();
    const profile = createPublicProfile({
      status: app.status,
      id: createId('mem', random),
      userId,
      source: derivePublicProfileSource(priv, todayInLocalCalendar(now())),
      policy: 'first_name',
      now: at,
    });
    db.memberProfiles[profile.id] = profile;
    db.memberIdByUser[userId] = profile.id;
    const photos = Object.values(db.media)
      .filter(
        (m) =>
          m.applicationId === app.id &&
          (m.purpose ?? 'profile') === 'profile' &&
          !m.retiredAt &&
          m.order >= 0 &&
          m.moderationStatus !== 'rejected',
      )
      .sort((a, b) => a.order - b.order);
    photos.forEach((m, order) => {
      const id = createId('mmd', random);
      db.memberMedia[id] = {
        id,
        memberProfileId: profile.id,
        type: m.type,
        storageKey: m.storageKey,
        order,
        width: null,
        height: null,
        sourceApplicationMediaId: m.id,
        createdAt: at,
      };
    });
    if (profile.intents.includes('dating')) {
      const prefs = db.datingPreferences[app.id];
      db.datingSettings[profile.id] = {
        memberId: profile.id,
        gender: null,
        selfDescription: null,
        appearsAs: [],
        seeking: prefs ? seekingFromMeet(prefs.meet) : [],
        ageRange: prefs ? { ...prefs.ageRange } : null,
        setupCompletedAt: null,
        createdAt: at,
        updatedAt: at,
      };
    }
    return profile;
  }

  // --- Reads ----------------------------------------------------------------------------

  /** Age is derived from the private date of birth at read time — never stored for display. */
  function ageOf(db: MemberServerDb, profile: PublicMemberProfile): number {
    const app = db.applications[profile.userId];
    const priv = app ? db.privateData[app.id] : undefined;
    const dob = priv ? parseISODate(priv.dateOfBirth) : null;
    return dob ? ageOn(dob, todayInLocalCalendar(now())) : profile.age;
  }

  function mediaOf(db: MemberServerDb, memberId: string): MemberProfileMedia[] {
    return Object.values(db.memberMedia).filter((m) => m.memberProfileId === memberId && m.order >= 0);
  }

  function profileOf(db: MemberServerDb, memberId: string): PublicMemberProfile | null {
    const p = db.memberProfiles[memberId];
    return p && hasMemberAccess(db, p.userId) ? p : null;
  }

  const view = (db: MemberServerDb, p: PublicMemberProfile): MemberProfileView =>
    projectMemberProfile(p, mediaOf(db, p.id), ageOf(db, p));
  const card = (db: MemberServerDb, p: PublicMemberProfile): MemberCard =>
    projectMemberCard(p, mediaOf(db, p.id), ageOf(db, p));

  const usesDating = (p: PublicMemberProfile) => p.intents.includes('dating');

  function settingsOf(db: MemberServerDb, p: PublicMemberProfile): DatingSettingsRecord | null {
    return usesDating(p) ? (db.datingSettings[p.id] ?? null) : null;
  }

  function own(db: MemberServerDb, me: PublicMemberProfile): OwnMember {
    const m = db.memberships[me.userId]!;
    return {
      profile: projectOwnProfile(me, mediaOf(db, me.id), ageOf(db, me)),
      membership: { planId: m.planId, status: m.status, startedAt: m.startedAt, renewsAt: m.renewsAt, activation: m.activation ?? 'billing' },
      dating: {
        usesDating: usesDating(me),
        // Setup is complete only when identity, who to meet and an age range all exist.
        setupRequired: usesDating(me) && !participant(db, me).dating,
      },
    };
  }

  function ownDating(db: MemberServerDb, me: PublicMemberProfile): OwnDatingSettings {
    const s = settingsOf(db, me);
    return {
      usesDating: usesDating(me),
      identity: s?.gender ? { gender: s.gender, selfDescription: s.selfDescription, appearsAs: [...s.appearsAs] } : null,
      seeking: s ? [...s.seeking] : [],
      ageRange: s?.ageRange ? { ...s.ageRange } : null,
      setupCompletedAt: s?.setupCompletedAt ?? null,
    };
  }

  /** The calling member, or the membership refusal. Applicants never pass. */
  function access(db: MemberServerDb, session: Session): { me: PublicMemberProfile } | { error: ApiError } {
    const userId = ctx.userFor(db, session);
    if (!userId) return { error: { kind: 'unauthorized' } };
    if (!hasMemberAccess(db, userId)) return { error: { kind: 'membership_required' } };
    const me = provision(db, userId);
    return me ? { me } : { error: { kind: 'membership_required' } };
  }

  const blocksOf = (db: MemberServerDb) => Object.values(db.blocks);
  const blockedBetween = (db: MemberServerDb, a: string, b: string) => isBlockedBetween(blocksOf(db), a, b);

  /** The pair's ACTIVE match — at most one exists (DEC-060). */
  function activeMatchFor(db: MemberServerDb, a: string, b: string): Match | null {
    const key = pairKey(a, b);
    return Object.values(db.matches).find((m) => m.pairKey === key && m.status === 'ACTIVE') ?? null;
  }

  /** When the pair's most recent match ended (the start of their current cycle), if any. */
  function lastEndedAt(db: MemberServerDb, a: string, b: string): string | null {
    const key = pairKey(a, b);
    return Object.values(db.matches).reduce<string | null>(
      (acc, m) => (m.pairKey === key && m.endedAt && (!acc || m.endedAt > acc) ? m.endedAt : acc),
      null,
    );
  }

  function activeMatchesOf(db: MemberServerDb, memberId: string): Match[] {
    return Object.values(db.matches).filter(
      (m) =>
        m.status === 'ACTIVE' &&
        m.memberIds.includes(memberId) &&
        !blockedBetween(db, m.memberIds[0], m.memberIds[1]) &&
        profileOf(db, otherMember(m, memberId)) !== null,
    );
  }

  // --- Eligibility (the single compatibility function) ---------------------------------

  function participant(db: MemberServerDb, p: PublicMemberProfile): DatingParticipant {
    const s = settingsOf(db, p);
    return {
      memberId: p.id,
      active: hasMemberAccess(db, p.userId),
      visible: p.visibility === 'visible',
      usesDating: usesDating(p),
      age: ageOf(db, p),
      dating:
        s && s.gender && s.ageRange && s.appearsAs.length && s.seeking.length
          ? { appearsAs: s.appearsAs, seeking: s.seeking, ageRange: s.ageRange }
          : null,
    };
  }

  function introductionsState(db: MemberServerDb, me: PublicMemberProfile): IntroductionsState {
    if (!usesDating(me)) return 'NOT_USING_DATING';
    return participant(db, me).dating ? 'READY' : 'DATING_SETUP_REQUIRED';
  }

  function entriesOf(db: MemberServerDb, batchId: string): IntroductionEntry[] {
    return Object.values(db.introductionEntries)
      .filter((e) => e.batchId === batchId)
      .sort((a, b) => a.position - b.position);
  }

  function batchFor(db: MemberServerDb, me: PublicMemberProfile): IntroductionBatch {
    const date = today();
    const key = `${me.id}:${date}`;
    const existing = db.introductionBatches[key];
    if (existing) return existing;
    const viewer = participant(db, me);
    const exhausted = exhaustedCandidates({
      today: date,
      policy,
      reactions: Object.values(db.reactions)
        .filter((r) => r.fromMemberId === me.id)
        .map((r) => ({ toMemberId: r.toMemberId, type: r.type, date: dayOf(r.createdAt) })),
      matches: Object.values(db.matches)
        .filter((m) => m.memberIds.includes(me.id))
        .map((m) => ({ otherId: otherMember(m, me.id), status: m.status, endedOn: m.endedAt ? dayOf(m.endedAt) : null })),
      earlierIntroductions: Object.values(db.introductionEntries)
        .filter((e) => e.viewerId === me.id && e.date < date)
        .map((e) => ({ candidateId: e.candidateId, date: e.date })),
    });
    const blocked = blockedSet(blocksOf(db), me.id);
    const candidates = Object.values(db.memberProfiles).map((p) => participant(db, p));
    const profileIds = selectDatingIntroductions({
      viewer,
      candidates,
      pair: (id) => ({ blocked: blocked.has(id), exhausted: exhausted.has(id) }),
      size: policy.perDay,
      rank: (id) => db.curation[id] ?? 1000 + (stableRank(`${me.id}:${id}:${date}`) % 100000),
    });
    const at = iso();
    const batch: IntroductionBatch = { id: createId('int', random), memberId: me.id, date, profileIds, createdAt: at };
    db.introductionBatches[key] = batch;
    profileIds.forEach((candidateId, position) => addEntry(db, batch, candidateId, position));
    return batch;
  }

  function addEntry(db: MemberServerDb, batch: IntroductionBatch, candidateId: string, position: number): IntroductionEntry {
    const entry: IntroductionEntry = {
      id: createId('itr', random),
      batchId: batch.id,
      date: batch.date,
      viewerId: batch.memberId,
      candidateId,
      position,
      context: 'DATING',
      status: 'PENDING',
      respondedAt: null,
      createdAt: iso(),
    };
    db.introductionEntries[entry.id] = entry;
    return entry;
  }

  /** Is this introduction still valid for the pair right now (block, membership, preferences)? */
  function stillEligible(db: MemberServerDb, me: PublicMemberProfile, candidateId: string): boolean {
    const candidate = profileOf(db, candidateId);
    if (!candidate) return false;
    return datingEligibility(participant(db, me), participant(db, candidate), {
      blocked: blockedBetween(db, me.id, candidateId),
      exhausted: false,
    }).eligible;
  }

  /** Waiting entries; anyone no longer eligible is withdrawn (settings changed, block, membership). */
  function waitingEntries(db: MemberServerDb, me: PublicMemberProfile, batch: IntroductionBatch): IntroductionEntry[] {
    const out: IntroductionEntry[] = [];
    for (const e of entriesOf(db, batch.id)) {
      if (e.status !== 'PENDING') continue;
      if (!stillEligible(db, me, e.candidateId)) {
        e.status = 'WITHDRAWN';
        continue;
      }
      out.push(e);
    }
    return out;
  }

  /** May `me` see `memberId`'s profile? Introduced today (not withdrawn), or matched — never across a block. */
  function canView(db: MemberServerDb, me: PublicMemberProfile, memberId: string): PublicMemberProfile | null {
    if (memberId === me.id) return me;
    const target = profileOf(db, memberId);
    if (!target || blockedBetween(db, me.id, memberId)) return null;
    const batch = db.introductionBatches[`${me.id}:${today()}`];
    const introduced = batch
      ? entriesOf(db, batch.id).some((e) => e.candidateId === memberId && e.status !== 'WITHDRAWN')
      : false;
    const matched = activeMatchesOf(db, me.id).some((m) => m.memberIds.includes(memberId));
    return introduced || matched ? target : null;
  }

  // --- Reactions & matches (shared by the API and the fixture) --------------------------

  function react(
    db: MemberServerDb,
    me: PublicMemberProfile,
    introductionId: string,
    type: ReactionType,
  ): { ok: true; match: Match | null } | { ok: false; error: ApiError } {
    const entry = db.introductionEntries[introductionId] ?? null;
    const candidateId = entry?.candidateId ?? '';
    const existing = Object.values(db.reactions).find((r) => r.introductionId === introductionId) ?? null;
    const decision = decideReaction({
      entry,
      viewerId: me.id,
      type,
      today: today(),
      existing: existing && existing.fromMemberId === me.id ? existing.type : null,
      eligible: entry ? stillEligible(db, me, candidateId) : false,
      // Only a like given in the pair's current cycle counts (after any earlier match ended).
      likedBack: likedSince(Object.values(db.reactions), candidateId, me.id, lastEndedAt(db, me.id, candidateId)),
      activeMatch: Boolean(entry && activeMatchFor(db, me.id, candidateId)),
    });
    if (!decision.ok) {
      const kind = ({
        INTRODUCTION_NOT_FOUND: 'introduction_not_found',
        INTRODUCTION_EXPIRED: 'introduction_expired',
        NOT_ELIGIBLE: 'not_eligible',
        REACTION_ALREADY_RECORDED: 'reaction_already_recorded',
      } as const)[decision.error];
      return { ok: false, error: { kind } };
    }
    if (decision.outcome === 'REPLAY') {
      return { ok: true, match: type === 'LIKE' ? activeMatchFor(db, me.id, candidateId) : null };
    }
    const at = iso();
    const reaction: MemberReaction = {
      id: createId('rct', random),
      fromMemberId: me.id,
      toMemberId: candidateId,
      type,
      introductionId,
      batchId: entry!.batchId,
      createdAt: at,
    };
    db.reactions[reaction.id] = reaction;
    entry!.status = type === 'LIKE' ? 'LIKED' : 'PASSED';
    entry!.respondedAt = at;
    if (!decision.createsMatch) return { ok: true, match: null };
    // At most one ACTIVE match per pair (the database enforces the same with a partial unique index).
    const prior = activeMatchFor(db, me.id, candidateId);
    if (prior) return { ok: true, match: prior };
    const match: Match = {
      id: createId('mch', random),
      memberIds: sortedPair(me.id, candidateId),
      pairKey: pairKey(me.id, candidateId),
      status: 'ACTIVE',
      createdAt: at,
      endedAt: null,
      endReason: null,
    };
    db.matches[match.id] = match;
    return { ok: true, match };
  }

  function matchView(db: MemberServerDb, me: PublicMemberProfile, match: Match): MatchView | null {
    const other = profileOf(db, otherMember(match, me.id));
    if (!other) return null;
    const conversation = Object.values(db.conversations).find((c) => c.matchId === match.id) ?? null;
    return {
      matchId: match.id,
      createdAt: match.createdAt,
      self: card(db, me),
      other: card(db, other),
      conversationId: conversation?.id ?? null,
    };
  }

  function threadOf(db: MemberServerDb, me: PublicMemberProfile, conversationId: string): ThreadMessage[] {
    return Object.values(db.messages)
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ id: m.id, fromSelf: m.senderId === me.id, body: m.body, createdAt: m.createdAt }));
  }

  function conversationForMatch(db: MemberServerDb, match: Match, create: boolean): Conversation | null {
    const existing = Object.values(db.conversations).find((c) => c.matchId === match.id);
    if (existing || !create) return existing ?? null;
    const c: Conversation = {
      id: createId('cnv', random),
      matchId: match.id,
      memberIds: [...match.memberIds] as [string, string],
      createdAt: iso(),
      closedAt: null,
      openedAt: { [match.memberIds[0]]: null, [match.memberIds[1]]: null },
    };
    db.conversations[c.id] = c;
    return c;
  }

  function send(
    db: MemberServerDb,
    me: PublicMemberProfile,
    conversationId: string,
    body: string,
    clientMessageId: string,
  ): ApiResult<ThreadMessage> {
    const forbidden = () => fail({ kind: 'conversation_forbidden' });
    const c = db.conversations[conversationId];
    if (!c) return forbidden();
    const match = db.matches[c.matchId];
    const isParticipant = c.memberIds.includes(me.id);
    const other = isParticipant ? (c.memberIds[0] === me.id ? c.memberIds[1] : c.memberIds[0]) : '';
    if (
      !match ||
      !canSendMessage({
        isParticipant,
        matchActive: match.status === 'ACTIVE' && profileOf(db, other) !== null,
        conversationOpen: c.closedAt === null,
        blocked: blockedBetween(db, me.id, other),
      })
    ) {
      return forbidden();
    }
    const prior = Object.values(db.messages).find(
      (m) => m.conversationId === c.id && m.senderId === me.id && m.clientMessageId === clientMessageId,
    );
    if (prior) return ok({ id: prior.id, fromSelf: true, body: prior.body, createdAt: prior.createdAt });
    const v = validateMessage(body);
    if (!v.ok) return fail({ kind: 'validation', fields: [v.error] });
    const at = iso();
    const message: Message = { id: createId('msg', random), conversationId: c.id, senderId: me.id, body: v.value, clientMessageId, createdAt: at };
    db.messages[message.id] = message;
    c.openedAt[me.id] = at;
    return ok({ id: message.id, fromSelf: true, body: message.body, createdAt: at });
  }

  /**
   * Block: silent and total. The match ends and its conversation closes;
   * nobody is notified; records are kept. Allowed for anyone the member can
   * currently see (or has already blocked).
   */
  function block(db: MemberServerDb, me: PublicMemberProfile, memberId: string): boolean {
    if (memberId === me.id || !db.memberProfiles[memberId]) return false;
    if (Object.values(db.blocks).some((b) => b.blockerId === me.id && b.blockedId === memberId)) return true;
    if (!blockedBetween(db, me.id, memberId) && !canView(db, me, memberId)) return false;
    const at = iso();
    const record: Block = { id: createId('blk', random), blockerId: me.id, blockedId: memberId, createdAt: at };
    db.blocks[record.id] = record;
    // The active match (if any) becomes BLOCKED — kept as history, never active again while the block exists.
    const match = activeMatchFor(db, me.id, memberId);
    if (match) {
      match.status = endedStatus('BLOCK');
      match.endedAt = at;
      match.endReason = 'BLOCK';
    }
    for (const c of Object.values(db.conversations)) if (match && c.matchId === match.id) c.closedAt ??= at;
    return true;
  }

  // --- API --------------------------------------------------------------------------------

  const api: MemberApi = {
    getMe: (session) =>
      op('getMe', (db) => {
        const a = access(db, session);
        return 'error' in a ? fail(a.error) : ok(own(db, a.me));
      }),

    confirmProfile: (session) =>
      op('confirmProfile', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        a.me.confirmedAt ??= iso();
        a.me.updatedAt = iso();
        return ok(own(db, a.me));
      }),

    updateProfile: (session, patch) =>
      op('updateProfile', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const { me } = a;
        const photos = mediaOf(db, me.id);
        const v = validateMemberProfilePatch(patch ?? {}, { photoIds: photos.map((m) => m.id) });
        if (!v.ok) return fail({ kind: 'validation', fields: v.fields });
        const p = v.value;
        // Only the member profile changes. Application records are untouched.
        if (p.occupation !== undefined) me.occupation = p.occupation;
        if (p.cityLabel !== undefined) me.cityLabel = p.cityLabel;
        if (p.knownFor !== undefined) me.knownFor = p.knownFor;
        if (p.interests !== undefined) me.interests = [...p.interests];
        if (p.photoOrder !== undefined) {
          for (const m of photos) m.order = p.photoOrder.indexOf(m.id); // -1 = removed from the profile
        }
        me.updatedAt = iso();
        return ok(own(db, me));
      }),

    addProfilePhoto: (session, photo) =>
      op('addProfilePhoto', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const photos = mediaOf(db, a.me.id);
        if (photos.length >= PHOTO_MAX) return fail({ kind: 'validation', fields: ['photos'] });
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(photo.dataUri) || photo.dataUri.length > MAX_UPLOAD_CHARS) {
          return fail({ kind: 'validation', fields: ['photo'] });
        }
        const id = createId('mmd', random);
        db.memberMedia[id] = {
          id,
          memberProfileId: a.me.id,
          type: 'photo',
          storageKey: photo.dataUri,
          order: photos.length,
          width: photo.width,
          height: photo.height,
          sourceApplicationMediaId: null,
          createdAt: iso(),
        };
        a.me.updatedAt = iso();
        return ok(own(db, a.me));
      }),

    getDatingSettings: (session) =>
      op('getDatingSettings', (db) => {
        const a = access(db, session);
        return 'error' in a ? fail(a.error) : ok(ownDating(db, a.me));
      }),

    saveDatingSettings: (session, input) =>
      op('saveDatingSettings', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const { me } = a;
        if (!usesDating(me)) return fail({ kind: 'not_allowed' });
        const v = validateDatingSettingsInput(input);
        if (!v.ok) return fail({ kind: 'validation', fields: v.fields });
        const at = iso();
        const prev = db.datingSettings[me.id];
        db.datingSettings[me.id] = {
          memberId: me.id,
          gender: v.value.identity.gender,
          selfDescription: v.value.identity.selfDescription,
          appearsAs: [...v.value.identity.appearsAs],
          seeking: [...v.value.seeking],
          ageRange: { ...v.value.ageRange },
          setupCompletedAt: at,
          createdAt: prev?.createdAt ?? at,
          updatedAt: at,
        };
        // Existing matches and conversations are kept; future introductions follow the new settings.
        return ok(ownDating(db, me));
      }),

    getIntroductions: (session) =>
      op('getIntroductions', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const { me } = a;
        const state = introductionsState(db, me);
        if (state !== 'READY') {
          return ok<IntroductionsView>({ state, batchId: null, date: today(), waiting: [], hadIntroductions: false });
        }
        const batch = batchFor(db, me);
        const waiting: IntroductionDTO[] = waitingEntries(db, me, batch).map((e) => ({
          introductionId: e.id,
          context: e.context,
          member: view(db, profileOf(db, e.candidateId)!),
        }));
        return ok<IntroductionsView>({
          state,
          batchId: batch.id,
          date: batch.date,
          waiting,
          hadIntroductions: batch.profileIds.length > 0,
        });
      }),

    getMemberProfile: (session, memberId) =>
      op('getMemberProfile', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const target = canView(db, a.me, memberId);
        return target ? ok(view(db, target)) : fail({ kind: 'not_available' });
      }),

    react: (session, introductionId, type) =>
      op('react', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        if (!isReactionType(type)) return fail({ kind: 'validation', fields: ['type'] });
        const res = react(db, a.me, introductionId, type);
        if (!res.ok) return fail(res.error);
        return ok({ type, match: res.match ? matchView(db, a.me, res.match) : null });
      }),

    getMatch: (session, matchId) =>
      op('getMatch', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const match = activeMatchesOf(db, a.me.id).find((m) => m.id === matchId);
        const v = match ? matchView(db, a.me, match) : null;
        return v ? ok(v) : fail({ kind: 'match_not_found' });
      }),

    listConversations: (session) =>
      op('listConversations', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const { me } = a;
        const out: ConversationSummary[] = [];
        for (const match of activeMatchesOf(db, me.id)) {
          const other = profileOf(db, otherMember(match, me.id))!;
          const c = conversationForMatch(db, match, false);
          const thread = c ? threadOf(db, me, c.id) : [];
          const last = thread[thread.length - 1] ?? null;
          const openedAt = c?.openedAt[me.id] ?? null;
          const unread = openedAt === null ? true : Boolean(last && !last.fromSelf && last.createdAt > openedAt);
          out.push({
            matchId: match.id,
            conversationId: c?.id ?? null,
            other: card(db, other),
            matchedAt: match.createdAt,
            lastMessage: last ? { body: last.body, fromSelf: last.fromSelf, createdAt: last.createdAt } : null,
            unread,
          });
        }
        out.sort((x, y) => (y.lastMessage?.createdAt ?? y.matchedAt).localeCompare(x.lastMessage?.createdAt ?? x.matchedAt));
        return ok(out);
      }),

    openConversation: (session, matchId) =>
      op('openConversation', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const { me } = a;
        // Only matched members can open a conversation.
        const match = activeMatchesOf(db, me.id).find((m) => m.id === matchId);
        if (!match) return fail({ kind: 'match_not_found' });
        const c = conversationForMatch(db, match, true)!;
        if (c.closedAt) return fail({ kind: 'match_not_found' });
        c.openedAt[me.id] = iso();
        const other = profileOf(db, otherMember(match, me.id))!;
        const result: ConversationView = {
          conversationId: c.id,
          matchId: match.id,
          matchedAt: match.createdAt,
          other: card(db, other),
          messages: threadOf(db, me, c.id),
        };
        return ok(result);
      }),

    sendMessage: (session, conversationId, body, clientMessageId) =>
      op('sendMessage', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        return send(db, a.me, conversationId, body, clientMessageId);
      }),

    blockMember: (session, memberId) =>
      op('blockMember', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        return block(db, a.me, memberId) ? ok({ blocked: true as const }) : fail({ kind: 'not_available' });
      }),

    reportMember: (session, memberId, report) =>
      op('reportMember', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        const { me } = a;
        if (!isReportReason(report?.reason) || (report.context !== 'profile' && report.context !== 'conversation')) {
          return fail({ kind: 'validation', fields: ['reason'] });
        }
        const iBlocked = Object.values(db.blocks).some((b) => b.blockerId === me.id && b.blockedId === memberId);
        if (memberId === me.id || !db.memberProfiles[memberId] || (!iBlocked && !canView(db, me, memberId))) {
          return fail({ kind: 'not_available' });
        }
        const r: Report = {
          id: createId('rpt', random),
          reporterId: me.id,
          reportedId: memberId,
          reason: report.reason,
          context: report.context,
          conversationId: report.conversationId ?? null,
          status: 'open',
          createdAt: iso(),
        };
        db.reports[r.id] = r;
        return ok({ reported: true as const });
      }),

    listBlocked: (session) =>
      op('listBlocked', (db) => {
        const a = access(db, session);
        if ('error' in a) return fail(a.error);
        return ok(
          Object.values(db.blocks)
            .filter((b) => b.blockerId === a.me.id)
            .map((b) => ({
              memberId: b.blockedId,
              displayName: db.memberProfiles[b.blockedId]?.displayName ?? '',
              blockedAt: b.createdAt,
            })),
        );
      }),
  };

  /**
   * Development fixture (community seeding, fixture member behaviour). Uses the
   * same provisioning, eligibility, reaction, messaging and block functions as
   * the API — no shortcuts. Removed from release bundles: the condition is a
   * build-time constant, and the fixture data module is only reachable from here.
   */
  function createMemberDevFixture() {
    // Build-time constant: in release builds this folds to `null` before Metro
    // collects dependencies, so the fixture module is never bundled.
    const loadFixture = (): typeof import('@/dev/communityFixture') => {
      const fixture =
        process.env.EXPO_PUBLIC_APP_ENV === 'production'
          ? null
          : // eslint-disable-next-line @typescript-eslint/no-require-imports
            (require('@/dev/communityFixture') as typeof import('@/dev/communityFixture'));
      if (!fixture) throw new Error('Development controls are not available in release builds.');
      return fixture;
    };

    function fixtureMember(db: MemberServerDb, key: string): PublicMemberProfile {
      const p = provision(db, `usr_fx_${key}`);
      if (!p) throw new Error(`Fixture member not seeded: ${key}`);
      return p;
    }

    /** The fixture member's introduction to `target` today (made only if the pair is eligible, unless forced). */
    function introduce(db: MemberServerDb, me: PublicMemberProfile, target: PublicMemberProfile, force: boolean) {
      const batch = batchFor(db, me);
      const existing = entriesOf(db, batch.id).find((e) => e.candidateId === target.id);
      if (existing) return existing;
      if (!force && !stillEligible(db, me, target.id)) return null;
      batch.profileIds.push(target.id);
      return addEntry(db, batch, target.id, batch.profileIds.length - 1);
    }

    return {
      /**
       * Seed the fixture community as existing members (account, approved
       * application, active membership, normal provisioning, completed Dating
       * setup where they date). `media` maps fixture keys to photo URIs
       * supplied by the test harness. With `admirerOf`, the admirer fixture
       * likes that user through the real introduction and reaction path — only
       * if the pair is eligible — so liking back creates a real match.
       */
      async seedCommunity(input: { media?: Record<string, string[]>; admirerOf?: string } = {}) {
        const { COMMUNITY_FIXTURE } = loadFixture();
        return ctx.transact((db) => {
          const at = iso();
          for (const f of COMMUNITY_FIXTURE) {
            const userId = `usr_fx_${f.key}`;
            if (db.accounts[userId]) continue;
            const appId = `app_fx_${f.key}`;
            db.accounts[userId] = {
              id: userId,
              phoneE164: `+90500000${String(f.curation).padStart(4, '0')}`,
              phoneVerifiedAt: at,
              createdAt: at,
              updatedAt: at,
              accountStatus: 'active',
            };
            db.applications[userId] = {
              id: appId,
              userId,
              status: 'ACTIVE_MEMBER',
              stage1CompletedAt: at,
              submittedAt: at,
              reviewStartedAt: at,
              extendedRequestedAt: at,
              extendedSubmittedAt: at,
              finalReviewStartedAt: at,
              decisionAt: at,
              moreInformationRequestedAt: null,
              moreInformationReturnTo: null,
              informationProvidedAt: null,
              reopenedAt: null,
              createdAt: at,
              updatedAt: at,
            };
            db.privateData[appId] = {
              applicationId: appId,
              firstName: f.firstName,
              lastName: f.lastName,
              dateOfBirth: f.dateOfBirth,
              instagram: { kind: 'handle', handle: `${f.key}.fixture` },
              countryCode: f.countryCode,
              city: { kind: 'other', label: f.city },
              referral: { kind: 'none' },
              occupation: f.occupation,
              workContext: null,
              workContextAnswer: null,
              workDescription: f.knownFor,
              personalResponse: null,
              interests: [...f.interests],
              intents: [...f.intents] as Intent[],
              education: null,
              websiteUrl: null,
              portfolioUrl: null,
              createdAt: at,
              updatedAt: at,
            };
            db.memberships[userId] = {
              id: `mbr_fx_${f.key}`,
              userId,
              planId: 'plan_membership_monthly_dev',
              status: 'active',
              startedAt: at,
              renewsAt: null,
              endsAt: null,
              activation: 'billing',
              createdAt: at,
              updatedAt: at,
            };
            (input.media?.[f.key] ?? []).forEach((uri, order) => {
              const id = `med_fx_${f.key}_${order}`;
              db.media[id] = {
                id,
                applicationId: appId,
                type: 'photo',
                purpose: 'profile',
                storageKey: uri,
                order,
                moderationStatus: 'approved',
                requestId: null,
                retiredAt: null,
                createdAt: at,
              };
            });
            const profile = provision(db, userId);
            if (!profile) continue;
            db.curation[profile.id] = f.curation;
            if (f.dating) {
              const v = validateDatingSettingsInput(f.dating);
              if (!v.ok) throw new Error(`Invalid fixture dating settings: ${f.key}`);
              db.datingSettings[profile.id] = {
                memberId: profile.id,
                gender: v.value.identity.gender,
                selfDescription: v.value.identity.selfDescription,
                appearsAs: v.value.identity.appearsAs,
                seeking: v.value.seeking,
                ageRange: v.value.ageRange,
                setupCompletedAt: at,
                createdAt: at,
                updatedAt: at,
              };
            }
          }

          let admirerLiked = false;
          if (input.admirerOf) {
            const target = provision(db, input.admirerOf);
            const admirer = COMMUNITY_FIXTURE.find((f) => f.admirer);
            if (target && admirer) {
              const me = fixtureMember(db, admirer.key);
              const entry = introduce(db, me, target, false);
              if (entry) admirerLiked = react(db, me, entry.id, 'LIKE').ok;
            }
          }
          return { members: Object.keys(db.memberProfiles).length, admirerLiked };
        });
      },

      /** A fixture member writes in an existing conversation with a user (same rules as the API). */
      async memberSays(key: string, toUserId: string, body: string) {
        return ctx.transact((db) => {
          const me = fixtureMember(db, key);
          const other = db.memberIdByUser[toUserId];
          const match = other ? activeMatchesOf(db, me.id).find((m) => m.memberIds.includes(other)) : undefined;
          if (!match) throw new Error('No active match with that member');
          const c = conversationForMatch(db, match, true)!;
          const res = send(db, me, c.id, body, createId('fxm', random));
          if (!res.ok) throw new Error(`Message refused: ${res.error.kind}`);
          return res.value;
        });
      },

      /** A fixture member blocks a user (to test the blocked side) — the same block path as the API. */
      async memberBlocks(key: string, userId: string) {
        return ctx.transact((db) => {
          const me = fixtureMember(db, key);
          const targetId = db.memberIdByUser[userId];
          const target = targetId ? db.memberProfiles[targetId] : undefined;
          if (!target) throw new Error('No member profile for user');
          // Blocking needs the target to be visible to the fixture member: a curated introduction.
          introduce(db, me, target, true);
          if (!block(db, me, target.id)) throw new Error('Block refused');
        });
      },
    };
  }

  type MemberDevFixture = ReturnType<typeof createMemberDevFixture>;
  const dev: MemberDevFixture =
    process.env.EXPO_PUBLIC_APP_ENV === 'production'
      ? (new Proxy({} as MemberDevFixture, {
          get() {
            throw new Error('Development controls are not available in release builds.');
          },
        }) as MemberDevFixture)
      : createMemberDevFixture();

  return { api, provision, dev };
}
