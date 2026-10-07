/**
 * Member DTOs — the ONLY shapes in which one member's data reaches another
 * member's device (docs/PRIVACY_BOUNDARIES.md).
 *
 * Built field by field from a narrow row that is itself selected with an
 * explicit column list (PUBLIC_MEMBER_COLUMNS): the database row is never
 * passed through. A PublicMemberDTO never contains the surname, date of
 * birth, phone, Instagram, referral, Dating identity or preferences,
 * application answers, the account id, coordinates or review information.
 * Serialization tests (test/privacy.test.ts) check the exact key sets.
 */
import type { MemberCard, MemberPhoto, MemberProfileView, OwnMemberProfile } from '@/domain/member/views';
import type { Intent } from '@/domain/admission/stage2';

/** What another member may receive. Same shape the app already renders (MemberProfileView). */
export type PublicMemberDTO = MemberProfileView;

/**
 * The public columns, with age DERIVED in SQL from the private date of birth
 * ($2 = the product calendar date) — the date of birth itself never leaves
 * the database in a public read.
 */
export const PUBLIC_MEMBER_SELECT = `
  SELECT p.id, p.display_name, p.occupation, p.city_label, p.known_for, p.interests, p.intents,
         p.visibility, p.confirmed_at,
         date_part('year', age($2::date, d.date_of_birth))::int AS age
  FROM app.member_profiles p
  JOIN app.membership_applications a ON a.account_id = p.account_id
  JOIN app.application_private_data d ON d.application_id = a.id`;

export type PublicMemberRow = {
  id: string;
  display_name: string;
  occupation: string | null;
  city_label: string | null;
  known_for: string | null;
  interests: string[];
  intents: Intent[];
  visibility: 'visible' | 'paused' | 'hidden';
  confirmed_at: string | null;
  age: number;
};

export function toPublicMemberDTO(row: PublicMemberRow, photos: readonly MemberPhoto[]): PublicMemberDTO {
  return {
    memberId: row.id,
    displayName: row.display_name,
    age: row.age,
    occupation: row.occupation,
    cityLabel: row.city_label,
    knownFor: row.known_for,
    interests: [...row.interests],
    intents: [...row.intents],
    photos: photos.map((p) => ({ id: p.id, uri: p.uri, width: p.width, height: p.height })),
  };
}

export function toMemberCardDTO(row: PublicMemberRow, photos: readonly MemberPhoto[]): MemberCard {
  const first = photos[0];
  return {
    memberId: row.id,
    displayName: row.display_name,
    age: row.age,
    occupation: row.occupation,
    cityLabel: row.city_label,
    photo: first ? { id: first.id, uri: first.uri, width: first.width, height: first.height } : null,
  };
}

/** The member's own profile: the public view plus what only they need. */
export function toOwnProfileDTO(row: PublicMemberRow, photos: readonly MemberPhoto[]): OwnMemberProfile {
  return { ...toPublicMemberDTO(row, photos), confirmedAt: row.confirmed_at, visibility: row.visibility };
}
