import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { PhotoBackdrop } from '@/components/PhotoBackdrop';
import { Reveal } from '@/components/Reveal';
import { Text } from '@/components/Text';
import { BRAND } from '@/config';
import { copy } from '@/copy/en';
import { color, layout, motion, space } from '@/design/tokens';
import { photography, photographyA11y } from '@/design/photography';
import { Guard } from '@/navigation/Guard';
import { Notice } from '@/components/Notice';
import { StagingMark } from '@/components/StagingMark';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * Launch. A single photograph, the working wordmark, one sentence and two
 * ways in. Nothing announces exclusivity — the application does that.
 */
export default function Launch() {
  return (
    <Guard allow={(s) => s.status === 'UNAUTHENTICATED'}>
      <LaunchScreen />
    </Guard>
  );
}

function LaunchScreen() {
  const insets = useSafeAreaInsets();
  // Shown once, right after an account deletion (in memory only — never persisted).
  const deleted = useAdmission((s) => s.signedOutBecause === 'account_deleted');
  const actions = useAdmissionActions();
  // The notice goes away once the person moves on (not on unmount: a guard redirect can remount this screen).
  const go = () => {
    actions.dismissSignedOutNotice();
    router.push('/verify/phone');
  };
  return (
    <View style={styles.root} testID="screen-launch">
      <PhotoBackdrop source={photography.launch} accessibilityLabel={photographyA11y.launch} />
      <View style={[styles.top, { paddingTop: insets.top + space[4] }]}>
        <Text variant="wordmark" accessibilityRole="header">
          {BRAND.workingName}
        </Text>
      </View>
      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, space[5]) + space[2] }]}>
        <Reveal duration={motion.considered}>
          <Text variant="display" style={styles.line}>
            {copy.launch.line}
          </Text>
        </Reveal>
        {deleted ? <Notice tone="info" announce message={copy.member.deleteAccount.done} testID="launch-account-deleted" /> : null}
        <View style={styles.actions}>
          <Button label={copy.launch.apply} onPress={go} testID="launch-apply" />
          <Button
            label={copy.launch.signIn}
            variant="quiet"
            onPress={go}
            style={styles.signIn}
            testID="launch-sign-in"
          />
          <StagingMark />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  top: { paddingHorizontal: layout.gutter },
  bottom: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: layout.gutter,
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
  },
  line: { maxWidth: 360 },
  actions: { marginTop: space[10], gap: space[3] },
  signIn: { alignSelf: 'center' },
});
