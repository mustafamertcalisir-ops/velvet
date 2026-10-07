import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { LongAnswerStep } from '@/screens/LongAnswerStep';

export default function AboutYouRoute() {
  return (
    <ExtendedStepGuard step="about-you">
      <LongAnswerStep field="aboutYou" />
    </ExtendedStepGuard>
  );
}
