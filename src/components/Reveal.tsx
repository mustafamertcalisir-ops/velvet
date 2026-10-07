import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

import { motion } from '@/design/tokens';
import { nativeDriver, useReducedMotion } from '@/design/useReducedMotion';

/**
 * Step transition for content: a short fade with a few points of rise.
 * Communicates "new question" without theatrics. Reduced motion: none.
 */
export function Reveal({
  children,
  delay = 0,
  duration = motion.standard,
  style,
}: {
  children: ReactNode;
  delay?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    });
    anim.start();
    return () => anim.stop();
  }, [reduced, delay, duration, progress]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [motion.rise, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
