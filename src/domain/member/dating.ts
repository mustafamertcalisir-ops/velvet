/**
 * Member dating identity and preferences — private matching data (DEC-058).
 *
 * Asked only of members who chose Dating, after activation. The member
 * states it themselves; nothing here is ever inferred from a name, photos,
 * Instagram, reviewer judgement, AI or profile content.
 *
 * Two layers, so the taxonomy can evolve without rewriting matching data:
 *   gender         — how the member describes themselves (WOMAN, MAN,
 *                    NON_BINARY, or SELF_DESCRIBED with private free text)
 *   appearsAs      — the normalised matching categories the member is
 *                    included under. Derived for the fixed answers; chosen
 *                    explicitly by a self-described member. Free text is never
 *                    classified.
 *   seeking        — the categories the member would like to meet.
 *                    "Everyone" is simply all categories selected.
 */
import { AGE_PREFERENCE_MAX, AGE_PREFERENCE_MIN, validateAgeRange, type AgeRange, type MeetOptionId } from '../admission/stage2';
import type { ISODateTime } from '../models';
import { invalid, valid, type Validation } from '../validation/result';

export const DATING_GENDERS = ['WOMAN', 'MAN', 'NON_BINARY', 'SELF_DESCRIBED'] as const;
export type DatingGenderId = (typeof DATING_GENDERS)[number];

/** Normalised matching categories — used for both "appears as" and "seeking". */
export const DATING_CATEGORIES = ['WOMAN', 'MAN', 'NON_BINARY'] as const;
export type DatingGenderPreference = (typeof DATING_CATEGORIES)[number];

export const SELF_DESCRIPTION_MAX = 40;

export type DatingIdentity = {
  gender: DatingGenderId;
  /** Only with SELF_DESCRIBED. Private; never shown to anyone, never classified. */
  selfDescription: string | null;
  /** The categories this member is included under when others look to meet. */
  appearsAs: DatingGenderPreference[];
};

/** The member-owned matching record (one per member using Dating). */
export type DatingSettings = {
  identity: DatingIdentity | null;
  seeking: DatingGenderPreference[];
  ageRange: AgeRange | null;
  /** When the member last completed Dating setup or saved Dating preferences. */
  setupCompletedAt: ISODateTime | null;
};

export type DatingSettingsInput = {
  gender: DatingGenderId;
  selfDescription?: string | null;
  /** Required (one or more) for SELF_DESCRIBED; ignored otherwise. */
  appearsAs?: DatingGenderPreference[];
  seeking: DatingGenderPreference[];
  ageRange: AgeRange;
};

export const isDatingGender = (v: unknown): v is DatingGenderId =>
  typeof v === 'string' && (DATING_GENDERS as readonly string[]).includes(v);
export const isDatingCategory = (v: unknown): v is DatingGenderPreference =>
  typeof v === 'string' && (DATING_CATEGORIES as readonly string[]).includes(v);

/** Categories in a fixed order, de-duplicated. */
export function orderedCategories(list: readonly DatingGenderPreference[]): DatingGenderPreference[] {
  return DATING_CATEGORIES.filter((c) => list.includes(c));
}

export function isEveryone(seeking: readonly DatingGenderPreference[]): boolean {
  return DATING_CATEGORIES.every((c) => seeking.includes(c));
}

/**
 * The application asked "who would you like to meet?" as catalogue ids
 * (DEC-040). The member record stores normalised categories: "everyone"
 * becomes every category.
 */
export function seekingFromMeet(meet: readonly MeetOptionId[]): DatingGenderPreference[] {
  const out = new Set<DatingGenderPreference>();
  for (const id of meet) {
    if (id === 'everyone') DATING_CATEGORIES.forEach((c) => out.add(c));
    else if (id === 'women') out.add('WOMAN');
    else if (id === 'men') out.add('MAN');
    else if (id === 'non_binary') out.add('NON_BINARY');
  }
  return orderedCategories([...out]);
}

export type DatingIdentityError =
  | 'gender_required'
  | 'description_required'
  | 'description_too_long'
  | 'categories_required';

export function normalizeSelfDescription(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Fixed answers map to their own category; a self-described member chooses. */
export function validateDatingIdentity(input: {
  gender: unknown;
  selfDescription?: unknown;
  appearsAs?: unknown;
}): Validation<DatingIdentity, DatingIdentityError> {
  if (!isDatingGender(input.gender)) return invalid('gender_required');
  if (input.gender !== 'SELF_DESCRIBED') {
    return valid({ gender: input.gender, selfDescription: null, appearsAs: [input.gender] });
  }
  const text = typeof input.selfDescription === 'string' ? normalizeSelfDescription(input.selfDescription) : '';
  if (!text) return invalid('description_required');
  if (text.length > SELF_DESCRIPTION_MAX) return invalid('description_too_long');
  const chosen = Array.isArray(input.appearsAs) ? input.appearsAs.filter(isDatingCategory) : [];
  if (chosen.length === 0) return invalid('categories_required');
  return valid({ gender: 'SELF_DESCRIBED', selfDescription: text, appearsAs: orderedCategories(chosen) });
}

export function validateSeeking(list: unknown): Validation<DatingGenderPreference[], 'required'> {
  const chosen = Array.isArray(list) ? list.filter(isDatingCategory) : [];
  if (chosen.length === 0) return invalid('required');
  return valid(orderedCategories(chosen));
}

export type DatingSettingsField = 'gender' | 'selfDescription' | 'appearsAs' | 'seeking' | 'ageRange';

/** Server-side validation of a full Dating setup / preferences save. */
export function validateDatingSettingsInput(
  input: Partial<DatingSettingsInput> | null | undefined,
): { ok: true; value: { identity: DatingIdentity; seeking: DatingGenderPreference[]; ageRange: AgeRange } } | { ok: false; fields: DatingSettingsField[] } {
  const bad: DatingSettingsField[] = [];
  const identity = validateDatingIdentity({
    gender: input?.gender,
    selfDescription: input?.selfDescription,
    appearsAs: input?.appearsAs,
  });
  if (!identity.ok) {
    bad.push(
      identity.error === 'gender_required'
        ? 'gender'
        : identity.error === 'categories_required'
          ? 'appearsAs'
          : 'selfDescription',
    );
  }
  const seeking = validateSeeking(input?.seeking);
  if (!seeking.ok) bad.push('seeking');
  const range =
    input?.ageRange && typeof input.ageRange === 'object'
      ? validateAgeRange({ min: Number(input.ageRange.min), max: Number(input.ageRange.max) })
      : invalid('invalid' as const);
  if (!range.ok) bad.push('ageRange');
  if (bad.length || !identity.ok || !seeking.ok || !range.ok) return { ok: false, fields: bad };
  return { ok: true, value: { identity: identity.value, seeking: seeking.value, ageRange: range.value } };
}

/** Dating setup is needed when the member uses Dating and has not stated their identity yet. */
export function datingSetupRequired(intents: readonly string[], settings: Pick<DatingSettings, 'identity'> | null): boolean {
  return intents.includes('dating') && !settings?.identity;
}

export const DATING_AGE_BOUNDS = { min: AGE_PREFERENCE_MIN, max: AGE_PREFERENCE_MAX } as const;
