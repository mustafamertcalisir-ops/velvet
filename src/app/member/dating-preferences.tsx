import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { isEveryone } from '@/domain/member/dating';
import { joinNatural } from '@/domain/profile/profilePresentation';
import { useMemberActions } from '@/state/member/MemberProvider';
import { useMemberQuery } from '@/state/member/useMemberQuery';

/**
 * Dating preferences — the member's own private matching settings, shown
 * only to them. Changing them affects future introductions; existing matches
 * and conversations stay (DEC-058).
 */
export default function DatingPreferences() {
  const actions = useMemberActions();
  const settings = useMemberQuery(() => actions.loadDatingSettings(), 'dating-settings');
  const { reload } = settings;
  // Re-read after returning from an edit.
  useFocusEffect(useCallback(() => reload(), [reload]));
  const t = copy.member.dating;
  const s = settings.value;
  const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

  const identity = s?.identity
    ? s.identity.gender === 'SELF_DESCRIBED'
      ? (s.identity.selfDescription ?? t.genders.SELF_DESCRIBED ?? '')
      : (t.genders[s.identity.gender] ?? s.identity.gender)
    : t.notSet;
  const categories = (list: readonly string[]) =>
    list.length === 0
      ? t.notSet
      : isEveryone(list as never)
        ? t.everyone
        : joinNatural(list.map((c, i) => (i === 0 ? (t.categories[c] ?? c) : lower(t.categories[c] ?? c))));

  const rows: [string, string, string][] = s
    ? [
        [t.you, identity, 'dating-row-you'],
        ...(s.identity?.gender === 'SELF_DESCRIBED'
          ? ([[t.appearsAs, categories(s.identity.appearsAs), 'dating-row-appears']] as [string, string, string][])
          : []),
        [t.seeking, categories(s.seeking), 'dating-row-seeking'],
        [t.ages, s.ageRange ? t.agesValue(s.ageRange.min, s.ageRange.max) : t.notSet, 'dating-row-ages'],
      ]
    : [];

  return (
    <ScreenShell onBack={() => router.back()} testID="screen-dating-preferences">
      <Text variant="headline" accessibilityRole="header" style={styles.title}>
        {t.preferencesTitle}
      </Text>
      <View>
        {rows.map(([label, value, testID], i) => (
          <View key={label} style={[styles.row, i > 0 && styles.divider]} testID={testID}>
            <Text variant="supporting" tone="secondary">
              {label}
            </Text>
            <Text variant="bodyLarge" style={styles.value}>
              {value}
            </Text>
          </View>
        ))}
      </View>
      <Text variant="caption" tone="tertiary" style={styles.note}>
        {t.privateNote}
      </Text>
      {s ? (
        <Button
          variant="secondary"
          label={t.change}
          onPress={() => router.push('/member/dating-setup?mode=edit' as Href)}
          testID="dating-change"
        />
      ) : null}
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: space[6] },
  row: { paddingVertical: space[3], gap: 2 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  value: {},
  note: { marginTop: space[5], marginBottom: space[6] },
});
