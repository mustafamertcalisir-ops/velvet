import { Image } from 'expo-image';
import { ActivityIndicator, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { copy } from '@/copy/en';
import { color, layout, radius, space } from '@/design/tokens';
import type { ApplicationPhoto } from '@/domain/admission/stage2';
import { Text } from './Text';

const GAP = space[2];

/**
 * Six frames composed like a contact print, not an upload grid:
 *
 *   ┌───────────────┬───────┐
 *   │               │   2   │
 *   │       1       ├───────┤   1 — the photograph that introduces you
 *   │               │   3   │
 *   ├───────┬───────┼───────┤
 *   │   4   │   5   │   6   │
 *   └───────┴───────┴───────┘
 *
 * The first frame's size says "this one leads" — no label needed. Empty
 * frames are quiet unlabelled fills (a contact sheet waiting for prints, not
 * a row of upload buttons); only the next frame to fill carries a mark. Any
 * empty frame opens the library.
 */
export function PhotoCollage({
  photos,
  max,
  uploading,
  onAdd,
  onPhotoPress,
}: {
  photos: readonly ApplicationPhoto[];
  max: number;
  uploading: number;
  onAdd: () => void;
  onPhotoPress: (photo: ApplicationPhoto, index: number) => void;
}) {
  const { width } = useWindowDimensions();
  const W = Math.min(width - layout.gutter * 2, layout.maxContentWidth);
  const heroW = Math.round(((W - GAP) * 2) / 3);
  const heroH = Math.round((heroW * 4) / 3);
  const sideW = W - GAP - heroW;
  const sideH = Math.round((heroH - GAP) / 2);
  const smallW = Math.floor((W - GAP * 2) / 3);
  const smallH = Math.round((smallW * 4) / 3);

  const sizes = [
    { width: heroW, height: heroH },
    { width: sideW, height: sideH },
    { width: sideW, height: sideH },
    { width: smallW, height: smallH },
    { width: smallW, height: smallH },
    { width: smallW, height: smallH },
  ].slice(0, max);

  const firstEmpty = photos.length + uploading;

  const frame = (i: number) => {
    const size = sizes[i]!;
    const photo = photos[i];
    const isHero = i === 0;
    if (photo) {
      return (
        <Pressable
          key={photo.id}
          onPress={() => onPhotoPress(photo, i)}
          accessibilityRole="button"
          accessibilityLabel={
            isHero ? copy.extended.photos.heroA11y(photos.length) : copy.extended.photos.photoA11y(i + 1, photos.length)
          }
          style={({ pressed }) => [styles.frame, isHero && styles.hero, size, pressed && { opacity: 0.85 }]}
          testID={`photo-${i}`}
        >
          <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        </Pressable>
      );
    }
    if (i < firstEmpty) {
      return (
        <View key={`up-${i}`} style={[styles.frame, styles.uploading, isHero && styles.hero, size]} accessibilityLabel={copy.extended.photos.uploading}>
          <ActivityIndicator color={color.smoke} />
        </View>
      );
    }
    const isNext = i === firstEmpty;
    return (
      <Pressable
        key={`slot-${i}`}
        onPress={onAdd}
        accessibilityRole="button"
        accessibilityLabel={isHero ? copy.extended.photos.addFirstA11y : copy.extended.photos.addA11y}
        style={({ pressed }) => [
          styles.frame,
          styles.empty,
          isNext && styles.emptyNext,
          isHero && styles.hero,
          size,
          pressed && { opacity: 0.7 },
        ]}
        testID={isNext ? 'photo-add' : undefined}
      >
        {isNext ? (
          <View style={styles.plus}>
            <View style={styles.plusH} />
            <View style={styles.plusV} />
          </View>
        ) : null}
        {isHero ? (
          <Text variant="supporting" tone="secondary" style={styles.heroInvite}>
            {copy.extended.photos.addFirst}
          </Text>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View style={{ width: W, gap: GAP }} testID="photo-grid">
      <View style={styles.row}>
        {frame(0)}
        <View style={{ gap: GAP }}>
          {frame(1)}
          {frame(2)}
        </View>
      </View>
      <View style={styles.row}>
        {frame(3)}
        {frame(4)}
        {frame(5)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: GAP },
  frame: {
    borderRadius: radius.control,
    overflow: 'hidden',
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: { borderRadius: radius.medium },
  uploading: { backgroundColor: color.surface },
  empty: { backgroundColor: 'rgba(243,240,234,0.035)' },
  emptyNext: {
    backgroundColor: 'rgba(243,240,234,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineStrong,
  },
  heroInvite: { marginTop: space[3], textAlign: 'center', paddingHorizontal: space[5] },
  plus: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  plusH: { position: 'absolute', width: 18, height: 1.5, backgroundColor: color.smoke },
  plusV: { position: 'absolute', width: 1.5, height: 18, backgroundColor: color.smoke },
});
