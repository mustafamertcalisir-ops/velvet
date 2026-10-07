import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { LongAnswerStep } from '@/screens/LongAnswerStep';

export default function WhatYouDoRoute() {
  return (
    <ExtendedStepGuard step="what-you-do">
      <LongAnswerStep field="whatYouDo" />
    </ExtendedStepGuard>
  );
}
