import { invalid, valid, type Validation } from './result';

export type NameError = 'required' | 'too_long' | 'invalid_characters';

export const NAME_MAX_LENGTH = 50;

/**
 * Letters from any script (incl. Turkish Ç Ğ İ ı Ö Ş Ü), combining marks,
 * single spaces, apostrophes (' ’), hyphens and the middle dot used in some
 * names. No digits, no emoji, no leading/trailing punctuation.
 */
const NAME_PATTERN = /^[\p{L}\p{M}]+(?:[ '’\-·][\p{L}\p{M}]+)*\.?$/u;

/** Trim and collapse internal whitespace. Never changes letter case. */
export function normalizeName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function validateName(raw: string): Validation<string, NameError> {
  const value = normalizeName(raw);
  if (value.length === 0) return invalid('required');
  if (value.length > NAME_MAX_LENGTH) return invalid('too_long');
  if (!NAME_PATTERN.test(value)) return invalid('invalid_characters');
  return valid(value);
}

export type CityLabelError = 'required' | 'too_long' | 'invalid_characters';

const PLACE_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '’\-.,()]*$/u;

export function validatePlaceName(raw: string): Validation<string, CityLabelError> {
  const value = normalizeName(raw);
  if (value.length < 2) return invalid('required');
  if (value.length > 60) return invalid('too_long');
  if (!PLACE_PATTERN.test(value)) return invalid('invalid_characters');
  return valid(value);
}
