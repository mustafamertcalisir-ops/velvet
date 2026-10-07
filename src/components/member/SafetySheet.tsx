import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Sheet } from '@/components/Sheet';
import { Text } from '@/components/Text';
import { copy } from '@/copy/en';
import { color, radius, space } from '@/design/tokens';
import { REPORT_REASONS, type ReportContext, type ReportReason } from '@/domain/member/safety';
import { useMemberActions } from '@/state/member/MemberProvider';

type Step = 'menu' | 'report' | 'reported' | 'block';

/**
 * Block and report, behind one quiet "More options" control (DEC-054).
 * Report: structured reasons only, then an optional block. Block: one
 * confirmation that says exactly what happens. Neither tells the other member.
 */
export function SafetySheet({
  visible,
  onClose,
  memberId,
  name,
  context,
  conversationId = null,
  onBlocked,
}: {
  visible: boolean;
  onClose: () => void;
  memberId: string;
  name: string;
  context: ReportContext;
  conversationId?: string | null;
  onBlocked: () => void;
}) {
  const actions = useMemberActions();
  const t = copy.member.safety;
  const [step, setStep] = useState<Step>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each time the sheet opens, it starts from the menu.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setStep('menu');
      setError(null);
    }
  }

  const report = async (reason: ReportReason) => {
    setBusy(true);
    setError(null);
    const res = await actions.report(memberId, { reason, context, conversationId });
    setBusy(false);
    if (res.ok) setStep('reported');
    else setError(t.failed);
  };

  const block = async () => {
    setBusy(true);
    setError(null);
    const res = await actions.block(memberId);
    setBusy(false);
    if (res.ok) {
      onClose();
      onBlocked();
    } else setError(t.failed);
  };

  return (
    <Sheet visible={visible} onClose={onClose} testID="safety-sheet" title={step === 'report' ? t.reportTitle : step === 'block' ? t.blockTitle(name) : undefined}>
      {step === 'menu' ? (
        <>
          <Rows
            rows={[
              { key: 'report', label: t.report(name), onPress: () => setStep('report'), testID: 'safety-report' },
              { key: 'block', label: t.block(name), onPress: () => setStep('block'), destructive: true, testID: 'safety-block' },
            ]}
          />
          <Button variant="secondary" label={t.cancel} onPress={onClose} testID="safety-cancel" />
        </>
      ) : null}

      {step === 'report' ? (
        <>
          <Rows
            rows={REPORT_REASONS.map((r) => ({
              key: r,
              label: t.reasons[r] ?? r,
              onPress: () => void report(r),
              testID: `report-reason-${r}`,
              disabled: busy,
            }))}
          />
          <Text variant="caption" tone="secondary" style={styles.note}>
            {t.reportNote(name)}
          </Text>
          <Notice message={error} />
          <Button variant="secondary" label={t.cancel} onPress={onClose} />
        </>
      ) : null}

      {step === 'reported' ? (
        <View testID="report-done">
          <Text variant="headline" accessibilityRole="header" style={styles.doneTitle}>
            {t.reported}
          </Text>
          <View style={styles.doneActions}>
            <Button variant="secondary" label={t.alsoBlock(name)} onPress={() => setStep('block')} testID="report-also-block" />
            <Button label={t.done} onPress={onClose} testID="report-close" />
          </View>
        </View>
      ) : null}

      {step === 'block' ? (
        <>
          <Text variant="bodyLarge" tone="secondary" style={styles.blockBody}>
            {t.blockBody(name)}
          </Text>
          <Notice message={error} />
          <View style={styles.doneActions}>
            <Pressable
              onPress={busy ? undefined : () => void block()}
              accessibilityRole="button"
              accessibilityState={{ busy }}
              style={({ pressed }) => [styles.blockButton, pressed && { opacity: 0.8 }]}
              testID="block-confirm"
            >
              <Text variant="button" tone="error">
                {t.blockConfirm}
              </Text>
            </Pressable>
            <Button variant="secondary" label={t.cancel} onPress={onClose} />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

type Row = { key: string; label: string; onPress: () => void; destructive?: boolean; testID?: string; disabled?: boolean };

function Rows({ rows }: { rows: Row[] }) {
  return (
    <View style={styles.group}>
      {rows.map((r, i) => (
        <Pressable
          key={r.key}
          onPress={r.disabled ? undefined : r.onPress}
          accessibilityRole="button"
          accessibilityState={{ disabled: r.disabled }}
          style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && { backgroundColor: color.surfaceRaised }]}
          testID={r.testID}
        >
          <Text variant="bodyLarge" tone={r.destructive ? 'error' : 'primary'}>
            {r.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: radius.medium, backgroundColor: color.surface, overflow: 'hidden', marginBottom: space[3] },
  row: { minHeight: 54, paddingHorizontal: space[5], paddingVertical: space[3], justifyContent: 'center' },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  note: { marginBottom: space[4] },
  doneTitle: { fontSize: 26, lineHeight: 32, marginBottom: space[6] },
  doneActions: { gap: space[3] },
  blockBody: { marginBottom: space[6] },
  blockButton: {
    height: 54,
    borderRadius: radius.control,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
