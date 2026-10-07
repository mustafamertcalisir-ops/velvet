import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import type { Progress } from '@/components/ScreenShell';
import {
  isDatingStep,
  isStage2StepComplete,
  nextStage2Step,
  stage2QuestionIndex,
  stage2QuestionStepsFor,
  stage2StepsFor,
  type Stage2Step,
} from '@/domain/admission/stage2';
import { useAdmission, useAdmissionGetState } from '@/state/admission/AdmissionProvider';
import { extendedStepHref } from './routes';

/**
 * Navigation for a Stage 2 step — same contract as useStep (commit, then goNext).
 *
 * The step list depends on the answers: the two dating-preference steps exist
 * only when Dating is chosen (DEC-040), so "next" and the folio ("8 of 9")
 * are computed from the latest draft rather than a fixed list.
 */
export function useExtendedStep(step: Stage2Step) {
  const params = useLocalSearchParams<{ from?: string }>();
  const fromReview = params.from === 'review';
  const intents = useAdmission((s) => s.extendedDraft.intents);
  const getState = useAdmissionGetState();
  const index = stage2QuestionIndex(step, { intents });
  const progress: Progress | undefined =
    index === null ? undefined : { index, total: stage2QuestionStepsFor({ intents }).length };

  const goNext = useCallback(() => {
    // Read after the commit that preceded this call.
    const draft = getState().extendedDraft;
    const next = nextStage2Step(step, draft);
    if (fromReview) {
      // Editing from review returns there — unless the edit opened a step that
      // still needs an answer (Dating newly chosen), or this is the first of the
      // dating pair. Replace, so Back from the chained step still lands on review.
      if (next && next !== 'preview' && next !== 'review' && (!isStage2StepComplete(draft, next) || (isDatingStep(step) && isDatingStep(next)))) {
        router.replace(extendedStepHref(next, true));
        return;
      }
      if (router.canGoBack()) router.back();
      else router.replace(extendedStepHref('review'));
      return;
    }
    if (next) router.push(extendedStepHref(next));
  }, [fromReview, step, getState]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    const steps = stage2StepsFor(getState().extendedDraft);
    const prev = steps[steps.indexOf(step) - 1];
    if (fromReview) router.replace(extendedStepHref('review'));
    else if (prev) router.replace(extendedStepHref(prev));
    else router.replace('/application/status');
  }, [fromReview, step, getState]);

  return { progress, fromReview, goNext, goBack };
}
