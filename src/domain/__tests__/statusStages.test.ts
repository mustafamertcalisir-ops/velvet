import { stagesFor } from '../admission/statusStages';

describe('status stage sequence', () => {
  it('shows three stages before the extended application', () => {
    expect(stagesFor('APPLICATION_RECEIVED', null)).toEqual({
      stages: ['received', 'review', 'decision'],
      currentIndex: 0,
    });
    expect(stagesFor('UNDER_REVIEW', null)?.currentIndex).toBe(1);
  });

  it('shows four stages once the extended stage begins', () => {
    expect(stagesFor('FINAL_REVIEW', null)).toEqual({
      stages: ['received', 'review', 'finalReview', 'decision'],
      currentIndex: 2,
    });
    expect(stagesFor('WAITLISTED', { extendedRequestedAt: '2026-10-01' })?.stages).toHaveLength(4);
  });

  it('has no sequence before submission or for membership states', () => {
    expect(stagesFor('APPLICATION_DRAFT', null)).toBeNull();
    expect(stagesFor('ACTIVE_MEMBER', null)).toBeNull();
  });
});
