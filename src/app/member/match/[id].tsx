import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Text } from '@/components/Text';
import { Photo } from '@/components/member/Photo';
import { copy } from '@/copy/en';
import { color, layout, motion, radius, space } from '@/design/tokens';
import { nativeDriver, useReducedMotion } from '@/design/useReducedMotion';
import type { MemberCard } from '@/domain/member/views';
import { useMemberActions } from '@/state/member/MemberProvider';
import { useMemberQuery } from '@/state/member/useMemberQuery';

/**
 * The match moment (DEC-051). Two photographs — theirs and yours — move
 * together until they almost touch; one line; two ways on. No confetti, no
 * hearts, no borrowed catchphrase. The match comes from the server; this
 * screen only shows one that exists.
 */
export default function MatchMoment() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const actions = useMemberActions();
  const match = useMemberQuery(() => actions.loadMatch(String(id)), String(id));
  const reduced = useReducedMotion();
  const [together] = useState(() => new Animated.Value(reduced ? 1 : 0));
  const t = copy.member.match;

  const ready = match.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    if (reduced) {
      together.setValue(1);
      return;
    }
    const anim = Animated.timing(together, {
      toValue: 1,
      duration: motion.considered,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    });
    anim.start();
    return () => anim.stop();
  }, [ready, reduced, together]);

  const column = Math.min(width, layout.maxContentWidth + layout.gutter * 2) - layout.gutter * 2;
  const gap = 4;
  const frameW = Math.floor((column - gap) / 2);
  const frameH = Math.round(frameW * 1.3);

  if (match.status === 'error') {
    return (
      <View style={[styles.root, { paddingTop: insets.top + space[16], paddingHorizontal: layout.gutter }]} testID="screen-match">
        <Notice message={copy.member.profile.unavailable} />
        <Button variant="quiet" label={t.keep} onPress={() => router.back()} />
      </View>
    );
  }

  const v = match.value;
  const slide = (dir: -1 | 1) => ({
    opacity: together,
    transform: [{ translateX: together.interpolate({ inputRange: [0, 1], outputRange: [dir * 20, 0] }) }],
  });

  return (
    <View style={[styles.root, { paddingTop: insets.top + space[10], paddingBottom: Math.max(insets.bottom, space[5]) + space[2] }]} testID="screen-match">
      <View style={[styles.column, { width: column }]}>
        {v ? (
          <>
            <View style={styles.diptych}>
              <Animated.View style={slide(-1)}>
                <Frame card={v.other} label={v.other.displayName} w={frameW} h={frameH} testID="match-their-photo" />
              </Animated.View>
              <View style={{ width: gap }} />
              <Animated.View style={slide(1)}>
                <Frame card={v.self} label={t.you} w={frameW} h={frameH} testID="match-your-photo" />
              </Animated.View>
            </View>
            <Animated.View style={[styles.words, { opacity: together }]}>
              <Text variant="display" accessibilityRole="header" style={styles.headline} testID="match-headline">
                {t.headline}
              </Text>
              <Text variant="bodyLarge" tone="secondary" style={styles.body}>
                {t.body(v.other.displayName)}
              </Text>
            </Animated.View>
          </>
        ) : null}
      </View>
      <View style={[styles.actions, { width: column }]}>
        <Button
          label={t.send}
          disabled={!v}
          onPress={() => v && router.replace(`/member/conversation/${v.matchId}` as Href)}
          testID="match-send"
        />
        <Button variant="quiet" label={t.keep} onPress={() => router.back()} style={styles.keep} testID="match-keep" />
      </View>
    </View>
  );
}

function Frame({ card, label, w, h, testID }: { card: MemberCard; label: string; w: number; h: number; testID: string }) {
  return (
    <View>
      <Photo
        photo={card.photo}
        style={{ width: w, height: h, borderRadius: radius.control }}
        accessibilityLabel={copy.member.match.photoA11y(card.displayName)}
        testID={testID}
      />
      <Text variant="caption" tone="secondary" style={styles.frameLabel}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background, alignItems: 'center' },
  column: { flex: 1, justifyContent: 'center' },
  diptych: { flexDirection: 'row' },
  frameLabel: { marginTop: space[2] },
  words: { marginTop: space[10] },
  headline: { fontSize: 44, lineHeight: 50, letterSpacing: -0.8 },
  body: { marginTop: space[3] },
  actions: { gap: space[2] },
  keep: { alignSelf: 'center' },
});
