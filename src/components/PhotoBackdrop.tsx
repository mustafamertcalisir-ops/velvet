import { Image, type ImageSource } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';

import { color } from '@/design/tokens';

/**
 * Photography first. The image fills its frame; the gradient exists only so
 * type stays legible, and reaches near-solid Obsidian wherever text sits.
 * Images are pre-graded (scripts/grade-photography.py) so highlights never
 * glare behind text.
 *
 * 'full' — fills the screen; text sits in the lower ~45% (Launch, Received)
 * 'band' — fills its parent (e.g. the top band of Status) and dissolves into the page
 */
export function PhotoBackdrop({
  source,
  variant = 'full',
  accessibilityLabel,
}: {
  source: ImageSource | number;
  variant?: 'full' | 'band';
  accessibilityLabel?: string;
}) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Image
        source={source}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={250}
        accessible={Boolean(accessibilityLabel)}
        accessibilityLabel={accessibilityLabel}
      />
      {variant === 'full' ? (
        <LinearGradient
          colors={['rgba(11,11,12,0.45)', 'rgba(11,11,12,0)', 'rgba(11,11,12,0.55)', 'rgba(11,11,12,0.9)', color.obsidian]}
          locations={[0, 0.18, 0.45, 0.66, 0.86]}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <LinearGradient
          colors={['rgba(11,11,12,0.45)', 'rgba(11,11,12,0.05)', 'rgba(11,11,12,0.6)', color.obsidian]}
          locations={[0, 0.3, 0.72, 1]}
          style={StyleSheet.absoluteFill}
        />
      )}
    </View>
  );
}
