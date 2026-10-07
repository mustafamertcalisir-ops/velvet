import {
  assembleStage1,
  canOpenStep,
  EMPTY_DRAFT,
  retainAfterSubmission,
  sanitizeDraft,
  resumeStep,
  STAGE1_QUESTION_STEPS,
  type ApplicationDraft,
} from '../admission/stage1';

const today = { year: 2026, month: 10, day: 3 };

const complete: ApplicationDraft = {
  introAcknowledged: true,
  firstName: 'Ece',
  lastName: 'Demir',
  dateOfBirth: '1995-06-01',
  instagram: { kind: 'handle', handle: 'ece.demir' },
  countryCode: 'TR',
  city: { kind: 'listed', cityId: 'TR-izmir', label: 'İzmir', region: null },
  referral: { kind: 'none' },
  updatedAt: null,
};

describe('Stage 1 steps', () => {
  it('has seven single-question steps between intro and review', () => {
    expect(STAGE1_QUESTION_STEPS).toEqual([
      'first-name',
      'last-name',
      'date-of-birth',
      'instagram',
      'country',
      'city',
      'referral',
    ]);
  });

  it('resumes at the first missing answer', () => {
    expect(resumeStep(EMPTY_DRAFT, today)).toBe('intro');
    expect(resumeStep({ ...complete, instagram: null }, today)).toBe('instagram');
    expect(resumeStep(complete, today)).toBe('review');
  });

  it('prevents deep-linking past unanswered steps', () => {
    expect(canOpenStep(EMPTY_DRAFT, 'review', today)).toBe(false);
    expect(canOpenStep({ ...EMPTY_DRAFT, introAcknowledged: true }, 'first-name', today)).toBe(true);
    expect(canOpenStep({ ...EMPTY_DRAFT, introAcknowledged: true }, 'last-name', today)).toBe(false);
  });

  it('re-validates age when assembling (a stale draft cannot bypass 18+)', () => {
    const result = assembleStage1({ ...complete, dateOfBirth: '2010-01-01' }, today);
    expect(result).toEqual({ ok: false, missing: ['date-of-birth'] });
  });

  it('requires at least one referral when a referral was requested', () => {
    const result = assembleStage1({ ...complete, referral: { kind: 'requested', referrals: [] } }, today);
    expect(result.ok).toBe(false);
  });

  it('assembles exactly the Stage 1 payload', () => {
    const result = assembleStage1(complete, today);
    expect(result.ok && Object.keys(result.submission).sort()).toEqual(
      ['city', 'countryCode', 'dateOfBirth', 'firstName', 'instagram', 'lastName', 'referral'],
    );
  });

  it('requires Instagram (DEC-023): a draft without a handle is incomplete', () => {
    const result = assembleStage1({ ...complete, instagram: null }, today);
    expect(result).toEqual({ ok: false, missing: ['instagram'] });
  });

  it('drops the retired "no Instagram" answer from older persisted drafts', () => {
    const legacy = { ...complete, instagram: { kind: 'none' } } as unknown as ApplicationDraft;
    const cleaned = sanitizeDraft(legacy);
    expect(cleaned.instagram).toBeNull();
    expect(resumeStep(cleaned, today)).toBe('instagram');
  });

  it('keeps only name and place on the device after submission', () => {
    const kept = retainAfterSubmission({
      ...complete,
      referral: { kind: 'requested', referrals: [{ id: 'r', name: 'Kerem Aksoy', phoneE164: '+905551112233' }] },
    });
    expect(kept).toMatchObject({ firstName: 'Ece', lastName: 'Demir', countryCode: 'TR' });
    expect(kept.dateOfBirth).toBeNull();
    expect(kept.instagram).toBeNull();
    expect(kept.referral).toBeNull();
    expect(JSON.stringify(kept)).not.toContain('555');
  });
});
