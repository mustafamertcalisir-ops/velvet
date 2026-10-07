import {
  AsYouType,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode as LibCountryCode,
} from 'libphonenumber-js/min';

import { invalid, valid, type Validation } from './result';

export type PhoneError = 'required' | 'invalid_number';

export type ParsedPhone = {
  e164: string;
  countryCode: string;
  /** Formatted for display to the OWNER of the number only. */
  international: string;
};

export function validatePhone(national: string, countryIso: string): Validation<ParsedPhone, PhoneError> {
  const digits = national.replace(/[^\d+]/g, '');
  if (!digits) return invalid('required');
  const parsed = parsePhoneNumberFromString(national, countryIso as LibCountryCode);
  if (!parsed || !parsed.isValid()) return invalid('invalid_number');
  return valid({
    e164: parsed.number,
    countryCode: parsed.country ?? countryIso,
    international: parsed.formatInternational(),
  });
}

export function formatAsYouType(national: string, countryIso: string): string {
  return new AsYouType(countryIso as LibCountryCode).input(national);
}

export function callingCodeFor(countryIso: string): string | null {
  try {
    return getCountryCallingCode(countryIso as LibCountryCode);
  } catch {
    return null;
  }
}

export function formatE164ForOwner(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

/**
 * Masked form for numbers the applicant entered about OTHER people
 * (referrals): keep the country code and the last two digits only.
 */
export function maskPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return '•••';
  const national = parsed.nationalNumber;
  const tail = national.slice(-2);
  return `+${parsed.countryCallingCode} ••• ${tail}`;
}
