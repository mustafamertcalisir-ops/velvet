import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Kicker } from '@/components/ApplicationBand';
import { Button } from '@/components/Button';
import { PhotoBackdrop } from '@/components/PhotoBackdrop';
import { Reveal } from '@/components/Reveal';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { photography, photographyA11y } from '@/design/photography';
import { color, layout, motion, space } from '@/design/tokens';
import { Guard } from '@/navigation/Guard';
import { formatLongDate } from '@/screens/applicationLetter';
import { useAdmission } from '@/state/admission/AdmissionProvider';

/**
 * APP-10 Application received — the one-time receipt moment.
 *
 * Full-bleed, graded photograph; the text sits on near-solid Obsidian so it
 * never fights the sky. One short fade. No confetti, no congratulations, no
 * promises. Application Status reuses the same photograph as a band, so the
 * receipt visibly "settles" into the durable status home.
 */
export default function ReceivedRoute() {
  return (
    <Guard allow={(s) => s.status === 'APPLICATION_RECEIVED'}>
      <ReceivedScreen />
    </Guard>
  );
}

function ReceivedScreen() {
  const insets = useSafeAreaInsets();
  const submittedAt = useAdmission((s) => s.application?.submittedAt ?? null);
  return (
    <View style={styles.root} testID="screen-received">
      <PhotoBackdrop source={photography.application} accessibilityLabel={photographyA11y.application} />
      <View style={[styles.content, { paddingBottom: Math.max(insets.bottom, space[4]) + space[2] }]}>
        <Reveal duration={motion.considered}>
          <Kicker testID="received-kicker">{copy.received.kicker}</Kicker>
          <Text variant="display" accessibilityRole="header" testID="received-headline">
            {copy.received.headline}
          </Text>
          <Text variant="bodyLarge" style={styles.body}>
            {copy.received.supporting}
          </Text>
          <Text variant="body" tone="secondary" style={styles.secondary}>
            {copy.received.secondary}
          </Text>
          {submittedAt ? (
            <Text variant="numeral" tone="tertiary" style={styles.date}>
              {copy.status.submittedOn(formatLongDate(submittedAt.slice(0, 10)))}
            </Text>
          ) : null}
        </Reveal>
        <View style={styles.action}>
          <Button
            label={copy.received.cta}
            onPress={() => router.replace('/application/status')}
            testID="received-view-status"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  content: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: layout.gutter,
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
  },
  body: { marginTop: space[4], maxWidth: 400 },
  secondary: { marginTop: space[3], maxWidth: 400 },
  date: { marginTop: space[5] },
  action: { marginTop: space[8] },
});
