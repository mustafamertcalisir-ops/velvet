import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View, ScrollView, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Glass, GlassBack } from '@/components/Glass';
import { ProfileView } from '@/components/profile/ProfileView';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, layout, space } from '@/design/tokens';
import { buildProfilePreview } from '@/domain/profile/profilePresentation';
import { ExtendedStepGuard } from '@/navigation/ExtendedStepGuard';
import { useExtendedStep } from '@/navigation/useExtendedStep';
import { useAdmission, useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * EXT-12 — the applicant's first look at themselves as a member would see them.
 *
 * Full-bleed photograph, identity on its lower edge, then a quiet editorial
 * column. Controls are glass and few: back, a privacy chip and one floating
 * action. One way through: scroll, with words and photographs alternating.
 * Built only from whitelisted presentation fields
 * (buildProfilePreview) — no surname, DOB, phone, Instagram, referral or
 * reviewer data can reach this screen.
 */
export default function PreviewRoute() {
  return (
    <ExtendedStepGuard step="preview">
      <PreviewScreen />
    </ExtendedStepGuard>
  );
}

function PreviewScreen() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const actions = useAdmissionActions();
  const ext = useAdmission((s) => s.extendedDraft);
  const summary = useAdmission((s) => s.summary);
  const fallbackFirstName = useAdmission((s) => s.draft.firstName);
  const fallbackCity = useAdmission((s) => s.draft.city?.label ?? null);
  const { goNext, goBack } = useExtendedStep('preview');
  const t = copy.extended.preview;

  const profile = buildProfilePreview({ summary, fallbackFirstName, fallbackCity, extended: ext });
  const footerH = 54 + space[4] * 2 + Math.max(insets.bottom, space[2]);

  return (
    <View style={styles.root} testID="screen-preview">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: footerH + space[6] }}>
        <ProfileView
          profile={profile}
          firstFrameHeight={height}
          bottomInset={footerH + space[5]}
          labels={{ knownFor: t.knownFor, interests: t.interests, photo: t.photoA11y }}
          topOverlay={
            <View style={[styles.top, { paddingTop: insets.top + space[2] }]}>
              <GlassBack onPress={goBack} label={copy.common.back} />
              <Glass style={styles.chip}>
                <Text variant="caption" testID="preview-chip">
                  {t.chip}
                </Text>
              </Glass>
              <View style={styles.spacer} />
            </View>
          }
        >
          <View style={styles.notes}>
            <Text variant="title" style={styles.headline}>
              {t.headline}
            </Text>
            <Text variant="supporting" tone="secondary">
              {t.supporting}
            </Text>
            <Text variant="caption" tone="tertiary">
              {t.nameRule}
            </Text>
          </View>
        </ProfileView>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space[2]) + space[4] }]} pointerEvents="box-none">
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(11,11,12,0)', 'rgba(11,11,12,0.85)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.footerInner}>
          <Button
            label={t.cta}
            onPress={() => {
              if (actions.markPreviewSeen().ok) goNext();
            }}
            testID="step-continue"
          />
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
  headline: { marginBottom: space[1] },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: space[6], paddingHorizontal: layout.gutter },
  footerInner: { width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' },
});
