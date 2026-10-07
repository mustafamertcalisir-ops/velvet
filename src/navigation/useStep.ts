import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import type { Progress } from '@/components/ScreenShell';
import {
  nextStep,
  questionIndex,
  STAGE1_QUESTION_STEPS,
  STAGE1_STEPS,
  type Stage1Step,
} from '@/domain/admission/stage1';
import { stepHref } from './routes';

/**
 * Navigation for a Stage 1 step. Answers are committed to the draft by the
 * screen BEFORE calling goNext(); going back never writes anything, so
 * back-navigation cannot corrupt the draft.
 */
export function useStep(step: Stage1Step) {
  const params = useLocalSearchParams<{ from?: string }>();
  const fromReview = params.from === 'review';
  const index = questionIndex(step);
  const progress: Progress | undefined =
    index === null ? undefined : { index, total: STAGE1_QUESTION_STEPS.length };

  const goNext = useCallback(() => {
    if (fromReview) {
      if (router.canGoBack()) router.back();
      else router.replace(stepHref('review'));
      return;
    }
    const next = nextStep(step);
    if (next) router.push(stepHref(next));
  }, [fromReview, step]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    const i = STAGE1_STEPS.indexOf(step);
    const prev = STAGE1_STEPS[i - 1];
    if (fromReview) router.replace(stepHref('review'));
    else if (prev) router.replace(stepHref(prev));
  }, [fromReview, step]);

  return { progress, fromReview, goNext, goBack };
}
