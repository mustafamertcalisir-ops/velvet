/**
 * Profile presentation — what a profile SHOWS, independent of where the data
 * came from (applicant preview today, member profile in Phase 6).
 *
 * Media is a sequence of items so the same frame can later hold several
 * photos, a short video, and (if a product decision allows) audio. Only
 * photos are produced today.
 */
import type { ApplicationPhoto, ExtendedDraft, Intent } from '../admission/stage2';
import type { ApplicantSummary } from '../models';

export type ProfileMediaItem =
  | { kind: 'photo'; id: string; uri: string; width: number; height: number }
  | { kind: 'video'; id: string; uri: string; posterUri: string; width: number; height: number; durationMs: number };

/** Everything a profile can display — and nothing else. */
export type ProfilePresentation = {
  firstName: string;
  age: number | null;
  occupation: string | null;
  cityLabel: string | null;
  intentLine: string | null;
  knownFor: string | null;
  interestsLine: string | null;
  media: ProfileMediaItem[];
};

export function mediaFromPhotos(photos: readonly ApplicationPhoto[]): ProfileMediaItem[] {
  return photos.map((p) => ({ kind: 'photo', id: p.id, uri: p.uri, width: p.width, height: p.height }));
}

/** "Architecture, Swimming and Jazz". */
export function joinNatural(items: readonly string[], and = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

const INTENT_NOUN: Record<Intent, string> = {
  dating: 'dating',
  friendship: 'friendship',
  community: 'community',
};

/** "friendship and community" — intents in a fixed order, as one phrase. */
export function intentPhrase(intents: readonly Intent[]): string | null {
  if (!intents.length) return null;
  const ordered = (['dating', 'friendship', 'community'] as const).filter((i) => intents.includes(i));
  return joinNatural(ordered.map((i) => INTENT_NOUN[i]));
}

/** One sentence instead of tags: "Here for friendship and community". */
export function intentLine(intents: readonly Intent[]): string | null {
  const phrase = intentPhrase(intents);
  return phrase ? `Here for ${phrase}` : null;
}

/**
 * Build the applicant's profile preview from an explicit whitelist.
 * Takes no surname, date of birth, phone, Instagram, referral or reviewer data —
 * they are not parameters, so they cannot leak in.
 */
export function buildProfilePreview(input: {
  summary: ApplicantSummary | null;
  fallbackFirstName: string | null;
  fallbackCity: string | null;
  extended: Pick<ExtendedDraft, 'photos' | 'occupation' | 'whatYouDo' | 'interests' | 'intents'>;
}): ProfilePresentation {
  const { summary, extended } = input;
  return {
    firstName: summary?.firstName ?? input.fallbackFirstName ?? '',
    age: summary?.age ?? null,
    occupation: extended.occupation,
    cityLabel: summary?.cityLabel ?? input.fallbackCity,
    intentLine: intentLine(extended.intents),
    knownFor: extended.whatYouDo,
    interestsLine: extended.interests.length ? joinNatural(extended.interests) : null,
    media: mediaFromPhotos(extended.photos),
  };
}
