/**
 * Admission API port. The app depends on this interface only. Two
 * implementations: the HTTP adapter to the production API
 * (src/services/http/, docs/API_CONTRACT.md) and the mock server for
 * development and deterministic E2E (src/services/mock/mockAdmissionApi.ts).
 * src/services/index.ts selects one at build time (DEC-059).
 *
 * Authorization principle (docs/DATA_MODEL.md §16): applicants can read their
 * own application status and submit their own draft. There is intentionally
 * NO endpoint here that lets an applicant query members.
 */
import type {
  ApplicantInformationRequest,
  InformationResponse,
} from '@/domain/admission/informationRequests';
import type { Stage2Submission } from '@/domain/admission/stage2';
import type { MembershipPlan } from '@/domain/membership/plan';
import type {
  ApplicantSummary,
  ApplicationMedia,
  MembershipApplication,
  Membership,
  Stage1Submission,
  UserAccount,
} from '@/domain/models';

export type ApiError =
  | { kind: 'network' }
  | { kind: 'invalid_phone' }
  /** The code could not be sent (provider unavailable or refused). Safe, retryable. */
  | { kind: 'code_not_sent' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'invalid_code'; attemptsRemaining: number }
  | { kind: 'code_expired' }
  | { kind: 'too_many_attempts' }
  | { kind: 'unauthorized' }
  | { kind: 'validation'; fields: string[] }
  | { kind: 'not_allowed' }
  // Member product (see src/services/api/contract.ts for the wire codes).
  | { kind: 'membership_required' }
  | { kind: 'not_available' }
  | { kind: 'not_eligible' }
  | { kind: 'introduction_not_found' }
  | { kind: 'introduction_expired' }
  | { kind: 'reaction_already_recorded' }
  | { kind: 'match_not_found' }
  | { kind: 'conversation_forbidden' }
  | { kind: 'blocked' }
  | { kind: 'server' };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export type OtpChallenge = {
  challengeId: string;
  phoneE164: string;
  expiresAt: string;
  resendAvailableAt: string;
};

export type Session = { token: string; userId: string };

/** Media classes an applicant can upload (DEC-063). PROFILE_MEDIA belongs to members. */
export type ApplicationMediaClass = 'APPLICATION_MEDIA' | 'VERIFICATION_MEDIA';

export type AuthenticatedApplicant = {
  session: Session;
  account: UserAccount;
  /** Null when this phone has never submitted an application. */
  application: MembershipApplication | null;
  membership: Membership | null;
};

export interface AdmissionApi {
  requestOtp(phoneE164: string): Promise<ApiResult<OtpChallenge>>;
  verifyOtp(challengeId: string, code: string): Promise<ApiResult<AuthenticatedApplicant>>;

  // --- Account (applicants and members alike) --------------------------------------
  /** Revoke this device's session on the server. The app clears local data whatever the answer. */
  signOut(session: Session): Promise<ApiResult<void>>;
  /**
   * Ask for the account to be deleted (DEC-066, DEC-077). Takes effect at
   * once on the server: every session is revoked, the profile leaves the
   * community, matches end, any membership ends. Personal data and photos are
   * then anonymized by the retention process, except records kept for safety,
   * security or legal reasons (docs/DATA_RETENTION.md).
   */
  requestAccountDeletion(session: Session): Promise<ApiResult<{ deletionRequested: true }>>;

  /**
   * Idempotent: repeated calls with the same key — or any second call for a
   * user who already has an application — return the existing application.
   * Never returns an approved application.
   */
  submitStage1(
    session: Session,
    idempotencyKey: string,
    submission: Stage1Submission,
  ): Promise<ApiResult<MembershipApplication>>;
  getMyApplication(session: Session): Promise<ApiResult<MyApplication>>;

  // --- Stage 2 (extended application) ---------------------------------------
  /** EXTENDED_APPLICATION_REQUIRED → EXTENDED_APPLICATION_DRAFT. Idempotent once started. */
  startExtendedApplication(session: Session): Promise<ApiResult<MyApplication>>;
  /**
   * Upload one already-resized photo. Media is private application data,
   * moderated before any use. With `requestId`, the photo answers that open
   * information request (replace a photo / confirm identity) — the only way to
   * upload outside the extended draft. Identity photos are VERIFICATION_MEDIA
   * (a separate, reviewer-only class); everything else is APPLICATION_MEDIA.
   */
  uploadApplicationPhoto(
    session: Session,
    photo: { dataUri: string; width: number; height: number },
    options?: { requestId?: string; mediaClass?: ApplicationMediaClass },
  ): Promise<ApiResult<ApplicationMedia>>;
  /**
   * Idempotent like Stage 1. On acceptance the server moves the application
   * EXTENDED_APPLICATION_SUBMITTED → FINAL_REVIEW. Never to a decision.
   */
  submitStage2(
    session: Session,
    idempotencyKey: string,
    submission: Stage2Submission,
  ): Promise<ApiResult<MembershipApplication>>;

  // --- MORE_INFORMATION_REQUIRED -------------------------------------------------
  /** Save (or change) the response to one open request. Touches only that request's target. */
  respondToInformationRequest(
    session: Session,
    requestId: string,
    response: InformationResponse,
  ): Promise<ApiResult<MyApplication>>;
  /**
   * Send every answered request. Idempotent. The server applies the changes
   * and returns the application to the review stage it came from.
   */
  submitInformationUpdate(session: Session, idempotencyKey: string): Promise<ApiResult<MyApplication>>;

  // --- Membership activation (boundary only; no billing provider yet) ---------
  /** APPROVED → MEMBERSHIP_PAYMENT_REQUIRED. Idempotent. Never activates membership. */
  beginMembership(session: Session): Promise<ApiResult<MyApplication>>;
  getMembershipPlans(session: Session): Promise<ApiResult<MembershipPlan[]>>;
}

export type MyApplication = {
  application: MembershipApplication | null;
  membership: Membership | null;
  /** Display-only facts derived server-side (first name, age, city). */
  summary: ApplicantSummary | null;
  /** Open requests while MORE_INFORMATION_REQUIRED; empty otherwise. No reviewer data. */
  informationRequests: ApplicantInformationRequest[];
};
