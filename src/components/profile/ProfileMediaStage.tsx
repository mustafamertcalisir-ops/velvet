import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';

import { color, motion } from '@/design/tokens';
import { nativeDriver, useReducedMotion } from '@/design/useReducedMotion';
import type { ProfileMediaItem } from '@/domain/profile/profilePresentation';

/**
 * The media frame of a profile: a sequence of items (photos today; a short
 * video can slot in later) shown one at a time with a short cross-fade.
 * Tap the left/right third to step. Reduced motion: instant change.
 */
export function ProfileMediaStage({
  media,
  index,
  onIndexChange,
}: {
  media: readonly ProfileMediaItem[];
  index: number;
  onIndexChange: (i: number) => void;
}) {
  const reduced = useReducedMotion();
  const [previous, setPrevious] = useState<number | null>(null);
  const [fade] = useState(() => new Animated.Value(1));
  const [shown, setShown] = useState(index);

  // Adopt a new index during render (React's "previous value" pattern); the
  // effect below only runs the cross-fade.
  if (index !== shown) {
    setPrevious(reduced ? null : shown);
    setShown(index);
  }

  useEffect(() => {
    if (previous === null) return;
    fade.setValue(0);
    const anim = Animated.timing(fade, {
      toValue: 1,
      duration: motion.standard,
      easing: Easing.out(Easing.quad),
      useNativeDriver: nativeDriver,
    });
    anim.start(({ finished }) => {
      if (finished) setPrevious(null);
    });
    return () => anim.stop();
  }, [previous, shown, fade]);

  const current = media[shown];
  const prior = previous !== null ? media[previous] : undefined;

  return (
    <View style={StyleSheet.absoluteFill}>
      {prior ? <MediaLayer item={prior} /> : null}
      {current ? (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
          <MediaLayer item={current} />
        </Animated.View>
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: color.surface }]} />
      )}
      {media.length > 1 ? (
        <View style={styles.taps}>
          <Pressable
            style={styles.tap}
            onPress={() => onIndexChange(Math.max(0, index - 1))}
            accessibilityRole="button"
            accessibilityLabel="Previous photo"
            testID="media-previous"
          />
          <View style={styles.middle} pointerEvents="none" />
          <Pressable
            style={styles.tap}
            onPress={() => onIndexChange(Math.min(media.length - 1, index + 1))}
            accessibilityRole="button"
            accessibilityLabel="Next photo"
            testID="media-next"
          />
        </View>
      ) : null}
    </View>
  );
}

function MediaLayer({ item }: { item: ProfileMediaItem }) {
  if (item.kind === 'photo') {
    return <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />;
  }
  // Video (future): poster frame for now; playback arrives with member profiles.
  return (
    <View style={StyleSheet.absoluteFill}>
      <Image source={{ uri: item.posterUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
    </View>
  );
}

const styles = StyleSheet.create({
  taps: { ...(StyleSheet.absoluteFill as object), flexDirection: 'row' },
  tap: { flex: 1 },
  middle: { flex: 1 },
});
