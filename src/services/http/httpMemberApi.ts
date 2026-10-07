/** MemberApi over HTTP — the same port the mock implements (src/services/api/memberTypes.ts). */
import { ROUTES } from '../api/contract';
import type { MemberApi } from '../api/memberTypes';
import { directUpload } from './directUpload';
import type { HttpClient } from './httpClient';

export function createHttpMemberApi(call: HttpClient): MemberApi {
  return {
    getMe: (session) => call(ROUTES.me, { session }),
    confirmProfile: (session) => call(ROUTES.confirmProfile, { session }),
    updateProfile: (session, patch) => call(ROUTES.updateProfile, { session, body: patch }),
    async addProfilePhoto(session, photo) {
      const done = await directUpload(call, session, photo, { mediaClass: 'PROFILE_MEDIA' });
      if (!done.ok) return done;
      return done.value.member ? { ok: true, value: done.value.member } : { ok: false, error: { kind: 'server' } };
    },
    getDatingSettings: (session) => call(ROUTES.datingSettings, { session }),
    saveDatingSettings: (session, input) => call(ROUTES.saveDatingSettings, { session, body: input }),
    getIntroductions: (session) => call(ROUTES.introductionsToday, { session }),
    getMemberProfile: (session, memberId) => call(ROUTES.member(memberId), { session }),
    react: (session, introductionId, type) => call(ROUTES.react(introductionId), { session, body: { type } }),
    getMatch: (session, matchId) => call(ROUTES.match(matchId), { session }),
    listConversations: (session) => call(ROUTES.conversations, { session }),
    openConversation: (session, matchId) => call(ROUTES.openConversation(matchId), { session }),
    sendMessage: (session, conversationId, body, clientMessageId) =>
      call(ROUTES.sendMessage(conversationId), { session, body: { body, clientMessageId } }),
    blockMember: (session, memberId) => call(ROUTES.block(memberId), { session }),
    reportMember: (session, memberId, report) => call(ROUTES.report(memberId), { session, body: report }),
    listBlocked: (session) => call(ROUTES.blocked, { session }),
  };
}
