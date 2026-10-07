/**
 * Mock admission backend — development only.
 *
 * Behaves like a real server would: it persists accounts and applications (in
 * device storage, under its own namespace), re-validates every submission
 * server-side, enforces OTP limits, and is idempotent.
 *
 * It NEVER lets the applicant's device decide admission. Review states change
 * only through the reviewer endpoint (`reviewer.apply`), which plans every
 * action with the shared domain rules (src/domain/admission/review.ts),
 * validates the transition, and writes a structured audit event. The
 * development fixture (`dev`) calls that same endpoint — it has no shortcut.
 */
import type { AuditEvent, AuditEventType, ActorType, InternalDecisionReason } from '@/domain/admission/audit';
import {
  isReviewReturnStage,
  resolveRequestDrafts,
  validateResponse,
  type ApplicantInformationRequest,
  type InformationRequest,
  type InformationResponse,
} from '@/domain/admission/informationRequests';
import { planReviewerAction, type ReviewerAction } from '@/domain/admission/review';
import { normalizeMatch } from '@/domain/member/matching';
import { validateStage1Submission, validateStage2Submission } from '@/domain/admission/submissions';
import { transition, type ApplicationStatus } from '@/domain/admission/status';
import type { MembershipPlan } from '@/domain/membership/plan';
import type {
  ApplicantSummary,
  ApplicationMedia,
  ApplicationReviewRecord,
  DatingPreferencesRecord,
  Membership,
  MembershipApplication,
  PrivateApplicationData,
  UserAccount,
} from '@/domain/models';
import { PHOTO_MAX } from '@/domain/admission/stage2';
import { ageOn, parseISODate, todayInLocalCalendar } from '@/domain/validation/dateOfBirth';
import { createId } from '@/lib/id';
import type { KeyValueStorage } from '../storage';
import { createMockMemberApi, emptyMemberTables, type MemberOperation, type MemberTables } from './mockMemberApi';
import type { AdmissionApi, ApiError, ApiResult, MyApplication, OtpChallenge, Session } from '../api/types';

export const MOCK_OTP_CODE = '246810';
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_REQUESTS_PER_HOUR = 5;

const SERVER_KEY = 'velvet.mockServer.v1';

type ChallengeRecord = OtpChallenge & { attempts: number; consumed: boolean };

/**
 * Pricing is not finalised (DEC-047): the server offers one development
 * fixture plan, flagged as such, so no interface presents it as a decision.
 */
export const DEVELOPMENT_MEMBERSHIP_PLAN: MembershipPlan = {
  id: 'plan_membership_monthly_dev',
  name: 'Membership',
  billingPeriod: 'monthly',
  priceMinor: 250_000,
  currency: 'TRY',
  isDevelopmentFixture: true,
};

/** One server database: admission tables + member tables (src/services/mock/mockMemberApi.ts). */
type ServerDb = MemberTables & {
  accounts: Record<string, UserAccount>; // by userId
  userIdByPhone: Record<string, string>;
  sessions: Record<string, string>; // token -> userId
  challenges: Record<string, ChallengeRecord>;
  otpRequests: Record<string, string[]>; // phone -> ISO timestamps
  applications: Record<string, MembershipApplication>; // by userId
  privateData: Record<string, PrivateApplicationData>; // by applicationId
  idempotency: Record<string, string>; // key -> applicationId
  referralRequests: { applicationId: string; name: string; phoneE164: string; requestedAt: string }[];
  memberships: Record<string, Membership>; // by userId
  media: Record<string, ApplicationMedia>; // by mediaId — private application media
  idempotencyStage2: Record<string, string>; // key -> applicationId
  idempotencyUpdate: Record<string, string>; // key -> applicationId
  informationRequests: Record<string, InformationRequest>; // by request id
  datingPreferences: Record<string, DatingPreferencesRecord>; // by applicationId — private matching data
  reviews: ApplicationReviewRecord[]; // internal reviewer actions (with reason codes)
  audit: AuditEvent[];
};

const emptyDb = (): ServerDb => ({
  ...emptyMemberTables(),
  accounts: {},
  userIdByPhone: {},
  sessions: {},
  challenges: {},
  otpRequests: {},
  applications: {},
  privateData: {},
  idempotency: {},
  referralRequests: [],
  memberships: {},
  media: {},
  idempotencyStage2: {},
  idempotencyUpdate: {},
  informationRequests: {},
  datingPreferences: {},
  reviews: [],
  audit: [],
});

export type FailureKind = 'network';
export type MockOperation =
  | 'requestOtp'
  | 'verifyOtp'
  | 'signOut'
  | 'requestAccountDeletion'
  | 'submitStage1'
  | 'getMyApplication'
  | 'startExtendedApplication'
  | 'uploadApplicationPhoto'
  | 'submitStage2'
  | 'respondToInformationRequest'
  | 'submitInformationUpdate'
  | 'beginMembership'
  | 'getMembershipPlans'
  | MemberOperation;

/** Upload size guard for the mock (base64 data URIs). Real uploads go to object storage. */
const MAX_UPLOAD_CHARS = 1_500_000;

export type MockAdmissionApiOptions = {
  storage: KeyValueStorage;
  latencyMs?: number;
  now?: () => Date;
  random?: () => number;
};

export function createMockAdmissionApi(options: MockAdmissionApiOptions) {
  const { storage, latencyMs = 0 } = options;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const failures = new Map<MockOperation, FailureKind[]>();
  /** Simulates a request that reached the server but whose response was lost. */
  const lostResponses = new Set<MockOperation>();

  let db: ServerDb | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<ServerDb> {
    if (db) return db;
    const raw = await storage.getItem(SERVER_KEY);
    db = raw ? { ...emptyDb(), ...(JSON.parse(raw) as Partial<ServerDb>) } : emptyDb();
    // Matches persisted before the match lifecycle (DEC-060) gain a status.
    for (const [id, m] of Object.entries(db.matches)) db.matches[id] = normalizeMatch(m);
    return db;
  }
  async function save() {
    if (db) await storage.setItem(SERVER_KEY, JSON.stringify(db));
  }

  /** Serialises server operations — mirrors a transactional backend. */
  function op<T>(name: MockOperation, fn: (db: ServerDb) => ApiResult<T> | Promise<ApiResult<T>>) {
    const run = async (): Promise<ApiResult<T>> => {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const queued = failures.get(name);
      if (queued && queued.length > 0) {
        queued.shift();
        return { ok: false, error: { kind: 'network' } };
      }
      const state = await load();
      const result = await fn(state);
      await save();
      if (lostResponses.has(name)) {
        lostResponses.delete(name);
        return { ok: false, error: { kind: 'network' } };
      }
      return result;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  }

  /** Serialised access outside the request path (fixtures): no latency, no failure injection. */
  function transact<T>(fn: (db: ServerDb) => T): Promise<T> {
    const run = async () => {
      const state = await load();
      const result = fn(state);
      await save();
      return result;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  }

  const fail = (error: ApiError) => ({ ok: false as const, error });
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const iso = () => now().toISOString();

  // The member product's server, sharing this database (profiles are provisioned from applications).
  const member = createMockMemberApi({
    op: (name, fn) => op(name, fn),
    transact: (fn) => transact(fn),
    now,
    random,
    userFor: (state, session) => userFor(state as ServerDb, session),
  });

  function audit(
    state: ServerDb,
    e: {
      eventType: AuditEventType;
      actorType: ActorType;
      userId: string | null;
      applicationId: string | null;
      previousStatus?: ApplicationStatus | null;
      newStatus?: ApplicationStatus | null;
      actorId?: string | null;
      reasonCode?: InternalDecisionReason | null;
      metadata?: AuditEvent['metadata'];
    },
  ) {
    state.audit.push({
      id: createId('evt', random),
      applicationId: e.applicationId,
      userId: e.userId,
      eventType: e.eventType,
      previousStatus: e.previousStatus ?? null,
      newStatus: e.newStatus ?? null,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      reasonCode: e.reasonCode ?? null,
      metadata: e.metadata ?? {},
      createdAt: iso(),
    });
  }

  /** Move an application along the lifecycle — the only place server code changes status. */
  function moveApp(app: MembershipApplication, to: ApplicationStatus) {
    app.status = transition(app.status, to);
    app.updatedAt = iso();
  }

  /** Applications persisted before newer fields existed. */
  function normalizeApp(app: MembershipApplication): MembershipApplication {
    app.moreInformationRequestedAt ??= null;
    app.moreInformationReturnTo ??= null;
    app.informationProvidedAt ??= null;
    app.reopenedAt ??= null;
    return app;
  }

  function appFor(state: ServerDb, userId: string): MembershipApplication | undefined {
    const app = state.applications[userId];
    return app ? normalizeApp(app) : undefined;
  }

  function profilePhotoIds(state: ServerDb, applicationId: string): string[] {
    return Object.values(state.media)
      .filter(
        (m) =>
          m.applicationId === applicationId && (m.purpose ?? 'profile') === 'profile' && !m.retiredAt && m.order >= 0,
      )
      .sort((a, b) => a.order - b.order)
      .map((m) => m.id);
  }

  function requestsOf(state: ServerDb, applicationId: string): InformationRequest[] {
    return Object.values(state.informationRequests)
      .filter((r) => r.applicationId === applicationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function userFor(state: ServerDb, session: Session): string | null {
    const userId = state.sessions[session.token];
    return userId && userId === session.userId ? userId : null;
  }

  const api: AdmissionApi = {
    requestOtp: (phoneE164) =>
      op('requestOtp', (state) => {
        if (!/^\+\d{6,15}$/.test(phoneE164)) return fail({ kind: 'invalid_phone' });
        const t = now().getTime();
        const recent = (state.otpRequests[phoneE164] ?? []).filter((ts) => t - new Date(ts).getTime() < 60 * 60 * 1000);
        const last = recent[recent.length - 1];
        if (last && t - new Date(last).getTime() < OTP_RESEND_COOLDOWN_MS) {
          return fail({
            kind: 'rate_limited',
            retryAfterMs: OTP_RESEND_COOLDOWN_MS - (t - new Date(last).getTime()),
          });
        }
        if (recent.length >= OTP_MAX_REQUESTS_PER_HOUR) {
          const oldest = recent[0] ?? iso();
          return fail({ kind: 'rate_limited', retryAfterMs: 60 * 60 * 1000 - (t - new Date(oldest).getTime()) });
        }
        // Invalidate earlier challenges for this number.
        for (const c of Object.values(state.challenges)) {
          if (c.phoneE164 === phoneE164) c.consumed = true;
        }
        const challenge: ChallengeRecord = {
          challengeId: createId('otp', random),
          phoneE164,
          expiresAt: new Date(t + OTP_TTL_MS).toISOString(),
          resendAvailableAt: new Date(t + OTP_RESEND_COOLDOWN_MS).toISOString(),
          attempts: 0,
          consumed: false,
        };
        state.challenges[challenge.challengeId] = challenge;
        state.otpRequests[phoneE164] = [...recent, iso()];
        const { attempts: _a, consumed: _c, ...publicChallenge } = challenge;
        return ok<OtpChallenge>(publicChallenge);
      }),

    verifyOtp: (challengeId, code) =>
      op('verifyOtp', (state) => {
        const c = state.challenges[challengeId];
        if (!c || c.consumed) return fail({ kind: 'code_expired' });
        if (now().getTime() > new Date(c.expiresAt).getTime()) return fail({ kind: 'code_expired' });
        if (c.attempts >= OTP_MAX_ATTEMPTS) return fail({ kind: 'too_many_attempts' });
        if (code !== MOCK_OTP_CODE) {
          c.attempts += 1;
          const remaining = OTP_MAX_ATTEMPTS - c.attempts;
          return remaining <= 0
            ? fail({ kind: 'too_many_attempts' })
            : fail({ kind: 'invalid_code', attemptsRemaining: remaining });
        }
        c.consumed = true;
        let userId = state.userIdByPhone[c.phoneE164];
        if (!userId) {
          userId = createId('usr', random);
          state.userIdByPhone[c.phoneE164] = userId;
          state.accounts[userId] = {
            id: userId,
            phoneE164: c.phoneE164,
            phoneVerifiedAt: iso(),
            createdAt: iso(),
            updatedAt: iso(),
            accountStatus: 'active',
          };
          audit(state, { userId, applicationId: null, actorType: 'applicant', eventType: 'PHONE_VERIFIED' });
        }
        const account = state.accounts[userId];
        if (!account) return fail({ kind: 'unauthorized' });
        // Like the server: only the number's owner gets here, and a deleted account cannot sign in again.
        if (account.accountStatus !== 'active') return fail({ kind: 'not_allowed' });
        const token = createId('ses', random);
        state.sessions[token] = userId;
        return ok({
          session: { token, userId },
          account,
          application: state.applications[userId] ?? null,
          membership: state.memberships[userId] ?? null,
        });
      }),

    signOut: (session) =>
      op('signOut', (state) => {
        delete state.sessions[session.token];
        return ok(undefined);
      }),

    requestAccountDeletion: (session) =>
      op('requestAccountDeletion', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        const account = state.accounts[userId];
        if (!account) return fail({ kind: 'unauthorized' });
        // Immediate: every session revoked, out of the community (member access requires an active account).
        state.accounts[userId] = { ...account, accountStatus: 'deleted', updatedAt: iso() };
        for (const [token, owner] of Object.entries(state.sessions)) if (owner === userId) delete state.sessions[token];
        const membership = state.memberships[userId];
        if (membership && membership.status !== 'cancelled') state.memberships[userId] = { ...membership, status: 'cancelled' };
        return ok({ deletionRequested: true as const });
      }),

    submitStage1: (session, idempotencyKey, submission) =>
      op('submitStage1', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });

        // Idempotent: the same key, or any repeat submit by this account,
        // returns the original application. One application per account.
        const existing = state.applications[userId];
        if (existing) return ok(existing);

        const checked = validateStage1Submission(submission, todayInLocalCalendar(now()));
        if (!checked.ok) return fail({ kind: 'validation', fields: checked.fields });
        const valid = checked.value;

        const at = iso();
        const applicationId = createId('app', random);
        // Server-side lifecycle: DRAFT → SUBMITTED → RECEIVED. Never further.
        const status: ApplicationStatus = transition(
          transition('APPLICATION_DRAFT', 'APPLICATION_SUBMITTED'),
          'APPLICATION_RECEIVED',
        );
        const application: MembershipApplication = {
          id: applicationId,
          userId,
          status,
          stage1CompletedAt: at,
          submittedAt: at,
          reviewStartedAt: null,
          extendedRequestedAt: null,
          extendedSubmittedAt: null,
          finalReviewStartedAt: null,
          decisionAt: null,
          moreInformationRequestedAt: null,
          moreInformationReturnTo: null,
          informationProvidedAt: null,
          reopenedAt: null,
          createdAt: at,
          updatedAt: at,
        };
        state.applications[userId] = application;
        state.idempotency[idempotencyKey] = applicationId;
        state.privateData[applicationId] = {
          applicationId,
          firstName: valid.firstName,
          lastName: valid.lastName,
          dateOfBirth: valid.dateOfBirth,
          instagram: valid.instagram,
          countryCode: valid.countryCode,
          city: valid.city,
          referral: valid.referral,
          occupation: null,
          workContext: null,
          workContextAnswer: null,
          workDescription: null,
          personalResponse: null,
          interests: [],
          intents: [],
          education: null,
          websiteUrl: null,
          portfolioUrl: null,
          createdAt: at,
          updatedAt: at,
        };
        if (valid.referral.kind === 'requested') {
          for (const r of valid.referral.referrals) {
            // Matched against members privately later. The applicant is never told the outcome.
            state.referralRequests.push({ applicationId, name: r.name, phoneE164: r.phoneE164, requestedAt: at });
          }
        }
        audit(state, {
          userId,
          applicationId,
          actorType: 'applicant',
          eventType: 'APPLICATION_SUBMITTED',
          previousStatus: 'APPLICATION_DRAFT',
          newStatus: 'APPLICATION_RECEIVED',
        });
        return ok(application);
      }),

    getMyApplication: (session) =>
      op('getMyApplication', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        return ok(mine(state, userId));
      }),

    startExtendedApplication: (session) =>
      op('startExtendedApplication', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        const app = appFor(state, userId);
        if (!app) return fail({ kind: 'not_allowed' });
        if (app.status === 'EXTENDED_APPLICATION_REQUIRED') {
          moveApp(app, 'EXTENDED_APPLICATION_DRAFT');
          audit(state, {
            userId,
            applicationId: app.id,
            actorType: 'applicant',
            eventType: 'EXTENDED_APPLICATION_STARTED',
            previousStatus: 'EXTENDED_APPLICATION_REQUIRED',
            newStatus: 'EXTENDED_APPLICATION_DRAFT',
          });
        } else if (app.status !== 'EXTENDED_APPLICATION_DRAFT') {
          return fail({ kind: 'not_allowed' });
        }
        return ok(mine(state, userId));
      }),

    uploadApplicationPhoto: (session, photo, options) =>
      op('uploadApplicationPhoto', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        const app = appFor(state, userId);
        if (!app) return fail({ kind: 'not_allowed' });
        // Stage 2 photos while the extended draft is open, or a photo that answers
        // a specific open request (replace a photo / confirm identity). Nothing else.
        const requestId = options?.requestId ?? null;
        let purpose: ApplicationMedia['purpose'] = 'profile';
        if (requestId) {
          const req = state.informationRequests[requestId];
          if (
            app.status !== 'MORE_INFORMATION_REQUIRED' ||
            !req ||
            req.applicationId !== app.id ||
            (req.status !== 'open' && req.status !== 'answered') ||
            (req.type !== 'REPLACE_PHOTO' && req.type !== 'VERIFY_IDENTITY')
          ) {
            return fail({ kind: 'not_allowed' });
          }
          purpose = req.type === 'VERIFY_IDENTITY' ? 'verification' : 'profile';
        } else if (app.status !== 'EXTENDED_APPLICATION_DRAFT') {
          return fail({ kind: 'not_allowed' });
        }
        // The declared media class must be the one this request calls for (as on the server).
        const declared = options?.mediaClass ?? 'APPLICATION_MEDIA';
        if (declared !== (purpose === 'verification' ? 'VERIFICATION_MEDIA' : 'APPLICATION_MEDIA')) return fail({ kind: 'not_allowed' });
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(photo.dataUri) || photo.dataUri.length > MAX_UPLOAD_CHARS) {
          return fail({ kind: 'validation', fields: ['photo'] });
        }
        const existing = Object.values(state.media).filter((m) => m.applicationId === app.id);
        if (existing.length >= PHOTO_MAX * 4) return fail({ kind: 'rate_limited', retryAfterMs: 60_000 });
        const media: ApplicationMedia = {
          id: createId('med', random),
          applicationId: app.id,
          type: 'photo',
          purpose,
          storageKey: photo.dataUri,
          // Request uploads join the profile only when the update is sent.
          order: requestId ? -1 : existing.filter((m) => !m.requestId).length,
          moderationStatus: 'pending',
          requestId,
          retiredAt: null,
          createdAt: iso(),
        };
        state.media[media.id] = media;
        // Verification media is never handed back to a device (DEC-063).
        return ok(purpose === 'verification' ? { ...media, storageKey: '' } : media);
      }),

    submitStage2: (session, idempotencyKey, submission) =>
      op('submitStage2', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        const app = appFor(state, userId);
        if (!app) return fail({ kind: 'not_allowed' });
        // Idempotent: a repeat (same key, or after acceptance) returns the application as it is.
        if (state.idempotencyStage2[idempotencyKey] === app.id || app.extendedSubmittedAt) return ok(app);
        if (app.status !== 'EXTENDED_APPLICATION_DRAFT') return fail({ kind: 'not_allowed' });

        const checked = validateStage2Submission(submission, { ownsPhoto: (id) => state.media[id]?.applicationId === app.id });
        if (!checked.ok) return fail({ kind: 'validation', fields: checked.fields });
        const v = checked.value;
        const ids = v.photoIds;

        const at = iso();
        // Server lifecycle: DRAFT → SUBMITTED → FINAL_REVIEW. Never to a decision (DEC-013).
        moveApp(app, 'EXTENDED_APPLICATION_SUBMITTED');
        moveApp(app, 'FINAL_REVIEW');
        app.extendedSubmittedAt = at;
        app.finalReviewStartedAt = at;
        app.updatedAt = at;
        state.idempotencyStage2[idempotencyKey] = app.id;
        ids.forEach((id, order) => {
          const m = state.media[id];
          if (m) m.order = order;
        });
        // Photos uploaded but removed before submitting are not part of the profile.
        for (const m of Object.values(state.media)) {
          if (m.applicationId === app.id && !ids.includes(m.id)) m.order = -1;
        }
        const priv = state.privateData[app.id];
        if (priv) {
          priv.occupation = v.occupation;
          priv.workContextAnswer = v.workContext;
          priv.workContext = v.workContextLabel;
          priv.workDescription = v.whatYouDo;
          priv.personalResponse = v.aboutYou;
          priv.interests = [...v.interests];
          priv.intents = [...v.intents];
          priv.updatedAt = at;
        }
        if (v.datingPreferences) {
          state.datingPreferences[app.id] = {
            applicationId: app.id,
            userId,
            meet: [...v.datingPreferences.meet],
            ageRange: { ...v.datingPreferences.ageRange },
            createdAt: at,
            updatedAt: at,
          };
        }
        audit(state, {
          userId,
          applicationId: app.id,
          actorType: 'applicant',
          eventType: 'EXTENDED_APPLICATION_SUBMITTED',
          previousStatus: 'EXTENDED_APPLICATION_DRAFT',
          newStatus: 'EXTENDED_APPLICATION_SUBMITTED',
        });
        audit(state, {
          userId,
          applicationId: app.id,
          actorType: 'system',
          eventType: 'FINAL_REVIEW_STARTED',
          previousStatus: 'EXTENDED_APPLICATION_SUBMITTED',
          newStatus: 'FINAL_REVIEW',
        });
        return ok(app);
      }),

    // --- More information required --------------------------------------------
    respondToInformationRequest: (session, requestId, response) =>
      op('respondToInformationRequest', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        const app = appFor(state, userId);
        const req = state.informationRequests[requestId];
        if (!app || app.status !== 'MORE_INFORMATION_REQUIRED' || !req || req.applicationId !== app.id) {
          return fail({ kind: 'not_allowed' });
        }
        const uploadedForRequest = Object.values(state.media)
          .filter((m) => m.requestId === req.id && !m.retiredAt)
          .map((m) => m.id);
        const v = validateResponse(req, response, { uploadedForRequest });
        if (!v.ok) {
          return v.error === 'invalid_value'
            ? fail({ kind: 'validation', fields: [req.type] })
            : fail({ kind: 'not_allowed' });
        }
        req.response = v.value;
        req.status = 'answered';
        req.answeredAt = iso();
        return ok(mine(state, userId));
      }),

    submitInformationUpdate: (session, idempotencyKey) =>
      op('submitInformationUpdate', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        const app = appFor(state, userId);
        if (!app) return fail({ kind: 'not_allowed' });
        if (state.idempotencyUpdate[idempotencyKey] === app.id) return ok(mine(state, userId));
        if (app.status !== 'MORE_INFORMATION_REQUIRED') return fail({ kind: 'not_allowed' });
        const open = requestsOf(state, app.id).filter((r) => r.status === 'open' || r.status === 'answered');
        if (open.length === 0 || open.some((r) => r.status !== 'answered' || !r.response)) {
          return fail({ kind: 'validation', fields: open.filter((r) => r.status !== 'answered').map((r) => r.id) });
        }
        const returnTo = isReviewReturnStage(app.moreInformationReturnTo)
          ? app.moreInformationReturnTo
          : 'UNDER_REVIEW';
        const at = iso();
        for (const req of open) applyResponse(state, app, req, at);
        const from = app.status;
        moveApp(app, returnTo);
        app.informationProvidedAt = at;
        if (returnTo === 'FINAL_REVIEW') app.finalReviewStartedAt = at;
        state.idempotencyUpdate[idempotencyKey] = app.id;
        audit(state, {
          userId,
          applicationId: app.id,
          actorType: 'applicant',
          eventType: 'MORE_INFORMATION_PROVIDED',
          previousStatus: from,
          newStatus: returnTo,
          metadata: { requestTypes: open.map((r) => r.type) },
        });
        return ok(mine(state, userId));
      }),

    // --- Membership activation boundary ---------------------------------------
    beginMembership: (session) =>
      op('beginMembership', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        const app = appFor(state, userId);
        if (!app) return fail({ kind: 'not_allowed' });
        if (app.status === 'MEMBERSHIP_PAYMENT_REQUIRED') return ok(mine(state, userId));
        if (app.status !== 'APPROVED') return fail({ kind: 'not_allowed' });
        moveApp(app, 'MEMBERSHIP_PAYMENT_REQUIRED');
        const at = iso();
        state.memberships[userId] = {
          id: createId('mbr', random),
          userId,
          planId: DEVELOPMENT_MEMBERSHIP_PLAN.id,
          status: 'pending',
          startedAt: null,
          renewsAt: null,
          endsAt: null,
          activation: 'billing',
          createdAt: at,
          updatedAt: at,
        };
        audit(state, {
          userId,
          applicationId: app.id,
          actorType: 'applicant',
          eventType: 'MEMBERSHIP_ACTIVATION_STARTED',
          previousStatus: 'APPROVED',
          newStatus: 'MEMBERSHIP_PAYMENT_REQUIRED',
        });
        return ok(mine(state, userId));
      }),

    getMembershipPlans: (session) =>
      op('getMembershipPlans', (state) => {
        const userId = userFor(state, session);
        if (!userId) return fail({ kind: 'unauthorized' });
        const app = appFor(state, userId);
        if (!app || (app.status !== 'APPROVED' && app.status !== 'MEMBERSHIP_PAYMENT_REQUIRED')) {
          return fail({ kind: 'not_allowed' });
        }
        return ok([{ ...DEVELOPMENT_MEMBERSHIP_PLAN }]);
      }),
  };

  /** Apply one answered request to the private application. Only its own target changes. */
  function applyResponse(state: ServerDb, app: MembershipApplication, req: InformationRequest, at: string) {
    const r = req.response as InformationResponse;
    const priv = state.privateData[app.id];
    switch (r.type) {
      case 'REPLACE_PHOTO': {
        const old = req.target?.kind === 'photo' ? state.media[req.target.mediaId] : undefined;
        const next = state.media[r.mediaId];
        if (old && next) {
          next.order = old.order;
          old.order = -1;
          old.retiredAt = at;
        }
        break;
      }
      case 'VERIFY_IDENTITY':
        // Stays a private verification photo; reviewed by the team, never on a profile.
        break;
      case 'UPDATE_INSTAGRAM':
        if (priv) priv.instagram = { kind: 'handle', handle: r.handle };
        break;
      case 'CLARIFY_WORK':
        if (priv) {
          priv.occupation = r.occupation;
          priv.workContextAnswer = r.workContext;
          priv.workContext =
            r.workContext.kind === 'organisation'
              ? r.workContext.name
              : r.workContext.kind === 'independent'
                ? 'Independent'
                : null;
        }
        break;
      case 'UPDATE_APPLICATION_FIELD':
        if (priv) {
          if (r.field === 'whatYouDo') priv.workDescription = r.value;
          else priv.personalResponse = r.value;
        }
        break;
    }
    if (priv) priv.updatedAt = at;
    req.status = 'resolved';
    req.resolvedAt = at;
  }

  /** The applicant's own view of one request: the request, and their own current answer. */
  function projectRequest(
    state: ServerDb,
    app: MembershipApplication,
    req: InformationRequest,
  ): ApplicantInformationRequest {
    const priv = state.privateData[app.id];
    let current: ApplicantInformationRequest['current'] = null;
    switch (req.type) {
      case 'REPLACE_PHOTO': {
        const m = req.target?.kind === 'photo' ? state.media[req.target.mediaId] : undefined;
        current = m ? { kind: 'photo', uri: m.storageKey } : null;
        break;
      }
      case 'UPDATE_INSTAGRAM':
        current = priv ? { kind: 'instagram', handle: priv.instagram.handle } : null;
        break;
      case 'CLARIFY_WORK':
        current = priv
          ? { kind: 'work', occupation: priv.occupation, workContext: priv.workContextAnswer ?? null }
          : null;
        break;
      case 'UPDATE_APPLICATION_FIELD':
        if (priv && req.target?.kind === 'field') {
          current = {
            kind: 'text',
            field: req.target.field,
            value: req.target.field === 'whatYouDo' ? priv.workDescription : priv.personalResponse,
          };
        }
        break;
      case 'VERIFY_IDENTITY':
        current = null;
        break;
    }
    const r = req.response;
    const response: ApplicantInformationRequest['response'] = !r
      ? null
      : r.type === 'VERIFY_IDENTITY'
        ? state.media[r.mediaId]
          ? { kind: 'verification_received' }
          : null
        : r.type === 'REPLACE_PHOTO'
          ? state.media[r.mediaId]
            ? { kind: 'photo', uri: state.media[r.mediaId]!.storageKey }
            : null
        : r.type === 'UPDATE_INSTAGRAM'
          ? { kind: 'instagram', handle: r.handle }
          : r.type === 'CLARIFY_WORK'
            ? { kind: 'work', occupation: r.occupation, workContext: r.workContext }
            : { kind: 'text', value: r.value };
    return {
      id: req.id,
      type: req.type,
      explanation: req.explanation,
      target: req.target,
      status: req.status === 'withdrawn' ? 'resolved' : req.status,
      createdAt: req.createdAt,
      resolvedAt: req.resolvedAt,
      current,
      response,
    };
  }

  /**
   * Reviewer endpoint — not part of the applicant API. Every review-state
   * change goes through here: planned by the shared domain rules, validated,
   * recorded internally (with any reason code) and audited.
   */
  async function applyReviewerAction(
    applicationId: string,
    action: ReviewerAction,
    actor: { reviewerId: string },
  ): Promise<{ ok: true; application: MembershipApplication } | { ok: false; error: string }> {
    const run = async () => {
      const state = await load();
      const app = Object.values(state.applications).find((a) => a.id === applicationId);
      if (!app) return { ok: false as const, error: 'not_found' };
      normalizeApp(app);
      const planned = planReviewerAction(app, action);
      if (!planned.ok) return { ok: false as const, error: planned.error };
      const { plan } = planned;

      let resolved: ReturnType<typeof resolveRequestDrafts> | null = null;
      if (action.kind === 'REQUEST_INFORMATION') {
        resolved = resolveRequestDrafts(action.requests, {
          photoIds: profilePhotoIds(state, app.id),
          extendedSubmitted: app.extendedSubmittedAt !== null,
        });
        if (!resolved.ok) return { ok: false as const, error: `request_${resolved.error}` };
      }

      const at = iso();
      moveApp(app, plan.to);
      switch (plan.to) {
        case 'UNDER_REVIEW':
          app.reviewStartedAt ??= at;
          break;
        case 'EXTENDED_APPLICATION_REQUIRED':
          app.extendedRequestedAt = at;
          break;
        case 'FINAL_REVIEW':
          app.finalReviewStartedAt = at;
          break;
        case 'MORE_INFORMATION_REQUIRED':
          app.moreInformationRequestedAt = at;
          app.moreInformationReturnTo = plan.returnTo;
          break;
      }
      if (action.kind === 'REOPEN') app.reopenedAt = at;
      if (plan.isDecision) app.decisionAt = at;
      if (resolved?.ok) {
        // A new round replaces anything still unanswered from an earlier one.
        for (const r of requestsOf(state, app.id))
          if (r.status === 'open' || r.status === 'answered') r.status = 'withdrawn';
        for (const d of resolved.value) {
          const id = createId('req', random);
          state.informationRequests[id] = {
            id,
            applicationId: app.id,
            type: d.type,
            explanation: d.explanation,
            target: d.target,
            status: 'open',
            response: null,
            createdAt: at,
            answeredAt: null,
            resolvedAt: null,
          };
        }
      }
      state.reviews.push({
        id: createId('rev', random),
        applicationId: app.id,
        reviewerId: actor.reviewerId,
        action: action.kind,
        fromStatus: plan.from,
        toStatus: plan.to,
        reasonCode: plan.reason,
        requestTypes: resolved?.ok ? resolved.value.map((r) => r.type) : [],
        createdAt: at,
      });
      audit(state, {
        userId: app.userId,
        applicationId: app.id,
        actorType: 'reviewer',
        actorId: actor.reviewerId,
        eventType: plan.eventType,
        previousStatus: plan.from,
        newStatus: plan.to,
        reasonCode: plan.reason,
        metadata: resolved?.ok ? { requestTypes: resolved.value.map((r) => r.type) } : {},
      });
      await save();
      return { ok: true as const, application: { ...app } };
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  }

  const reviewer = { apply: applyReviewerAction };

  /** The applicant's own view: lifecycle record + display-only summary (no DOB). */
  function mine(state: ServerDb, userId: string): MyApplication {
    const application = appFor(state, userId) ?? null;
    const priv = application ? state.privateData[application.id] : undefined;
    const dob = priv ? parseISODate(priv.dateOfBirth) : null;
    const summary: ApplicantSummary | null =
      priv && dob
        ? { firstName: priv.firstName, age: ageOn(dob, todayInLocalCalendar(now())), cityLabel: priv.city.label }
        : null;
    // Requests are shown only while they are the applicant's next step.
    const informationRequests =
      application && application.status === 'MORE_INFORMATION_REQUIRED'
        ? requestsOf(state, application.id)
            .filter((r) => r.status !== 'withdrawn' && r.status !== 'resolved')
            .map((r) => projectRequest(state, application, r))
        : [];
    return { application, membership: state.memberships[userId] ?? null, summary, informationRequests };
  }

  /**
   * Development-only controls (failure injection, reviewer fixture, billing
   * fixture). Not part of the AdmissionApi port.
   *
   * Release builds: EXPO_PUBLIC_APP_ENV is inlined at build time, so the
   * condition below is a constant and the minifier removes createDevFixture
   * — none of this code exists in a production bundle (checked by
   * scripts/check-release-bundle.mjs). What remains is a stub that throws.
   */
  function createDevFixture() {
    const fixture = {
      failNext(operation: MockOperation, kind: FailureKind = 'network', times = 1) {
        failures.set(operation, [...(failures.get(operation) ?? []), ...Array<FailureKind>(times).fill(kind)]);
      },
      /** The server processes the request but the response never arrives. */
      loseNextResponse(operation: MockOperation) {
        lostResponses.add(operation);
      },
      async snapshot(): Promise<ServerDb> {
        return structuredClone(await load());
      },
      async reset() {
        db = emptyDb();
        await save();
      },
      /** Member product fixtures (src/services/mock/mockMemberApi.ts) — same server rules, no shortcuts. */
      seedCommunity: (input?: { media?: Record<string, string[]>; admirerOf?: string }) => member.dev.seedCommunity(input),
      memberSays: (key: string, toUserId: string, body: string) => member.dev.memberSays(key, toUserId, body),
      memberBlocks: (key: string, userId: string) => member.dev.memberBlocks(key, userId),
      /**
       * Development reviewer fixture. Calls the SAME reviewer endpoint real
       * tooling will use — validated, recorded and audited; no shortcuts.
       */
      async review(userId: string, action: ReviewerAction): Promise<MembershipApplication> {
        const state = await load();
        const app = state.applications[userId];
        if (!app) throw new Error('No application for user');
        const res = await applyReviewerAction(app.id, action, { reviewerId: 'dev-fixture' });
        if (!res.ok) throw new Error(`Reviewer action refused: ${res.error}`);
        return res.application;
      },
      /**
       * Convenience for tests: move to a review state by choosing the matching
       * reviewer action. Anything the lifecycle forbids is refused, as above.
       */
      async advance(userId: string, to: ApplicationStatus): Promise<MembershipApplication> {
        const state = await load();
        const app = state.applications[userId];
        if (!app) throw new Error('No application for user');
        const firstPhoto = profilePhotoIds(state, app.id)[0];
        const action: ReviewerAction | null =
          to === 'UNDER_REVIEW'
            ? app.status === 'WAITLISTED'
              ? { kind: 'REOPEN', to: 'UNDER_REVIEW' }
              : { kind: 'START_REVIEW' }
            : to === 'FINAL_REVIEW'
              ? { kind: 'REOPEN', to: 'FINAL_REVIEW' }
              : to === 'EXTENDED_APPLICATION_REQUIRED'
                ? { kind: 'REQUEST_EXTENDED' }
                : to === 'MORE_INFORMATION_REQUIRED'
                  ? {
                      kind: 'REQUEST_INFORMATION',
                      requests: firstPhoto
                        ? [{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: firstPhoto }]
                        : [{ preset: 'INSTAGRAM_NOT_FOUND' }],
                    }
                  : to === 'WAITLISTED'
                    ? { kind: 'WAITLIST', reason: 'CAPACITY' }
                    : to === 'APPROVED'
                      ? { kind: 'APPROVE', reason: 'COMMUNITY_FIT' }
                      : to === 'NOT_ADMITTED'
                        ? { kind: 'NOT_ADMIT', reason: 'APPLICATION_QUALITY' }
                        : null;
        if (!action) throw new Error(`Not a reviewer state: ${to}`);
        return fixture.review(userId, action);
      },
      /**
       * Development billing fixture: stands in for a payment provider's
       * confirmation (in production this arrives server-to-server). Activates
       * the pending membership — MEMBERSHIP_PAYMENT_REQUIRED → ACTIVE_MEMBER.
       */
      async confirmFixturePayment(userId: string): Promise<MembershipApplication> {
        const state = await load();
        const app = state.applications[userId];
        const membership = state.memberships[userId];
        if (!app || !membership || app.status !== 'MEMBERSHIP_PAYMENT_REQUIRED') throw new Error('Nothing to activate');
        normalizeApp(app);
        moveApp(app, 'ACTIVE_MEMBER');
        const at = iso();
        membership.status = 'active';
        membership.startedAt = at;
        membership.renewsAt = new Date(now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        membership.updatedAt = at;
        audit(state, {
          userId,
          applicationId: app.id,
          actorType: 'system',
          eventType: 'MEMBERSHIP_ACTIVATED',
          previousStatus: 'MEMBERSHIP_PAYMENT_REQUIRED',
          newStatus: 'ACTIVE_MEMBER',
          metadata: { billing: 'development_fixture' },
        });
        // The server provisions the member profile from the approved application at activation.
        member.provision(state, userId);
        await save();
        return app;
      },
      /**
       * Development billing fixture: the membership lapses (in production the
       * provider's expiry notice). ACTIVE_MEMBER → EXPIRED; the member leaves
       * every introduction and conversation, records are kept.
       */
      async expireMembership(userId: string): Promise<MembershipApplication> {
        const state = await load();
        const app = state.applications[userId];
        const membership = state.memberships[userId];
        if (!app || !membership || app.status !== 'ACTIVE_MEMBER') throw new Error('No active membership');
        normalizeApp(app);
        moveApp(app, 'EXPIRED');
        const at = iso();
        membership.status = 'expired';
        membership.endsAt = at;
        membership.updatedAt = at;
        audit(state, {
          userId,
          applicationId: app.id,
          actorType: 'system',
          eventType: 'MEMBERSHIP_EXPIRED',
          previousStatus: 'ACTIVE_MEMBER',
          newStatus: 'EXPIRED',
          metadata: { billing: 'development_fixture' },
        });
        await save();
        return app;
      },
    };

    return fixture;
  }

  type DevFixture = ReturnType<typeof createDevFixture>;
  const dev: DevFixture =
    process.env.EXPO_PUBLIC_APP_ENV === 'production' ? notInReleaseBuilds<DevFixture>() : createDevFixture();

  return { api, member: member.api, reviewer, dev };
}

export type MockAdmissionBackend = ReturnType<typeof createMockAdmissionApi>;

/** Any use of development controls in a release build fails loudly. */
function notInReleaseBuilds<T extends object>(): T {
  return new Proxy({} as T, {
    get() {
      throw new Error('Development controls are not available in release builds.');
    },
  });
}
