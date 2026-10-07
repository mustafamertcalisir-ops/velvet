/**
 * Date of birth — collected instead of age (DEC-004). Age is always derived.
 *
 * All arithmetic uses CALENDAR components (year/month/day), never epoch
 * milliseconds, so results do not drift with timezones or DST.
 */
import { invalid, valid, type Validation } from './result';

export type CalendarDate = { year: number; month: number; day: number }; // month 1–12

export const MINIMUM_AGE = 18;
const MAXIMUM_PLAUSIBLE_AGE = 110;

export type DobError =
  | 'incomplete'
  | 'impossible_date'
  | 'future_date'
  | 'implausible_date'
  | 'under_minimum_age';

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function isRealDate(d: CalendarDate): boolean {
  return (
    Number.isInteger(d.year) &&
    Number.isInteger(d.month) &&
    Number.isInteger(d.day) &&
    d.month >= 1 &&
    d.month <= 12 &&
    d.day >= 1 &&
    d.day <= daysInMonth(d.year, d.month)
  );
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * Completed years between dob and today: the year difference, minus one if
 * this year's (month, day) has not yet been reached. Standard calendar
 * arithmetic — no epoch milliseconds, so no timezone or DST drift.
 */
export function ageOn(dob: CalendarDate, today: CalendarDate): number {
  const birthdayReached =
    today.month > dob.month || (today.month === dob.month && today.day >= dob.day);
  return today.year - dob.year - (birthdayReached ? 0 : 1);
}

/** The applicant's local calendar date. Injected for testability. */
export function todayInLocalCalendar(now: Date = new Date()): CalendarDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

export function toISODate(d: CalendarDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function parseISODate(iso: string): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return isRealDate(d) ? d : null;
}

export type DobParts = { day: string; month: string; year: string };

export function validateDateOfBirth(
  parts: DobParts,
  today: CalendarDate,
): Validation<CalendarDate, DobError> {
  const digits = /^\d+$/;
  if (
    !digits.test(parts.day) ||
    !digits.test(parts.month) ||
    !/^\d{4}$/.test(parts.year)
  ) {
    return invalid('incomplete');
  }
  const d: CalendarDate = {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
  if (!isRealDate(d)) return invalid('impossible_date');
  if (compareDates(d, today) > 0) return invalid('future_date');
  const age = ageOn(d, today);
  if (age > MAXIMUM_PLAUSIBLE_AGE) return invalid('implausible_date');
  if (age < MINIMUM_AGE) return invalid('under_minimum_age');
  return valid(d);
}
