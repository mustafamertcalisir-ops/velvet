import { BlurView } from 'expo-blur';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { blur, color } from '@/design/tokens';

/**
 * A translucent dark surface for controls that sit on photography. Only for
 * controls (back, media index, an action bar) — never for content panels.
 * Android uses a dim fill instead of a live blur.
 */
export function Glass({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.base, style]}>
      {Platform.OS === 'android' ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(11,11,12,0.62)' }]} />
      ) : (
        <BlurView intensity={blur.surface} tint="dark" style={StyleSheet.absoluteFill}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(11,11,12,0.32)' }]} />
        </BlurView>
      )}
      {children}
    </View>
  );
}

/** Round glass back control, 44pt target. */
export function GlassBack({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} testID="back-button">
      {({ pressed }) => (
        <Glass style={[styles.round, pressed && { opacity: 0.7 }]}>
          <View style={styles.chevron} />
        </Glass>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(243,240,234,0.14)' },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  chevron: {
    width: 10,
    height: 10,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: color.pearl,
    transform: [{ rotate: '45deg' }],
    marginLeft: 4,
  },
});
