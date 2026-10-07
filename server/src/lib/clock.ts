import type { CalendarDate } from '@/domain/validation/dateOfBirth';

/** Injected everywhere so tests can move time; production uses the system clock. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/**
 * The calendar date in the product's time zone (Europe/Istanbul by default).
 * Introductions are per calendar day; ages are computed on this date.
 */
export function calendarDateIn(now: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

export function isoDateIn(now: Date, timeZone: string): string {
  const d = calendarDateIn(now, timeZone);
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
