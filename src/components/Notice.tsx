import { useEffect } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';

import { color, space } from '@/design/tokens';
import { Text } from './Text';

/**
 * Inline message under a field or action. Errors are announced to screen
 * readers; an info message is announced only when `announce` is passed
 * explicitly (an outcome the person must hear, e.g. "account deleted").
 * A short pomegranate tick marks errors; nothing shouts.
 */
export function Notice({
  message,
  tone = 'error',
  announce,
  testID,
}: {
  message: string | null | undefined;
  tone?: 'error' | 'info';
  announce?: boolean;
  testID?: string;
}) {
  const speak = announce ?? tone === 'error';
  useEffect(() => {
    if (message && speak && Platform.OS !== 'web') {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message, speak]);

  if (!message) return null;
  return (
    <View
      style={styles.row}
      accessibilityLiveRegion="polite"
      role={tone === 'error' ? 'alert' : speak ? 'status' : undefined}
      testID={testID}
    >
      {tone === 'error' ? <View style={styles.tick} /> : null}
      <Text variant="supporting" tone={tone === 'error' ? 'error' : 'secondary'} style={styles.text}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', marginTop: space[3] },
  tick: { width: 10, height: 1.5, backgroundColor: color.error, marginTop: 10, marginRight: space[2] },
  text: { flex: 1 },
});
