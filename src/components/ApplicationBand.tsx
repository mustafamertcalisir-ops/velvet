import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BRAND } from '@/config';
import { photography, photographyA11y } from '@/design/photography';
import { layout, space } from '@/design/tokens';
import { PhotoBackdrop } from './PhotoBackdrop';
import { Text } from './Text';

/**
 * The application's photograph, condensed to a band at the top of a page that
 * scrolls with it. Shared by Application Status and the Stage 2 introduction
 * so "continue your application" visibly belongs to the status home it
 * comes from. Same graded image as the Received and Final Review moments.
 */
export function ApplicationBand({
  compact = false,
  photo = 'application',
}: {
  compact?: boolean;
  /** 'welcome' after approval — the one change of atmosphere (DEC-046). */
  photo?: 'application' | 'welcome';
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const base = compact ? height * 0.26 : height * 0.34;
  const bandHeight = Math.round(Math.min(Math.max(base, compact ? 180 : 220), compact ? 260 : 340));
  return (
    <View style={{ height: bandHeight + insets.top }}>
      <PhotoBackdrop source={photography[photo]} variant="band" accessibilityLabel={photographyA11y[photo]} />
      <View style={[styles.topBar, { marginTop: insets.top }]}>
        <Text variant="wordmark">{BRAND.workingName}</Text>
      </View>
    </View>
  );
}

/** The quiet line above a status-family headline: which letter this is. */
export function Kicker({ children, testID }: { children: string; testID?: string }) {
  return (
    <Text variant="label" tone="secondary" style={styles.kicker} testID={testID}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  topBar: { height: layout.headerHeight, justifyContent: 'center', paddingHorizontal: layout.gutter },
  kicker: { marginBottom: space[3] },
});
