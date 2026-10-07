import type { Country, CountryCode } from '../models';
import { searchBy } from '../text/search';
import { COUNTRIES_GENERATED } from './countries.generated';

export const DEFAULT_COUNTRY: CountryCode = 'TR';

/** Türkiye first (initial market), then alphabetical. */
export const COUNTRIES: readonly Country[] = [
  ...COUNTRIES_GENERATED.filter((c) => c.code === DEFAULT_COUNTRY),
  ...COUNTRIES_GENERATED.filter((c) => c.code !== DEFAULT_COUNTRY),
];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function countryByCode(code: CountryCode | null | undefined): Country | null {
  return code ? (BY_CODE.get(code) ?? null) : null;
}

/** Matches English and Turkish names, ISO code and calling code ("+49"). */
export function searchCountries(query: string): Country[] {
  const q = query.trim().replace(/^\+/, '');
  const results = searchBy(COUNTRIES, q, (c) => [c.name, c.nameTr, c.code, c.callingCode]);
  if (/^\d+$/.test(q)) {
    // Shared calling codes: the main country first (+44 → United Kingdom).
    const main = results.findIndex((c) => c.callingCode === q && c.primaryForCallingCode);
    if (main > 0) results.unshift(...results.splice(main, 1));
  }
  return results;
}
