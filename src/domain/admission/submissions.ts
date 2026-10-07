/**
 * Server-side validation of applicant submissions — shared by the mock
 * server and the production API (server/src/admission/), so both enforce the
 * same rules on the same input.
 *
 * Input is UNTRUSTED (it arrived over the network): every field is
 * type-checked before a validator runs, and the result is the normalised
 * value the server stores — never the raw payload.
 */
import type { CityAnswer, ReferralAnswer, Stage1Submission } from '../models';
import { countryByCode } from '../geo/countries';
import { ageOn, parseISODate, validateDateOfBirth, type CalendarDate } from '../validation/dateOfBirth';
import { normalizeInstagram } from '../validation/instagram';
import { validateName, validatePlaceName } from '../validation/name';
import { MAX_REFERRALS } from './stage1';
import {
  ABOUT_YOU_MAX,
  PHOTO_MAX,
  PHOTO_MIN,
  WHAT_YOU_DO_MAX,
  validateDatingPreferences,
  validateInterests,
  validateIntents,
  validateLongText,
  validateShortText,
  validateWorkContext,
  type DatingPreferences,
  type Intent,
  type Stage2Submission,
  type WorkContextAnswer,
} from './stage2';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);

export const E164 = /^\+\d{6,15}$/;

export type SubmissionResult<T> = { ok: true; value: T } | { ok: false; fields: string[] };

/** Stage 1: the short application. Returns the normalised submission. */
export function validateStage1Submission(input: unknown, today: CalendarDate): SubmissionResult<Stage1Submission> {
  const s = obj(input) ?? {};
  const bad = new Set<string>();

  const first = validateName(str(s.firstName) ?? '');
  if (!first.ok) bad.add('firstName');
  const last = validateName(str(s.lastName) ?? '');
  if (!last.ok) bad.add('lastName');

  const dobRaw = str(s.dateOfBirth) ?? '';
  const dob = parseISODate(dobRaw);
  if (!dob || !validateDateOfBirth({ day: String(dob.day), month: String(dob.month), year: String(dob.year) }, today).ok) {
    bad.add('dateOfBirth');
  }

  const ig = obj(s.instagram);
  const handle = ig?.kind === 'handle' ? normalizeInstagram(str(ig.handle) ?? '') : null;
  if (!handle?.ok) bad.add('instagram');

  const countryCode = str(s.countryCode) ?? '';
  if (!countryByCode(countryCode)) bad.add('countryCode');

  const c = obj(s.city);
  let city: CityAnswer | null = null;
  const label = c ? validatePlaceName(str(c.label) ?? '') : null;
  if (!c || !label?.ok) bad.add('city');
  else if (c.kind === 'listed') {
    const cityId = str(c.cityId) ?? '';
    if (!cityId.startsWith(`${countryCode}-`)) bad.add('city');
    else city = { kind: 'listed', cityId, label: label.value, region: str(c.region) };
  } else if (c.kind === 'other') city = { kind: 'other', label: label.value };
  else bad.add('city');

  const r = obj(s.referral);
  let referral: ReferralAnswer | null = null;
  if (r?.kind === 'none') referral = { kind: 'none' };
  else if (r?.kind === 'requested' && Array.isArray(r.referrals)) {
    const list = r.referrals.map(obj);
    if (list.length === 0 || list.length > MAX_REFERRALS) bad.add('referral');
    const referrals = list.map((x, i) => {
      const name = validateName(str(x?.name) ?? '');
      const phone = str(x?.phoneE164) ?? '';
      if (!name.ok || !E164.test(phone)) bad.add('referral');
      return { id: str(x?.id) ?? `r${i + 1}`, name: name.ok ? name.value : '', phoneE164: phone };
    });
    referral = { kind: 'requested', referrals };
  } else bad.add('referral');

  if (bad.size || !first.ok || !last.ok || !handle?.ok || !city || !referral) return { ok: false, fields: [...bad] };
  return {
    ok: true,
    value: {
      firstName: first.value,
      lastName: last.value,
      dateOfBirth: dobRaw,
      instagram: { kind: 'handle', handle: handle.value },
      countryCode,
      city,
      referral,
    },
  };
}

export type ValidStage2 = {
  photoIds: string[];
  occupation: string;
  workContext: WorkContextAnswer;
  /** Display form of the work context ("Studio X", "Independent"). */
  workContextLabel: string | null;
  whatYouDo: string;
  aboutYou: string;
  interests: string[];
  intents: Intent[];
  datingPreferences: DatingPreferences | null;
};

/** Stage 2: the extended application. `ownsPhoto` checks each photo belongs to this application. */
export function validateStage2Submission(
  input: unknown,
  ctx: { ownsPhoto: (mediaId: string) => boolean },
): SubmissionResult<ValidStage2> {
  const s = obj(input) ?? {};
  const bad = new Set<string>();

  const ids = [...new Set(strings(s.photoIds) ?? [])];
  if (ids.length < PHOTO_MIN || ids.length > PHOTO_MAX || ids.some((id) => !ctx.ownsPhoto(id))) bad.add('photos');

  const occupation = validateShortText(str(s.occupation) ?? '');
  if (!occupation.ok) bad.add('occupation');

  const w = obj(s.workContext);
  const workInput: WorkContextAnswer | null =
    w?.kind === 'organisation'
      ? { kind: 'organisation', name: str(w.name) ?? '' }
      : w?.kind === 'independent'
        ? { kind: 'independent' }
        : w?.kind === 'not_shared'
          ? { kind: 'not_shared' }
          : null;
  const work = workInput ? validateWorkContext(workInput) : null;
  if (!work?.ok) bad.add('workContext');

  const whatYouDo = validateLongText(str(s.whatYouDo) ?? '', WHAT_YOU_DO_MAX);
  if (!whatYouDo.ok) bad.add('whatYouDo');
  const aboutYou = validateLongText(str(s.aboutYou) ?? '', ABOUT_YOU_MAX);
  if (!aboutYou.ok) bad.add('aboutYou');
  const interests = validateInterests(strings(s.interests) ?? []);
  if (!interests.ok) bad.add('interests');
  const intents = validateIntents(strings(s.intents) ?? []);
  if (!intents.ok) bad.add('intents');

  // Dating preferences: required with Dating, refused without it (DEC-040).
  const p = s.datingPreferences === null || s.datingPreferences === undefined ? null : obj(s.datingPreferences);
  const range = obj(p?.ageRange);
  const prefsInput: DatingPreferences | null = p
    ? { meet: strings(p.meet) ?? [], ageRange: { min: Number(range?.min), max: Number(range?.max) } }
    : null;
  const prefs = validateDatingPreferences(intents.ok ? intents.value : (strings(s.intents) ?? []), prefsInput);
  if (!prefs.ok || (p === null && s.datingPreferences !== null && s.datingPreferences !== undefined)) bad.add('datingPreferences');

  if (bad.size || !occupation.ok || !work?.ok || !whatYouDo.ok || !aboutYou.ok || !interests.ok || !intents.ok || !prefs.ok) {
    return { ok: false, fields: [...bad] };
  }
  return {
    ok: true,
    value: {
      photoIds: ids,
      occupation: occupation.value,
      workContext: work.value,
      workContextLabel:
        work.value.kind === 'organisation' ? work.value.name : work.value.kind === 'independent' ? 'Independent' : null,
      whatYouDo: whatYouDo.value,
      aboutYou: aboutYou.value,
      interests: interests.value,
      intents: intents.value,
      datingPreferences: prefs.value,
    },
  };
}

/** The applicant's display summary: first name, derived age, city label — never the date of birth. */
export function applicantAge(dateOfBirth: string, today: CalendarDate): number | null {
  const dob = parseISODate(dateOfBirth);
  return dob ? ageOn(dob, today) : null;
}

export type { Stage2Submission };
