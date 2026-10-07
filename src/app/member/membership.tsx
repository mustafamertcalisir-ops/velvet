import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { formatLongDate } from '@/screens/applicationLetter';
import { useMember } from '@/state/member/MemberProvider';

/**
 * Membership — what the member has, in plain facts. One plan; no tiers (DEC-047).
 * An invited membership (DEC-088) says so plainly: nothing to pay, nothing renews.
 */
export default function MembershipDetails() {
  const me = useMember((s) => s.me);
  const t = copy.member.membershipScreen;
  const m = me?.membership;
  const invited = m?.activation === 'complimentary';
  const rows: [string, string][] = m
    ? [
        [t.plan, invited ? t.planNameInvited : t.planName],
        [t.status, t.statuses[m.status] ?? m.status],
        ...(m.startedAt ? ([[t.since, formatLongDate(m.startedAt.slice(0, 10))]] as [string, string][]) : []),
        ...(m.renewsAt ? ([[t.renews, formatLongDate(m.renewsAt.slice(0, 10))]] as [string, string][]) : []),
      ]
    : [];
  return (
    <ScreenShell onBack={() => router.back()} testID="screen-member-membership">
      <Text variant="headline" accessibilityRole="header" style={styles.title}>
        {t.title}
      </Text>
      <View>
        {rows.map(([label, value], i) => (
          <View key={label} style={[styles.row, i > 0 && styles.divider]}>
            <Text variant="supporting" tone="secondary">
              {label}
            </Text>
            <Text variant="bodyLarge" style={styles.value}>
              {value}
            </Text>
          </View>
        ))}
      </View>
      <Text variant="caption" tone="tertiary" style={styles.note} testID={invited ? 'membership-invited-note' : undefined}>
        {invited ? t.invited : t.billing}
      </Text>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: space[6] },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', minHeight: 52, paddingVertical: space[3], gap: space[4] },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  value: { textAlign: 'right', flexShrink: 1 },
  note: { marginTop: space[6] },
});
