import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Glass, GlassBack } from '@/components/Glass';
import { Text } from '@/components/Text';
import { Chevron, GlassMore } from '@/components/member/Controls';
import { SafetySheet } from '@/components/member/SafetySheet';
import { ProfileView } from '@/components/profile/ProfileView';
import { copy } from '@/copy/en';
import { color, layout, motion, radius, space } from '@/design/tokens';
import { nativeDriver, useReducedMotion } from '@/design/useReducedMotion';
import type { ReactionType } from '@/domain/member/matching';
import { memberPresentation, type MemberProfileView } from '@/domain/member/views';
import { haptics } from '@/lib/haptics';
import { useMember, useMemberActions } from '@/state/member/MemberProvider';
import { useMemberQuery } from '@/state/member/useMemberQuery';

/**
 * A member's profile — the central dating surface.
 *
 * The person occupies the screen (lead photograph, then one editorial column
 * of words and photographs). Chrome is two glass controls at the top. For an
 * introduction, Pass and Like sit in one quiet glass bar at the bottom — the
 * person first, the decision second. `me` shows your own profile as members
 * see it.
 */
export default function MemberProfileRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return id === 'me' ? <OwnProfile /> : <OtherProfile memberId={String(id)} />;
}

function OwnProfile() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const me = useMember((s) => s.me);
  if (!me) return <View style={styles.root} />;
  return (
    <View style={styles.root} testID="screen-profile-own">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + space[10] }}>
        <ProfileView
          profile={memberPresentation(me.profile)}
          firstFrameHeight={height}
          bottomInset={insets.bottom + space[8]}
          labels={labels}
          topOverlay={
            <View style={[styles.top, { paddingTop: insets.top + space[2] }]}>
              <GlassBack onPress={() => router.back()} label={copy.common.back} />
              <Glass style={styles.chip}>
                <Text variant="caption">{copy.member.profile.yours}</Text>
              </Glass>
              <View style={styles.spacer} />
            </View>
          }
        />
      </ScrollView>
    </View>
  );
}

const labels = { knownFor: copy.member.profile.knownFor, interests: copy.member.profile.interests, photo: copy.member.profile.photoA11y };

type Decision = { type: ReactionType } | null;

function OtherProfile({ memberId }: { memberId: string }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const actions = useMemberActions();
  const cached = useMember((s) => s.profiles[memberId] ?? null);
  // The introduction this profile was opened from (if any) — fixed for this visit.
  const waiting = useWaitingIntroductionId(memberId);
  const [introductionId] = useState(waiting);
  const introduction = introductionId !== null;
  const query = useMemberQuery(() => actions.loadProfile(memberId), String(memberId), cached);
  const [decision, setDecision] = useState<Decision>(null);
  const [busy, setBusy] = useState<ReactionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [safety, setSafety] = useState(false);
  const t = copy.member.profile;

  const view: MemberProfileView | null = query.value;
  const unavailable = query.status === 'error' && query.error.kind === 'not_available';
  const barH = 56;
  const footerSpace = barH + Math.max(insets.bottom, space[3]) + space[3];

  const react = async (type: ReactionType) => {
    if (!view || busy || decision || !introductionId) return;
    if (type === 'LIKE') haptics.light();
    setBusy(type);
    setError(null);
    const res = await actions.react(introductionId, type);
    setBusy(null);
    if (!res.ok) {
      const gone = ['not_eligible', 'introduction_expired', 'introduction_not_found', 'not_available'].includes(res.error.kind);
      setError(gone ? t.unavailable : t.failed);
      return;
    }
    if (res.value.match) {
      haptics.success();
      router.replace(`/member/match/${res.value.match.matchId}` as Href);
      return;
    }
    setDecision({ type });
  };

  if (unavailable || (!view && query.status === 'error')) {
    return (
      <View style={[styles.root, styles.unavailable, { paddingTop: insets.top + space[16] }]} testID="screen-profile-unavailable">
        <Text variant="headline">{unavailable ? t.unavailable : copy.member.loadFailed}</Text>
        <Button variant="quiet" label={copy.common.back} onPress={() => router.back()} style={styles.unavailableBack} />
      </View>
    );
  }
  if (!view) return <View style={styles.root} testID="screen-profile" />;

  return (
    <View style={styles.root} testID="screen-profile">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: (introduction ? footerSpace : insets.bottom) + space[8] }}
        testID="profile-scroll"
      >
        <ProfileView
          profile={memberPresentation(view)}
          firstFrameHeight={height}
          bottomInset={(introduction ? footerSpace : insets.bottom) + space[6]}
          labels={labels}
          topOverlay={
            <View style={[styles.top, { paddingTop: insets.top + space[2] }]}>
              <GlassBack onPress={() => router.back()} label={copy.common.back} />
              <GlassMore onPress={() => setSafety(true)} label={t.more} testID="profile-more" />
            </View>
          }
        />
      </ScrollView>

      {decision?.type === 'PASS' ? <SetAside /> : null}

      {introduction ? (
        <View style={[styles.barWrap, { paddingBottom: Math.max(insets.bottom, space[3]) }]} pointerEvents="box-none">
          {decision ? (
            <Outcome
              text={decision.type === 'LIKE' ? t.liked(view.displayName) : t.passed(view.displayName)}
              testID={decision.type === 'LIKE' ? 'outcome-liked' : 'outcome-passed'}
            />
          ) : (
            <Glass style={styles.bar}>
              <Choice
                label={t.pass}
                a11y={t.passA11y(view.displayName)}
                tone="secondary"
                busy={busy === 'PASS'}
                onPress={() => void react('PASS')}
                testID="decision-pass"
              />
              <View style={styles.barDivider} />
              <Choice
                label={t.like}
                a11y={t.likeA11y(view.displayName)}
                tone="primary"
                busy={busy === 'LIKE'}
                onPress={() => void react('LIKE')}
                testID="decision-like"
              />
            </Glass>
          )}
          {error ? (
            <Text variant="caption" tone="error" style={styles.error} accessibilityLiveRegion="polite" testID="decision-error">
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}

      <SafetySheet
        visible={safety}
        onClose={() => setSafety(false)}
        memberId={memberId}
        name={view.displayName}
        context="profile"
        onBlocked={() => router.navigate('/member/home' as Href)}
      />
    </View>
  );
}

/** The waiting introduction for this member today, if any. */
function useWaitingIntroductionId(memberId: string): string | null {
  return useMember((s) => s.introductions?.waiting.find((w) => w.member.memberId === memberId)?.introductionId ?? null);
}

function Choice({
  label,
  a11y,
  tone,
  busy,
  onPress,
  testID,
}: {
  label: string;
  a11y: string;
  tone: 'primary' | 'secondary';
  busy: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ busy }}
      style={({ pressed }) => [styles.choice, (pressed || busy) && (tone === 'primary' ? styles.choiceLikePressed : styles.choicePressed)]}
      testID={testID}
    >
      {({ pressed }) => (
        <Text variant="button" tone={(pressed || busy) && tone === 'primary' ? 'inverse' : tone}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** The decision, said plainly — then the way on. */
function Outcome({ text, testID }: { text: string; testID: string }) {
  const reduced = useReducedMotion();
  const [rise] = useState(() => new Animated.Value(reduced ? 1 : 0));
  useEffect(() => {
    if (reduced) {
      rise.setValue(1);
      return;
    }
    const anim = Animated.timing(rise, { toValue: 1, duration: motion.standard, easing: Easing.out(Easing.cubic), useNativeDriver: nativeDriver });
    anim.start();
    return () => anim.stop();
  }, [rise, reduced]);
  return (
    <Animated.View
      style={{ opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [motion.rise, 0] }) }] }}
    >
      <Glass style={styles.outcome}>
        <Text variant="caption" style={styles.outcomeText} accessibilityLiveRegion="polite" testID={testID}>
          {text}
        </Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={copy.member.profile.next}
          hitSlop={8}
          style={({ pressed }) => [styles.next, pressed && { opacity: 0.6 }]}
          testID="outcome-next"
        >
          <Text variant="link">{copy.member.profile.nextShort}</Text>
          <Chevron direction="right" size={7} />
        </Pressable>
      </Glass>
    </Animated.View>
  );
}

/** A pass sets the person gently aside: the view dims, nothing more. */
function SetAside() {
  const reduced = useReducedMotion();
  const [dim] = useState(() => new Animated.Value(reduced ? 1 : 0));
  useEffect(() => {
    if (reduced) {
      dim.setValue(1);
      return;
    }
    const anim = Animated.timing(dim, { toValue: 1, duration: motion.considered, useNativeDriver: nativeDriver });
    anim.start();
    return () => anim.stop();
  }, [dim, reduced]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: dim }]}>
      <LinearGradient
        colors={['rgba(11,11,12,0.35)', 'rgba(11,11,12,0.55)']}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  top: {
    position: 'absolute',
    left: layout.gutter - 8,
    right: layout.gutter - 8,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chip: { height: 32, paddingHorizontal: space[3], borderRadius: 16, justifyContent: 'center' },
  spacer: { width: 44 },
  barWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space[4],
    alignItems: 'center',
  },
  bar: {
    width: '100%',
    maxWidth: layout.maxContentWidth,
    height: 56,
    // A little more density than other glass: the bar may sit on bright photographs.
    backgroundColor: 'rgba(11,11,12,0.38)',
    borderRadius: radius.medium,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  barDivider: { width: StyleSheet.hairlineWidth, marginVertical: space[3], backgroundColor: 'rgba(243,240,234,0.22)' },
  choice: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  choicePressed: { backgroundColor: 'rgba(243,240,234,0.08)' },
  choiceLikePressed: { backgroundColor: color.pearl },
  outcome: {
    width: '100%',
    maxWidth: layout.maxContentWidth,
    minHeight: 56,
    backgroundColor: 'rgba(11,11,12,0.38)',
    borderRadius: radius.medium,
    paddingLeft: space[4],
    paddingRight: space[3],
    paddingVertical: space[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  outcomeText: { flex: 1, color: color.text },
  next: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[2] },
  error: { marginTop: space[2], textAlign: 'center' },
  unavailable: { paddingHorizontal: layout.gutter },
  unavailableBack: { marginTop: space[4] },
});
