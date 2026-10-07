import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, findNodeHandle } from 'react-native';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { ScreenShell } from '@/components/ScreenShell';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, space } from '@/design/tokens';
import { useAdmissionActions } from '@/state/admission/AdmissionProvider';

/**
 * Delete account (DEC-077) — You → Privacy & safety → Delete account.
 *
 * Two steps, both explicit: the consequences, then one confirmation. No
 * countdowns, no guilt, no buried cancel: "Keep my account" is as clear as the
 * destructive action. On success the server has already signed out every
 * device; this device is cleared and returns to the start, where a one-time
 * line confirms what happened. On failure nothing changes and the person can
 * retry.
 */
export default function DeleteAccount() {
  const admission = useAdmissionActions();
  const t = copy.member.deleteAccount;
  const [step, setStep] = useState<'explain' | 'confirm'>('explain');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmHeading = useRef<View>(null);

  // Move screen-reader focus to the confirmation when it appears.
  useEffect(() => {
    if (step !== 'confirm') return;
    if (Platform.OS === 'web') return;
    const node = confirmHeading.current ? findNodeHandle(confirmHeading.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [step]);

  async function confirm() {
    setBusy(true);
    setError(null);
    const r = await admission.deleteAccount();
    if (r.ok) {
      router.replace('/');
      return;
    }
    setBusy(false);
    if (r.error.kind === 'unauthorized') {
      router.replace('/');
      return;
    }
    setError(r.error.kind === 'network' ? t.errors.network : t.errors.generic);
  }

  return (
    <ScreenShell onBack={busy ? undefined : () => router.back()} testID="screen-delete-account">
      <Text variant="headline" accessibilityRole="header" style={styles.title}>
        {t.title}
      </Text>
      <Text variant="bodyLarge" style={styles.intro}>
        {t.intro}
      </Text>

      <View style={styles.block}>
        <Text variant="label">{t.whatHappensTitle}</Text>
        <View style={styles.list}>
          {t.whatHappens.map((line) => (
            <Text key={line} variant="supporting" tone="secondary" style={styles.item}>
              {line}
            </Text>
          ))}
        </View>
      </View>
      <View style={styles.block}>
        <Text variant="label">{t.keptTitle}</Text>
        <Text variant="supporting" tone="secondary" style={styles.item} testID="delete-account-kept">
          {t.kept}
        </Text>
      </View>

      {step === 'explain' ? (
        <View style={styles.actions}>
          <Button label={t.action} variant="secondary" onPress={() => setStep('confirm')} testID="delete-account-start" />
        </View>
      ) : (
        <View style={styles.confirm} testID="delete-account-confirm">
          <View ref={confirmHeading} accessible accessibilityRole="header">
            <Text variant="title">{t.confirmTitle}</Text>
          </View>
          <Text variant="supporting" tone="secondary" style={styles.item}>
            {t.confirmBody}
          </Text>
          <Notice message={error} testID="delete-account-error" />
          <View style={styles.actions}>
            <Button label={t.confirm} onPress={() => void confirm()} loading={busy} testID="delete-account-confirm-button" />
            <Button
              label={t.cancel}
              variant="quiet"
              disabled={busy}
              onPress={() => {
                setStep('explain');
                setError(null);
              }}
              style={styles.cancel}
              testID="delete-account-cancel"
            />
          </View>
        </View>
      )}
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: space[4] },
  intro: { maxWidth: 460, marginBottom: space[4] },
  block: { paddingVertical: space[4], borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  list: { marginTop: space[1], gap: space[2] },
  item: { maxWidth: 460, marginTop: space[1] },
  confirm: { marginTop: space[4], paddingTop: space[5], borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  actions: { marginTop: space[6], gap: space[3], marginBottom: space[8] },
  cancel: { alignSelf: 'center' },
});
