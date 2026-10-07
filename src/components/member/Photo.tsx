import { Image } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { color } from '@/design/tokens';
import type { MemberPhoto } from '@/domain/member/views';

/**
 * A member photograph. Fills its frame (cover); while loading, or when a
 * member has no photo, the frame is plain Ink — never a placeholder face.
 */
export function Photo({
  photo,
  style,
  accessibilityLabel,
  transition = 200,
  testID,
}: {
  photo: MemberPhoto | null | undefined;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  transition?: number;
  testID?: string;
}) {
  return (
    <View style={[styles.frame, style]} testID={testID}>
      {photo ? (
        <Image
          source={{ uri: photo.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={transition}
          accessible={Boolean(accessibilityLabel)}
          accessibilityLabel={accessibilityLabel}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: color.surface },
});
