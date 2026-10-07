import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { space } from '@/design/tokens';
import { Reveal } from './Reveal';
import { Text } from './Text';

/** One question per screen: the headline is the screen's single focus. */
export function Question({
  headline,
  supporting,
  children,
}: {
  headline: string;
  supporting?: string;
  children?: ReactNode;
}) {
  return (
    <Reveal>
      <Text variant="headline" accessibilityRole="header" testID="question-headline">
        {headline}
      </Text>
      {supporting ? (
        <Text variant="body" tone="secondary" style={styles.supporting}>
          {supporting}
        </Text>
      ) : null}
      {children ? <View style={styles.body}>{children}</View> : null}
    </Reveal>
  );
}

const styles = StyleSheet.create({
  supporting: { marginTop: space[3], maxWidth: 440 },
  body: { marginTop: space[8] },
});
