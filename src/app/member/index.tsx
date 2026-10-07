import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Reveal } from '@/components/Reveal';
import { Text } from '@/components/Text';
import { Photo } from '@/components/member/Photo';
import { copy } from '@/copy/en';
import { color, layout, motion, space } from '@/design/tokens';
import { nativeDriver, useReducedMotion } from '@/design/useReducedMotion';
import { useMember, useMemberActions } from '@/state/member/MemberProvider';
import { useMemberQuery } from '@/state/member/useMemberQuery';

/**
 * The member entrance (/member). The first time — before the profile is
 * confirmed — it is the welcome: the member's own photograph, one line, one
 * action, leading to Dating setup (members using Dating, DEC-058) and then
 * Profile confirmation. Afterwards it simply opens Home. Whether the profile was confirmed
 * is the server's record, not a device flag (DEC-048).
 */
export default function MemberEntrance() {
  const actions = useMemberActions();
  const cached = useMember((s) => s.me);
  const me = useMemberQuery(() => actions.loadMe(), 'me', cached);

  if (me.value?.profile.confirmedAt) return <Redirect href="/member/home" />;

  return (
    <View style={styles.root} testID="screen-member">
      {me.value ? (
        <Welcome photo={me.value.profile.photos[0] ?? null} datingSetup={me.value.dating.setupRequired} />
      ) : me.status === 'error' ? (
        <View style={styles.center}>
          <Notice message={copy.member.loadFailed} />
          <Button variant="quiet" label={copy.common.retry} onPress={() => void me.reload()} />
        </View>
      ) : null}
    </View>
  );
}

function Welcome({ photo, datingSetup }: { photo: Parameters<typeof Photo>[0]['photo']; datingSetup: boolean }) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const t = copy.member.welcome;
  // One orchestrated moment: the room opens — the photograph comes up out of Obsidian.
  const [open] = useState(() => new Animated.Value(reduced ? 1 : 0));
  useEffect(() => {
    if (reduced) {
      open.setValue(1);
      return;
    }
    const anim = Animated.timing(open, {
      toValue: 1,
      duration: motion.considered,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    });
    anim.start();
    return () => anim.stop();
  }, [open, reduced]);

  return (
    <View style={StyleSheet.absoluteFill} testID="screen-member-welcome">
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { opacity: open, transform: [{ scale: open.interpolate({ inputRange: [0, 1], outputRange: [1.03, 1] }) }] },
        ]}
      >
        <Photo photo={photo} style={StyleSheet.absoluteFill} accessibilityLabel={t.photoA11y} transition={0} />
      </Animated.View>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(11,11,12,0.35)', 'rgba(11,11,12,0)', 'rgba(11,11,12,0.6)', 'rgba(11,11,12,0.94)', color.obsidian]}
        locations={[0, 0.2, 0.5, 0.72, 0.9]}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, space[5]) + space[2] }]}>
        <Reveal delay={reduced ? 0 : 120} duration={motion.considered}>
          <Text variant="display" accessibilityRole="header" style={styles.headline} testID="welcome-headline">
            {t.headline}
          </Text>
          <Text variant="bodyLarge" tone="secondary" style={styles.body}>
            {t.body}
          </Text>
        </Reveal>
        <Button label={t.cta} onPress={() => router.push(datingSetup ? '/member/dating-setup' : '/member/confirm')} style={styles.cta} testID="welcome-continue" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  center: { flex: 1, justifyContent: 'center', padding: layout.gutter },
  bottom: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: layout.gutter,
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
  },
  headline: { fontSize: 48, lineHeight: 54, letterSpacing: -0.9 },
  body: { marginTop: space[3], maxWidth: 360 },
  cta: { marginTop: space[10] },
});
