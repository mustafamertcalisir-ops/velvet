import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { Button } from '@/components/Button';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import type { InstagramError } from '@/domain/validation/instagram';
import { StepGuard } from '@/navigation/StepGuard';
import { useStep } from '@/navigation/useStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function InstagramRoute() {
  return (
    <StepGuard step="instagram">
      <InstagramScreen />
    </StepGuard>
  );
}

function InstagramScreen() {
  const actions = useAdmissionActions();
  const committed = useAdmission((s) => s.draft.instagram);
  const { progress, goNext, goBack } = useStep('instagram');
  const [value, setValue] = useState(committed?.kind === 'handle' ? committed.handle : '');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const result = actions.setInstagram(value);
    if (!result.ok) {
      if (result.error !== 'not_allowed') setError(copy.instagram.errors[result.error as InstagramError]);
      return;
    }
    goNext();
  };

  return (
    <ScreenShell
      onBack={goBack}
      progress={progress}
      testID="screen-instagram"
      footer={
        <Button
          label={copy.common.continue}
          onPress={submit}
          disabled={value.trim().length === 0}
          testID="step-continue"
        />
      }
    >
      <Question headline={copy.instagram.headline} supporting={copy.instagram.supporting}>
        <TextField
          label={copy.instagram.label}
          value={value}
          onChangeText={(t) => {
            setValue(t.replace(/^@+/, ''));
            if (error) setError(null);
          }}
          onSubmitEditing={submit}
          placeholder={copy.instagram.placeholder}
          error={error}
          hint={copy.instagram.privacy}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          keyboardType="url"
          returnKeyType="next"
          maxLength={120}
          leading={
            <Text variant="answer" tone="tertiary" style={styles.at}>
              @
            </Text>
          }
          testID="input-instagram"
        />
      </Question>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  at: { paddingBottom: space[3], paddingTop: space[2], marginRight: space[1] },
});
