/**
 * Typed API errors. Services throw AppError with a wire code from the shared
 * contract (src/services/api/contract.ts); the HTTP layer turns it into a
 * small JSON body. Anything else becomes INTERNAL with a generic message —
 * database and provider errors never reach the client.
 */
import { HTTP_STATUS, type ApiErrorBody, type ApiErrorCode } from '@/services/api/contract';
import { currentRequestId } from '../lib/log';

export type ErrorDetails = { fields?: string[]; retryAfterMs?: number; attemptsRemaining?: number };

export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly details: ErrorDetails = {},
  ) {
    super(code);
    this.name = 'AppError';
  }
}

export const fail = (code: ApiErrorCode, details?: ErrorDetails): never => {
  throw new AppError(code, details);
};

/** Short, calm, non-technical. Screens use their own copy; these are for logs and tools. */
const MESSAGES: Record<ApiErrorCode, string> = {
  UNAUTHENTICATED: 'Please sign in again.',
  MEMBERSHIP_REQUIRED: 'This is available to members.',
  NOT_ALLOWED: 'That isn’t available right now.',
  VALIDATION_FAILED: 'Some details need another look.',
  NOT_FOUND: 'Not found.',
  NOT_AVAILABLE: 'This profile isn’t available.',
  NOT_ELIGIBLE: 'This introduction is no longer available.',
  INTRODUCTION_NOT_FOUND: 'This introduction isn’t available.',
  INTRODUCTION_EXPIRED: 'This introduction has ended.',
  REACTION_ALREADY_RECORDED: 'You already answered this introduction.',
  MATCH_NOT_FOUND: 'This conversation isn’t available.',
  CONVERSATION_FORBIDDEN: 'This conversation isn’t available.',
  BLOCKED: 'This isn’t available.',
  RATE_LIMITED: 'Please wait a moment and try again.',
  INVALID_PHONE: 'Check the number and try again.',
  CODE_NOT_SENT: 'We couldn’t send a code right now. Try again.',
  INVALID_CODE: 'That code isn’t right.',
  CODE_EXPIRED: 'That code has expired.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Request a new code.',
  PAYLOAD_TOO_LARGE: 'That file is too large.',
  INTERNAL: 'Something went wrong. Please try again.',
};

export function errorResponse(e: unknown): { status: number; body: ApiErrorBody } {
  const err = e instanceof AppError ? e : new AppError('INTERNAL');
  const body: ApiErrorBody = { error: { code: err.code, message: MESSAGES[err.code] } };
  if (err.details.fields) body.error.fields = err.details.fields;
  if (err.details.retryAfterMs !== undefined) body.error.retryAfterMs = err.details.retryAfterMs;
  if (err.details.attemptsRemaining !== undefined) body.error.attemptsRemaining = err.details.attemptsRemaining;
  const requestId = currentRequestId();
  if (requestId) body.error.requestId = requestId;
  return { status: HTTP_STATUS[err.code], body };
}
