import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Glass, GlassBack } from '@/components/Glass';
import { Notice } from '@/components/Notice';
import { Text } from '@/components/Text';
import { ProfileView } from '@/components/profile/ProfileView';
import { copy } from '@/copy/en';
import { color, layout, space } from '@/design/tokens';
import { memberPresentation } from '@/domain/member/views';
import { useMember, useMemberActions } from '@/state/member/MemberProvider';
import { useMemberQuery } from '@/state/member/useMemberQuery';

/**
 * Profile confirmation. The profile already exists — made at activation from
 * the approved application — so this is a look, not a form: the member sees
 * themselves exactly as members will, can edit, and enters the community.
 */
export default function ConfirmProfile() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const actions = useMemberActions();
  const cached = useMember((s) => s.me);
  const me = useMemberQuery(() => actions.loadMe(), 'me', cached);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = copy.member.confirm;
  const footerH = 54 + space[4] * 2 + Math.max(insets.bottom, space[2]);

  const enter = async () => {
    setBusy(true);
    setError(null);
    const res = await actions.confirmProfile();
    setBusy(false);
    if (res.ok) router.replace('/member/home');
    else setError(copy.member.profile.failed);
  };

  const live = cached ?? me.value;
  if (!live) return <View style={styles.root} testID="screen-confirm" />;
  // A member using Dating states their identity before entering (DEC-058).
  if (live.dating.setupRequired) return <Redirect href="/member/dating-setup" />;
  const profile = memberPresentation(live.profile);

  return (
    <View style={styles.root} testID="screen-confirm">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: footerH + space[6] }}>
        <ProfileView
          profile={profile}
          firstFrameHeight={height}
          bottomInset={footerH + space[5]}
          labels={{ knownFor: copy.member.profile.knownFor, interests: copy.member.profile.interests, photo: copy.member.profile.photoA11y }}
          topOverlay={
            <View style={[styles.top, { paddingTop: insets.top + space[2] }]}>
              <GlassBack onPress={() => router.back()} label={copy.common.back} />
              <Glass style={styles.chip}>
                <Text variant="caption" testID="confirm-chip">
                  {t.chip}
                </Text>
              </Glass>
              <View style={styles.spacer} />
            </View>
          }
        >
          <View style={styles.notes}>
            <Text variant="title">{t.headline}</Text>
            <Text variant="supporting" tone="secondary">
              {t.supporting}
            </Text>
            <Text variant="caption" tone="tertiary" testID="confirm-privacy">
              {t.privacy}
            </Text>
            <Button variant="quiet" label={t.edit} onPress={() => router.push('/member/edit-profile')} style={styles.edit} testID="confirm-edit" />
          </View>
        </ProfileView>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space[2]) + space[4] }]} pointerEvents="box-none">
        <LinearGradient pointerEvents="none" colors={['rgba(11,11,12,0)', 'rgba(11,11,12,0.88)']} style={StyleSheet.absoluteFill} />
        <View style={styles.footerInner}>
          <Notice message={error} />
          <Button label={t.cta} onPress={() => void enter()} loading={busy} testID="confirm-enter" />
        </View>
      </View>
    </View>
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
  notes: {
    marginTop: space[4],
    paddingTop: space[5],
    gap: space[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  edit: { marginTop: space[2] },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: space[6], paddingHorizontal: layout.gutter },
  footerInner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: space[2] },
});
