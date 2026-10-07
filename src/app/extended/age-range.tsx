import { useState } from 'react';

import { AgeRangeField } from '@/components/AgeRangeField';
import { Button } from '@/components/Button';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { copy } from '@/copy/en';
import {
  AGE_PREFERENCE_MAX,
  AGE_PREFERENCE_MIN,
  AGE_PREFERENCE_MIN_SPAN,
  suggestedAgeRange,
  type AgeRange,
} from '@/domain/admission/stage2';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * EXT-08b — the age range the applicant would like to meet. Dating only,
 * private. No distance: location belongs to the member product.
 */
export default function AgeRangeRoute() {
  return (
    <ExtendedStepGuard step="age-range">
      <AgeRangeScreen />
    </ExtendedStepGuard>
  );
}

function AgeRangeScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.extendedDraft.datingPreferences.ageRange);
  const age = useAdmission((s) => s.summary?.age ?? null);
  const { progress, goNext, goBack } = useExtendedStep('age-range');
  const [range, setRange] = useState<AgeRange>(() => committed ?? suggestedAgeRange(age));
  const t = copy.extended.ageRange;

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-age-range"
      footer={
        <Button
          label={copy.common.continue}
          onPress={() => {
            if (actions.setAgeRange(range).ok) goNext();
          }}
          testID="step-continue"
        />
      }
    >
      <Question headline={t.headline} supporting={t.supporting}>
        <AgeRangeField
          value={range}
          onChange={setRange}
          bounds={{ min: AGE_PREFERENCE_MIN, max: AGE_PREFERENCE_MAX }}
          minSpan={AGE_PREFERENCE_MIN_SPAN}
          testID="age-range"
        />
      </Question>
    </ScreenShell>
  );
}
