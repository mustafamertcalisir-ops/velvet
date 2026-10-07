import { APPLICATION_STATUSES } from '@/domain/admission/status';
import { EMPTY_DRAFT } from '@/domain/admission/stage1';
import { EMPTY_EXTENDED_DRAFT } from '@/domain/admission/stage2';
import type { Membership } from '@/domain/models';
import { effectiveZone, homeRoute } from '../routes';

const base = { draft: EMPTY_DRAFT, membership: null };
const activeMembership = { status: 'active' } as Membership;

describe('lifecycle → route', () => {
  it('maps pre-application states to auth and draft screens', () => {
    expect(homeRoute({ ...base, status: 'UNAUTHENTICATED' })).toBe('/');
    expect(homeRoute({ ...base, status: 'PHONE_VERIFICATION' })).toBe('/verify/code');
    expect(homeRoute({ ...base, status: 'APPLICATION_DRAFT' })).toBe('/apply/intro');
    expect(homeRoute({ ...base, status: 'APPLICATION_SUBMITTED' })).toBe('/apply/review');
  });

  it('sends an open extended application to its next unanswered step', () => {
    expect(homeRoute({ ...base, status: 'EXTENDED_APPLICATION_DRAFT', extendedDraft: EMPTY_EXTENDED_DRAFT })).toBe('/extended/intro');
    expect(
      homeRoute({ ...base, status: 'EXTENDED_APPLICATION_DRAFT', extendedDraft: { ...EMPTY_EXTENDED_DRAFT, introAcknowledged: true } }),
    ).toBe('/extended/photos');
    expect(homeRoute({ ...base, status: 'EXTENDED_APPLICATION_SUBMITTED', extendedDraft: EMPTY_EXTENDED_DRAFT })).toBe('/extended/review');
  });

  it('sends every other post-submission applicant state to the status screen', () => {
    for (const status of APPLICATION_STATUSES) {
      if (['UNAUTHENTICATED', 'PHONE_VERIFICATION', 'APPLICATION_DRAFT', 'APPLICATION_SUBMITTED', 'EXTENDED_APPLICATION_DRAFT', 'EXTENDED_APPLICATION_SUBMITTED'].includes(status)) continue;
      const href = homeRoute({ ...base, status });
      if (status === 'ACTIVE_MEMBER') continue;
      // Approved applicants who continued reach the membership activation shell (DEC-046).
      expect(href).toBe(status === 'MEMBERSHIP_PAYMENT_REQUIRED' ? '/membership' : '/application/status');
    }
  });

  it('never routes to /member without a live membership (no redirect loop)', () => {
    expect(homeRoute({ ...base, status: 'ACTIVE_MEMBER' })).toBe('/application/status');
    expect(effectiveZone({ ...base, status: 'ACTIVE_MEMBER' })).toBe('status');
    expect(homeRoute({ ...base, status: 'ACTIVE_MEMBER', membership: activeMembership })).toBe('/member');
    expect(homeRoute({ ...base, status: 'APPROVED', membership: activeMembership })).toBe('/application/status');
  });
});
