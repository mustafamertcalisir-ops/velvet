import { useState } from 'react';

import { Button } from '@/components/Button';
import { DateField } from '@/components/DateField';
import { Notice } from '@/components/Notice';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { copy } from '@/copy/en';
import { parseISODate, type DobError, type DobParts } from '@/domain/validation/dateOfBirth';
import { StepGuard } from '@/navigation/StepGuard';
import { useStep } from '@/navigation/useStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function DateOfBirthRoute() {
  return (
    <StepGuard step="date-of-birth">
      <DateOfBirthScreen />
    </StepGuard>
  );
}

function DateOfBirthScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.draft.dateOfBirth);
  const { progress, goNext, goBack } = useStep('date-of-birth');

  const initial = committed ? parseISODate(committed) : null;
  const [parts, setParts] = useState<DobParts>(
    initial
      ? {
          day: String(initial.day).padStart(2, '0'),
          month: String(initial.month).padStart(2, '0'),
          year: String(initial.year),
        }
      : { day: '', month: '', year: '' },
  );
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const result = actions.setDateOfBirth(parts);
    if (!result.ok) {
      if (result.error !== 'not_allowed') setError(copy.dob.errors[result.error as DobError]);
      return;
    }
    goNext();
  };

  const complete = parts.day.length > 0 && parts.month.length > 0 && parts.year.length === 4;

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-date-of-birth"
      footer={<Button label={copy.common.continue} onPress={submit} disabled={!complete} testID="step-continue" />}
    >
      <Question headline={copy.dob.headline} supporting={copy.dob.supporting}>
        <DateField
          value={parts}
          onChange={(p) => {
            setParts(p);
            if (error) setError(null);
          }}
          onSubmit={submit}
          error={error}
        />
        {!error ? <Notice message={copy.dob.privacy} tone="info" announce={false} /> : null}
      </Question>
    </ScreenShell>
  );
}
