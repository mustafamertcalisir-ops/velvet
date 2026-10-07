/** AdmissionApi over HTTP — the same port the mock implements (src/services/api/types.ts). */
import { ROUTES } from '../api/contract';
import type { AdmissionApi } from '../api/types';
import { directUpload } from './directUpload';
import type { HttpClient } from './httpClient';

export function createHttpAdmissionApi(call: HttpClient): AdmissionApi {
  return {
    requestOtp: (phoneE164) => call(ROUTES.requestOtp, { body: { phoneE164 } }),
    verifyOtp: (challengeId, code) => call(ROUTES.verifyOtp, { body: { challengeId, code } }),
    async signOut(session) {
      const r = await call<{ signedOut: true }>(ROUTES.signOut, { session });
      return r.ok ? { ok: true, value: undefined } : r;
    },
    // The server requires an explicit confirmation flag: a deletion is never a side effect of another call.
    requestAccountDeletion: (session) => call(ROUTES.requestAccountDeletion, { session, body: { confirm: true } }),
    submitStage1: (session, idempotencyKey, submission) => call(ROUTES.submitStage1, { session, idempotencyKey, body: submission }),
    getMyApplication: (session) => call(ROUTES.myApplication, { session }),
    startExtendedApplication: (session) => call(ROUTES.startExtended, { session }),
    async uploadApplicationPhoto(session, photo, options) {
      const done = await directUpload(call, session, photo, {
        mediaClass: options?.mediaClass ?? 'APPLICATION_MEDIA',
        requestId: options?.requestId ?? null,
      });
      if (!done.ok) return done;
      return done.value.applicationMedia ? { ok: true, value: done.value.applicationMedia } : { ok: false, error: { kind: 'server' } };
    },
    submitStage2: (session, idempotencyKey, submission) => call(ROUTES.submitStage2, { session, idempotencyKey, body: submission }),
    respondToInformationRequest: (session, requestId, response) => call(ROUTES.respondToRequest(requestId), { session, body: response }),
    submitInformationUpdate: (session, idempotencyKey) => call(ROUTES.submitInformationUpdate, { session, idempotencyKey }),
    beginMembership: (session) => call(ROUTES.beginMembership, { session }),
    getMembershipPlans: (session) => call(ROUTES.membershipPlans, { session }),
  };
}
