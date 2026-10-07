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

/**
 * EXT-14 — the extended application has reached the membership team.
 * Same visual language as APP-10 (one receipt moment, then the status home).
 * Completing Stage 2 is not approval (DEC-013) and nothing here implies it.
 */
export default function SentRoute() {
  return (
    <Guard allow={(s) => s.status === 'FINAL_REVIEW'}>
      <SentScreen />
    </Guard>
  );
}

function SentScreen() {
  const insets = useSafeAreaInsets();
  const t = copy.extended.sent;
  return (
    <View style={styles.root} testID="screen-extended-sent">
      <PhotoBackdrop source={photography.application} accessibilityLabel={photographyA11y.application} />
      <View style={[styles.content, { paddingBottom: Math.max(insets.bottom, space[4]) + space[2] }]}>
        <Reveal duration={motion.considered}>
          <Kicker testID="sent-kicker">{t.kicker}</Kicker>
          <Text variant="display" accessibilityRole="header">
            {t.headline}
          </Text>
          <Text variant="bodyLarge" style={styles.body}>
            {t.supporting}
          </Text>
          <Text variant="body" tone="secondary" style={styles.secondary}>
            {t.secondary}
          </Text>
        </Reveal>
        <View style={styles.action}>
          <Button label={t.cta} onPress={() => router.replace('/application/status')} testID="sent-view-status" />
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
  action: { marginTop: space[8] },
});
