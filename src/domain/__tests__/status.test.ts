import { canAccessMemberProduct } from '../admission/access';
import {
  APPLICATION_STATUSES,
  canEditStage1,
  canTransition,
  InvalidTransitionError,
  transition,
  TRANSITIONS,
  zoneForStatus,
  type ApplicationStatus,
} from '../admission/status';

describe('admission lifecycle', () => {
  it('declares a transition entry for every status', () => {
    for (const s of APPLICATION_STATUSES) expect(TRANSITIONS[s]).toBeDefined();
  });

  it('only allows transitions to known statuses', () => {
    for (const s of APPLICATION_STATUSES) {
      for (const t of TRANSITIONS[s]) expect(APPLICATION_STATUSES).toContain(t);
    }
  });

  it('follows the Stage 1 path: DRAFT → SUBMITTED → RECEIVED → UNDER_REVIEW', () => {
    let s: ApplicationStatus = 'UNAUTHENTICATED';
    s = transition(s, 'PHONE_VERIFICATION');
    s = transition(s, 'APPLICATION_DRAFT');
    s = transition(s, 'APPLICATION_SUBMITTED');
    s = transition(s, 'APPLICATION_RECEIVED');
    s = transition(s, 'UNDER_REVIEW');
    expect(s).toBe('UNDER_REVIEW');
  });

  it('never allows instant approval from any applicant pre-review state', () => {
    const preReview: ApplicationStatus[] = [
      'UNAUTHENTICATED',
      'PHONE_VERIFICATION',
      'APPLICATION_DRAFT',
      'APPLICATION_SUBMITTED',
      'APPLICATION_RECEIVED',
    ];
    for (const s of preReview) {
      expect(canTransition(s, 'APPROVED')).toBe(false);
      expect(canTransition(s, 'ACTIVE_MEMBER')).toBe(false);
    }
    expect(() => transition('APPLICATION_SUBMITTED', 'APPROVED')).toThrow(InvalidTransitionError);
  });

  it('only reaches APPROVED from FINAL_REVIEW', () => {
    const into = APPLICATION_STATUSES.filter((s) => TRANSITIONS[s].includes('APPROVED'));
    expect(into).toEqual(['FINAL_REVIEW']);
  });

  it('only reaches ACTIVE_MEMBER via payment or reinstatement', () => {
    const into = APPLICATION_STATUSES.filter((s) => TRANSITIONS[s].includes('ACTIVE_MEMBER'));
    expect(into.sort()).toEqual(['MEMBERSHIP_PAYMENT_REQUIRED', 'SUSPENDED']);
  });

  it('keeps Stage 1 editable only while drafting', () => {
    expect(APPLICATION_STATUSES.filter(canEditStage1)).toEqual(['APPLICATION_DRAFT']);
  });

  it('routes only ACTIVE_MEMBER into the member zone', () => {
    expect(APPLICATION_STATUSES.filter((s) => zoneForStatus(s) === 'member')).toEqual(['ACTIVE_MEMBER']);
    expect(zoneForStatus('APPLICATION_RECEIVED')).toBe('status');
    expect(zoneForStatus('APPROVED')).toBe('status');
    expect(zoneForStatus('APPLICATION_SUBMITTED')).toBe('apply');
  });
});

describe('member access guard', () => {
  it('denies every status except ACTIVE_MEMBER with an active membership', () => {
    for (const s of APPLICATION_STATUSES) {
      const allowed = canAccessMemberProduct(s, { status: 'active' });
      expect(allowed).toBe(s === 'ACTIVE_MEMBER');
    }
  });

  it('denies ACTIVE_MEMBER without a live membership record', () => {
    expect(canAccessMemberProduct('ACTIVE_MEMBER', null)).toBe(false);
    expect(canAccessMemberProduct('ACTIVE_MEMBER', { status: 'pending' })).toBe(false);
    expect(canAccessMemberProduct('ACTIVE_MEMBER', { status: 'expired' })).toBe(false);
    expect(canAccessMemberProduct('ACTIVE_MEMBER', { status: 'grace_period' })).toBe(true);
  });

  it('denies APPROVED applicants (approval is not membership)', () => {
    expect(canAccessMemberProduct('APPROVED', { status: 'active' })).toBe(false);
  });
});
