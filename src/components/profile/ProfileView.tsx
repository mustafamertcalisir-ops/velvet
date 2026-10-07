import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components/Text';
import { color, layout, radius, space } from '@/design/tokens';
import type { ProfileMediaItem, ProfilePresentation } from '@/domain/profile/profilePresentation';
import { ProfileMediaStage } from './ProfileMediaStage';

/**
 * A profile as a member would meet it — our own composition:
 *
 *   ┌──────────────────────────────┐
 *   │ full-bleed lead media        │  the person is the screen
 *   │                              │
 *   │ Çağla 32                     │  serif first name, sans age
 *   │ Architect                    │  what they do
 *   │ Muğla                        │  where (city only)
 *   │ Here for friendship and …    │  intent as one sentence
 *   └──────────────────────────────┘
 *   Known for                         then one quiet editorial column in
 *   I restore wooden yalı houses…     which words and photographs alternate:
 *   [photo 2]                         you get to know someone by scrolling,
 *   Into                              not by tapping through a carousel.
 *   Architecture, Swimming and Jazz   Each photograph appears exactly once.
 *   [photo 3] …
 *
 * Used for the applicant's preview now and intended for member profiles later.
 */
export function ProfileView({
  profile,
  firstFrameHeight,
  bottomInset,
  topOverlay,
  children,
  labels,
}: {
  profile: ProfilePresentation;
  firstFrameHeight: number;
  /** Space reserved at the bottom of the first frame (e.g. for a floating action). */
  bottomInset: number;
  topOverlay?: ReactNode;
  children?: ReactNode;
  labels: { knownFor: string; interests: string; photo: (i: number, n: number) => string };
}) {
  const { width } = useWindowDimensions();
  const total = profile.media.length;
  const lead = profile.media.slice(0, 1);
  const [second, ...rest] = profile.media.slice(1);
  const columnW = Math.min(width - layout.gutter * 2, layout.maxContentWidth);
  const plate = (m: ProfileMediaItem | undefined, i: number) =>
    m ? (
      <Image
        key={m.id}
        source={{ uri: m.kind === 'photo' ? m.uri : m.posterUri }}
        style={[styles.morePhoto, { height: Math.round(columnW * 1.25) }]}
        contentFit="cover"
        accessibilityLabel={labels.photo(i, total)}
        testID="preview-plate"
      />
    ) : null;

  return (
    <View>
      <View style={{ height: firstFrameHeight }} testID="preview-frame">
        <ProfileMediaStage media={lead} index={0} onIndexChange={() => {}} />
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(11,11,12,0.5)', 'rgba(11,11,12,0)', 'rgba(11,11,12,0)', 'rgba(11,11,12,0.72)', color.obsidian]}
          locations={[0, 0.16, 0.48, 0.8, 1]}
          style={StyleSheet.absoluteFill}
        />
        {topOverlay}
        <View style={[styles.identity, { paddingBottom: bottomInset }]} pointerEvents="none">
          <View style={styles.nameRow}>
            <Text variant="display" style={styles.name} numberOfLines={2} testID="preview-name">
              {profile.firstName}
            </Text>
            {profile.age ? (
              <Text variant="title" tone="secondary" style={styles.age} testID="preview-age">
                {String(profile.age)}
              </Text>
            ) : null}
          </View>
          {profile.occupation ? (
            <Text variant="bodyLarge" style={styles.line} numberOfLines={2}>
              {profile.occupation}
            </Text>
          ) : null}
          {profile.cityLabel ? (
            <Text variant="supporting" tone="secondary" style={styles.line}>
              {profile.cityLabel}
            </Text>
          ) : null}
          {profile.intentLine ? (
            <Text variant="supporting" style={[styles.line, styles.intent]}>
              {profile.intentLine}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={[styles.column, { width: columnW }]}>
        {profile.knownFor ? (
          <View style={styles.block}>
            <Text variant="caption" tone="secondary">
              {labels.knownFor}
            </Text>
            <Text variant="bodyLarge" style={styles.knownFor}>
              {profile.knownFor}
            </Text>
          </View>
        ) : null}

        {plate(second, 2)}

        {profile.interestsLine ? (
          <View style={styles.block}>
            <Text variant="caption" tone="secondary">
              {labels.interests}
            </Text>
            <Text variant="bodyLarge" style={styles.knownFor} testID="preview-interests">
              {profile.interestsLine}
            </Text>
          </View>
        ) : null}
        {rest.map((m, i) => plate(m, i + 3))}
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  identity: {
    position: 'absolute',
    left: layout.gutter,
    right: layout.gutter,
    bottom: 0,
  },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: space[3] },
  name: { fontSize: 44, lineHeight: 50, letterSpacing: -0.8 },
  age: { fontSize: 24, lineHeight: 30 },
  line: { marginTop: 2, maxWidth: 420 },
  intent: { marginTop: space[3], color: 'rgba(243,240,234,0.86)' },
  column: { alignSelf: 'center', paddingTop: space[6], gap: space[6] },
  block: { gap: space[2] },
  knownFor: { maxWidth: 520 },
  morePhoto: { width: '100%', borderRadius: radius.medium, backgroundColor: color.surface },
});
