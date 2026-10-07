import { LinearGradient } from 'expo-linear-gradient';
import { router, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { StagingMark } from '@/components/StagingMark';
import { Text } from '@/components/Text';
import { Chevron } from '@/components/member/Controls';
import { Photo } from '@/components/member/Photo';
import { copy } from '@/copy/en';
import { color, layout, space } from '@/design/tokens';
import { useAdmissionActions } from '@/state/admission/AdmissionProvider';
import { useMember } from '@/state/member/MemberProvider';

/** You — the member's own space: their profile, and the few settings this slice needs. */
export default function You() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const me = useMember((s) => s.me);
  const admission = useAdmissionActions();
  const t = copy.member.you;
  const p = me?.profile;
  const bandH = Math.round(Math.min(height * 0.56, 520));

  return (
    <View style={styles.root} testID="screen-you">
      <ScrollView contentContainerStyle={{ paddingBottom: space[10] }} showsVerticalScrollIndicator={false}>
        <Pressable
          onPress={() => router.push('/member/profile/me' as Href)}
          accessibilityRole="button"
          accessibilityLabel={t.viewProfile}
          style={{ height: bandH }}
          testID="you-portrait"
        >
          <Photo photo={p?.photos[0]} style={StyleSheet.absoluteFill} />
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(11,11,12,0.45)', 'rgba(11,11,12,0)', 'rgba(11,11,12,0.6)', color.obsidian]}
            locations={[0, 0.25, 0.7, 1]}
            style={StyleSheet.absoluteFill}
          />
          {p ? (
            <View style={[styles.identity, { paddingTop: insets.top }]} pointerEvents="none">
              <View style={styles.nameRow}>
                <Text variant="display" numberOfLines={1} style={styles.name} testID="you-name">
                  {p.displayName}
                </Text>
                <Text variant="title" tone="secondary">
                  {String(p.age)}
                </Text>
              </View>
              {p.occupation ? <Text variant="bodyLarge">{p.occupation}</Text> : null}
              {p.cityLabel ? (
                <Text variant="supporting" tone="secondary">
                  {p.cityLabel}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Pressable>

        <View style={styles.column}>
          <View style={styles.group}>
            <Row label={t.viewProfile} onPress={() => router.push('/member/profile/me' as Href)} testID="you-view-profile" first />
            <Row label={t.edit} onPress={() => router.push('/member/edit-profile' as Href)} testID="you-edit" />
            {me?.dating.usesDating ? (
              <Row
                label={t.datingPreferences}
                onPress={() => router.push('/member/dating-preferences' as Href)}
                testID="you-dating"
              />
            ) : null}
            <Row
              label={t.membership}
              value={me?.membership.status === 'active' ? t.active : undefined}
              onPress={() => router.push('/member/membership' as Href)}
              testID="you-membership"
            />
            <Row label={t.privacy} onPress={() => router.push('/member/privacy' as Href)} testID="you-privacy" />
          </View>
          <Button variant="quiet" label={t.signOut} onPress={() => void admission.signOut()} style={styles.signOut} testID="you-sign-out" />
          <StagingMark />
        </View>
      </ScrollView>
    </View>
  );
}

function Row({ label, value, onPress, testID, first = false }: { label: string; value?: string; onPress: () => void; testID: string; first?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      style={({ pressed }) => [styles.row, !first && styles.divider, pressed && { opacity: 0.6 }]}
      testID={testID}
    >
      <Text variant="bodyLarge" style={styles.rowLabel}>
        {label}
      </Text>
      {value ? (
        <Text variant="supporting" tone="secondary">
          {value}
        </Text>
      ) : null}
      <Chevron direction="right" size={7} tint={color.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  identity: { position: 'absolute', left: layout.gutter, right: layout.gutter, bottom: space[5] },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', columnGap: space[3] },
  name: { flexShrink: 1 },
  column: {
    paddingHorizontal: layout.gutter,
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
  },
  group: { marginTop: space[3] },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space[3] },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  rowLabel: { flex: 1 },
  signOut: { marginTop: space[8] },
});
