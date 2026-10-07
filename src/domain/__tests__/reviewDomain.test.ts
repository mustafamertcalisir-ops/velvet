import {
  allAnswered,
  resolveRequestDrafts,
  validateResponse,
} from '../admission/informationRequests';
import { planReviewerAction, REVIEWER_ACTIONS } from '../admission/review';
import {
  EMPTY_EXTENDED_DRAFT,
  nextStage2Step,
  stage2QuestionStepsFor,
  suggestedAgeRange,
  toggleMeetOption,
  validateAgeRange,
  validateDatingPreferences,
  validateMeet,
} from '../admission/stage2';
import { canTransition } from '../admission/status';
import { stagesFor } from '../admission/statusStages';
import { formatPrice } from '../membership/plan';

describe('reviewer action table', () => {
  it('only plans transitions the lifecycle allows', () => {
    for (const [status, kinds] of Object.entries(REVIEWER_ACTIONS)) {
      for (const kind of kinds!) {
        const action =
          kind === 'REQUEST_INFORMATION'
            ? { kind, requests: [] }
            : kind === 'REOPEN'
              ? { kind, to: 'UNDER_REVIEW' as const }
              : { kind };
        const r = planReviewerAction({ status: status as never, extendedSubmittedAt: '2026-10-01' }, action as never);
        expect(r.ok).toBe(true);
        if (r.ok) expect(canTransition(r.plan.from, r.plan.to)).toBe(true);
      }
    }
  });

  it('never approves outside final review and never moves a decided application', () => {
    for (const status of ['APPLICATION_RECEIVED', 'UNDER_REVIEW', 'WAITLISTED', 'MORE_INFORMATION_REQUIRED', 'NOT_ADMITTED', 'APPROVED'] as const) {
      expect(planReviewerAction({ status, extendedSubmittedAt: null }, { kind: 'APPROVE' }).ok).toBe(false);
    }
    expect(planReviewerAction({ status: 'NOT_ADMITTED', extendedSubmittedAt: 'x' }, { kind: 'REOPEN', to: 'UNDER_REVIEW' }).ok).toBe(false);
  });

  it('records where a request round returns to', () => {
    const fromFinal = planReviewerAction({ status: 'FINAL_REVIEW', extendedSubmittedAt: 'x' }, { kind: 'REQUEST_INFORMATION', requests: [] });
    const fromReview = planReviewerAction({ status: 'UNDER_REVIEW', extendedSubmittedAt: null }, { kind: 'REQUEST_INFORMATION', requests: [] });
    expect(fromFinal.ok && fromFinal.plan.returnTo).toBe('FINAL_REVIEW');
    expect(fromReview.ok && fromReview.plan.returnTo).toBe('UNDER_REVIEW');
  });
});

describe('information requests', () => {
  const ctx = { photoIds: ['p1', 'p2', 'p3'], extendedSubmitted: true };

  it('turns presets into narrow, targeted requests', () => {
    const r = resolveRequestDrafts([{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: 'p2' }, { preset: 'ABOUT_YOU_MORE' }], ctx);
    expect(r).toEqual({
      ok: true,
      value: [
        { type: 'REPLACE_PHOTO', explanation: expect.any(String), target: { kind: 'photo', mediaId: 'p2' } },
        { type: 'UPDATE_APPLICATION_FIELD', explanation: expect.any(String), target: { kind: 'field', field: 'aboutYou' } },
      ],
    });
    expect(resolveRequestDrafts([{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: 'p2' }, { preset: 'PHOTO_FACE_NOT_CLEAR', mediaId: 'p2' }], ctx)).toEqual({
      ok: false,
      error: 'duplicate',
    });
    expect(resolveRequestDrafts(Array(4).fill({ preset: 'INSTAGRAM_NOT_FOUND' }), ctx)).toEqual({ ok: false, error: 'too_many' });
  });

  it('accepts a response only for its own type and target', () => {
    const photoReq = { type: 'REPLACE_PHOTO' as const, target: { kind: 'photo' as const, mediaId: 'p1' }, status: 'open' as const };
    expect(validateResponse(photoReq, { type: 'REPLACE_PHOTO', mediaId: 'new' }, { uploadedForRequest: ['new'] }).ok).toBe(true);
    expect(validateResponse(photoReq, { type: 'REPLACE_PHOTO', mediaId: 'p2' }, { uploadedForRequest: ['new'] })).toEqual({ ok: false, error: 'target_mismatch' });
    expect(validateResponse(photoReq, { type: 'UPDATE_INSTAGRAM', handle: 'a' }, { uploadedForRequest: [] })).toEqual({ ok: false, error: 'type_mismatch' });
    expect(validateResponse({ ...photoReq, status: 'resolved' }, { type: 'REPLACE_PHOTO', mediaId: 'new' }, { uploadedForRequest: ['new'] })).toEqual({
      ok: false,
      error: 'not_open',
    });
  });

  it('is ready to send only when every request is answered', () => {
    expect(allAnswered([])).toBe(false);
    expect(allAnswered([{ status: 'answered' }, { status: 'open' }])).toBe(false);
    expect(allAnswered([{ status: 'answered' }])).toBe(true);
  });

  it('keeps the stage line on the stage that asked', () => {
    expect(stagesFor('MORE_INFORMATION_REQUIRED', { extendedRequestedAt: 'x', moreInformationReturnTo: 'FINAL_REVIEW' })).toEqual({
      stages: ['received', 'review', 'finalReview', 'decision'],
      currentIndex: 2,
    });
    expect(stagesFor('MORE_INFORMATION_REQUIRED', { extendedRequestedAt: null, moreInformationReturnTo: 'UNDER_REVIEW' })?.currentIndex).toBe(1);
  });
});

describe('dating preferences', () => {
  it('adds the two steps only when Dating is chosen', () => {
    expect(stage2QuestionStepsFor({ intents: ['friendship'] })).not.toContain('meet');
    expect(stage2QuestionStepsFor({ intents: ['dating'] }).slice(-3)).toEqual(['intent', 'meet', 'age-range']);
    expect(nextStage2Step('intent', { intents: ['community'] })).toBe('preview');
    expect(nextStage2Step('intent', { intents: ['dating'] })).toBe('meet');
    expect(nextStage2Step('age-range', { intents: ['dating'] })).toBe('preview');
    // A step left behind after Dating is unchosen continues safely.
    expect(nextStage2Step('meet', { intents: ['friendship'] })).toBe('preview');
    expect(stage2QuestionStepsFor(EMPTY_EXTENDED_DRAFT)).toHaveLength(7);
  });

  it('treats "Everyone" as exclusive and keeps the taxonomy data-driven', () => {
    expect(toggleMeetOption(['women'], 'men')).toEqual(['women', 'men']);
    expect(toggleMeetOption(['women', 'men'], 'everyone')).toEqual(['everyone']);
    expect(toggleMeetOption(['everyone'], 'women')).toEqual(['women']);
    expect(toggleMeetOption(['women'], 'women')).toEqual([]);
    expect(validateMeet(['women', 'everyone'])).toEqual({ ok: false, error: 'conflict' });
    expect(validateMeet(['unicorns'])).toEqual({ ok: false, error: 'unknown' });
    expect(validateMeet([])).toEqual({ ok: false, error: 'required' });
  });

  it('bounds the age range to platform limits', () => {
    expect(validateAgeRange({ min: 18, max: 80 }).ok).toBe(true);
    expect(validateAgeRange({ min: 17, max: 30 })).toEqual({ ok: false, error: 'out_of_bounds' });
    expect(validateAgeRange({ min: 30, max: 81 })).toEqual({ ok: false, error: 'out_of_bounds' });
    expect(validateAgeRange({ min: 40, max: 40 })).toEqual({ ok: false, error: 'too_narrow' });
    expect(validateAgeRange({ min: 25.5, max: 40 })).toEqual({ ok: false, error: 'invalid' });
    expect(suggestedAgeRange(19)).toEqual({ min: 18, max: 30 });
    expect(suggestedAgeRange(79)).toEqual({ min: 68, max: 80 });
    expect(suggestedAgeRange(null)).toEqual({ min: 25, max: 40 });
  });

  it('exist exactly when Dating is chosen', () => {
    const prefs = { meet: ['women'], ageRange: { min: 30, max: 40 } };
    expect(validateDatingPreferences(['dating'], prefs).ok).toBe(true);
    expect(validateDatingPreferences(['dating'], null)).toEqual({ ok: false, error: 'required' });
    expect(validateDatingPreferences(['community'], prefs)).toEqual({ ok: false, error: 'not_applicable' });
    expect(validateDatingPreferences(['community'], null)).toEqual({ ok: true, value: null });
  });
});

describe('membership plan', () => {
  it('formats prices from data, never from copy', () => {
    expect(formatPrice({ priceMinor: 250_000, currency: 'TRY' })).toBe('₺2,500');
    expect(formatPrice({ priceMinor: 1_999, currency: 'EUR' })).toBe('€19.99');
    expect(formatPrice({ priceMinor: 5_000, currency: 'CHF' })).toBe('50 CHF');
  });
});
