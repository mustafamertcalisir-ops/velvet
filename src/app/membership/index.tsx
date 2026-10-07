import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApplicationBand, Kicker } from '@/components/ApplicationBand';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Reveal } from '@/components/Reveal';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, layout, space } from '@/design/tokens';
import { formatPrice, type MembershipPlan } from '@/domain/membership/plan';
import { describeApiError } from '@/navigation/errors';
import { useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * Membership activation shell. One plan, named "Membership" — no tiers.
 * Pricing comes from the server; while it is a development fixture the screen
 * says so. Activation hands over to the billing provider, which confirms to
 * the server; this screen never activates membership itself (DEC-047).
 * Release builds have no provider yet, so activation is shown as not yet open.
 */
export default function MembershipScreen() {
  const insets = useSafeAreaInsets();
  const actions = useAdmissionActions();
  const t = copy.membership;
  const [plans, setPlans] = useState<MembershipPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const billingAvailable = actions.billingAvailable();

  useEffect(() => {
    let cancelled = false;
    void actions.loadMembershipPlans().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setPlans(res.value);
        setLoadError(null);
      } else {
        setLoadError(t.loadFailed);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [actions, attempt, t.loadFailed]);

  const plan = plans?.[0] ?? null;

  const activate = async () => {
    if (!plan) return;
    setActivating(true);
    setError(null);
    const res = await actions.activateMembership(plan);
    setActivating(false);
    if (!res.ok) {
      const kind = res.error.kind;
      setError(
        kind === 'billing_unavailable'
          ? t.unavailable
          : kind === 'billing_failed' || kind === 'billing_cancelled'
            ? t.billingFailed
            : describeApiError(res.error as Parameters<typeof describeApiError>[0]),
      );
    }
    // On success the server reports ACTIVE_MEMBER and the guard opens the member product.
  };

  return (
    <View style={styles.root} testID="screen-membership">
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <ApplicationBand compact photo="welcome" />
        <View style={styles.body}>
          <Reveal>
            <Kicker>{t.kicker}</Kicker>
            <Text variant="display" accessibilityRole="header">
              {t.headline}
            </Text>
            <Text variant="bodyLarge" style={styles.paragraph}>
              {t.body}
            </Text>
          </Reveal>

          <View style={styles.plan} testID="membership-plan">
            {plan ? (
              <>
                <View style={styles.planRow}>
                  <View style={styles.flex}>
                    <Text variant="title">{plan.name}</Text>
                    <Text variant="supporting" tone="secondary" style={styles.billed}>
                      {t.billed[plan.billingPeriod]}
                    </Text>
                  </View>
                  <View style={styles.price}>
                    <Text style={styles.priceNumeral} testID="membership-price">
                      {formatPrice(plan)}
                    </Text>
                    <Text variant="caption" tone="secondary">
                      {t.per[plan.billingPeriod]}
                    </Text>
                  </View>
                </View>
                {plan.isDevelopmentFixture ? (
                  <Text variant="caption" tone="tertiary" style={styles.fixture} testID="membership-fixture-note">
                    {t.fixtureNote}
                  </Text>
                ) : null}
              </>
            ) : loadError ? (
              <View>
                <Notice message={loadError} />
                <Button variant="quiet" label={copy.common.retry} onPress={() => setAttempt((n) => n + 1)} />
              </View>
            ) : (
              <Text variant="supporting" tone="tertiary">
                {t.loading}
              </Text>
            )}
          </View>

          <Text variant="caption" tone="tertiary" style={styles.privacy}>
            {t.privacy}
          </Text>
        </View>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space[4]) }]}>
        <View style={styles.footerInner}>
          <Button
            label={t.cta}
            onPress={activate}
            loading={activating}
            disabled={!plan || !billingAvailable}
            testID="membership-activate"
          />
          {!billingAvailable ? (
            <Text variant="caption" tone="tertiary" style={styles.unavailable} testID="membership-unavailable">
              {t.unavailable}
            </Text>
          ) : null}
          <Notice message={error} testID="membership-error" />
          <Button
            variant="quiet"
            label={copy.common.signOut}
            onPress={() => void actions.signOut()}
            style={styles.signOut}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background },
  scroll: { flexGrow: 1, paddingBottom: space[6] },
  body: {
    marginTop: -space[8],
    paddingHorizontal: layout.gutter,
    width: '100%',
    maxWidth: layout.maxContentWidth + layout.gutter * 2,
    alignSelf: 'center',
  },
  paragraph: { marginTop: space[3], maxWidth: 420 },
  plan: {
    marginTop: space[8],
    paddingVertical: space[5],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  planRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space[4] },
  flex: { flex: 1 },
  billed: { marginTop: 2 },
  price: { alignItems: 'flex-end' },
  priceNumeral: {
    fontFamily: 'InstrumentSans_500Medium',
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    fontVariant: ['tabular-nums'],
    color: color.text,
  },
  fixture: { marginTop: space[3] },
  privacy: { marginTop: space[4], maxWidth: 420 },
  footer: { paddingTop: space[3], paddingHorizontal: layout.gutter, backgroundColor: color.background },
  footerInner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', gap: space[2] },
  unavailable: { textAlign: 'center' },
  signOut: { alignSelf: 'center' },
});
