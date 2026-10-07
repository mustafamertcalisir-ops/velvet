/**
 * The wire contract between the mobile app and the production backend
 * (docs/API_CONTRACT.md). Shared by the app's HTTP adapters
 * (src/services/http/) and the server (server/src/http/). Pure TypeScript —
 * no React Native, no Node imports.
 *
 * Every response body is an explicit DTO. Errors are typed codes; raw
 * database or provider errors never reach the client.
 */
import type { ApplicationMedia } from '@/domain/models';
import type { OwnMember } from './memberTypes';
import type { ApiError } from './types';

export const API_PREFIX = '/v1';

// --- Errors -----------------------------------------------------------------------

export const API_ERROR_CODES = [
  'UNAUTHENTICATED',
  'MEMBERSHIP_REQUIRED',
  'NOT_ALLOWED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'NOT_AVAILABLE',
  'NOT_ELIGIBLE',
  'INTRODUCTION_NOT_FOUND',
  'INTRODUCTION_EXPIRED',
  'REACTION_ALREADY_RECORDED',
  'MATCH_NOT_FOUND',
  'CONVERSATION_FORBIDDEN',
  'BLOCKED',
  'RATE_LIMITED',
  'INVALID_PHONE',
  'CODE_NOT_SENT',
  'INVALID_CODE',
  'CODE_EXPIRED',
  'TOO_MANY_ATTEMPTS',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    /** A short, non-technical message. Never a stack trace or SQL. */
    message: string;
    fields?: string[];
    retryAfterMs?: number;
    attemptsRemaining?: number;
    /** Correlates the response with server logs. Safe to show to support; carries nothing else. */
    requestId?: string;
  };
};

export const HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  MEMBERSHIP_REQUIRED: 403,
  NOT_ALLOWED: 403,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  NOT_AVAILABLE: 404,
  NOT_ELIGIBLE: 409,
  INTRODUCTION_NOT_FOUND: 404,
  INTRODUCTION_EXPIRED: 410,
  REACTION_ALREADY_RECORDED: 409,
  MATCH_NOT_FOUND: 404,
  CONVERSATION_FORBIDDEN: 403,
  BLOCKED: 409,
  RATE_LIMITED: 429,
  INVALID_PHONE: 422,
  CODE_NOT_SENT: 503,
  INVALID_CODE: 422,
  CODE_EXPIRED: 410,
  TOO_MANY_ATTEMPTS: 429,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

export const isApiErrorCode = (v: unknown): v is ApiErrorCode =>
  typeof v === 'string' && (API_ERROR_CODES as readonly string[]).includes(v);

/** Wire error → the app's ApiError union (what screens already understand). */
export function toClientError(e: ApiErrorBody['error'] | null | undefined): ApiError {
  switch (e?.code) {
    case 'UNAUTHENTICATED':
      return { kind: 'unauthorized' };
    case 'MEMBERSHIP_REQUIRED':
      return { kind: 'membership_required' };
    case 'NOT_ALLOWED':
    case 'NOT_FOUND':
      return { kind: 'not_allowed' };
    case 'VALIDATION_FAILED':
    case 'PAYLOAD_TOO_LARGE':
      return { kind: 'validation', fields: e.fields ?? [] };
    case 'NOT_AVAILABLE':
      return { kind: 'not_available' };
    case 'NOT_ELIGIBLE':
      return { kind: 'not_eligible' };
    case 'INTRODUCTION_NOT_FOUND':
      return { kind: 'introduction_not_found' };
    case 'INTRODUCTION_EXPIRED':
      return { kind: 'introduction_expired' };
    case 'REACTION_ALREADY_RECORDED':
      return { kind: 'reaction_already_recorded' };
    case 'MATCH_NOT_FOUND':
      return { kind: 'match_not_found' };
    case 'CONVERSATION_FORBIDDEN':
      return { kind: 'conversation_forbidden' };
    case 'BLOCKED':
      return { kind: 'blocked' };
    case 'RATE_LIMITED':
      return { kind: 'rate_limited', retryAfterMs: e.retryAfterMs ?? 30_000 };
    case 'INVALID_PHONE':
      return { kind: 'invalid_phone' };
    case 'CODE_NOT_SENT':
      return { kind: 'code_not_sent' };
    case 'INVALID_CODE':
      return { kind: 'invalid_code', attemptsRemaining: e.attemptsRemaining ?? 0 };
    case 'CODE_EXPIRED':
      return { kind: 'code_expired' };
    case 'TOO_MANY_ATTEMPTS':
      return { kind: 'too_many_attempts' };
    default:
      return { kind: 'server' };
  }
}

/** The app's ApiError → wire code (used by the server to answer in the same vocabulary). */
export function toWireCode(e: ApiError): ApiErrorCode {
  switch (e.kind) {
    case 'unauthorized':
      return 'UNAUTHENTICATED';
    case 'membership_required':
      return 'MEMBERSHIP_REQUIRED';
    case 'not_allowed':
      return 'NOT_ALLOWED';
    case 'validation':
      return 'VALIDATION_FAILED';
    case 'not_available':
      return 'NOT_AVAILABLE';
    case 'not_eligible':
      return 'NOT_ELIGIBLE';
    case 'introduction_not_found':
      return 'INTRODUCTION_NOT_FOUND';
    case 'introduction_expired':
      return 'INTRODUCTION_EXPIRED';
    case 'reaction_already_recorded':
      return 'REACTION_ALREADY_RECORDED';
    case 'match_not_found':
      return 'MATCH_NOT_FOUND';
    case 'conversation_forbidden':
      return 'CONVERSATION_FORBIDDEN';
    case 'blocked':
      return 'BLOCKED';
    case 'rate_limited':
      return 'RATE_LIMITED';
    case 'invalid_phone':
      return 'INVALID_PHONE';
    case 'code_not_sent':
      return 'CODE_NOT_SENT';
    case 'invalid_code':
      return 'INVALID_CODE';
    case 'code_expired':
      return 'CODE_EXPIRED';
    case 'too_many_attempts':
      return 'TOO_MANY_ATTEMPTS';
    case 'network':
    case 'server':
      return 'INTERNAL';
  }
}

// --- Routes ------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
export type Route = { method: Method; path: string };
const r = (method: Method, path: string): Route => ({ method, path: `${API_PREFIX}${path}` });
const id = (v: string) => encodeURIComponent(v);

/**
 * Every app-facing operation. Internal operations (reviewer actions, billing
 * confirmation) are under /internal and are not callable with a member session.
 */
export const ROUTES = {
  // Authentication (phone → OTP → session)
  requestOtp: r('POST', '/auth/otp'),
  verifyOtp: r('POST', '/auth/otp/verify'),
  signOut: r('POST', '/auth/sign-out'),
  signOutEverywhere: r('POST', '/auth/sign-out-all'),
  rotateSession: r('POST', '/auth/session/rotate'),

  // Account lifecycle (applicants and members alike)
  requestAccountDeletion: r('POST', '/me/deletion'),

  // Media: authorise a direct upload to private storage, then complete it (DEC-063)
  createUpload: r('POST', '/media/uploads'),
  completeUpload: (uploadId: string) => r('POST', `/media/uploads/${id(uploadId)}/complete`),

  // Admission (the applicant's own application only)
  myApplication: r('GET', '/me/application'),
  submitStage1: r('POST', '/application'),
  startExtended: r('POST', '/application/extended/start'),
  submitStage2: r('POST', '/application/extended'),
  respondToRequest: (requestId: string) => r('PUT', `/application/information-requests/${id(requestId)}/response`),
  submitInformationUpdate: r('POST', '/application/information-update'),
  beginMembership: r('POST', '/membership/begin'),
  membershipPlans: r('GET', '/membership/plans'),

  // Member (ACTIVE_MEMBER with a live membership only)
  me: r('GET', '/member/me'),
  confirmProfile: r('POST', '/member/me/confirm'),
  updateProfile: r('PATCH', '/member/me/profile'),
  datingSettings: r('GET', '/member/me/dating'),
  saveDatingSettings: r('PUT', '/member/me/dating'),
  blocked: r('GET', '/member/me/blocked'),
  introductionsToday: r('GET', '/introductions/today'),
  react: (introductionId: string) => r('POST', `/introductions/${id(introductionId)}/reaction`),
  member: (memberId: string) => r('GET', `/members/${id(memberId)}`),
  block: (memberId: string) => r('POST', `/members/${id(memberId)}/block`),
  report: (memberId: string) => r('POST', `/members/${id(memberId)}/reports`),
  match: (matchId: string) => r('GET', `/matches/${id(matchId)}`),
  openConversation: (matchId: string) => r('POST', `/matches/${id(matchId)}/conversation`),
  conversations: r('GET', '/conversations'),
  sendMessage: (conversationId: string) => r('POST', `/conversations/${id(conversationId)}/messages`),
} as const;

// --- Media uploads (DEC-063, docs/MEDIA_ARCHITECTURE.md) -----------------------------

export const MEDIA_CLASSES = ['APPLICATION_MEDIA', 'VERIFICATION_MEDIA', 'PROFILE_MEDIA'] as const;
export type MediaClass = (typeof MEDIA_CLASSES)[number];
export const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

/** POST /media/uploads — ask for a direct upload. */
export type CreateUploadRequest = {
  mediaClass: MediaClass;
  contentType: UploadContentType;
  byteLength: number;
  /** For an upload that answers an information request (replace a photo / confirm identity). */
  requestId?: string | null;
};

/** A short-lived, single-object upload permission. The bytes go straight to private storage. */
export type UploadAuthorization = {
  uploadId: string;
  mediaClass: MediaClass;
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
  expiresAt: string;
};

/** POST /media/uploads/{id}/complete — the processed media, as the caller may see it. */
export type CompletedUpload = {
  uploadId: string;
  mediaClass: MediaClass;
  mediaId: string;
  /** APPLICATION_MEDIA / VERIFICATION_MEDIA (a verification photo never carries a url). */
  applicationMedia: ApplicationMedia | null;
  /** PROFILE_MEDIA: the member's own profile, with the new photo. */
  member: OwnMember | null;
};

/** Header carrying the client idempotency key for submissions. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
