/**
 * What member clients receive — explicit, field-by-field projections of the
 * server's member records. Nothing here can carry surname, date of birth,
 * phone, Instagram, referral, application answers, reviewer data, dating
 * preferences or coordinates: those are not inputs (DEC-049, DEC-018).
 *
 * Member profile ids are the only identifiers members see of each other —
 * never account (user) ids.
 */
import type { Intent } from '../admission/stage2';
import type { ISODateTime, MemberProfileMedia, PublicMemberProfile } from '../models';
import { intentLine, joinNatural, type ProfilePresentation } from '../profile/profilePresentation';

export type MemberPhoto = { id: string; uri: string; width: number; height: number };

/** A compact reference to another member (lists, headers, match moment). */
export type MemberCard = {
  memberId: string;
  displayName: string;
  age: number;
  occupation: string | null;
  cityLabel: string | null;
  photo: MemberPhoto | null;
};

/** A member's full profile as another member sees it. */
export type MemberProfileView = {
  memberId: string;
  displayName: string;
  age: number;
  occupation: string | null;
  cityLabel: string | null;
  knownFor: string | null;
  interests: string[];
  intents: Intent[];
  photos: MemberPhoto[];
};

/** The member's own profile: the same view, plus what only they need. */
export type OwnMemberProfile = MemberProfileView & {
  confirmedAt: ISODateTime | null;
  visibility: PublicMemberProfile['visibility'];
};

/** The exact keys another member can receive. Tested to never grow private fields. */
export const MEMBER_VIEW_FIELDS = [
  'memberId',
  'displayName',
  'age',
  'occupation',
  'cityLabel',
  'knownFor',
  'interests',
  'intents',
  'photos',
] as const satisfies readonly (keyof MemberProfileView)[];

type AssertNever<T extends never> = T;
export type _MemberViewWhitelistIsComplete = AssertNever<
  Exclude<keyof MemberProfileView, (typeof MEMBER_VIEW_FIELDS)[number]>
>;
type ForbiddenOnView =
  | 'lastName'
  | 'dateOfBirth'
  | 'phoneE164'
  | 'instagram'
  | 'referral'
  | 'userId'
  | 'personalResponse'
  | 'datingPreferences'
  | 'ageRange'
  | 'meet'
  | 'latitude'
  | 'longitude';
export type _NoPrivateFieldsOnMemberView = AssertNever<Extract<keyof MemberProfileView, ForbiddenOnView>>;

function photosOf(media: readonly MemberProfileMedia[]): MemberPhoto[] {
  return [...media]
    .filter((m) => m.type === 'photo' && m.order >= 0)
    .sort((a, b) => a.order - b.order)
    .map((m) => ({ id: m.id, uri: m.storageKey, width: m.width ?? 0, height: m.height ?? 0 }));
}

export function projectMemberProfile(
  profile: PublicMemberProfile,
  media: readonly MemberProfileMedia[],
  age: number,
): MemberProfileView {
  // Explicit construction — never spread a record into a view.
  return {
    memberId: profile.id,
    displayName: profile.displayName,
    age,
    occupation: profile.occupation,
    cityLabel: profile.cityLabel,
    knownFor: profile.knownFor,
    interests: [...profile.interests],
    intents: [...profile.intents],
    photos: photosOf(media),
  };
}

export function projectOwnProfile(
  profile: PublicMemberProfile,
  media: readonly MemberProfileMedia[],
  age: number,
): OwnMemberProfile {
  return {
    ...projectMemberProfile(profile, media, age),
    confirmedAt: profile.confirmedAt,
    visibility: profile.visibility,
  };
}

export function projectMemberCard(
  profile: PublicMemberProfile,
  media: readonly MemberProfileMedia[],
  age: number,
): MemberCard {
  return {
    memberId: profile.id,
    displayName: profile.displayName,
    age,
    occupation: profile.occupation,
    cityLabel: profile.cityLabel,
    photo: photosOf(media)[0] ?? null,
  };
}

/** The shared profile presentation (DEC-034) for a member profile. */
export function memberPresentation(view: MemberProfileView, and = 'and'): ProfilePresentation {
  return {
    firstName: view.displayName,
    age: view.age,
    occupation: view.occupation,
    cityLabel: view.cityLabel,
    intentLine: intentLine(view.intents),
    knownFor: view.knownFor,
    interestsLine: view.interests.length ? joinNatural(view.interests, and) : null,
    media: view.photos.map((p) => ({ kind: 'photo', id: p.id, uri: p.uri, width: p.width, height: p.height })),
  };
}

// --- Editable fields (member-owned) -------------------------------------------------

/**
 * What a member may change on their own profile. Application records are not
 * reachable from here: the application, its decision, referral and reviewer
 * data stay as they were (DEC-049).
 */
export type MemberProfilePatch = {
  occupation?: string;
  cityLabel?: string;
  knownFor?: string;
  interests?: string[];
  /** New photo order (member media ids). Photos not listed are removed from the profile. */
  photoOrder?: string[];
};
