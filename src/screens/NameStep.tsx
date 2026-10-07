import { useState } from 'react';

import { Button } from '@/components/Button';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { TextField } from '@/components/TextField';
import { copy } from '@/copy/en';
import type { NameError } from '@/domain/validation/name';
import { useStep } from '@/navigation/useStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/** First and last name share one implementation; only copy and target field differ. */
export function NameStep({ field }: { field: 'firstName' | 'lastName' }) {
  const step = field === 'firstName' ? 'first-name' : 'last-name';
  const text = field === 'firstName' ? copy.firstName : copy.lastName;
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.draft[field]);
  const { progress, goNext, goBack } = useStep(step);

  const [value, setValue] = useState(committed ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const result = field === 'firstName' ? actions.setFirstName(value) : actions.setLastName(value);
    if (!result.ok) {
      if (result.error !== 'not_allowed') setError(copy.nameErrors[result.error as NameError]);
      return;
    }
    goNext();
  };

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID={`screen-${step}`}
      footer={
        <Button
          label={copy.common.continue}
          onPress={submit}
          disabled={value.trim().length === 0}
          testID="step-continue"
        />
      }
    >
      <Question headline={text.headline} supporting={'supporting' in text ? text.supporting : undefined}>
        <TextField
          label={text.label}
          value={value}
          onChangeText={(t) => {
            setValue(t);
            if (error) setError(null);
          }}
          onSubmitEditing={submit}
          error={error}
          autoFocus
          autoCapitalize="words"
          autoCorrect={false}
          autoComplete={field === 'firstName' ? 'given-name' : 'family-name'}
          textContentType={field === 'firstName' ? 'givenName' : 'familyName'}
          returnKeyType="next"
          maxLength={60}
          testID={`input-${step}`}
        />
      </Question>
    </ScreenShell>
  );
}
