import { useState } from 'react';

import { Button } from '@/components/Button';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { TextField } from '@/components/TextField';
import { copy } from '@/copy/en';
import { OCCUPATION_MAX } from '@/domain/admission/stage2';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { extendedTextError } from '@/screens/extendedErrors';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * EXT-02 — a short, public-friendly occupation label. The answer IS the
 * screen: large sans, no box, no visible label (the headline asks), wrapping
 * rather than scrolling so a long title stays fully readable.
 */
export default function OccupationRoute() {
  return (
    <ExtendedStepGuard step="occupation">
      <OccupationScreen />
    </ExtendedStepGuard>
  );
}

function OccupationScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.extendedDraft.occupation);
  const { progress, goNext, goBack } = useExtendedStep('occupation');
  const [value, setValue] = useState(committed ?? '');
  const [error, setError] = useState<string | null>(null);
  const t = copy.extended.occupation;

  const submit = () => {
    const r = actions.setOccupation(value);
    if (!r.ok) return setError(extendedTextError(r.error));
    goNext();
  };

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-occupation"
      footer={<Button label={copy.common.continue} onPress={submit} disabled={value.trim().length < 2} testID="step-continue" />}
    >
      <Question headline={t.headline} supporting={t.supporting}>
        <TextField
          label={t.label}
          hideLabel
          size="heroAnswer"
          grow
          autoCorrect={false}
          caption={t.shownAs}
          value={value}
          onChangeText={(v) => {
            setValue(v);
            if (error) setError(null);
          }}
          onSubmitEditing={submit}
          placeholder={t.placeholder}
          error={error}
          autoFocus
          autoCapitalize="sentences"
          autoComplete="off"
          returnKeyType="next"
          maxLength={OCCUPATION_MAX + 10}
          testID="input-occupation"
        />
      </Question>
    </ScreenShell>
  );
}
