import { Pressable, StyleSheet, View } from 'react-native';

import { Glass } from '@/components/Glass';
import { color } from '@/design/tokens';

/** Three quiet dots, drawn (no icon font). */
export function Dots({ tint = color.pearl }: { tint?: string }) {
  return (
    <View style={styles.dots}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.dot, { backgroundColor: tint }]} />
      ))}
    </View>
  );
}

/** A drawn chevron pointing left (back) or right (onward). */
export function Chevron({ direction = 'left', tint = color.pearl, size = 10 }: { direction?: 'left' | 'right'; tint?: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderLeftWidth: 1.5,
        borderBottomWidth: 1.5,
        borderColor: tint,
        transform: [{ rotate: direction === 'left' ? '45deg' : '-135deg' }],
        marginLeft: direction === 'left' ? 4 : -4,
      }}
    />
  );
}

/** Round glass "More options" control for screens over photography. 44pt target. */
export function GlassMore({ onPress, label, testID }: { onPress: () => void; label: string; testID?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} testID={testID}>
      {({ pressed }) => (
        <Glass style={[styles.round, pressed && { opacity: 0.7 }]}>
          <Dots />
        </Glass>
      )}
    </Pressable>
  );
}

/** Plain 44pt control for headers on Obsidian (no photograph beneath, so no glass). */
export function PlainIconButton({
  onPress,
  label,
  children,
  testID,
}: {
  onPress: () => void;
  label: string;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      testID={testID}
      style={({ pressed }) => [styles.plain, pressed && { opacity: 0.6 }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', gap: 3.5 },
  dot: { width: 3.5, height: 3.5, borderRadius: 2 },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  plain: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
