import { copy } from '@/copy/en';
import { LONG_TEXT_MIN, type LongTextError, type ShortTextError } from '@/domain/admission/stage2';

/** Human copy for Stage 2 text validation errors. */
export function extendedTextError(error: ShortTextError | LongTextError | 'not_allowed'): string | null {
  switch (error) {
    case 'required':
      return copy.extended.errors.required;
    case 'too_short':
      return copy.extended.errors.too_short(LONG_TEXT_MIN);
    case 'too_long':
      return copy.extended.errors.too_long;
    case 'invalid_characters':
      return copy.extended.errors.invalid_characters;
    default:
      return null;
  }
}
