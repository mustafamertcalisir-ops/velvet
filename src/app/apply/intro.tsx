import { StyleSheet } from 'react-native';

import { Button } from '@/components/Button';
import { Question } from '@/components/Question';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import { StepGuard } from '@/navigation/StepGuard';
import { useStep } from '@/navigation/useStep';
import { useAdmissionActions } from '@/state/admission/AdmissionProvider';

export default function IntroRoute() {
  return (
    <StepGuard step="intro">
      <IntroScreen />
    </StepGuard>
  );
}

function IntroScreen() {
  const actions = useAdmissionActions();
  const { goNext } = useStep('intro');
  return (
    <ScreenShell
      testID="screen-intro"
      footer={
        <>
          <Button
            label={copy.intro.cta}
            onPress={() => {
              if (actions.acknowledgeIntro().ok) goNext();
            }}
            testID="intro-begin"
          />
          <Button
            variant="quiet"
            label={copy.common.signOut}
            onPress={() => void actions.signOut()}
            style={styles.signOut}
          />
        </>
      }
    >
      <Question headline={copy.intro.headline} supporting={copy.intro.supporting}>
        <Text variant="bodyLarge" tone="secondary" style={styles.detail}>
          {copy.intro.detail}
        </Text>
      </Question>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  detail: { maxWidth: 400 },
  signOut: { alignSelf: 'center', marginTop: space[1] },
});
