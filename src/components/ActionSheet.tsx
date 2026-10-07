import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { color, radius, space } from '@/design/tokens';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { Text } from './Text';

export type SheetAction = {
  key: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  testID?: string;
};

/**
 * A calm, native-feeling action sheet: an optional header (e.g. a thumbnail
 * of what is being acted on), one grouped list of actions separated by
 * hairlines, destructive actions set apart in the validation colour, and a
 * separate Cancel. No titles in caps, no icons, no admin-menu density.
 */
export function ActionSheet({
  visible,
  onClose,
  header,
  actions,
  cancelLabel,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  header?: ReactNode;
  actions: readonly SheetAction[];
  cancelLabel: string;
  testID?: string;
}) {
  const regular = actions.filter((a) => !a.destructive);
  const destructive = actions.filter((a) => a.destructive);
  return (
    <Sheet visible={visible} onClose={onClose} testID={testID}>
      {header ? <View style={styles.header}>{header}</View> : null}
      {regular.length ? <Group actions={regular} /> : null}
      {destructive.length ? <Group actions={destructive} /> : null}
      <Button variant="secondary" label={cancelLabel} onPress={onClose} style={styles.cancel} testID={testID ? `${testID}-cancel` : undefined} />
    </Sheet>
  );
}

function Group({ actions }: { actions: readonly SheetAction[] }) {
  return (
    <View style={styles.group}>
      {actions.map((a, i) => (
        <Pressable
          key={a.key}
          onPress={a.onPress}
          accessibilityRole="button"
          style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && { backgroundColor: color.surfaceRaised }]}
          testID={a.testID}
        >
          <Text variant="bodyLarge" tone={a.destructive ? 'error' : 'primary'}>
            {a.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: space[5] },
  group: { borderRadius: radius.medium, backgroundColor: color.surface, overflow: 'hidden', marginBottom: space[3] },
  row: { minHeight: 54, paddingHorizontal: space[5], justifyContent: 'center' },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  cancel: { marginTop: space[2] },
});
