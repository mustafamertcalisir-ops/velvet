import { BlurView } from 'expo-blur';
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { blur, color, elevation, layout, motion, radius, space } from '@/design/tokens';
import { nativeDriver, useReducedMotion } from '@/design/useReducedMotion';
import { Text } from './Text';

/**
 * A sheet over a dimmed, blurred view of the screen beneath. The backdrop
 * fades; only the sheet rises (a short distance, ~240ms). Used sparingly:
 * pickers and the submit confirmation.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  fill = false,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  fill?: boolean;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [rise] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!visible) return;
    if (reduced) {
      rise.setValue(1);
      return;
    }
    rise.setValue(0);
    const anim = Animated.timing(rise, {
      toValue: 1,
      duration: motion.standard,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    });
    anim.start();
    return () => anim.stop();
  }, [visible, reduced, rise]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduced ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View style={styles.root}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        >
          {Platform.OS === 'android' ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(11,11,12,0.8)' }]} />
          ) : (
            <BlurView intensity={blur.sheet} tint="dark" style={StyleSheet.absoluteFill}>
              <View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim }]} />
            </BlurView>
          )}
        </Pressable>
        <Animated.View
          style={[
            styles.sheet,
            elevation.sheet,
            fill && { top: insets.top + space[6] },
            { paddingBottom: Math.max(insets.bottom, space[4]) + space[2] },
            {
              opacity: rise.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
              transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [32, 0] }) }],
            },
          ]}
          accessibilityViewIsModal
          testID={testID}
        >
          <View style={styles.handle} />
          <View style={[styles.inner, fill && styles.fillBody]}>
            {title ? (
              <Text variant="headline" accessibilityRole="header" style={styles.title}>
                {title}
              </Text>
            ) : null}
            <View style={fill ? styles.fillBody : undefined}>{children}</View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.surfaceRaised,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: layout.gutter,
    paddingTop: space[3],
  },
  inner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.hairlineStrong,
    marginBottom: space[6],
  },
  title: { fontSize: 26, lineHeight: 32, marginBottom: space[3] },
  fillBody: { flex: 1 },
});
