import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Text } from '@/components/Text';
import { Chevron } from '@/components/member/Controls';
import { Photo } from '@/components/member/Photo';
import { copy } from '@/copy/en';
import { color, layout, motion, space } from '@/design/tokens';
import { nativeDriver, useReducedMotion } from '@/design/useReducedMotion';
import { dateline } from '@/domain/member/conversation';
import type { MemberProfileView } from '@/domain/member/views';
import { useMember, useMemberActions } from '@/state/member/MemberProvider';

/**
 * Home — today's introductions, one person at a time (DEC-050). Every
 * introduction comes from the server and has already passed the single
 * eligibility function (DEC-058); this screen filters nothing.
 *
 * The person is the screen: their first photograph, their name, what they
 * do and where. Opening them is the only action here; pass and like live in
 * the profile, after you've looked. There is no count, no grid and no feed —
 * a quiet line says whether more are waiting today.
 */
export default function Home() {
  const actions = useMemberActions();
  const intro = useMember((s) => s.introductions);
  const hasConversations = useMember((s) => (s.conversations?.length ?? 0) > 0);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    const res = await actions.loadIntroductions();
    setError(!res.ok);
  }, [actions]);

  useFocusEffect(
    useCallback(() => {
      void load();
      void actions.loadConversations();
    }, [load, actions]),
  );

  const current = intro?.waiting[0]?.member ?? null;
  const t = copy.member.home;

  return (
    <View style={styles.root} testID="screen-home">
      {current ? (
        <IntroductionCover
          key={current.memberId}
          view={current}
          more={(intro?.waiting.length ?? 0) > 1}
          onOpen={() => router.push(`/member/profile/${current.memberId}` as Href)}
        />
      ) : intro?.state === 'NOT_USING_DATING' ? (
        // Introductions are for members open to dating (DEC-058). Friendship and
        // community surfaces are a later phase; nothing is promised here.
        <Quiet headline={t.notDatingHeadline} body={t.notDatingBody} kicker={copy.member.tabs.home} testID="home-not-dating">
          {hasConversations ? (
            <Button variant="quiet" label={t.toMessages} onPress={() => router.navigate('/member/messages' as Href)} testID="home-to-messages" />
          ) : null}
        </Quiet>
      ) : intro?.state === 'DATING_SETUP_REQUIRED' ? (
        <Quiet headline={t.setupHeadline} body={t.setupBody} testID="home-setup-required">
          <Button variant="quiet" label={t.setupAction} onPress={() => router.push('/member/dating-setup' as Href)} testID="home-dating-setup" />
        </Quiet>
      ) : intro ? (
        <Quiet
          headline={intro.hadIntroductions ? t.doneHeadline : t.emptyHeadline}
          body={intro.hadIntroductions ? t.doneBody : t.emptyBody}
          testID={intro.hadIntroductions ? 'home-done' : 'home-empty'}
        >
          {hasConversations ? (
            <Button variant="quiet" label={t.toMessages} onPress={() => router.navigate('/member/messages' as Href)} testID="home-to-messages" />
          ) : null}
        </Quiet>
      ) : error ? (
        <Quiet headline={t.kicker} body="">
          <Notice message={t.loadFailed} />
          <Button variant="quiet" label={copy.common.retry} onPress={() => void load()} testID="home-retry" />
        </Quiet>
      ) : null}
    </View>
  );
}

function IntroductionCover({ view, more, onOpen }: { view: MemberProfileView; more: boolean; onOpen: () => void }) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const t = copy.member.home;
  const [enter] = useState(() => new Animated.Value(reduced ? 1 : 0));
  useEffect(() => {
    if (reduced) {
      enter.setValue(1);
      return;
    }
    const anim = Animated.timing(enter, { toValue: 1, duration: motion.standard, easing: Easing.out(Easing.quad), useNativeDriver: nativeDriver });
    anim.start();
    return () => anim.stop();
  }, [enter, reduced]);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: enter }]} testID="home-introduction">
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={t.open(view.displayName)}
        testID="home-open"
      >
        {({ pressed }) => (
          <>
            <Photo photo={view.photos[0]} style={StyleSheet.absoluteFill} transition={0} />
            <LinearGradient
              pointerEvents="none"
              colors={['rgba(11,11,12,0.72)', 'rgba(11,11,12,0.18)', 'rgba(11,11,12,0)', 'rgba(11,11,12,0.7)', 'rgba(11,11,12,0.96)']}
              locations={[0, 0.14, 0.4, 0.74, 1]}
              style={StyleSheet.absoluteFill}
            />
            {pressed ? <View style={[StyleSheet.absoluteFill, styles.pressed]} /> : null}
          </>
        )}
      </Pressable>

      <View style={[styles.top, { paddingTop: insets.top + space[3] }]} pointerEvents="none">
        <Text variant="label" testID="home-kicker">
          {t.kicker}
        </Text>
        <Text variant="caption" style={styles.dateline}>
          {dateline(new Date())}
        </Text>
      </View>

      <View style={styles.identity} pointerEvents="none">
        <View style={styles.nameRow}>
          <Text variant="display" style={styles.name} numberOfLines={1} testID="home-name">
            {view.displayName}
          </Text>
          <Text variant="title" tone="secondary" style={styles.age}>
            {String(view.age)}
          </Text>
        </View>
        {view.occupation ? (
          <Text variant="bodyLarge" numberOfLines={1}>
            {view.occupation}
          </Text>
        ) : null}
        {view.cityLabel ? (
          <Text variant="supporting" tone="secondary">
            {view.cityLabel}
          </Text>
        ) : null}
        {view.knownFor ? (
          <Text variant="supporting" style={styles.knownFor} numberOfLines={2}>
            {view.knownFor}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <View style={styles.viewProfile}>
            <Text variant="link">{t.view}</Text>
            <Chevron direction="right" size={7} />
          </View>
          <Text variant="caption" tone="secondary" testID="home-remaining">
            {more ? t.more : t.last}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

function Quiet({
  headline,
  body,
  children,
  testID,
  kicker = copy.member.home.kicker,
}: {
  headline: string;
  body: string;
  children?: React.ReactNode;
  testID?: string;
  kicker?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.quiet, { paddingTop: insets.top + space[3] }]} testID={testID}>
      <Text variant="label">{kicker}</Text>
      <Text variant="caption" tone="secondary">
        {dateline(new Date())}
      </Text>
      <View style={styles.quietBody}>
        <Text variant="display" accessibilityRole="header">
          {headline}
        </Text>
        {body ? (
          <Text variant="bodyLarge" tone="secondary" style={styles.quietText}>
            {body}
          </Text>
        ) : null}
        <View style={styles.quietActions}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  pressed: { backgroundColor: 'rgba(11,11,12,0.12)' },
  dateline: { color: 'rgba(243,240,234,0.78)' },
  top: { position: 'absolute', left: layout.gutter, right: layout.gutter, top: 0, gap: 2 },
  identity: {
    position: 'absolute',
    left: layout.gutter,
    right: layout.gutter,
    bottom: space[5],
    maxWidth: layout.maxContentWidth,
  },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', columnGap: space[3] },
  name: { fontSize: 48, lineHeight: 54, letterSpacing: -0.9, flexShrink: 1 },
  age: { fontSize: 24, lineHeight: 30 },
  knownFor: { marginTop: space[3], color: 'rgba(243,240,234,0.86)', maxWidth: 420 },
  footer: {
    marginTop: space[5],
    paddingTop: space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  viewProfile: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  quiet: { flex: 1, paddingHorizontal: layout.gutter, width: '100%', maxWidth: layout.maxContentWidth + layout.gutter * 2, alignSelf: 'center', gap: 2 },
  quietBody: { flex: 1, justifyContent: 'center', paddingBottom: space[16] },
  quietText: { marginTop: space[3], maxWidth: 380 },
  quietActions: { marginTop: space[6], gap: space[2] },
});
