import { StyleSheet, View } from 'react-native';

import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { referralDisplayName } from '@/domain/admission/referral';
import type { ReferralRequestDraft } from '@/domain/models';
import { Button } from './Button';
import { Text } from './Text';

/**
 * Referral treatment (DEC-022): once added, a referral is shown only as a
 * short name — "Kerem A." — with a generic "Referral requested" state.
 * Never the phone number, never whether they are a member, never a count
 * presented as status.
 */
export function ReferralList({
  referrals,
  onRemove,
}: {
  referrals: readonly ReferralRequestDraft[];
  onRemove: (id: string) => void;
}) {
  return (
    <View accessibilityRole="list" testID="referral-list">
      {referrals.map((r) => {
        const name = referralDisplayName(r.name);
        return (
          <View key={r.id} style={styles.row}>
            <View style={styles.text}>
              <Text variant="title" numberOfLines={1}>
                {name}
              </Text>
              <Text variant="supporting" tone="secondary" style={styles.state}>
                {copy.referral.requested}
              </Text>
            </View>
            <Button
              variant="quiet"
              label={copy.referral.remove}
              accessibilityLabel={copy.referral.removeA11y(name)}
              onPress={() => onRemove(r.id)}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
    gap: space[4],
  },
  text: { flex: 1 },
  state: { marginTop: 2 },
});
