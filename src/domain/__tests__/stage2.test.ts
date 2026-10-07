import {
  INTEREST_CATALOGUE,
  INTEREST_GROUPS,
  assembleStage2,
  canOpenStage2Step,
  EMPTY_EXTENDED_DRAFT,
  normalizeLongText,
  resumeStage2Step,
  STAGE2_QUESTION_STEPS,
  validateIntents,
  validateInterests,
  validateLongText,
  validateShortText,
  validateWorkContext,
  type ExtendedDraft,
} from '../admission/stage2';

const photo = (id: string) => ({ id, uri: `file:///${id}.jpg`, width: 720, height: 960, moderationStatus: 'pending' as const });
const long = 'I restore Ottoman-era wooden houses along the Bosphorus with a small team.';

export const completeExtended: ExtendedDraft = {
  introAcknowledged: true,
  photos: [photo('a'), photo('b'), photo('c')],
  occupation: 'Architect',
  workContext: { kind: 'organisation', name: 'Studio Kuzguncuk' },
  whatYouDo: long,
  aboutYou: 'I swim in the Bosphorus every morning from May to November, whatever the weather.',
  interests: ['Architecture', 'Swimming', 'Jazz'],
  intents: ['dating', 'community'],
  datingPreferences: { meet: ['everyone'], ageRange: { min: 28, max: 40 } },
  previewSeen: true,
  updatedAt: null,
};

describe('Stage 2 steps', () => {
  it('has seven questions between intro and preview', () => {
    expect(STAGE2_QUESTION_STEPS).toEqual([
      'photos', 'occupation', 'work-context', 'what-you-do', 'about-you', 'interests', 'intent',
    ]);
  });

  it('resumes at the first unanswered step and refuses deep links past it', () => {
    expect(resumeStage2Step(EMPTY_EXTENDED_DRAFT)).toBe('intro');
    expect(resumeStage2Step({ ...completeExtended, photos: [photo('a')] })).toBe('photos');
    expect(resumeStage2Step(completeExtended)).toBe('review');
    expect(canOpenStage2Step({ ...EMPTY_EXTENDED_DRAFT, introAcknowledged: true }, 'occupation')).toBe(false);
  });

  it('requires 3–6 photos', () => {
    expect(assembleStage2({ ...completeExtended, photos: [photo('a'), photo('b')] }).ok).toBe(false);
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(photo);
    expect(assembleStage2({ ...completeExtended, photos: seven }).ok).toBe(false);
    expect(assembleStage2(completeExtended).ok).toBe(true);
  });

  it('assembles photo ids in order', () => {
    const r = assembleStage2(completeExtended);
    expect(r.ok && r.submission.photoIds).toEqual(['a', 'b', 'c']);
  });
});

describe('Stage 2 validation', () => {
  it('accepts Turkish occupations and organisations', () => {
    expect(validateShortText('Mimar & iç mimar').ok).toBe(true);
    expect(validateShortText('Boğaziçi Üniversitesi').ok).toBe(true);
    expect(validateShortText('x')).toEqual({ ok: false, error: 'required' });
    expect(validateShortText('🎨 Artist')).toEqual({ ok: false, error: 'invalid_characters' });
  });

  it('bounds long answers and keeps paragraphs', () => {
    expect(validateLongText('Too short.', 400)).toEqual({ ok: false, error: 'too_short' });
    expect(validateLongText('a'.repeat(401), 400)).toEqual({ ok: false, error: 'too_long' });
    expect(normalizeLongText('  First   line \n\n\n\n second  ')).toBe('First line\n\nsecond');
  });

  it('limits interests to the curated catalogue, 3–8', () => {
    expect(validateInterests(['Jazz', 'Art'])).toEqual({ ok: false, error: 'too_few' });
    expect(validateInterests(['Jazz', 'Art', 'Yachts'])).toEqual({ ok: false, error: 'unknown' });
    expect(validateInterests(['Jazz', 'Art', 'Books', 'Jazz']).ok).toBe(true);
  });

  it('requires at least one known intent', () => {
    expect(validateIntents([])).toEqual({ ok: false, error: 'required' });
    expect(validateIntents(['networking'])).toEqual({ ok: false, error: 'unknown' });
    expect(validateIntents(['friendship']).ok).toBe(true);
  });

  it('treats work context as optional but explicit', () => {
    expect(validateWorkContext({ kind: 'not_shared' }).ok).toBe(true);
    expect(validateWorkContext({ kind: 'independent' }).ok).toBe(true);
    expect(validateWorkContext({ kind: 'organisation', name: '' }).ok).toBe(false);
  });
});

describe('interest groups', () => {
  it('cover the catalogue exactly once', () => {
    const grouped = INTEREST_GROUPS.flatMap((g) => [...g.items]);
    expect([...grouped].sort()).toEqual([...INTEREST_CATALOGUE].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});
