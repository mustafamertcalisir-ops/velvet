import type { PrivateApplicationData } from '../models';
import {
  createPublicProfile,
  derivePublicProfileSource,
  PRIVATE_APPLICATION_FIELDS,
  PUBLIC_PROFILE_FIELDS,
  PublicProfileNotAllowedError,
  type _NoPrivateFieldsOnPublicProfile,
} from '../profile/publicProfile';
import { APPLICATION_STATUSES } from '../admission/status';

// Compile-time: this line fails `tsc` if a private field is ever added to PublicMemberProfile.
const _assertion: _NoPrivateFieldsOnPublicProfile | undefined = undefined;

const privateData: PrivateApplicationData = {
  applicationId: 'app_1',
  firstName: 'Defne',
  lastName: 'Yıldırımoğlu',
  dateOfBirth: '1993-04-17',
  instagram: { kind: 'handle', handle: 'defne.private' },
  countryCode: 'TR',
  city: { kind: 'listed', cityId: 'TR-istanbul', label: 'İstanbul', region: null },
  referral: { kind: 'requested', referrals: [{ id: 'r1', name: 'Kerem Aksoy', phoneE164: '+905551112233' }] },
  occupation: 'Architect',
  workContext: null,
  workContextAnswer: null,
  workDescription: null,
  personalResponse: null,
  interests: ['Cinema'],
  intents: [],
  education: null,
  websiteUrl: null,
  portfolioUrl: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
};

const today = { year: 2026, month: 10, day: 3 };

describe('public profile projection', () => {
  it('shares no keys with private application fields', () => {
    expect(_assertion).toBeUndefined();
    for (const f of PRIVATE_APPLICATION_FIELDS) expect(PUBLIC_PROFILE_FIELDS).not.toContain(f);
  });

  it('never contains surname, DOB, Instagram, phone or referral values', () => {
    for (const policy of ['first_name', 'first_name_initial'] as const) {
      const profile = createPublicProfile({
        status: 'ACTIVE_MEMBER',
        id: 'pub_1',
        userId: 'usr_1',
        source: derivePublicProfileSource(privateData, today),
        policy,
        now: '2026-10-03T00:00:00.000Z',
      });
      const json = JSON.stringify(profile);
      expect(json).not.toContain('Yıldırımoğlu');
      expect(json).not.toContain('1993');
      expect(json).not.toContain('defne.private');
      expect(json).not.toContain('Kerem');
      expect(json).not.toContain('555');
      expect(Object.keys(profile).sort()).toEqual([...PUBLIC_PROFILE_FIELDS].sort());
      expect(profile.age).toBe(33);
    }
  });

  it('uses only an initial when the initial policy is chosen', () => {
    const profile = createPublicProfile({
      status: 'ACTIVE_MEMBER',
      id: 'p',
      userId: 'u',
      source: derivePublicProfileSource(privateData, today),
      policy: 'first_name_initial',
      now: 'x',
    });
    expect(profile.displayName).toBe('Defne Y.');
  });

  it('refuses to build a public profile for any non-member status', () => {
    for (const status of APPLICATION_STATUSES.filter((s) => s !== 'ACTIVE_MEMBER')) {
      expect(() =>
        createPublicProfile({
          status,
          id: 'p',
          userId: 'u',
          source: derivePublicProfileSource(privateData, today),
          policy: 'first_name',
          now: 'x',
        }),
      ).toThrow(PublicProfileNotAllowedError);
    }
  });
});
