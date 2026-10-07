import { useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { color, layout, motion, radius, space } from '@/design/tokens';
import { nativeDriver, useReducedMotion } from '@/design/useReducedMotion';
import { Text } from './Text';

type Variant = 'primary' | 'secondary' | 'quiet';

/**
 * primary   — solid Pearl, 54pt, 12pt radius. The one confident action on a screen.
 * secondary — a quiet dark fill, no outline (DESIGN.md: no fake hierarchy via outlines).
 * quiet     — text action for tertiary paths; still a 44pt target.
 *
 * Disabled is a distinct state, not a faded primary: dark fill, tertiary label.
 *
 * Accessibility: the disabled state is a real state, not only a look.
 *  - native: Pressable `disabled` + accessibilityState.disabled — VoiceOver
 *    reads "dimmed", TalkBack "disabled"; presses are ignored.
 *  - web: react-native-web renders role="button" as a native <button> and
 *    derives `disabled` / `aria-disabled` from Pressable's own `disabled`
 *    prop (an aria-disabled passed directly is overridden), so the prop must
 *    be set. The result is the platform's native disabled button: announced
 *    as unavailable, skipped by Tab, inert to Enter/Space and clicks.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  accessibilityHint,
  accessibilityLabel,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));
  const inactive = disabled || loading;

  const animateTo = (v: number) => {
    if (reduced || inactive) return;
    Animated.timing(scale, { toValue: v, duration: motion.quick, useNativeDriver: nativeDriver }).start();
  };

  return (
    <Pressable
      testID={testID}
      disabled={inactive}
      onPress={inactive ? undefined : onPress}
      onPressIn={() => animateTo(motion.pressScale)}
      onPressOut={() => animateTo(1)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      aria-busy={loading}
      hitSlop={variant === 'quiet' ? 6 : 0}
      style={style}
    >
      {({ pressed }) => {
        const isPressed = pressed && !inactive;
        return (
          <Animated.View
            style={[
              styles.base,
              variant === 'primary' && styles.primary,
              variant === 'secondary' && styles.secondary,
              variant === 'quiet' && styles.quiet,
              variant === 'primary' && isPressed && { backgroundColor: color.primaryPressed },
              variant === 'secondary' && isPressed && { backgroundColor: color.ink },
              variant === 'quiet' && isPressed && { opacity: 0.6 },
              disabled && !loading && variant !== 'quiet' && styles.disabledFill,
              { transform: [{ scale }] },
            ]}
          >
            {loading ? (
              <View style={styles.loading}>
                <ActivityIndicator color={variant === 'primary' ? color.onPrimary : color.text} />
              </View>
            ) : (
              <Text
                variant={variant === 'quiet' ? 'link' : 'button'}
                tone={disabled ? 'tertiary' : variant === 'primary' ? 'inverse' : 'primary'}
                numberOfLines={1}
              >
                {label}
              </Text>
            )}
          </Animated.View>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: layout.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    height: layout.buttonHeight,
    borderRadius: radius.control,
    backgroundColor: color.pearl,
    paddingHorizontal: space[6],
  },
  secondary: {
    height: layout.buttonHeight,
    borderRadius: radius.control,
    backgroundColor: color.surfaceRaised,
    paddingHorizontal: space[6],
  },
  quiet: {
    alignSelf: 'flex-start',
    paddingHorizontal: 0,
  },
  disabledFill: { backgroundColor: color.surfaceRaised },
  loading: { height: 20, justifyContent: 'center' },
});
