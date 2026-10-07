/**
 * The ONLY sanctioned way to build a PublicMemberProfile.
 *
 * It takes a narrow, explicitly-whitelisted source — never the private
 * application object — so private fields cannot be spread in by accident.
 * See docs/TRUST_AND_PRIVACY.md "Potential Public Member Data".
 */
import { INTENTS, type Intent } from '../admission/stage2';
import type { ApplicationStatus } from '../admission/status';
import type { PrivateApplicationData, PublicMemberProfile } from '../models';
import { ageOn, parseISODate, type CalendarDate } from '../validation/dateOfBirth';

/** Private application fields that must never reach a public model. */
export const PRIVATE_APPLICATION_FIELDS = [
  'lastName',
  'dateOfBirth',
  'instagram',
  'referral',
  'countryCode',
  'city',
] as const satisfies readonly (keyof PrivateApplicationData)[];

export type PrivateApplicationField = (typeof PRIVATE_APPLICATION_FIELDS)[number];

/** Fields a public profile is allowed to carry. Compile-time checked below. */
export const PUBLIC_PROFILE_FIELDS = [
  'id',
  'userId',
  'displayName',
  'age',
  'occupation',
  'cityLabel',
  'bio',
  'knownFor',
  'interests',
  'intents',
  'visibility',
  'confirmedAt',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof PublicMemberProfile)[];

// Compile-time guarantees: the public model shares no key with the private
// fields, and PUBLIC_PROFILE_FIELDS covers the model exactly.
/** Private matching data (DEC-040) is never part of a public profile either. */
type MatchingField = 'meet' | 'ageRange' | 'datingPreferences';
type Overlap = Extract<keyof PublicMemberProfile, PrivateApplicationField | MatchingField | 'phoneE164'>;
type AssertNever<T extends never> = T;
export type _NoPrivateFieldsOnPublicProfile = AssertNever<Overlap>;
type MissingFromWhitelist = Exclude<keyof PublicMemberProfile, (typeof PUBLIC_PROFILE_FIELDS)[number]>;
export type _WhitelistIsComplete = AssertNever<MissingFromWhitelist>;

const STATUSES_WITH_PUBLIC_PROFILE: readonly ApplicationStatus[] = ['ACTIVE_MEMBER'];

export class PublicProfileNotAllowedError extends Error {
  constructor(status: ApplicationStatus) {
    super(`A public profile cannot exist in status ${status}`);
    this.name = 'PublicProfileNotAllowedError';
  }
}

export type DisplayNamePolicy = 'first_name' | 'first_name_initial';

/** The explicit, narrow input to a public profile. */
export type PublicProfileSource = {
  firstName: string;
  /** Only the INITIAL is ever read, and only under the 'first_name_initial' policy. */
  lastNameInitial: string | null;
  age: number;
  occupation: string | null;
  cityLabel: string | null;
  bio: string | null;
  knownFor: string | null;
  interests: readonly string[];
  intents: readonly Intent[];
};

/**
 * Derive the narrow source from private data. Last name → at most an initial;
 * DOB → age; city → label only (no coordinates, no IDs).
 */
export function derivePublicProfileSource(
  data: Pick<
    PrivateApplicationData,
    'firstName' | 'lastName' | 'dateOfBirth' | 'city' | 'occupation' | 'interests'
  > &
    Partial<Pick<PrivateApplicationData, 'workDescription' | 'intents'>>,
  today: CalendarDate,
): PublicProfileSource {
  const dob = parseISODate(data.dateOfBirth);
  if (!dob) throw new Error('Invalid date of birth on application');
  const initial = data.lastName.trim().charAt(0);
  return {
    firstName: data.firstName.trim(),
    lastNameInitial: initial ? initial.toLocaleUpperCase('tr-TR') : null,
    age: ageOn(dob, today),
    occupation: data.occupation,
    cityLabel: data.city.label,
    bio: null,
    knownFor: data.workDescription ?? null,
    interests: [...data.interests],
    intents: (data.intents ?? []).filter((i): i is Intent => (INTENTS as readonly string[]).includes(i)),
  };
}

export function createPublicProfile(args: {
  status: ApplicationStatus;
  id: string;
  userId: string;
  source: PublicProfileSource;
  policy: DisplayNamePolicy;
  now: string;
}): PublicMemberProfile {
  const { status, id, userId, source, policy, now } = args;
  if (!STATUSES_WITH_PUBLIC_PROFILE.includes(status)) {
    throw new PublicProfileNotAllowedError(status);
  }
  const displayName =
    policy === 'first_name_initial' && source.lastNameInitial
      ? `${source.firstName} ${source.lastNameInitial}.`
      : source.firstName;

  // Explicit field-by-field construction. Do not use object spread here.
  return {
    id,
    userId,
    displayName,
    age: source.age,
    occupation: source.occupation,
    cityLabel: source.cityLabel,
    bio: source.bio,
    knownFor: source.knownFor,
    interests: [...source.interests],
    intents: [...source.intents],
    visibility: 'visible',
    confirmedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
