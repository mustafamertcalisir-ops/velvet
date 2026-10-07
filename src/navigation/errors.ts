import { copy } from '@/copy/en';
import type { ActionError } from '@/state/admission/store';

/** Fallback, non-technical description for errors a screen doesn't special-case. */
export function describeApiError(error: ActionError): string {
  switch (error.kind) {
    case 'network':
      return copy.common.networkError;
    case 'invalid_code':
      return copy.otp.errors.invalid_code;
    case 'code_expired':
      return copy.otp.errors.code_expired;
    case 'too_many_attempts':
      return copy.otp.errors.too_many_attempts;
    case 'invalid_phone':
      return copy.phone.errors.invalid_number;
    case 'code_not_sent':
      return copy.phone.errors.code_not_sent;
    case 'rate_limited':
      return copy.phone.errors.rate_limited(Math.ceil(error.retryAfterMs / 1000));
    case 'incomplete':
      return copy.review.incomplete;
    default:
      return copy.common.networkError;
  }
}
