/**
 * Member client state — in memory only (DEC-055).
 *
 * Other members' profiles, introductions and messages are never written to
 * device storage: they are fetched for the session and dropped on sign-out or
 * when the app process ends. The server is the authority for everything here —
 * the client never decides a match, a batch or who can be seen; it asks and
 * renders the answer.
 */
import type { ReactionType } from '@/domain/member/matching';
import type { ReportContext, ReportReason } from '@/domain/member/safety';
import type { ThreadMessage } from '@/domain/member/conversation';
import type { DatingSettingsInput } from '@/domain/member/dating';
import type { MemberProfilePatch, MemberProfileView } from '@/domain/member/views';
import { createId } from '@/lib/id';
import type {
  BlockedMember,
  ConversationSummary,
  ConversationView,
  IntroductionsView,
  MatchView,
  MemberApi,
  OwnDatingSettings,
  OwnMember,
  ReactionResult,
} from '@/services/api/memberTypes';
import type { ApiError, ApiResult, Session } from '@/services/api/types';

export type MemberState = {
  me: OwnMember | null;
  introductions: IntroductionsView | null;
  conversations: ConversationSummary[] | null;
  /** Profiles seen this session (introductions, matches) — memory only, for instant transitions. */
  profiles: Record<string, MemberProfileView>;
};

const initial = (): MemberState => ({ me: null, introductions: null, conversations: null, profiles: {} });

export type MemberResult<T> = ApiResult<T>;

export function createMemberStore({
  api,
  getSession,
  onUnauthorized,
}: {
  api: MemberApi;
  getSession: () => Session | null;
  /** The session is no longer valid (sign out); membership access lost (re-check lifecycle). */
  onUnauthorized: (kind: 'unauthorized' | 'membership_required') => void;
}) {
  let state = initial();
  const listeners = new Set<() => void>();

  function set(patch: Partial<MemberState>) {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  }

  const noSession = (): ApiResult<never> => ({ ok: false, error: { kind: 'unauthorized' } });

  /** Run a member call with the current session; surface lost sessions once. */
  async function call<T>(fn: (s: Session) => Promise<ApiResult<T>>, accessCheck = false): Promise<ApiResult<T>> {
    const session = getSession();
    if (!session) return noSession();
    const res = await fn(session);
    if (!res.ok && res.error.kind === 'unauthorized') onUnauthorized('unauthorized');
    else if (!res.ok && accessCheck && res.error.kind === 'membership_required') onUnauthorized('membership_required');
    return res;
  }

  function remember(views: readonly MemberProfileView[]) {
    if (!views.length) return;
    const profiles = { ...state.profiles };
    for (const v of views) profiles[v.memberId] = v;
    set({ profiles });
  }

  function forget(memberId: string) {
    const profiles = { ...state.profiles };
    delete profiles[memberId];
    set({
      profiles,
      introductions: state.introductions
        ? { ...state.introductions, waiting: state.introductions.waiting.filter((v) => v.member.memberId !== memberId) }
        : null,
      conversations: state.conversations?.filter((c) => c.other.memberId !== memberId) ?? null,
    });
  }

  const actions = {
    async loadMe(): Promise<ApiResult<OwnMember>> {
      const res = await call((s) => api.getMe(s), true);
      if (res.ok) set({ me: res.value });
      return res;
    },

    async confirmProfile(): Promise<ApiResult<OwnMember>> {
      const res = await call((s) => api.confirmProfile(s));
      if (res.ok) set({ me: res.value });
      return res;
    },

    async updateProfile(patch: MemberProfilePatch): Promise<ApiResult<OwnMember>> {
      const res = await call((s) => api.updateProfile(s, patch));
      if (res.ok) set({ me: res.value });
      return res;
    },

    async addProfilePhoto(photo: { dataUri: string; width: number; height: number }): Promise<ApiResult<OwnMember>> {
      const res = await call((s) => api.addProfilePhoto(s, photo));
      if (res.ok) set({ me: res.value });
      return res;
    },

    async loadIntroductions(): Promise<ApiResult<IntroductionsView>> {
      const res = await call((s) => api.getIntroductions(s), true);
      if (res.ok) {
        set({ introductions: res.value });
        remember(res.value.waiting.map((w) => w.member));
      }
      return res;
    },

    async loadProfile(memberId: string): Promise<ApiResult<MemberProfileView>> {
      const res = await call((s) => api.getMemberProfile(s, memberId));
      if (res.ok) remember([res.value]);
      else if (res.error.kind === 'not_available') forget(memberId);
      return res;
    },

    /**
     * Pass or like one introduction. The server answers with the outcome — a
     * match only if it created one. Repeating the same answer (a double tap,
     * a retry) replays the same result. The introduction leaves today's set.
     */
    async react(introductionId: string, type: ReactionType): Promise<ApiResult<ReactionResult>> {
      const res = await call((s) => api.react(s, introductionId, type));
      const gone =
        res.ok ||
        ['not_eligible', 'introduction_expired', 'introduction_not_found', 'reaction_already_recorded'].includes(res.error.kind);
      if (gone) {
        set({
          introductions: state.introductions
            ? { ...state.introductions, waiting: state.introductions.waiting.filter((w) => w.introductionId !== introductionId) }
            : null,
        });
      }
      if (res.ok && res.value.match) set({ conversations: null });
      return res;
    },

    loadDatingSettings(): Promise<ApiResult<OwnDatingSettings>> {
      return call((s) => api.getDatingSettings(s));
    },

    /** Dating setup / preferences. Today's introductions are re-read: the server re-checks eligibility. */
    async saveDatingSettings(input: DatingSettingsInput): Promise<ApiResult<OwnDatingSettings>> {
      const res = await call((s) => api.saveDatingSettings(s, input));
      if (res.ok) {
        set({ introductions: null });
        await actions.loadMe();
      }
      return res;
    },

    loadMatch(matchId: string): Promise<ApiResult<MatchView>> {
      return call((s) => api.getMatch(s, matchId));
    },

    async loadConversations(): Promise<ApiResult<ConversationSummary[]>> {
      const res = await call((s) => api.listConversations(s), true);
      if (res.ok) set({ conversations: res.value });
      return res;
    },

    async openConversation(matchId: string): Promise<ApiResult<ConversationView>> {
      const res = await call((s) => api.openConversation(s, matchId));
      if (res.ok && state.conversations) {
        set({
          conversations: state.conversations.map((c) =>
            c.matchId === matchId ? { ...c, conversationId: res.value.conversationId, unread: false } : c,
          ),
        });
      }
      return res;
    },

    /** A stable id per outgoing message, so a retried send never duplicates it. */
    newMessageId: () => createId('cm'),

    sendMessage(conversationId: string, body: string, clientMessageId: string): Promise<ApiResult<ThreadMessage>> {
      return call((s) => api.sendMessage(s, conversationId, body, clientMessageId));
    },

    async block(memberId: string): Promise<ApiResult<{ blocked: true }>> {
      const res = await call((s) => api.blockMember(s, memberId));
      if (res.ok) forget(memberId);
      return res;
    },

    report(
      memberId: string,
      report: { reason: ReportReason; context: ReportContext; conversationId?: string | null },
    ): Promise<ApiResult<{ reported: true }>> {
      return call((s) => api.reportMember(s, memberId, report));
    },

    listBlocked(): Promise<ApiResult<BlockedMember[]>> {
      return call((s) => api.listBlocked(s));
    },

    reset() {
      state = initial();
      listeners.forEach((l) => l());
    },
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
  };
}

export type MemberStore = ReturnType<typeof createMemberStore>;
export type MemberActions = MemberStore['actions'];
export type { ApiError };
