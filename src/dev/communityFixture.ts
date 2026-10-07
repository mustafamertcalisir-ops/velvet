/**
 * DEVELOPMENT / TEST ONLY — a small fixture community of members.
 *
 * Loaded only through a build-time conditional require in the mock member
 * server, so this module is not part of release bundles (checked by
 * scripts/check-release-bundle.mjs via the marker below). It contains no
 * imagery: QA photographs are supplied by the test harness at run time
 * (e2e/fixtures/members/) and never bundled (DEC-037).
 *
 * A varied private-community sample — people first, job titles second; no
 * caricatures (no billionaires, influencers, models, celebrities). Surnames
 * and dates of birth exist only as private application data, as for any member.
 */
import type { Intent } from '@/domain/admission/stage2';
import type { DatingGenderId, DatingGenderPreference } from '@/domain/member/dating';

export const COMMUNITY_FIXTURE_MARKER = 'velvet-community-fixture';

export type FixtureMember = {
  key: string;
  firstName: string;
  /** Private — never shown to members. */
  lastName: string;
  /** Private — members see derived age only. */
  dateOfBirth: string;
  countryCode: string;
  city: string;
  occupation: string;
  knownFor: string;
  interests: string[];
  intents: Intent[];
  /**
   * Private matching data, only with dating: the member's own stated identity
   * (self-described members choose the categories they appear under), who
   * they'd like to meet, and an age range. Never shown to other members.
   */
  dating?: {
    gender: DatingGenderId;
    selfDescription?: string;
    appearsAs?: DatingGenderPreference[];
    seeking: DatingGenderPreference[];
    ageRange: { min: number; max: number };
  };
  /** Curated order for the mock's daily introductions (lower first). */
  curation: number;
  /** The deterministic QA fixture: already likes whoever the test seeds it for. */
  admirer?: boolean;
};

export const COMMUNITY_FIXTURE: readonly FixtureMember[] = [
  {
    key: 'elif',
    firstName: 'Elif',
    lastName: 'Kaptanoğlu',
    dateOfBirth: '1995-06-02',
    countryCode: 'TR',
    city: 'İzmir',
    occupation: 'Chef',
    knownFor: 'Cooking only what the Alsancak market had that morning, at a ten-seat counter that closes when the fish runs out.',
    interests: ['Cooking', 'Wine', 'Sailing', 'Photography'],
    intents: ['friendship', 'community'],
    curation: 11,
  },
  {
    key: 'mert',
    firstName: 'Mert',
    lastName: 'Erdinç',
    dateOfBirth: '1990-01-23',
    countryCode: 'TR',
    city: 'Bodrum',
    occupation: 'Marine ecologist',
    knownFor: 'Mapping seagrass meadows along the Gökova coast with a small team of free divers and a very old boat.',
    interests: ['Diving', 'Science', 'Sailing'],
    intents: ['dating', 'community'],
    dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 28, max: 40 } },
    curation: 5,
  },
  {
    key: 'deniz',
    firstName: 'Deniz',
    lastName: 'Aksoylu',
    dateOfBirth: '1992-02-11',
    countryCode: 'TR',
    city: 'İstanbul',
    occupation: 'Architect',
    knownFor: 'Turning a 1920s tobacco warehouse in Tophane into a public library. Most evenings I’m still there, measuring the light.',
    interests: ['Architecture', 'Swimming', 'Jazz', 'Books'],
    intents: ['dating', 'friendship'],
    dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 27, max: 40 } },
    curation: 3,
    admirer: true,
  },
  {
    key: 'selin',
    firstName: 'Selin',
    lastName: 'Demirtaş',
    dateOfBirth: '1993-04-30',
    countryCode: 'TR',
    city: 'İstanbul',
    occupation: 'Documentary producer',
    knownFor: 'Two films about weaving cooperatives in Anatolia, and the very long dinners it took to get them made.',
    interests: ['Cinema', 'Photography', 'History', 'Travel'],
    intents: ['dating', 'friendship', 'community'],
    dating: { gender: 'WOMAN', seeking: ['MAN', 'WOMAN'], ageRange: { min: 29, max: 42 } },
    curation: 2,
  },
  {
    key: 'can',
    firstName: 'Can',
    lastName: 'Özbilgin',
    dateOfBirth: '1988-08-08',
    countryCode: 'TR',
    city: 'Ankara',
    occupation: 'Paediatric cardiologist',
    knownFor: 'Looking after very small hearts at a children’s hospital, and running the citadel walls before early shifts.',
    interests: ['Running', 'Hiking', 'Classical music'],
    intents: ['dating', 'friendship'],
    dating: { gender: 'MAN', seeking: ['WOMAN'], ageRange: { min: 30, max: 42 } },
    curation: 6,
  },
  {
    key: 'lara',
    firstName: 'Lara',
    lastName: 'Weiß-Güneş',
    dateOfBirth: '1993-01-15',
    countryCode: 'DE',
    city: 'Berlin',
    occupation: 'Type designer',
    knownFor: 'Drawing a typeface that sets Turkish, Greek and Armenian with the same care — ğ, ş and ı included.',
    interests: ['Design', 'Languages', 'Writing', 'Cinema'],
    intents: ['friendship', 'community'],
    curation: 12,
  },
  {
    key: 'emre',
    firstName: 'Emre',
    lastName: 'Tunçel',
    dateOfBirth: '1991-03-03',
    countryCode: 'FR',
    city: 'Paris',
    occupation: 'Composer',
    knownFor: 'Writing for string quartets, and for a small jazz trio that plays on Tuesdays in the eleventh.',
    interests: ['Classical music', 'Jazz', 'Poetry'],
    intents: ['dating', 'community'],
    dating: { gender: 'MAN', seeking: ['MAN'], ageRange: { min: 28, max: 40 } },
    curation: 7,
  },
  {
    key: 'zeynep',
    firstName: 'Zeynep',
    lastName: 'Arıkan',
    dateOfBirth: '1996-09-19',
    countryCode: 'GB',
    city: 'London',
    occupation: 'Ceramicist',
    knownFor: 'Repairing mid-century Kütahya ceramics in a small Hackney studio, with a waiting list of other people’s grandmothers’ plates.',
    interests: ['Ceramics', 'Art', 'Gardening'],
    intents: ['dating', 'community'],
    dating: {
      gender: 'SELF_DESCRIBED',
      selfDescription: 'Genderfluid',
      appearsAs: ['WOMAN', 'NON_BINARY'],
      seeking: ['WOMAN', 'MAN', 'NON_BINARY'],
      ageRange: { min: 26, max: 38 },
    },
    curation: 4,
  },
  {
    key: 'aylin',
    firstName: 'Aylin',
    lastName: 'Sarıgül',
    dateOfBirth: '1983-05-21',
    countryCode: 'TR',
    city: 'Bodrum',
    occupation: 'Novelist',
    knownFor: 'Three novels about the same Aegean village, each told by someone who never quite left.',
    interests: ['Books', 'Writing', 'Swimming', 'Wine'],
    intents: ['friendship', 'community'],
    curation: 13,
  },
  {
    key: 'kerem',
    firstName: 'Kerem',
    lastName: 'Yalçınkaya',
    dateOfBirth: '1994-11-02',
    countryCode: 'TR',
    city: 'İstanbul',
    occupation: 'Rowing coach',
    knownFor: 'Coaching a junior squad on the Golden Horn at six every morning, and teaching them to like the cold.',
    interests: ['Running', 'Swimming', 'Live music'],
    intents: ['dating', 'friendship'],
    dating: { gender: 'MAN', seeking: ['WOMAN', 'NON_BINARY'], ageRange: { min: 25, max: 36 } },
    curation: 1,
  },
];
