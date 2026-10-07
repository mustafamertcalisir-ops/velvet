import { router, type Href } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { Chevron } from '@/components/member/Controls';
import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { useMemberActions } from '@/state/member/MemberProvider';
import { useMemberQuery } from '@/state/member/useMemberQuery';

/** Privacy & safety — what is shared, what never is, and who you've blocked. */
export default function PrivacySafety() {
  const actions = useMemberActions();
  const blocked = useMemberQuery(() => actions.listBlocked(), 'blocked');
  const t = copy.member.privacy;
  return (
    <ScreenShell onBack={() => router.back()} testID="screen-privacy">
      <Text variant="headline" accessibilityRole="header" style={styles.title}>
        {t.title}
      </Text>
      <Block title={t.seeTitle} body={t.see} />
      <Block title={t.neverTitle} body={t.never} />
      <Block title={t.locationTitle} body={t.location} />
      <View style={styles.block}>
        <Text variant="label">{t.blockedTitle}</Text>
        {blocked.value && blocked.value.length > 0 ? (
          <View style={styles.list} testID="privacy-blocked-list">
            {blocked.value.map((b) => (
              <Text key={b.memberId} variant="bodyLarge">
                {b.displayName}
              </Text>
            ))}
          </View>
        ) : blocked.status !== 'loading' ? (
          <Text variant="supporting" tone="secondary" style={styles.body}>
            {t.noneBlocked}
          </Text>
        ) : null}
        <Text variant="caption" tone="tertiary" style={styles.body}>
          {t.blockedNote}
        </Text>
      </View>
      <Block title={t.reportingTitle} body={t.reporting} />
      <Text variant="caption" tone="tertiary" style={styles.screenshots}>
        {t.screenshots}
      </Text>
      <View style={styles.block}>
        <Text variant="label">{t.accountTitle}</Text>
        <Pressable
          onPress={() => router.push('/member/delete-account' as Href)}
          accessibilityRole="button"
          accessibilityLabel={t.deleteRow}
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
          testID="privacy-delete-account"
        >
          <Text variant="bodyLarge" style={styles.rowLabel}>
            {t.deleteRow}
          </Text>
          <Chevron direction="right" size={7} tint={color.textTertiary} />
        </Pressable>
      </View>
    </ScreenShell>
  );
}

function Block({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.block}>
      <Text variant="label">{title}</Text>
      <Text variant="supporting" tone="secondary" style={styles.body}>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: space[6] },
  block: { paddingVertical: space[4], borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  body: { marginTop: space[1], maxWidth: 460 },
  list: { marginTop: space[2], gap: space[1] },
  screenshots: { marginTop: space[4], marginBottom: space[6] },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space[3], marginBottom: space[8] },
  rowLabel: { flex: 1 },
});
