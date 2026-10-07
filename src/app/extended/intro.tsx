import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApplicationBand, Kicker } from '@/components/ApplicationBand';
import { Button } from '@/components/Button';
import { Reveal } from '@/components/Reveal';
import { StatusStages } from '@/components/StatusStages';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, layout, space } from '@/design/tokens';
import { stagesFor } from '@/domain/admission/statusStages';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * EXT-00 — an application update, not a new form. It is composed exactly like
 * Application Status (same photograph band, kicker, headline, stage
 * sequence) so continuing the application reads as the next line of the same
 * letter. What it involves is set as three plain facts, not a checklist.
 */
export default function ExtendedIntroRoute() {
  return (
    <ExtendedStepGuard step="intro">
      <ExtendedIntro />
    </ExtendedStepGuard>
  );
}

function ExtendedIntro() {
  const insets = useSafeAreaInsets();
  const actions = useAdmissionActions();
  const status = useAdmission((s) => s.status);
  const application = useAdmission((s) => s.application);
  const { goNext } = useExtendedStep('intro');
  const t = copy.extended.intro;
  const sequence = stagesFor(status, application);

  return (
    <View style={styles.root} testID="screen-extended-intro">
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <ApplicationBand compact />
        <View style={styles.body}>
          <Reveal>
            <Kicker>{t.kicker}</Kicker>
            <Text variant="display" accessibilityRole="header" testID="question-headline">
              {t.headline}
            </Text>
            <Text variant="bodyLarge" style={styles.paragraph}>
              {t.supporting}
            </Text>
          </Reveal>
          {sequence ? (
            <View style={styles.stages}>
              <StatusStages sequence={sequence} />
            </View>
          ) : null}
          <View style={styles.facts}>
            <Fact label={t.involvesLabel}>{t.includes}</Fact>
            <Fact label={t.timeLabel}>{t.time}</Fact>
            <Fact label={t.privateLabel}>{t.private}</Fact>
          </View>
        </View>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space[4]) }]}>
        <View style={styles.footerInner}>
          <Button
            label={t.cta}
            onPress={() => {
              if (actions.acknowledgeExtendedIntro().ok) goNext();
            }}
            testID="extended-begin"
          />
        </View>
      </View>
    </View>
  );
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${children}`}>
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
      <Text variant="body" style={styles.factValue}>
        {children}
      </Text>
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
  stages: { marginTop: space[8] },
  facts: { marginTop: space[6], gap: space[4], maxWidth: 440 },
  factValue: { marginTop: 2 },
  footer: {
    paddingTop: space[3],
    paddingHorizontal: layout.gutter,
    backgroundColor: color.background,
  },
  footerInner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' },
});
