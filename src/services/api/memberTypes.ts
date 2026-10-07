/**
 * Member API port — the member product's server boundary, separate from the
 * admission API. Every call requires an ACTIVE_MEMBER with a live membership
 * (canAccessMemberProduct); applicants at any stage get `membership_required`.
 *
 * Implemented by the mock server (local development, deterministic E2E) and
 * the HTTP adapter for the production API (docs/API_CONTRACT.md). Responses
 * are projections (src/domain/member/views.ts): other members are identified
 * only by member profile id, and nothing private crosses this boundary —
 * no other member's Dating identity or preferences, ever (DEC-058).
 * "Unavailable" is one uniform refusal (`not_available` / `match_not_found`)
 * whether a member does not exist, blocked someone, or was never introduced —
 * so a block can't be detected and members can't be enumerated.
 */
import type { AgeRange } from '@/domain/admission/stage2';
import type { DatingGenderPreference, DatingIdentity, DatingSettingsInput } from '@/domain/member/dating';
import type { IntroductionContext } from '@/domain/member/introductions';
import type { ReportContext, ReportReason } from '@/domain/member/safety';
import type { ReactionType } from '@/domain/member/matching';
import type { ThreadMessage } from '@/domain/member/conversation';
import type {
  MemberCard,
  MemberProfilePatch,
  MemberProfileView,
  OwnMemberProfile,
} from '@/domain/member/views';
import type { ISODate, ISODateTime, Membership } from '@/domain/models';
import type { ApiResult, Session } from './types';

export type OwnMember = {
  profile: OwnMemberProfile;
  membership: Pick<Membership, 'planId' | 'status' | 'startedAt' | 'renewsAt' | 'activation'>;
  /** The member's own Dating status — never sent about anyone else. */
  dating: { usesDating: boolean; setupRequired: boolean };
};

/** The member's own private matching record (never part of any other response). */
export type OwnDatingSettings = {
  usesDating: boolean;
  identity: DatingIdentity | null;
  seeking: DatingGenderPreference[];
  ageRange: AgeRange | null;
  setupCompletedAt: string | null;
};

/** One introduction — the unit a reaction answers. */
export type IntroductionDTO = {
  introductionId: string;
  context: IntroductionContext;
  member: MemberProfileView;
};

export type IntroductionsState =
  /** Today's introductions (possibly all answered). */
  | 'READY'
  /** A Dating member who hasn't completed Dating setup gets no introductions yet. */
  | 'DATING_SETUP_REQUIRED'
  /** Introductions are currently for members open to dating (DEC-058). */
  | 'NOT_USING_DATING';

export type IntroductionsView = {
  state: IntroductionsState;
  batchId: string | null;
  date: ISODate;
  /** Introductions still waiting today, in curated order. Never refilled. */
  waiting: IntroductionDTO[];
  /** Whether today's batch had anyone at all (distinguishes "done for today" from "no one today"). */
  hadIntroductions: boolean;
};

export type MatchView = {
  matchId: string;
  createdAt: ISODateTime;
  self: MemberCard;
  other: MemberCard;
  conversationId: string | null;
};

export type ReactionResult = {
  type: ReactionType;
  /** Present only when the server created a mutual match. */
  match: MatchView | null;
};

export type ConversationSummary = {
  matchId: string;
  conversationId: string | null;
  other: MemberCard;
  matchedAt: ISODateTime;
  lastMessage: { body: string; fromSelf: boolean; createdAt: ISODateTime } | null;
  /** Something new since the member last opened it (a new match, or a reply). */
  unread: boolean;
};

export type ConversationView = {
  conversationId: string;
  matchId: string;
  matchedAt: ISODateTime;
  other: MemberCard;
  messages: ThreadMessage[];
};

export type BlockedMember = { memberId: string; displayName: string; blockedAt: ISODateTime };

export interface MemberApi {
  /** Own profile (provisioned from the approved application at activation) and membership. */
  getMe(session: Session): Promise<ApiResult<OwnMember>>;
  /** Profile confirmation after activation. Idempotent. */
  confirmProfile(session: Session): Promise<ApiResult<OwnMember>>;
  /** Edit public profile fields only. */
  updateProfile(session: Session, patch: MemberProfilePatch): Promise<ApiResult<OwnMember>>;
  addProfilePhoto(session: Session, photo: { dataUri: string; width: number; height: number }): Promise<ApiResult<OwnMember>>;

  /** Own private Dating settings. */
  getDatingSettings(session: Session): Promise<ApiResult<OwnDatingSettings>>;
  /** Dating setup and later edits. Affects future introductions only. */
  saveDatingSettings(session: Session, input: DatingSettingsInput): Promise<ApiResult<OwnDatingSettings>>;

  /** Today's introductions for the authenticated member — only eligible members, never a directory. */
  getIntroductions(session: Session): Promise<ApiResult<IntroductionsView>>;
  /** Only someone introduced to you, or matched with you. */
  getMemberProfile(session: Session, memberId: string): Promise<ApiResult<MemberProfileView>>;
  /** Idempotent: repeating the same reaction to the same introduction replays its result. */
  react(session: Session, introductionId: string, type: ReactionType): Promise<ApiResult<ReactionResult>>;
  getMatch(session: Session, matchId: string): Promise<ApiResult<MatchView>>;

  listConversations(session: Session): Promise<ApiResult<ConversationSummary[]>>;
  /** Opens (creating if needed) the conversation of an active match. Marks it opened. */
  openConversation(session: Session, matchId: string): Promise<ApiResult<ConversationView>>;
  sendMessage(
    session: Session,
    conversationId: string,
    body: string,
    clientMessageId: string,
  ): Promise<ApiResult<ThreadMessage>>;

  blockMember(session: Session, memberId: string): Promise<ApiResult<{ blocked: true }>>;
  reportMember(
    session: Session,
    memberId: string,
    report: { reason: ReportReason; context: ReportContext; conversationId?: string | null },
  ): Promise<ApiResult<{ reported: true }>>;
  listBlocked(session: Session): Promise<ApiResult<BlockedMember[]>>;
}
