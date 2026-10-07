import { StyleSheet } from 'react-native';

import { RELEASE_CHANNEL } from '@/config';
import { copy } from '@/copy/en';
import { space } from '@/design/tokens';
import { Text } from './Text';

/**
 * A quiet marker on staging builds only (DEC-078): one small caption where a
 * tester naturally looks — the launch screen and You — so staging is never
 * mistaken for production. Not a banner, not on every screen. Renders nothing
 * in production and development builds.
 */
export function StagingMark({ channel = RELEASE_CHANNEL }: { channel?: typeof RELEASE_CHANNEL }) {
  if (channel !== 'staging') return null;
  return (
    <Text variant="caption" tone="tertiary" style={styles.mark} accessibilityLabel={copy.staging.a11y} testID="staging-mark">
      {copy.staging.mark}
    </Text>
  );
}

const styles = StyleSheet.create({
  mark: { alignSelf: 'center', marginTop: space[3], letterSpacing: 0.4 },
});
